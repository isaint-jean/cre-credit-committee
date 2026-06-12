/**
 * Production reader, component 5: pari-passu / loan-combination aggregator.
 *
 * Underwriting Model A re-computes LTV / Debt Yield from sources. For
 * pari-passu loans, the trust holds a slice (e.g., Republic Plaza $155M)
 * but the property is appraised at the WHOLE basis ($535.4M) — so naive
 * LTV = trustBalance / appraisedValue gives 29%, badly wrong vs the
 * issuer-stated 52.3%. The correct denominator is the WHOLE LOAN
 * COMBINATION ($280M Republic Plaza = trust + non-trust companion).
 *
 *   wholeLoanLtv      = wholeLoanAmount / concludedValue
 *   wholeLoanDebtYield = uwY1Noi / wholeLoanAmount
 *
 * The trust slice is preserved (loanAmount stays the trust balance) for
 * trust-level loss accounting (bcLoss / dsLoss is to the trust, not to
 * the whole loan).
 *
 * Two split-loan structures are detected:
 *   - PARI-PASSU: trust + non-trust mortgage notes pari passu in payment
 *     priority. WFRBS in-deal table at "Cut-off Date LTV of Loan
 *     Combination" is the primary source. Cross-shelf FTS is the fallback
 *     when the loan is post-2016 (EX-102 has loanStructureCode='PP' but
 *     no companion balance).
 *   - CROSS-COLLATERALIZED: multiple loans share a single appraisal pool;
 *     the LTV in the per-loan T4 is reported on the COMBINED basis. Each
 *     loan in isolation fails the T2-vs-T4×LTV cross-check (St. Helen
 *     Shops + Sandy Shops = "CIIICM Crossed Portfolio A" on WFRBS).
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-pari-passu-aggregator.ts
 *
 * Validates on WFRBS 2013-C11 (3 pari-passu + 1 crossed pair) and
 * spot-checks COR3 (post-2016 EX-102 PP flag flow).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { walkProspectus, type WalkerBackboneRecord } from './clean-corpus-annexA-walker.ts';

const WFRBS_PROSPECTUS = '/tmp/wfrbs-2013-c11-424B5.htm';
const COR3_EX102 = '/tmp/cor3-ex102-latest.xml';
const OUT_PATH = '/tmp/clean-corpus-pari-passu-aggregator.out';

/* ============================================================================
 * STRIP HTML — same as the walker; duplicated to avoid importing internals.
 * ========================================================================== */

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-').replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/* ============================================================================
 * IN-DEAL LOAN COMBINATION TABLE
 *
 * The WFRBS 2013-C11 prospectus body carries a pari-passu summary table
 * with the columns:
 *   Property Name | Trust $ | Non-Trust $ | Total $ | Combined LTV % |
 *     Trust Rate % | Non-Trust Rate % | Combined DSCR x
 *
 * Anchored on the unique header phrase "Cut-off Date LTV of Loan
 * Combination". Three rows on this deal (the 3 pari-passu loans).
 * ========================================================================== */

interface LoanCombinationEntry {
  readonly propertyName: string;
  readonly trustBalance: number;
  readonly companionBalance: number;
  readonly wholeLoanBalance: number;
  readonly wholeLoanLtv: number;
  readonly trustRate: number;
  readonly companionRate: number;
  readonly wholeLoanDscr: number;
}

function parseLoanCombinationTable(stripped: string): LoanCombinationEntry[] {
  const headerIdx = stripped.indexOf('Cut-off Date LTV of Loan Combination');
  if (headerIdx < 0) return [];
  // Data rows start AFTER the last column header phrase, which is
  // "U/W Debt Service Coverage Ratio for Loan Combination". Anchor on
  // "for Loan Combination" (a unique end-of-header marker) so the regex
  // doesn't capture "Loan Combination Republic Plaza" as a property name.
  const headerEnd = stripped.indexOf('for Loan Combination', headerIdx);
  if (headerEnd < 0) return [];
  const dataStart = headerEnd + 'for Loan Combination'.length;
  const slice = stripped.slice(dataStart, dataStart + 1500);
  // Row pattern: <name> $ <trust> $ <companion> $ <total> <ltv>% <rate>% <rate>% <dscr>x
  const rowRe = /([A-Z][A-Za-z0-9 '\-\.,&]+?)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+([\d.]+)\s*%\s+([\d.]+)\s*%\s+([\d.]+)\s*%\s+([\d.]+)\s*x/g;
  const out: LoanCombinationEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(slice)) !== null) {
    const propertyName = m[1].trim();
    // Reject false matches: names with too many words, or starting with
    // article words from prose context.
    if (propertyName.length > 60 || /^(?:The|For|With|Notwithstanding|Of|In)\b/i.test(propertyName)) continue;
    out.push({
      propertyName,
      trustBalance: Number(m[2].replace(/,/g, '')),
      companionBalance: Number(m[3].replace(/,/g, '')),
      wholeLoanBalance: Number(m[4].replace(/,/g, '')),
      wholeLoanLtv: Number(m[5]) / 100,
      trustRate: Number(m[6]) / 100,
      companionRate: Number(m[7]) / 100,
      wholeLoanDscr: Number(m[8]),
    });
  }
  return out;
}

/* ============================================================================
 * CROSS-COLLATERALIZED GROUP DETECTION
 *
 * On WFRBS each crossed loan's T1 row carries "Crossed Portfolio <X>"
 * right after the seller code (e.g., "57 St. Helen Shops CIIICM Crossed
 * Portfolio A ..."). Scan the T1 region and group loans by portfolio tag.
 * ========================================================================== */

interface CrossCollateralizedGroup {
  readonly groupTag: string;          // e.g., "Crossed Portfolio A"
  readonly seller: string;            // e.g., "CIIICM"
  readonly memberProsIds: string[];
  readonly memberPropertyNames: string[];
}

function findCrossCollateralizedGroups(stripped: string): CrossCollateralizedGroup[] {
  const annexAStart = stripped.indexOf('Mortgage Loan Number Property Name');
  if (annexAStart < 0) return [];
  const annexA = stripped.slice(annexAStart);
  // T1 region ends at "Mortgage Rate" (T3 header)
  const t1 = annexA.slice(0, annexA.indexOf('Mortgage Rate'));
  // Pattern: <id> <name> <seller> Crossed Portfolio <X>
  const SELLER = '(WFB|RBS|JLC|CIIICM|LIG\\sI|GACC|RCMC|CGMRC|UBSRES|MSMCH|LCM|WFCMC|JPMCB|CCRE|Basis)';
  const re = new RegExp(`\\b(\\d{1,3})\\s+([A-Z][A-Za-z0-9 '\\-\\&\\.,;/]{2,60}?)\\s+${SELLER}\\s+Crossed\\s+Portfolio\\s+([A-Z])\\b`, 'g');
  const groups = new Map<string, CrossCollateralizedGroup>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(t1)) !== null) {
    const prosId = m[1];
    const propertyName = m[2].trim();
    const seller = m[3].trim();
    const groupLetter = m[4];
    const key = `${seller}:${groupLetter}`;
    if (!groups.has(key)) {
      groups.set(key, {
        groupTag: `Crossed Portfolio ${groupLetter}`,
        seller,
        memberProsIds: [],
        memberPropertyNames: [],
      });
    }
    const g = groups.get(key)!;
    if (!g.memberProsIds.includes(prosId)) {
      g.memberProsIds.push(prosId);
      g.memberPropertyNames.push(propertyName);
    }
  }
  return [...groups.values()];
}

/* ============================================================================
 * AGGREGATED RECORD — the walker's backbone DealBag + split-loan fields.
 * ========================================================================== */

export type StructureCode = 'WL' | 'PP' | 'A1' | 'CC';
export type AggregationSource = 'in-deal-table' | 'fts-fallback' | 'ex-102' | null;

export interface AggregatedRecord extends WalkerBackboneRecord {
  readonly loanStructureCode: StructureCode;
  readonly wholeLoanAmount: number | null;
  readonly wholeLoanLtv: number | null;
  readonly wholeLoanDebtYield: number | null;
  readonly pariPassuCompanionBalance: number | null;
  readonly crossCollateralGroupTag: string | null;
  readonly crossCollateralGroupMembers: readonly string[] | null;
  readonly aggregationSource: AggregationSource;
  readonly aggregationProvenance: string | null;
}

/* Normalize a property name for fuzzy matching (lower, strip punctuation,
 * common abbreviation rules). The walker's name comes from Annex A T1
 * ("Republic Plaza"); the in-deal Loan Combination table sometimes
 * abbreviates ("One South Wacker Drive" vs "One South Wacker"). */
function normalizeName(s: string): string {
  return s.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(drive|drv|street|st|avenue|ave|boulevard|blvd|road|rd|lane|ln|portfolio)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return true;
  // Prefix match (table entry may be a shorter form)
  if (na.length > 4 && nb.length > 4 && (na.startsWith(nb) || nb.startsWith(na))) return true;
  // Token-overlap: every token from the shorter name must appear in the longer
  const ta = na.split(' ').filter(t => t.length > 2);
  const tb = nb.split(' ').filter(t => t.length > 2);
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return shorter.length > 0 && shorter.every(t => longer.includes(t));
}

export function aggregateBackbone(
  records: WalkerBackboneRecord[],
  prospectusPath: string,
): AggregatedRecord[] {
  const raw = fs.readFileSync(prospectusPath, 'utf8');
  const stripped = stripHtml(raw);
  const loanCombos = parseLoanCombinationTable(stripped);
  const crossGroups = findCrossCollateralizedGroups(stripped);

  return records.map(rec => {
    // PARI-PASSU lookup by property name
    const combo = loanCombos.find(c => namesMatch(c.propertyName, rec.propertyName));
    if (combo !== undefined) {
      const wholeLoanLtv = rec.concludedValue !== null && rec.concludedValue > 0
        ? combo.wholeLoanBalance / rec.concludedValue
        : null;
      const wholeLoanDebtYield = rec.uwY1Noi !== null && combo.wholeLoanBalance > 0
        ? rec.uwY1Noi / combo.wholeLoanBalance
        : null;
      const ltvCheck = wholeLoanLtv !== null && Math.abs(wholeLoanLtv - combo.wholeLoanLtv) < 0.005
        ? '✓ matches issuer'
        : `${wholeLoanLtv !== null ? (wholeLoanLtv * 100).toFixed(1) + '%' : 'null'} vs issuer ${(combo.wholeLoanLtv * 100).toFixed(1)}%`;
      return {
        ...rec,
        loanStructureCode: 'PP' as StructureCode,
        wholeLoanAmount: combo.wholeLoanBalance,
        wholeLoanLtv,
        wholeLoanDebtYield,
        pariPassuCompanionBalance: combo.companionBalance,
        crossCollateralGroupTag: null,
        crossCollateralGroupMembers: null,
        aggregationSource: 'in-deal-table' as AggregationSource,
        aggregationProvenance: `pari-passu: in-deal Loan Combination table (trust=$${combo.trustBalance.toLocaleString()}, companion=$${combo.companionBalance.toLocaleString()}, total=$${combo.wholeLoanBalance.toLocaleString()}, issuer LTV=${(combo.wholeLoanLtv * 100).toFixed(1)}%); recomputed LTV ${ltvCheck}`,
      };
    }

    // CROSS-COLLATERALIZED lookup by prosId
    const group = crossGroups.find(g => g.memberProsIds.includes(rec.prosId));
    if (group !== undefined) {
      return {
        ...rec,
        loanStructureCode: 'CC' as StructureCode,
        wholeLoanAmount: null,           // combined denominator computed at group level
        wholeLoanLtv: null,
        wholeLoanDebtYield: null,
        pariPassuCompanionBalance: null,
        crossCollateralGroupTag: `${group.seller} ${group.groupTag}`,
        crossCollateralGroupMembers: group.memberProsIds.slice(),
        aggregationSource: 'in-deal-table' as AggregationSource,
        aggregationProvenance: `cross-collateralized: ${group.seller} ${group.groupTag} (members: ${group.memberProsIds.join(', ')}); LTV reported on combined-pair basis — engine must treat group as one denominator`,
      };
    }

    // WHOLE LOAN — no split structure detected
    return {
      ...rec,
      loanStructureCode: 'WL' as StructureCode,
      wholeLoanAmount: rec.loanAmount,
      wholeLoanLtv: rec.concludedLtv,
      wholeLoanDebtYield: rec.uwY1Noi !== null && rec.loanAmount !== null && rec.loanAmount > 0
        ? rec.uwY1Noi / rec.loanAmount
        : null,
      pariPassuCompanionBalance: null,
      crossCollateralGroupTag: null,
      crossCollateralGroupMembers: null,
      aggregationSource: null,
      aggregationProvenance: null,
    };
  });
}

/* ============================================================================
 * EX-102 SPOT-CHECK (post-2016 path)
 *
 * EX-102 carries a loanStructureCode field (per ABS-EE schema): WL, PP, A1.
 * The aggregator's path for supplement deals is: trust the EX-102 flag,
 * tag the structure, mark wholeLoanAmount as deferred-to-FTS. Cross-shelf
 * FTS would be batched (Component 6); this Component just verifies the
 * flag flows through and the structure is tagged correctly.
 * ========================================================================== */

interface SimpleEx102Record {
  readonly assetNumber: string;
  readonly propertyName: string | null;
  readonly loanStructureCode: StructureCode | null;
  readonly originalLoanAmount: number | null;
}

function parseEx102PariPassuFlags(xmlPath: string): SimpleEx102Record[] {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  // Per the CMBS ABS-EE schema, each asset is wrapped in <assets>...</assets>
  // (plural — one of those quirks of the SEC's draft schema). Inside each
  // block: <assetNumber>, <originalLoanAmount>, <loanStructureCode>, and a
  // nested <property>...</property> with <propertyName>.
  const out: SimpleEx102Record[] = [];
  const assetRe = /<assets>([\s\S]*?)<\/assets>/g;
  let am: RegExpExecArray | null;
  while ((am = assetRe.exec(xml)) !== null) {
    const block = am[1];
    const num = /<assetNumber>([^<]+)<\/assetNumber>/.exec(block)?.[1] ?? null;
    const name = /<propertyName>([^<]+)<\/propertyName>/.exec(block)?.[1] ?? null;
    const code = /<loanStructureCode>([^<]+)<\/loanStructureCode>/.exec(block)?.[1]?.trim() ?? null;
    const orig = /<originalLoanAmount>([^<]+)<\/originalLoanAmount>/.exec(block)?.[1] ?? null;
    if (num === null) continue;
    out.push({
      assetNumber: num,
      propertyName: name,
      loanStructureCode: code === 'WL' || code === 'PP' || code === 'A1' ? code : null,
      originalLoanAmount: orig ? Number(orig) : null,
    });
  }
  return out;
}

/* ============================================================================
 * MAIN — WFRBS validation + COR3 spot-check
 * ========================================================================== */

function main() {
  const out: string[] = [];
  out.push('PRODUCTION READER — COMPONENT 5: PARI-PASSU / LOAN-COMBINATION AGGREGATOR');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');

  /* === WFRBS 2013-C11 === */
  out.push('==============================================================================');
  out.push('DEAL: WFRBS 2013-C11 (backbone — 3 pari-passu + 1 crossed pair expected)');
  out.push('==============================================================================');
  const wfrbsRecords = walkProspectus(WFRBS_PROSPECTUS, '1566543', 'WFRBS 2013-C11');
  out.push(`Walker backbone records: ${wfrbsRecords.length}`);

  // Parse the in-deal Loan Combination table
  const stripped = stripHtml(fs.readFileSync(WFRBS_PROSPECTUS, 'utf8'));
  const combos = parseLoanCombinationTable(stripped);
  out.push(`\nIn-deal Loan Combination table — ${combos.length} entries:`);
  for (const c of combos) {
    out.push(`  ${c.propertyName.padEnd(28)} trust=$${c.trustBalance.toLocaleString().padStart(13)} companion=$${c.companionBalance.toLocaleString().padStart(13)} whole=$${c.wholeLoanBalance.toLocaleString().padStart(13)} LTV=${(c.wholeLoanLtv * 100).toFixed(1)}% DSCR=${c.wholeLoanDscr.toFixed(2)}x`);
  }

  // Detect cross-collateralized groups
  const groups = findCrossCollateralizedGroups(stripped);
  out.push(`\nCross-collateralized groups — ${groups.length}:`);
  for (const g of groups) {
    out.push(`  ${g.seller} ${g.groupTag} — members: [${g.memberProsIds.join(', ')}] ${g.memberPropertyNames.join(' + ')}`);
  }

  // Run aggregator
  const enriched = aggregateBackbone(wfrbsRecords, WFRBS_PROSPECTUS);
  const ppRecs = enriched.filter(r => r.loanStructureCode === 'PP');
  const ccRecs = enriched.filter(r => r.loanStructureCode === 'CC');
  const wlRecs = enriched.filter(r => r.loanStructureCode === 'WL');
  out.push(`\nStructure tally: WL=${wlRecs.length}  PP=${ppRecs.length}  CC=${ccRecs.length}`);

  /* === PARI-PASSU RECONCILIATION === */
  out.push('\n=== PARI-PASSU RECONCILIATION (walker × in-deal table → wholeLoan basis) ===');
  for (const rec of ppRecs) {
    const recomputed = rec.wholeLoanLtv;
    const issuer = combos.find(c => namesMatch(c.propertyName, rec.propertyName))!.wholeLoanLtv;
    const match = recomputed !== null && Math.abs(recomputed - issuer) < 0.005;
    out.push(`\n  [${rec.prosId}] ${rec.propertyName}`);
    out.push(`    trust slice (loanAmount):       $${rec.loanAmount?.toLocaleString()}  (preserved)`);
    out.push(`    pari-passu companion:           $${rec.pariPassuCompanionBalance?.toLocaleString()}`);
    out.push(`    wholeLoanAmount:                $${rec.wholeLoanAmount?.toLocaleString()}  (TRUST + COMPANION)`);
    out.push(`    concludedValue (whole prop):    $${rec.concludedValue?.toLocaleString()}`);
    out.push(`    wholeLoanLtv (recomputed):      ${recomputed !== null ? (recomputed * 100).toFixed(1) + '%' : 'null'}`);
    out.push(`    wholeLoanLtv (issuer-stated):   ${(issuer * 100).toFixed(1)}%   ${match ? '✓ MATCH' : '✗ MISMATCH'}`);
    out.push(`    wholeLoanDebtYield (recomputed): ${rec.wholeLoanDebtYield !== null ? (rec.wholeLoanDebtYield * 100).toFixed(2) + '%' : 'null'}`);
    out.push(`    naive (trust/value) LTV:        ${rec.concludedValue ? ((rec.loanAmount! / rec.concludedValue) * 100).toFixed(1) + '%' : 'null'}  (WRONG basis — for comparison)`);
    out.push(`    aggregationSource: ${rec.aggregationSource}`);
  }

  /* === CROSSED PAIR === */
  out.push('\n=== CROSS-COLLATERALIZED PAIR ===');
  for (const g of groups) {
    const members = enriched.filter(r => g.memberProsIds.includes(r.prosId));
    const combinedTrust = members.reduce((s, r) => s + (r.loanAmount ?? 0), 0);
    const combinedValue = members.reduce((s, r) => s + (r.concludedValue ?? 0), 0);
    const combinedLtv = combinedValue > 0 ? combinedTrust / combinedValue : 0;
    out.push(`\n  ${g.seller} ${g.groupTag}`);
    out.push(`    members:                ${members.map(r => `#${r.prosId} ${r.propertyName}`).join(' + ')}`);
    out.push(`    combined loan balance:  $${combinedTrust.toLocaleString()}`);
    out.push(`    combined appraised val: $${combinedValue.toLocaleString()}`);
    out.push(`    combined LTV:           ${(combinedLtv * 100).toFixed(1)}%   (each member's T4 carries this — engine treats the group as one denominator)`);
    for (const m of members) {
      out.push(`    [${m.prosId}] tag="${m.crossCollateralGroupTag}"  members=[${m.crossCollateralGroupMembers?.join(',')}]`);
    }
  }

  /* === NON-SPLIT SPOT-CHECK (Minot must be unaffected) === */
  out.push('\n=== NON-SPLIT SPOT-CHECK (Minot Hotel Portfolio #17) ===');
  const minot = enriched.find(r => r.prosId === '17');
  if (minot) {
    const ok = minot.loanStructureCode === 'WL'
      && minot.wholeLoanAmount === minot.loanAmount
      && minot.wholeLoanLtv === minot.concludedLtv
      && minot.pariPassuCompanionBalance === null
      && minot.crossCollateralGroupTag === null;
    out.push(`  loanStructureCode=${minot.loanStructureCode}  wholeLoanAmount=$${minot.wholeLoanAmount?.toLocaleString()}  wholeLoanLtv=${minot.wholeLoanLtv !== null ? (minot.wholeLoanLtv*100).toFixed(1)+'%' : 'null'}  pp.companion=${minot.pariPassuCompanionBalance ?? 'null'}  crossTag=${minot.crossCollateralGroupTag ?? 'null'}`);
    out.push(`  → ${ok ? '✓ unaffected (whole loan, no aggregation applied)' : '✗ regression — Minot should be untouched'}`);
  }

  /* === COR3 spot-check (post-2016 EX-102 PP flag flow) === */
  out.push('\n==============================================================================');
  out.push('DEAL: COMM 2018-COR3 (supplement — EX-102 loanStructureCode spot-check)');
  out.push('==============================================================================');
  const ex102 = parseEx102PariPassuFlags(COR3_EX102);
  const ppFlagged = ex102.filter(a => a.loanStructureCode === 'PP' || a.loanStructureCode === 'A1');
  out.push(`EX-102 assets parsed: ${ex102.length}`);
  out.push(`Flagged PP / A1: ${ppFlagged.length}`);
  for (const a of ppFlagged) {
    out.push(`  asset #${a.assetNumber} loanStructureCode=${a.loanStructureCode}  propertyName="${a.propertyName}"  trustOrigAmount=$${a.originalLoanAmount?.toLocaleString()}`);
  }
  out.push('');
  out.push('  POST-2016 PATH: the flag is carried through EX-102 directly. wholeLoanAmount');
  out.push('  is NOT in EX-102 for the companion piece — it must come from a cross-shelf');
  out.push('  FTS lookup (find the companion deal by propertyName + "pari passu", sum its');
  out.push('  originatorOriginalLoanAmount). That cross-shelf walk belongs to Component 6');
  out.push('  (batch) where shelf membership is already enumerated. For this spike: the');
  out.push("  aggregator confirms it can DETECT the structure post-2016; FTS enrichment is");
  out.push('  the batch step. Trust slice (loanAmount) is preserved either way.');
  out.push('');

  /* Per-loan summary at the bottom */
  out.push('=== AGGREGATED RECORDS — summary table ===');
  out.push(`  ${'prosId'.padEnd(8)}${'struct'.padEnd(8)}${'trust'.padStart(14)}${'whole'.padStart(14)}${'wholeLtv'.padStart(10)}${'naiveLtv'.padStart(10)}  property`);
  for (const r of enriched.filter(r => r.loanStructureCode !== 'WL')) {
    const naive = r.concludedValue && r.loanAmount ? (r.loanAmount / r.concludedValue) : null;
    out.push(`  ${r.prosId.padEnd(8)}${r.loanStructureCode.padEnd(8)}$${(r.loanAmount ?? 0).toLocaleString().padStart(13)}$${(r.wholeLoanAmount ?? 0).toLocaleString().padStart(13)}${r.wholeLoanLtv !== null ? ((r.wholeLoanLtv * 100).toFixed(1) + '%').padStart(10) : 'null'.padStart(10)}${naive !== null ? ((naive * 100).toFixed(1) + '%').padStart(10) : 'null'.padStart(10)}  ${r.propertyName}`);
  }

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[aggregator] wrote ${out.join('\n').length} chars to ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();

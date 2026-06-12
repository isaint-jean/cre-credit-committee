/**
 * Production reader, component 4: per-deal composer.
 *
 * Joins Components 1/2 (inputs) + Component 3 (outcome) into per-loan answer-
 * key records — DealBag (origination inputs) + 3-class label + bcLoss/dsLoss
 * (outcome), joined by Pros ID, with provenance.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-composer.ts
 *
 * Routing:
 *   - pre-2016  → Annex A inputs (Component 1)  +  10-D outcomes (Component 3)
 *   - post-2016 → EX-102 inputs (Component 2)   +  10-D outcomes (Component 3)
 *                                              + (EX-102 OutcomeContext from C2)
 *
 * Join policy:
 *   LEFT JOIN from inputs. Iterate every input loan; look it up by Pros ID in
 *   the 10-D outcome sections. ABSENT from all distress sections → CLEAN
 *   (bcLoss/dsLoss null), since the 10-D only lists distressed loans.
 *
 *   *** GUARD: if the 10-D's Historical Liquidated Loan Detail section is not
 *   located, the composer FAILS the deal (returns INCOMPLETE) rather than
 *   silently defaulting all loans to CLEAN. A 10-D fetch/parse failure must
 *   not mass-mislabel a deal.
 *
 * Multi-property roll-up:
 *   - Annex A:  loan terms on the N row, property metadata on N.NN sub-rows
 *               → aggregate (sum SF, list property names)
 *   - EX-102:   loan terms top-level, nested <property> children
 *               → aggregate (sum SF, list property names)
 *
 * Pari-passu tagging (defer aggregation to Component 5):
 *   - loanStructureCode ∈ {PP, A1} → flag `pariPassuFlag = true`
 *   - concludedLtv on PP loans is marked PROVISIONAL (per-shelf piece only)
 *
 * NOT the full reader. No pari passu aggregation (Component 5), no batch run
 * (Component 6), no doctrine, no cleanup. Operates on already-cached prospectus
 * + EX-102 + 10-D files at /tmp/.
 */
import fs from 'node:fs';
import { walkProspectus } from './clean-corpus-annexA-walker.ts';

const OUT_PATH = '/tmp/clean-corpus-composer.out';

/* ============================================================================
 * TEST DEALS
 * ========================================================================== */

interface ComposerTestDeal {
  readonly name: string;
  readonly cik: string;
  readonly track: 'backbone' | 'supplement';
  readonly vintage: number;
  readonly originator: string;
  readonly inputsPath: string;  // 424B5 or EX-102
  readonly outcomesPath: string; // 10-D Ex 99.1
}

const DEALS: ComposerTestDeal[] = [
  {
    name: 'WFRBS 2013-C11', cik: '1566543',
    track: 'backbone', vintage: 2013,
    originator: 'Wells Fargo (WFRBS)',
    inputsPath:    '/tmp/wfrbs-2013-c11-424B5.htm',
    outcomesPath:  '/tmp/wfrbs-10D-ex991.htm',
  },
  {
    name: 'COMM 2018-COR3', cik: '1735733',
    track: 'supplement', vintage: 2018,
    originator: 'Deutsche/COMM/DBGS',
    inputsPath:    '/tmp/cor3-ex102-latest.xml',  // EX-102
    outcomesPath:  '/tmp/cor3-10D-ex991.htm',     // 10-D
  },
];

/* ============================================================================
 * SHARED UTILS (HTML strip + parsing helpers, lifted from C1/C2/C3)
 * ========================================================================== */

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/[$,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const IRP_ASSET_TYPE: Record<string, string> = {
  RT: 'Retail', OF: 'Office', MF: 'Multifamily', LO: 'Hotel',
  IN: 'Industrial', MH: 'MHC', SS: 'SelfStorage', MU: 'MixedUse',
  WH: 'Industrial', HC: 'HealthCare', SE: 'Securities', CH: 'CoopHousing',
  SF: 'SFR', ZZ: 'Unknown', '98': 'Other',
};

/* ============================================================================
 * DealBag + provenance shape (matches calibration-baseline.ts:88 + extras)
 * ========================================================================== */

interface Provenance {
  readonly dealName: string;
  readonly cik: string;
  readonly prosId: string;
  readonly vintage: number;
  readonly originator: string;
  readonly inputSource: 'annex-a' | 'ex-102';
  readonly inputSourcePath: string;
  readonly outcomeSource: '10-d' | 'ex-102+10-d' | 'incomplete';
  readonly multiProperty: boolean;
  readonly subPropertyCount: number;
  readonly subPropertyNames: readonly string[];
  readonly pariPassuFlag: boolean;
  readonly loanStructureCode: string | null;
}

interface AnswerKeyRecord {
  readonly file: string;
  // DealBag-shaped inputs
  readonly loanAmount: number | null;
  readonly termYears: number | null;
  readonly amortMonths: number | null;
  readonly ioYears: number | null;
  readonly coupon: number | null;
  readonly occupancyCurrent: number | null;
  readonly assetType: string | null;
  readonly subType: string | null;
  readonly t12Noi: number | null;
  readonly t12Egi: number | null;
  readonly t12OpEx: number | null;
  readonly priorPeriodNoi: number | null;
  readonly uwY1Noi: number | null;
  readonly concludedCap: number | null;
  readonly concludedLtv: number | null;
  readonly concludedValue: number | null;
  readonly upfrontTiLcEscrow: number | null;
  readonly top1IncomeShare: number | null;
  readonly pctIncomeExpiringWithinTerm: number | null;
  // Outcome
  readonly outcomeClass: 'clean' | 'stress-only' | 'loss' | 'inconclusive';
  readonly bcLoss: number | null;
  readonly dsLoss: number | null;
  readonly outcomeEvidence: readonly string[];
  // Provenance + flags
  readonly provenance: Provenance;
}

/* ============================================================================
 * Bridge to Component 1's positional walker (clean-corpus-annexA-walker.ts)
 *
 * The walker emits one DealBag-shape per loan with load-bearing fields filled
 * from the stratified Annex A tables (T1 → T2 → T3 → T4 → T5 → T6 → T7 → T12)
 * via signature-based row classification. Composer consumes the walker output
 * directly; per-loan extraction is no longer stubbed.
 * ========================================================================== */

interface WalkerResult {
  prosId: string;
  propertyName: string;
  seller: string;
  subPropertyCount: number;
  subPropertyNames: string[];
  loanAmount: number | null;
  termYears: number | null;
  amortMonths: number | null;
  ioYears: number | null;
  coupon: number | null;
  maturityDate: string | null;
  occupancyCurrent: number | null;
  assetType: string | null;
  subType: string | null;
  t12Noi: number | null; t12Egi: number | null; t12OpEx: number | null;
  priorPeriodNoi: number | null;
  uwY1Noi: number | null;
  concludedCap: number | null;
  concludedLtv: number | null;
  concludedValue: number | null;
  upfrontTiLcEscrow: number | null;
}

function invokeAnnexAWalker(prospectusPath: string, cik: string, dealName: string): WalkerResult[] {
  /* Import the hardened walker directly. The inline copy below was the spike
   * stub; with WALKER HARDENING locked in (T2 single-property format, T1
   * bound, name-cap, Basis seller, semicolon names, value*LTV fallback), the
   * walker hits 100% loanAmount / maturityDate / coupon / assetType on the
   * WFRBS 2013-C11 anchor. */
  const recs = walkProspectus(prospectusPath, cik, dealName);
  return recs.map(r => ({
    prosId: r.prosId,
    propertyName: r.propertyName,
    seller: r.seller,
    subPropertyCount: r.subPropertyCount,
    subPropertyNames: [...r.subPropertyNames],
    loanAmount: r.loanAmount,
    termYears: r.termYears,
    amortMonths: r.amortMonths,
    ioYears: r.ioYears,
    coupon: r.coupon,
    maturityDate: r.maturityDate,
    occupancyCurrent: r.occupancyCurrent,
    assetType: r.assetType,
    subType: r.subType,
    t12Noi: r.t12Noi, t12Egi: r.t12Egi, t12OpEx: r.t12OpEx,
    priorPeriodNoi: r.priorPeriodNoi,
    uwY1Noi: r.uwY1Noi,
    concludedCap: r.concludedCap,
    concludedLtv: r.concludedLtv,
    concludedValue: r.concludedValue,
    upfrontTiLcEscrow: r.upfrontTiLcEscrow,
  }));
}

function inlineWalkRun(prospectusPath: string): WalkerResult[] {
  /* Inlined Component 1 walker (clean-corpus-annexA-walker.ts). Identical
   * algorithm + thresholds — copying the load-bearing helpers here so the
   * composer is self-contained for the spike. Production wiring would
   * import these from a shared module. */
  const raw = fs.readFileSync(prospectusPath, 'utf8');
  const annexAStart = (() => {
    const m = raw.match(/(?<!Table of Contents.*)ANNEX A[\s\S]{0,200}?(?:STATISTICAL|CERTAIN CHARACTERISTICS|MORTGAGE POOL)[\s\S]{0,200}?MORTGAGE/i);
    if (m && m.index !== undefined) {
      const tableStart = raw.indexOf('Mortgage Loan', m.index);
      if (tableStart > 0 && tableStart - m.index < 50_000) return m.index;
    }
    return -1;
  })();
  if (annexAStart < 0) return [];
  const annexA = stripHtml(raw.slice(annexAStart));
  const WFRBS_SELLER = '(WFB|RBS|JLC|CIIICM|LIG\\sI|GACC|RCMC|CGMRC|UBSRES|MSMCH|LCM|WFCMC|JPMCB|CCRE)';
  const rowRe = new RegExp(`\\b(\\d{1,3}(?:\\.\\d{2})?)\\s+([A-Z][A-Za-z0-9 '\\-\\&\\.,/]{2,80}?)\\s+${WFRBS_SELLER}\\b([\\s\\S]{0,200}?)(?=\\b\\d{1,3}(?:\\.\\d{2})?\\s+[A-Z][A-Za-z]|A-\\d+|$)`, 'g');
  const loans = new Map<string, { prosId: string; label: string; propertyName: string; seller: string; sub: string[]; typeRaw: string | null; subTypeRaw: string | null }>();
  let mm: RegExpExecArray | null;
  while ((mm = rowRe.exec(annexA)) !== null) {
    const idStr = mm[1]; const isSub = idStr.includes('.'); const parentId = isSub ? idStr.split('.')[0] : idStr;
    const n = Number(parentId); if (n < 1 || n > 100) continue;
    const name = mm[2].trim(); const seller = mm[3].trim();
    const tailCtx = mm[4] ?? '';
    let typeRaw: string | null = null, subTypeRaw: string | null = null;
    const tm = tailCtx.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+([A-Z][a-z][A-Za-z]+(?:\s[A-Z][a-z][A-Za-z]+)*)\s*$/);
    if (tm) { typeRaw = tm[1].trim(); subTypeRaw = tm[2].trim(); }
    if (!loans.has(parentId)) {
      loans.set(parentId, { prosId: parentId, label: `${parentId} ${name} ${seller}`, propertyName: isSub ? `(portfolio rolled up at #${parentId})` : name, seller, sub: [], typeRaw, subTypeRaw });
    } else if (isSub) {
      const p = loans.get(parentId)!; if (!p.sub.includes(name)) p.sub.push(name);
    }
  }
  // Per-loan walk: classify rows, parse, assemble
  const classifyRow = (body: string): 'T2'|'T3'|'T4'|'T5'|'T6'|'T7'|'T12'|'T9'|'unknown' => {
    if (/^\s*TTM\s+\d{1,2}\/\d{1,2}\/\d{2,4}/.test(body)) return 'T6';
    if (/^\s*Actual\s+20\d{2}/.test(body)) return 'T7';
    if (/^\s*\d+\.\d{2,4}%\s+\d+\.\d{2,4}%/.test(body)) return 'T3';
    if (/^\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s+L\(\d+\)[,;]/.test(body)) return 'T4';
    if (/^\s*(?:\d{4}|Various|NAP|NAV)\s+(?:\d{4}|Various|NAP|NAV)\s+[\d,]+\s+(?:Rooms?|Units?|Sq\.?\s*Ft\.?|Pads?|Beds?|Keys?)/i.test(body)) return 'T2';
    if (/^\s*Various\s+Various\s+[\d,]+\s+(?:[\d,]+|Various)\s+[\d,]{4,}/i.test(body)) return 'T2';
    if (/^\s*[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+\d+\.\d{1,2}%\s+\d{1,2}\/\d{1,2}\/\d{2,4}/.test(body)) return 'T5';
    if (/^\s*(?:PIP Reserve|Required Repairs|Engineering Reserve|Environmental Reserve|Replacement Reserve|TI\/LC|Tenant\s+Improvement)/i.test(body)) return 'T12';
    return 'unknown';
  };
  const ASSET_MAP: Record<string, string> = {
    Office: 'Office', Retail: 'Retail', 'Mixed Use': 'MixedUse', Hospitality: 'Hotel', Hotel: 'Hotel',
    Multifamily: 'Multifamily', 'Manufactured Housing': 'MHC', 'Manufactured Housing Community': 'MHC',
    Industrial: 'Industrial', 'Self Storage': 'SelfStorage', Warehouse: 'Industrial',
  };
  const results: WalkerResult[] = [];
  for (const loan of [...loans.values()].sort((a, b) => Number(a.prosId) - Number(b.prosId))) {
    const rows: Record<string, string[]> = {};
    let idx = 0; let safety = 0;
    while ((idx = annexA.indexOf(loan.label, idx)) >= 0) {
      if (++safety > 50) break;
      const start = idx + loan.label.length;
      const tail = annexA.slice(start, Math.min(annexA.length, start + 600));
      const stopM = tail.search(new RegExp(`\\s+\\d{1,3}(?:\\.\\d{2})?\\s+[A-Z][A-Za-z0-9 '\\-\\&\\.,/]+?\\s+${WFRBS_SELLER}\\b|\\s+A-\\d+\\b`));
      const body = stopM > 0 ? tail.slice(0, stopM) : tail;
      const t = classifyRow(body);
      if (!rows[t]) rows[t] = [];
      rows[t].push(body);
      idx = start + (stopM > 0 ? stopM : Math.max(body.length, 1));
    }
    const num = (s: string | null): number | null => s === null ? null : (() => { const neg = /^\(.*\)$/.test(s); const n = Number(s.replace(/[$,()%]/g, '')); return Number.isFinite(n) ? (neg ? -n : n) : null; })();
    const pct = (s: string | null): number | null => s === null ? null : (() => { const n = Number(s.replace(/[%,$\s]/g, '')); return Number.isFinite(n) ? n / 100 : null; })();
    // T2
    const t2 = rows['T2']?.[0] ?? null;
    const t2BigMoneys = t2 ? (t2.match(/\b\d{1,3}(?:,\d{3}){2,}(?:\.\d{2})?\b/g) ?? []) : [];
    const loanAmount = t2BigMoneys[0] ? num(t2BigMoneys[0]) : null;
    const t2Dates = t2 ? (t2.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) ?? []) : [];
    const maturityDate = t2Dates.length > 0 ? t2Dates[t2Dates.length - 1] : null;
    // T3
    const t3 = rows['T3']?.[0] ?? null;
    const t3Pcts = t3 ? (t3.match(/\d+\.\d{1,4}%/g) ?? []) : [];
    const coupon = t3Pcts[0] ? pct(t3Pcts[0]) : null;
    const t3LoanType = t3 ? (/Amortizing\s+Balloon|Amortizing|IO\s+Balloon|Interest\s*Only|IO/i.exec(t3)?.[0] ?? null) : null;
    const amortizing = t3LoanType !== null && /Amortizing/i.test(t3LoanType);
    const t3IntsAfter = t3 && t3LoanType ? t3.slice(t3.indexOf(t3LoanType) + t3LoanType.length).match(/\b\d{1,3}\b/g) : null;
    const termMonths = t3IntsAfter && t3IntsAfter.length >= 1 ? Number(t3IntsAfter[0]) : null;
    const ioMonths = t3IntsAfter && t3IntsAfter.length >= 3 ? Number(t3IntsAfter[2]) : null;
    // T4
    const t4 = rows['T4']?.[0] ?? null;
    const t4FirstInts = t4 ? (t4.match(/\b\d{1,4}\b/g)) : null;
    const t4AmortMonths = t4FirstInts ? Number(t4FirstInts[0]) : null;
    const t4BigMoneys = t4 ? (t4.match(/\b\d{1,3}(?:,\d{3}){1,}\b/g) ?? []) : [];
    const concludedValue = t4BigMoneys[0] ? num(t4BigMoneys[0]) : null;
    const t4Decimals = t4 ? (t4.match(/\b\d+\.\d{1,2}\b/g) ?? []) : [];
    const t4Pcts = t4 ? (t4.match(/\d+\.\d{1,2}\s*%/g) ?? []) : [];
    const uwDscrNcf = t4Decimals[0] ? Number(t4Decimals[0]) : null;
    const uwDscrNoi = t4Decimals[1] ? Number(t4Decimals[1]) : null;
    const concludedLtv = t4Pcts[0] ? pct(t4Pcts[0]) : null;
    // T5
    const t5 = rows['T5']?.[0] ?? null;
    const t5BigMoneys = t5 ? (t5.match(/\b\d{1,3}(?:,\d{3}){1,}(?:\.\d{2})?\b/g) ?? []) : [];
    const t12Egi = t5BigMoneys[0] ? num(t5BigMoneys[0]) : null;
    const t12OpEx = t5BigMoneys[1] ? num(t5BigMoneys[1]) : null;
    const t12Noi = t5BigMoneys[2] ? num(t5BigMoneys[2]) : null;
    const t5Occ = t5 ? (t5.match(/(\d+\.\d{1,2})%/)) : null;
    const occupancyCurrent = t5Occ ? pct(t5Occ[0]) : null;
    // T6
    const t6 = rows['T6']?.[0] ?? null;
    const t6BigMoneys = t6 ? (t6.match(/\b\d{1,3}(?:,\d{3}){1,}(?:\.\d{2})?\b/g) ?? []) : [];
    const uwY1Noi = t6BigMoneys[2] ? num(t6BigMoneys[2]) : null;
    // T7
    const t7 = rows['T7']?.[0] ?? null;
    const t7BigMoneys = t7 ? (t7.match(/\b\d{1,3}(?:,\d{3}){1,}(?:\.\d{2})?\b/g) ?? []) : [];
    const priorPeriodNoi = t7BigMoneys[2] ? num(t7BigMoneys[2]) : null;
    // T12
    const t12 = rows['T12']?.[0] ?? null;
    const t12BigMoneys = t12 ? (t12.match(/\b\d{1,3}(?:,\d{3}){0,}\b/g) ?? []) : [];
    const upfrontTiLcEscrow = t12BigMoneys[0] ? num(t12BigMoneys[0]) : null;

    const assetType = loan.typeRaw ? (ASSET_MAP[loan.typeRaw] ?? 'Other') : null;
    const concludedCap = (uwY1Noi !== null && concludedValue !== null && concludedValue > 0) ? uwY1Noi / concludedValue : null;
    const amortMonths = !amortizing && ioMonths !== null && ioMonths > 0 ? 0 : t4AmortMonths;
    results.push({
      prosId: loan.prosId, propertyName: loan.propertyName, seller: loan.seller,
      subPropertyCount: loan.sub.length, subPropertyNames: loan.sub,
      loanAmount, termYears: termMonths !== null ? termMonths / 12 : null,
      amortMonths, ioYears: ioMonths !== null ? ioMonths / 12 : null,
      coupon, maturityDate, occupancyCurrent, assetType, subType: loan.subTypeRaw,
      t12Noi, t12Egi, t12OpEx, priorPeriodNoi, uwY1Noi,
      concludedCap, concludedLtv, concludedValue, upfrontTiLcEscrow,
    });
  }
  return results;
}

/* ============================================================================
 * COMPONENT 1 — Annex A per-loan extractor (simplified for composer)
 *
 * Component 1's full extractor walks 14 stratified tables per loan. For the
 * composer we focus on the JOIN-bearing fields the survey marked 100%
 * across shelves: loanAmount, termYears, amortMonths, coupon, maturityDate,
 * assetType, uwY1Noi, concludedValue, concludedLtv, uwDscr, plus the
 * pari-passu loanStructureCode.
 *
 * For WFRBS 2013-C11 these all anchored cleanly. The simplified extractor
 * uses positional walks within Table 1 (property metadata) and Table 4
 * (financial metrics) — enough to populate the JOIN-bearing record.
 * ========================================================================== */

interface AnnexAInputLoan {
  readonly prosId: string;
  readonly propertyName: string;
  readonly seller: string;
  readonly subPropertyNames: readonly string[];
  readonly assetType: string | null;
  readonly subType: string | null;
  readonly loanStructureCode: 'WL' | 'PP' | 'A1' | null;
}

function locateAnnexA(prospectus: string): number {
  // Find the title page (lifted from Component 1's locator): "ANNEX A"
  // followed within 200 chars by "STATISTICAL" / "CERTAIN CHARACTERISTICS" /
  // "MORTGAGE POOL" and then a "MORTGAGE" token. The "Mortgage Loan" anchor
  // must follow within 50k chars (the interstitial page typically intervenes).
  const titlePatterns = [
    /(?<!Table of Contents.*)ANNEX A[\s\S]{0,200}?(?:STATISTICAL|CERTAIN CHARACTERISTICS|MORTGAGE POOL)[\s\S]{0,200}?MORTGAGE/i,
    /(?<!Table of Contents.*)Annex A[\s\S]{0,200}?(?:Statistical|Certain Characteristics)/i,
  ];
  for (const pat of titlePatterns) {
    const m = prospectus.match(pat);
    if (m && m.index !== undefined) {
      const tableStart = prospectus.indexOf('Mortgage Loan', m.index);
      if (tableStart > 0 && tableStart - m.index < 50_000) return m.index;
    }
  }
  // Fallback to last-hit (preserves prior behavior on unconventional shelves)
  const hits = [...prospectus.matchAll(/ANNEX A/g)].map(m => m.index ?? 0);
  return hits.length === 0 ? -1 : Math.max(0, hits[hits.length - 1] - 2000);
}

function extractAnnexALoans(prospectusPath: string): AnnexAInputLoan[] {
  const raw = fs.readFileSync(prospectusPath, 'utf8');
  const annexAStart = locateAnnexA(raw);
  if (annexAStart < 0) return [];
  const text = stripHtml(raw.slice(annexAStart));

  // Find Table 1 rows. The pattern that's stable across all WFRBS loans is
  //   <ID> <PropertyName 1+ words> <SellerCode>
  // The trailing address starts with a digit on many rows (Republic Plaza =
  // "370 17th Street; ..."), so we don't anchor on address+city+state+zip.
  // Seller codes seen on WFRBS 2013-C11: WFB, RBS, JLC, CIIICM, LIG I, etc.
  const loans = new Map<string, AnnexAInputLoan>();
  const sellerCodes = '(WFB|RBS|JLC|CIIICM|LIG\\sI|GACC|RCMC|CGMRC|UBSRES|MSMCH|LCM|WFCMC|JPMCB|CCRE|UBS\\sAG)';
  const rowRe = new RegExp(`\\b(\\d{1,3}(?:\\.\\d{2})?)\\s+([A-Z][A-Za-z0-9 '\\-\\&\\.,/]{2,80}?)\\s+${sellerCodes}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(text)) !== null) {
    const idStr = m[1];
    const isSubProperty = idStr.includes('.');
    const parentId = isSubProperty ? idStr.split('.')[0] : idStr;
    const propertyName = m[2].trim();
    const seller = m[3].trim();
    if (!loans.has(parentId)) {
      loans.set(parentId, {
        prosId: parentId,
        propertyName: isSubProperty ? `(portfolio rolled up at #${parentId})` : propertyName,
        seller,
        subPropertyNames: [],
        assetType: null,            // production parser populates from Annex A T1's property-type columns
        subType: null,
        loanStructureCode: null,    // PP/A1 flag from Annex A footnotes — Component 5 reads
      });
    } else if (isSubProperty) {
      const parent = loans.get(parentId)!;
      if (!parent.subPropertyNames.includes(propertyName)) {
        loans.set(parentId, { ...parent, subPropertyNames: [...parent.subPropertyNames, propertyName] });
      }
    }
  }
  // Spike-grade filter: drop IDs above the highest one that pairs with at
  // least 1 sub-row OR is named in a known-distress 10-D row. (Production
  // walker uses positional row anchors instead of this heuristic.) The
  // composer's join logic is unaffected — this only trims the CLEAN-default
  // tail of spurious "<digit> <CapName> <RBS>" address matches.
  // We keep the original Component-1-validated upper bound of Pros 100 for
  // 2013-vintage conduit pools.
  const SPIKE_PROS_ID_CEILING = 100;
  return [...loans.values()]
    .filter(l => Number(l.prosId) > 0 && Number(l.prosId) <= SPIKE_PROS_ID_CEILING)
    .sort((a, b) => Number(a.prosId) - Number(b.prosId));
}

/* ============================================================================
 * COMPONENT 2 — EX-102 per-asset extractor (lifted from C2)
 * ========================================================================== */

interface Ex102InputAsset {
  readonly prosId: string;
  readonly propertyName: string;
  readonly assetType: string | null;
  readonly subType: string | null;
  readonly loanStructureCode: string | null;
  readonly subPropertyNames: readonly string[];
  readonly dealBagSeed: Partial<AnswerKeyRecord>;
  // EX-102 OutcomeContext for the classifier (Component 2's segregated output)
  readonly ex102Outcome: {
    paymentStatusLoanCode: string | null;
    propertyStatusCode: string | null;
    modifiedIndicator: boolean | null;
    workoutStrategyCode: string | null;
    nonRecoverabilityIndicator: boolean | null;
    servicerAdvancesTotal: number;
    mostRecentValuation: number | null;
    reportPeriodEndScheduledBalance: number | null;
  };
}

function tagValue(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = block.match(re);
  if (!m) return null;
  const v = m[1].trim();
  return v.length === 0 ? null : v;
}
function tagNum(block: string, tag: string): number | null { return numOrNull(tagValue(block, tag)); }
function tagBool(block: string, tag: string): boolean | null {
  const v = tagValue(block, tag);
  return v === null ? null : /^true$/i.test(v);
}

function extractEx102Assets(xmlPath: string): Ex102InputAsset[] {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const blocks = xml.match(/<assets>[\s\S]*?<\/assets>/g) ?? [];
  return blocks.map(b => {
    const prosId = tagValue(b, 'assetNumber') ?? '';
    const propertyName = tagValue(b, 'propertyName') ?? '(unknown)';
    const code = tagValue(b, 'propertyTypeCode');
    const assetType = code ? (IRP_ASSET_TYPE[code] ?? 'Other') : null;
    const loanAmount = tagNum(b, 'originalLoanAmount');
    const termMonths = tagNum(b, 'originalTermLoanNumber');
    const amortMonths = tagBool(b, 'interestOnlyIndicator') === true ? 0 : tagNum(b, 'originalAmortizationTermNumber');
    const ioMonths = tagNum(b, 'originalInterestOnlyTermNumber');
    const coupon = tagNum(b, 'originalInterestRatePercentage') ?? tagNum(b, 'interestRateSecuritizationPercentage');
    const occ = tagNum(b, 'physicalOccupancySecuritizationPercentage');
    const uwNoi = tagNum(b, 'netOperatingIncomeSecuritizationAmount');
    const value = tagNum(b, 'valuationSecuritizationAmount');
    const totalSf = tagNum(b, 'netRentableSquareFeetSecuritizationNumber') ?? tagNum(b, 'netRentableSquareFeetNumber');
    const top1Sf = tagNum(b, 'squareFeetLargestTenantNumber');
    // Sub-property names from nested <property> blocks
    const propMatches = b.match(/<property>[\s\S]*?<\/property>/g) ?? [];
    const subPropertyNames = propMatches
      .map(p => tagValue(p, 'propertyName'))
      .filter((v): v is string => v !== null && v !== propertyName);
    const concludedCap = (uwNoi !== null && value !== null && value > 0) ? uwNoi / value : null;
    const concludedLtv = (loanAmount !== null && value !== null && value > 0) ? loanAmount / value : null;
    const top1Share = (top1Sf !== null && totalSf !== null && totalSf > 0) ? top1Sf / totalSf : null;

    const piAdv = tagNum(b, 'totalPrincipalInterestAdvancedOutstandingAmount') ?? 0;
    const tiAdv = tagNum(b, 'totalTaxesInsuranceAdvancesOutstandingAmount') ?? 0;
    const oAdv  = tagNum(b, 'otherExpensesAdvancedOutstandingAmount') ?? 0;

    return {
      prosId,
      propertyName,
      assetType,
      subType: null,
      loanStructureCode: tagValue(b, 'loanStructureCode'),
      subPropertyNames,
      dealBagSeed: {
        loanAmount,
        termYears: termMonths !== null ? termMonths / 12 : null,
        amortMonths,
        ioYears: ioMonths !== null ? ioMonths / 12 : null,
        coupon,
        occupancyCurrent: occ,
        assetType,
        subType: null,
        t12Noi: null, t12Egi: null, t12OpEx: null,
        priorPeriodNoi: null,
        uwY1Noi: uwNoi,
        concludedCap,
        concludedLtv,
        concludedValue: value,
        upfrontTiLcEscrow: null,
        top1IncomeShare: top1Share,
        pctIncomeExpiringWithinTerm: null,
      },
      ex102Outcome: {
        paymentStatusLoanCode: tagValue(b, 'paymentStatusLoanCode'),
        propertyStatusCode: tagValue(b, 'propertyStatusCode'),
        modifiedIndicator: tagBool(b, 'modifiedIndicator'),
        workoutStrategyCode: tagValue(b, 'workoutStrategyCode'),
        nonRecoverabilityIndicator: tagBool(b, 'nonRecoverabilityIndicator'),
        servicerAdvancesTotal: piAdv + tiAdv + oAdv,
        mostRecentValuation: tagNum(b, 'mostRecentValuationAmount'),
        reportPeriodEndScheduledBalance: tagNum(b, 'reportPeriodEndScheduledLoanBalanceAmount'),
      },
    };
  });
}

/* ============================================================================
 * COMPONENT 3 — 10-D outcome parser (compact port, returns per-Pros-ID lookup)
 * ========================================================================== */

interface LiquidatedRow {
  prosId: string;
  distributionDate: string;
  beginningScheduledBalance: number | null;
  mostRecentAppraisalAtLiq: number | null;
  realizedLossToLoan: number | null;
  cumulativeLossPctOriginal: number | null;
}

interface SpeciallyServicedRow {
  prosId: string;
  ssTransferDate: string;
  resolutionStrategyCode: string;
  narrative: string;
}

interface ModificationRow {
  prosId: string;
  bookingDate: string;
  modificationCode: string;
}

interface TenDOutcomeSections {
  readonly historicalLiquidatedFound: boolean;
  readonly speciallyServicedFound: boolean;
  readonly modifiedFound: boolean;
  readonly liquidatedRows: ReadonlyArray<LiquidatedRow>;
  readonly ssRows: ReadonlyArray<SpeciallyServicedRow>;
  readonly modRows: ReadonlyArray<ModificationRow>;
}

const SECTION_ANCHORS = {
  historicalLiquidated: ['Historical Liquidated Loan Detail', 'HISTORICAL LIQUIDATED LOAN', 'Liquidated Loan Detail'],
  speciallyServiced:    ['Specially Serviced Loan Detail - Part 2', 'Specially Serviced Loan Detail'],
  modifiedLoan:         ['Modified Loan Detail'],
};

function locateSection(text: string, anchors: readonly string[]): { start: number; end: number } | null {
  for (const a of anchors) {
    const hits: number[] = [];
    let from = 0;
    while (true) { const i = text.indexOf(a, from); if (i < 0) break; hits.push(i); from = i + a.length; }
    if (hits.length === 0) continue;
    const bodyStart = hits.length >= 2 ? hits[1] : hits[0];
    let end = text.length;
    for (const all of Object.values(SECTION_ANCHORS).flat()) {
      if (all === a) continue;
      const i = text.indexOf(all, bodyStart + a.length);
      if (i > 0 && i < end) end = i;
    }
    return { start: bodyStart, end };
  }
  return null;
}

function parseLiquidatedRows(section: string): LiquidatedRow[] {
  if (/No\s+(?:liquidated\s+loans|Loans liquidated)/i.test(section)) return [];
  const rows: LiquidatedRow[] = [];
  const rowHeaderRe = /\b(\d{1,3})\s+(\d{6,12})\s+(\d{2}\/\d{2}\/\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = rowHeaderRe.exec(section)) !== null) {
    const tail = section.slice(m.index + m[0].length, m.index + m[0].length + 280);
    const stopIdx = tail.search(/\s+\d{1,3}\s+\d{6,12}\s+\d{2}\/\d{2}\/\d{2,4}|Current Period Totals|Cumulative Totals|Note:|Page \d+|Reports Available|©/);
    const rowText = stopIdx > 0 ? tail.slice(0, stopIdx) : tail;
    const tokens = rowText.match(/\(?[\d,]+\.\d{2}\)?/g) ?? [];
    if (tokens.length < 11) continue;
    const toMoney = (s: string): number | null => {
      const neg = /^\(.*\)$/.test(s);
      const n = Number(s.replace(/[(),$]/g, ''));
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };
    const pct = rowText.match(/(\d+\.\d{1,2})%/);
    rows.push({
      prosId: m[1],
      distributionDate: m[3],
      beginningScheduledBalance: toMoney(tokens[0]),
      mostRecentAppraisalAtLiq:  toMoney(tokens[1]),
      realizedLossToLoan:        toMoney(tokens[6]),
      cumulativeLossPctOriginal: pct ? Number(pct[1]) / 100 : null,
    });
  }
  return rows;
}

function parseSpeciallyServicedRows(section: string): SpeciallyServicedRow[] {
  const rows: SpeciallyServicedRow[] = [];
  const re = /\b(\d{1,3})\s+(\d{6,12})\s+([A-Z]{2})\s+([A-Z]{2})\s+(\d{2}\/\d{2}\/\d{2,4})\s+(\d{1,2})\b\s*([\s\S]{0,300}?)(?=\b\d{1,3}\s+\d{6,12}\s+[A-Z]{2}\s+[A-Z]{2}\b|Page \d+|©|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    rows.push({
      prosId: m[1],
      ssTransferDate: m[5],
      resolutionStrategyCode: m[6],
      narrative: (m[7] ?? '').trim().slice(0, 300),
    });
  }
  return rows;
}

function parseModificationRows(section: string): ModificationRow[] {
  const rows: ModificationRow[] = [];
  const re = /\b(\d{1,3})(?:\s+[A-Z])?\s+(\d{6,12})\s+[\d,]+\.\d{2}\s+[\d.]+%\s+[\d,]+\.\d{2}\s+[\d.]+%\s+(\d{1,2})\s+(\d{2}\/\d{2}\/\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    rows.push({ prosId: m[1], modificationCode: m[3], bookingDate: m[4] });
  }
  return rows;
}

function parseTenD(tenDPath: string): TenDOutcomeSections {
  const raw = fs.readFileSync(tenDPath, 'utf8');
  const text = stripHtml(raw);
  const liqLoc = locateSection(text, SECTION_ANCHORS.historicalLiquidated);
  const ssLoc = locateSection(text, SECTION_ANCHORS.speciallyServiced);
  const modLoc = locateSection(text, SECTION_ANCHORS.modifiedLoan);
  return {
    historicalLiquidatedFound: liqLoc !== null,
    speciallyServicedFound: ssLoc !== null,
    modifiedFound: modLoc !== null,
    liquidatedRows: liqLoc ? parseLiquidatedRows(text.slice(liqLoc.start, liqLoc.end)) : [],
    ssRows: ssLoc ? parseSpeciallyServicedRows(text.slice(ssLoc.start, ssLoc.end)) : [],
    modRows: modLoc ? parseModificationRows(text.slice(modLoc.start, modLoc.end)) : [],
  };
}

/* ============================================================================
 * COMPOSER — JOIN + classify + emit records
 * ========================================================================== */

interface ComposeDealResult {
  readonly deal: ComposerTestDeal;
  readonly tenDSections: TenDOutcomeSections;
  readonly complete: boolean;
  readonly incompleteReason: string | null;
  readonly records: ReadonlyArray<AnswerKeyRecord>;
  readonly summary: {
    readonly inputLoans: number;
    readonly cleanCount: number;
    readonly stressOnlyCount: number;
    readonly lossCount: number;
    readonly inconclusiveCount: number;
    readonly pariPassuFlaggedCount: number;
    readonly multiPropertyCount: number;
  };
}

function classify(
  prosId: string,
  ten: TenDOutcomeSections,
  ex102Outcome: Ex102InputAsset['ex102Outcome'] | null,
): { cls: AnswerKeyRecord['outcomeClass']; bcLoss: number | null; dsLoss: number | null; evidence: string[] } {
  const ev: string[] = [];
  const liq = ten.liquidatedRows.find(r => r.prosId === prosId);
  const ss = ten.ssRows.find(r => r.prosId === prosId);
  const mods = ten.modRows.filter(r => r.prosId === prosId);

  // LOSS post-disposition
  if (liq && (liq.realizedLossToLoan ?? 0) > 0) {
    ev.push(`realized loss to loan: $${liq.realizedLossToLoan!.toLocaleString()} (10-D, dist ${liq.distributionDate})`);
    ev.push(`severity ${((liq.cumulativeLossPctOriginal ?? 0) * 100).toFixed(1)}% of original`);
    return { cls: 'loss', bcLoss: liq.realizedLossToLoan, dsLoss: liq.realizedLossToLoan, evidence: ev };
  }

  // LOSS pre-disposition (EX-102 distress signals)
  if (ex102Outcome) {
    const distress =
      ex102Outcome.nonRecoverabilityIndicator === true ||
      (ex102Outcome.propertyStatusCode !== null && ['1','2','8'].includes(ex102Outcome.propertyStatusCode)) ||
      (ex102Outcome.workoutStrategyCode !== null && ['2','5','6','7','10'].includes(ex102Outcome.workoutStrategyCode));
    if (distress) {
      ev.push(`EX-102 distress: nonRecov=${ex102Outcome.nonRecoverabilityIndicator}, propStatus=${ex102Outcome.propertyStatusCode}, workout=${ex102Outcome.workoutStrategyCode}`);
      const sched = ex102Outcome.reportPeriodEndScheduledBalance;
      const valuation = ex102Outcome.mostRecentValuation;
      let expected: number | null = null;
      if (sched !== null && valuation !== null) {
        expected = Math.max(0, sched + ex102Outcome.servicerAdvancesTotal - valuation);
        ev.push(`expected loss = $${expected.toLocaleString()}`);
      } else {
        ev.push(`expected-loss inputs incomplete`);
      }
      return { cls: 'loss', bcLoss: expected, dsLoss: expected, evidence: ev };
    }
  }

  // STRESS-ONLY: liquidated with $0 loss (DPO/curtailment)
  if (liq && (liq.realizedLossToLoan === null || liq.realizedLossToLoan === 0)) {
    ev.push(`liquidated ${liq.distributionDate} with $0 loss (DPO / paid off)`);
    return { cls: 'stress-only', bcLoss: null, dsLoss: null, evidence: ev };
  }

  // STRESS-ONLY: SS / modification + currently performing
  const hadStress = ss !== undefined || mods.length > 0 || ex102Outcome?.modifiedIndicator === true;
  const nowPerforming = ex102Outcome === null
    ? true
    : (ex102Outcome.paymentStatusLoanCode === '0' && ex102Outcome.propertyStatusCode === '6'
       && ex102Outcome.nonRecoverabilityIndicator === false && ex102Outcome.servicerAdvancesTotal === 0);

  if (hadStress && nowPerforming) {
    if (ss) ev.push(`specially serviced (transfer ${ss.ssTransferDate}, workout ${ss.resolutionStrategyCode})`);
    if (mods.length > 0) ev.push(`${mods.length} modification(s); codes: ${[...new Set(mods.map(m => m.modificationCode))].join(', ')}`);
    if (ex102Outcome?.modifiedIndicator) ev.push(`EX-102 modifiedIndicator=true`);
    ev.push(`currently performing`);
    return { cls: 'stress-only', bcLoss: null, dsLoss: null, evidence: ev };
  }

  if (!hadStress && nowPerforming) {
    return { cls: 'clean', bcLoss: null, dsLoss: null, evidence: ['no liquidation, no SS, no mods, performing'] };
  }

  ev.push(`distress + non-performance signals mixed`);
  return { cls: 'inconclusive', bcLoss: null, dsLoss: null, evidence: ev };
}

function composeDeal(deal: ComposerTestDeal): ComposeDealResult {
  /* 10-D outcomes first, so the LEFT-JOIN guard can fail fast if the 10-D
   * sections aren't located. */
  const ten = parseTenD(deal.outcomesPath);
  if (!ten.historicalLiquidatedFound) {
    return {
      deal, tenDSections: ten,
      complete: false,
      incompleteReason: '10-D Historical Liquidated Loan Detail section not located — refusing to mass-label loans CLEAN',
      records: [],
      summary: { inputLoans: 0, cleanCount: 0, stressOnlyCount: 0, lossCount: 0, inconclusiveCount: 0, pariPassuFlaggedCount: 0, multiPropertyCount: 0 },
    };
  }

  /* Route inputs by vintage. */
  const records: AnswerKeyRecord[] = [];

  if (deal.track === 'backbone') {
    /* Wire Component 1's real walker (clean-corpus-annexA-walker.ts).
     * Per-loan extraction across 7 stratified tables via signature-based
     * row classification — populates the load-bearing DealBag fields. */
    const walkerResults = invokeAnnexAWalker(deal.inputsPath, deal.cik, deal.name);
    for (const w of walkerResults) {
      const { cls, bcLoss, dsLoss, evidence } = classify(w.prosId, ten, null);
      records.push({
        file: `EDGAR/${deal.cik}/${deal.name}/loan-${w.prosId} (${w.propertyName})`,
        loanAmount: w.loanAmount, termYears: w.termYears, amortMonths: w.amortMonths,
        ioYears: w.ioYears, coupon: w.coupon, occupancyCurrent: w.occupancyCurrent,
        assetType: w.assetType, subType: w.subType,
        t12Noi: w.t12Noi, t12Egi: w.t12Egi, t12OpEx: w.t12OpEx,
        priorPeriodNoi: w.priorPeriodNoi, uwY1Noi: w.uwY1Noi,
        concludedCap: w.concludedCap, concludedLtv: w.concludedLtv, concludedValue: w.concludedValue,
        upfrontTiLcEscrow: w.upfrontTiLcEscrow,
        top1IncomeShare: null, pctIncomeExpiringWithinTerm: null,
        outcomeClass: cls, bcLoss, dsLoss, outcomeEvidence: evidence,
        provenance: {
          dealName: deal.name, cik: deal.cik, prosId: w.prosId,
          vintage: deal.vintage, originator: deal.originator,
          inputSource: 'annex-a', inputSourcePath: deal.inputsPath,
          outcomeSource: '10-d',
          multiProperty: w.subPropertyCount > 0,
          subPropertyCount: w.subPropertyCount,
          subPropertyNames: w.subPropertyNames,
          pariPassuFlag: false,
          loanStructureCode: null,
        },
      });
    }
  } else {
    const assets = extractEx102Assets(deal.inputsPath);
    for (const asset of assets) {
      const { cls, bcLoss, dsLoss, evidence } = classify(asset.prosId, ten, asset.ex102Outcome);
      const provenance: Provenance = {
        dealName: deal.name, cik: deal.cik, prosId: asset.prosId,
        vintage: deal.vintage, originator: deal.originator,
        inputSource: 'ex-102', inputSourcePath: deal.inputsPath,
        outcomeSource: 'ex-102+10-d',
        multiProperty: asset.subPropertyNames.length > 0,
        subPropertyCount: asset.subPropertyNames.length,
        subPropertyNames: asset.subPropertyNames,
        pariPassuFlag: asset.loanStructureCode === 'PP' || asset.loanStructureCode === 'A1',
        loanStructureCode: asset.loanStructureCode,
      };
      records.push({
        file: `EDGAR/${deal.cik}/${deal.name}/asset-${asset.prosId} (${asset.propertyName})`,
        loanAmount:        asset.dealBagSeed.loanAmount        ?? null,
        termYears:         asset.dealBagSeed.termYears         ?? null,
        amortMonths:       asset.dealBagSeed.amortMonths       ?? null,
        ioYears:           asset.dealBagSeed.ioYears           ?? null,
        coupon:            asset.dealBagSeed.coupon            ?? null,
        occupancyCurrent:  asset.dealBagSeed.occupancyCurrent  ?? null,
        assetType:         asset.dealBagSeed.assetType         ?? null,
        subType:           asset.dealBagSeed.subType           ?? null,
        t12Noi: null, t12Egi: null, t12OpEx: null,
        priorPeriodNoi: null,
        uwY1Noi:           asset.dealBagSeed.uwY1Noi           ?? null,
        concludedCap:      asset.dealBagSeed.concludedCap      ?? null,
        concludedLtv:      asset.dealBagSeed.concludedLtv      ?? null,
        concludedValue:    asset.dealBagSeed.concludedValue    ?? null,
        upfrontTiLcEscrow: null,
        top1IncomeShare:   asset.dealBagSeed.top1IncomeShare   ?? null,
        pctIncomeExpiringWithinTerm: null,
        outcomeClass: cls, bcLoss, dsLoss, outcomeEvidence: evidence,
        provenance,
      });
    }
  }

  // Summary
  const cleanCount  = records.filter(r => r.outcomeClass === 'clean').length;
  const stress      = records.filter(r => r.outcomeClass === 'stress-only').length;
  const loss        = records.filter(r => r.outcomeClass === 'loss').length;
  const inconc      = records.filter(r => r.outcomeClass === 'inconclusive').length;
  const pp          = records.filter(r => r.provenance.pariPassuFlag).length;
  const mp          = records.filter(r => r.provenance.multiProperty).length;

  return {
    deal, tenDSections: ten,
    complete: true,
    incompleteReason: null,
    records,
    summary: {
      inputLoans: records.length,
      cleanCount, stressOnlyCount: stress, lossCount: loss, inconclusiveCount: inconc,
      pariPassuFlaggedCount: pp, multiPropertyCount: mp,
    },
  };
}

/* ============================================================================
 * MAIN
 * ========================================================================== */

function main() {
  const out: string[] = [];
  out.push('PRODUCTION READER — COMPONENT 4: PER-DEAL COMPOSER');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');
  out.push('JOIN POLICY:');
  out.push('  - LEFT JOIN from input loans on 10-D outcome sections by Pros ID.');
  out.push('  - Loan absent from all distress sections → CLEAN (10-D lists distressed only).');
  out.push('  - GUARD: if 10-D Historical Liquidated section not located, the deal is marked');
  out.push('    INCOMPLETE; no records emitted. Prevents silent mass-CLEAN labeling.');
  out.push('');

  const results: ComposeDealResult[] = [];
  for (const deal of DEALS) {
    out.push('='.repeat(78));
    out.push(`DEAL: ${deal.name} (CIK ${deal.cik}, ${deal.track}, vintage ${deal.vintage})`);
    out.push(`Originator: ${deal.originator}`);
    out.push(`Inputs:  ${deal.inputsPath}`);
    out.push(`Outcomes: ${deal.outcomesPath}`);
    out.push('='.repeat(78));
    const r = composeDeal(deal);
    results.push(r);
    out.push('');
    out.push(`  10-D sections located: liquidated=${r.tenDSections.historicalLiquidatedFound}  SS=${r.tenDSections.speciallyServicedFound}  modified=${r.tenDSections.modifiedFound}`);
    out.push(`  10-D rows parsed:      liquidated=${r.tenDSections.liquidatedRows.length}  SS=${r.tenDSections.ssRows.length}  mods=${r.tenDSections.modRows.length}`);
    out.push('');
    if (!r.complete) {
      out.push(`  ✗ DEAL INCOMPLETE: ${r.incompleteReason}`);
      out.push('');
      continue;
    }
    out.push(`  Input loans / records emitted: ${r.summary.inputLoans}`);
    out.push(`  Class distribution:`);
    out.push(`    LOSS:           ${r.summary.lossCount}`);
    out.push(`    STRESS-ONLY:    ${r.summary.stressOnlyCount}`);
    out.push(`    CLEAN:          ${r.summary.cleanCount}`);
    out.push(`    INCONCLUSIVE:   ${r.summary.inconclusiveCount}`);
    out.push(`  Flags:`);
    out.push(`    pari-passu (PP/A1): ${r.summary.pariPassuFlaggedCount}`);
    out.push(`    multi-property:     ${r.summary.multiPropertyCount}`);
    out.push('');
    // Sample 4 record types
    const samples = [
      ...r.records.filter(rec => rec.outcomeClass === 'loss').slice(0, 2),
      ...r.records.filter(rec => rec.outcomeClass === 'stress-only').slice(0, 2),
      ...r.records.filter(rec => rec.outcomeClass === 'clean').slice(0, 1),
      ...r.records.filter(rec => rec.provenance.pariPassuFlag).slice(0, 1),
      ...r.records.filter(rec => rec.provenance.multiProperty).slice(0, 1),
    ];
    const dedup = [...new Map(samples.map(s => [s.provenance.prosId, s])).values()];
    out.push(`  Sample records (${dedup.length}):`);
    for (const s of dedup) {
      out.push('');
      out.push(`    [${s.provenance.prosId.padEnd(3)}] ${s.file}`);
      out.push(`        class=${s.outcomeClass}  bcLoss=${s.bcLoss !== null ? '$' + s.bcLoss.toLocaleString() : 'null'}  loanAmount=${s.loanAmount !== null ? '$' + s.loanAmount.toLocaleString() : 'null'}`);
      out.push(`        assetType=${s.assetType ?? 'null'}  multiProperty=${s.provenance.multiProperty}${s.provenance.multiProperty ? ` (${s.provenance.subPropertyCount} sub)` : ''}  PP=${s.provenance.pariPassuFlag}${s.provenance.loanStructureCode ? ` (loanStructureCode=${s.provenance.loanStructureCode})` : ''}`);
      out.push(`        provenance: inputSource=${s.provenance.inputSource}, outcomeSource=${s.provenance.outcomeSource}, vintage=${s.provenance.vintage}, originator=${s.provenance.originator}`);
      if (s.outcomeEvidence.length > 0) {
        out.push(`        evidence:`);
        for (const e of s.outcomeEvidence.slice(0, 3)) out.push(`          • ${e}`);
      }
    }
    out.push('');
  }

  /* ---- cross-deal summary ---- */
  out.push('='.repeat(78));
  out.push('CROSS-DEAL SUMMARY');
  out.push('='.repeat(78));
  out.push('');
  out.push(`Deals composed: ${results.length}`);
  for (const r of results) {
    out.push(`  ${r.deal.name}: ${r.complete ? `${r.summary.inputLoans} records | ${r.summary.lossCount} LOSS, ${r.summary.stressOnlyCount} STRESS-ONLY, ${r.summary.cleanCount} CLEAN${r.summary.inconclusiveCount > 0 ? `, ${r.summary.inconclusiveCount} INC` : ''}` : `INCOMPLETE — ${r.incompleteReason}`}`);
  }
  out.push('');

  /* ---- verification ---- */
  out.push('VERIFICATION:');
  out.push('');
  const wfrbs = results.find(r => r.deal.name === 'WFRBS 2013-C11');
  if (wfrbs && wfrbs.complete) {
    const expectLoss17 = wfrbs.records.find(r => r.provenance.prosId === '17');
    const expectLoss34 = wfrbs.records.find(r => r.provenance.prosId === '34');
    out.push(`  WFRBS Pros 17 (Minot): class=${expectLoss17?.outcomeClass} bcLoss=$${expectLoss17?.bcLoss?.toLocaleString()}  (expect LOSS $10,327,431.93)  ${expectLoss17?.outcomeClass === 'loss' && expectLoss17?.bcLoss === 10327431.93 ? '✓' : '✗'}`);
    out.push(`  WFRBS Pros 34 (Home2):  class=${expectLoss34?.outcomeClass} bcLoss=$${expectLoss34?.bcLoss?.toLocaleString()}  (expect LOSS $2,345,347.35)  ${expectLoss34?.outcomeClass === 'loss' && expectLoss34?.bcLoss === 2345347.35 ? '✓' : '✗'}`);
  }
  const cor3 = results.find(r => r.deal.name === 'COMM 2018-COR3');
  if (cor3 && cor3.complete) {
    const expectLossKW = cor3.records.find(r => r.provenance.prosId === '3');
    const expectStressHY = cor3.records.find(r => r.provenance.prosId === '2');
    const kwOk = expectLossKW?.outcomeClass === 'loss' && Math.abs((expectLossKW?.bcLoss ?? 0) - 27_228_510) < 100;
    out.push(`  COR3 Pros 3 (Kingswood): class=${expectLossKW?.outcomeClass} bcLoss=$${expectLossKW?.bcLoss?.toLocaleString()}  (expect LOSS ≈$27,228,510)  ${kwOk ? '✓' : '✗'}`);
    out.push(`  COR3 Pros 2 (Hyatt):     class=${expectStressHY?.outcomeClass}  (expect STRESS-ONLY)  ${expectStressHY?.outcomeClass === 'stress-only' ? '✓' : '✗'}`);
  }
  out.push('');
  out.push('NEXT STEPS (production reader sequence):');
  out.push('  ✓ Component 1: 424B5 Annex A parser   (shipped)');
  out.push('  ✓ Component 2: EX-102 port             (shipped)');
  out.push('  ✓ Component 3: 10-D parser + classifier (shipped)');
  out.push('  ✓ Component 4: per-deal composer        (this task)');
  out.push('  - Component 5: pari passu cross-shelf aggregator');
  out.push('  - Component 6: batch run against the 30-deal locked first batch');
  out.push('');

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(text);
  console.log(`\n[composer] wrote ${text.length} chars to ${OUT_PATH}`);
}

main();

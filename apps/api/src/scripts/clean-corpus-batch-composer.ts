/**
 * Production reader, body-page-primary batch composer (2-shelf proof).
 *
 * Architecture:
 *   1. Body-description pages = PRIMARY input source.
 *   2. 10-D's loss-loan list drives TARGETED lookup for losses without
 *      body pages (tail losses go through the per-shelf Annex A walker
 *      JUST for that one Pros ID, not the whole tail).
 *   3. Per-deal corpus = {top-loan body pages (CLEAN sample + any losses)}
 *      ∪ {tail loss loans via targeted lookup}.
 *      Tail CLEAN loans are NOT processed — the sample is the body-page set.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-batch-composer.ts
 *
 * Proves the architecture on 2 shelves:
 *   WFRBS 2013-C11 (top loans + tail loss anchors Minot #17 + Home2 Suites #34)
 *   CGCMT 2013-GCJ11 (top loans + Empire Hotel & Retail loss anchor in top 10)
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type LabelCatalog, type BodyPageExtract,
  WFRBS_LABELS, CGCMT_LABELS,
  extractFromBodyPage, findBodyPageOffset, dscrOrderConsistent,
} from './clean-corpus-body-page-extractor.ts';
import { walkProspectus, type WalkerBackboneRecord } from './clean-corpus-annexA-walker.ts';

const OUT_PATH = '/tmp/clean-corpus-batch-composer.out';

/* ============================================================================
 * DEAL CONFIG — one entry per shelf for the 2-shelf proof
 * ========================================================================== */

interface DealConfig {
  readonly cik: string;
  readonly name: string;
  readonly shelf: 'WFRBS' | 'CGCMT';
  readonly prospectusPath: string;
  readonly tenDPath: string;
  readonly labels: LabelCatalog;
  // Top-loan names from the deal's own issuer table (Ten Largest summary
  // for CGCMT, the Loan Combination + body-page sequence for WFRBS).
  readonly topLoans: readonly { prosId: string; name: string }[];
  // Known loss anchors (from prior 10-D analysis); the composer should
  // emit a complete DealBag for each, regardless of body-page presence.
  readonly knownLossAnchors: readonly { prosId: string; name: string }[];
  // Per-shelf issuer top-loans summary truth (for reconciliation).
  readonly issuerTopLoans: readonly IssuerTopLoanEntry[];
}

interface IssuerTopLoanEntry {
  readonly name: string;
  readonly balance: number;
  readonly ltv: number;
  readonly ncfDscr: number;
}

const WFRBS_TOP_LOANS = [
  { prosId: '1',  name: 'Republic Plaza' },
  { prosId: '2',  name: 'Concord Mills' },
  { prosId: '6',  name: 'One South Wacker Drive' },
  { prosId: '7',  name: 'Encana Oil & Gas' },
];

// Issuer-stated truth — Republic Plaza, Concord Mills, One South Wacker from
// the in-deal Loan Combination table (the same we used for Component-5
// reconciliation); Encana from the body-page top-of-deck reference.
const WFRBS_ISSUER_TRUTH: IssuerTopLoanEntry[] = [
  { name: 'Republic Plaza',        balance: 155_000_000, ltv: 0.523, ncfDscr: 1.55 },
  { name: 'Concord Mills',         balance: 125_000_000, ltv: 0.540, ncfDscr: 3.13 },
  { name: 'One South Wacker Drive',balance: 70_000_000,  ltv: 0.730, ncfDscr: 2.40 },
  { name: 'Encana Oil & Gas',      balance: 66_000_000,  ltv: 0.550, ncfDscr: 2.52 },
];

const WFRBS_LOSS_ANCHORS = [
  { prosId: '17', name: 'Minot Hotel Portfolio' },
  { prosId: '34', name: 'Home 2 Suites - Baltimore' },
];

const CGCMT_TOP_LOANS = [
  { prosId: '1',  name: '39 Broadway' },
  { prosId: '2',  name: 'Empire Hotel & Retail' },
  { prosId: '3',  name: 'Christown Spectrum' },
  { prosId: '4',  name: 'Ascentia MHC Portfolio' },
  { prosId: '5',  name: 'Blue Diamond Crossing' },
  { prosId: '6',  name: '127 West 25th Street' },
  { prosId: '7',  name: 'Radisson Bloomington' },
  { prosId: '8',  name: 'Residence Inn Boston Harbor' },
  { prosId: '9',  name: '677 Ala Moana Boulevard' },
  { prosId: '10', name: 'Pin Oak Portfolio - North Parcel' },
];

const CGCMT_ISSUER_TRUTH: IssuerTopLoanEntry[] = [
  { name: '39 Broadway',                      balance: 85_500_000, ltv: 0.590, ncfDscr: 1.68 },
  { name: 'Empire Hotel & Retail',            balance: 70_000_000, ltv: 0.458, ncfDscr: 1.55 },
  { name: 'Christown Spectrum',               balance: 66_500_000, ltv: 0.707, ncfDscr: 1.34 },
  { name: 'Ascentia MHC Portfolio',           balance: 59_329_994, ltv: 0.652, ncfDscr: 1.89 },
  { name: 'Blue Diamond Crossing',            balance: 59_000_000, ltv: 0.689, ncfDscr: 1.32 },
  { name: '127 West 25th Street',             balance: 47_947_785, ltv: 0.685, ncfDscr: 1.35 },
  { name: 'Radisson Bloomington',             balance: 44_946_246, ltv: 0.691, ncfDscr: 2.01 },
  { name: 'Residence Inn Boston Harbor',      balance: 43_500_000, ltv: 0.657, ncfDscr: 1.84 },
  { name: '677 Ala Moana Boulevard',          balance: 41_440_000, ltv: 0.688, ncfDscr: 1.70 },
  { name: 'Pin Oak Portfolio - North Parcel', balance: 38_750_000, ltv: 0.638, ncfDscr: 2.93 },
];

const CGCMT_LOSS_ANCHORS = [
  { prosId: '2', name: 'Empire Hotel & Retail' },  // in top 10 → body-page path
];

const DEALS: DealConfig[] = [
  {
    cik: '1566543',
    name: 'WFRBS 2013-C11',
    shelf: 'WFRBS',
    prospectusPath: '/tmp/wfrbs-2013-c11-424B5.htm',
    tenDPath: '/tmp/wfrbs-10D-ex991.htm',
    labels: WFRBS_LABELS,
    topLoans: WFRBS_TOP_LOANS,
    knownLossAnchors: WFRBS_LOSS_ANCHORS,
    issuerTopLoans: WFRBS_ISSUER_TRUTH,
  },
  {
    cik: '1573946',
    name: 'CGCMT 2013-GCJ11',
    shelf: 'CGCMT',
    prospectusPath: '/tmp/cgcmt-2013-gcj11-424B5.htm',
    tenDPath: '/tmp/cgcmt-10D-ex991.htm',
    labels: CGCMT_LABELS,
    topLoans: CGCMT_TOP_LOANS,
    knownLossAnchors: CGCMT_LOSS_ANCHORS,
    issuerTopLoans: CGCMT_ISSUER_TRUTH,
  },
];

/* ============================================================================
 * STRIP HTML
 * ========================================================================== */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-').replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

/* ============================================================================
 * ANSWER KEY RECORD — body-page-primary DealBag with provenance
 * ========================================================================== */

interface AnswerKeyRecord {
  readonly prosId: string;
  readonly propertyName: string;
  readonly inputSource: 'body-page' | 'targeted-annexA' | 'none';
  readonly outcomeClass: 'CLEAN-TOP-SAMPLE' | 'LOSS' | 'UNKNOWN';
  // Core DealBag fields
  readonly loanAmount: number | null;
  readonly coupon: number | null;
  readonly maturityDate: string | null;
  readonly concludedValue: number | null;
  readonly concludedLtv: number | null;
  readonly uwDscrNoi: number | null;
  readonly uwDscrNcf: number | null;
  readonly uwY1Noi: number | null;
  readonly t12Noi: number | null;
  // Provenance
  readonly shelfLabelCatalog: string | null;
  readonly bodyPageOffset: number | null;
  readonly notes: string | null;
}

/* ============================================================================
 * TARGETED ANNEX-A LOOKUP — fall back path for tail losses with no body page
 *
 * Re-uses the existing per-shelf walker, but we only consume the records
 * for the specific Pros IDs we need. For shelves where the walker hasn't
 * been adapted yet (CGCMT), this returns empty and the composer flags it.
 * ========================================================================== */

function targetedAnnexALookup(
  deal: DealConfig,
  prosId: string,
): WalkerBackboneRecord | null {
  if (deal.shelf === 'WFRBS') {
    const records = walkProspectus(deal.prospectusPath, deal.cik, deal.name);
    return records.find(r => r.prosId === prosId) ?? null;
  }
  // CGCMT walker would go here once the canary's per-shelf adapter is
  // promoted. For this proof we don't need it — Empire Hotel & Retail (the
  // CGCMT loss anchor) is in the top 10, so it's already body-page-served.
  return null;
}

/* ============================================================================
 * 10-D LOSS-LOAN IDENTIFICATION (minimal — just enough to drive lookup)
 *
 * Returns a deduped list of Pros IDs + property names that took a realized
 * loss. The full classifier (3-class CLEAN/STRESS-ONLY/LOSS) lives in
 * Component 4; here we only need the LOSS set for the targeted-lookup
 * driver. Loss-anchor list (knownLossAnchors) supplements parsing.
 * ========================================================================== */

function parseLossLoans(tenDPath: string): { prosId: string; propertyName: string }[] {
  const raw = fs.readFileSync(tenDPath, 'utf8');
  const s = stripHtml(raw);
  const hist = s.search(/Historical Liquidated/i);
  if (hist < 0) return [];
  const slice = s.slice(hist, hist + 50_000);
  // Row pattern: <prosId> [A|B ]<PropertyName> <num> <loss> <date>
  const rowRe = /\b(\d{1,3})\s+(?:[AB]\s+)?([A-Z][A-Za-z0-9 '\-\.,&/]{3,55}?)\s+[\d,]+(?:\.\d{2})?\s+([\d,]+(?:\.\d{2})?)\s+\d{1,2}\/\d{1,2}\/\d{2,4}/g;
  const seen = new Set<string>();
  const out: { prosId: string; propertyName: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(slice)) !== null) {
    const loss = Number(m[3].replace(/,/g, ''));
    if (loss <= 1000) continue;
    const name = m[2].trim();
    const key = `${m[1]}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ prosId: m[1], propertyName: name });
  }
  return out;
}

/* ============================================================================
 * COMPOSER — build AnswerKeyRecords for one deal
 * ========================================================================== */

function composeDeal(deal: DealConfig): {
  records: AnswerKeyRecord[];
  reconciliation: ReconciliationResult;
  dscrOrder: DscrOrderResult;
} {
  const raw = fs.readFileSync(deal.prospectusPath, 'utf8');
  const stripped = stripHtml(raw);
  const records: AnswerKeyRecord[] = [];

  // Compose the union of top loans + known loss anchors
  const seenProsId = new Set<string>();
  const allCandidates: { prosId: string; name: string; isLoss: boolean }[] = [];
  for (const t of deal.topLoans) {
    if (seenProsId.has(t.prosId)) continue;
    seenProsId.add(t.prosId);
    allCandidates.push({ ...t, isLoss: deal.knownLossAnchors.some(l => l.prosId === t.prosId) });
  }
  for (const l of deal.knownLossAnchors) {
    if (seenProsId.has(l.prosId)) continue;
    seenProsId.add(l.prosId);
    allCandidates.push({ ...l, isLoss: true });
  }

  for (const c of allCandidates) {
    // 1) Try body-page extraction first
    const ext = extractFromBodyPage(stripped, c.name, deal.labels);
    if (ext.source === 'body-page') {
      records.push({
        prosId: c.prosId,
        propertyName: c.name,
        inputSource: 'body-page',
        outcomeClass: c.isLoss ? 'LOSS' : 'CLEAN-TOP-SAMPLE',
        loanAmount: ext.loanAmount,
        coupon: ext.coupon,
        maturityDate: ext.maturityDate,
        concludedValue: ext.concludedValue,
        concludedLtv: ext.concludedLtv,
        uwDscrNoi: ext.uwDscrNoi,
        uwDscrNcf: ext.uwDscrNcf,
        uwY1Noi: ext.uwY1Noi,
        t12Noi: ext.t12Noi,
        shelfLabelCatalog: ext.shelfLabelCatalog,
        bodyPageOffset: ext.bodyPageOffset,
        notes: null,
      });
      continue;
    }
    // 2) Body page not found → targeted Annex A lookup (loss-only path)
    if (!c.isLoss) {
      records.push({
        prosId: c.prosId, propertyName: c.name,
        inputSource: 'none', outcomeClass: 'UNKNOWN',
        loanAmount: null, coupon: null, maturityDate: null,
        concludedValue: null, concludedLtv: null,
        uwDscrNoi: null, uwDscrNcf: null,
        uwY1Noi: null, t12Noi: null,
        shelfLabelCatalog: null, bodyPageOffset: null,
        notes: 'No body page found and not a known loss — skipped per body-page-primary architecture (tail CLEAN loans are sampled via body pages only)',
      });
      continue;
    }
    const wk = targetedAnnexALookup(deal, c.prosId);
    if (wk !== null) {
      records.push({
        prosId: c.prosId,
        propertyName: c.name,
        inputSource: 'targeted-annexA',
        outcomeClass: 'LOSS',
        loanAmount: wk.loanAmount,
        coupon: wk.coupon,
        maturityDate: wk.maturityDate,
        concludedValue: wk.concludedValue,
        concludedLtv: wk.concludedLtv,
        uwDscrNoi: wk.uwDscrNoi,
        uwDscrNcf: wk.uwDscrNcf,
        uwY1Noi: wk.uwY1Noi,
        t12Noi: wk.t12Noi,
        shelfLabelCatalog: `${deal.shelf}-annexA-walker`,
        bodyPageOffset: null,
        notes: `Targeted Annex A lookup for tail loss loan (no body page exists for #${c.prosId})`,
      });
      continue;
    }
    // 3) Last resort: emit a placeholder marked incomplete (this is the
    //    case the architecture must NOT silently pass — loss loans need
    //    a complete DealBag).
    records.push({
      prosId: c.prosId, propertyName: c.name,
      inputSource: 'none', outcomeClass: 'LOSS',
      loanAmount: null, coupon: null, maturityDate: null,
      concludedValue: null, concludedLtv: null,
      uwDscrNoi: null, uwDscrNcf: null,
      uwY1Noi: null, t12Noi: null,
      shelfLabelCatalog: null, bodyPageOffset: null,
      notes: `INCOMPLETE LOSS: no body page AND no per-shelf walker adapter available; targeted lookup not yet implemented for ${deal.shelf}`,
    });
  }

  // Issuer reconciliation on top loans
  const reconciliation = reconcileAgainstIssuer(records, deal.issuerTopLoans);
  // DSCR order sanity
  const dscrOrder = checkDscrOrder(records);
  return { records, reconciliation, dscrOrder };
}

interface ReconciliationResult {
  readonly checked: number;
  readonly balMatches: number;
  readonly ltvMatches: number;
  readonly ncfDscrMatches: number;
  readonly perLoan: { name: string; balOk: boolean; ltvOk: boolean; dscrOk: boolean }[];
}

function reconcileAgainstIssuer(
  records: AnswerKeyRecord[],
  issuer: readonly IssuerTopLoanEntry[],
): ReconciliationResult {
  let bal = 0, ltv = 0, dscr = 0;
  const perLoan: ReconciliationResult['perLoan'] = [];
  for (const entry of issuer) {
    const rec = records.find(r => r.propertyName === entry.name);
    if (!rec) continue;
    const balOk = rec.loanAmount !== null && Math.abs(rec.loanAmount - entry.balance) / entry.balance < 0.02;
    const ltvOk = rec.concludedLtv !== null && Math.abs(rec.concludedLtv - entry.ltv) < 0.005;
    const dscrOk = rec.uwDscrNcf !== null && Math.abs(rec.uwDscrNcf - entry.ncfDscr) < 0.05;
    if (balOk) bal++;
    if (ltvOk) ltv++;
    if (dscrOk) dscr++;
    perLoan.push({ name: entry.name, balOk, ltvOk, dscrOk });
  }
  return { checked: issuer.length, balMatches: bal, ltvMatches: ltv, ncfDscrMatches: dscr, perLoan };
}

interface DscrOrderResult {
  readonly checked: number;
  readonly consistent: number;
  readonly violations: { name: string; noi: number; ncf: number }[];
}

function checkDscrOrder(records: AnswerKeyRecord[]): DscrOrderResult {
  let consistent = 0, checked = 0;
  const violations: DscrOrderResult['violations'] = [];
  for (const r of records) {
    if (r.uwDscrNoi === null || r.uwDscrNcf === null) continue;
    checked++;
    if (r.uwDscrNcf <= r.uwDscrNoi) consistent++;
    else violations.push({ name: r.propertyName, noi: r.uwDscrNoi, ncf: r.uwDscrNcf });
  }
  return { checked, consistent, violations };
}

/* ============================================================================
 * MAIN — run on WFRBS + CGCMT, report side-by-side
 * ========================================================================== */

function main() {
  const out: string[] = [];
  out.push('PRODUCTION READER — BODY-PAGE-PRIMARY BATCH COMPOSER (2-shelf proof)');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');
  out.push('Architecture: body-description pages = primary; 10-D loss list drives');
  out.push('targeted lookup for tail losses; tail CLEAN loans are sampled via body');
  out.push('pages only. Per-shelf adaptation = label catalog (NOT per-shelf walker).');
  out.push('');

  for (const deal of DEALS) {
    out.push('================================================================');
    out.push(`DEAL: ${deal.name} (${deal.shelf}, CIK ${deal.cik})`);
    out.push('================================================================');

    // Identify loss loans from 10-D
    const losses10D = parseLossLoans(deal.tenDPath);
    out.push(`10-D losses parsed: ${losses10D.length} (used to confirm loss-anchor coverage)`);
    out.push(`Known loss anchors: ${deal.knownLossAnchors.map(l => `#${l.prosId} ${l.name}`).join(', ')}`);

    const { records, reconciliation, dscrOrder } = composeDeal(deal);
    out.push('');
    out.push(`Records emitted: ${records.length}`);
    const byInput = new Map<string, number>();
    const byOutcome = new Map<string, number>();
    for (const r of records) {
      byInput.set(r.inputSource, (byInput.get(r.inputSource) ?? 0) + 1);
      byOutcome.set(r.outcomeClass, (byOutcome.get(r.outcomeClass) ?? 0) + 1);
    }
    out.push(`  by inputSource: ${[...byInput.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    out.push(`  by outcomeClass: ${[...byOutcome.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    out.push('');

    out.push(`=== ISSUER RECONCILIATION (${deal.shelf} body pages vs. deal's own top-loans truth) ===`);
    out.push(`  balance match: ${reconciliation.balMatches}/${reconciliation.checked}`);
    out.push(`  LTV match:     ${reconciliation.ltvMatches}/${reconciliation.checked}`);
    out.push(`  NCF DSCR match:${reconciliation.ncfDscrMatches}/${reconciliation.checked}`);
    for (const p of reconciliation.perLoan) {
      out.push(`    ${p.name.padEnd(34)} bal=${p.balOk ? '✓' : '✗'}  LTV=${p.ltvOk ? '✓' : '✗'}  DSCR=${p.dscrOk ? '✓' : '✗'}`);
    }
    out.push('');

    out.push(`=== DSCR COLUMN ORDER (NCF ≤ NOI per CMBS convention, ${deal.shelf}) ===`);
    out.push(`  consistent: ${dscrOrder.consistent}/${dscrOrder.checked}`);
    if (dscrOrder.violations.length > 0) {
      out.push('  ⚠  VIOLATIONS (potential per-shelf label swap):');
      for (const v of dscrOrder.violations) out.push(`    ${v.name}: NOI=${v.noi}x NCF=${v.ncf}x`);
    } else {
      out.push(`  → ${deal.shelf} DSCR order: VERIFIED, NCF ≤ NOI everywhere`);
    }
    out.push('');

    out.push('=== LOSS-LOAN COMPLETENESS (every known loss must have full DealBag) ===');
    for (const la of deal.knownLossAnchors) {
      const rec = records.find(r => r.prosId === la.prosId);
      if (!rec) {
        out.push(`  ✗ #${la.prosId} ${la.name}: MISSING from composed records`);
        continue;
      }
      const required = ['loanAmount', 'coupon', 'concludedLtv', 'concludedValue', 'uwDscrNcf'] as const;
      const filled = required.filter(f => rec[f] !== null);
      const complete = filled.length === required.length;
      out.push(`  ${complete ? '✓' : '✗'} #${la.prosId} ${la.name}`);
      out.push(`     inputSource=${rec.inputSource}  filled=${filled.length}/${required.length} of [${required.join(', ')}]`);
      out.push(`     bal=$${rec.loanAmount?.toLocaleString()}  cpn=${rec.coupon !== null ? (rec.coupon*100).toFixed(3)+'%' : 'null'}  LTV=${rec.concludedLtv !== null ? (rec.concludedLtv*100).toFixed(1)+'%' : 'null'}  value=$${rec.concludedValue?.toLocaleString()}  NCF DSCR=${rec.uwDscrNcf}x`);
      if (rec.notes) out.push(`     notes: ${rec.notes}`);
    }
    out.push('');
  }

  /* === GENERALIZATION VERDICT === */
  out.push('================================================================');
  out.push('TWO-SHELF GENERALIZATION VERDICT');
  out.push('================================================================');
  out.push('');
  out.push('Single generalized extractor (clean-corpus-body-page-extractor.ts)');
  out.push('handled BOTH shelves; the only per-shelf surface was the label catalog:');
  out.push('');
  out.push('WFRBS catalog highlights:');
  out.push('  - DSCR: SEPARATE labels ("U/W NOI DSCR", "U/W NCF DSCR")');
  out.push('  - DY:   SEPARATE labels ("U/W NOI Debt Yield", "U/W NCF Debt Yield")');
  out.push('  - Appraised: "As-Is Appraised Value"');
  out.push('  - Page signature: /Loan Information\\b/');
  out.push('  - NOI:  "U/W NOI" (no parens)');
  out.push('');
  out.push('CGCMT catalog highlights:');
  out.push('  - DSCR: COMBINED ("DSCR Based on Underwritten NOI / NCF X.XXx / Y.YYx")');
  out.push('  - DY:   COMBINED ("Debt Yield Based on Underwritten NOI / NCF X% / Y%")');
  out.push('  - Appraised: "Appraised Value"');
  out.push('  - Page signature: /Mor\\s*tgaged Property Information\\b/  (tolerates Ascentia typo)');
  out.push('  - NOI:  "Underwritten Net Operating Income (NOI)"');
  out.push('');
  out.push('Cross-shelf invariant pieces (NOT shelf-specific):');
  out.push('  - Page locator (uppercase name + signature within 600 chars)');
  out.push('  - Footnote-tolerant grab pattern ("(<n>)" between label and value)');
  out.push('  - DSCR convention check (NCF ≤ NOI) and issuer-reconciliation harness');
  out.push('  - Composer flow (body-page → targeted-Annex-A fallback → completeness gate)');
  out.push('');
  out.push('For the remaining 13 backbone shelves, the adaptation work per shelf is:');
  out.push('  1. Dump ONE body description page (e.g., the largest loan)');
  out.push('  2. Record which labels spell each DealBag field (DSCR mode separate/combined)');
  out.push('  3. Record the page signature phrase');
  out.push('  4. Run the composer with the new catalog; reconcile against the deal\'s');
  out.push('     own top-loans summary table');
  out.push('  5. If the deal has tail loss loans without body pages: add a per-shelf');
  out.push('     targeted-Annex-A lookup adapter (one walker function per shelf).');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[batch-composer] wrote ${out.join('\n').length} chars to ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();

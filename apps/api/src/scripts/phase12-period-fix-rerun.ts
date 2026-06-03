/**
 * Phase 12 — Sunroad re-run with the period-classification fix (2026-05-31).
 *
 *   cd apps/api && npx tsx src/scripts/phase12-period-fix-rerun.ts
 *
 * Writes to data/phase12-period-fix.db (SEPARATE from data/cre.db and every
 * prior phase db: phase8-rr-node.db, phase9-refi-gate.db,
 * phase10-reserve-footnote-gate.db, phase11-noi-recon.db).
 *
 * Structure (modeled on phase11):
 *   1. Composer pass (same Sunroad ASR / CF / PCA fixtures).
 *   2. PREFLIGHT: inspect AdjustedInputs.capitalReserves to confirm the new
 *      cascade flipped class-(a) values: monthlyReplacementReserves ~$4,579/mo
 *      ($54,952/yr ÷ 12); reimbursements and taxes shifted to the GS U/W
 *      column figures; vacancyLoss reflects the issuer's UW vacancy.
 *      Inspect the new metrics cross-refs: issuerCfUwNoi, inPlaceNoi.
 *   3. Mode A — ingest WITH placeholder per-tenant comps (phase11-style).
 *   4. Mode B — ingest WITHOUT comps.
 *   5. Report:
 *        - Corrected class-(a) values verbatim.
 *        - New AdjustedInputs.metrics.noi (it WILL shift; report).
 *        - issuerCfUwNoi + inPlaceNoi cross-refs.
 *        - JE_TRAILING_ACTUALS_MISSING firing? (expected YES)
 *        - JE_IN_PLACE_MISSING firing? (expected NO)
 *        - JE_PERIOD_LABEL_MISMATCH firing? (expected NO — Sunroad labels are sane)
 *        - P-III-3 / P-III-4 / P-IV-OFF-3 verbatim both modes.
 *        - P-III-15 (NOI recon) verbatim both modes (verdict=insufficient_data
 *          expected because trailingActualNoi is now honestly null).
 *        - A/B/C bucket vs phase11.
 *        - Principles that moved.
 */

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  HandbookEvaluation,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  ManualInputs,
  MarketBenchmarks,
  RevisionId,
  RentRoll,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildExtractionResult } from '../services/extraction/build-extraction-result.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { buildNoiReconciliationFacts } from '../services/handbook/run-llm-context-check.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/phase12-period-fix.db');
const PHASE11_DB = path.join(REPO, 'apps/api/data/phase11-noi-recon.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const WATCH_LIST = [
  'P-II-9',
  'P-III-3',     // Recurring TI/LC/capex deducted from NOI — class-(a) reserves change drives this
  'P-III-4',     // Cash on hand reserves
  'P-III-15',    // NOI-recon — should still return insufficient_data (trailingActualNoi null today)
  'P-IV-OFF-3',  // TI/LC adequacy (office)
] as const;

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][AssetType]>(null);
  byAssetType.Office = {
    vacancy: { median: 0.10, p25: 0.07, p75: 0.13 },
    expenseRatio: { median: 0.30, p25: 0.25, p75: 0.35 },
    capRate: { median: 0.075, p25: 0.07, p75: 0.08 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Office: 0.10 },
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.50), Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(): CreditManifesto {
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

// Corrected per the Sunroad answer-key Property & Loan Summary (Phase A loan-
// fix prerequisite). Previously this const carried placeholder values inherited
// through phase7→8→9→10→11→12 (loanAmount $80M, 7% rate, 30yr amort, 0 IO).
// The real Sunroad loan is $82.46M @ 7.9% IO-only (60 mo IO over a 60 mo term,
// amortization=0). Phase A's DSCR / Debt Yield CONCLUDED-vs-AWAITING_INPUT
// decision depends on these flowing through to AdjustedInputs.metrics.
const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 82_460_000,
  interestRate: 0.079,
  amortization: 0,
  interestOnlyPeriod: 60,
  maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

const PLACEHOLDER_COMP: ManualInputs = {
  marketRentComps: [
    { tenantOrSpace: 'Top Tenant (T-1)',           psf: 29, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Second Tenant (T-2)',        psf: 28, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Third Tenant (T-3)',         psf: 27, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Remaining Tenants (blended)', psf: 26, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
  ],
};

interface RuleOutcome {
  state: 'fired' | 'skipped' | 'absent';
  severity?: string;
  msg: string;
  detail?: string;
  manualInputRequests?: ReadonlyArray<{ kind: string; detail: string }>;
}

function ruleOutcome(he: HandbookEvaluation, pid: string): RuleOutcome {
  const fired = he.firedFlags.find((f) => f.principleId === pid);
  if (fired) return { state: 'fired', severity: fired.severity, msg: fired.flag_message };
  const skipped = he.skippedPrinciples.find((s) => s.principleId === pid);
  if (skipped) return {
    state: 'skipped',
    msg: `reason=${skipped.reason}`,
    detail: skipped.detail,
    manualInputRequests: skipped.manualInputRequests,
  };
  return { state: 'absent', msg: '(not in HE)' };
}

interface Buckets { A: string[]; B: string[]; C: string[]; }

function bucket(he: HandbookEvaluation): Buckets {
  const A: string[] = [];
  const B: string[] = [];
  const C: string[] = [];
  for (const f of he.firedFlags) {
    A.push(`${f.principleId} [${f.severity}] ${f.flag_message.slice(0, 120)}`);
  }
  for (const s of he.skippedPrinciples) {
    if (s.reason === 'needs_manual_input') {
      B.push(`${s.principleId}  → ${s.detail ?? ''}`.slice(0, 160));
    } else {
      C.push(`${s.principleId}  reason=${s.reason}`);
    }
  }
  return { A, B, C };
}

function loadPhase11HE(): HandbookEvaluation | null {
  if (!existsSync(PHASE11_DB)) {
    console.log('  (phase11-noi-recon.db not found — skipping baseline comparison)');
    return null;
  }
  const db = new Database(PHASE11_DB, { readonly: true });
  try {
    const row = db
      .prepare('SELECT id, payload FROM handbook_evaluations LIMIT 1')
      .get() as { id: string; payload: string } | undefined;
    if (!row) return null;
    const body = JSON.parse(row.payload) as Record<string, unknown>;
    return { id: row.id, ...body } as HandbookEvaluation;
  } finally {
    db.close();
  }
}

function reportRule(label: string, r: RuleOutcome): void {
  console.log(`  ${label.padEnd(14)} state=${r.state}${r.severity ? `  severity=${r.severity}` : ''}`);
  console.log(`                  msg:    ${r.msg}`);
  if (r.detail) console.log(`                  detail: ${r.detail}`);
  if (r.manualInputRequests) {
    for (const req of r.manualInputRequests) {
      console.log(`                  → req[${req.kind}]: ${req.detail.slice(0, 200)}`);
    }
  }
}

async function ingest(
  store: RecordGraphStore,
  composed: { extractionResult: import('@cre/contracts').ExtractionResult; rentRoll: RentRoll | null },
  label: string,
  manualInputs: ManualInputs | undefined,
): Promise<HandbookEvaluation> {
  console.log(`\n--- ingest: ${label}`);
  const t0 = Date.now();
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const dealRef = `SUNROAD-PHASE12-${label}`;
  const er = { ...composed.extractionResult, dealRef };
  const { computeExtractionResultId } = await import('../util/content-hash.js');
  const { id: _oldId, ...erBody } = er;
  void _oldId;
  const newId = computeExtractionResultId(erBody);
  const erCorrect = { id: newId, ...erBody } as typeof composed.extractionResult;
  const ingestResult = await ingestExtractionResult(
    {
      extractionResult: erCorrect,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: composed.rentRoll,
    },
    store,
    manualInputs !== undefined ? { manualInputs } : {},
  );
  console.log(`  ingest ms: ${Date.now() - t0}`);
  console.log(`  rootId:    ${ingestResult.rootId}`);
  const envelope = store.getRevisionEnvelope(ingestResult.rootId as RevisionId);
  if (!envelope) throw new Error('envelope null');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (!he) throw new Error('HE null');
  console.log(`  HE id:     ${he.id}`);
  console.log(`  HE handbook: ${he.handbookVersion}  engine: ${he.engineVersion}`);
  return he;
}

(async () => {
  console.log('============================================================');
  console.log('PHASE 12 — period-classification fix live re-run (Sunroad)');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  console.log(`DB:           ${DB_PATH}  (separate from cre.db + phase8/9/10/11 dbs)`);
  console.log(`Baseline:     ${PHASE11_DB}`);
  console.log('');

  // -------- Composer pass
  console.log('--- composer pass (real PCA + ASR AI extraction; ~30-60s)');
  const tComp = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-PHASE12-composer',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);
  console.log(`  typed RentRoll:   ${composed.rentRoll ? `present (${composed.rentRoll.lines.length} lines)` : 'null'}`);
  console.log(`  inPlace.noi:      ${composed.extractionResult.inPlace?.noi ?? 'null'}`);
  console.log(`  t12Actual.noi:    ${composed.extractionResult.t12Actual?.noi ?? 'null'}`);
  console.log(`  sellerUwOS.noi:   ${composed.extractionResult.sellerUwOperatingStatement?.noi ?? 'null'}`);
  console.log(`  inPlace.belowNoi.replReserves:    ${composed.extractionResult.inPlace?.belowNoiAdjustments.replacementReserves ?? 'null'}`);
  console.log(`  sellerUwOS.belowNoi.replReserves: ${composed.extractionResult.sellerUwOperatingStatement?.belowNoiAdjustments.replacementReserves ?? 'null'}`);
  console.log(`  sellerUw.noi:     ${composed.extractionResult.sellerUw?.underwrittenNOI ?? 'null'}`);
  console.log(`  asr.noi:          ${composed.extractionResult.asr?.underwrittenNOI ?? 'null'}`);

  // -------- Preview AdjustedInputs (scratch ingest)
  console.log('\n============================================================');
  console.log('ADJUSTED-INPUTS PREVIEW (server-computed, post period-fix cascades)');
  console.log('============================================================');
  const scratch = new RecordGraphStore(':memory:');
  const previewLib = makeSnapshot();
  scratch.insertLibrarySnapshot(previewLib);
  const previewDealRef = 'SUNROAD-PHASE12-PREVIEW';
  const erPrev = { ...composed.extractionResult, dealRef: previewDealRef };
  const { computeExtractionResultId } = await import('../util/content-hash.js');
  const { id: _oldId, ...erPrevBody } = erPrev;
  void _oldId;
  const newPrevId = computeExtractionResultId(erPrevBody);
  const erPrevCorrect = { id: newPrevId, ...erPrevBody } as typeof composed.extractionResult;
  const previewResult = await ingestExtractionResult(
    {
      extractionResult: erPrevCorrect,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: previewLib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
      rentRoll: composed.rentRoll,
    },
    scratch,
  );
  const envelopePrev = scratch.getRevisionEnvelope(previewResult.rootId as RevisionId);
  if (!envelopePrev) throw new Error('preview envelope null');
  const adjustedInputsPrev = scratch.getAdjustedInputs(envelopePrev.adjustedInputsId);
  if (!adjustedInputsPrev) throw new Error('preview AdjustedInputs null');
  const aip = adjustedInputsPrev;

  console.log('  CORRECTED CLASS-(A) VALUES:');
  console.log(`    monthlyReplacementReserves    adjusted=${aip.capitalReserves.monthlyReplacementReserves.adjusted.toFixed(2)}  source=${aip.capitalReserves.monthlyReplacementReserves.source}`);
  console.log(`    monthlyTenantImprovements     adjusted=${aip.capitalReserves.monthlyTenantImprovements.adjusted.toFixed(2)}  source=${aip.capitalReserves.monthlyTenantImprovements.source}`);
  console.log(`    monthlyLeasingCommissions     adjusted=${aip.capitalReserves.monthlyLeasingCommissions.adjusted.toFixed(2)}  source=${aip.capitalReserves.monthlyLeasingCommissions.source}`);
  console.log(`    monthlyTiLc                   adjusted=${aip.capitalReserves.monthlyTiLc.adjusted.toFixed(2)}  source=${aip.capitalReserves.monthlyTiLc.source}`);
  console.log(`    expenses.realEstateTaxes      adjusted=${aip.expenses.realEstateTaxes.adjusted.toFixed(2)}  source=${aip.expenses.realEstateTaxes.source}`);
  console.log(`    expenses.reimbursements       adjusted=${aip.expenses.reimbursements.adjusted.toFixed(2)}  source=${aip.expenses.reimbursements.source}`);
  console.log(`    income.vacancyPct             adjusted=${aip.income.vacancyPct.adjusted.toFixed(4)}  source=${aip.income.vacancyPct.source}`);
  console.log(`    expenses.totalOperatingExp    adjusted=${aip.expenses.totalOperatingExpenses.adjusted.toFixed(2)}  source=${aip.expenses.totalOperatingExpenses.source}`);

  console.log('\n  ADJUSTED-INPUTS METRICS:');
  console.log(`    noi:                       ${aip.metrics.noi}`);
  console.log(`    dscr:                      ${aip.metrics.dscr}`);
  console.log(`    debtYield:                 ${aip.metrics.debtYield}`);
  console.log(`    expenseRatio:              ${aip.metrics.expenseRatio}`);
  console.log(`    trailingActualNoi:         ${aip.metrics.trailingActualNoi}  (sources from extraction.t12Actual.noi; null today)`);
  console.log(`    issuerCfUwNoi:             ${aip.metrics.issuerCfUwNoi}  (NEW — from CF's GS U/W column)`);
  console.log(`    inPlaceNoi:                ${aip.metrics.inPlaceNoi}  (NEW — from CF's In-Place column)`);
  console.log(`    issuerStatedNoiSellerUw:   ${aip.metrics.issuerStatedNoiSellerUw}  (narrative SellerUW document)`);
  console.log(`    issuerStatedNoiAsr:        ${aip.metrics.issuerStatedNoiAsr}`);

  console.log('\n  DATA-QUALITY FLAGS:');
  for (const f of aip.dataQualityFlags) console.log(`    - ${f}`);
  console.log(`  Period-mismatch entries in topLevelAdjustments:`);
  for (const a of aip.topLevelAdjustments) {
    if (a.ruleId === 'JE_PERIOD_LABEL_MISMATCH') {
      console.log(`    - delta=${a.delta} reason=${a.reason}`);
    }
  }

  // NOI reconciliation preview (was the prime target of phase11; should now
  // return verdict=insufficient_data because trailingActualNoi is null).
  const noiPreview = buildNoiReconciliationFacts(adjustedInputsPrev);
  scratch.close();
  console.log('\n  NOI RECONCILIATION (server-computed Stage-5 input):');
  console.log('    source:                          ', noiPreview.source);
  console.log('    systemUwNoi:                     ', noiPreview.systemUwNoi);
  console.log('    trailingActualNoi:               ', noiPreview.trailingActualNoi);
  console.log('    issuerStatedNoiSellerUw:         ', noiPreview.issuerStatedNoiSellerUw);
  console.log('    issuerStatedNoiAsr:              ', noiPreview.issuerStatedNoiAsr);
  console.log('    excessDollars:                   ', noiPreview.excessDollars);
  console.log('    excessFraction:                  ', noiPreview.excessFraction);
  console.log('    verdict:                         ', noiPreview.verdict);
  console.log('    signedLeaseBackingAvailable:     ', noiPreview.signedLeaseBackingAvailable);
  console.log('    extractionGap.kind:              ', noiPreview.extractionGap.kind);
  console.log('    extractionGap.recommendedInputKind:', noiPreview.extractionGap.recommendedInputKind);

  // -------- Real ingest twice (Mode A + Mode B)
  const store = new RecordGraphStore(DB_PATH);

  console.log('\n============================================================');
  console.log('MODE A — WITH per-tenant market-rent comps');
  console.log('============================================================');
  const heA = await ingest(store, composed, 'mode-A-with-comp', PLACEHOLDER_COMP);

  console.log('\n============================================================');
  console.log('MODE B — WITHOUT comps');
  console.log('============================================================');
  const heB = await ingest(store, composed, 'mode-B-no-comp', undefined);

  // -------- Reports
  console.log('\n============================================================');
  console.log('WATCH LIST (period-fix impacted principles) — verbatim, both modes');
  console.log('============================================================');
  for (const pid of WATCH_LIST) {
    console.log(`\n[${pid}]`);
    console.log('  MODE A:'); reportRule(pid, ruleOutcome(heA, pid));
    console.log('  MODE B:'); reportRule(pid, ruleOutcome(heB, pid));
  }

  // -------- A / B / C buckets vs phase11
  console.log('\n============================================================');
  console.log('A / B / C BUCKETS — phase11 vs phase12 Mode A vs phase12 Mode B');
  console.log('============================================================');
  const p11 = loadPhase11HE();
  const bA = bucket(heA);
  const bB = bucket(heB);
  const b11 = p11 ? bucket(p11) : { A: [], B: [], C: [] };
  console.log(`             |   A (fired) | B (need-input) | C (other skip) | total`);
  console.log(`  phase11    |  ${String(b11.A.length).padStart(9)} | ${String(b11.B.length).padStart(13)} | ${String(b11.C.length).padStart(13)} | ${b11.A.length + b11.B.length + b11.C.length}`);
  console.log(`  phase12 A  |  ${String(bA.A.length).padStart(9)} | ${String(bA.B.length).padStart(13)} | ${String(bA.C.length).padStart(13)} | ${bA.A.length + bA.B.length + bA.C.length}`);
  console.log(`  phase12 B  |  ${String(bB.A.length).padStart(9)} | ${String(bB.B.length).padStart(13)} | ${String(bB.C.length).padStart(13)} | ${bB.A.length + bB.B.length + bB.C.length}`);

  console.log('\nMode A — fired flags (Bucket A):');
  for (const a of bA.A) console.log(`  - ${a}`);
  console.log('\nMode A — needs_manual_input (Bucket B):');
  for (const b of bA.B) console.log(`  - ${b}`);

  // -------- Diff: which principles moved between phase11 and phase12 Mode A?
  if (p11) {
    console.log('\n============================================================');
    console.log('PRINCIPLES THAT MOVED — phase11 → phase12 Mode A');
    console.log('============================================================');
    const allPids = new Set<string>();
    for (const f of p11.firedFlags) allPids.add(f.principleId);
    for (const s of p11.skippedPrinciples) allPids.add(s.principleId);
    for (const f of heA.firedFlags) allPids.add(f.principleId);
    for (const s of heA.skippedPrinciples) allPids.add(s.principleId);
    const sorted = [...allPids].sort();
    let moved = 0;
    for (const pid of sorted) {
      const before = ruleOutcome(p11, pid);
      const after = ruleOutcome(heA, pid);
      const sameState = before.state === after.state;
      const sameReason = (before.state === 'skipped' && after.state === 'skipped' && before.msg === after.msg);
      if (!sameState || (before.state === 'skipped' && !sameReason)) {
        moved++;
        const beforeLbl = before.state === 'fired' ? 'FIRED' : (before.state === 'skipped' ? before.msg : 'absent');
        const afterLbl = after.state === 'fired' ? 'FIRED' : (after.state === 'skipped' ? after.msg : 'absent');
        console.log(`  ${pid.padEnd(20)}  ${beforeLbl.padEnd(38)}  →  ${afterLbl}`);
      }
    }
    if (moved === 0) console.log('  (no principles moved state between phase11 and phase12 Mode A)');
    else console.log(`\n  ${moved} principles moved.`);
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
  console.log(`Mode A HE id: ${heA.id}`);
  console.log(`Mode B HE id: ${heB.id}`);
  console.log(`DB:           ${DB_PATH}`);
})();

/**
 * Phase 11 — Sunroad re-run with the NOI-reconciliation rule (Commit 1 of the
 * Model-A value-add series).
 *
 *   cd apps/api && npx tsx src/scripts/phase11-noi-recon-rerun.ts
 *
 * Writes to data/phase11-noi-recon.db (SEPARATE from data/cre.db,
 * phase8-rr-node.db, phase9-refi-gate.db, phase10-reserve-footnote-gate.db).
 *
 * Structure (modelled on phase10):
 *   1. Composer pass (same ASR/CF/PCA Sunroad fixtures).
 *   2. PREFLIGHT: inspect the noiReconciliation block the gate WILL surface to
 *      the LLM (systemUwNoi, trailingActualNoi, excessDollars, excessFraction,
 *      verdict, plus the signed-lease-status extractionGap marker).
 *   3. Mode A — ingest WITH placeholder per-tenant comps (phase8-style).
 *   4. Mode B — ingest WITHOUT comps.
 *   5. Report:
 *        - noiReconciliation block (verbatim).
 *        - P-III-15 outcome both modes — expected: needs_manual_input with
 *          kind='signed_lease_status_extraction_gap'. Verbatim.
 *        - Whether the gate principle (P-II-9) and any other principles cite the
 *          NOI-recon facts.
 *        - A/B/C bucket vs phase10.
 *        - Any principle that moved.
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
const DB_PATH = path.join(REPO, 'apps/api/data/phase11-noi-recon.db');
const PHASE10_DB = path.join(REPO, 'apps/api/data/phase10-reserve-footnote-gate.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const WATCH_LIST = [
  'P-II-9',      // The "read deal data before asset-class priors" gate principle (Phase 1)
  'P-III-3',     // Recurring TI/LC/capex deducted from NOI
  'P-III-4',     // Cash on hand reserves
  'P-III-15',    // The NEW NOI-recon rule (this commit's prime target)
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

const LOAN_TERMS: LoanTermsExtraction = {
  loanAmount: 80_000_000,
  interestRate: 0.07,
  amortization: 360,
  interestOnlyPeriod: 0,
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

interface Buckets {
  A: string[];
  B: string[];
  C: string[];
}

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

function loadPhase10HE(): HandbookEvaluation | null {
  if (!existsSync(PHASE10_DB)) {
    console.log('  (phase10-reserve-footnote-gate.db not found — skipping baseline comparison)');
    return null;
  }
  const db = new Database(PHASE10_DB, { readonly: true });
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

/**
 * Detect any principle that returned a needs_manual_input citing the new
 * NOI-recon signed-lease-status extraction gap. Helps confirm the gate's
 * extractionGap marker is being consumed end-to-end.
 */
function signedLeaseGapHits(he: HandbookEvaluation): Array<{ principleId: string; detail: string }> {
  const out: Array<{ principleId: string; detail: string }> = [];
  for (const s of he.skippedPrinciples) {
    if (s.reason !== 'needs_manual_input' || !s.manualInputRequests) continue;
    for (const req of s.manualInputRequests) {
      if (req.kind === 'signed_lease_status_extraction_gap') {
        out.push({ principleId: s.principleId, detail: req.detail });
        break;
      }
    }
  }
  return out;
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
  const dealRef = `SUNROAD-PHASE11-${label}`;
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
  console.log('PHASE 11 — NOI-reconciliation Commit 1 live re-run (Sunroad)');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  console.log(`DB:           ${DB_PATH}  (separate from cre.db, phase8/9/10 dbs)`);
  console.log(`Baseline:     ${PHASE10_DB}`);
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
    dealRef: 'SUNROAD-PHASE11-composer',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);
  console.log(`  typed RentRoll:   ${composed.rentRoll ? `present (${composed.rentRoll.lines.length} lines)` : 'null'}`);
  console.log(`  t12.noi:          ${composed.extractionResult.t12?.noi ?? 'null'}`);
  console.log(`  sellerUw.noi:     ${composed.extractionResult.sellerUw?.underwrittenNOI ?? 'null'}`);
  console.log(`  asr.noi:          ${composed.extractionResult.asr?.underwrittenNOI ?? 'null'}`);

  // -------- Pre-LLM: ingest once into a SCRATCH store so we can pull AdjustedInputs
  //          to compute the noiReconciliation preview.
  console.log('\n============================================================');
  console.log('NOI-RECONCILIATION GATE PREVIEW (server-computed BEFORE any LLM call)');
  console.log('============================================================');
  const scratch = new RecordGraphStore(':memory:');
  const previewLib = makeSnapshot();
  scratch.insertLibrarySnapshot(previewLib);
  const previewDealRef = 'SUNROAD-PHASE11-PREVIEW';
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
  const noiPreview = buildNoiReconciliationFacts(adjustedInputsPrev);
  scratch.close();

  console.log('  noiReconciliation (verbatim — server-computed Stage-5 input):');
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
  console.log('    extractionGap.detail:            ', noiPreview.extractionGap.detail);

  // -------- Ingest twice (real store; one composer result reused)
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
  console.log('WATCH LIST (NOI-recon impacted principles) — verbatim, both modes');
  console.log('============================================================');
  for (const pid of WATCH_LIST) {
    console.log(`\n[${pid}]`);
    console.log('  MODE A:'); reportRule(pid, ruleOutcome(heA, pid));
    console.log('  MODE B:'); reportRule(pid, ruleOutcome(heB, pid));
  }

  // -------- Signed-lease-gap hits (any principle that consumed the gap marker)
  console.log('\n============================================================');
  console.log('SIGNED-LEASE-STATUS EXTRACTION-GAP HITS (any principle that returned the kind)');
  console.log('============================================================');
  const gapA = signedLeaseGapHits(heA);
  const gapB = signedLeaseGapHits(heB);
  console.log(`Mode A: ${gapA.length} hits`);
  for (const h of gapA) console.log(`  - ${h.principleId}: ${h.detail.slice(0, 240)}`);
  console.log(`Mode B: ${gapB.length} hits`);
  for (const h of gapB) console.log(`  - ${h.principleId}: ${h.detail.slice(0, 240)}`);

  // -------- A / B / C buckets vs phase10
  console.log('\n============================================================');
  console.log('A / B / C BUCKETS — phase10 vs phase11 Mode A vs phase11 Mode B');
  console.log('============================================================');
  const p10 = loadPhase10HE();
  const bA = bucket(heA);
  const bB = bucket(heB);
  const b10 = p10 ? bucket(p10) : { A: [], B: [], C: [] };
  console.log(`             |   A (fired) | B (need-input) | C (other skip) | total`);
  console.log(`  phase10    |  ${String(b10.A.length).padStart(9)} | ${String(b10.B.length).padStart(13)} | ${String(b10.C.length).padStart(13)} | ${b10.A.length + b10.B.length + b10.C.length}`);
  console.log(`  phase11 A  |  ${String(bA.A.length).padStart(9)} | ${String(bA.B.length).padStart(13)} | ${String(bA.C.length).padStart(13)} | ${bA.A.length + bA.B.length + bA.C.length}`);
  console.log(`  phase11 B  |  ${String(bB.A.length).padStart(9)} | ${String(bB.B.length).padStart(13)} | ${String(bB.C.length).padStart(13)} | ${bB.A.length + bB.B.length + bB.C.length}`);

  console.log('\nMode A — fired flags (Bucket A):');
  for (const a of bA.A) console.log(`  - ${a}`);
  console.log('\nMode A — needs_manual_input (Bucket B):');
  for (const b of bA.B) console.log(`  - ${b}`);

  // -------- Diff: which principles moved between phase10 and phase11 Mode A?
  if (p10) {
    console.log('\n============================================================');
    console.log('PRINCIPLES THAT MOVED — phase10 → phase11 Mode A');
    console.log('============================================================');
    const allPids = new Set<string>();
    for (const f of p10.firedFlags) allPids.add(f.principleId);
    for (const s of p10.skippedPrinciples) allPids.add(s.principleId);
    for (const f of heA.firedFlags) allPids.add(f.principleId);
    for (const s of heA.skippedPrinciples) allPids.add(s.principleId);
    const sorted = [...allPids].sort();
    let moved = 0;
    for (const pid of sorted) {
      const before = ruleOutcome(p10, pid);
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
    if (moved === 0) console.log('  (no principles moved state between phase10 and phase11 Mode A)');
    else console.log(`\n  ${moved} principles moved.`);
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
  console.log(`Mode A HE id: ${heA.id}`);
  console.log(`Mode B HE id: ${heB.id}`);
  console.log(`DB:           ${DB_PATH}`);
})();

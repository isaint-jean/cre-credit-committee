/**
 * Phase 10 — Sunroad re-run with the reserve-read + footnote-read gate (Phase 2 of the
 * "read deal data before asset-class priors" series).
 *
 *   cd apps/api && npx tsx src/scripts/phase10-reserve-footnote-gate-rerun.ts
 *
 * Writes to data/phase10-reserve-footnote-gate.db (SEPARATE from data/cre.db,
 * phase8-rr-node.db, phase9-refi-gate.db).
 *
 * Structure (modelled on phase9):
 *   1. Composer pass (same ASR/CF/PCA Sunroad fixtures).
 *   2. PREFLIGHT: inspect the reserveSchedule the gate WILL surface to the LLM
 *      (all 9 fields verbatim, plus the 3 derived roll-ups) AND the
 *      terminationOptions extraction-gap marker.
 *   3. Mode A — ingest WITH placeholder per-tenant comps.
 *   4. Mode B — ingest WITHOUT comps.
 *   5. Report:
 *        - reserveSchedule the gate surfaced (verbatim).
 *        - terminationOptions extraction-gap marker (verbatim).
 *        - P-IV-OFF-3 / P-III-3 / P-III-4 outcomes — verbatim, both modes.
 *        - Any principle that returned termination_option_extraction_gap.
 *        - A/B/C bucket comparison vs phase9.
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
import {
  buildReserveScheduleFacts,
  buildTerminationOptionsFacts,
} from '../services/handbook/run-llm-context-check.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/phase10-reserve-footnote-gate.db');
const PHASE9_DB = path.join(REPO, 'apps/api/data/phase9-refi-gate.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const WATCH_LIST = [
  'P-II-9',      // The gate principle itself (authored in Phase 1)
  'P-III-3',     // Recurring TI/LC/capex deducted from NOI
  'P-III-4',     // Cash on hand reserves
  'P-IV-OFF-3',  // TI/LC adequacy (office; the prime regression target for Phase 2)
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

function loadPhase9HE(): HandbookEvaluation | null {
  if (!existsSync(PHASE9_DB)) {
    console.log('  (phase9-refi-gate.db not found — skipping baseline comparison)');
    return null;
  }
  const db = new Database(PHASE9_DB, { readonly: true });
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
 * Detect any principle that returned a needs_manual_input with kind matching
 * the Phase 2 termination-option extraction gap. Helps confirm the gate's
 * extractionGap marker is actually being consumed end-to-end.
 */
function terminationGapHits(he: HandbookEvaluation): Array<{ principleId: string; detail: string }> {
  const out: Array<{ principleId: string; detail: string }> = [];
  for (const s of he.skippedPrinciples) {
    if (s.reason !== 'needs_manual_input' || !s.manualInputRequests) continue;
    for (const req of s.manualInputRequests) {
      if (req.kind === 'termination_option_extraction_gap') {
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
  const dealRef = `SUNROAD-PHASE10-${label}`;
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
  console.log('PHASE 10 — reserve-read + footnote-read gate live re-run (Sunroad)');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  console.log(`DB:           ${DB_PATH}  (separate from cre.db, phase8/9 dbs)`);
  console.log(`Baseline:     ${PHASE9_DB}`);
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
    dealRef: 'SUNROAD-PHASE10-composer',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);
  console.log(`  typed RentRoll:   ${composed.rentRoll ? `present (${composed.rentRoll.lines.length} lines)` : 'null'}`);

  // -------- Pre-LLM: ingest once into a SCRATCH store so we can pull AdjustedInputs
  //          to compute the reserveSchedule preview. (The terminationOptions preview
  //          has no inputs.)
  console.log('\n============================================================');
  console.log('RESERVE-SCHEDULE GATE PREVIEW (server-computed BEFORE any LLM call)');
  console.log('============================================================');
  const scratch = new RecordGraphStore(':memory:');
  const previewLib = makeSnapshot();
  scratch.insertLibrarySnapshot(previewLib);
  const previewDealRef = 'SUNROAD-PHASE10-PREVIEW';
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
  const reservePreview = buildReserveScheduleFacts(adjustedInputsPrev);
  const termPreview = buildTerminationOptionsFacts();
  scratch.close();

  console.log('  reserveSchedule (verbatim, all 9 fields + 3 roll-ups):');
  console.log('    source:                          ', reservePreview.source);
  console.log('    monthlyReplacementReserves:      ', reservePreview.monthlyReplacementReserves);
  console.log('    monthlyCapex:                    ', reservePreview.monthlyCapex);
  console.log('    monthlyTiLc:                     ', reservePreview.monthlyTiLc);
  console.log('    monthlyTenantImprovements:       ', reservePreview.monthlyTenantImprovements);
  console.log('    monthlyLeasingCommissions:       ', reservePreview.monthlyLeasingCommissions);
  console.log('    upfrontReplacementReserves:      ', reservePreview.upfrontReplacementReserves);
  console.log('    upfrontTiLc:                     ', reservePreview.upfrontTiLc);
  console.log('    pcaImmediateRepairs:             ', reservePreview.pcaImmediateRepairs);
  console.log('    capexScheduleInflated (n=' + (reservePreview.capexScheduleInflated?.length ?? 0) + '):',
    reservePreview.capexScheduleInflated ? JSON.stringify(reservePreview.capexScheduleInflated).slice(0, 200) : 'null');
  console.log('    totalMonthlyReservesDollars:     ', reservePreview.totalMonthlyReservesDollars);
  console.log('    totalUpfrontReservesDollars:     ', reservePreview.totalUpfrontReservesDollars);
  console.log('    anyMonthlyReservePopulated:      ', reservePreview.anyMonthlyReservePopulated);

  console.log('\n  terminationOptions (verbatim — Phase 2 extraction-gap marker):');
  console.log('    source:        ', termPreview.source);
  console.log('    extracted:     ', termPreview.extracted);
  console.log('    options:       ', termPreview.options);
  if (termPreview.extractionGap !== null) {
    console.log('    extractionGap.kind:                ', termPreview.extractionGap.kind);
    console.log('    extractionGap.recommendedInputKind:', termPreview.extractionGap.recommendedInputKind);
    console.log('    extractionGap.detail:              ', termPreview.extractionGap.detail);
  }

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
  console.log('WATCH LIST (gate-impacted principles) — verbatim, both modes');
  console.log('============================================================');
  for (const pid of WATCH_LIST) {
    console.log(`\n[${pid}]`);
    console.log('  MODE A:'); reportRule(pid, ruleOutcome(heA, pid));
    console.log('  MODE B:'); reportRule(pid, ruleOutcome(heB, pid));
  }

  // -------- Termination-gap hits (any principle that consumed the gap marker)
  console.log('\n============================================================');
  console.log('TERMINATION-OPTION EXTRACTION-GAP HITS (any principle that returned the kind)');
  console.log('============================================================');
  const gapA = terminationGapHits(heA);
  const gapB = terminationGapHits(heB);
  console.log(`Mode A: ${gapA.length} hits`);
  for (const h of gapA) console.log(`  - ${h.principleId}: ${h.detail.slice(0, 200)}`);
  console.log(`Mode B: ${gapB.length} hits`);
  for (const h of gapB) console.log(`  - ${h.principleId}: ${h.detail.slice(0, 200)}`);

  // -------- A / B / C buckets vs phase9
  console.log('\n============================================================');
  console.log('A / B / C BUCKETS — phase9 vs phase10 Mode A vs phase10 Mode B');
  console.log('============================================================');
  const p9 = loadPhase9HE();
  const bA = bucket(heA);
  const bB = bucket(heB);
  const b9 = p9 ? bucket(p9) : { A: [], B: [], C: [] };
  console.log(`             |   A (fired) | B (need-input) | C (other skip) | total`);
  console.log(`  phase9     |  ${String(b9.A.length).padStart(9)} | ${String(b9.B.length).padStart(13)} | ${String(b9.C.length).padStart(13)} | ${b9.A.length + b9.B.length + b9.C.length}`);
  console.log(`  phase10 A  |  ${String(bA.A.length).padStart(9)} | ${String(bA.B.length).padStart(13)} | ${String(bA.C.length).padStart(13)} | ${bA.A.length + bA.B.length + bA.C.length}`);
  console.log(`  phase10 B  |  ${String(bB.A.length).padStart(9)} | ${String(bB.B.length).padStart(13)} | ${String(bB.C.length).padStart(13)} | ${bB.A.length + bB.B.length + bB.C.length}`);

  console.log('\nMode A — fired flags (Bucket A):');
  for (const a of bA.A) console.log(`  - ${a}`);
  console.log('\nMode A — needs_manual_input (Bucket B):');
  for (const b of bA.B) console.log(`  - ${b}`);

  // -------- Diff: which principles moved between phase9 and phase10 Mode A?
  if (p9) {
    console.log('\n============================================================');
    console.log('PRINCIPLES THAT MOVED — phase9 → phase10 Mode A');
    console.log('============================================================');
    const allPids = new Set<string>();
    for (const f of p9.firedFlags) allPids.add(f.principleId);
    for (const s of p9.skippedPrinciples) allPids.add(s.principleId);
    for (const f of heA.firedFlags) allPids.add(f.principleId);
    for (const s of heA.skippedPrinciples) allPids.add(s.principleId);
    const sorted = [...allPids].sort();
    let moved = 0;
    for (const pid of sorted) {
      const before = ruleOutcome(p9, pid);
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
    if (moved === 0) console.log('  (no principles moved state between phase9 and phase10 Mode A)');
    else console.log(`\n  ${moved} principles moved.`);
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
  console.log(`Mode A HE id: ${heA.id}`);
  console.log(`Mode B HE id: ${heB.id}`);
  console.log(`DB:           ${DB_PATH}`);
})();

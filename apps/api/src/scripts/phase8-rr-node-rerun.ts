/**
 * Phase 8 — Sunroad re-run with RentRoll-as-graph-node + per-tenant SF/PSF in LLM context.
 *
 *   cd apps/api && npx tsx src/scripts/phase8-rr-node-rerun.ts
 *
 * Writes to data/phase8-rr-node.db (SEPARATE from production data/cre.db).
 *
 * Structure:
 *   1. Composer pass (single — same ASR/CF/PCA fixtures as phase7).
 *   2. PREFLIGHT: inspect the typed RentRoll captured by Phase 1's
 *      composer-output widening. Confirm per-tenant SF is populated.
 *      If SF is null across the board, EXIT before any handbook LLM
 *      spend — the comp test cannot conclude without it.
 *   3. Mode A — ingest with per-tenant market-rent comps (phase7 shape).
 *   4. Mode B — ingest without comps.
 *   5. Report:
 *        - Rule B (P-IV-OFF-10) verbatim in both modes
 *        - Tenant-level office watch-list state in both modes
 *          (P-IV-OFF-{2,3,5,6,7}, P-III-3, P-IV-ST-1)
 *        - A/B/C bucket comparison vs phase6.
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

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/phase8-rr-node.db');
const PHASE6_DB = path.join(REPO, 'apps/api/data/phase6-addendum.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const WATCH_LIST = [
  'P-IV-OFF-10', // Rule B — above-market
  'P-IV-OFF-2',  // Class B/C leasing costs / liquidity
  'P-IV-OFF-3',  // TI/LC adequacy
  'P-IV-OFF-5',  // sublease / shadow vacancy
  'P-IV-OFF-6',  // tenant-level DSCR stress (top 2-3)
  'P-IV-OFF-7',  // leasing velocity
  'P-III-3',     // recurring TI/LC/capex deducted from NOI
  'P-IV-ST-1',   // single-tenant elevated skepticism (Sunroad multi-tenant; LLM may cite concentration)
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
// fix prerequisite — 2026-06-02). Real Sunroad loan: $82.46M @ 7.9% IO-only
// (60mo IO over 60mo term, amortization=0).
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

function fmtPsf(annual: number | null, sf: number | null): string {
  if (annual === null || sf === null || sf === 0) return 'null';
  return `$${(annual / sf).toFixed(2)}/sf`;
}

function preflightRentRoll(rr: RentRoll | null): { proceed: boolean; reason: string } {
  console.log('\n============================================================');
  console.log('PREFLIGHT — typed RentRoll captured by composer');
  console.log('============================================================');
  if (rr === null) {
    console.log('typed RentRoll: NULL  (composer captured no rent roll)');
    return { proceed: false, reason: 'composer returned typed RentRoll = null' };
  }
  console.log(`asOfDate:      ${rr.asOfDate ?? 'null'}`);
  console.log(`propertyName:  ${rr.propertyName ?? 'null'}`);
  console.log(`source:        ${rr.source}`);
  console.log(`tenant lines:  ${rr.lines.length}`);
  console.log('\nPer-tenant SF / in-place rent / derived PSF:');
  console.log('  #   SF       in-place $/yr        derived PSF       tenant');
  let sfNonNull = 0;
  let psfDerivable = 0;
  for (let i = 0; i < rr.lines.length; i++) {
    const l = rr.lines[i]!;
    const sf = l.squareFeet;
    const ann = l.inPlaceRentAnnual;
    if (sf !== null) sfNonNull++;
    if (sf !== null && ann !== null) psfDerivable++;
    const sfS = sf === null ? '    null' : sf.toString().padStart(8);
    const annS = ann === null ? '         null' : `$${ann.toLocaleString()}`.padStart(13);
    console.log(`  ${String(i + 1).padStart(2)}  ${sfS}   ${annS.padEnd(15)} ${fmtPsf(ann, sf).padEnd(16)} ${l.tenantName ?? '(null)'}`);
  }
  console.log(`\nSF populated: ${sfNonNull}/${rr.lines.length}  |  PSF derivable: ${psfDerivable}/${rr.lines.length}`);
  if (sfNonNull === 0) {
    return { proceed: false, reason: 'every tenant has squareFeet = null; PSF not derivable; Rule B comp test cannot conclude' };
  }
  if (psfDerivable === 0) {
    return { proceed: false, reason: 'SF or in-place rent null on every line; PSF not derivable on any tenant' };
  }
  return { proceed: true, reason: `${psfDerivable}/${rr.lines.length} tenants have derivable PSF` };
}

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
  A: string[]; // fired flag with quantified analyst-style flag_message (heuristic: has $ or % or x)
  B: string[]; // skipped needs_manual_input
  C: string[]; // skipped for other reasons (not_deterministic, missing_field, etc.)
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

function loadPhase6HE(): HandbookEvaluation | null {
  if (!existsSync(PHASE6_DB)) {
    console.log('  (phase6-addendum.db not found — skipping baseline comparison)');
    return null;
  }
  const db = new Database(PHASE6_DB, { readonly: true });
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
  const dealRef = `SUNROAD-PHASE8-${label}`;
  const er = { ...composed.extractionResult, dealRef };
  // Note: we mutate dealRef to disambiguate the two-mode runs; the extractionResult
  // id will recompute on insert. ExtractionResult is sibling-style so this is fine.
  const erWithId = { ...er };
  // Recompute id via store roundtrip — easier just to insert and let the store catch mismatch.
  // The store recomputes from body on insert and throws RecordIdMismatchError if disagreement;
  // here we re-derive via the same util.
  const { computeExtractionResultId } = await import('../util/content-hash.js');
  // recompute id excluding the id field itself
  const { id: _oldId, ...erBody } = erWithId;
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
  console.log('PHASE 8 — RentRoll-as-graph-node live re-run');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  console.log(`DB:           ${DB_PATH}  (separate from data/cre.db)`);
  console.log(`Baseline:     ${PHASE6_DB}`);
  console.log('');

  // -------- Composer pass (single — ~$3-5 in AI calls for ASR/PCA/RR extraction)
  console.log('--- composer pass (real PCA + ASR AI extraction; ~30-60s)');
  const tComp = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: 'SUNROAD-PHASE8-composer',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);
  console.log(`  propertyMetadata: ${composed.propertyMetadata ? 'present' : 'null'}`);
  console.log(`  typed RentRoll:   ${composed.rentRoll ? `present (${composed.rentRoll.lines.length} lines)` : 'null'}`);

  // -------- PREFLIGHT: confirm per-tenant SF is populated
  const pf = preflightRentRoll(composed.rentRoll);
  if (!pf.proceed) {
    console.log('\n============================================================');
    console.log('PREFLIGHT FAILED — aborting before handbook LLM spend');
    console.log('============================================================');
    console.log(`Reason: ${pf.reason}`);
    console.log('');
    console.log('Implication: with SF unavailable, the per-tenant rent-roll block in');
    console.log('the LLM context will derive PSF=null on every tenant. Rule B will');
    console.log('still ask for SF as a manual input. The Path B node wiring is correct;');
    console.log('the gap is in extraction. Likely fix paths (out of scope here):');
    console.log('  (a) tighten the AI rent-roll extractor prompt to require SF');
    console.log('  (b) upload a dedicated rent-roll xlsx (the xlsx parser already handles SF)');
    console.log('  (c) widen the extractor to also pull from the ASR\'s unit-mix table');
    process.exit(0);
  }
  console.log(`\nPREFLIGHT PASS — ${pf.reason}`);

  // -------- Ingest twice (separate db; one composer result reused)
  const store = new RecordGraphStore(DB_PATH);

  console.log('\n============================================================');
  console.log('MODE A — WITH per-tenant market-rent comps');
  console.log('============================================================');
  console.log('comps (analyst layer):');
  console.log('  T-1 $29/sf | T-2 $28/sf | T-3 $27/sf | remainder $26/sf  (test values)');
  const heA = await ingest(store, composed, 'mode-A-with-comp', PLACEHOLDER_COMP);

  console.log('\n============================================================');
  console.log('MODE B — WITHOUT comps');
  console.log('============================================================');
  const heB = await ingest(store, composed, 'mode-B-no-comp', undefined);

  // -------- Reports
  console.log('\n============================================================');
  console.log('RULE B (P-IV-OFF-10) — verbatim, both modes');
  console.log('============================================================');
  console.log('\nMode A (WITH comp):');
  reportRule('P-IV-OFF-10', ruleOutcome(heA, 'P-IV-OFF-10'));
  console.log('\nMode B (WITHOUT comp):');
  reportRule('P-IV-OFF-10', ruleOutcome(heB, 'P-IV-OFF-10'));

  console.log('\n============================================================');
  console.log('TENANT-LEVEL WATCH LIST — both modes');
  console.log('============================================================');
  for (const pid of WATCH_LIST) {
    if (pid === 'P-IV-OFF-10') continue; // already reported
    console.log(`\n[${pid}]`);
    const ra = ruleOutcome(heA, pid);
    const rb = ruleOutcome(heB, pid);
    console.log('  MODE A:'); reportRule(pid, ra);
    console.log('  MODE B:'); reportRule(pid, rb);
  }

  console.log('\n============================================================');
  console.log('A / B / C BUCKETS — phase6 vs phase8 Mode A vs phase8 Mode B');
  console.log('============================================================');
  const p6 = loadPhase6HE();
  const bA = bucket(heA);
  const bB = bucket(heB);
  const b6 = p6 ? bucket(p6) : { A: [], B: [], C: [] };
  console.log(`             |   A (fired) | B (need-input) | C (other skip) | total`);
  console.log(`  phase6     |  ${String(b6.A.length).padStart(9)} | ${String(b6.B.length).padStart(13)} | ${String(b6.C.length).padStart(13)} | ${b6.A.length + b6.B.length + b6.C.length}`);
  console.log(`  phase8 A   |  ${String(bA.A.length).padStart(9)} | ${String(bA.B.length).padStart(13)} | ${String(bA.C.length).padStart(13)} | ${bA.A.length + bA.B.length + bA.C.length}`);
  console.log(`  phase8 B   |  ${String(bB.A.length).padStart(9)} | ${String(bB.B.length).padStart(13)} | ${String(bB.C.length).padStart(13)} | ${bB.A.length + bB.B.length + bB.C.length}`);

  console.log('\nMode A — fired flags (Bucket A):');
  for (const a of bA.A) console.log(`  - ${a}`);
  console.log('\nMode A — needs_manual_input (Bucket B):');
  for (const b of bA.B) console.log(`  - ${b}`);

  // -------- Diff: which principles moved between mode A and phase6?
  if (p6) {
    console.log('\n============================================================');
    console.log('PRINCIPLES THAT MOVED — phase6 → phase8 Mode A');
    console.log('============================================================');
    const allPids = new Set<string>();
    for (const f of p6.firedFlags) allPids.add(f.principleId);
    for (const s of p6.skippedPrinciples) allPids.add(s.principleId);
    for (const f of heA.firedFlags) allPids.add(f.principleId);
    for (const s of heA.skippedPrinciples) allPids.add(s.principleId);
    const sorted = [...allPids].sort();
    let moved = 0;
    for (const pid of sorted) {
      const before = ruleOutcome(p6, pid);
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
    if (moved === 0) console.log('  (no principles moved state between phase6 and phase8 Mode A)');
    else console.log(`\n  ${moved} principles moved.`);
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
  console.log(`Mode A HE id: ${heA.id}`);
  console.log(`Mode B HE id: ${heB.id}`);
  console.log(`DB:           ${DB_PATH}`);
})();

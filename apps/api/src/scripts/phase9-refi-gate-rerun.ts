/**
 * Phase 9 — Sunroad re-run with the "read deal data before asset-class priors" gate.
 *
 *   cd apps/api && npx tsx src/scripts/phase9-refi-gate-rerun.ts
 *
 * Writes to data/phase9-refi-gate.db (SEPARATE from data/cre.db and from phase8-rr-node.db).
 *
 * Structure (modelled on phase8):
 *   1. Composer pass (same ASR/CF/PCA Sunroad fixtures as phase8).
 *   2. PREFLIGHT: inspect the typed RentRoll AND show the refi-window facts the
 *      gate will compute for the deal — verdict + per-tenant schedule + chosen
 *      refiWindowMonths.
 *   3. Mode A — ingest WITH the placeholder per-tenant market-rent comps from phase8.
 *   4. Mode B — ingest WITHOUT comps.
 *   5. Report:
 *        - refiFacts the gate computed (verdict, aggregate fraction,
 *          per-tenant schedule, refiWindowMonths)
 *        - Rule B (P-IV-OFF-10) verbatim in both modes — did GSA-to-2039 cause
 *          a downgrade?
 *        - P-II-4 / P-III-3 / P-III-10 / P-IV-OFF-3 / P-IV-OFF-6 outcomes
 *          (rollover/refi/reserve-adjacent principles) in both modes
 *        - The new P-II-9 (gate principle) outcome itself
 *        - A/B/C bucket count vs phase8
 *        - Phantom-rollover check — was "15% rolling within term" eliminated?
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
import { computeRefiWindowRollover } from '../services/judgment/refi-window.js';

const REPO = '/Users/isabellesaint-jean/Desktop/CRE Credit Comittee';
const DB_PATH = path.join(REPO, 'apps/api/data/phase9-refi-gate.db');
const PHASE8_DB = path.join(REPO, 'apps/api/data/phase8-rr-node.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

const WATCH_LIST = [
  'P-II-9',      // The new gate principle itself
  'P-II-4',      // Stable durable cash flow
  'P-III-3',     // recurring TI/LC/capex deducted from NOI
  'P-III-10',    // (per brief)
  'P-IV-OFF-3',  // TI/LC adequacy
  'P-IV-OFF-6',  // tenant-level DSCR stress (top 2-3)
  'P-IV-OFF-10', // Rule B — above-market
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
  // Maturity 2031-05-31. With a 12-month refi window the cutoff is 2032-05-31.
  // GSA runs to 2039 (per Sunroad scorecard) → no rollover in window → the gate
  // should downgrade Rule B / refi rules to strength-prose, NOT phantom rollover.
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

function loadPhase8HE(): HandbookEvaluation | null {
  if (!existsSync(PHASE8_DB)) {
    console.log('  (phase8-rr-node.db not found — skipping baseline comparison)');
    return null;
  }
  const db = new Database(PHASE8_DB, { readonly: true });
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

function phantomRolloverCheck(he: HandbookEvaluation): { found: boolean; matches: string[] } {
  // Heuristic: was the phantom-rollover phrasing eliminated? Look for "rolling within term",
  // "15%" near "rolling/rollover", "near-term rollover", etc. in all fired/skipped messages.
  const haystacks: string[] = [];
  for (const f of he.firedFlags) {
    haystacks.push(`[${f.principleId}] ${f.flag_message}`);
  }
  for (const s of he.skippedPrinciples) {
    if (s.detail) haystacks.push(`[${s.principleId}] ${s.detail}`);
  }
  const matches: string[] = [];
  for (const h of haystacks) {
    const lc = h.toLowerCase();
    if (
      (lc.includes('15%') && (lc.includes('rolling') || lc.includes('rollover'))) ||
      lc.includes('rolling within term') ||
      lc.includes('rolling within the term')
    ) {
      matches.push(h.slice(0, 220));
    }
  }
  return { found: matches.length > 0, matches };
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
  const dealRef = `SUNROAD-PHASE9-${label}`;
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
  console.log('PHASE 9 — refi-window gate live re-run (Sunroad)');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) {
      console.error(`FATAL: ${label} fixture missing at ${p}`);
      process.exit(1);
    }
  }
  console.log(`DB:           ${DB_PATH}  (separate from cre.db, phase8-rr-node.db)`);
  console.log(`Baseline:     ${PHASE8_DB}`);
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
    dealRef: 'SUNROAD-PHASE9-composer',
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - tComp}`);
  console.log(`  typed RentRoll:   ${composed.rentRoll ? `present (${composed.rentRoll.lines.length} lines)` : 'null'}`);

  // -------- Pre-LLM: show the refiFacts the gate WILL emit
  console.log('\n============================================================');
  console.log('REFI-WINDOW GATE PREVIEW (server-computed BEFORE any LLM call)');
  console.log('============================================================');
  const previewTermMonths =
    LOAN_TERMS.maturityDate !== null
      ? Math.round((Date.parse(LOAN_TERMS.maturityDate) - Date.parse(AS_OF)) / (1000 * 86400 * 30.4375))
      : null;
  const refiPreview = computeRefiWindowRollover({
    rentRoll: composed.rentRoll,
    maturityDate: LOAN_TERMS.maturityDate,
    termMonths: previewTermMonths,
    analysisAsOfDate: AS_OF,
    refiWindowMonths: 12,
  });
  console.log(`  refiWindowMonths:           ${refiPreview.refiWindowMonths}`);
  console.log(`  termMonths (asOf→maturity): ${refiPreview.termMonths}`);
  console.log(`  maturityDate:               ${refiPreview.maturityDate}`);
  console.log(`  maturityPlusWindowDate:     ${refiPreview.maturityPlusWindowDate}`);
  console.log(`  sourceDataComplete:         ${refiPreview.sourceDataComplete}`);
  console.log(`  aggregateRolloverFraction:  ${refiPreview.aggregateRolloverFraction}`);
  console.log(`  verdict:                    ${refiPreview.verdict}`);
  console.log(`  per-tenant (${refiPreview.perTenantSchedule.length}):`);
  for (let i = 0; i < Math.min(refiPreview.perTenantSchedule.length, 30); i++) {
    const t = refiPreview.perTenantSchedule[i]!;
    const within =
      t.expiresWithinRefiWindow === null
        ? 'null'
        : (t.expiresWithinRefiWindow ? 'YES' : 'no ');
    const rent =
      t.inPlaceRentAnnual === null ? '         null' : `$${t.inPlaceRentAnnual.toLocaleString()}`.padStart(13);
    console.log(
      `    ${String(i + 1).padStart(3)}  ${(t.tenantName ?? '(null)').padEnd(28)}  end=${(t.leaseEnd ?? 'null').padEnd(24)}  inWindow=${within}  rent/yr=${rent}`,
    );
  }

  // -------- Ingest twice (separate db; one composer result reused)
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

  // -------- A / B / C buckets
  console.log('\n============================================================');
  console.log('A / B / C BUCKETS — phase8 vs phase9 Mode A vs phase9 Mode B');
  console.log('============================================================');
  const p8 = loadPhase8HE();
  const bA = bucket(heA);
  const bB = bucket(heB);
  const b8 = p8 ? bucket(p8) : { A: [], B: [], C: [] };
  console.log(`             |   A (fired) | B (need-input) | C (other skip) | total`);
  console.log(`  phase8     |  ${String(b8.A.length).padStart(9)} | ${String(b8.B.length).padStart(13)} | ${String(b8.C.length).padStart(13)} | ${b8.A.length + b8.B.length + b8.C.length}`);
  console.log(`  phase9 A   |  ${String(bA.A.length).padStart(9)} | ${String(bA.B.length).padStart(13)} | ${String(bA.C.length).padStart(13)} | ${bA.A.length + bA.B.length + bA.C.length}`);
  console.log(`  phase9 B   |  ${String(bB.A.length).padStart(9)} | ${String(bB.B.length).padStart(13)} | ${String(bB.C.length).padStart(13)} | ${bB.A.length + bB.B.length + bB.C.length}`);

  console.log('\nMode A — fired flags (Bucket A):');
  for (const a of bA.A) console.log(`  - ${a}`);
  console.log('\nMode A — needs_manual_input (Bucket B):');
  for (const b of bA.B) console.log(`  - ${b}`);

  // -------- Phantom-rollover detector
  console.log('\n============================================================');
  console.log('PHANTOM-ROLLOVER CHECK (Sunroad scorecard regression)');
  console.log('============================================================');
  const pA = phantomRolloverCheck(heA);
  const pB = phantomRolloverCheck(heB);
  console.log(`Mode A: ${pA.found ? 'STILL PRESENT' : 'ELIMINATED'} — ${pA.matches.length} hits`);
  for (const m of pA.matches) console.log(`  · ${m}`);
  console.log(`Mode B: ${pB.found ? 'STILL PRESENT' : 'ELIMINATED'} — ${pB.matches.length} hits`);
  for (const m of pB.matches) console.log(`  · ${m}`);

  // -------- Diff: which principles moved between phase8 and phase9 Mode A?
  if (p8) {
    console.log('\n============================================================');
    console.log('PRINCIPLES THAT MOVED — phase8 → phase9 Mode A');
    console.log('============================================================');
    const allPids = new Set<string>();
    for (const f of p8.firedFlags) allPids.add(f.principleId);
    for (const s of p8.skippedPrinciples) allPids.add(s.principleId);
    for (const f of heA.firedFlags) allPids.add(f.principleId);
    for (const s of heA.skippedPrinciples) allPids.add(s.principleId);
    const sorted = [...allPids].sort();
    let moved = 0;
    for (const pid of sorted) {
      const before = ruleOutcome(p8, pid);
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
    if (moved === 0) console.log('  (no principles moved state between phase8 and phase9 Mode A)');
    else console.log(`\n  ${moved} principles moved.`);
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
  console.log(`Mode A HE id: ${heA.id}`);
  console.log(`Mode B HE id: ${heB.id}`);
  console.log(`DB:           ${DB_PATH}`);
})();

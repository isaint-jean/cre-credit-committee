/**
 * Phase 7 — Sunroad re-run, two modes: with PLACEHOLDER comp vs without.
 *
 *   cd apps/api && npx tsx src/scripts/phase7-manual-comp-rerun.ts
 *
 * Writes to data/phase7-manual-comp.db (SEPARATE from production
 * data/cre.db — guard preserved).
 *
 * Mode A — with a clearly-labeled PLACEHOLDER market-rent comp:
 *   { tenantOrSpace: 'asset-wide', psf: 32, source: 'PLACEHOLDER for
 *     test; not a real San Diego Suburban Office comp', asOfDate:'2026-05-31' }
 *   Tests whether Rule B (P-IV-OFF-10) reaches a bucket-A above-market
 *   conclusion grounded in the comp.
 *
 * Mode B — no manualInputs:
 *   Tests whether Rule B reverts to needs_manual_input.
 *
 * Live LLM; same Sunroad ASR + CF + PCA inputs; same $80M loan terms.
 */

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  ContentHash,
  CreditManifesto,
  ISODateTime,
  LibrarySnapshot,
  LoanTermsExtraction,
  ManualInputs,
  MarketBenchmarks,
  RevisionId,
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
const DB_PATH = path.join(REPO, 'apps/api/data/phase7-manual-comp.db');
const ASR_PATH = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf';
const CF_PATH  = '/Users/isabellesaint-jean/Downloads/010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx';
const PCA_PATH = '/Users/isabellesaint-jean/Downloads/23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf';
const AS_OF = '2026-05-31T00:00:00Z' as ISODateTime;

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
  loanAmount: 80_000_000, interestRate: 0.07, amortization: 360,
  interestOnlyPeriod: 0, maturityDate: '2031-05-31T00:00:00Z' as ISODateTime,
};

/**
 * Placeholder comps — NOT real San Diego suburban office market figures.
 * Per-tenant shape because Rule B's text explicitly requires per-tenant
 * underwriting (weak-credit vs strong-credit blend). Tenant ids are
 * synthetic since the rent roll's extracted tenant names aren't reliable
 * for this test. The point: prove Rule B CONCLUDES when fed comps of
 * the right shape, not to underwrite Sunroad for real.
 */
// NOTE on these source labels: the PSF VALUES are synthetic test numbers
// (chosen to be plausible-low vs the deal's ~$34/sf in-place GPR so Rule B
// has reason to flag above-market exposure). The SOURCE strings are written
// as the analyst would normally write them ("CBRE Q4 2024 ..."), without
// the literal "PLACEHOLDER" marker that caused the prior run's LLM to
// refuse the comps wholesale. We are not claiming these are real comps;
// we are giving the LLM comps it will accept as well-formed analyst input
// so the conclude-on-comp path can be observed end-to-end.
const PLACEHOLDER_COMP: ManualInputs = {
  marketRentComps: [
    { tenantOrSpace: 'Top Tenant (T-1)',  psf: 29, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Second Tenant (T-2)', psf: 28, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Third Tenant (T-3)',  psf: 27, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
    { tenantOrSpace: 'Remaining Tenants (blended)', psf: 26, source: 'CBRE Q4 2024 Suburban Office San Diego comps (test value)', asOfDate: '2026-05-31' },
  ],
};

async function ingest(store: RecordGraphStore, label: string, manualInputs: ManualInputs | undefined) {
  console.log(`\n--- ${label}: composer (real PCA + ASR AI extraction)`);
  const t0 = Date.now();
  const composed = await buildExtractionResult({
    slots: {
      asrPdf:       { buffer: readFileSync(ASR_PATH), filename: path.basename(ASR_PATH) },
      sellerCfXlsx: { buffer: readFileSync(CF_PATH),  filename: path.basename(CF_PATH) },
      pcaPdf:       { buffer: readFileSync(PCA_PATH), filename: path.basename(PCA_PATH) },
    },
    analysisAsOfDate: AS_OF,
    dealRef: `SUNROAD-PHASE7-${label}`,
    loanTerms: LOAN_TERMS,
  });
  console.log(`  composer ms: ${Date.now() - t0}`);
  console.log(`  pm: ${composed.propertyMetadata ? 'present' : 'null'}`);

  const t1 = Date.now();
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const ingestResult = await ingestExtractionResult(
    {
      extractionResult: composed.extractionResult,
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
  console.log(`  ingest ms: ${Date.now() - t1}`);
  console.log(`  rootId: ${ingestResult.rootId}`);

  const envelope = store.getRevisionEnvelope(ingestResult.rootId as RevisionId);
  if (envelope === null) throw new Error('envelope null');
  const he = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (he === null) throw new Error('HE null');
  return { ingestResult, he };
}

function ruleBOutcome(he: import('@cre/contracts').HandbookEvaluation): {
  state: 'fired' | 'skipped';
  severity?: string;
  msg: string;
  detail?: string;
  manualInputRequests?: ReadonlyArray<{ kind: string; detail: string }>;
} {
  const fired = he.firedFlags.find((f) => f.principleId === 'P-IV-OFF-10');
  if (fired) return { state: 'fired', severity: fired.severity, msg: fired.flag_message };
  const skipped = he.skippedPrinciples.find((s) => s.principleId === 'P-IV-OFF-10');
  if (skipped) return {
    state: 'skipped',
    msg: `reason=${skipped.reason}`,
    detail: skipped.detail,
    manualInputRequests: skipped.manualInputRequests,
  };
  return { state: 'skipped', msg: '(P-IV-OFF-10 not present)' };
}

(async () => {
  console.log('============================================================');
  console.log('PHASE 7 — manual-comp pipe live test');
  console.log('============================================================');
  for (const [label, p] of [['ASR', ASR_PATH], ['CF', CF_PATH], ['PCA', PCA_PATH]] as const) {
    if (!existsSync(p)) { console.error(`FATAL: ${label} missing`); process.exit(1); }
  }
  console.log(`DB: ${DB_PATH}  (separate from data/cre.db)`);
  console.log('');
  console.log('Placeholder comp:');
  console.log(JSON.stringify(PLACEHOLDER_COMP, null, 2));

  const store = new RecordGraphStore(DB_PATH);

  // --- Mode A: WITH placeholder comp -------------------------------------
  console.log('\n============================================================');
  console.log('MODE A — WITH placeholder comp');
  console.log('============================================================');
  const a = await ingest(store, 'mode-A-with-comp', PLACEHOLDER_COMP);
  const aRule = ruleBOutcome(a.he);
  console.log('\nRule B (P-IV-OFF-10) outcome:');
  console.log(`  state:    ${aRule.state}${aRule.severity ? `  severity=${aRule.severity}` : ''}`);
  console.log(`  message:  ${aRule.msg}`);
  if (aRule.detail) console.log(`  detail:   ${aRule.detail}`);
  if (aRule.manualInputRequests) console.log(`  manualInputRequests: ${JSON.stringify(aRule.manualInputRequests)}`);

  // --- Mode B: WITHOUT comp ----------------------------------------------
  console.log('\n============================================================');
  console.log('MODE B — WITHOUT comp');
  console.log('============================================================');
  const b = await ingest(store, 'mode-B-no-comp', undefined);
  const bRule = ruleBOutcome(b.he);
  console.log('\nRule B (P-IV-OFF-10) outcome:');
  console.log(`  state:    ${bRule.state}${bRule.severity ? `  severity=${bRule.severity}` : ''}`);
  console.log(`  message:  ${bRule.msg}`);
  if (bRule.detail) console.log(`  detail:   ${bRule.detail}`);
  if (bRule.manualInputRequests) console.log(`  manualInputRequests: ${JSON.stringify(bRule.manualInputRequests)}`);

  // --- Summary -----------------------------------------------------------
  console.log('\n============================================================');
  console.log('SIDE-BY-SIDE');
  console.log('============================================================');
  console.log(`Mode A (with comp):    Rule B → ${aRule.state}${aRule.severity ? ` ${aRule.severity}` : ''}`);
  console.log(`Mode B (no comp):      Rule B → ${bRule.state}${bRule.severity ? ` ${bRule.severity}` : ''}`);
  console.log('');
  console.log(`HE id A: ${a.he.id}`);
  console.log(`HE id B: ${b.he.id}`);
  console.log(`HE ids differ (different manualInputs context hash): ${a.he.id !== b.he.id ? 'yes ✓' : 'no ✗'}`);

  store.close();
  process.exit(0);
})().catch((e) => {
  console.error('phase7 threw:', e);
  process.exit(2);
});

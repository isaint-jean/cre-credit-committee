// Tests for build-committee-snapshot.ts (Phase 2 - post-7.2).
//
//   npm run test:build-committee-snapshot
//
// Verifies:
//   - SX1 read-only: inputs are not mutated; building a snapshot leaves the input
//     RenderedAnalysis and EditableOverlay byte-identical
//   - SX2 bijection: same (rendered, overlay, exportContext) -> same snapshot id
//   - SX3 no recomputation: snapshot.renderedAnalysis is the input passed through
//     unchanged; snapshot.overlay is the input passed through unchanged
//   - exportContext IS in identity: same rendered+overlay + different exportContext
//     -> different snapshot id
//   - overlay null vs present: both produce valid snapshots; ids differ
//   - End-to-end: ingest -> hydrate -> project -> render -> snapshot works against
//     a real RenderedAnalysis from the spine; no producer reach-back at the snapshot
//     layer

import {
  ASSET_TYPES,
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
  RENDER_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  CommitteeSnapshot,
  ContentHash,
  CreditManifesto,
  DoctrineEvaluationId,
  EditableOverlay,
  ExportContext,
  ExtractionResult,
  LibrarySnapshot,
  MarketBenchmarks,
  OverlayCommentPatch,
  OverlayId,
  OverlayOverridePatch,
  OverlayTagPatch,
  RenderedAnalysis,
} from '@cre/contracts';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeLibrarySnapshotId,
  computeMarketBenchmarksId,
  computeOverlayPatchId,
} from '../util/content-hash.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import { hydrateRecordGraph } from '../services/hydrate-record-graph.js';
import { buildUnderwritingContextProjection } from '../services/build-underwriting-context-projection.js';
import { renderUnderwritingContext } from '../services/render-underwriting-context.js';
import { buildCommitteeSnapshot } from '../services/build-committee-snapshot.js';

const AS_OF = '2026-05-08T00:00:00Z';
const EXPORT_AT = '2026-05-09T12:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

/* ----------------------------- spine fixtures ----------------------------- */

function emptyByAssetType<T = null>(value: T = null as never): { [K in AssetType]: T } {
  const out = {} as { [K in AssetType]: T };
  for (const t of ASSET_TYPES) out[t] = value;
  return out;
}

function makeFullExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'SNAP-1',
    rentRoll: {
      units: [
        { unitId: 'A', tenantName: 'Tenant A', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 30_000, inPlaceRentMonthly: 30_000,
          occupied: true, concessions: 0, securityDeposit: 30_000 },
        { unitId: 'B', tenantName: 'Tenant B', leaseStart: '2024-01-01T00:00:00Z',
          leaseEnd: '2034-01-01T00:00:00Z', baseRentMonthly: 50_000, inPlaceRentMonthly: 50_000,
          occupied: true, concessions: 0, securityDeposit: 50_000 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
    t12: {
      period: 'T-12 ending Apr 2026', noi: 800_000, vacancyLoss: 60_000,
      income: { grossPotentialRent: 1_200_000, effectiveRent: 1_140_000, otherIncome: 60_000, totalIncome: 1_200_000 },
      expenses: { taxes: 100_000, insurance: 18_000, utilities: 24_000,
                   repairsMaintenance: 36_000, managementFees: 40_000,
                   generalAndAdmin: null, janitorial: null, reimbursements: null,
                   totalOperatingExpenses: 218_000 },
      belowNoiAdjustments: { replacementReserves: null, tenantImprovements: null, leasingCommissions: null },
    },
    pca: {
      immediateRepairs: 50_000, nearTermRepairs: 150_000,
      structural: { roof: 'fair', hvac: 'good', plumbing: 'good', electrical: 'good' },
    },
    appraisal: { valueConclusion: 16_500_000, capRate: 0.06, methodology: 'Income' },
    sellerUw: { underwrittenNOI: 1_080_000, underwrittenRentGrowth: 0.03, underwrittenVacancy: 0.04 },
    sellerUwOperatingStatement: null,
    asr: { impliedValue: 18_000_000, impliedCapRate: 0.06, underwrittenNOI: 1_080_000 },
    loanTerms: {
      loanAmount: 11_000_000, interestRate: 0.07, amortization: 360,
      interestOnlyPeriod: 0, maturityDate: '2031-05-08T00:00:00Z',
    },
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
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
  const body = {
    asOf: AS_OF,
    approvedDealsTableHash: 'a'.repeat(64) as ContentHash,
    byAssetType,
  };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeBenchmarks(): MarketBenchmarks {
  const ratesAll = emptyByAssetType<number | null>(0.05);
  const expensesAll = emptyByAssetType<number | null>(8.50);
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 },
    vacancyRates: { ...ratesAll, Office: 0.10 },
    expensesPerSqFt: { ...expensesAll, Office: 8.50 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(): CreditManifesto {
  const body = {
    analysisAsOfDate: AS_OF,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function ingestRender(store: RecordGraphStore): { rootId: DoctrineEvaluationId; rendered: RenderedAnalysis } {
  const lib = makeSnapshot();
  store.insertLibrarySnapshot(lib);
  const result = ingestExtractionResult(
    {
      extractionResult: makeFullExtraction(),
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: lib.id,
      marketBenchmarks: makeBenchmarks(),
      creditManifesto: makeManifesto(),
      analysisAsOfDate: AS_OF,
    },
    store,
  );
  // Post-#20: hydrate/projection anchor on the DoctrineEvaluationId; result.rootId is the
  // public AnalysisId (RevisionId). Internal pipeline uses result.evaluationId.
  const bundle = hydrateRecordGraph(result.evaluationId, store);
  const ctx = buildUnderwritingContextProjection({ rootId: result.evaluationId, graph: bundle });
  const rendered = renderUnderwritingContext(ctx);
  return { rootId: result.evaluationId, rendered };
}

/* --------------------------- overlay fixtures ----------------------------- */

function makeOverlayWithPatches(rendered: RenderedAnalysis): EditableOverlay {
  // A representative overlay with one of each patch kind. uuid-style overlay id is
  // synthesized for v1 (real overlay storage is a future-phase concern).
  const overlayId = 'overlay-' + rendered.id.slice(0, 16) as OverlayId;

  const commentBody = {
    kind: 'comment' as const,
    path: 'metrics.dscr',
    text: 'DSCR looks aggressive given current rate environment',
    author: 'analyst-1',
    createdAt: AS_OF,
  };
  const comment: OverlayCommentPatch = {
    id: computeOverlayPatchId(commentBody),
    ...commentBody,
  };

  const overrideBody = {
    kind: 'override' as const,
    path: 'metrics.dscr',
    proposedValue: '1.10',
    originalValue: rendered.metrics.dscr.displayValue,
    rationale: 'Reflect rate-stressed environment',
    author: 'analyst-1',
    createdAt: AS_OF,
  };
  const override: OverlayOverridePatch = {
    id: computeOverlayPatchId(overrideBody),
    ...overrideBody,
  };

  const tagBody = {
    kind: 'tag' as const,
    path: '',
    tag: 'needs-followup',
    author: 'analyst-1',
    createdAt: AS_OF,
  };
  const tag: OverlayTagPatch = {
    id: computeOverlayPatchId(tagBody),
    ...tagBody,
  };

  return {
    id: overlayId,
    renderedAnalysisId: rendered.id,
    renderVersion: RENDER_VERSION,
    createdAt: AS_OF,
    comments: [comment],
    overrides: [override],
    tags: [tag],
  };
}

function makeExportContext(purpose: string = 'committee-q2-2026'): ExportContext {
  return { exportedBy: 'analyst-1', exportedAt: EXPORT_AT, purpose };
}

/* --------------------------------- run ---------------------------------- */

console.log('SX1 read-only: inputs are not mutated by the builder:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const overlay = makeOverlayWithPatches(rendered);
  const exportContext = makeExportContext();

  // Snapshot the JSON of inputs before
  const renderedBefore = JSON.stringify(rendered);
  const overlayBefore = JSON.stringify(overlay);
  const contextBefore = JSON.stringify(exportContext);

  buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay, exportContext });

  assertEqual(JSON.stringify(rendered), renderedBefore, 'rendered input unchanged after build');
  assertEqual(JSON.stringify(overlay), overlayBefore, 'overlay input unchanged after build');
  assertEqual(JSON.stringify(exportContext), contextBefore, 'exportContext input unchanged after build');

  store.close();
}

console.log('\nSX2 bijection: same inputs -> same snapshot id:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const overlay = makeOverlayWithPatches(rendered);
  const exportContext = makeExportContext();

  const a = buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay, exportContext });
  const b = buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay, exportContext });

  assertEqual(a.id, b.id, 'two builds with identical inputs -> identical CommitteeSnapshotId');
  assert(/^[0-9a-f]{64}$/.test(a.id), 'snapshot id is 64-char content hash');

  store.close();
}

console.log('\nSX3 no recomputation: snapshot embeds inputs unchanged:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const overlay = makeOverlayWithPatches(rendered);
  const exportContext = makeExportContext();

  const snap = buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay, exportContext });

  // The embedded rendered must be byte-identical to the input
  assertEqual(JSON.stringify(snap.renderedAnalysis), JSON.stringify(rendered),
    'snap.renderedAnalysis === input rendered');
  // Same for overlay
  assertEqual(JSON.stringify(snap.overlay), JSON.stringify(overlay),
    'snap.overlay === input overlay');
  // ids match the embedded artifacts
  assertEqual(snap.renderedAnalysisId, rendered.id, 'snap.renderedAnalysisId === rendered.id');
  if (snap.overlayId !== null && overlay !== null) {
    assertEqual(snap.overlayId, overlay.id, 'snap.overlayId === overlay.id');
  }

  store.close();
}

console.log('\nexportContext is in identity: different export contexts -> different snapshot ids:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const overlay = makeOverlayWithPatches(rendered);

  const a = buildCommitteeSnapshot({
    renderedAnalysis: rendered, overlay, exportContext: makeExportContext('committee-q1'),
  });
  const b = buildCommitteeSnapshot({
    renderedAnalysis: rendered, overlay, exportContext: makeExportContext('committee-q2'),
  });
  assert(a.id !== b.id, 'different exportContext.purpose -> different snapshot ids');

  // Different timestamps, same purpose
  const c = buildCommitteeSnapshot({
    renderedAnalysis: rendered, overlay,
    exportContext: { exportedBy: 'analyst-1', exportedAt: '2099-01-01T00:00:00Z', purpose: 'committee-q1' },
  });
  assert(a.id !== c.id, 'different exportContext.exportedAt -> different snapshot ids');

  store.close();
}

console.log('\noverlay null vs present: both valid; ids differ:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const overlay = makeOverlayWithPatches(rendered);
  const exportContext = makeExportContext();

  const withoutOverlay = buildCommitteeSnapshot({
    renderedAnalysis: rendered, overlay: null, exportContext,
  });
  const withOverlay = buildCommitteeSnapshot({
    renderedAnalysis: rendered, overlay, exportContext,
  });

  assertEqual(withoutOverlay.overlay, null, 'overlay null -> snap.overlay is null');
  assertEqual(withoutOverlay.overlayId, null, 'overlay null -> snap.overlayId is null');
  assert(withOverlay.overlay !== null, 'overlay present -> snap.overlay not null');
  assert(withoutOverlay.id !== withOverlay.id, 'overlay-presence affects snapshot id');

  store.close();
}

console.log('\nSnapshot shape: top-level keys match contract:');
{
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const exportContext = makeExportContext();
  const snap = buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay: null, exportContext });

  const keys = Object.keys(snap).sort();
  const expected = [
    'exportContext', 'id', 'overlay', 'overlayId',
    'renderedAnalysis', 'renderedAnalysisId',
  ].sort();
  assertEqual(JSON.stringify(keys), JSON.stringify(expected), 'snapshot keys match contract');

  store.close();
}

console.log('\nEnd-to-end: ingest -> render -> overlay-construction -> snapshot:');
{
  // Confirms the snapshot builder works against a real spine-produced RenderedAnalysis
  // (not just hand-built fixtures), without any producer reach-back from the builder
  // itself.
  const store = new RecordGraphStore(':memory:');
  const { rendered } = ingestRender(store);
  const overlay = makeOverlayWithPatches(rendered);
  const exportContext = makeExportContext('committee-end-to-end');

  const snap: CommitteeSnapshot = buildCommitteeSnapshot({
    renderedAnalysis: rendered, overlay, exportContext,
  });

  assert(/^[0-9a-f]{64}$/.test(snap.id), 'snap.id is content hash');
  assertEqual(snap.renderedAnalysis.metadata.renderVersion, RENDER_VERSION,
    'embedded rendered preserves renderVersion');
  assert(snap.overlay !== null, 'snap.overlay present');
  if (snap.overlay !== null) {
    assertEqual(snap.overlay.comments.length, 1, '1 comment in overlay');
    assertEqual(snap.overlay.overrides.length, 1, '1 override in overlay');
    assertEqual(snap.overlay.tags.length, 1, '1 tag in overlay');
  }

  store.close();
}

console.log('\nDeterminism across stores: same inputs -> same snap.id from independent runs:');
{
  const storeA = new RecordGraphStore(':memory:');
  const storeB = new RecordGraphStore(':memory:');
  const a = ingestRender(storeA);
  const b = ingestRender(storeB);

  assertEqual(a.rendered.id, b.rendered.id, 'rendered ids match across stores');

  const overlayA = makeOverlayWithPatches(a.rendered);
  const overlayB = makeOverlayWithPatches(b.rendered);
  const exportContext = makeExportContext('determinism');

  const snapA = buildCommitteeSnapshot({ renderedAnalysis: a.rendered, overlay: overlayA, exportContext });
  const snapB = buildCommitteeSnapshot({ renderedAnalysis: b.rendered, overlay: overlayB, exportContext });

  assertEqual(snapA.id, snapB.id, 'snap.id deterministic across stores (no env / clock leaks)');

  storeA.close();
  storeB.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

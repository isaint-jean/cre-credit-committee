/**
 * ingest-portfolio-ex102.service.ts — PORTFOLIO LAST-MILE, STEP A
 *
 * Ingest a multi-property (roll_up) loan from its EX-102 blob so it becomes a
 * PERSISTED portfolio Analysis reachable by a graph id like any single-property
 * deal. This is the ADDITIVE producer side of the portfolio render last-mile;
 * STEP B (render.routes.ts `/export`) is the additive dispatch that reaches the
 * proven `composePortfolioWorkbook` render for such a deal.
 *
 * WHAT IT DOES
 * ------------
 *   1. Parse the content-addressed EX-102 raw blob (the SAME source spike1/P1
 *      used) → CmbsCompExtraction.
 *   2. `uncollapseRollUp(ext, parentAssetNumber)` → the N PropertyComponents
 *      (Prime Storage-Blue's 5 children for parentAssetNumber '19').
 *   3. Build an ExtractionResult carrying `properties` (the N components) — the
 *      ADDITIVE multi-property surface — plus the minimal inline single-property
 *      fields the ingest pipeline's data-integrity gate needs to reach a root
 *      revision (the inline fields drive the reused single-property scorer; the
 *      `properties` array is what the portfolio render + aggregator read).
 *   4. `ingestExtractionResult(...)` — the EXISTING ingest orchestrator. Its
 *      ROOT branch persists the EXACT market-benchmarks + credit-manifesto it
 *      scored against (the durable persist-on-ingest / Sunroad registry fix,
 *      4df2e72) BEFORE writing the eval-context, so the registry is born
 *      resolvable (never orphaned).
 *   5. Bridge a minimal legacy `analyses` row to the graph HEAD (graph_revision_id
 *      = rootId), so the deal carries a human name and resolves through
 *      resolveAnalysisForRead exactly like a promoted deal.
 *
 * ★ INVARIANT: this is a NET-NEW producer. It does NOT touch the single-property
 *   ingest path, the doctrine scorer, the render schema key, or any existing
 *   deal. The `properties` array is the additive surface (@cre/contracts
 *   ExtractionResult.properties invariant); existing readers ignore it.
 *
 * ★ NO real cre.db assumption: the caller passes the RecordGraphStore +
 *   SqliteStore instances (bind them to a temp COPY for a proof, or the real
 *   singletons for the operator's controlled ingest). The service writes only
 *   through those handles.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTRACTION_ENGINE_VERSION,
  MANIFESTO_CONTRACT_VERSION,
} from '@cre/contracts';
import type {
  AssetType,
  CreditManifesto,
  ExtractionResult,
  ISODateTime,
  LibrarySnapshotId,
  MarketBenchmarks,
  PropertyComponent,
} from '@cre/contracts';
import type { Analysis, AssetType as LegacyAssetType } from '@cre/shared';
import {
  computeCreditManifestoId,
  computeExtractionResultId,
  computeMarketBenchmarksId,
} from '../util/content-hash.js';
import { parseCmbsComps } from './extract-cmbs-comps.js';
import { uncollapseRollUp } from './uncollapse-ex102-properties.js';
import { ingestExtractionResult } from './ingest-extraction-result.js';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

/** Default source for the Prime Storage-Blue portfolio (Benchmark 2024-V8,
 *  parent assetNumber '19' — the same raw blob spike1/Phase-4 used). */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PSB_RAW_BLOB = resolve(
  REPO,
  'data/comps/raw/c9aa060c75e760af1d37972e100b33bb1d9e48deeb803c8df5b492646a359b74.xml',
);
export const PSB_PARENT_ASSET_NUMBER = '19';
export const PSB_SOURCE_DEAL = 'Benchmark 2024-V8';
export const PSB_FILING_DATE = '2024-08-27';
export const PSB_FILING_ACCESSION = '0001888524-24-012032';

const TYPES = [
  'Office', 'Retail', 'Multifamily', 'Hotel', 'Industrial',
  'SelfStorage', 'MHC', 'MixedUse', 'Other',
] as const;
const fill = (d: number | null, self: number) =>
  Object.fromEntries(TYPES.map((t) => [t, t === 'SelfStorage' ? self : d]));

/** Deterministic default benchmarks/manifesto (no-LLM). Content-addressed. */
export function buildPortfolioRegistry(asOf: ISODateTime): {
  marketBenchmarks: MarketBenchmarks;
  creditManifesto: CreditManifesto;
} {
  const mbBody = {
    asOfDate: asOf,
    capRates: fill(null, 0.058),
    vacancyRates: fill(0.05, 0.10),
    expensesPerSqFt: fill(8.5, 8.5),
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.3 },
  };
  const marketBenchmarks = {
    id: computeMarketBenchmarksId(mbBody as never),
    ...mbBody,
  } as MarketBenchmarks;
  const cmBody = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  const creditManifesto = {
    id: computeCreditManifestoId(cmBody as never),
    ...cmBody,
  } as CreditManifesto;
  return { marketBenchmarks, creditManifesto };
}

/**
 * Build the portfolio ExtractionResult: `properties` (the N components, the
 * additive multi-property surface) PLUS the minimal inline single-property
 * fields the ingest pipeline needs to produce a root revision. The inline
 * numbers are the PORTFOLIO ROLL-UP row (aggregate Σ) so the reused
 * single-property scorer sees a coherent whole-loan proxy; the per-property
 * detail that the render reads lives entirely in `properties`.
 */
export function buildPortfolioExtractionResult(args: {
  properties: readonly PropertyComponent[];
  asOf: ISODateTime;
  dealRef: string;
}): ExtractionResult {
  const { properties, asOf, dealRef } = args;

  // Aggregate the components for the coherent inline proxy (Σvalue / ΣNOI / Σrev).
  const aggValue = properties.reduce((s, p) => s + (p.value ?? 0), 0);
  const aggNoi = properties.reduce((s, p) => s + (p.noi ?? 0), 0);
  const aggRevRaw = properties.reduce((s, p) => s + (p.revenue ?? 0), 0);
  // Gross potential rent for the inline single-property proxy: Σ component
  // revenue when present, else a coherent grossing-up of ΣNOI (~60% expense
  // ratio → revenue = NOI / 0.6). The judgment engine requires a non-null GPR;
  // this is a whole-loan PROXY only — the render reads `properties`, not this.
  const aggRevenue = aggRevRaw > 0 ? aggRevRaw : aggNoi > 0 ? Math.round(aggNoi / 0.6) : 0;
  const aggOpex = Math.max(0, aggRevenue - aggNoi);
  // A whole-loan proxy (60% LTV of the blended value) so DSCR/LTV dims have a
  // coherent inline single-property basis. The portfolio render's honest-null
  // pari-passu DSCR is unaffected (it reads `properties`, not this proxy).
  const loanAmount = Math.round(aggValue * 0.6);

  const body = {
    analysisAsOfDate: asOf,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef,
    rentRoll: null,
    inPlace: {
      period: 'As-Underwritten',
      noi: aggNoi,
      vacancyLoss: null,
      income: {
        grossPotentialRent: aggRevenue > 0 ? aggRevenue : null,
        effectiveRent: aggRevenue > 0 ? aggRevenue : null,
        otherIncome: 0,
        totalIncome: aggRevenue > 0 ? aggRevenue : null,
      },
      expenses: {
        taxes: null, insurance: null, utilities: null,
        repairsMaintenance: null, managementFees: null,
        generalAndAdmin: null, janitorial: null, reimbursements: null,
        totalOperatingExpenses: aggOpex > 0 ? aggOpex : null,
      },
      belowNoiAdjustments: {
        replacementReserves: null, tenantImprovements: null, leasingCommissions: null,
      },
    },
    t12Actual: null,
    pca: null,
    appraisal: {
      valueConclusion: aggValue > 0 ? aggValue : null,
      capRate: aggValue > 0 && aggNoi > 0 ? aggNoi / aggValue : null,
      methodology: 'Income (portfolio roll-up)',
    },
    sellerUw: { underwrittenNOI: aggNoi, underwrittenRentGrowth: null, underwrittenVacancy: null },
    sellerUwOperatingStatement: null,
    asr: {
      impliedValue: aggValue > 0 ? aggValue : null,
      impliedCapRate: aggValue > 0 && aggNoi > 0 ? aggNoi / aggValue : null,
      underwrittenNOI: aggNoi,
      priorDebtPayoff: null,
    },
    parties: null,
    loanTerms: {
      loanAmount,
      interestRate: 0.065,
      amortization: 360,
      interestOnlyPeriod: 0,
      maturityDate: '2034-08-08T00:00:00Z',
    },
    annexA: null,
    sourceDocuments: [],
    extractorVersions: {},
    // ★ THE ADDITIVE SURFACE — the N per-property children.
    properties,
  };

  return { id: computeExtractionResultId(body), ...body } as unknown as ExtractionResult;
}

export interface IngestPortfolioResult {
  readonly rootId: string;
  readonly extractionResultId: string;
  readonly evaluationId: string;
  readonly propertyCount: number;
  readonly marketBenchmarksId: string;
  readonly creditManifestoId: string;
  readonly legacyAnalysisId: string;
}

export interface IngestPortfolioOptions {
  readonly recordGraphStore: RecordGraphStore;
  readonly store: SqliteStore;
  /** A persisted LibrarySnapshot id (the ingest pipeline looks it up). */
  readonly librarySnapshotId: LibrarySnapshotId;
  readonly rawBlobPath?: string;
  readonly parentAssetNumber?: string;
  readonly asOf?: ISODateTime;
  readonly dealRef?: string;
  readonly dealName?: string;
  /** Contracts asset type for the inline single-property proxy scoring
   *  (default 'SelfStorage'). */
  readonly propertyType?: AssetType;
  /** Legacy (shared) asset type for the bridged analyses row + `/export`
   *  assetClass query (default 'self_storage'). */
  readonly legacyAssetType?: LegacyAssetType;
}

/**
 * Ingest a portfolio (roll_up) loan from its EX-102 blob into the given stores.
 * Returns the graph root id (the public AnalysisId) — the id `/export` resolves.
 */
export async function ingestPortfolioFromEx102(
  opts: IngestPortfolioOptions,
): Promise<IngestPortfolioResult> {
  const {
    recordGraphStore,
    store,
    librarySnapshotId,
    rawBlobPath = PSB_RAW_BLOB,
    parentAssetNumber = PSB_PARENT_ASSET_NUMBER,
    asOf = '2026-07-10T00:00:00Z',
    dealRef = 'Prime Storage-Blue Portfolio',
    dealName = 'Prime Storage-Blue Portfolio (roll-up)',
    propertyType = 'SelfStorage' as AssetType,
    legacyAssetType = 'self_storage' as LegacyAssetType,
  } = opts;

  // (1) parse the EX-102 raw blob → (2) un-collapse to the N components.
  const xml = readFileSync(rawBlobPath, 'utf8');
  const ext = parseCmbsComps(xml, {
    sourceDeal: PSB_SOURCE_DEAL,
    filingDate: PSB_FILING_DATE,
    filingAccession: PSB_FILING_ACCESSION,
  });
  const properties = uncollapseRollUp(ext, parentAssetNumber);
  if (properties.length <= 1) {
    throw new Error(
      `ingestPortfolioFromEx102: parent assetNumber '${parentAssetNumber}' has ${properties.length} ` +
        'component(s) — not a portfolio (N>1 required).',
    );
  }

  // (3) build the ExtractionResult carrying `properties`.
  const extractionResult = buildPortfolioExtractionResult({ properties, asOf, dealRef });

  // (4) ingest — the ROOT branch persists registry (durable fix) then writes the
  //     root envelope + eval-context. Deterministic, no LLM (stub llmCall).
  const { marketBenchmarks, creditManifesto } = buildPortfolioRegistry(asOf);
  const ingest = await ingestExtractionResult(
    {
      extractionResult,
      propertyType,
      marketLiquidityHint: 'Secondary',
      librarySnapshotId,
      marketBenchmarks,
      creditManifesto,
      analysisAsOfDate: asOf,
      rentRoll: null,
    },
    recordGraphStore,
    // Deterministic no-LLM stub prose (the narrative producer rejects an empty
    // response). Portfolio scoring/render read structured records, not this text.
    {
      llmCall: async () =>
        'Portfolio roll-up ingest (deterministic). Per-property detail and the ' +
        'value-weighted roll-up drive the committee view; portfolio-structure ' +
        'terms are DATA_NOT_PROVIDED pending the loan documents.',
    },
  );

  // (5) bridge a minimal legacy analyses row → graph HEAD (rootId). Gives the
  //     deal a human name + makes resolveAnalysisForRead take the bridged-row
  //     branch, exactly like a promoted deal. graph_revision_id = rootId
  //     (ordinal-0 root IS the HEAD for a fresh ingest).
  const now = new Date().toISOString();
  const legacy: Analysis = {
    id: ingest.rootId,
    name: dealName,
    assetType: legacyAssetType,
    status: 'complete',
    progress: 100,
    currentStep: 'complete',
    createdAt: now,
    updatedAt: now,
    parentAnalysisId: null,
    lineageRootId: ingest.rootId,
    revisionOrdinal: 0,
    graphRevisionId: ingest.rootId,
    document: null,
    uwDocument: null,
    supportingDocuments: [],
    templateDocument: null,
    findings: [],
    creditScore: null,
    uwModel: null,
    research: null,
    crossCheckFindings: [],
    mitigations: [],
    executiveSummary: null,
    bPieceDecision: null,
    comments: [],
    criteriaEvaluations: [],
    stressScenarios: [],
  };
  // Idempotent: skip if a row for this id already exists (re-run safety).
  if (store.getAnalysis(ingest.rootId) === null) {
    store.createAnalysis(legacy);
  }

  return {
    rootId: ingest.rootId,
    extractionResultId: extractionResult.id,
    evaluationId: ingest.evaluationId,
    propertyCount: properties.length,
    marketBenchmarksId: marketBenchmarks.id,
    creditManifestoId: creditManifesto.id,
    legacyAnalysisId: ingest.rootId,
  };
}

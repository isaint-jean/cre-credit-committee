/**
 * underwriteLoan — Data-Room Phase 3, P1: the lineage-root BRIDGE + the
 * has-root / no-root BRANCH, fired behind an explicit "Underwrite now" action.
 *
 * This is the FIRST data-room → ingest edge. Per the hard invariant
 * (data-room-store.service.ts:10) the data-room STORE stays DECOUPLED from
 * ingest — so this orchestration lives in the SERVICE layer, called from the
 * ROUTE, NOT inside assignDataRoomFiles. The store still never imports the
 * composer; this service is the seam.
 *
 * ONE APPEND / INGEST PER LOAN. A loan's N tier-(a) data-room docs collapse to
 * ONE re-extraction job — never N. The has-root path copies the whole set into
 * the deal-source-doc store (which becomes the append's "prior" set), then fires
 * ONE appendSourceDocToDeal; the no-root path assembles the whole set into ONE
 * build-and-ingest.
 *
 * THE BRIDGE (two stores, two keys):
 *   - data-room store: keyed (poolId, loanInPoolId, docType)
 *   - deal-source-doc store: keyed rootId (lineage root) — what append reads
 * Half A moves a loan's tier-(a) docs across that seam (docType→slot); the bytes
 * already ride the shared content-addressed blobStore, so this is a manifest
 * write, not a byte copy.
 *
 * THE BRANCH (loan → root, latest-wins):
 *   - HAS-ROOT  (Sunroad/DEMO): lookupAnalysisByDealRef finds a legacy analysis
 *     with a graphRevisionId → copy docs to its lineage root → ONE append → child
 *     revision.
 *   - NO-ROOT   (the BMARK stubs): no analysis yet → build-and-ingest the doc set
 *     into a NEW root (supplying an available/appropriate benchmarks + manifesto +
 *     library snapshot registry INLINE, which the Phase-1 fix persists so the
 *     fresh root's eval-context resolves — no orphan) → promote-from-graph mints
 *     the legacy Analysis with graphRevisionId. The loan becomes analyzed; the
 *     NEXT underwrite takes the append path.
 *
 * NEVER writes cre.db directly — every write flows through the injected stores /
 * shipped services (append + ingest + promote). Idempotent-ish: re-running
 * re-appends (a new child) — the append's whole purpose.
 */

import { v4 as uuid } from 'uuid';
import { docTypeById } from '@cre/contracts';
import type {
  AssetType as ContractsAssetType,
  CreditManifesto,
  CreditManifestoId,
  ISODateTime,
  LibrarySnapshotId,
  LoanTermsExtraction,
  MarketBenchmarks,
  MarketBenchmarksId,
  MarketLiquidity,
  RevisionId,
} from '@cre/contracts';
import type { Analysis, AssetType as LegacyAssetType, SourceDocSlot } from '@cre/shared';

import { store as defaultSqliteStore } from '../../storage/sqlite-store.js';
import type { SqliteStore } from '../../storage/sqlite-store.js';
import { recordGraphStore as defaultGraphStore } from '../../storage/record-graph-store.js';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import { blobStore as defaultBlobStore } from '../../storage/blob-store.js';
import type { BlobStore } from '../../storage/blob-store.js';

import { listPoolDocs as defaultListPoolDocs } from '../data-room-store.service.js';
import type { DataRoomDocEntry } from '../data-room-store.service.js';
import { saveDealSourceDoc } from '../deal-source-doc-store.service.js';
import { appendSourceDocToDeal } from '../append-source-doc.service.js';
import type { AppendSourceDocResult } from '../append-source-doc.service.js';
import { buildExtractionResult as defaultBuild } from '../extraction/build-extraction-result.js';
import type { InputSlots } from '../extraction/extractor-outcome.js';
import { ingestExtractionResult as defaultIngest, IngestionError } from '../ingest-extraction-result.js';
import { cityStateToMarketLiquidity } from '../metro-tier-lookup.js';
import type { LLMCallFn } from '../narrative/build-narrative.js';

/* -------------------------------------------------------------------------- */
/* Result shape.                                                              */
/* -------------------------------------------------------------------------- */

export type UnderwriteLoanResult =
  | {
      readonly outcome: 'no-ingestable-docs';
      readonly loanInPoolId: string;
      readonly message: string;
    }
  | {
      readonly outcome: 'appended';
      readonly loanInPoolId: string;
      /** How many distinct tier-(a) docs fed the ONE append (proof of coalesce). */
      readonly docCount: number;
      readonly parentRevisionId: RevisionId;
      readonly childRevisionId: RevisionId;
      readonly revisionOrdinal: number;
      readonly analysisId: string;
    }
  | {
      readonly outcome: 'ingested';
      readonly loanInPoolId: string;
      readonly docCount: number;
      /** New lineage root minted by build-and-ingest. */
      readonly rootId: RevisionId;
      /** Legacy Analysis id minted by promote-from-graph. */
      readonly analysisId: string;
    };

/** Ingest / extraction failed — surfaced honestly, never a fake success. */
export class UnderwriteLoanError extends Error {
  override readonly name = 'UnderwriteLoanError';
  readonly code: string;
  readonly loanInPoolId: string;
  constructor(code: string, loanInPoolId: string, message: string) {
    super(message);
    this.code = code;
    this.loanInPoolId = loanInPoolId;
  }
}

/* -------------------------------------------------------------------------- */
/* Injectable deps — default singletons; the temp-db gates inject copies.      */
/* -------------------------------------------------------------------------- */

export interface UnderwriteLoanDeps {
  readonly sqliteStore?: SqliteStore;
  readonly recordGraphStore?: RecordGraphStore;
  readonly blobStore?: BlobStore;
  readonly listPoolDocs?: typeof defaultListPoolDocs;
  readonly buildExtractionResult?: typeof defaultBuild;
  readonly ingestExtractionResult?: typeof defaultIngest;
  /** Narrative LLM (stubbable for tests; live for real underwrites). */
  readonly llmCall?: LLMCallFn;
}

export interface UnderwriteLoanArgs {
  readonly poolId: string;
  readonly loanInPoolId: string;
  /** The pool loan's dealRef (read at the route from the pool store) — the
   *  loan→root join key. propertyType/loanTerms feed the no-root initial ingest.
   *  propertyType is the CONTRACTS AssetType (Office/Multifamily/…) the pool loan
   *  carries (LoanInPool.assetType). */
  readonly dealRef: string;
  readonly propertyType?: ContractsAssetType | null;
  readonly loanTerms?: LoanTermsExtraction | null;
  readonly analysisName?: string | null;
  /** As-of date for the no-root ingest (defaults to now). */
  readonly analysisAsOfDate?: ISODateTime;
}

/* -------------------------------------------------------------------------- */
/* Legacy asset-type mapping (mirror of promote-from-graph's map, inverted).    */
/* -------------------------------------------------------------------------- */

const CONTRACTS_TO_LEGACY_ASSET_TYPE: Record<ContractsAssetType, LegacyAssetType> = {
  Office: 'office',
  Retail: 'retail',
  Multifamily: 'multifamily',
  Hotel: 'hotel',
  Industrial: 'industrial',
  SelfStorage: 'self_storage',
  MHC: 'manufactured_housing',
  MixedUse: 'mixed_use',
  Other: 'mixed_use',
};

/* -------------------------------------------------------------------------- */
/* Half A helpers.                                                            */
/* -------------------------------------------------------------------------- */

/** A loan's tier-(a) (ingest===true) docs from the data-room store. Deduped per
 *  docType → SourceDocSlot: if two docs share a slot, the latest-uploaded wins
 *  (one slot ingests once). Returns the resolved slot alongside each entry. */
function gatherTierADocs(
  poolId: string,
  loanInPoolId: string,
  listPoolDocs: typeof defaultListPoolDocs,
): Array<{ entry: DataRoomDocEntry; slot: SourceDocSlot }> {
  const docs = listPoolDocs(poolId)
    .filter((d) => d.loanInPoolId === loanInPoolId && d.ingest === true)
    // stable: oldest → newest so the latest-per-slot wins the dedupe below.
    .slice()
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));

  const bySlot = new Map<SourceDocSlot, { entry: DataRoomDocEntry; slot: SourceDocSlot }>();
  for (const d of docs) {
    const taxo = docTypeById(d.docType);
    const slot = taxo?.slot as SourceDocSlot | null | undefined;
    if (!slot) continue; // not slotted → not a composer input (shouldn't happen for tier-a)
    bySlot.set(slot, { entry: d, slot }); // latest-per-slot wins
  }
  return Array.from(bySlot.values());
}

/* -------------------------------------------------------------------------- */
/* Public API — the bridge + branch.                                           */
/* -------------------------------------------------------------------------- */

export async function underwriteLoan(
  args: UnderwriteLoanArgs,
  deps: UnderwriteLoanDeps = {},
): Promise<UnderwriteLoanResult> {
  const sqlite = deps.sqliteStore ?? defaultSqliteStore;
  const graph = deps.recordGraphStore ?? defaultGraphStore;
  const blob = deps.blobStore ?? defaultBlobStore;
  const listPoolDocs = deps.listPoolDocs ?? defaultListPoolDocs;
  const build = deps.buildExtractionResult ?? defaultBuild;
  const ingest = deps.ingestExtractionResult ?? defaultIngest;

  // ── Gather the loan's tier-(a) docs (ONE set → ONE job). ──
  const tierA = gatherTierADocs(args.poolId, args.loanInPoolId, listPoolDocs);
  if (tierA.length === 0) {
    return {
      outcome: 'no-ingestable-docs',
      loanInPoolId: args.loanInPoolId,
      message:
        'No ingestable (tier-a) source documents on file for this loan — nothing to underwrite. ' +
        'Drop an ASR / cash-flow / rent-roll / PCA / appraisal first.',
    };
  }

  // Fetch bytes for each doc's blob (content-addressed; shared store).
  const docBytes: Array<{ slot: SourceDocSlot; fileName: string; bytes: Buffer }> = [];
  for (const { entry, slot } of tierA) {
    const bytes = await blob.getBlob(entry.fileHash as never);
    if (bytes === null) {
      throw new UnderwriteLoanError(
        'DATA_ROOM_BLOB_MISSING',
        args.loanInPoolId,
        `data-room doc bytes missing from blobStore: ${entry.docType}/${entry.fileHash} (manifest/blob drift)`,
      );
    }
    docBytes.push({ slot, fileName: entry.fileName, bytes });
  }

  // ── Half B — resolve loan → root (latest-wins). ──
  const matches = sqlite.lookupAnalysisByDealRef(args.dealRef);
  const legacyId = matches.find((m) => m.legacyId !== null)?.legacyId ?? null;

  if (legacyId !== null) {
    // ================= HAS-ROOT → APPEND (one job) =================
    return underwriteHasRoot({ ...args, legacyId, docBytes }, { sqlite, graph, llmCall: deps.llmCall });
  }

  // ================= NO-ROOT → BUILD-AND-INGEST → PROMOTE =================
  return underwriteNoRoot({ ...args, docBytes }, { sqlite, graph, blob, build, ingest, llmCall: deps.llmCall });
}

/* -------------------------------------------------------------------------- */
/* HAS-ROOT path.                                                             */
/* -------------------------------------------------------------------------- */

async function underwriteHasRoot(
  args: UnderwriteLoanArgs & {
    legacyId: string;
    docBytes: Array<{ slot: SourceDocSlot; fileName: string; bytes: Buffer }>;
  },
  deps: { sqlite: SqliteStore; graph: RecordGraphStore; llmCall?: UnderwriteLoanDeps['llmCall'] },
): Promise<UnderwriteLoanResult> {
  const analysis = deps.sqlite.getAnalysis(args.legacyId);
  if (analysis === null || !analysis.graphRevisionId) {
    // lookup found it but it isn't graph-backed → not append-able. Fall through
    // to a clear error rather than silently ingesting nothing.
    throw new UnderwriteLoanError(
      'NOT_GRAPH_BACKED',
      args.loanInPoolId,
      `analysis ${args.legacyId} has no graph revision — cannot append`,
    );
  }
  const parentRev = analysis.graphRevisionId as RevisionId;

  // SELF-SOURCE benchmarks/manifesto from the parent's eval-context (A-enabler).
  const ctx = deps.graph.getRevisionEvaluationContext(parentRev);
  if (ctx === null) {
    throw new UnderwriteLoanError(
      'NO_EVAL_CONTEXT',
      args.loanInPoolId,
      `deal predates eval-context recording — not append-able (analysis ${args.legacyId})`,
    );
  }

  // The lineage root is the deal-source-doc store key. Resolve it from the parent
  // envelope so Half-A writes land where append reads.
  const parentEnv = deps.graph.getRevisionEnvelope(parentRev);
  if (parentEnv === null) {
    throw new UnderwriteLoanError('PARENT_ENVELOPE_NOT_FOUND', args.loanInPoolId, `parent envelope not found: ${parentRev}`);
  }
  const lineageRoot = parentEnv.lineageRootId;

  // ── Half A — copy the loan's tier-(a) docs into the deal-source-doc store at
  //    the lineage root. Bytes already ride the shared blobStore, so this is a
  //    manifest write. These become the append's "prior" set. ──
  for (const d of args.docBytes) {
    await saveDealSourceDoc(lineageRoot, d.slot, { originalFileName: d.fileName, bytes: d.bytes });
  }

  // ── ONE append over the WHOLE set. The whole set now lives at the root as
  //    "prior"; we pass ONE doc as `newDoc` (dedupes in the manifest) so the
  //    append re-extracts the FULL set in a SINGLE re-extraction — NOT one
  //    append per doc. ──
  const head = args.docBytes[args.docBytes.length - 1]!;
  let result: AppendSourceDocResult;
  try {
    result = await appendSourceDocToDeal(
      {
        analysisId: args.legacyId,
        newDoc: { slot: head.slot, originalFileName: head.fileName, bytes: head.bytes },
        marketBenchmarksId: ctx.marketBenchmarksId as MarketBenchmarksId,
        creditManifestoId: ctx.creditManifestoId as CreditManifestoId,
      },
      { sqliteStore: deps.sqlite, recordGraphStore: deps.graph, llmCall: deps.llmCall },
    );
  } catch (e) {
    throw wrapIngestError(e, args.loanInPoolId, 'APPEND_FAILED');
  }

  return {
    outcome: 'appended',
    loanInPoolId: args.loanInPoolId,
    docCount: args.docBytes.length,
    parentRevisionId: result.parentRevisionId,
    childRevisionId: result.childRevisionId,
    revisionOrdinal: result.revisionOrdinal,
    analysisId: args.legacyId,
  };
}

/* -------------------------------------------------------------------------- */
/* NO-ROOT path.                                                              */
/* -------------------------------------------------------------------------- */

async function underwriteNoRoot(
  args: UnderwriteLoanArgs & {
    docBytes: Array<{ slot: SourceDocSlot; fileName: string; bytes: Buffer }>;
  },
  deps: {
    sqlite: SqliteStore;
    graph: RecordGraphStore;
    blob: BlobStore;
    build: typeof defaultBuild;
    ingest: typeof defaultIngest;
    llmCall?: UnderwriteLoanDeps['llmCall'];
  },
): Promise<UnderwriteLoanResult> {
  // Supply an available/appropriate registry INLINE. The Phase-1 fix persists the
  // inline registry on fresh-root creation so the eval-context resolves (no
  // orphan). "Available/appropriate" = a COHERENT triple sourced from an existing
  // analyzed revision's eval-context (benchmarks + manifesto + librarySnapshot +
  // analysisAsOfDate all from the SAME evaluation) — NOT list[0] of each store
  // independently, which can pick mismatched vintages and trip the replay-key
  // as-of check (JE_ANALYSIS_AS_OF_MISMATCH). This is the same set /analysis/new
  // uses; a first ingest inherits the library the live deals were judged against.
  const ctx = pickCoherentRegistryContext(deps.graph);
  if (ctx === null) {
    throw new UnderwriteLoanError(
      'NO_REGISTRY_AVAILABLE',
      args.loanInPoolId,
      'no analyzed revision to source a coherent benchmarks/manifesto/library registry from — cannot mint a ' +
        'first analysis. Ingest at least one deal (or register a library snapshot + benchmarks + manifesto) first.',
    );
  }
  const benchmarks = deps.graph.getMarketBenchmarks(ctx.marketBenchmarksId as MarketBenchmarksId);
  const manifesto = deps.graph.getCreditManifesto(ctx.creditManifestoId as CreditManifestoId);
  const librarySnapshot = deps.graph.getLibrarySnapshot(ctx.librarySnapshotId as LibrarySnapshotId);
  if (benchmarks === null || manifesto === null || librarySnapshot === null) {
    throw new UnderwriteLoanError(
      'NO_REGISTRY_AVAILABLE',
      args.loanInPoolId,
      'the sourced registry triple is not fully resolvable — cannot mint a first analysis.',
    );
  }

  // Assemble the WHOLE tier-(a) set into ONE InputSlots (ONE ingest job).
  const slots: InputSlots = {};
  for (const d of args.docBytes) {
    const key = SLOT_TO_COMPOSER_INPUT[d.slot];
    if (key !== null) (slots as Record<string, { buffer: Buffer; filename: string }>)[key] = { buffer: d.bytes, filename: d.fileName };
  }

  // The analysis as-of date participates in the doctrine replay key and MUST match
  // the sourced context's as-of (JE_ANALYSIS_AS_OF_MISMATCH otherwise). Inherit the
  // coherent context's date — never now() (which would mismatch the reused registry).
  const asOf = args.analysisAsOfDate ?? (ctx.analysisAsOfDate as ISODateTime);
  const dealRef = args.dealRef;

  // Persist blobs FIRST (fail-fast before any AI call) — mirrors build-and-ingest.
  for (const d of args.docBytes) {
    await deps.blob.putBlob(d.bytes);
  }

  let composed;
  try {
    composed = await deps.build({
      slots,
      analysisAsOfDate: asOf,
      dealRef,
      ...(args.loanTerms ? { loanTerms: args.loanTerms } : {}),
    });
  } catch (e) {
    throw wrapIngestError(e, args.loanInPoolId, 'BUILD_FAILED');
  }

  // propertyType: prefer the pool loan's asset type; else Office (a first ingest
  // needs a propertyType and the pool loan's assetType is the authoritative hint).
  const propertyType: ContractsAssetType = args.propertyType ?? ('Office' as ContractsAssetType);

  const liquidity: MarketLiquidity =
    composed.propertyMetadata !== null
      ? cityStateToMarketLiquidity(composed.propertyMetadata.city, composed.propertyMetadata.state)
      : 'Unknown';

  let ingested;
  try {
    ingested = await deps.ingest(
      {
        extractionResult: composed.extractionResult,
        propertyType: propertyType as never,
        marketLiquidityHint: liquidity,
        librarySnapshotId: librarySnapshot.id as LibrarySnapshotId,
        // INLINE registry → Phase-1 fix persists it on fresh-root create (no orphan).
        marketBenchmarks: benchmarks as MarketBenchmarks,
        creditManifesto: manifesto as CreditManifesto,
        analysisAsOfDate: asOf,
        rentRoll: composed.rentRoll,
        propertyMetadata: composed.propertyMetadata,
      },
      deps.graph,
      { llmCall: deps.llmCall },
    );
  } catch (e) {
    throw wrapIngestError(e, args.loanInPoolId, 'INGEST_FAILED');
  }

  // Persist raw docs at the new root so the NEXT underwrite takes the append path.
  for (const d of args.docBytes) {
    try {
      await saveDealSourceDoc(ingested.rootId, d.slot, { originalFileName: d.fileName, bytes: d.bytes });
    } catch {
      // best-effort — the graph is committed; a persist miss only means the next
      // append re-supplies from the data room. Never fail the underwrite for it.
    }
  }

  // ── promote-from-graph: mint the legacy Analysis carrying graphRevisionId. ──
  const rootRevisionId = ingested.rootId as RevisionId;
  const analysisId = promoteFromGraph({
    sqlite: deps.sqlite,
    graph: deps.graph,
    rootRevisionId,
    name: args.analysisName ?? null,
  });

  return {
    outcome: 'ingested',
    loanInPoolId: args.loanInPoolId,
    docCount: args.docBytes.length,
    rootId: rootRevisionId,
    analysisId,
  };
}

/* -------------------------------------------------------------------------- */
/* promote-from-graph (in-process mirror of analysis.routes.ts:347).           */
/* -------------------------------------------------------------------------- */

function promoteFromGraph(args: {
  sqlite: SqliteStore;
  graph: RecordGraphStore;
  rootRevisionId: RevisionId;
  name: string | null;
}): string {
  const envelope = args.graph.getRevisionEnvelope(args.rootRevisionId);
  if (envelope === null) throw new Error(`promote: revision not found: ${args.rootRevisionId}`);
  const doctrine = args.graph.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (doctrine === null) throw new Error('promote: DoctrineEvaluation missing');
  const extraction = args.graph.getExtractionResult(doctrine.extractionResultId);
  if (extraction === null) throw new Error('promote: ExtractionResult missing');
  const assetProfile = args.graph.getAssetProfile(doctrine.assetProfileId);
  if (assetProfile === null) throw new Error('promote: AssetProfile missing');

  const id = uuid();
  const now = new Date().toISOString();
  const name =
    args.name && args.name.length > 0
      ? args.name
      : extraction.dealRef ?? `Promoted Analysis ${id.slice(0, 8)}`;

  const analysis: Analysis = {
    id,
    name,
    assetType: CONTRACTS_TO_LEGACY_ASSET_TYPE[assetProfile.propertyType],
    status: 'complete',
    progress: 100,
    currentStep: 'Complete (promoted from graph)',
    createdAt: now,
    updatedAt: now,
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
    graphRevisionId: args.rootRevisionId,
  };
  args.sqlite.createAnalysis(analysis);
  return id;
}

/* -------------------------------------------------------------------------- */
/* Coherent registry-context sourcing (no-root initial ingest).                */
/* -------------------------------------------------------------------------- */

/** A self-consistent registry triple + as-of date, all from ONE prior evaluation
 *  — so the reused registry passes the doctrine replay-key / as-of check. */
interface CoherentRegistryContext {
  readonly marketBenchmarksId: string;
  readonly creditManifestoId: string;
  readonly librarySnapshotId: string;
  readonly analysisAsOfDate: string;
}

/** Source a coherent registry context from the NEWEST existing revision that has
 *  an eval-context: its {benchmarks, manifesto} come from revision_evaluation_context,
 *  its {librarySnapshot, analysisAsOfDate} from that revision's doctrine evaluation.
 *  Returns null when no analyzed revision exists (nothing to inherit from). */
function pickCoherentRegistryContext(graph: RecordGraphStore): CoherentRegistryContext | null {
  const db = (graph as unknown as { db: import('better-sqlite3').Database }).db;
  const row = db
    .prepare(
      `SELECT rec.market_benchmarks_id AS mb,
              rec.credit_manifesto_id  AS cm,
              de.library_snapshot_id   AS lib,
              de.analysis_as_of_date   AS asof
       FROM revision_evaluation_context rec
       JOIN revision_lineage_envelopes rle ON rle.revision_id = rec.revision_id
       JOIN doctrine_evaluations de        ON de.id = rle.doctrine_evaluation_id
       ORDER BY rec.created_at DESC
       LIMIT 1`,
    )
    .get() as { mb: string; cm: string; lib: string; asof: string } | undefined;
  if (!row) return null;
  return {
    marketBenchmarksId: row.mb,
    creditManifestoId: row.cm,
    librarySnapshotId: row.lib,
    analysisAsOfDate: row.asof,
  };
}

/* -------------------------------------------------------------------------- */
/* Composer slot map (mirror of append-source-doc.service.ts SLOT_TO_INPUT).    */
/* -------------------------------------------------------------------------- */

const SLOT_TO_COMPOSER_INPUT: Record<SourceDocSlot, keyof InputSlots | null> = {
  asr: 'asrPdf',
  cf: 'sellerCfXlsx',
  rent_roll: 'rentRollXlsx',
  pca: 'pcaPdf',
  appraisal: 'appraisalPdf',
  seller_uw: null,
  t12: null,
};

/* -------------------------------------------------------------------------- */
/* Error mapping — surface the REAL reason, never a fake success.              */
/* -------------------------------------------------------------------------- */

function wrapIngestError(e: unknown, loanInPoolId: string, fallbackCode: string): UnderwriteLoanError {
  if (e instanceof UnderwriteLoanError) return e;
  if (e instanceof IngestionError) {
    return new UnderwriteLoanError(e.code, loanInPoolId, e.message);
  }
  const msg = (e as Error)?.message ?? 'underwrite failed';
  const name = (e as Error)?.name;
  return new UnderwriteLoanError(name && name !== 'Error' ? name : fallbackCode, loanInPoolId, msg);
}

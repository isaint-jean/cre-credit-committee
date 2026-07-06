/**
 * appendSourceDocToDeal — re-ingest an existing deal with an added source
 * document as a CHILD revision (append step 2 orchestration).
 *
 * Flow: resolve the deal's current revision as parent → assemble prior docs
 * (getDealSourceDocs, from step (a)) + the new doc → buildExtractionResult on
 * the FULL set → ingestExtractionResult({ parentRevisionId }) writes a child
 * revision (step 1) → store.updateAnalysis advances the deal to it
 * (overlay-coherent) → persist the new doc so the child stays re-appendable.
 *
 * Overlay policy = PRESERVE-AND-FLAG: project-legacy reads overlays
 * (t12Extraction/sourcesAndUses/…) PRIMARY over the fresh extraction, so they
 * survive automatically (PRESERVE). This service only FLAGS divergences (its own
 * channel, NOT doctrine findings) — it never clears an overlay.
 *
 * Reconstruction note: librarySnapshotId / analysisAsOfDate / propertyType are
 * read from the parent (doctrine evaluation + asset profile). marketBenchmarksId
 * and creditManifestoId are NOT graph-persisted, so the CALLER must supply them.
 *
 * No new extractor — the new doc routes through the existing composer adapters.
 */
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import { recordGraphStore as defaultGraphStore } from '../storage/record-graph-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { store as defaultSqliteStore } from '../storage/sqlite-store.js';
import type { LLMCallFn } from './narrative/build-narrative.js';
import { buildExtractionResult as defaultBuild } from './extraction/build-extraction-result.js';
import { ingestExtractionResult as defaultIngest, IngestionError } from './ingest-extraction-result.js';
import { getDealSourceDocs, saveDealSourceDoc } from './deal-source-doc-store.service.js';
import type { InputSlots } from './extraction/extractor-outcome.js';
import type { SourceDocSlot } from '@cre/shared';
import type {
  AssetType, ISODateTime, LibrarySnapshotId, MarketBenchmarksId, CreditManifestoId,
  RevisionId, ExtractionResult,
} from '@cre/contracts';

/** deal-doc slot → composer InputSlots field. null = not a composer input.
 *  ★ INGEST-CRITICAL — this map drives the composer slot assembly below; do NOT
 *  rewire it from the taxonomy. It is `export`ed (read-only, additive) purely so
 *  the doc-type-taxonomy consistency check can ASSERT it agrees with the single
 *  source of truth (@cre/contracts SLOT_TO_ENGINE_INPUT). Physical definition
 *  stays here for ingest safety; the taxonomy is the *verified* source. */
export const SLOT_TO_INPUT: Record<SourceDocSlot, keyof InputSlots | null> = {
  asr: 'asrPdf',
  cf: 'sellerCfXlsx',
  rent_roll: 'rentRollXlsx',
  pca: 'pcaPdf',
  appraisal: 'appraisalPdf',
  seller_uw: null,
  t12: null,
};

export interface OverlayDivergence {
  readonly overlay: 't12Extraction' | 'sourcesAndUses';
  readonly detail: string;
}

export interface AppendSourceDocArgs {
  readonly analysisId: string;
  readonly newDoc: { slot: SourceDocSlot; originalFileName: string; bytes: Buffer };
  /** Caller-supplied — NOT reconstructable from the parent graph. */
  readonly marketBenchmarksId: MarketBenchmarksId;
  readonly creditManifestoId: CreditManifestoId;
}

export interface AppendSourceDocResult {
  readonly parentRevisionId: RevisionId;
  readonly childRevisionId: RevisionId;
  readonly revisionOrdinal: number;
  readonly overlayDivergences: ReadonlyArray<OverlayDivergence>;
  readonly newDocPersist: { slot: SourceDocSlot; status: 'ok' | 'error'; fileHash?: string; message?: string };
}

export interface AppendSourceDocDeps {
  readonly recordGraphStore?: RecordGraphStore;
  readonly sqliteStore?: SqliteStore;
  readonly buildExtractionResult?: typeof defaultBuild;
  readonly ingestExtractionResult?: typeof defaultIngest;
  readonly llmCall?: LLMCallFn;
}

/** PRESERVE-AND-FLAG: compare each existing overlay against what the fresh
 *  extraction now produces. Returns divergences; never mutates anything. */
function compareOverlays(
  analysis: { t12Extraction?: unknown; sourcesAndUses?: unknown },
  fresh: ExtractionResult,
): OverlayDivergence[] {
  const out: OverlayDivergence[] = [];
  const ovT12 = analysis.t12Extraction as { noi?: number } | null | undefined;
  const freshT12 = fresh.t12Actual;
  if (ovT12 && freshT12 && ovT12.noi !== freshT12.noi) {
    out.push({ overlay: 't12Extraction', detail: `overlay NOI ${ovT12.noi} vs fresh extraction NOI ${freshT12.noi} — overlay PRESERVED (PRIMARY); review.` });
  }
  const ovSU = analysis.sourcesAndUses as { loanAmount?: number } | null | undefined;
  const freshSU = fresh.asr?.sourcesAndUses;
  if (ovSU && freshSU && ovSU.loanAmount !== freshSU.loanAmount) {
    out.push({ overlay: 'sourcesAndUses', detail: `overlay loanAmount ${ovSU.loanAmount} vs fresh ${freshSU.loanAmount} — overlay PRESERVED (PRIMARY); review.` });
  }
  return out;
}

export async function appendSourceDocToDeal(
  args: AppendSourceDocArgs,
  deps: AppendSourceDocDeps = {},
): Promise<AppendSourceDocResult> {
  const graph = deps.recordGraphStore ?? defaultGraphStore;
  const sqlite = deps.sqliteStore ?? defaultSqliteStore;
  const build = deps.buildExtractionResult ?? defaultBuild;
  const ingest = deps.ingestExtractionResult ?? defaultIngest;

  // 1. Resolve current revision as parent.
  const analysis = sqlite.getAnalysis(args.analysisId);
  if (analysis === null) throw new Error(`append: analysis not found: ${args.analysisId}`);
  const parentRevisionId = analysis.graphRevisionId as RevisionId | null;
  if (!parentRevisionId) throw new Error(`append: analysis ${args.analysisId} has no graphRevisionId (not graph-backed)`);
  const parentEnv = graph.getRevisionEnvelope(parentRevisionId);
  if (parentEnv === null) throw new Error(`append: parent revision envelope not found: ${parentRevisionId}`);
  const doctrineEval = graph.getDoctrineEvaluation(parentEnv.doctrineEvaluationId);
  if (doctrineEval === null) throw new Error(`append: parent doctrine evaluation not found`);
  const assetProfile = graph.getAssetProfile(doctrineEval.assetProfileId);
  if (assetProfile === null) throw new Error(`append: parent asset profile not found`);
  const parentAdjustedInputs = graph.getAdjustedInputs(parentEnv.adjustedInputsId);
  if (parentAdjustedInputs === null) throw new Error(`append: parent adjusted inputs not found`);
  const lineageRoot = parentEnv.lineageRootId; // deal-doc store key (stable across revisions)

  // Reconstruct the parent's CURRENT (adjusted) loan economics into the
  // LoanTermsExtraction the composer expects, so the child re-extraction carries
  // the deal's loan terms — not a blank. Source of truth = parent AdjustedInputs
  // (inherit the adjusted terms, not the raw original).
  const pl = parentAdjustedInputs.loan;
  const loanTerms: import('@cre/contracts').LoanTermsExtraction = {
    loanAmount: pl.loanAmount.adjusted,
    interestRate: pl.interestRate.adjusted,
    amortization: pl.amortizationMonths.adjusted,
    interestOnlyPeriod: pl.ioPeriodMonths.adjusted,
    maturityDate: pl.maturityDate,
  };

  // 2. Assemble docs: prior (from (a)) + new. Map slot → composer InputSlots.
  const prior = await getDealSourceDocs(lineageRoot);
  const allDocs = [
    ...prior.map((d) => ({ slot: d.slot, filename: d.fileName, bytes: d.bytes })),
    { slot: args.newDoc.slot, filename: args.newDoc.originalFileName, bytes: args.newDoc.bytes },
  ];
  const slots: Record<string, { buffer: Buffer; filename: string }> = {};
  for (const d of allDocs) {
    const key = SLOT_TO_INPUT[d.slot];
    if (key !== null) slots[key] = { buffer: d.bytes, filename: d.filename };
  }

  // 3. Re-extract the FULL set (same composer, same adapters — no new extractor).
  const composed = await build({
    slots: slots as InputSlots,
    analysisAsOfDate: doctrineEval.analysisAsOfDate,
    dealRef: analysis.name ?? args.analysisId,
    loanTerms,
  });

  // 4. PRESERVE-AND-FLAG overlay divergences (own channel; PRESERVE is automatic).
  const overlayDivergences = compareOverlays(analysis as never, composed.extractionResult);

  // 5. Ingest as a CHILD revision (step 1's parentRevisionId branch).
  const child = await ingest(
    {
      extractionResult: composed.extractionResult,
      propertyType: assetProfile.propertyType as unknown as AssetType,
      librarySnapshotId: doctrineEval.librarySnapshotId as LibrarySnapshotId,
      marketBenchmarksId: args.marketBenchmarksId,
      creditManifestoId: args.creditManifestoId,
      analysisAsOfDate: doctrineEval.analysisAsOfDate as ISODateTime,
      rentRoll: composed.rentRoll,
      propertyMetadata: composed.propertyMetadata,
      parentRevisionId,
    },
    graph,
    { llmCall: deps.llmCall },
  );

  // 6. Advance the deal to the child — load-merge-save (overlays survive in
  //    `existing`; blob+column graph_revision_id advance to the SAME child).
  //    NEVER a raw UPDATE … SET data.
  sqlite.updateAnalysis(args.analysisId, { graphRevisionId: child.rootId });

  // 7. Persist the new doc so the child deal stays re-appendable.
  let newDocPersist: AppendSourceDocResult['newDocPersist'];
  try {
    const entry = await saveDealSourceDoc(lineageRoot, args.newDoc.slot, {
      originalFileName: args.newDoc.originalFileName,
      bytes: args.newDoc.bytes,
    });
    newDocPersist = { slot: args.newDoc.slot, status: 'ok', fileHash: entry.fileHash };
  } catch (e) {
    newDocPersist = { slot: args.newDoc.slot, status: 'error', message: (e as Error)?.message ?? 'persist failed' };
  }

  return {
    parentRevisionId,
    childRevisionId: child.rootId,
    revisionOrdinal: parentEnv.revisionOrdinal + 1,
    overlayDivergences,
    newDocPersist,
  };
}
void IngestionError;

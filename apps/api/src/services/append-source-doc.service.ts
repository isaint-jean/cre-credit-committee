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
import type { NarrativeStatus } from './evaluate-and-narrate.js';
import { getDealSourceDocs, saveDealSourceDoc } from './deal-source-doc-store.service.js';
import type { InputSlots } from './extraction/extractor-outcome.js';
import type { SourceDocSlot } from '@cre/shared';
import type {
  AssetType, ISODateTime, LibrarySnapshotId, MarketBenchmarksId, CreditManifestoId,
  RevisionId, ExtractionResult, RentRoll, PropertyMetadata, LoanTermsExtraction,
  ExtractionResultId, RentRollId,
} from '@cre/contracts';
import { computeBufferContentHash, computeExtractionResultId } from '../util/content-hash.js';
import { ASR_ADAPTER_VERSION } from './extraction/adapters/asr.adapter.js';

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

/**
 * ★ PARENT CARRY-FORWARD (pure, creditless). Reuse the parent's FROZEN extraction
 * verbatim — income / value / rent-roll / asr / etc. all carry unchanged — and
 * override ONLY loanTerms with the AdjustedInputs reconstruction (the existing
 * term-carry). NO re-extraction, NO LLM (no llmCall parameter — creditless by
 * construction). This is what makes a re-score deterministic: the child's
 * extraction is byte-identical to the parent's for every field the new doc didn't
 * change. Exported so the determinism invariant is unit-tested without an ingest
 * or any model call.
 */
export function composeFromParentCarry(args: {
  readonly parentEr: ExtractionResult;
  readonly parentRentRoll: RentRoll | null;
  readonly parentPropertyMetadata: PropertyMetadata | null;
  readonly loanTerms: LoanTermsExtraction;
}): { extractionResult: ExtractionResult; propertyMetadata: PropertyMetadata | null; rentRoll: RentRoll | null } {
  return {
    extractionResult: { ...args.parentEr, loanTerms: args.loanTerms },
    propertyMetadata: args.parentPropertyMetadata,
    rentRoll: args.parentRentRoll,
  };
}

/**
 * ★ PER-SLOT MERGE — carry the parent's frozen extraction, but take the FRESH
 * rent-roll field. Used when the rent-roll extractor IMPROVED (parent asr 0.5.0 →
 * current 0.6.2 = the 5afa5f5 reconciling roll): re-extract to get the reconciled
 * 24-tenant roll so concentration prices, while income / value / loan-terms stay
 * BYTE-IDENTICAL to the parent (field-level, not all-or-nothing — no
 * re-extraction drift). The content-addressed extractionResult.id is RECOMPUTED
 * (ingest trusts it and does not recompute) so the child's id reflects the new
 * rent-roll content. Only `rentRoll` (+ its extractorVersion) changes; every other
 * field is the parent's frozen value.
 */
export function composeFromParentCarryWithFreshRentRoll(args: {
  readonly parentEr: ExtractionResult;
  readonly parentPropertyMetadata: PropertyMetadata | null;
  readonly fresh: { extractionResult: ExtractionResult; rentRoll: RentRoll | null };
  readonly loanTerms: LoanTermsExtraction;
}): { extractionResult: ExtractionResult; propertyMetadata: PropertyMetadata | null; rentRoll: RentRoll | null } {
  const parent = args.parentEr as unknown as Record<string, unknown>;
  const fresh = args.fresh.extractionResult as unknown as Record<string, unknown>;
  const { id: _dropId, ...parentBody } = parent; // id recomputed below from the new content
  const childBody = {
    ...parentBody,
    rentRoll: fresh['rentRoll'], // ★ ONLY the rent-roll field is fresh (the reconciled roll)
    loanTerms: args.loanTerms,
    extractorVersions: {
      ...(parent['extractorVersions'] as Record<string, unknown> ?? {}),
      rentRoll: (fresh['extractorVersions'] as Record<string, unknown> | undefined)?.['rentRoll']
        ?? (parent['extractorVersions'] as Record<string, unknown> | undefined)?.['rentRoll'],
    },
  };
  const id = computeExtractionResultId(childBody);
  return {
    extractionResult: { id, ...childBody } as unknown as ExtractionResult,
    propertyMetadata: args.parentPropertyMetadata,
    rentRoll: args.fresh.rentRoll,
  };
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
  /** Narrative status of the child revision — 'deferred' when the memo LLM failed
   *  (credits exhausted) but the child's score/head persisted (a PARTIAL append). */
  readonly narrativeStatus: NarrativeStatus;
  readonly narrativeDeferredReason: string | null;
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

  // Reconstruct the parent's CURRENT loan economics into the
  // LoanTermsExtraction the composer expects, so the child re-extraction carries
  // the deal's loan terms — not a blank. Source of truth = parent AdjustedInputs.
  //
  // ★ PROVENANCE-PRESERVING CARRY (re-score-never-downgrades-disclosure). A field
  // that was ASSUMED in the parent — raw === null with a substitution / benchmark
  // / default adjustment (e.g. 640's interest rate: the ASR is pre-pricing, so
  // judgment SUBSTITUTED 6.5% from the market benchmark and flagged
  // JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK) — must carry the RAW null, NOT
  // the adjusted value. Carrying the adjusted 0.065 makes the child present the
  // rate as a SOURCED bank rate (raw 0.065, substitution flag gone) → the
  // "interest rate is an assumption" disclosure the assumed-inputs surface exists
  // to show silently vanishes on a re-score. Carrying null re-runs the SAME
  // substitution against the SAME (carried) benchmark → identical value AND
  // identical disclosure. Genuinely-extracted / derived-and-carried fields
  // (loanAmount, term) are NOT assumed → carry the adjusted value (preserves the
  // 7d4fd9a term-carry). INVARIANT: an assumed input stays flagged assumed
  // through the append carry — never downgraded to sourced.
  const pl = parentAdjustedInputs.loan;
  const carry = (li: { raw: number | null; adjusted: number | null; adjustments?: ReadonlyArray<{ ruleId?: string }> }): number | null => {
    const assumed = li.raw === null
      && (li.adjustments ?? []).some((a) => /SUBSTITUT|BENCHMARK|DEFAULT/i.test(a.ruleId ?? ''));
    return assumed ? null : li.adjusted;
  };
  const loanTerms: import('@cre/contracts').LoanTermsExtraction = {
    loanAmount: carry(pl.loanAmount),
    interestRate: carry(pl.interestRate),
    amortization: carry(pl.amortizationMonths),
    interestOnlyPeriod: carry(pl.ioPeriodMonths),
    // ★ CARRY termMonths. buildTermMonths reads maturityDate−asOf FIRST, then
    // falls back to loanTerms.termMonths. A deal with a stated maturityDate
    // (Sunroad) survived on that first path — but a TERM-ONLY deal with NO
    // maturity (640: "$400,000,000, 5-year, interest-only", maturityDate null)
    // has ONLY the termMonths fallback. Omitting it here dropped the parent's
    // 60mo term on every re-score → JE_TERM_MONTHS_MISSING, regardless of what
    // the fresh extraction found (this override is PRIMARY over it). termMonths is
    // extracted/derived (not benchmark-substituted) so `carry` returns its value.
    termMonths: carry(pl.termMonths),
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

  // 3. ★ PARENT CARRY-FORWARD (append-determinism, item #1b). A re-score that
  //    re-extracts income / rent-roll FRESH DRIFTS: 640's re-score dropped NOI to
  //    a worse-sourced figure + lost concentration (a non-reconciling fresh roll)
  //    → 60→66 on WORSE inputs. The append ALREADY carries loan-terms; extend that
  //    carry to the WHOLE extraction. When the appended doc adds NO NEW CONTENT
  //    (a re-score re-firing the SAME docs — its bytes already in the parent), we
  //    reuse the parent's FROZEN extraction verbatim: deterministic, byte-identical
  //    to the parent, ZERO re-extraction, ZERO LLM (pure data reuse).
  const parentEr = graph.getExtractionResult(doctrineEval.extractionResultId as ExtractionResultId);
  const parentRentRoll = doctrineEval.rentRollId
    ? graph.getRentRoll(doctrineEval.rentRollId as RentRollId)
    : null;
  const parentPm = parentEr
    ? graph.getPropertyMetadataByExtractionResultId(doctrineEval.extractionResultId as ExtractionResultId)
    : null;
  const newDocHash = computeBufferContentHash(args.newDoc.bytes);
  const parentDocHashes = new Set((parentEr?.sourceDocuments ?? []).map((d) => d.contentHash));
  const introducesNewContent = parentEr === null || !parentDocHashes.has(newDocHash);
  // ★ Rent-roll extractor improved? The reconciling roll (5afa5f5) ships in the
  //   ASR adapter, so an asr-version bump (parent 0.5.0 → current 0.6.2) means a
  //   re-extract would read the FULL reconciled roll the parent under-read. Only
  //   then do we re-extract — a PLAIN re-score (matching version) still carries
  //   byte-identical (determinism fix intact).
  const parentAsrVersion = (parentEr?.extractorVersions as Record<string, unknown> | undefined)?.['asr'];
  const rentRollExtractorImproved = parentEr !== null
    && typeof parentAsrVersion === 'string' && parentAsrVersion !== ASR_ADAPTER_VERSION;

  let composed: { extractionResult: ExtractionResult; propertyMetadata: PropertyMetadata | null; rentRoll: RentRoll | null };
  if (parentEr !== null && !introducesNewContent && !rentRollExtractorImproved) {
    // ★ CARRY-FORWARD — no new content, no extractor change → reuse the parent's
    //   frozen extraction verbatim (deterministic, byte-identical, ZERO LLM).
    composed = composeFromParentCarry({ parentEr, parentRentRoll, parentPropertyMetadata: parentPm, loanTerms });
  } else if (parentEr !== null && rentRollExtractorImproved) {
    // ★ PER-SLOT MERGE — the rent-roll extractor improved. Re-extract to get the
    //   reconciled roll (concentration prices), but carry income / value /
    //   loan-terms BYTE-IDENTICAL from the parent — ONLY the rent-roll field
    //   changes. id recomputed from the new content.
    const fresh = await build({
      slots: slots as InputSlots,
      analysisAsOfDate: doctrineEval.analysisAsOfDate,
      dealRef: analysis.name ?? args.analysisId,
      loanTerms,
    });
    // ★ NEVER-REGRESS GUARD. The rent-roll LLM is non-deterministic — a run can
    //   return FEWER tenants than the parent already has (640: parent 19 units, a
    //   fresh run 0). Only ADOPT the fresh roll when it is at least as complete as
    //   the parent's; otherwise carry the parent's frozen roll. So a bad
    //   re-extraction can never DOWNGRADE a deal's concentration data.
    //   Count via the lossy RentRollExtraction projection on the ExtractionResult
    //   (`.units`) — the typed RentRoll carries `.lines`, but the projection's
    //   unit count is the completeness signal every consumer reads.
    const parentUnits = parentEr.rentRoll?.units?.length ?? 0;
    const freshUnits = fresh.extractionResult.rentRoll?.units?.length ?? 0;
    composed = freshUnits >= parentUnits && freshUnits > 0
      ? composeFromParentCarryWithFreshRentRoll({ parentEr, parentPropertyMetadata: parentPm, fresh, loanTerms })
      : composeFromParentCarry({ parentEr, parentRentRoll, parentPropertyMetadata: parentPm, loanTerms });
  } else {
    // Genuinely-new content (or no parent extraction) → re-extract the full set.
    composed = await build({
      slots: slots as InputSlots,
      analysisAsOfDate: doctrineEval.analysisAsOfDate,
      dealRef: analysis.name ?? args.analysisId,
      loanTerms,
    });
  }

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
    narrativeStatus: child.narrativeStatus,
    narrativeDeferredReason: child.narrativeDeferredReason,
  };
}
void IngestionError;

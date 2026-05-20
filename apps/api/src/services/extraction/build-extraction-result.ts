/**
 * buildExtractionResult — composer that turns typed input slots into an
 * ExtractionResult.
 *
 * Sits alongside ingestExtractionResult (not replacing it). The future
 * POST /api/build-and-ingest route calls this, then hands the resulting
 * ExtractionResult to ingestExtractionResult. The composer itself is
 * ingest-blind: it does not import or call any ingestion code, and a
 * module-graph guardrail (mirroring test-extraction-isolation.ts) will
 * enforce that.
 *
 * Composition shape:
 *
 *   1. Fan out: for each PROVIDED slot, run its adapter. Absent slots skip
 *      the adapter call entirely (a SlotInput-was-absent decision is the
 *      caller's, not an extraction outcome). Promise.allSettled wraps the
 *      fan-out as defense-in-depth against unanticipated adapter throws —
 *      adapters absorb their internal extractor throws, but a bug at the
 *      adapter level still becomes a 'failed' slot rather than a composer
 *      crash.
 *
 *   2. Project: each adapter's `value` projects into the corresponding
 *      ExtractionResult field(s). The CF adapter's single outcome carries
 *      two fields (t12 + sellerUwOperatingStatement); the projection step
 *      splits them. sourceRefs from every slot concatenate into
 *      ExtractionResult.sourceDocuments.
 *
 *   3. Resolve rent-roll precedence: pickRentRoll() runs over the rent-roll
 *      outcomes (xlsx vs AI-from-PDF). See pick-rent-roll.ts for the
 *      truth-table. This is the ONLY policy decision the composer makes —
 *      extracted into its own pure helper, unit-tested in isolation, so the
 *      composer body stays mechanical.
 *
 *   4. Carry propertyMetadata sibling-style (Finding 2 / decision 2a):
 *      PropertyMetadata is its own contract record with its own id; it has
 *      no slot on ExtractionResult. The composer's output carries it as a
 *      separate field (null when not extracted). Downstream persistence
 *      writes through a separate insertPropertyMetadata path (Ticket F, #5).
 *
 *   5. Always compute the extractionResultId. The contract allows all
 *      sub-records to be null; an incomplete build is structurally a valid
 *      ExtractionResult with more nulls and a well-defined hash. There is
 *      no separate 'partial' shape — callers inspect report.slots to
 *      determine completeness (see slotIsAcceptable / incompleteSlots in
 *      build-report.ts).
 *
 * Source-ref ordering: the composer concatenates per-slot sourceRefs in
 * the order [cf, rentRoll, asr] for implementation simplicity. As of this
 * writing, no downstream consumer reads ExtractionResult.sourceDocuments
 * positionally or by first-of-kind — verified by grep. If a future consumer
 * needs deterministic ordering, sort the refs before assigning to
 * extractionResult.sourceDocuments using:
 *
 *   refs.sort((a, b) =>
 *     a.kind < b.kind ? -1 : a.kind > b.kind ? 1 :
 *     a.contentHash < b.contentHash ? -1 :
 *     a.contentHash > b.contentHash ? 1 : 0);
 *
 * (alphabetical by kind, lexicographic by contentHash as tiebreaker).
 *
 * Dependency injection: the composer takes a BuildExtractionResultDeps
 * parameter defaulting to DEFAULT_COMPOSER_DEPS (the real adapter
 * implementations). Tests inject stubs that return synthesized outcomes
 * so the composer's coordination logic can be exercised without re-running
 * adapter-level concerns. Production code calls the composer without
 * supplying deps.
 */

import type {
  ExtractionResult,
  ExtractionResultId,
  ISODateTime,
  LoanTermsExtraction,
  PropertyMetadata,
  SourceDocumentRef,
} from '@cre/contracts';
import { EXTRACTION_ENGINE_VERSION } from '@cre/contracts';
import { computeExtractionResultId } from '../../util/content-hash.js';
import { runCfAdapter } from './adapters/cf.adapter.js';
import { runRentRollAdapter } from './adapters/rent-roll.adapter.js';
import { runAsrAdapter } from './adapters/asr.adapter.js';
import type {
  ExtractorOutcome,
  ExtractionSlot,
  InputSlots,
} from './extractor-outcome.js';
import type { BuildReport, SlotReport } from './build-report.js';
import { pickRentRoll } from './pick-rent-roll.js';

/* --------------------------------- args ----------------------------------- */

export interface BuildExtractionResultArgs {
  readonly slots: InputSlots;
  readonly analysisAsOfDate: ISODateTime;
  readonly dealRef: string;
  /** Optional hint passed to AI extractors (currently unused by the composer
   *  itself; future iteration may thread it into runAsrAdapter's deps when
   *  the AI rent-roll fallback's propertyHint becomes a first-class arg). */
  readonly propertyHint?: string | null;
  /**
   * Optional caller-provided loan terms. When present, projects directly
   * into ExtractionResult.loanTerms. When absent (undefined or null), the
   * composer sets loanTerms: null and downstream judgment throws on the
   * null via JE_LOAN_AMOUNT_MISSING. This input mechanism closes the gap
   * documented in Ticket K (#7): no v0.1.0 adapter produces loan terms,
   * so callers must supply them via the route's `loanTerms` form field
   * (JSON-stringified) until a future extractLoanTerms adapter ships.
   *
   * The other "always-null because no producer" sub-records (pca,
   * appraisal, sellerUw, sellerUwOperatingStatement — wait, the last two
   * have producers via CF; pca + appraisal don't) don't yet have analogous
   * input mechanisms because they're not currently load-bearing for
   * judgment-engine throws.
   */
  readonly loanTerms?: LoanTermsExtraction | null;
}

/* -------------------------------- output ---------------------------------- */

/**
 * Composer output. Flat shape — no `ok: true | false` discriminator.
 * Callers inspect report.slots (or use incompleteSlots(report) from
 * build-report.ts) to determine completeness. extractionResult is always
 * a valid, content-addressed ExtractionResult; sub-records are null when
 * their adapter didn't run or didn't produce data.
 */
export interface BuildExtractionResultOutput {
  readonly extractionResult: ExtractionResult;
  readonly propertyMetadata: PropertyMetadata | null;
  readonly report: BuildReport;
}

/* --------------------------------- deps ----------------------------------- */

export interface BuildExtractionResultDeps {
  readonly runCfAdapter: typeof runCfAdapter;
  readonly runRentRollAdapter: typeof runRentRollAdapter;
  readonly runAsrAdapter: typeof runAsrAdapter;
}

export const DEFAULT_COMPOSER_DEPS: BuildExtractionResultDeps = {
  runCfAdapter,
  runRentRollAdapter,
  runAsrAdapter,
};

/* ------------------------------- internal --------------------------------- */

/**
 * Unwrap a settled adapter promise. Fulfilled values pass through;
 * rejections synthesize a 'failed' outcome with error.name='adapterThrew'
 * — this is defense-in-depth against bugs at the adapter level. Adapters
 * absorb their internal extractor throws; if an adapter itself rejects,
 * it's a bug, and the composer surfaces it as a slot failure rather than
 * crashing.
 */
function unwrapAdapterSettled<T>(
  settled: PromiseSettledResult<ExtractorOutcome<T> | null>,
): ExtractorOutcome<T> | null {
  if (settled.status === 'fulfilled') return settled.value;
  const e = settled.reason as Error | undefined;
  return {
    status: 'failed',
    sourceRefs: [],
    adapterVersion: '0.0.0',
    durationMs: 0,
    error: {
      name: 'adapterThrew',
      message: `${e?.name ?? 'Error'}: ${e?.message ?? 'adapter rejected unexpectedly'}`,
    },
  };
}

/** Reduce a slot outcome (or null = absent) to its stripped report shape. */
function toSlotReport<T>(outcome: ExtractorOutcome<T> | null): SlotReport {
  if (outcome === null) return { status: 'absent' };
  if (outcome.status === 'ok') {
    return {
      status: 'ok',
      durationMs: outcome.durationMs,
      adapterVersion: outcome.adapterVersion,
    };
  }
  if (outcome.status === 'empty') {
    return {
      status: 'empty',
      durationMs: outcome.durationMs,
      adapterVersion: outcome.adapterVersion,
      reason: outcome.reason,
    };
  }
  // 'failed'
  return {
    status: 'failed',
    durationMs: outcome.durationMs,
    adapterVersion: outcome.adapterVersion,
    error: outcome.error,
  };
}

/* ------------------------------ composer ---------------------------------- */

export async function buildExtractionResult(
  args: BuildExtractionResultArgs,
  deps: BuildExtractionResultDeps = DEFAULT_COMPOSER_DEPS,
): Promise<BuildExtractionResultOutput> {
  const startedAt = new Date().toISOString() as ISODateTime;

  /* Fan out. Absent slots resolve to null (adapter never called). Provided
     slots run their adapter and return its outcome. */
  const cfP = args.slots.sellerCfXlsx
    ? deps.runCfAdapter(args.slots.sellerCfXlsx)
    : Promise.resolve(null);
  const rrP = args.slots.rentRollXlsx
    ? deps.runRentRollAdapter(args.slots.rentRollXlsx)
    : Promise.resolve(null);
  const asrP = args.slots.asrPdf
    ? deps.runAsrAdapter(args.slots.asrPdf)
    : Promise.resolve(null);

  const [cfSettled, rrSettled, asrSettled] = await Promise.allSettled([cfP, rrP, asrP]);

  const cfOutcome = unwrapAdapterSettled(cfSettled);
  const rrOutcome = unwrapAdapterSettled(rrSettled);
  const asrOutcome = unwrapAdapterSettled(asrSettled);

  /* Per-slot reports for the BuildReport. */
  const slotReports: Record<ExtractionSlot, SlotReport> = {
    sellerCfXlsx: toSlotReport(cfOutcome),
    rentRollXlsx: toSlotReport(rrOutcome),
    asrPdf: toSlotReport(asrOutcome),
  };

  /* Project adapter outputs into ExtractionResult-shaped fields. Explicit
     null-checks instead of `??` per the orchestration discipline (no `??`
     in producer code beyond error-string defaulting in catch blocks). */
  const cfOk = cfOutcome !== null && cfOutcome.status === 'ok' ? cfOutcome.value : null;
  const t12 = cfOk === null ? null : cfOk.t12;
  const sellerUwOperatingStatement = cfOk === null ? null : cfOk.sellerUwOperatingStatement;

  const asrOk = asrOutcome !== null && asrOutcome.status === 'ok' ? asrOutcome.value : null;
  const asr = asrOk === null ? null : asrOk.asr;
  const propertyMetadata = asrOk === null ? null : asrOk.propertyMetadata;
  const asrRentRollFallback = asrOk === null ? null : asrOk.rentRollFallback;

  /* Rent-roll precedence: XLSX wins when ok-with-units; AI fallback fills
     in otherwise. Truth table in pick-rent-roll.ts. */
  const rentRoll = pickRentRoll(rrOutcome, asrRentRollFallback);

  /* Concatenate sourceRefs from each slot in [cf, rentRoll, asr] order.
     Order is incidental — see header doc comment for the sort recipe if
     a future consumer needs determinism. */
  const sourceDocuments: SourceDocumentRef[] = [];
  if (cfOutcome !== null) sourceDocuments.push(...cfOutcome.sourceRefs);
  if (rrOutcome !== null) sourceDocuments.push(...rrOutcome.sourceRefs);
  if (asrOutcome !== null) sourceDocuments.push(...asrOutcome.sourceRefs);

  /* loanTerms projection — caller-provided via args (Ticket K #7). Treat
     undefined and null as "absent" (composer projects null). When present,
     project the caller's value verbatim into extractionResult.loanTerms,
     which downstream judgment then sees as populated and proceeds without
     the JE_LOAN_AMOUNT_MISSING hard throw. */
  const loanTerms: LoanTermsExtraction | null =
    args.loanTerms === undefined || args.loanTerms === null
      ? null
      : args.loanTerms;

  /* Build the body (everything except id). Fields with no producer in the
     current spine stay null — pca, appraisal, sellerUw (summary triplet).
     Their producers land in later batches. */
  const body = {
    analysisAsOfDate: args.analysisAsOfDate,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: args.dealRef,
    rentRoll,
    t12,
    pca: null,
    appraisal: null,
    sellerUw: null,
    sellerUwOperatingStatement,
    asr,
    loanTerms,
    sourceDocuments,
  };

  const id: ExtractionResultId = computeExtractionResultId(body);
  const extractionResult: ExtractionResult = { id, ...body };

  const finishedAt = new Date().toISOString() as ISODateTime;

  const report: BuildReport = {
    startedAt,
    finishedAt,
    engineVersion: EXTRACTION_ENGINE_VERSION,
    slots: slotReports,
  };

  return { extractionResult, propertyMetadata, report };
}

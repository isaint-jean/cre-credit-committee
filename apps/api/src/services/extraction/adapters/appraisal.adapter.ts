/**
 * Appraisal adapter — sole composer call site of `extractCbreAppraisal`.
 *
 * Simpler than pca.adapter and asr.adapter:
 *   - No `parseDocument` step (extractCbreAppraisal uses unpdf internally).
 *   - No LLM. Fully deterministic regex-over-PDF-text.
 *   - No internal `runOnDocument` split (no `ParsedDocument` intermediate;
 *     tests synthesize either real or mocked extractor responses via deps).
 *
 * Status mapping:
 *   - extractCbreAppraisal threw                            → 'failed'
 *   - extractor recognized NOTHING (sentinel below)         → 'empty'
 *   - extractor returned a record with any anchor populated → 'ok'
 *     with a single SourceDocumentRef of kind 'appraisal'.
 *
 * EMPTY SENTINEL — the condition is "the extractor recognized NOTHING":
 *
 *   asIsValue === null && netRentableArea === null && yearBuilt === null
 *
 * A deal with a real `asIsValue` but null `asStabilizedValue` is 'ok' (it's
 * a stabilized deal — no second-stage value to project). A deal with NRA or
 * yearBuilt populated even if asIsValue is null still indicates the page
 * regexes are finding identity anchors; we don't fire 'empty' on that case.
 * The 3-anchor compound (value + size + vintage) must ALL be null for the
 * extractor to be declared blind.
 *
 * Adapter version is local. Same convention as PCA_ADAPTER_VERSION /
 * ASR_ADAPTER_VERSION / CF_ADAPTER_VERSION (composer's version harvester
 * stamps it into ExtractionResult.extractorVersions['appraisal']).
 */
import type {
  AppraisalExtraction,
  ContentHash,
  SourceDocumentRef,
} from '@cre/contracts';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { extractCbreAppraisal, loadAppraisalText } from '../../extract-cbre-appraisal.js';
import {
  extractCbreAppraisalLlm,
  type AppraisalLlmResult,
  type ExtractCbreAppraisalLlmDeps,
} from '../../extract-cbre-appraisal-llm.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/* 1.0 — regex-only (CBRE Sunroad template).
 * 1.1 — LLM-PRIMARY CORE FALLBACK (Tier 1). When the deterministic regex can't
 *       find the score-relevant core (asIsValue / overallCapRate / stabilized NOI
 *       / current occupancy) — i.e. any appraisal that isn't the Sunroad template
 *       (proven on Lexington Grand, which the regex read 0/66 on) — the adapter
 *       reads the WHOLE appraisal text with the LLM (cite-or-discard, subject-not-
 *       comp) and fills the missing core. Regex stays the free fast path: Sunroad
 *       hits it and the LLM never fires. Bumped to cache-bust a re-extract. */
export const APPRAISAL_ADAPTER_VERSION = '1.1';

export interface AppraisalAdapterDeps {
  readonly extractCbreAppraisal: (buffer: Buffer) => Promise<AppraisalExtraction>;
  /** ★ LLM-primary CORE fallback deps (the de-anchor path: regex missed the
   *  score core → LLM reads the whole appraisal). Production uses live Sonnet +
   *  the env credit gate; tests inject a stub LLM seam + in-memory cache.
   *  Undefined ⇒ the extractor's own defaults (real call, env gate, no cache). */
  readonly appraisalLlm?: ExtractCbreAppraisalLlmDeps;
  /** Injectable full-text loader (buffer → all pages joined). Defaults to the
   *  real unpdf load; tests inject a stub to avoid parsing a fixture PDF. */
  readonly loadAppraisalText?: (buffer: Buffer) => Promise<string>;
}

export const DEFAULT_APPRAISAL_DEPS: AppraisalAdapterDeps = {
  extractCbreAppraisal,
};

/** The score-relevant core the doctrine + memo read. When the regex leaves ANY
 *  of these null, the LLM fallback fires to fill them. */
function scoreCoreMissing(a: AppraisalExtraction): boolean {
  return (
    (a.asIsValue ?? null) === null ||
    (a.overallCapRate ?? null) === null ||
    (a.currentOccupancyPhysical ?? null) === null ||
    (a.stabilizedProForma?.netOperatingIncome ?? null) === null
  );
}

/** Merge the LLM core into the regex record — REGEX WINS where present; the LLM
 *  only fills nulls. Never overwrites a deterministically-extracted value. */
function mergeLlmIntoAppraisal(base: AppraisalExtraction, llm: AppraisalLlmResult): AppraisalExtraction {
  const sp = base.stabilizedProForma;
  return {
    ...base,
    asIsValue: base.asIsValue ?? llm.asIsValue,
    asStabilizedValue: base.asStabilizedValue ?? llm.asStabilizedValue,
    overallCapRate: base.overallCapRate ?? llm.overallCapRate,
    terminalCapRate: base.terminalCapRate ?? llm.terminalCapRate,
    currentOccupancyPhysical: base.currentOccupancyPhysical ?? llm.currentOccupancyPhysical,
    yearBuilt: base.yearBuilt ?? llm.yearBuilt,
    city: base.city ?? llm.city,
    state: base.state ?? llm.state,
    interestAppraised: base.interestAppraised ?? llm.interestAppraised,
    methodology: base.methodology ?? llm.methodology,
    // Legacy 3-field aliases mirror the primaries.
    valueConclusion: base.valueConclusion ?? llm.asIsValue,
    capRate: base.capRate ?? llm.overallCapRate,
    ...(sp ? { stabilizedProForma: { ...sp, netOperatingIncome: sp.netOperatingIncome ?? llm.stabilizedNoi } } : {}),
  };
}

/**
 * External entry point — what the composer calls.
 *
 *   1. Hash the buffer for the SourceDocumentRef.
 *   2. Run extractCbreAppraisal. The extractor never returns null at the
 *      function level (it always produces an AppraisalExtraction shell);
 *      failure modes are (a) it throws (malformed PDF → 'failed') or
 *      (b) it returns a record where every anchor field is null
 *      (non-CBRE format → 'empty').
 *   3. The 'empty' sentinel is a 3-field compound: asIsValue + NRA +
 *      yearBuilt all null. See header comment for rationale.
 */
export async function runAppraisalAdapter(
  slot: SlotInput,
  deps: AppraisalAdapterDeps = DEFAULT_APPRAISAL_DEPS,
): Promise<ExtractorOutcome<AppraisalExtraction | null>> {
  const t0 = Date.now();
  const bufferHash: ContentHash = computeBufferContentHash(slot.buffer);

  let value: AppraisalExtraction;
  try {
    value = await deps.extractCbreAppraisal(slot.buffer);
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: APPRAISAL_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'extractCbreAppraisalThrew',
        message: `${e?.name ?? 'Error'}: ${e?.message ?? 'extractCbreAppraisal failed'}`,
      },
    };
  }

  // ★ Tier 1 — LLM-primary CORE fallback. When the deterministic regex missed the
  // score-relevant core (non-Sunroad template), read the WHOLE appraisal with the
  // LLM (cite-or-discard) and fill the missing fields. Sunroad hits the regex and
  // this never fires (free fast path preserved). Fail-safe: on no-credits / error
  // the LLM returns all-null and the merge is a no-op → the regex floor stands.
  if (scoreCoreMissing(value)) {
    try {
      const loadText = deps.loadAppraisalText ?? loadAppraisalText;
      const text = await loadText(slot.buffer);
      const llm = await extractCbreAppraisalLlm(text, bufferHash, deps.appraisalLlm);
      value = mergeLlmIntoAppraisal(value, llm);
    } catch {
      // Fail-safe — any load/parse error leaves the regex result untouched.
    }
  }

  // EMPTY sentinel — 3-anchor compound. See header comment for the rationale.
  if (value.asIsValue === null && value.netRentableArea === null && value.yearBuilt === null) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: APPRAISAL_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'extractor recognized no anchor fields (asIsValue + NRA + yearBuilt all null); buffer likely a non-CBRE format',
    };
  }

  const refs: SourceDocumentRef[] = [{ kind: 'appraisal', contentHash: bufferHash }];
  return {
    status: 'ok',
    value,
    sourceRefs: refs,
    adapterVersion: APPRAISAL_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}

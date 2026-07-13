/**
 * CF adapter — sole call site of extractCashFlowFromXlsx in the composer path.
 *
 * Status mapping (mirrors the extractor's documented behavior):
 *
 *   - wb.xlsx.load throws (corrupt / not-an-xlsx buffer)               → 'failed'
 *   - all THREE column slots returned null (no period-header / label
 *     structure)                                                       → 'empty'
 *   - at least one column populated                                    → 'ok'
 *     (the other-column-null case is genuine null fidelity — the workbook
 *     simply didn't have that period; NOT an extractor failure)
 *
 * Three-slot output (locked 2026-05-31):
 *
 *   - `t12Actual`: strict T-12 / trailing-twelve column. Most CMBS-style CFs
 *     don't expose one; this slot will be null on most fixtures.
 *   - `inPlace`: In-Place / current column. The misleading `t12` slot was
 *     renamed here as part of the period-classification fix.
 *   - `sellerUwOperatingStatement`: the issuer's UW column.
 *
 * SourceDocumentRef emission:
 *
 *   - ok: one ref per POPULATED slot. All three populated → three refs with
 *     the SAME contentHash and distinct kinds ('t12_actual', 'in_place',
 *     'seller_uw'). Same physical document, three semantic extractions —
 *     contract-allowed and preserves lineage at the layer contentHash was
 *     designed for (drift detection on re-uploads).
 *   - empty / failed: zero refs. Stamping a kind we didn't actually extract
 *     would mislead future readers of ExtractionResult.sourceDocuments.
 *
 * Adapter version is local to this file (CF_ADAPTER_VERSION). Bumped 0.1.0
 * → 0.2.0 with the three-slot output (contract shape change).
 */

import type { OperatingStatementExtraction, SourceDocumentRef } from '@cre/contracts';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { extractCashFlowFromXlsx } from '../../extract-cash-flow-from-xlsx.js';
import {
  extractCashFlowFromXlsxLlm,
  type ExtractCashFlowLlmDeps,
} from '../../extract-cash-flow-from-xlsx-llm.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/** Bump when this adapter's contract with downstream changes. Bumped 0.1.0 →
 *  0.2.0 on 2026-05-31 with the three-slot output (t12 → inPlace rename +
 *  new t12Actual slot).
 *
 *  0.3.0 — DE-ANCHORED income. When the deterministic parser
 *  (extractCashFlowFromXlsx) returns null across ALL THREE slots (a
 *  Yardi/MRI GL export or any non-MS/Goldman layout it can't read), an
 *  LLM-primary FALLBACK (extractCashFlowFromXlsxLlm) reads the parsed workbook
 *  grid → a structured operating statement (EGI/OpEx/NOI + cited cells), routed
 *  into whichever period slot the LLM judged (t12/in_place/seller_uw). Fixes
 *  640/Yardi-class deals that collapsed to a rent-roll-only NOI stub. Sunroad
 *  and every CMBS-format deal still resolve via the free deterministic path (no
 *  LLM). Bumped to cache-bust a re-extract. */
export const CF_ADAPTER_VERSION = '0.3.0';

/** Single value, three ExtractionResult fields. The composer's projection step splits:
 *    value.t12Actual                  → extractionResult.t12Actual
 *    value.inPlace                    → extractionResult.inPlace
 *    value.sellerUwOperatingStatement → extractionResult.sellerUwOperatingStatement
 *  Preserves the 1:1 slot-to-outcome invariant in BuildReport. */
export interface CfAdapterValue {
  readonly t12Actual: OperatingStatementExtraction | null;
  readonly inPlace: OperatingStatementExtraction | null;
  readonly sellerUwOperatingStatement: OperatingStatementExtraction | null;
}

export interface CfAdapterDeps {
  /** ★ LLM-primary CF FALLBACK deps. Passed through to extractCashFlowFromXlsxLlm
   *  ONLY when the deterministic parser returns null across all three slots.
   *  Production uses live Sonnet + the env credit gate; tests inject a stub LLM
   *  seam + in-memory cache to exercise the logic deterministically. Undefined ⇒
   *  the extractor's own defaults (real call, env gate, no cache). */
  readonly cfLlm?: ExtractCashFlowLlmDeps;
}

export async function runCfAdapter(
  slot: SlotInput,
  deps: CfAdapterDeps = {},
): Promise<ExtractorOutcome<CfAdapterValue>> {
  const t0 = Date.now();

  let result: {
    t12Actual: OperatingStatementExtraction | null;
    inPlace: OperatingStatementExtraction | null;
    sellerUwOperatingStatement: OperatingStatementExtraction | null;
  };
  try {
    result = await extractCashFlowFromXlsx(slot.buffer);
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: CF_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: e?.name ?? 'CfExtractError',
        message: e?.message ?? 'CF extraction failed',
      },
    };
  }

  let hasT12Actual = result.t12Actual !== null;
  let hasInPlace = result.inPlace !== null;
  let hasUw = result.sellerUwOperatingStatement !== null;
  let llmWarnings: readonly string[] = [];

  const bufferHash = computeBufferContentHash(slot.buffer);

  // v0.3.0 — DE-ANCHOR. When the deterministic parser read NOTHING (all three
  // slots null), the workbook is a layout it can't parse (Yardi/MRI GL export,
  // etc.). Fall back to the LLM-primary reader over the parsed grid. The LLM
  // path is credit-gated + fail-safe: no credits / error → all-null → we stay
  // 'empty' (today's honest floor). CMBS-format deals never reach here (they
  // populated at least one slot above), so the free path is fully preserved.
  if (!hasT12Actual && !hasInPlace && !hasUw) {
    const llm = await extractCashFlowFromXlsxLlm(slot.buffer, bufferHash, deps.cfLlm);
    if (llm.statement !== null && llm.periodKind !== null) {
      result = { ...result, [llm.periodKind]: llm.statement };
      hasT12Actual = result.t12Actual !== null;
      hasInPlace = result.inPlace !== null;
      hasUw = result.sellerUwOperatingStatement !== null;
      llmWarnings = llm.warnings;
    }
  }

  if (!hasT12Actual && !hasInPlace && !hasUw) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: CF_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'no period-header / label-column structure detected in workbook (deterministic + LLM fallback)',
    };
  }
  // Surface any LLM-fallback data-quality warning (e.g. EGI−OpEx ≠ cited NOI)
  // for debug visibility. The CF value shape carries no warnings field; the
  // load-bearing divergence signal is the ASR-NOI cross-check downstream.
  for (const w of llmWarnings) {
    // eslint-disable-next-line no-console -- TODO(observability): typed log event
    console.warn(`[cf.adapter] LLM fallback: ${w} TODO(observability)`);
  }

  const refs: SourceDocumentRef[] = [];
  if (hasT12Actual) refs.push({ kind: 't12_actual', contentHash: bufferHash });
  if (hasInPlace) refs.push({ kind: 'in_place', contentHash: bufferHash });
  if (hasUw) refs.push({ kind: 'seller_uw', contentHash: bufferHash });

  return {
    status: 'ok',
    value: {
      t12Actual: result.t12Actual,
      inPlace: result.inPlace,
      sellerUwOperatingStatement: result.sellerUwOperatingStatement,
    },
    sourceRefs: refs,
    adapterVersion: CF_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}

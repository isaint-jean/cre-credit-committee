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
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/** Bump when this adapter's contract with downstream changes. Bumped 0.1.0 →
 *  0.2.0 on 2026-05-31 with the three-slot output (t12 → inPlace rename +
 *  new t12Actual slot). */
export const CF_ADAPTER_VERSION = '0.2.0';

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

export async function runCfAdapter(slot: SlotInput): Promise<ExtractorOutcome<CfAdapterValue>> {
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

  const hasT12Actual = result.t12Actual !== null;
  const hasInPlace = result.inPlace !== null;
  const hasUw = result.sellerUwOperatingStatement !== null;

  if (!hasT12Actual && !hasInPlace && !hasUw) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: CF_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'no period-header / label-column structure detected in workbook',
    };
  }

  const bufferHash = computeBufferContentHash(slot.buffer);
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

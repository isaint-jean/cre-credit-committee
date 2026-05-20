/**
 * CF adapter — sole call site of extractCashFlowFromXlsx in the composer path.
 *
 * Status mapping (mirrors the extractor's documented behavior at
 * extract-cash-flow-from-xlsx.ts:279-329):
 *
 *   - wb.xlsx.load throws (corrupt / not-an-xlsx buffer)               → 'failed'
 *   - both columns returned null (no period-header / label structure)  → 'empty'
 *   - at least one column populated                                    → 'ok'
 *     (the other-column-null case is genuine null fidelity — the workbook
 *     simply didn't have that period; NOT an extractor failure)
 *
 * SourceDocumentRef emission:
 *
 *   - ok: one ref per POPULATED kind. Both columns populated → two refs with the
 *     SAME contentHash and distinct kinds ('t12' and 'seller_uw'). This is
 *     dual-kind emission: same physical document, two semantic extractions —
 *     contract-allowed and preserves lineage at the layer contentHash was
 *     designed for (drift detection on re-uploads).
 *   - empty / failed: zero refs. Stamping a kind we didn't actually extract would
 *     mislead future readers of ExtractionResult.sourceDocuments.
 *
 * Adapter version is local to this file (CF_ADAPTER_VERSION). Ticket D will harvest
 * per-extractor versions into a new ExtractionResult field; until then the composer
 * projects only EXTRACTION_ENGINE_VERSION into the result.
 */

import type { OperatingStatementExtraction, SourceDocumentRef } from '@cre/contracts';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { extractCashFlowFromXlsx } from '../../extract-cash-flow-from-xlsx.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/** Bump when this adapter's contract with downstream changes. Post-Ticket-D this
 *  becomes the per-extractor version stamped into ExtractionResult.extractorVersions['cf']. */
export const CF_ADAPTER_VERSION = '0.1.0';

/** Single value, two ExtractionResult fields. The composer's projection step splits:
 *    value.t12                        → extractionResult.t12
 *    value.sellerUwOperatingStatement → extractionResult.sellerUwOperatingStatement
 *  Preserves the 1:1 slot-to-outcome invariant in BuildReport. */
export interface CfAdapterValue {
  readonly t12: OperatingStatementExtraction | null;
  readonly sellerUwOperatingStatement: OperatingStatementExtraction | null;
}

export async function runCfAdapter(slot: SlotInput): Promise<ExtractorOutcome<CfAdapterValue>> {
  const t0 = Date.now();

  let result: { t12: OperatingStatementExtraction | null; sellerUwOperatingStatement: OperatingStatementExtraction | null };
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

  const hasT12 = result.t12 !== null;
  const hasUw = result.sellerUwOperatingStatement !== null;

  if (!hasT12 && !hasUw) {
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
  if (hasT12) refs.push({ kind: 't12', contentHash: bufferHash });
  if (hasUw) refs.push({ kind: 'seller_uw', contentHash: bufferHash });

  return {
    status: 'ok',
    value: {
      t12: result.t12,
      sellerUwOperatingStatement: result.sellerUwOperatingStatement,
    },
    sourceRefs: refs,
    adapterVersion: CF_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}

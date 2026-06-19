/**
 * NOI-basis disclosure resolver (Option C).
 *
 * The memo + workbook surface a small callout when the workbook NOI
 * (judgment basis) and the verdict NOI (contracted basis) diverge on
 * lease-up deals. Both surfaces read from the same source of truth:
 *
 *   1. PREFERRED — pin-faithful, from the v1.1 render snapshot's `noiBasis`.
 *      Numbers were captured at eval-write time under the deal's pinned
 *      doctrine.
 *   2. FALLBACK — deterministic recompute against the persisted bundle.
 *      Mirrors the lease-up detection + contracted-basis pipeline the
 *      live-write / re-narrate / memo-renderer use. Pure; no LLM, no
 *      randomness.
 *
 * Honest-blank discipline (the gate the brief locks down):
 *   - `contractedNoi === null` → predicate didn't fire → STABILIZED deal →
 *     callout is OMITTED (`shouldRender === false`). Stabilized memos +
 *     workbooks render byte-identical to today's.
 *   - `contractedNoi !== null` AND differs from judgment → callout RENDERS.
 *   - `contractedNoi !== null` AND equals judgment → callout is OMITTED
 *     (no divergence to disclose). Defensive even though this case is
 *     vanishingly rare.
 */

import type { Analysis } from '@cre/shared';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import type {
  AdjustedInputs,
  AssetProfile,
  DoctrineEvaluationId,
  ExtractionResult,
  RentRoll,
  RevisionId,
  SnapshotNoiBasis,
} from '@cre/contracts';
import { detectLeaseUp } from '../doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from './contracted-basis.js';
import { loadRenderSnapshot } from './render-memo/snapshot-readers.js';
import { NOI_BASIS_DIVERGENCE_REASON } from './evaluate-and-narrate.js';

/**
 * Disclosure source — pin-faithful when read from snapshot, deterministic
 * recompute otherwise. Surfaced for the memo footer (banner already shows
 * the broader render source; this is the NOI-basis-specific seam).
 */
export type NoiBasisSource = 'snapshot' | 'recompute';

export interface NoiBasisDisclosure {
  /**
   * `true` when the callout should render — predicate fired AND there's a
   * non-zero divergence (judgmentNoi !== contractedNoi within $1).
   */
  readonly shouldRender: boolean;
  readonly judgmentNoi: number | null;
  readonly contractedNoi: number | null;
  /** contracted − judgment, in dollars. `null` when either side is null. */
  readonly divergence: number | null;
  readonly divergenceReason: string;
  readonly source: NoiBasisSource;
}

/**
 * Resolve NOI-basis facts for an analysis. Snapshot read first (v1.1+); on
 * miss / version-mismatch, deterministic recompute against the persisted
 * bundle. Returns the disclosure shape ready for the memo + workbook
 * callouts.
 *
 * Pure of writes. Reads only.
 */
export function resolveNoiBasis(
  analysis: Analysis,
  store: RecordGraphStore,
): NoiBasisDisclosure {
  const link = analysis.graphRevisionId;
  if (!link) return blank('recompute');
  const envelope = store.getRevisionEnvelope(link as RevisionId);
  if (!envelope) return blank('recompute');
  const adjustedInputs = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (!adjustedInputs) return blank('recompute');
  const judgmentNoi = (adjustedInputs.metrics as { noi?: number | null }).noi ?? null;

  // 1. PREFERRED — snapshot path.
  const snapshot = loadRenderSnapshot(envelope.doctrineEvaluationId, store);
  if (snapshot !== null && snapshot.noiBasis !== undefined) {
    return shape(snapshot.noiBasis, 'snapshot');
  }

  // 2. FALLBACK — deterministic recompute. Mirrors the pipeline in
  // evaluate-from-adjusted-inputs.ts:263-272 and the memo renderer.
  const doctrine = store.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (!doctrine) return shape({ judgmentNoi, contractedNoi: null, divergenceReason: NOI_BASIS_DIVERGENCE_REASON }, 'recompute');
  const extraction = store.getExtractionResult(doctrine.extractionResultId);
  const assetProfile = store.getAssetProfile(doctrine.assetProfileId);
  if (!extraction || !assetProfile) return shape({ judgmentNoi, contractedNoi: null, divergenceReason: NOI_BASIS_DIVERGENCE_REASON }, 'recompute');
  const rentRoll = doctrine.rentRollId ? store.getRentRoll(doctrine.rentRollId) : null;

  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  return shape(
    {
      judgmentNoi,
      contractedNoi: contractedTrace.contractedNoi,
      divergenceReason: NOI_BASIS_DIVERGENCE_REASON,
    },
    'recompute',
  );
}

/**
 * Bundle-aware variant — for callers (e.g., materializeRenderedAnalysisWithMeta)
 * that already have the hydrated bundle records in hand and don't want to
 * re-walk the analysis → envelope → records chain. Prefers the snapshot's
 * `noiBasis` when v1.1+; falls back to deterministic recompute otherwise.
 */
export function resolveNoiBasisFromBundle(
  doctrineEvaluationId: DoctrineEvaluationId,
  adjustedInputs: AdjustedInputs,
  extraction: ExtractionResult,
  assetProfile: AssetProfile,
  rentRoll: RentRoll | null,
  store: RecordGraphStore,
): NoiBasisDisclosure {
  const judgmentNoi = (adjustedInputs.metrics as { noi?: number | null }).noi ?? null;
  const snapshot = loadRenderSnapshot(doctrineEvaluationId, store);
  if (snapshot !== null && snapshot.noiBasis !== undefined) {
    return shape(snapshot.noiBasis, 'snapshot');
  }
  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  return shape(
    {
      judgmentNoi,
      contractedNoi: contractedTrace.contractedNoi,
      divergenceReason: NOI_BASIS_DIVERGENCE_REASON,
    },
    'recompute',
  );
}

/**
 * Format scalars to USD with rounding (memo + workbook share the same format).
 * Single source of truth so the two surfaces never disagree on punctuation /
 * sign / units.
 */
export function formatNoiBasisCallout(d: NoiBasisDisclosure): string {
  if (!d.shouldRender) return '';
  const judgment = d.judgmentNoi !== null ? `$${Math.round(d.judgmentNoi).toLocaleString()}` : '—';
  const contracted = d.contractedNoi !== null ? `$${Math.round(d.contractedNoi).toLocaleString()}` : '—';
  const delta = d.divergence !== null ? `$${Math.round(d.divergence).toLocaleString()}` : '—';
  const sign = (d.divergence ?? 0) >= 0 ? '+' : '';
  return `NOI basis: workbook (judgment) ${judgment}; verdict (contracted) ${contracted}; Δ ${sign}${delta}. ${d.divergenceReason}`;
}

function blank(source: NoiBasisSource): NoiBasisDisclosure {
  return {
    shouldRender: false,
    judgmentNoi: null,
    contractedNoi: null,
    divergence: null,
    divergenceReason: NOI_BASIS_DIVERGENCE_REASON,
    source,
  };
}

function shape(
  facts: { readonly judgmentNoi: number | null; readonly contractedNoi: number | null; readonly divergenceReason: string },
  source: NoiBasisSource,
): NoiBasisDisclosure {
  const { judgmentNoi, contractedNoi } = facts;
  const divergence = judgmentNoi !== null && contractedNoi !== null
    ? contractedNoi - judgmentNoi
    : null;
  // Gate: render only when predicate fired (contractedNoi non-null) AND a real
  // divergence exists (> $1 absolute). Stabilized deals → contractedNoi=null
  // → shouldRender=false → memo + workbook unchanged from pre-Option-C.
  const shouldRender =
    contractedNoi !== null &&
    judgmentNoi !== null &&
    divergence !== null &&
    Math.abs(divergence) > 1;
  return {
    shouldRender,
    judgmentNoi,
    contractedNoi,
    divergence,
    divergenceReason: facts.divergenceReason,
    source,
  };
}

/**
 * Sibling for cases where the renderer already has a snapshot's noiBasis in
 * hand (e.g., memo renderer at the snapshot-path branch) — saves the second
 * snapshot fetch. Same gating logic.
 */
export function shapeNoiBasisFromSnapshot(
  noiBasis: SnapshotNoiBasis | undefined,
  judgmentNoiFallback: number | null,
): NoiBasisDisclosure {
  if (noiBasis === undefined) {
    return blank('snapshot');
  }
  return shape(
    {
      judgmentNoi: noiBasis.judgmentNoi ?? judgmentNoiFallback,
      contractedNoi: noiBasis.contractedNoi,
      divergenceReason: noiBasis.divergenceReason,
    },
    'snapshot',
  );
}

/**
 * underwrite-readiness — Chunk 1 of the continuous-tape engine: the completeness
 * GATE that decides whether a loan is READY to auto-underwrite.
 *
 * ★ PRE-EXTRACTION, pure DOC-PRESENCE. A loan is READY when the minimum doc set to
 *   produce a meaningful verdict is PRESENT in the data-room manifest (data_room_doc)
 *   — NO extraction, NO LLM, NO K-based coverage. This is deliberately distinct from
 *   pool-coverage's K-gated `CoverageState` (which requires extraction to have ALREADY
 *   run): readiness is the TRIGGER gate; coverage is the post-underwrite display.
 *
 * REQUIRED SET (Isabelle's decision — the minimum to underwrite):
 *   - asr    : the Asset Summary Report (deal summary → valuation / NOI / S&U).
 *   - income : a cash-flow / operating statement — the `cf` composite (T-12 +
 *              in-place) OR a standalone `t12`. Either satisfies "income present".
 *
 * NOT required for the trigger (they flag-as-missing INSIDE a ready underwrite via
 * the honest-floor JE_*_MISSING codes, but never block the trigger):
 *   - rent_roll (satisfiable from the ASR's rent table), pca, appraisal.
 *
 * Readiness gates the TRIGGER only. A ready loan still emits JE_APPRAISAL_MISSING /
 * JE_PCA_MISSING / JE_RENT_ROLL_MISSING for whatever's absent — the engine's honest
 * floor is unchanged.
 */

import { listPoolDocs as defaultListPoolDocs } from '../data-room-store.service.js';

/** The docType ids that satisfy each required readiness slot (presence in data_room_doc). */
export const READINESS_REQUIRED_SLOTS: Readonly<Record<'asr' | 'income', readonly string[]>> = {
  asr: ['asr'],
  // `cf` is the primary income doc (composite → in_place + t12); a standalone `t12`
  // also satisfies "income present". Either counts.
  income: ['cf', 't12'],
};

/** Human labels for the required slots — surfaced in "needs X to underwrite" copy. */
const REQUIRED_LABEL: Readonly<Record<'asr' | 'income', string>> = {
  asr: 'Asset Summary Report (ASR)',
  income: 'Cash-flow / operating statement',
};

export interface ReadinessResult {
  /** True iff every required slot has at least one doc present for the loan. */
  readonly ready: boolean;
  /** Human labels of the required slots still ABSENT (empty when ready). */
  readonly missing: readonly string[];
}

export interface ReadinessDeps {
  readonly listPoolDocs?: typeof defaultListPoolDocs;
}

/**
 * Evaluate a loan's underwrite readiness by pure doc-presence against the pool
 * manifest. No extraction / LLM. Returns which required slots are still missing so
 * the UI can say exactly what's needed.
 */
export function evaluateUnderwriteReadiness(
  poolId: string,
  loanInPoolId: string,
  deps: ReadinessDeps = {},
): ReadinessResult {
  const listPoolDocs = deps.listPoolDocs ?? defaultListPoolDocs;
  const docs = listPoolDocs(poolId).filter((d) => d.loanInPoolId === loanInPoolId);
  const hasAny = (slotIds: readonly string[]): boolean => docs.some((d) => slotIds.includes(d.docType));

  const missing: string[] = [];
  for (const key of ['asr', 'income'] as const) {
    if (!hasAny(READINESS_REQUIRED_SLOTS[key])) missing.push(REQUIRED_LABEL[key]);
  }
  return { ready: missing.length === 0, missing };
}

/** Boolean convenience — the loan has ASR + income present. */
export function isReadyToUnderwrite(poolId: string, loanInPoolId: string, deps: ReadinessDeps = {}): boolean {
  return evaluateUnderwriteReadiness(poolId, loanInPoolId, deps).ready;
}

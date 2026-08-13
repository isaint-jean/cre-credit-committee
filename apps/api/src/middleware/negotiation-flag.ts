/**
 * negotiation-flag — the route guard that shelves the bank↔buyer NEGOTIATION LOOP.
 *
 * When NEGOTIATION_LOOP_ENABLED is not 'true' (the DEFAULT), the negotiation-only
 * routes read as ABSENT (404): buyer-diff (display/decisions/export), overlay
 * lever-agree/override anchors, and overlay comment threads. The route CODE stays
 * intact — only gated — so flipping the flag to 'true' restores everything.
 *
 * ★ NOT gated by this (stay live regardless): the CrossCheckResult producer
 *   (buildBuyerDiffCrossCheck, in the mint), disposition/close/lifecycle, the
 *   committee-action LOG route, and general /:id/comments annotation.
 *
 * Reads process.env LIVE (mirrors the deal-access flag idiom) so proofs/tests can
 * toggle it per-process without re-importing the cached `env` snapshot.
 */
import type { Response } from 'express';

/** Live read of the shelve flag. Default OFF (loop shelved). */
export function negotiationLoopEnabled(): boolean {
  return process.env.NEGOTIATION_LOOP_ENABLED === 'true';
}

/**
 * Route guard: returns true when the request should PROCEED (loop enabled). When
 * the loop is shelved, sends 404 (the negotiation route reads as absent) and
 * returns false — the handler must `return` immediately.
 */
export function requireNegotiationLoop(res: Response): boolean {
  if (negotiationLoopEnabled()) return true;
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'The bank↔buyer negotiation loop is shelved (NEGOTIATION_LOOP_ENABLED is off).',
  });
  return false;
}

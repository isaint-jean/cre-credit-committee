/**
 * Client-visible feature flags. Read from NEXT_PUBLIC_* env at build/runtime.
 */

/**
 * Bank↔buyer NEGOTIATION LOOP — shelved by default. When 'true' the negotiation
 * surfaces render (NegotiationSurface + BuyerDiffPanel); when off (the default),
 * they are hidden and the analysis page falls back to its workspace/score-rail
 * primary. Mirror of the api's NEGOTIATION_LOOP_ENABLED — flip BOTH to 'true' to
 * fully restore the loop. The CrossCheckResult producer, disposition/close,
 * committee-action log, and general comments are NOT gated by this.
 */
export const negotiationLoopEnabled = process.env.NEXT_PUBLIC_NEGOTIATION_LOOP_ENABLED === 'true';

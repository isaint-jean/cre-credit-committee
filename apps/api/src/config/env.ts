import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '../../.env') });

export const env = {
  port: parseInt(process.env.PORT || '3001', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripePriceId: process.env.STRIPE_PRICE_ID || '',
  jwtSecret: process.env.JWT_SECRET || 'cre-credit-committee-secret-change-me',
  /**
   * External DD at mint (v1.2 snapshot §4/§6). Deployment feature flag —
   * default OFF. When 'true', the production mint routes run the live external-
   * DD fetch→guard chain at mint and freeze it into the render snapshot. OFF by
   * default so the test suite (which loads this same .env) never fires live web
   * searches at mint; ops opt in with EXTERNAL_DD_AT_MINT=true. Scripts/tests
   * that exercise DD set the per-call `enabled` flag directly and bypass this.
   */
  externalDdAtMint: process.env.EXTERNAL_DD_AT_MINT === 'true',
  /**
   * Chunk 3b — deal-access enforcement (dark-ship flag). Default OFF: the whole
   * enforcement sweep (middleware/deal-access.ts) is a NO-OP until this is 'true',
   * so shipping 3b changes nothing live until it's flipped (after the deployed-DB
   * backfill). The middleware reads process.env live for per-process/per-test
   * togglability; this entry documents the default.
   */
  dealAccessEnforcement: process.env.DEAL_ACCESS_ENFORCEMENT === 'true',
  /**
   * Shelve the bank↔buyer NEGOTIATION LOOP (dark-ship flag). Default OFF: the
   * negotiation-framed surfaces (NegotiationSurface + BuyerDiffPanel and their
   * negotiation-only routes — buyer-diff, overlay lever-agree/override, overlay
   * comment threads) are hidden/disabled until this is 'true'. The
   * CrossCheckResult PRODUCER, disposition/close/lifecycle, the committee-action
   * LOG, and general commenting are NOT gated by this — they stay live. Flip to
   * 'true' for full recovery, nothing deleted. The route guard
   * (middleware/negotiation-flag.ts) reads process.env live for per-process/per-
   * test togglability; this entry documents the default.
   */
  negotiationLoopEnabled: process.env.NEGOTIATION_LOOP_ENABLED === 'true',
};

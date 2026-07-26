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
};

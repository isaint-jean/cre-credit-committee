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
};

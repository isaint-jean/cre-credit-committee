/**
 * Runs the doctrine boot check standalone (without starting the api).
 *
 *   npm run check:doctrine
 *
 * Exits 0 on success, 1 on any failure with the failure code + message.
 */

import { performDoctrineBootCheck, DoctrineBootCheckError } from '../util/doctrine-boot-check.js';

try {
  performDoctrineBootCheck();
  console.log('doctrine boot check: ok');
  process.exit(0);
} catch (err) {
  if (err instanceof DoctrineBootCheckError) {
    console.error(`doctrine boot check FAILED: ${err.message}`);
  } else {
    console.error('doctrine boot check FAILED with unexpected error:', err);
  }
  process.exit(1);
}

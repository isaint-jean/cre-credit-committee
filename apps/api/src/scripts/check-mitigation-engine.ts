/**
 * Standalone runner for the mitigation-engine boot check (no api startup needed).
 *
 *   npm run check:mitigation-engine
 *
 * Exits 0 on success, 1 on any failure.
 */

import {
  performMitigationEngineBootCheck,
  MitigationEngineBootCheckError,
} from '../util/mitigation-engine-boot-check.js';

try {
  performMitigationEngineBootCheck();
  console.log('mitigation-engine boot check: ok');
  process.exit(0);
} catch (err) {
  if (err instanceof MitigationEngineBootCheckError) {
    console.error(`mitigation-engine boot check FAILED: ${err.message}`);
  } else {
    console.error('mitigation-engine boot check FAILED with unexpected error:', err);
  }
  process.exit(1);
}

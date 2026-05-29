/**
 * Standalone runner for the narrative-engine boot check (no api startup needed).
 *
 *   npm run check:narrative-engine
 *
 * Exits 0 on success, 1 on any failure.
 */

import {
  performNarrativeEngineBootCheck,
  NarrativeEngineBootCheckError,
} from '../util/narrative-engine-boot-check.js';

try {
  performNarrativeEngineBootCheck();
  console.log('narrative-engine boot check: ok');
  process.exit(0);
} catch (err) {
  if (err instanceof NarrativeEngineBootCheckError) {
    console.error(`narrative-engine boot check FAILED: ${err.message}`);
  } else {
    console.error('narrative-engine boot check FAILED with unexpected error:', err);
  }
  process.exit(1);
}

/**
 * Standalone runner for the judgment-engine boot check (no api startup needed).
 *
 *   npm run check:judgment-engine
 *
 * Exits 0 on success, 1 on any failure.
 */

import {
  performJudgmentEngineBootCheck,
  JudgmentEngineBootCheckError,
} from '../util/judgment-engine-boot-check.js';

try {
  performJudgmentEngineBootCheck();
  console.log('judgment-engine boot check: ok');
  process.exit(0);
} catch (err) {
  if (err instanceof JudgmentEngineBootCheckError) {
    console.error(`judgment-engine boot check FAILED: ${err.message}`);
  } else {
    console.error('judgment-engine boot check FAILED with unexpected error:', err);
  }
  process.exit(1);
}

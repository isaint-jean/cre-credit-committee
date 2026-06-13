/**
 * Standalone runner for the committee-memo format boot check (no api
 * startup needed).
 *
 *   npm run check:committee-memo
 *
 * Exits 0 on success, 1 on any failure.
 */

import {
  performCommitteeMemoBootCheck,
  CommitteeMemoBootCheckError,
} from '../util/committee-memo-boot-check.js';

try {
  performCommitteeMemoBootCheck();
  console.log('committee-memo boot check: ok');
  process.exit(0);
} catch (err) {
  if (err instanceof CommitteeMemoBootCheckError) {
    console.error(`committee-memo boot check FAILED: ${err.message}`);
  } else {
    console.error('committee-memo boot check FAILED with unexpected error:', err);
  }
  process.exit(1);
}

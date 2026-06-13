/**
 * Prints the canonical hash of the current frozen committee-memo format.
 *
 * Run when bumping `COMMITTEE_MEMO_VERSION`: copy the printed hash and
 * append to `COMMITTEE_MEMO_MANIFEST` in
 * @cre/contracts/committee-memo-manifest.ts.
 *
 *   npm run committee-memo:print-hash
 */

import { COMMITTEE_MEMO_VERSION } from '@cre/contracts';
import { computeCurrentCommitteeMemoHash } from '../util/committee-memo-boot-check.js';

const hash = computeCurrentCommitteeMemoHash();
console.log(`COMMITTEE_MEMO_VERSION    = '${COMMITTEE_MEMO_VERSION}'`);
console.log(`hash                      = ${hash}`);
console.log('');
console.log('To register: append to COMMITTEE_MEMO_MANIFEST in @cre/contracts/committee-memo-manifest.ts:');
console.log(`  '${COMMITTEE_MEMO_VERSION}': '${hash}' as ContentHash,`);

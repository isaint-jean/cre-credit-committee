/**
 * Prints the canonical hash of the current frozen judgment-engine state.
 *
 * Run when bumping `JUDGMENT_ENGINE_VERSION`: copy the printed hash and append to
 * `JUDGMENT_ENGINE_MANIFEST` in @cre/contracts/judgment-engine-manifest.ts.
 *
 *   npm run judgment-engine:print-hash
 */

import { JUDGMENT_ENGINE_VERSION } from '@cre/contracts';
import { computeCurrentJudgmentEngineHash } from '../util/judgment-engine-boot-check.js';

const hash = computeCurrentJudgmentEngineHash();
console.log(`JUDGMENT_ENGINE_VERSION = '${JUDGMENT_ENGINE_VERSION}'`);
console.log(`hash                    = ${hash}`);
console.log('');
console.log('To register: append to JUDGMENT_ENGINE_MANIFEST in @cre/contracts/judgment-engine-manifest.ts:');
console.log(`  '${JUDGMENT_ENGINE_VERSION}': '${hash}' as ContentHash,`);

/**
 * Prints the canonical hash of the current frozen mitigation-engine state.
 *
 * Run when bumping `MITIGATION_ENGINE_VERSION`: copy the printed hash and
 * append to `MITIGATION_ENGINE_MANIFEST` in
 * @cre/contracts/mitigation-engine-manifest.ts.
 *
 *   npm run mitigation-engine:print-hash
 */

import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import { computeCurrentMitigationEngineHash } from '../util/mitigation-engine-boot-check.js';

const hash = computeCurrentMitigationEngineHash();
console.log(`MITIGATION_ENGINE_VERSION = '${MITIGATION_ENGINE_VERSION}'`);
console.log(`hash                      = ${hash}`);
console.log('');
console.log('To register: append to MITIGATION_ENGINE_MANIFEST in @cre/contracts/mitigation-engine-manifest.ts:');
console.log(`  '${MITIGATION_ENGINE_VERSION}': '${hash}' as ContentHash,`);

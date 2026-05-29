/**
 * Prints the canonical hash of the current frozen narrative-engine state.
 *
 * Run when bumping `NARRATIVE_ENGINE_VERSION` or shipping the initial
 * `'1.0'` registration: copy the printed hash and append to
 * `NARRATIVE_ENGINE_MANIFEST` in @cre/contracts/narrative-engine-manifest.ts.
 *
 *   npm run narrative-engine:print-hash
 */

import { NARRATIVE_ENGINE_VERSION } from '@cre/contracts';
import { computeCurrentNarrativeEngineHash } from '../util/narrative-engine-boot-check.js';

const hash = computeCurrentNarrativeEngineHash();
console.log(`NARRATIVE_ENGINE_VERSION = '${NARRATIVE_ENGINE_VERSION}'`);
console.log(`hash                     = ${hash}`);
console.log('');
console.log('To register: append to NARRATIVE_ENGINE_MANIFEST in @cre/contracts/narrative-engine-manifest.ts:');
console.log(`  '${NARRATIVE_ENGINE_VERSION}': '${hash}' as ContentHash,`);

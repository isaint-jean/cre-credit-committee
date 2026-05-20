/**
 * Prints the canonical hash of the current frozen doctrine state.
 *
 * Run when bumping `DOCTRINE_VERSION`: copy the printed hash and append it to
 * `DOCTRINE_MANIFEST` in @cre/contracts/doctrine/manifest.ts.
 *
 *   npm run doctrine:print-hash
 */

import { DOCTRINE_VERSION } from '@cre/contracts';
import { computeCurrentDoctrineHash } from '../util/doctrine-boot-check.js';

const hash = computeCurrentDoctrineHash();
console.log(`DOCTRINE_VERSION = '${DOCTRINE_VERSION}'`);
console.log(`hash             = ${hash}`);
console.log('');
console.log('To register: append to DOCTRINE_MANIFEST in @cre/contracts/doctrine/manifest.ts:');
console.log(`  '${DOCTRINE_VERSION}': '${hash}' as ContentHash,`);

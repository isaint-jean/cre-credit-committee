/**
 * Boot-time invariant assertions for the mitigation engine.
 *
 * Mirrors `judgment-engine-boot-check.ts`. One check: HASH_DRIFT — recomputing
 * the canonical hash of the frozen mitigation-engine state matches the
 * manifest entry for `MITIGATION_ENGINE_VERSION`. Throws
 * `MitigationEngineBootCheckError` on any failure; caller (api/index.ts)
 * propagates so the process exits non-zero before the HTTP listener.
 */

import {
  MITIGATION_ENGINE_MANIFEST,
  MITIGATION_ENGINE_VERSION,
} from '@cre/contracts';
import { buildMitigationEngineHashSnapshot } from '../services/mitigation/produce-mitigations.js';
import { computeContentHash } from './content-hash.js';

export class MitigationEngineBootCheckError extends Error {
  override readonly name = 'MitigationEngineBootCheckError';
  constructor(
    public readonly code:
      | 'MITIGATION_ENGINE_MANIFEST_MISSING_VERSION'
      | 'MITIGATION_ENGINE_HASH_DRIFT',
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export function computeCurrentMitigationEngineHash(): string {
  return computeContentHash(buildMitigationEngineHashSnapshot());
}

export function performMitigationEngineBootCheck(): void {
  const expectedHash = MITIGATION_ENGINE_MANIFEST[MITIGATION_ENGINE_VERSION];
  if (!expectedHash || expectedHash === '__MITIGATION_ENGINE_V1_HASH__') {
    throw new MitigationEngineBootCheckError(
      'MITIGATION_ENGINE_MANIFEST_MISSING_VERSION',
      `no manifest entry for MITIGATION_ENGINE_VERSION='${MITIGATION_ENGINE_VERSION}'. Run \`npm run mitigation-engine:print-hash\` and append the result to MITIGATION_ENGINE_MANIFEST.`,
    );
  }
  const currentHash = computeCurrentMitigationEngineHash();
  if (currentHash !== expectedHash) {
    throw new MitigationEngineBootCheckError(
      'MITIGATION_ENGINE_HASH_DRIFT',
      `mitigation-engine state for version '${MITIGATION_ENGINE_VERSION}' hashes to ${currentHash}, ` +
        `manifest expects ${expectedHash}. Either revert the change OR bump MITIGATION_ENGINE_VERSION ` +
        `and append a new manifest entry.`,
    );
  }
}

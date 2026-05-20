/**
 * Boot-time invariant assertions for the judgment-engine rule registry.
 *
 * Two checks, both fail-fast:
 *   1. PENALTY_KEYS_VALID — every key in `JE_MISSING_DOC_PENALTIES` and `JE_DISTRUST_PENALTIES`
 *      is a real `JudgmentEngineRuleId` (catches rename drift; type system enforces but `as`
 *      casts could bypass).
 *   2. HASH_DRIFT — recomputing the canonical hash of the frozen judgment-engine state matches
 *      the manifest entry for `JUDGMENT_ENGINE_VERSION`.
 *
 * Mirrors `doctrine-boot-check.ts`. Throws `JudgmentEngineBootCheckError` on any failure;
 * caller (api/index.ts) propagates so the process exits non-zero before the HTTP listener.
 */

import {
  JE_DISTRUST_PENALTIES,
  JE_MISSING_DOC_PENALTIES,
  JUDGMENT_ENGINE_MANIFEST,
  JUDGMENT_ENGINE_VERSION,
  JudgmentEngineRules,
} from '@cre/contracts';
import { computeContentHash } from './content-hash.js';

export class JudgmentEngineBootCheckError extends Error {
  override readonly name = 'JudgmentEngineBootCheckError';
  constructor(
    public readonly code:
      | 'JUDGMENT_ENGINE_PENALTY_KEY_INVALID'
      | 'JUDGMENT_ENGINE_MANIFEST_MISSING_VERSION'
      | 'JUDGMENT_ENGINE_HASH_DRIFT',
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

function buildJudgmentEngineHashSnapshot() {
  return {
    rules: JudgmentEngineRules,
    missingDocPenalties: JE_MISSING_DOC_PENALTIES,
    distrustPenalties: JE_DISTRUST_PENALTIES,
  };
}

export function computeCurrentJudgmentEngineHash(): string {
  return computeContentHash(buildJudgmentEngineHashSnapshot());
}

export function performJudgmentEngineBootCheck(): void {
  const ruleSet = new Set<string>(Object.values(JudgmentEngineRules));

  // 1. PENALTY_KEYS_VALID — every penalty key must be a real rule id
  for (const key of Object.keys(JE_MISSING_DOC_PENALTIES)) {
    if (!ruleSet.has(key)) {
      throw new JudgmentEngineBootCheckError(
        'JUDGMENT_ENGINE_PENALTY_KEY_INVALID',
        `JE_MISSING_DOC_PENALTIES key '${key}' is not a JudgmentEngineRuleId. Reconcile the rule registry and the penalty map.`,
      );
    }
  }
  for (const key of Object.keys(JE_DISTRUST_PENALTIES)) {
    if (!ruleSet.has(key)) {
      throw new JudgmentEngineBootCheckError(
        'JUDGMENT_ENGINE_PENALTY_KEY_INVALID',
        `JE_DISTRUST_PENALTIES key '${key}' is not a JudgmentEngineRuleId. Reconcile the rule registry and the penalty map.`,
      );
    }
  }

  // 2. HASH_DRIFT
  const expectedHash = JUDGMENT_ENGINE_MANIFEST[JUDGMENT_ENGINE_VERSION];
  if (!expectedHash || expectedHash === '__JUDGMENT_ENGINE_V1_HASH__') {
    throw new JudgmentEngineBootCheckError(
      'JUDGMENT_ENGINE_MANIFEST_MISSING_VERSION',
      `no manifest entry for JUDGMENT_ENGINE_VERSION='${JUDGMENT_ENGINE_VERSION}'. Run \`npm run judgment-engine:print-hash\` and append the result to JUDGMENT_ENGINE_MANIFEST.`,
    );
  }
  const currentHash = computeCurrentJudgmentEngineHash();
  if (currentHash !== expectedHash) {
    throw new JudgmentEngineBootCheckError(
      'JUDGMENT_ENGINE_HASH_DRIFT',
      `judgment-engine state for version '${JUDGMENT_ENGINE_VERSION}' hashes to ${currentHash}, ` +
        `manifest expects ${expectedHash}. Either revert the change OR bump JUDGMENT_ENGINE_VERSION ` +
        `and append a new manifest entry.`,
    );
  }
}

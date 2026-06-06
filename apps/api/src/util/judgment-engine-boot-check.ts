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
// v1.10 — desk constants folded into the snapshot. Every output-affecting
// numeric living outside the rule registry / penalty maps is imported here so
// a silent re-tune of any value moves the manifest hash and trips the boot
// check, replacing the prior "manual bump" convention with an automatic gate.
import { NOI_DIVERGENCE_THRESHOLD } from '../services/judgment/noi-divergence.js';
import {
  CAP_RATE_FLOOR,
  CAP_RATE_CEILING,
  NET_ADJ_BAND_BPS,
  TIER_DELTA,
  BP_LEASEUP_DELTA,
  ROLLOVER_HEAVY_THRESHOLD,
  ROLLOVER_HEAVY_DELTA,
  ROLLOVER_MODERATE_THRESHOLD,
  ROLLOVER_MODERATE_DELTA,
  CONCENTRATION_THRESHOLD,
  CONCENTRATION_DELTA,
} from '../services/judgment/apply-cap-rate-stress.js';
import {
  CONCESSIONS_DEFAULT_PCT,
  MONTHLY_CAPEX_DEFAULT_PCT_OF_EGI_ANNUAL,
  TERMINAL_CAP_RATE_SPREAD,
} from '../services/judgment/line-item-builders.js';

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
    // v1.10 (2026-06-06) — every output-affecting desk constant outside the
    // rule registry, hashed alongside it. canonicalize() sorts keys at hash
    // time, so the property insertion order below has no effect on the digest;
    // the order is kept by source-file for readability. Adding a new desk
    // constant requires (a) appending it here, (b) bumping
    // JUDGMENT_ENGINE_VERSION, and (c) appending a new manifest entry.
    deskConstants: {
      // noi-divergence.ts
      NOI_DIVERGENCE_THRESHOLD,
      // apply-cap-rate-stress.ts
      CAP_RATE_FLOOR,
      CAP_RATE_CEILING,
      NET_ADJ_BAND_BPS,
      TIER_DELTA,
      BP_LEASEUP_DELTA,
      ROLLOVER_HEAVY_THRESHOLD,
      ROLLOVER_HEAVY_DELTA,
      ROLLOVER_MODERATE_THRESHOLD,
      ROLLOVER_MODERATE_DELTA,
      CONCENTRATION_THRESHOLD,
      CONCENTRATION_DELTA,
      // line-item-builders.ts (1d06cc9 extracted these from inline literals)
      CONCESSIONS_DEFAULT_PCT,
      MONTHLY_CAPEX_DEFAULT_PCT_OF_EGI_ANNUAL,
      TERMINAL_CAP_RATE_SPREAD,
    },
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

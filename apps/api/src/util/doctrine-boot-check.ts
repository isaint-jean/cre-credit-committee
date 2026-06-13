/**
 * Boot-time invariant assertions for the doctrine spine.
 *
 * Three checks, all fail-fast:
 *   1. WEIGHT_SUM       — DOCTRINE_COMPONENT_WEIGHTS sums to exactly 100
 *   2. RULE_COVERAGE    — every component in DOCTRINE_RULES_BY_COMPONENT has at least one rule,
 *                          except components in DOCTRINE_COMPONENTS_WITH_DEFERRED_RULES
 *   3. HASH_DRIFT       — recomputing the canonical hash of the frozen doctrine state matches
 *                          the manifest entry for the current DOCTRINE_VERSION
 *
 * Throws `DoctrineBootCheckError` on any failure. Caller (api/index.ts) propagates the throw so
 * Node exits non-zero before the HTTP listener starts.
 */

import {
  DOCTRINE_COMPONENT_WEIGHTS,
  DOCTRINE_COMPONENTS_WITH_DEFERRED_RULES,
  DOCTRINE_MANIFEST,
  DOCTRINE_RULES_BY_COMPONENT,
  DOCTRINE_VERSION,
  DoctrineFlags,
  DoctrineReasonCodes,
  DoctrineRules,
  RATING_BANDS,
} from '@cre/contracts';
import { computeContentHash } from './content-hash.js';
// v1.4 — dim-7 cap-rate floor table folded into the snapshot. These are the
// constants that produce stressedValue (the load-bearing memo number); a
// silent retune of any floor / tier delta / valuation band would have
// passed the v1.3 boot check and rippled through every downstream signal
// (stressedLtv, mitigation LTV-arm cut sizing, leverage-band classification,
// the memo's "Doctrine-stressed value (dim 7)" row). Folding here closes
// that gap without moving any number — the constants don't change; only
// the hash scope does.
import {
  ASSET_FLOORS,
  OFFICE_SUBTYPE_FLOORS,
  OFFICE_SUBTYPE_DEFAULT_FLOOR,
  MARKET_TIER_DELTAS,
  TERMINAL_WIDEN_BPS,
  VALUATION_BANDS,
} from '../doctrine-clean/dimensions/cap-rate-valuation-stress.js';

export class DoctrineBootCheckError extends Error {
  override readonly name = 'DoctrineBootCheckError';
  constructor(
    public readonly code:
      | 'DOCTRINE_WEIGHT_SUM_INVALID'
      | 'DOCTRINE_COMPONENT_HAS_NO_RULES'
      | 'DOCTRINE_MANIFEST_MISSING_VERSION'
      | 'DOCTRINE_HASH_DRIFT',
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

/**
 * Snapshot of the frozen doctrine state. Hashed for drift detection. Bumping `DOCTRINE_VERSION`
 * + appending a manifest entry is required when this hash changes.
 */
function buildDoctrineHashSnapshot() {
  return {
    rules: DoctrineRules,
    flags: DoctrineFlags,
    reasonCodes: DoctrineReasonCodes,
    weights: DOCTRINE_COMPONENT_WEIGHTS,
    bands: RATING_BANDS,
    rulesByComponent: DOCTRINE_RULES_BY_COMPONENT,
    // v1.4 — dim-7 spine constants. Mirrors the v1.10 judgment-engine
    // pattern (deskConstants block alongside rules/flags). Maps converted to
    // entry arrays so insertion order participates in the digest. Bands are
    // projected to a hash-stable shape: load-bearing math (tier,
    // riskContribution, edges) + ±Infinity sentinels collapsed to null
    // (canonicalize() rejects non-finite numbers). Prose `rationale` is
    // skipped — narrative engine governs end-user prose.
    spineConstants: {
      // cap-rate-valuation-stress.ts (dim 7) — the load-bearing lookups
      capRateAssetFloors:        ASSET_FLOORS,
      officeSubtypeFloors:       Array.from(OFFICE_SUBTYPE_FLOORS.entries()),
      officeSubtypeDefaultFloor: OFFICE_SUBTYPE_DEFAULT_FLOOR,
      marketTierDeltas:          MARKET_TIER_DELTAS,
      terminalWidenBps:          TERMINAL_WIDEN_BPS,
      valuationBands: VALUATION_BANDS.map(b => ({
        tier: b.tier,
        riskContribution: b.riskContribution,
        minAggressiveness: Number.isFinite(b.minAggressiveness) ? b.minAggressiveness : null,
        maxAggressiveness: Number.isFinite(b.maxAggressiveness) ? b.maxAggressiveness : null,
      })),
    },
  };
}

/** Compute the current canonical hash of the frozen doctrine state. */
export function computeCurrentDoctrineHash(): string {
  return computeContentHash(buildDoctrineHashSnapshot());
}

/** Run all three boot checks. Throws on the first failure; succeeds silently. */
export function performDoctrineBootCheck(): void {
  // 1. WEIGHT_SUM
  const totalWeight = Object.values(DOCTRINE_COMPONENT_WEIGHTS).reduce((s, w) => s + w, 0);
  if (totalWeight !== 100) {
    throw new DoctrineBootCheckError(
      'DOCTRINE_WEIGHT_SUM_INVALID',
      `expected 100, got ${totalWeight}. Edit DOCTRINE_COMPONENT_WEIGHTS in @cre/contracts/doctrine/components.`,
    );
  }

  // 2. RULE_COVERAGE
  const deferredComponents = new Set<string>(DOCTRINE_COMPONENTS_WITH_DEFERRED_RULES);
  for (const [component, rules] of Object.entries(DOCTRINE_RULES_BY_COMPONENT)) {
    if (rules.length === 0 && !deferredComponents.has(component)) {
      throw new DoctrineBootCheckError(
        'DOCTRINE_COMPONENT_HAS_NO_RULES',
        `component '${component}' has no rules in DOCTRINE_RULES_BY_COMPONENT and is not on the deferred list. Either add rules or add it to DOCTRINE_COMPONENTS_WITH_DEFERRED_RULES.`,
      );
    }
  }

  // 3. HASH_DRIFT
  const expectedHash = DOCTRINE_MANIFEST[DOCTRINE_VERSION];
  if (!expectedHash || expectedHash === '__DOCTRINE_V1_HASH__') {
    throw new DoctrineBootCheckError(
      'DOCTRINE_MANIFEST_MISSING_VERSION',
      `no manifest entry for DOCTRINE_VERSION='${DOCTRINE_VERSION}'. Run \`npm run doctrine:print-hash\` and append the result to DOCTRINE_MANIFEST.`,
    );
  }
  const currentHash = computeCurrentDoctrineHash();
  if (currentHash !== expectedHash) {
    throw new DoctrineBootCheckError(
      'DOCTRINE_HASH_DRIFT',
      `doctrine state for version '${DOCTRINE_VERSION}' hashes to ${currentHash}, ` +
        `manifest expects ${expectedHash}. Either revert the change OR bump DOCTRINE_VERSION ` +
        `and append a new manifest entry.`,
    );
  }
}

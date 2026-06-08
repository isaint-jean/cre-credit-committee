/**
 * `DOCTRINE_MANIFEST` — append-only registry of canonical-content hashes per `DoctrineVersion`.
 *
 * One entry per shipped doctrine version. The boot check (`apps/api/src/util/doctrine-boot-check.ts`)
 * recomputes the hash of the frozen doctrine state at startup and compares against the entry for
 * `DOCTRINE_VERSION`. If they disagree, the api refuses to start with `DOCTRINE_HASH_DRIFT`.
 *
 * Workflow when changing the doctrine ruleset:
 *   1. Edit the doctrine module(s) (rules / flags / reason-codes / weights / bands /
 *      rules-by-component).
 *   2. Bump `DOCTRINE_VERSION` in `versioning.ts` (e.g., `'1.0'` → `'2.0'`). Add the new literal
 *      to the union in versioning.ts.
 *   3. Run `npm run doctrine:print-hash` (in apps/api) and copy the printed hash.
 *   4. APPEND a new entry to `DOCTRINE_MANIFEST` below — DO NOT edit existing entries.
 *   5. Run `npm run check:doctrine` to verify the boot check passes.
 *
 * Editing an existing entry is forbidden: it would silently invalidate every previously-persisted
 * `DoctrineEvaluation` that stamps that version.
 */

import type { DoctrineVersion } from '../versioning.js';
import type { ContentHash } from '../identity.js';

export type DoctrineManifest = { readonly [V in DoctrineVersion]: ContentHash };

export const DOCTRINE_MANIFEST: DoctrineManifest = {
  // Hash for v1.0 — initial frozen ruleset. If the doctrine state is edited without a version
  // bump, the boot check surfaces drift here.
  '1.0': '0cb4f0a37e070dee8796d9b7061f490d3f15207acb775b3d7de2a065fb85ba7c' as ContentHash,
  // v1.1 (2026-06-08) — Doctrine missing-data fix Stage 1. Adds the
  // exclude-renormalize aggregation philosophy + risk-dim band cap +
  // coverage-floor gate. Snapshot coverage unchanged in shape ({rules, flags,
  // reasonCodes, weights, bands, rulesByComponent}); the hash moves because
  // DoctrineFlags gains INSUFFICIENT_COVERAGE_GATE. Per-component status +
  // applicability machinery added in commit 1 (45553ac) — no output drift.
  // Coverage struct + cap/floor wired here.
  //
  // DEFERRED HASH COVERAGE: doctrine-side desk constants
  //   (COVERAGE_FLOOR_THRESHOLD=0.50, RISK_DIMENSION_RULES set, band cap target
  //    'Acceptable') live outside the snapshot today. Tracked on the deferred
  //   doctrine-desk-hashing thread; mirror of the pre-v1.10 judgment situation.
  '1.1': '34d8960f9031cf2d186465582ce5d8c09659d717cfb61ff586010368ba9a3b46' as ContentHash,
  // v1.2 (2026-06-08) — Doctrine missing-data fix Stage 1, commits 3a+3b.
  // Two derivable-sink fills land together to avoid a cap-lifted-but-LTV-excluded
  // over-crediting hole:
  //   3a: scoreUwVsT12Reconciliation gains a derived path — when crossCheck has
  //       no NOI finding (today's hardcoded reality) AND
  //       metrics.trailingActualNoi is present, delta is computed directly
  //       from metrics.noi vs metrics.trailingActualNoi and scored through
  //       the existing band thresholds. Emits UW_VS_T12_DERIVED_FROM_METRICS.
  //   3b: scoreLtv gains a derived-LTV fallback — when ltvAppraisal is null
  //       (AR3: extraction.appraisal hardcoded null in production) AND
  //       valuationConclusion.finalValue is present, ltv = loan/finalValue
  //       and is scored through the existing band thresholds. Emits
  //       LTV_DERIVED_FROM_IMPLIED_VALUE.
  // Snapshot covers {rules, flags, reasonCodes, weights, bands, rulesByComponent};
  // hash moves because reasonCodes registry gains UW_VS_T12_DERIVED_FROM_METRICS
  // and LTV_DERIVED_FROM_IMPLIED_VALUE.
  '1.2': '4b57cd91c883439d6c90384af7e1abac8270cb94cf43fb099b4d4a615d9191d9' as ContentHash,
};

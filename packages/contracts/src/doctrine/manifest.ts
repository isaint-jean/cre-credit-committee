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
  // v1.3 (2026-06-08) — Graduated band cap. Updates the v1.1 flat-cap
  // decision per the calibration finding: the flat cap let tenant-driven
  // deals missing multiple risk dims (Sentinel Square II + Naugatuck Valley)
  // sail to a clean Acceptable. New graduation by count of risk dims in
  // 'insufficient_data' status:
  //   n == 0 → no cap
  //   n == 1 → clamp to Acceptable (v1.1 behavior)
  //   n >= 2 → clamp to Weak (Strong→Weak, Acceptable→Weak)
  // Bites only data-thin tenant-driven deals (Office/Retail/Industrial with
  // 2+ rent-roll-dependent dims sinking simultaneously); Multifamily/Hotel/
  // SelfStorage/MHC unaffected because their tenant dims are 'not_applicable'
  // (not counted). New flag DoctrineFlags.BAND_CAPPED fires when the cap
  // actually lowered the band (bandCapApplied === true) — gives the render
  // layer a flag-keyed banner signal parallel to INSUFFICIENT_COVERAGE_GATE.
  // Hash moves because DoctrineFlags registry gained BAND_CAPPED.
  //
  // DEFERRED HASH COVERAGE — graduation threshold n>=2 → Weak is a desk
  // tunable that lives outside the snapshot. Tracked on the doctrine-desk-
  // hashing thread alongside COVERAGE_FLOOR_THRESHOLD=0.50 and the
  // RISK_DIMENSION_RULES set; manual DOCTRINE_VERSION bump required to
  // change. Mirror of pre-v1.10 judgment situation.
  '1.3': 'b28476735047bfc23d9d2dbdfa7c58f83d55cca4a85df2988a2093c75aa0c48a' as ContentHash,
  // v1.4 (2026-06-13) — COVERAGE EXPANSION, NOT CALIBRATION. The dim-7
  // cap-rate floor table (ASSET_FLOORS, OFFICE_SUBTYPE_FLOORS,
  // OFFICE_SUBTYPE_DEFAULT_FLOOR, MARKET_TIER_DELTAS, TERMINAL_WIDEN_BPS,
  // VALUATION_BANDS — at apps/api/src/doctrine-clean/dimensions/cap-rate-
  // valuation-stress.ts) is folded into the doctrine hash snapshot under a
  // new spineConstants block. Mirrors the v1.10 judgment-engine pattern
  // (deskConstants alongside rules/flags). Closes the highest-value gate
  // gap surfaced by the valuation/stress recon: dim-7 produces stressedValue
  // — the single most load-bearing number in the lender memo — and the
  // pre-v1.4 doctrine snapshot {rules, flags, reasonCodes, weights, bands,
  // rulesByComponent} did NOT cover the floor table. A silent retune of
  // (e.g.) OFFICE_SUBTYPE_FLOORS['cbd'] 0.0900 → 0.0750 would have shifted
  // every Office CBD deal's stressedLtv, every downstream mitigation cut,
  // and every memo's "Doctrine-stressed value (dim 7)" row, while passing
  // the v1.3 boot check unchanged. This bump expands coverage — NO floor
  // moved, NO market-tier delta moved, NO band edge moved. Sunroad's
  // stressedValue / stressedLtv / $7.48M cut all byte-identical pre/post.
  // VALUATION_BANDS projected: ±Infinity sentinels → null (canonical-json
  // rejects non-finite numbers), prose `rationale` field dropped from the
  // hash (narrative engine governs end-user prose, not doctrine).
  // ASSET_FLOORS hashed as-is including the `source:` citation strings —
  // citation drift is provenance drift, in scope.
  '1.4': '577ce5772eaa1f28a58ecfa953428aa8951ef0c80272b4c820267ef3415b6c06' as ContentHash,
  // v1.5 (2026-06-19) — Conservative-lease-up doctrine: contracted-basis NOI
  // routing. ADDS a deliberate (not default) router that detects lease-up
  // deals via a 5-signal OR (t12 ≤ 0 / appraisal currentProForma NOI < 0 /
  // stabilizationMonths > 0 / occupancy gap > 10pp / assetProfile.businessPlan
  // === 'LeaseUp_or_Transitional') and substitutes a contracted-revenue-
  // derived uwY1Noi for the existing pickIssuerNoi cascade on lease-up deals.
  // Contracted revenue = Σ rent-roll inPlaceRentAnnual for status ∈
  // {OCCUPIED, PRELEASED}; speculative/vacant space excluded. EGI/TOE reuse
  // AdjustedInputs vacancy + expense floors (no policy duplication).
  // Stabilized deals fall through unchanged.
  //
  // DOCTRINE-SNAPSHOT HASH IS IDENTICAL TO v1.4. The hash didn't move because
  // the snapshot covers {rules, flags, reasonCodes, weights, bands,
  // rulesByComponent, spineConstants} — call-site behavior (which adapter
  // option uwY1Noi reads from) is OUTSIDE that surface. The version bump
  // records the policy decision; the boot check still passes because the
  // doctrine snapshot is byte-identical pre/post. Future calibrations that
  // touch the snapshot move the hash again.
  //
  // FENCE COMPLIANCE: the producer (services/contracted-basis.ts) reads
  // AdjustedInputs — but it's OUTSIDE doctrine-clean. The doctrine-clean
  // adapter only receives the resulting scalar via the explicit
  // `uwY1NoiOverride` option, never the AdjustedInputs object. The clean-
  // room invariant ("doctrine-clean reads only raw extraction + property
  // metadata") is preserved by construction.
  '1.5': '577ce5772eaa1f28a58ecfa953428aa8951ef0c80272b4c820267ef3415b6c06' as ContentHash,
};

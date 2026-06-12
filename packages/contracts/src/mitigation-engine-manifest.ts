/**
 * `MITIGATION_ENGINE_MANIFEST` — append-only registry of canonical-content
 * hashes per `MitigationEngineVersion`.
 *
 * Mirrors the `JUDGMENT_ENGINE_MANIFEST` pattern. Boot check
 * (`apps/api/src/util/mitigation-engine-boot-check.ts`) recomputes the hash
 * of the frozen mitigation-engine state at startup and compares against the
 * entry for `MITIGATION_ENGINE_VERSION`. If they disagree, the api refuses
 * to start with `MITIGATION_ENGINE_HASH_DRIFT`.
 *
 * The hashed state covers: desk constants (DEFAULT_MITIGATION_DESK), the
 * reserve clamp ceiling, the v1 lever set (MITIGATION_LEVERS), and the
 * principle-enrichment table mapping target metric → corroborating principle
 * ids. Bumping any of these changes the hash and requires a new manifest
 * entry under a bumped version.
 *
 * Workflow when changing engine state:
 *   1. Edit `apps/api/src/services/mitigation/produce-mitigations.ts`.
 *   2. Bump `MITIGATION_ENGINE_VERSION` in `versioning.ts` AND extend the
 *      MitigationEngineVersion union.
 *   3. Run `npm run mitigation-engine:print-hash` (in apps/api).
 *   4. APPEND a new entry below — DO NOT edit existing entries.
 *   5. Run `npm run check:mitigation-engine` to verify boot check passes.
 */

import type { MitigationEngineVersion } from './versioning.js';
import type { ContentHash } from './identity.js';

export type MitigationEngineManifest = { readonly [V in MitigationEngineVersion]: ContentHash };

export const MITIGATION_ENGINE_MANIFEST: MitigationEngineManifest = {
  // v1.0 (2026-06-05). Initial release. Two levers (reduce_proceeds,
  // fund_reserve), metrics-driven trigger per doctrine v1.2, desk constants
  // T_DSCR=1.25, T_DY=0.085, T_LTV=0.65, T_ROLLOVER=0.20,
  // COVERAGE_FACTOR=0.75, MATERIALITY_MIN_PROCEEDS_CUT_PCT=0.02; reserve
  // clamp ceiling $25M. Principle-enrichment table covers self-storage and
  // mall coverage/leverage flags; ltv and rollover targets enrich from no
  // deterministic principle (handbook gap, see doctrine v1.2 §7).
  '1.0': '36aa36e344e7787f9f52b0e32bdcdeb22a24cd1f227ee2c9567b1ef88cac09c9' as ContentHash,
  // v1.1 (2026-06-05). Desk-vet pass. T_LTV 0.65 → 0.70 (hash-driving).
  // Lever-1 description gains a collateral-benefit clause ("Also improves
  // DSCR <b>→<a>, Debt Yield <b>→<a>.") naming the non-binding metrics that
  // moved favorably. Lever-2 coverageStatement rewritten to an income-honest
  // form ("pre-funds re-tenanting cost (TI/LC + downtime) at X% of the Y.Y%
  // rollover-exposed annual income"). Copy changes are convention-managed
  // version bumps — the snapshot hashes constants + tables, not prose
  // (see MITIGATION_ENGINE_VERSION docstring).
  '1.1': '6e2489128977dd8887c2d96bb1127ff06096237fdcd5b1b0cabbebd181decfec' as ContentHash,
  // v1.2 — two bundled state changes:
  //   (a) Guaranty desk knobs added to the hash snapshot — DEFAULT_GUARANTY_
  //       TIER_TERMS table (4 tier-keys × 4 numeric knobs). Lift-and-extract
  //       of the prior string-literal recourse % / NW × / liquidity % /
  //       burn-off years out of buildGuarantyProposal copy into a desk-owned
  //       calibrable table. (The earlier guaranty refactor commit landed
  //       the snapshot widening; this entry registers the resulting hash.)
  //   (b) reduce_proceeds_ltv lever copy rewritten in DOCTRINE-STRESSED
  //       basis: appraised/concluded LTV ("Concluded LTV X% breaches target
  //       Y%; ... brings LTV to Z%") is REMOVED from the LTV-arm description
  //       and from the collateralBenefitClause side-effects list. The lever
  //       now states the stressed-LTV breach and cure (loan / dim-7
  //       stressedValue) — one LTV basis in the memo, doctrine-stressed.
  //       Convention: copy changes also bump the version (see
  //       MITIGATION_ENGINE_VERSION docstring), even when the snapshot
  //       hash doesn't change on the copy edit alone.
  '1.2': '6d5a636f4dc05df9698174e4b8c817934988f440d8d2bda2eebcc78072eb03e9' as ContentHash,
};

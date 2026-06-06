/**
 * `JUDGMENT_ENGINE_MANIFEST` — append-only registry of canonical-content hashes per
 * `JudgmentEngineVersion`.
 *
 * Mirrors the `DOCTRINE_MANIFEST` pattern. Boot check (`apps/api/src/util/judgment-engine-boot-check.ts`)
 * recomputes the hash of the frozen judgment-engine state at startup and compares against the
 * entry for `JUDGMENT_ENGINE_VERSION`. If they disagree, the api refuses to start with
 * `JUDGMENT_ENGINE_HASH_DRIFT`.
 *
 * Workflow when changing the rule registry or penalty weights:
 *   1. Edit `judgment-engine-rules.ts`.
 *   2. Bump `JUDGMENT_ENGINE_VERSION` in `versioning.ts`.
 *   3. Run `npm run judgment-engine:print-hash` (in apps/api) and copy the printed hash.
 *   4. APPEND a new entry below — DO NOT edit existing entries.
 *   5. Run `npm run check:judgment-engine` to verify boot check passes.
 */

import type { JudgmentEngineVersion } from './versioning.js';
import type { ContentHash } from './identity.js';

export type JudgmentEngineManifest = { readonly [V in JudgmentEngineVersion]: ContentHash };

export const JUDGMENT_ENGINE_MANIFEST: JudgmentEngineManifest = {
  // Batch 6.2 (2026-05-08) — registry expanded with 7 new rules (audit U10/U11/U12/U15/NR4).
  // Batch 6.2.1 (2026-05-08) — registry further expanded with 6 deferred-cleanup rules
  // (audit U7 rent-roll incompleteness, U8 impossible composite, U9 four MANUAL defaults).
  // No graph-backed records exist for v1.0 yet (Audit 4), so in-place hash regeneration is
  // safe. Once persistence ships in sub-batch 6.4, any further registry change MUST bump the
  // version per the workflow above (no more in-place edits).
  '1.0': '7e39fd654e780c8abf440f770bbce6cdbbae3aac7cf7815ee98a4919951023e9' as ContentHash,
  // C.2 (2026-05-24) — OperatingStatementExtraction widening Phase 1+2. Three new rules
  // (JE_REPLACEMENT_RESERVES_DEFAULTED, JE_TENANT_IMPROVEMENTS_DEFAULTED,
  // JE_LEASING_COMMISSIONS_DEFAULTED) covering the new below-NOI projection builders.
  '1.1': '8b1289e7c3f07dfa8a78afbec3d80507f9c2d2fe65129acdd6c81242d3e06f67' as ContentHash,
  // PCA producer ticket — Phase 1+2 ship (2026-05-25). One new rule
  // (JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED) covering the buildUpfrontReplacementReserves
  // MANUAL-default path (fires when PCA capex schedule is null).
  '1.2': 'a34151a7568cf30e31fab531ab3dd95af6b4190f6609ce7fb124fc44c6144bf5' as ContentHash,
  // Period-classification fix (2026-05-31). Three new rules:
  // JE_TRAILING_ACTUALS_MISSING (rename of JE_T12_MISSING — re-source: fires on
  // extraction.t12Actual === null instead of the historical extraction.t12 === null),
  // JE_IN_PLACE_MISSING (new — fires on extraction.inPlace === null), and
  // JE_PERIOD_LABEL_MISMATCH (new — informational delta=0 surface for sanity-checking
  // extractor period-label assignments). JE_MISSING_DOC_PENALTIES gains a key for
  // JE_TRAILING_ACTUALS_MISSING (weight 12, inherited from JE_T12_MISSING) and
  // JE_IN_PLACE_MISSING (weight 8). Hash placeholder until print-judgment-engine-hash runs.
  '1.3': 'abfc5a2fe1e61bc020349b9e3f14a9bf8c3d02dd53e8bc00237153cf7049d110' as ContentHash,
  // Cap-rate stress doctrine v1 scaffolding (2026-06-05). Eight new rule literals added
  // to the JudgmentEngineRules registry: JE_CAP_TIER_GATEWAY, JE_CAP_TIER_SECONDARY,
  // JE_CAP_TIER_TERTIARY (bidirectional tier corrections off library median),
  // JE_CAP_STRESS_BUSINESS_PLAN, JE_CAP_STRESS_TENANCY_ROLLOVER,
  // JE_CAP_STRESS_TENANCY_CONCENTRATION (widen-only risk stress), JE_CAP_CLAMPED_TO_RANGE
  // (mutative clamp into [4.5%, 12.0%] band), and JE_CAP_NET_ADJ_OUT_OF_BAND
  // (informational net-adjustment review flag). Scaffolding only — literals defined,
  // not yet emitted. No JE_MISSING_DOC_PENALTIES / JE_DISTRUST_PENALTIES additions.
  '1.4': '7ab706aa52063cb4d044268a7868eef87ec4bc0c765be0e8440403c4f883d2e9' as ContentHash,
  // Cap-rate stress doctrine v1, commit 4a (2026-06-05). One new rule literal
  // added: JE_CAP_TIER_UNRESOLVED — informational (delta=0) degraded-state
  // flag that fires on Office deals when AssetProfile.marketLiquidity ===
  // 'Unknown' (neither explicit hint nor metro lookup resolved a tier).
  // Pushed to dataQualityFlags by the orchestrator, same shape as Phase 6.5
  // degraded-state flags. No JE_MISSING_DOC_PENALTIES / JE_DISTRUST_PENALTIES
  // additions. No emit-site changes elsewhere in the pipeline.
  '1.5': 'b184cfffa710174716a6ff3f053bdeb0c4eb49ef4cb4bd59736115c0fefe6bc1' as ContentHash,
  // Data-confidence axis v1.0, commit 1 of 3 — DETECT (2026-06-05). Adds the
  // top-level `AdjustedInputs.dataConfidence: 'validated' | 'unvalidated'`
  // field; derived purely from the existing bankNoi cascade at apply-judgment-
  // adjustments.ts. Pure detect; no downstream consumer yet (committee gate +
  // render surface land in commits 2 and 3). The judgment-engine hashed
  // snapshot covers {rules, missingDocPenalties, distrustPenalties} only —
  // derived-field logic is NOT in the snapshot, so the v1.6 hash equals the
  // v1.5 hash (expected; the version bump anchors the AdjustedInputs shape
  // change rather than an engine-state change). See data-confidence-design-v1.md.
  '1.6': 'b184cfffa710174716a6ff3f053bdeb0c4eb49ef4cb4bd59736115c0fefe6bc1' as ContentHash,
  // Income recovery (2026-06-06). One new rule literal added to JudgmentEngineRules:
  // JE_OTHER_INCOME_RECOVERED_FROM_TOTAL — emitted by buildOtherIncome when all CF columns
  // omit an explicit otherIncome line BUT a single statement carries both totalIncome and
  // GPR, synthesizing otherIncome as (totalIncome − GPR) from that pinned slot. Captures
  // undecomposed reimbursement/other-income residual the extractor's LINE_PATTERNS couldn't
  // break out (Showcase I pattern: ~$3.67M lost between t12.totalIncome=$16.09M and engine
  // EGI base). No JE_MISSING_DOC_PENALTIES / JE_DISTRUST_PENALTIES additions — this is a
  // synthesis flag, not a penalty trigger. Unlike v1.6, the rule-registry change DOES move
  // the snapshot hash (rules ∈ buildJudgmentEngineHashSnapshot). See income-recovery-design-v1.md.
  '1.7': '8e96057620d3e23d422616bd407c106ff6a8b31a2d888f50bad4f6506f867eb2' as ContentHash,
  // NOI divergence detect — commit 1 of 2 (2026-06-06). One new rule literal:
  // JE_NOI_BELOW_TRAILING_ACTUAL — emitted at apply-judgment-adjustments.ts when
  // t12Actual.noi is present AND finalNoi is ≥ 20% below it. Pushed as a
  // topLevelAdjustment (delta = finalNoi − t12.noi, negative; reason carries the figures)
  // AND mirrored to dataQualityFlags in Phase 6.5. Threshold (NOI_DIVERGENCE_THRESHOLD =
  // 0.20) lives in apps/api/src/services/judgment/noi-divergence.ts, NOT in the hashed
  // snapshot — same convention as cap-rate-stress desk constants. Changing the threshold
  // value MUST be paired with a manual JUDGMENT_ENGINE_VERSION bump (the rule-registry
  // hash will not catch a silent numeric re-tune). No penalty-map entry. Commit 2 lands
  // the render surface (RENDER_VERSION bump + summary.noiDivergence + UI banner). See
  // noi-divergence-flag-design-v1.md.
  '1.8': '9a34fe04deca1b2d7cb9bb37afe9e5a1532197dc672f625f1803a06648a1e6b8' as ContentHash,
  // Low-confidence middle tier — commit 1 of 2 (2026-06-06). Widens DataConfidence
  // from binary ('validated' | 'unvalidated') to 3-tier ordinal ('validated' |
  // 'low_confidence' | 'unvalidated'). low_confidence = no t12 but bankNoi cascade
  // resolved via inPlace or sellerUwOperatingStatement (Sunroad pattern). Pure
  // derived-field shape change: the judgment-engine hashed snapshot covers
  // {rules, missingDocPenalties, distrustPenalties} only, so the v1.9 hash equals
  // v1.8 by construction (expected; same precedent as v1.5 → v1.6 — the version
  // bump anchors the AdjustedInputs UNION change rather than an engine-state
  // change). Commit 2 lands the render surface (RENDER_VERSION bump + 3-way
  // displayValue mapping + low_confidence banner). See low-confidence-tier-design-v1.md.
  // FORWARD-POINTER: v1.10 (below) widens the snapshot to include desk constants,
  // so the rule-registry-only convention is no longer the full story from 1.10 on.
  '1.9': '9a34fe04deca1b2d7cb9bb37afe9e5a1532197dc672f625f1803a06648a1e6b8' as ContentHash,
  // Desk constants now hash-covered (2026-06-06). The snapshot gains a `deskConstants`
  // top-level key carrying every output-affecting numeric outside the rule registry:
  //   - NOI_DIVERGENCE_THRESHOLD (noi-divergence.ts)
  //   - 11 cap-rate-stress constants (apply-cap-rate-stress.ts):
  //       CAP_RATE_FLOOR, CAP_RATE_CEILING, NET_ADJ_BAND_BPS, TIER_DELTA,
  //       BP_LEASEUP_DELTA, ROLLOVER_HEAVY_{THRESHOLD,DELTA},
  //       ROLLOVER_MODERATE_{THRESHOLD,DELTA}, CONCENTRATION_{THRESHOLD,DELTA}
  //   - 3 line-item-builders constants (line-item-builders.ts, extracted from
  //     inline literals in 1d06cc9 byte-identically):
  //       CONCESSIONS_DEFAULT_PCT, MONTHLY_CAPEX_DEFAULT_PCT_OF_EGI_ANNUAL,
  //       TERMINAL_CAP_RATE_SPREAD
  // A silent re-tune of any value now moves the manifest hash and trips
  // JUDGMENT_ENGINE_HASH_DRIFT at boot — replaces the prior manual-bump
  // convention with an automatic forcing function. No engine-output semantic
  // change in 1.10 (Showcase I / Sunroad / Eleven13 outputs byte-identical to
  // v1.9); the hash MOVED because the snapshot shape changed. See
  // docs/desk-threshold-hashing-design.md.
  '1.10': 'd0950410bd1fc7027d1fd910771f3be7368818824cdf429ed42fb57eb810d081' as ContentHash,
};

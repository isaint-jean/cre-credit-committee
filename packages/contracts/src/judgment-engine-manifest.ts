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
};

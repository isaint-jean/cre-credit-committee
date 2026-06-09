/**
 * `NARRATIVE_ENGINE_MANIFEST` — append-only registry of canonical-content hashes
 * per `NarrativeEngineVersion`.
 *
 * Mirrors the `JUDGMENT_ENGINE_MANIFEST` pattern. Boot check
 * (`apps/api/src/util/narrative-engine-boot-check.ts`) recomputes the hash of
 * the frozen narrative-engine state (prompt templates + system prompt) at
 * startup and compares against the entry for `NARRATIVE_ENGINE_VERSION`. If
 * they disagree, the api refuses to start with `NARRATIVE_ENGINE_HASH_DRIFT`.
 *
 * Workflow when changing prompt templates or the system prompt:
 *   1. Edit `apps/api/src/services/narrative/prompt-templates.ts`.
 *   2. Bump `NARRATIVE_ENGINE_VERSION` in `versioning.ts` (and extend the
 *      `NarrativeEngineVersion` union).
 *   3. Run `npm run narrative-engine:print-hash` (in apps/api) and copy the
 *      printed hash.
 *   4. APPEND a new entry below — DO NOT edit existing entries.
 *   5. Run `npm run check:narrative-engine` to verify boot check passes.
 */

import type { NarrativeEngineVersion } from './versioning.js';
import type { ContentHash } from './identity.js';

export type NarrativeEngineManifest = { readonly [V in NarrativeEngineVersion]: ContentHash };

export const NARRATIVE_ENGINE_MANIFEST: NarrativeEngineManifest = {
  // Piece A Phase 1 batch 1 (2026-05-29) — initial executive_summary survivor.
  // Frozen state: NARRATIVE_SYSTEM_PROMPT + EXECUTIVE_SUMMARY_PROMPT_TEMPLATE
  // from apps/api/src/services/narrative/prompt-templates.ts.
  '1.0': '01b7f1e437c48c394bb3fd09bb6d4b0a28ebf25a9a86713fdbb2b832235544dd' as ContentHash,
  // Phase 2 (2026-05-29) — red_flag_assessment slot added. Frozen state
  // additionally includes RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE. Hash
  // registered via `npm run narrative-engine:print-hash` after the
  // template + buildNarrativeEngineHashSnapshot widening landed.
  '1.1': '6018806ab5df6da9f62052467e79454988a0bc8456e9c3b3171f4bfd2b12f900' as ContentHash,
  // Phase 3 (2026-05-29) — mitigation_suggestions slot added. Frozen
  // state additionally includes MITIGATION_SUGGESTIONS_PROMPT_TEMPLATE.
  // Hash registered via `npm run narrative-engine:print-hash`.
  '1.2': '334392e9cdeecabc732dfa10408716132aa8aa543033e2b2a1dbcfd71bde295d' as ContentHash,
  // Phase 4 (2026-05-29) — committee_recommendation slot added; closes the
  // slot set (4 of 4 InjectionPoints have producers). Frozen state
  // additionally includes COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE.
  '1.3': 'c5deb3cf9c6d9e80df6d3999e65f55f3af608669fff23e48624ee57c41f91a1a' as ContentHash,
  // Data-confidence axis v1.0, commit 2 of 3 — GATE (2026-06-05).
  // buildCommitteeRecommendation short-circuits to a deterministic
  // "Insufficient data to issue a committee recommendation; obtain [docs]"
  // template when args.adjustedInputs.dataConfidence === 'unvalidated'.
  // Other slots (executive_summary, red_flag_assessment, mitigation_
  // suggestions) flow through the LLM unchanged.
  //
  // Hash note: the engine-state snapshot covers prompt templates + system
  // prompt; the gate template lives in build-narrative.ts (not prompt-
  // templates.ts), so it is NOT in the hashed state. Expected: v1.4 hash
  // equals v1.3 hash. The bump anchors the BuildNarrativeInput shape change
  // (new dataConfidence + dataQualityFlags fields) rather than a prompt-
  // template change. Same pattern as JUDGMENT_ENGINE_VERSION 1.5 → 1.6.
  '1.4': 'c5deb3cf9c6d9e80df6d3999e65f55f3af608669fff23e48624ee57c41f91a1a' as ContentHash,
  // v1.5 — narrative→mitigant wiring (2026-06-08). mitigation_suggestions
  // slot is now rendered DETERMINISTICALLY from MitigationProposalSet (no
  // LLM call); the new MITIGATION_SUGGESTIONS_HEADER_V1_5 +
  // MITIGATION_SUGGESTIONS_EMPTY_V1_5 constants enter the hash snapshot.
  // committee_recommendation template gains a {{mitigations}} placeholder
  // and an explicit constraint forbidding the LLM from inventing sized
  // structural conditions beyond what the engine produced — fixes Sunroad
  // fabricating a "$2.5M DSR" + DSCR covenant + cash sweep when the
  // mitigation engine produced zero proposals.
  '1.5': '43a025d0b8f31a3ac955a367e6bf40e697e28c64fa20b6ead45b00877bd327ed' as ContentHash,
};

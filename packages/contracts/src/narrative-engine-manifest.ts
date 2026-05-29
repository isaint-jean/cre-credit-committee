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
};

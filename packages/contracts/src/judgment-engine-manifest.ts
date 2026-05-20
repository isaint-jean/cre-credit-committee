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
};

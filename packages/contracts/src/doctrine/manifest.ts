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
};

/**
 * `COMMITTEE_MEMO_MANIFEST` — append-only registry of canonical-content
 * hashes per `CommitteeMemoVersion`.
 *
 * Mirrors the `MITIGATION_ENGINE_MANIFEST` pattern. Boot check
 * (`apps/api/src/util/committee-memo-boot-check.ts`) recomputes the
 * hash of the frozen committee-memo FORMAT snapshot at startup and
 * compares against the entry for `COMMITTEE_MEMO_VERSION`. If they
 * disagree, the api refuses to start with `COMMITTEE_MEMO_FORMAT_DRIFT`.
 *
 * The hashed state covers the memo's SHAPE only:
 *   - MEMO_SECTION_ORDER (the section render order)
 *   - MEMO_SECTION_HEADINGS (visible h2 strings)
 *   - MEMO_RESTRUCTURE_TITLES (cut vs hold variant section title)
 *   - MEMO_RESTRUCTURE_SUBHEADS (callout h3 strings)
 *   - MEMO_CALLOUT_LABELS (recommended-package headline labels)
 *   - MEMO_NULL_SENTINEL ('—' missing-data string)
 *
 * NOT covered (intentionally):
 *   - Per-deal numeric figures (the engines produce those; their
 *     manifests cover them).
 *   - LLM narrative prose (NARRATIVE_ENGINE_MANIFEST covers the
 *     prompt-template snapshot that shapes it).
 *   - CSS / styling (display layer, not document shape).
 *
 * Workflow when changing memo format:
 *   1. Edit apps/api/src/services/render-memo/committee-memo-format.ts.
 *   2. Bump COMMITTEE_MEMO_VERSION in versioning.ts AND extend the
 *      CommitteeMemoVersion union.
 *   3. Run `npm run committee-memo:print-hash` (in apps/api).
 *   4. APPEND a new entry below — DO NOT edit existing entries.
 *   5. Run `npm run check:committee-memo` to verify the gate passes.
 */

import type { CommitteeMemoVersion } from './versioning.js';
import type { ContentHash } from './identity.js';

export type CommitteeMemoManifest = { readonly [V in CommitteeMemoVersion]: ContentHash };

export const COMMITTEE_MEMO_MANIFEST: CommitteeMemoManifest = {
  // v1.0 (2026-06-12) — initial register. Captures the shape of the
  // committee memo as shipped through commit 4efb130 (the funded-exit
  // single-source move). 8-section order, current section/callout
  // headings, '—' null sentinel. Hash populated by the boot-check
  // printer; if you see __COMMITTEE_MEMO_V1_HASH__ here, run
  // `npm run committee-memo:print-hash` and replace the placeholder.
  '1.0': '3638b2992461af7b6653d74e763c92f8ccec1263804d6e9b381ed777b19fff51' as ContentHash,
  // v1.1 — Phase C "Open Items / Data Required" section added (2026-06-20).
  // MEMO_SECTION_ORDER widens by one entry (open_items appended after
  // committee_recommendation); MEMO_SECTION_HEADINGS adds the new h2 string.
  // No reordering, no callout-label changes, no null-sentinel change — the
  // existing 8 entries are preserved verbatim and the new section appends.
  //
  // Hash placeholder pending `npm run committee-memo:print-hash` after the
  // memo-format constants land. The boot-check rejects mismatches so a
  // stale hash is caught at startup.
  '1.1': '49f582eae808b7e48ceab0e203653199f34cb25d253ffd6df3655b9b43a84d61' as ContentHash,
};

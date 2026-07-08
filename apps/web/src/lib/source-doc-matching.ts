/**
 * Source-document → library-deal matching (client-side, conservative).
 *
 * Used by the "Upload Supporting Documents" flow on the UW Library page to
 * classify each dropped file into one of three buckets:
 *
 *   - auto_attach  — single exact normalized-name match; uploaded straight to
 *                    the deal's slot once the user clicks "Process All".
 *   - needs_pick   — ambiguous; user picks from a ranked candidate list.
 *   - unmatched    — no candidate; file is staged for later assignment.
 *
 * **Conservative bias**: when in doubt, flag. A wrong auto-attach silently
 * corrupts a source-doc ↔ answer-key pair the analyst won't catch until a
 * validation run. Over-flagging costs minutes; a wrong attach costs a bad
 * pair found much later. The portfolio guard (multiple strong matches → flag)
 * is the load-bearing piece — see matchFileToDeal() below.
 *
 * Pure functions, no I/O, no network calls. Easy to unit-test against a
 * fixture of UWRecord-shaped objects.
 */

// ── Lifted to @cre/shared (Data-Room content-routing SLICE 1) ───────────────
// `inferSlotFromFilename`, `normalizeForMatch`, `stripSlotHints`, `SLOT_LABELS`,
// `REQUIRED_SLOTS`, the `SourceDocSlot` / `SOURCE_DOC_SLOTS` union — AND now the
// fuzzy `matchFileToDeal` + its result types (`UWRecordLike`, `MatchCandidate`,
// `MatchBucket`, `MatchResult`) — all live in @cre/shared so BOTH web and the
// API's content-classify tier import ONE copy (no duplicate, no drift). The API
// content tier repoints `matchFileToDeal` at page-1 content text. Re-exported
// here so this module's existing web consumers (SourceDocUpload.tsx,
// api-client.ts) keep importing from the same path.
export {
  SOURCE_DOC_SLOTS,
  REQUIRED_SLOTS,
  SLOT_LABELS,
  stripSlotHints,
  normalizeForMatch,
  inferSlotFromFilename,
  matchFileToDeal,
  type SourceDocSlot,
  type UWRecordLike,
  type MatchCandidate,
  type MatchBucket,
  type MatchResult,
} from '@cre/shared';

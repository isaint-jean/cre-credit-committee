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

/**
 * Local narrow shape — only the fields the matcher reads. The page-level
 * UWRecord is wider; we accept anything assignable to this shape.
 */
export interface UWRecordLike {
  id: string;
  dealName: string;
  fileName: string;
  assetType?: string;
  year?: number;
  city?: string;
  state?: string;
}

// ── Lifted to @cre/shared (Data-Room Phase 2a) ──────────────────────────────
// `inferSlotFromFilename`, `normalizeForMatch`, `stripSlotHints`, `SLOT_LABELS`,
// `REQUIRED_SLOTS`, and the `SourceDocSlot` / `SOURCE_DOC_SLOTS` union now live in
// @cre/shared so BOTH web and the API's classify-on-stage path import ONE copy
// (no duplicate, no drift). Re-exported here so this module's existing web
// consumers (SourceDocUpload.tsx, api-client.ts) keep importing from the same
// path. `matchFileToDeal` + its result types stay web-only (library matcher).
export {
  SOURCE_DOC_SLOTS,
  REQUIRED_SLOTS,
  SLOT_LABELS,
  stripSlotHints,
  normalizeForMatch,
  inferSlotFromFilename,
  type SourceDocSlot,
} from '@cre/shared';

import { normalizeForMatch } from '@cre/shared';

export interface MatchCandidate {
  readonly uwRecord: UWRecordLike;
  readonly score: number; // 0..1; 1 = exact normalized core match
  readonly reason: 'exact' | 'substring' | 'token_overlap';
}

export type MatchBucket = 'auto_attach' | 'needs_pick' | 'unmatched';

export interface MatchResult {
  readonly bucket: MatchBucket;
  readonly candidates: ReadonlyArray<MatchCandidate>;
  readonly pickedUwRecord?: UWRecordLike;
}

/**
 * Conservative matcher. Returns the bucket + top candidates for one file.
 *
 * Decision rules (in order):
 *   1. AUTO-ATTACH iff exactly ONE UWRecord has a normalized dealName OR
 *      fileName that EXACTLY equals the normalized filename, AND no other
 *      UWRecord matches with score >= 0.7. Two strong matches => portfolio
 *      risk; we flag instead.
 *   2. Otherwise, build top-5 candidates with score >= 0.4 → NEEDS-PICK.
 *   3. Otherwise → UNMATCHED.
 *
 * Score table:
 *   - exact normalized match           → 1.00 (reason: exact)
 *   - file contains deal (deal≥6 chars) → 0.85 (reason: substring)
 *   - deal contains file (file≥6 chars) → 0.75 (reason: substring)
 *   - token-set overlap                → overlap / max(|file|,|deal|)
 */
export function matchFileToDeal(
  fileName: string,
  underwritings: ReadonlyArray<UWRecordLike>,
): MatchResult {
  const fileNormalized = normalizeForMatch(fileName);
  if (fileNormalized.length === 0) {
    return { bucket: 'unmatched', candidates: [] };
  }

  const scored: MatchCandidate[] = [];
  for (const uw of underwritings) {
    const dealNormalized = normalizeForMatch(uw.dealName);
    const fileNameNormalized = normalizeForMatch(uw.fileName);

    let score = 0;
    let reason: MatchCandidate['reason'] = 'token_overlap';

    if (
      (dealNormalized.length > 0 && dealNormalized === fileNormalized) ||
      (fileNameNormalized.length > 0 && fileNameNormalized === fileNormalized)
    ) {
      score = 1.0;
      reason = 'exact';
    } else if (dealNormalized.length >= 6 && fileNormalized.includes(dealNormalized)) {
      score = 0.85;
      reason = 'substring';
    } else if (fileNormalized.length >= 6 && dealNormalized.includes(fileNormalized)) {
      score = 0.75;
      reason = 'substring';
    } else {
      const fileTokens = new Set(fileNormalized.split(' ').filter((t) => t.length >= 3));
      const dealTokens = new Set(dealNormalized.split(' ').filter((t) => t.length >= 3));
      if (fileTokens.size === 0 || dealTokens.size === 0) continue;
      let overlap = 0;
      for (const t of fileTokens) if (dealTokens.has(t)) overlap++;
      score = overlap / Math.max(fileTokens.size, dealTokens.size);
      reason = 'token_overlap';
    }

    if (score > 0) scored.push({ uwRecord: uw, score, reason });
  }

  scored.sort((a, b) => b.score - a.score);

  const exactMatches = scored.filter((c) => c.reason === 'exact');
  const strongMatches = scored.filter((c) => c.score >= 0.7);

  // AUTO-ATTACH: exactly one exact match AND no other strong matches.
  if (exactMatches.length === 1 && strongMatches.length === 1) {
    return {
      bucket: 'auto_attach',
      candidates: [exactMatches[0]!],
      pickedUwRecord: exactMatches[0]!.uwRecord,
    };
  }

  // NEEDS-PICK: any candidate with score >= 0.4 (portfolio cases land here
  // because 2+ exacts/strongs fall through from above).
  const topCandidates = scored.filter((c) => c.score >= 0.4).slice(0, 5);
  if (topCandidates.length > 0) {
    return { bucket: 'needs_pick', candidates: topCandidates };
  }

  return { bucket: 'unmatched', candidates: [] };
}

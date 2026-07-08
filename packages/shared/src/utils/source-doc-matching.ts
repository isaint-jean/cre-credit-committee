/**
 * Source-document → deal fuzzy matcher (shared).
 *
 * LIFTED from apps/web/src/lib/source-doc-matching.ts (Data-Room content-routing
 * SLICE 1) so BOTH the web review UI and the API's content-classify tier import
 * the SAME conservative matcher — no duplicate, no drift. The web module now
 * re-exports these; the API's `classifyLoanFromContent` repoints this same
 * matcher at page-1 content text.
 *
 * **Conservative bias**: when in doubt, flag. A wrong auto-attach silently
 * corrupts a source-doc ↔ loan pair the analyst won't catch until later. The
 * portfolio guard (multiple strong matches → refuse) is the load-bearing piece:
 * the same deterministic-or-refuse discipline the filename/folder tiers use.
 *
 * Pure functions, no I/O, no network, NO LLM. Easy to unit-test.
 */

import { normalizeForMatch } from './source-doc-classify.js';

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
 *
 * `subject` is the text to match — a filename (web library flow) OR a page-1
 * content blob (the API content tier). Both go through `normalizeForMatch`,
 * which peels slot hints / prefixes / punctuation down to a bare property core.
 */
export function matchFileToDeal(
  subject: string,
  underwritings: ReadonlyArray<UWRecordLike>,
): MatchResult {
  const fileNormalized = normalizeForMatch(subject);
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

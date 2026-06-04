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

export type SourceDocSlot =
  | 'asr'
  | 'cf'
  | 'rent_roll'
  | 'pca'
  | 'seller_uw'
  | 't12'
  | 'appraisal';

export const SOURCE_DOC_SLOTS: ReadonlyArray<SourceDocSlot> = [
  'asr',
  'cf',
  'rent_roll',
  'pca',
  'seller_uw',
  't12',
  'appraisal',
];

export const REQUIRED_SLOTS: ReadonlyArray<SourceDocSlot> = ['asr', 'cf'];

export const SLOT_LABELS: Record<SourceDocSlot, string> = {
  asr: 'ASR (Anticipated Sale Report)',
  cf: 'Cash Flow (Seller CF)',
  rent_roll: 'Rent Roll',
  pca: 'PCA (Property Condition)',
  seller_uw: 'Seller Underwriting',
  t12: 'T-12 (Trailing 12 Operating Statement)',
  appraisal: 'Appraisal',
};

/**
 * Strip the slot-hint tokens from a filename for matching purposes. We don't
 * alter slot inference here; we just remove substrings that would otherwise
 * pollute the name-similarity score (e.g. the word "ASR" appearing in the
 * filename but not the dealName).
 */
export function stripSlotHints(s: string): string {
  return s
    .replace(
      /\b(ASR|CF|PCA|Rent[\s-]*Roll|RR|T-?12|Trailing[\s-]*Twelve|Trailing[\s-]*12|Appraisal|Seller[\s-]*UW|Seller[\s-]*Underwriting|Cash[\s-]*Flow|Operating[\s-]*Statement|Pro[\s-]*Forma|Anticipated[\s-]*Sale[\s-]*Report|Property[\s-]*Condition|Acquisition[\s-]*Sale[\s-]*Report|Valuation[\s-]*Report)\b/gi,
      ' ',
    )
    .replace(/\(\s*\d{4}[\s-]*\d{1,2}[\s-]*\d{1,2}\s*\)/g, ' ') // (2023-07-25)
    .replace(/\b(PRELIM|FINAL|DRAFT)\b/gi, ' ');
}

/**
 * Normalize a deal-name or filename for comparison.
 *
 * Pipeline:
 *   - strip file extension
 *   - strip leading "NNN- " / "NNN.NN- " / "N- " prefix
 *   - strip common manual-status suffixes ("OK TO PRINT JN", "FINAL", "W SITES", ...)
 *   - strip slot-hint substrings (delegated to stripSlotHints)
 *   - replace punctuation with spaces
 *   - lowercase + collapse whitespace
 */
export function normalizeForMatch(raw: string): string {
  let s = raw;

  // Strip file extension
  s = s.replace(/\.(xlsm|xlsx|xls|pdf|doc|docx)$/i, '');

  // Strip leading "NNN- " or "NNN.NN- " or "N- " prefix
  s = s.replace(/^\s*\d{1,3}(?:\.\d{1,3})?\s*[-–.\s]+/, '');

  // Strip common suffixes (order matters — longest first). Repeated passes
  // peel nested suffixes (e.g. "FINAL OK TO PRINT JN" → "FINAL OK TO PRINT"
  // → "FINAL" → ""). Trim between passes so trailing whitespace doesn't
  // break the `$` anchor.
  const suffixRx = /\s*[-–]?\s*(OK\s*TO\s*PRINT\s*[A-Z]{1,3}|OK\s*TO\s*PRINT|FINAL[-–\s]*OK\s*TO\s*PRINT|FINAL|with\s+sites|W\s+SITES|vStress|v\d+|need(?:s)?\s+site|JH\s*OK(?:\s+with\s+sites)?|JK\s+with\s+sites|LP\s*OK(?:\s+with\s+sites)?|JN|Updated|Revised|REV\d*)\s*$/gi;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(suffixRx, '').trim();
    if (s === before) break;
  }

  // Strip slot-hint tokens so name match isn't confused by them.
  s = stripSlotHints(s);

  // Punctuation → space
  s = s.replace(/[-–_.,(){}[\]&'']/g, ' ');

  // Lowercase + collapse
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Infer the slot type from a filename. Returns null on either zero matches
 * (unknown) or multiple matches (ambiguous) — both states require the user
 * to choose explicitly via the dropdown in the review UI.
 *
 * The PCA pattern intentionally matches before the rent-roll pattern only
 * via ordering; we still rely on the multi-match-null fallback for the
 * pathological "appraisal-cf-pca.pdf" case.
 *
 * Bare "RR" is intentionally NOT a rent-roll trigger — too noisy in real
 * filenames (also matches in property codes).
 */
export function inferSlotFromFilename(fileName: string): SourceDocSlot | null {
  const patterns: ReadonlyArray<readonly [SourceDocSlot, RegExp]> = [
    ['asr', /\b(ASR|Anticipated[\s-]*Sale[\s-]*Report|Acquisition[\s-]*Sale[\s-]*Report)\b/i],
    ['cf', /\b(CF|Cash[\s-]*Flow|Operating[\s-]*Statement|Pro[\s-]*Forma)\b/i],
    ['pca', /\b(PCA|Property[\s-]*Condition(?:[\s-]*Assessment)?)\b/i],
    ['rent_roll', /\b(Rent[\s-]*Roll)\b/i],
    ['seller_uw', /\b(Seller[\s-]*UW|Seller[\s-]*Underwriting|Seller[\s-]*Pro[\s-]*Forma)\b/i],
    ['t12', /\b(T-?12|Trailing[\s-]*Twelve|Trailing[\s-]*12)\b/i],
    ['appraisal', /\b(Appraisal(?:[\s-]*Report)?|Valuation[\s-]*Report)\b/i],
  ];

  const matched: SourceDocSlot[] = [];
  for (const [slot, rx] of patterns) {
    if (rx.test(fileName)) matched.push(slot);
  }
  if (matched.length === 1) return matched[0]!;
  return null;
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

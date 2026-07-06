/**
 * Source-document filename classification + name-normalization (shared).
 *
 * LIFTED from apps/web/src/lib/source-doc-matching.ts (Data-Room Phase 2a) so
 * BOTH the web review UI and the API's classify-on-stage path import the SAME
 * pure functions — no duplicate, no drift. The web module now re-exports these.
 *
 * The api package has rootDir=./src (forbids importing across app packages), so
 * before this lift the api's test embedded a byte-copy of the matcher. Placing
 * the logic in @cre/shared — which both apps already depend on — is the clean
 * single home.
 *
 * ── What lives here ──────────────────────────────────────────────────────────
 *   - `SourceDocSlot` / `SOURCE_DOC_SLOTS` are re-used from ./../types/source-docs
 *     (the pre-existing authoritative slot union) — NOT redefined.
 *   - `stripSlotHints` / `normalizeForMatch` — filename → bare-name normalizers.
 *   - `inferSlotFromFilename` — filename → SourceDocSlot | null. Exactly-1-hit
 *     or refuse (null on 0 hits OR ≥2 hits). This is the DOC-TYPE axis of the
 *     Phase-2 auto-router: it can ONLY emit the 7 slotted tier-(a/b) types, so
 *     tier-(c) room-only doc-types (legal/title/insurance/…) are structurally
 *     un-inferable and can never be "confident" → never auto-file. Preserve this.
 *
 * Pure functions, no I/O, no network — easy to unit-test.
 */

// SOURCE_DOC_SLOTS / SourceDocSlot are the pre-existing authoritative slot union
// (types/source-docs.ts) and are already re-exported at the package barrel via
// types/index.ts — we import (not re-export) them here to avoid a duplicate-export
// collision at the top-level index.
import type { SourceDocSlot } from '../types/source-docs.js';

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

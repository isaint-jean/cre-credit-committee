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

  // Strip leading "NNN- " or "NNN.NN- " or "N- " DOC-INDEX prefix. ★ The separator
  // MUST include a dash/dot ([-–.]) — a bare space is NOT enough. Otherwise a
  // street number ("640 5th avenue") is wrongly stripped to a generic ordinal
  // core ("5th avenue"), which then false-matches any 5th-avenue prose. Doc
  // indexes are "010. "/"23- "/"001 - " (dash/dot); street numbers are
  // space-separated and are KEPT.
  s = s.replace(/^\s*\d{1,3}(?:\.\d{1,3})?\s*[-–.]+\s*/, '');

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
 * The doc-type slot regex table — the SINGLE source of truth for both the
 * filename axis (`inferSlotFromFilename`) and the CONTENT axis
 * (`classifyDocTypeFromContent`, Data-Room content-routing SLICE 1). Extracted
 * so filename + page-1 content share ONE keyword table — no duplicate, no drift.
 *
 * Each RegExp is a set of cover-page / header keywords (the same words appear in
 * a filename AND on the document's own page 1: "Property Condition Assessment",
 * "Appraisal Report", "Cash Flow", …). The bare-abbreviation alternatives (PCA,
 * ASR, T-12, CF) are the ones that appear in short filenames; the spelled-out
 * alternatives (Property Condition Assessment, Anticipated Sale Report) are the
 * ones a document's own cover carries.
 *
 * The PCA pattern intentionally sits before the rent-roll pattern only via
 * ordering; we still rely on the multi-match-null fallback for the pathological
 * "appraisal-cf-pca.pdf" case. Bare "RR" is intentionally NOT a rent-roll
 * trigger — too noisy (also matches property codes).
 */
export const SLOT_PATTERNS: ReadonlyArray<readonly [SourceDocSlot, RegExp]> = [
  ['asr', /\b(ASR|Anticipated[\s-]*Sale[\s-]*Report|Acquisition[\s-]*Sale[\s-]*Report)\b/i],
  ['cf', /\b(CF|Cash[\s-]*Flow|Operating[\s-]*Statement|Pro[\s-]*Forma)\b/i],
  ['pca', /\b(PCA|Property[\s-]*Condition(?:[\s-]*Assessment)?)\b/i],
  ['rent_roll', /\b(Rent[\s-]*Roll)\b/i],
  ['seller_uw', /\b(Seller[\s-]*UW|Seller[\s-]*Underwriting|Seller[\s-]*Pro[\s-]*Forma)\b/i],
  ['t12', /\b(T-?12|Trailing[\s-]*Twelve|Trailing[\s-]*12)\b/i],
  ['appraisal', /\b(Appraisal(?:[\s-]*Report)?|Valuation[\s-]*Report)\b/i],
];

/**
 * Run the shared SLOT_PATTERNS table over an arbitrary text and return the one
 * matched slot, or null on 0 or ≥2 matches (unknown OR ambiguous). The common
 * engine behind both `inferSlotFromFilename` (text = filename) and
 * `classifyDocTypeFromContent` (text = page-1 content) — same exactly-1-or-refuse
 * discipline, one keyword table.
 */
function matchSlotInText(text: string): SourceDocSlot | null {
  const matched: SourceDocSlot[] = [];
  for (const [slot, rx] of SLOT_PATTERNS) {
    if (rx.test(text)) matched.push(slot);
  }
  if (matched.length === 1) return matched[0]!;
  return null;
}

/**
 * Infer the slot type from a filename. Returns null on either zero matches
 * (unknown) or multiple matches (ambiguous) — both states require the user
 * to choose explicitly via the dropdown in the review UI.
 */
export function inferSlotFromFilename(fileName: string): SourceDocSlot | null {
  return matchSlotInText(fileName);
}

/**
 * DOC-TYPE axis, CONTENT tier (Data-Room content-routing SLICE 1).
 *
 * Run the EXACT same SLOT_PATTERNS keyword table over a document's page-1 text.
 * Same exactly-1-or-refuse discipline as the filename axis. NO-LLM, pure regex.
 * The caller (`classifyFileCascade`) uses this only as the tier-3 fallback when
 * the filename axis refused (an un-renamed / cryptically-named file whose OWN
 * cover page carries "Property Condition Assessment" / "Appraisal Report").
 */
export function classifyDocTypeFromContent(pageText: string): SourceDocSlot | null {
  return matchSlotInText(pageText);
}

/* -------------------------------------------------------------------------- */
/* CONTENT-DATE axis (Data-Room content-routing SLICE 4).                     */
/*                                                                            */
/* Extract a document's effective / as-of / report date from its own text —  */
/* the version tiebreak signal for gatherTierADocs (latest-content-date wins  */
/* the underwrite slot). NO-LLM: pure regex over the doc's front-matter text  */
/* (the same page-1/cover text the SLICE-1 content classifier already reads,  */
/* extended a few pages for the appraisal value-conclusion table). Returns an */
/* ISO-8601 UTC string (YYYY-MM-DDT00:00:00.000Z) or null when no parseable   */
/* date is present (→ the caller falls back to uploadedAt, honest).           */
/* -------------------------------------------------------------------------- */

const MONTH_INDEX: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** A month/day/year triple → the canonical ISO-UTC midnight string, or null on
 *  an out-of-range component. */
function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
}

/** "July 13, 2023" → ISO, or null. Mirrors extract-cbre-appraisal.ts parseDate. */
function parseMonthNameDate(s: string): string | null {
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTH_INDEX[m[1]!.toLowerCase()];
  if (mo === undefined) return null;
  return toIso(Number(m[3]), mo, Number(m[2]));
}

/** "7/13/2023" or "1.23.20" (M/D/Y) → ISO, or null. 2-digit years → 2000s. */
function parseNumericDate(s: string): string | null {
  const m = s.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return toIso(year, Number(m[1]), Number(m[2]));
}

/** Either date form → ISO, or null. */
function parseAnyDate(s: string): string | null {
  return parseMonthNameDate(s) ?? parseNumericDate(s);
}

/** A single alternation for BOTH date forms (month-name OR numeric M/D/Y),
 *  reused inside the labeled-date patterns. */
const DATE_TOKEN =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}';

/**
 * CONTENT-DATE axis (SLICE 4). Extract the strongest effective/as-of/report date
 * signal from a document's front-matter text. Priority (strongest first):
 *
 *   1. As-Is value / effective / valuation / "Date of Value" date — the
 *      appraisal's own effective date (the field extract-cbre-appraisal reads as
 *      asIsValueDate). This is the canonical "as of when is this valuation true".
 *   2. Date of Report / Report Date — the document's issue date.
 *   3. Any bare month-name date anywhere in the text — last resort.
 *
 * Within a priority tier, the LATEST date wins (recency). Returns ISO-UTC or
 * null. Pure regex, NO-LLM — runs with API credits depleted.
 */
export function classifyDateFromContent(text: string): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;

  const candidates: Array<{ iso: string; priority: number }> = [];
  const collect = (rx: RegExp, priority: number): void => {
    for (const m of text.matchAll(rx)) {
      const iso = parseAnyDate(m[1]!);
      if (iso) candidates.push({ iso, priority });
    }
  };

  // Priority 1 — value / effective / as-of dates (the value-conclusion table).
  collect(
    new RegExp(
      `(?:As[\\s-]*Is[^\\n$]{0,40}?|Effective Date(?: of (?:Value|the Appraisal))?|Date of Value|Valuation Date)\\s*:?\\s*(${DATE_TOKEN})`,
      'gi',
    ),
    1,
  );
  // Priority 2 — report / issue date.
  collect(new RegExp(`(?:Date of Report|Report Date)\\s*:?\\s*(${DATE_TOKEN})`, 'gi'), 2);
  // Priority 3 — any month-name date anywhere (last resort).
  collect(
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi,
    3,
  );

  if (candidates.length === 0) return null;
  // Strongest priority; within a tier, the latest ISO date (lexical compare works
  // for the fixed ISO shape).
  candidates.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : (a.iso < b.iso ? 1 : -1)));
  return candidates[0]!.iso;
}

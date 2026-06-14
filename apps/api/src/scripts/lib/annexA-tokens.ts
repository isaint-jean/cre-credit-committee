/**
 * annexA-tokens — low-level text utilities shared by every Annex A walker.
 *
 * Scope: HTML stripping, whitespace tokenization, numeric token parsing,
 * bare-year detection. NOT a parser; each walker still owns its own
 * `extractLoanRow`, table-anchor logic, and column-specific parseT* functions
 * (per PASS 2a survey those are fundamentally per-issuer).
 *
 * Sentinel/entity coverage is the UNION of WFRBS 2013-C11 + CGCMT 2013-GC15:
 * adding extra null-sentinels or HTML entity replacements never changes
 * behavior on a doc that doesn't contain them, and the dual-shelf
 * byte-identical regression gate PROVES this empirically every commit.
 *
 * Extracted 2026-06-14 from the WFRBS + CGCMT shelf generalizers (PASS 2b).
 */

/**
 * Strip HTML structure + decode HTML entities to plain text, then collapse
 * whitespace. The replacement list is the UNION of patterns the two shelves
 * carry — every line is either present in both (and trivially merged) or
 * present in only one (and a no-op on the other doc).
 *
 *   <style>/<script> blocks   — CGCMT only (the 424B5 carries inline CSS/JS;
 *                              WFRBS's stripped doc has none, harmless)
 *   <tag>                     — both
 *   &nbsp;/&#160;             — both
 *   en-dash/em-dash entities  — both
 *   apostrophe entities       — both (CGCMT adds &#8217;, harmless on WFRBS)
 *   smart-quote entities      — CGCMT only (harmless on WFRBS)
 *   &amp;                     — both
 *   &lt;/&gt;                 — CGCMT only (harmless on WFRBS)
 *   whitespace collapse       — both
 */
export function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#8217;|&#146;|&#145;/g, "'")
    .replace(/&#8220;|&#8221;|&#147;|&#148;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/** Tokenize a row into whitespace-separated tokens. */
export function tokenize(row: string): string[] {
  return row.trim().split(/\s+/);
}

/**
 * Parse a number out of a token: strip $, %, commas, parentheses; treat the
 * UNION of WFRBS + CGCMT null-sentinels as null.
 *
 * Null-sentinel union: 'Various' (WFRBS+CGCMT), 'NAV' (both), 'N/A' (both),
 * '-' (both), '' (both empty-after-strip), 'NAP' (CGCMT — not applicable),
 * '—' (CGCMT em-dash). Adding NAP / em-dash to WFRBS's check doesn't change
 * behavior because those tokens don't appear in WFRBS's prospectus.
 */
export function num(tok: string | undefined): number | null {
  if (tok === undefined) return null;
  const cleaned = tok.replace(/[$,\s%()]/g, '');
  if (['Various', 'NAP', 'NAV', 'N/A', '-', '—', ''].includes(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when `raw` is a bare 4-digit standalone integer in the year range
 * 1900-2100 (no comma, no decimal — financial figures use commas; years
 * in CMBS prospectuses don't). Defensive: applied in parseT6 (and analogs)
 * where the row may carry a period descriptor like "Actual 2011" before
 * the comma-formatted financial figures. Class B fix (2026-06-13).
 */
export function isBareYearToken(raw: string): boolean {
  if (!/^\d{4}$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1900 && n <= 2100;
}

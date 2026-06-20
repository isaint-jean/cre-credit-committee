/**
 * Committee-memo FORMAT constants — the document's shape.
 *
 * These are the strings + structures whose drift would change what the
 * lender sees on the page WITHOUT changing any underlying number. The
 * boot check (apps/api/src/util/committee-memo-boot-check.ts) hashes a
 * canonical serialization of this module's exports and compares against
 * the registered entry for COMMITTEE_MEMO_VERSION.
 *
 * Scope of the hash:
 *   - MEMO_SECTION_ORDER       — render order of the document's <section>s.
 *   - MEMO_SECTION_HEADINGS    — visible <h2>/<h3> heading strings per
 *                                 section / callout subhead.
 *   - MEMO_RESTRUCTURE_TITLES  — cut vs. hold variant of the centerpiece
 *                                 section title.
 *   - MEMO_CALLOUT_LABELS      — restructuring callout headline labels.
 *   - MEMO_NULL_SENTINEL       — the missing-data string ("—") rendered
 *                                 in fmtUsd / fmtPct / fmtDscr / fallback
 *                                 inline reads (auth.assetType ?? '—' etc.).
 *
 * Out of scope (intentionally):
 *   - Numeric values (figures the engines produce — those move the
 *     engine hashes).
 *   - CSS / styling (display layer, not document shape).
 *   - LLM-generated prose (narrative engine governs that, separately
 *     hashed).
 *   - Per-deal copy stitched from authoritative numbers (those change
 *     deal-to-deal by design).
 *
 * Workflow when changing any constant below:
 *   1. Edit the constant.
 *   2. Bump COMMITTEE_MEMO_VERSION in @cre/contracts/versioning.ts AND
 *      extend the CommitteeMemoVersion union.
 *   3. Run `npm run committee-memo:print-hash` (in apps/api) and copy
 *      the printed hash.
 *   4. APPEND a new entry to COMMITTEE_MEMO_MANIFEST.
 *   5. Run `npm run check:committee-memo` (or `check:engines`) to
 *      verify the gate passes.
 */

/** Render order of the memo's top-level <section>s. Drift here changes
 *  document structure even if heading copy is unchanged. */
export const MEMO_SECTION_ORDER = [
  'header',
  'executive_summary',
  'stressed_credit_profile',
  'restructuring_package',
  'sponsor_burden',
  'risk_assessment',
  'committee_recommendation',
  // v1.1 — Open Items / Data Required (Phase C). Renders the deterministic
  // narrative.openItemsAndDataRequired prose. Appended AFTER committee_
  // recommendation so the reader's last substantive section is the verdict;
  // the open items list reads as a follow-on diligence punch list rather
  // than mixing with the committee's accept/condition language.
  'open_items',
  'footer',
] as const;
export type MemoSectionId = (typeof MEMO_SECTION_ORDER)[number];

/** Visible heading strings keyed by section id. The restructuring section
 *  has a variant title (cut vs. hold), surfaced separately below. */
export const MEMO_SECTION_HEADINGS: Readonly<Record<Exclude<MemoSectionId, 'header' | 'footer' | 'restructuring_package'>, string>> = {
  executive_summary:        'Executive Summary',
  stressed_credit_profile:  'Stressed Credit Profile',
  sponsor_burden:           'Sponsor Burden',
  risk_assessment:          'Risk Assessment',
  committee_recommendation: 'Committee Recommendation',
  open_items:               'Open Items / Data Required',
} as const;

/** Centerpiece section title — variant by whether the recommended package
 *  is a structure-first HOLD or a proceeds CUT. Both strings are
 *  format-grade; drift in either is a memo-shape change. */
export const MEMO_RESTRUCTURE_TITLES = {
  cut:  'Restructuring Package',
  hold: 'Structuring Package',
} as const;

/** Callout subheads inside the restructuring section. */
export const MEMO_RESTRUCTURE_SUBHEADS = {
  whyShape:                'Why this shape',
  compositionReconciliation: 'Composition reconciliation',
  orthogonalConditions:    'Structural conditions (orthogonal levers)',
} as const;

/** Recommended-package headline labels (cut vs. hold variant). */
export const MEMO_CALLOUT_LABELS = {
  cut:  'Recommended restructure',
  hold: 'Recommended structure',
} as const;

/** Missing-data string. fmtUsd / fmtPct / fmtDscr and the inline
 *  `auth.X ?? '—'` reads all use this character. Drift here changes how
 *  every null on the document presents. */
export const MEMO_NULL_SENTINEL = '—' as const;

/**
 * Canonical serialization for the format hash. The boot check feeds this
 * through computeContentHash (which canonicalizes — sorts keys at hash
 * time) and compares the digest to the manifest entry for the current
 * COMMITTEE_MEMO_VERSION.
 *
 * NOTE: MEMO_SECTION_ORDER is converted to an array of `{ position, id }`
 * pairs so the position is captured in the digest even though
 * canonicalize() sorts object keys — without the pairing, an array
 * reorder + duplicate would be silently equivalent. (Plain arrays are
 * preserved in canonicalize order; pairing is defensive belt-and-
 * suspenders so a future canonicalize impl change can't lose order.)
 */
export function buildCommitteeMemoHashSnapshot() {
  return {
    sectionOrder: MEMO_SECTION_ORDER.map((id, position) => ({ position, id })),
    sectionHeadings: MEMO_SECTION_HEADINGS,
    restructureTitles: MEMO_RESTRUCTURE_TITLES,
    restructureSubheads: MEMO_RESTRUCTURE_SUBHEADS,
    calloutLabels: MEMO_CALLOUT_LABELS,
    nullSentinel: MEMO_NULL_SENTINEL,
  };
}

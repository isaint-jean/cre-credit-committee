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
/**
 * v2.0 — Isabelle's institutional 13-section structure (memo v2). NARRATIVE-
 * FIRST: sections 1–10 build the investment case, the risks, the evidence, the
 * exit, and the validation as narrative — they do NOT lead with LTV / DSCR /
 * scores. Section 11 (Credit Structure) is the FIRST place leverage ratios and
 * sized mitigants appear. Sections 12–13 return to the thesis and the verdict.
 */
export const MEMO_SECTION_ORDER = [
  'header',
  'investment_overview',        // 1 — the deal, in plain terms
  'investment_merits',          // 2 — the case for the deal
  'key_credit_risks',           // 3 — loss paths in plain English
  'sponsor_assessment',         // 4 — sponsor read (honest-blank when absent)
  'tenant_analysis',            // 5 — tenancy / concentration / rollover
  'market_position',            // 6 — submarket (honest-blank when absent)
  'exit_refinance',             // 7 — can the loan exit at maturity (narrative)
  'appraisal_value_challenge',  // 8 — is the value real (narrative)
  'underwriting_validation',    // 9 — does the underwriting hold up (assumptions)
  'data_quality_review',        // 10 — what's missing vs what's unreliable
  'credit_structure',           // 11 — FIRST ratios / leverage / sized mitigants
  'committee_view',             // 12 — the committee's synthesis
  'final_recommendation',       // 13 — the thesis surviving the numbers
  'footer',
] as const;
export type MemoSectionId = (typeof MEMO_SECTION_ORDER)[number];

/** Visible heading strings keyed by section id (all sections except the
 *  structural header/footer). The restructuring callout inside Credit Structure
 *  keeps its own cut/hold variant title, surfaced separately below. */
export const MEMO_SECTION_HEADINGS: Readonly<Record<Exclude<MemoSectionId, 'header' | 'footer'>, string>> = {
  investment_overview:       'Investment Overview',
  investment_merits:         'Investment Merits',
  key_credit_risks:          'Key Credit Risks',
  sponsor_assessment:        'Sponsor Assessment',
  tenant_analysis:           'Tenant Analysis',
  market_position:           'Market & Competitive Position',
  exit_refinance:            'Exit & Refinance Analysis',
  appraisal_value_challenge: 'Appraisal & Value Challenge',
  underwriting_validation:   'Underwriting Validation',
  data_quality_review:       'Data Quality Review',
  credit_structure:          'Credit Structure',
  committee_view:            'Investment Committee View',
  final_recommendation:      'Final Recommendation',
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

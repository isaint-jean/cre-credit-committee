/**
 * FlagDetail — the render-time "how I determined this" content for a red flag, shared by
 * the deal-room modal (React) and the memo's inline <details> (server HTML). Assembled at
 * render from the finding + the re-run doctrine evaluation + the extraction — DISPLAY-ONLY,
 * never minted.
 *
 * ★ Honesty rule: `evidence[].source` is NEVER a fabricated document+page. It is one of the
 *   honest forms — "Underwriting inputs" (dimension-derived), "<document-kind> (page not
 *   captured)" (NOI), "Absence of <doc>" (data-quality), or "Not captured" (thin) — because
 *   most flags carry no named-document/page provenance.
 */

/** `tier` records how much grounded evidence the flag actually carries (for UI + audit). */
export type FlagDetailTier = 'rich' | 'message' | 'thin';

export interface FlagEvidence {
  /** What the figure/fact is (e.g. "Stressed LTV", "Trailing-12 actual NOI"). */
  readonly label: string;
  /** The value/finding, formatted for display. */
  readonly value: string;
  /** Where it came from — an honest attribution, NEVER a fabricated doc+page. */
  readonly source: string;
}

export interface FlagDetail {
  /** Stable id the deal-room matches on click (dimensionId / ruleId / banner key). */
  readonly flagId: string;
  /** A clear statement of the flag. */
  readonly statement: string;
  /** How it was determined — the reasoning/logic (dimension rationale, or the rule + threshold). */
  readonly howDetermined: string;
  /** The sourced evidence, named as text (not clickable). Empty when none is captured. */
  readonly evidence: readonly FlagEvidence[];
  readonly tier: FlagDetailTier;
}

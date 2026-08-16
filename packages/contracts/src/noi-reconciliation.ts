/**
 * NoiReconciliationDetail — the render-time "receipts" for a NOI-reconciliation red
 * flag (JE_NOI_DIVERGES_FROM_ASR / JE_NOI_BELOW_TRAILING_ACTUAL / UW_VS_T12_NOI_
 * RECONCILIATION). The compared NOI figures already exist on the ExtractionResult;
 * this is assembled AT RENDER TIME from those values (never minted onto the finding)
 * and shown inside a collapsible on the existing flag.
 *
 * ★ DISPLAY-ONLY. Source DOCUMENT only — no page number (page-level provenance is not
 *   captured for these figures; fabricating one would violate the grounding discipline).
 */

export interface NoiReconciliationRow {
  /** Human label, e.g. "Trailing-12 actual NOI". */
  readonly label: string;
  /** The figure, formatted for display (e.g. "$3,778,355"). */
  readonly valueFormatted: string;
  /** The source DOCUMENT the figure came from (e.g. "Asset Summary Report (ASR)").
   *  Deliberately NOT a page number — that provenance does not exist for these. */
  readonly sourceDocument: string;
}

export interface NoiReconciliationDetail {
  /** One row per compared figure that is actually PRESENT (absent figures omitted). */
  readonly rows: readonly NoiReconciliationRow[];
  /** A short, deterministic variance summary vs the concluded NOI, or null. */
  readonly variance: string | null;
}

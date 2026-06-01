/**
 * ExtractionResult — Stage-1 producer output.
 *
 * Pure mirror of source documents. NOT interpretation. NOT cleaning. NOT normalization.
 * The structured surface that downstream stages (Stage 4 judgment engine in particular) read
 * before any underwriting transform is applied.
 *
 * Architecture rule (§2): "AI is allowed as an extractor only. AI may NOT define underwriting
 * assumptions, override adjustments, or influence final metrics." This contract enforces that
 * boundary by giving extraction a strictly-typed surface; downstream consumers read these
 * fields and apply the underwriting transforms separately.
 *
 * Architecture rule (§8): "Missing inputs remain `null` through extraction." Every numeric
 * field is `number | null`; the extractor never substitutes 0 for missing data.
 */

import type {
  ContentHash,
  ExtractionResultId,
} from './identity.js';
import type {
  ExtractionEngineVersion,
  ISODateTime,
} from './versioning.js';

/* ------------------------- source-document provenance ----------------------- */

export const SOURCE_DOCUMENT_KINDS = [
  'rent_roll',
  /**
   * Generic CF / operating-statement document kind. Retained for back-compat;
   * new emissions prefer one of the three column-specific kinds below
   * ('t12_actual', 'in_place', 'seller_uw') so source-document refs are
   * traceable to the SPECIFIC column inside the workbook that produced data.
   */
  't12',
  /**
   * Strict T-12 / trailing-twelve column from the seller CF (the column whose
   * header reads "T-12", "Trailing Twelve", etc.). Distinct from 'in_place'
   * (current-rent column) and 'seller_uw' (issuer-underwriting column).
   * Added 2026-05-31 with the period-classification fix.
   */
  't12_actual',
  /**
   * In-Place / current column from the seller CF. Historically emitted under
   * the misleading kind 't12' due to a regex collision in the extractor that
   * the 2026-05-31 split fixed. New emissions use this kind.
   */
  'in_place',
  'pca',
  'appraisal',
  'asr',
  'seller_uw',
  'loan_terms',
  'property_metadata',
] as const;
export type SourceDocumentKind = (typeof SOURCE_DOCUMENT_KINDS)[number];

/**
 * Provenance ref to a source document. The `contentHash` is the hash of the document file's
 * bytes (not of the extraction output) — lets us detect drift if the same logical document
 * is re-uploaded with edits.
 */
export interface SourceDocumentRef {
  readonly kind: SourceDocumentKind;
  readonly contentHash: ContentHash;
}

/* --------------------------------- rent roll -------------------------------- */

export interface RentRollUnit {
  readonly unitId: string;
  readonly tenantName: string | null;            // null for vacant units
  readonly leaseStart: ISODateTime | null;
  readonly leaseEnd: ISODateTime | null;
  readonly baseRentMonthly: number | null;
  readonly inPlaceRentMonthly: number | null;
  readonly occupied: boolean;
  readonly concessions: number | null;           // dollars/month equivalent
  readonly securityDeposit: number | null;
}

export interface RentRollExtraction {
  readonly units: readonly RentRollUnit[];
  readonly summary: {
    readonly totalUnits: number;
    readonly occupiedUnits: number;
    readonly economicOccupancy: number | null;   // 0..1; null if not derivable
  };
}

/* ----------------------------- operating statement -------------------------- */

export interface OperatingStatementExtraction {
  readonly period: string;                        // free-form label (e.g., "T-12 ending Apr 2026")
  readonly income: {
    readonly grossPotentialRent: number | null;
    readonly effectiveRent: number | null;
    readonly otherIncome: number | null;
    readonly totalIncome: number | null;
  };
  readonly expenses: {
    readonly taxes: number | null;
    readonly insurance: number | null;
    readonly utilities: number | null;
    readonly repairsMaintenance: number | null;
    readonly managementFees: number | null;
    readonly generalAndAdmin: number | null;
    readonly janitorial: number | null;
    readonly reimbursements: number | null;
    readonly totalOperatingExpenses: number | null;
  };
  readonly noi: number | null;
  readonly vacancyLoss: number | null;
  /**
   * Line items reported below the NOI line in the source cash flow statement.
   * These are NCF adjustments, not operating expenses; per handbook P-III-3
   * they must be deducted from NOI to arrive at realistic NCF.
   */
  readonly belowNoiAdjustments: {
    readonly replacementReserves: number | null;
    readonly tenantImprovements: number | null;
    readonly leasingCommissions: number | null;
  };
}

/* ------------------------------------ PCA ----------------------------------- */

/**
 * PCA (Property Condition Assessment) extraction. Source: ASTM E2018-style
 * Property Condition Report PDF, prepared by an engineering firm for the lender.
 *
 * Phase 1+2 widening (#TBD, scoped against the Sunroad PCA fixture committed at
 * 431102d, design captured in v8 §14.1 of docs/specs/uw-template-populator/SPEC.md):
 * the shape carries Table 1 totals (immediate + short-term repair dollars),
 * Table 2 metadata (evaluation period, inflation rate, per-SF-per-year reserves),
 * Table 2 per-year capex schedules (inflated + uninflated), and the structural
 * narratives. Decisions 2 (no annual reserves field — derive downstream), 4 (no
 * structural-narrative widening), and 6 (no utility infrastructure field) are
 * reasons the contract is NOT widened in directions one might initially expect.
 */
export interface PCAExtraction {
  /**
   * Total dollars from Table 1's "Immediate Repair" column. Items that require
   * action at closing — reserved up-front (cell E49 in the template).
   */
  readonly immediateRepairs: number | null;

  /**
   * Total dollars from Table 1's "Short-Term Cost" column. Items that should be
   * addressed within ~2 years per ASTM E2018 — inform the year-1+ capex plan.
   * RENAMED from `nearTermRepairs` (Decision 5 / Item 6a of the implementation
   * recon — zero non-fixture consumers; clean rename eliminates the field-name
   * ambiguity). The Short-Term Cost column is structurally present in standard
   * PCA reports even when the total is $0 (Sunroad's case); return `null` only
   * if the column is structurally absent.
   */
  readonly shortTermRepairs: number | null;

  /**
   * Evaluation period from Table 2's header (e.g., "12-Year Replacement Reserve
   * Schedule"). Anchors the length of `capexScheduleInflated` / `capexScheduleUninflated`
   * — extractor post-processing enforces `evaluationPeriodYears === array.length`
   * by trusting the array and overriding the field when they disagree
   * (Item 6c of the recon).
   */
  readonly evaluationPeriodYears: number | null;

  /**
   * Annual inflation rate applied to the uninflated schedule to produce the
   * inflated schedule (e.g., 0.025 for 2.5%). Decimal fraction, NOT percent.
   */
  readonly inflationRate: number | null;

  /**
   * PCA-reported summary metric: average annual replacement reserve cost per
   * square foot, inflated dollars. Used as a cross-check value against the
   * primary derivation `sum(capexScheduleInflated) / evaluationPeriodYears`
   * (Item 6b of the recon).
   */
  readonly replacementReservesPerSfPerYearInflated: number | null;

  /**
   * Same metric as above, in uninflated (year-0) dollars.
   */
  readonly replacementReservesPerSfPerYearUninflated: number | null;

  /**
   * Year-by-year capex schedule in inflated dollars. One entry per year of the
   * evaluation period. Years with no scheduled capex emit
   * `{year: N, amount: 0}` — do NOT omit zero-amount years (would silently
   * misrepresent back-loaded capex profiles per v8 §10.4 Errata).
   *
   * Engine consumption: projected to the handbook field-bag as
   * `bag['capex_projection']` (a length-N array of amounts) for P-IV-RET-6's
   * `sum_over_term` formula.
   *
   * Extracted deterministically via pdfjs-dist's positional API (see
   * `apps/api/src/services/extract-pca-schedule.ts`) — issue #44 resolution,
   * v10. The v9 KNOWN LIMITATION here (50-60% per-year alignment accuracy)
   * was framed as PDF-format-structural; it was actually
   * extractor-choice-structural: `unpdf`'s `extractText({ mergePages: true })`
   * path stripped column positions, but pdfjs-dist (already accessible
   * through `unpdf`'s `getDocumentProxy`) preserves them. The deterministic
   * extractor reads Table 2's year-header row + the labeled
   * INFLATED/UNINFLATED totals rows directly.
   */
  readonly capexScheduleInflated: ReadonlyArray<{
    readonly year: number;     // 1-indexed
    readonly amount: number;   // dollars; 0 for years with no scheduled capex
  }> | null;

  /**
   * Same schedule in uninflated (year-0) dollars. Cross-source for the
   * inflated schedule; not consumed by the handbook engine directly.
   */
  readonly capexScheduleUninflated: ReadonlyArray<{
    readonly year: number;
    readonly amount: number;
  }> | null;

  /**
   * Condition narratives for the four major building-system categories.
   * 1-3 sentence summary of each system's condition + remaining useful life.
   * LLM_CONTEXT consumers (P-IV-MF-4, P-IV-MHC-1) read these for credit
   * narrative; no DET check reads them today. Decision 4: not widened to a
   * structured rating + narrative split — flat strings serve the handbook
   * principles adequately.
   */
  readonly structural: {
    readonly roof: string | null;
    readonly hvac: string | null;
    readonly plumbing: string | null;
    readonly electrical: string | null;
  };
}

/* --------------------------------- appraisal -------------------------------- */

export interface AppraisalExtraction {
  readonly valueConclusion: number | null;        // dollars
  readonly capRate: number | null;                // 0..1 fraction (NOT percent)
  readonly methodology: string | null;            // free-form (Income / Sales Comparison / Cost)
}

/* ------------------------------- seller UW + ASR ---------------------------- */

export interface SellerUWExtraction {
  readonly underwrittenNOI: number | null;
  readonly underwrittenRentGrowth: number | null;  // 0..1 fraction (annualized)
  readonly underwrittenVacancy: number | null;     // 0..1 fraction
}

export interface ASRExtraction {
  readonly impliedValue: number | null;
  readonly impliedCapRate: number | null;          // 0..1 fraction
  readonly underwrittenNOI: number | null;
}

/* -------------------------------- loan terms -------------------------------- */

export interface LoanTermsExtraction {
  readonly loanAmount: number | null;
  readonly interestRate: number | null;            // 0..1 annualized fraction
  readonly amortization: number | null;            // months
  readonly interestOnlyPeriod: number | null;      // months
  readonly maturityDate: ISODateTime | null;
}

/* ------------------------------ ExtractionResult ---------------------------- */

/**
 * Stage-1 record. `id` is the SHA-256 of the JCS canonical serialization of every field below
 * EXCEPT `id`. Producers compute the hash, brand as `ExtractionResultId`, attach.
 *
 * Re-extraction of the same source documents produces the same `id`; re-running with a different
 * `extractionEngineVersion` produces a new `id` (engine bump → new record).
 */
export interface ExtractionResult {
  readonly id: ExtractionResultId;
  readonly analysisAsOfDate: ISODateTime;
  readonly extractionEngineVersion: ExtractionEngineVersion;

  /** External deal identifier (e.g., loan number, opportunity name). Distinct from `id`. */
  readonly dealRef: string;

  readonly rentRoll: RentRollExtraction | null;
  /**
   * In-Place / current column from the seller CF (contractual rents currently
   * in effect, annualized).
   *
   * RENAMED 2026-05-31 from `t12` — that name was misleading because this slot
   * has always held the In-Place column when both In-Place and T-12 columns
   * exist in the source workbook (regex collision in the extractor + dedup
   * made the t12 column unreachable). The collision was fixed and the field
   * renamed in one atomic commit. Strict T-12 / trailing-twelve data, when
   * present in the source, now flows into the separate `t12Actual` slot.
   *
   * Class-(a) downstream fields (reserves, taxes, reimbursements, vacancyLoss,
   * totalOpEx) DO NOT read primarily from this slot — they cascade through
   * `t12Actual → sellerUwOperatingStatement → inPlace`. Neutral income lines
   * preserve the legacy semantic where In-Place wins the revenue baseline.
   */
  readonly inPlace: OperatingStatementExtraction | null;
  /**
   * Strict T-12 / trailing-twelve column extracted from the seller CF when
   * the source workbook actually exposes one (most CMBS-style seller CFs do
   * NOT — they show In-Place + GS U/W only, in which case this slot is null).
   *
   * Always null today on every deal whose source CF lacks a T-12 column. A
   * separate class-(b) ingest slot for true trailing operating statements
   * (T-12 P&L PDFs / spreadsheets uploaded as a 5th input) is planned but
   * NOT in scope here — when that lands, this field gains a second producer
   * and `JE_TRAILING_ACTUALS_MISSING` will stop firing on deals carrying a
   * T-12 statement. Until then, the field documents the gap honestly rather
   * than silently borrowing the In-Place column's data.
   *
   * Load-bearing consumer: `AdjustedInputs.metrics.trailingActualNoi` reads
   * `t12Actual.noi`. The NOI-reconciliation rule (P-III-15) uses
   * trailing-actual NOI as the truth floor for the issuer's underwritten NOI.
   */
  readonly t12Actual: OperatingStatementExtraction | null;
  readonly pca: PCAExtraction | null;
  readonly appraisal: AppraisalExtraction | null;
  readonly sellerUw: SellerUWExtraction | null;
  /**
   * Full operating-statement projection of the seller's underwriting column (the right-most
   * column in a Seller CF workbook — labels vary: "GS U/W", "Seller U/W", "Issuer UW"). Distinct
   * from `sellerUw` above, which carries only three summary fields (NOI / rent growth / vacancy)
   * consumed by the judgment source-cascade. This field mirrors the shape of `inPlace` so the
   * same downstream renderers can treat In-Place and Seller-UW columns symmetrically.
   *
   * Load-bearing for class-(a) downstream fields. Reserves, taxes,
   * reimbursements, vacancyLoss, and totalOpEx cascade through this slot
   * (preferring t12Actual when present, falling back to inPlace) because the
   * GS U/W column carries the issuer's adjustments — Prop 13 tax bases,
   * market-rent reimbursements, etc. Reading In-Place for these fields
   * understated reserves to $0 on Sunroad before the 2026-05-31 fix.
   *
   * Engine bump 1.0 → 1.1 introduced this field; pre-1.1 extractions did not carry it.
   */
  readonly sellerUwOperatingStatement: OperatingStatementExtraction | null;
  readonly asr: ASRExtraction | null;
  readonly loanTerms: LoanTermsExtraction | null;

  readonly sourceDocuments: readonly SourceDocumentRef[];

  /**
   * Per-sub-record extractor versions, stamped by the composer (Ticket D #?).
   *
   * Open-shaped Record<string, string>: keys are sub-record field names from
   * this contract (e.g., 'inPlace', 't12Actual', 'sellerUwOperatingStatement',
   * 'rentRoll', 'asr'); values are the adapter version strings that produced
   * the corresponding field's data. New adapters add new keys without contract
   * widening. (The historical 't12' key was renamed to 'inPlace' alongside
   * the 2026-05-31 field rename; producers that wrote 't12' before that date
   * are interpreted as having written In-Place data.)
   *
   * Composer emission rule: a key appears IFF the sub-record value is
   * non-null. Empty `{}` is valid for "no extractor produced data" (e.g.,
   * a synthesized extraction from caller-provided data only). For sub-records
   * with multiple potential producers (rentRoll: xlsx-adapter vs ASR-AI-fallback),
   * the version recorded is that of the adapter that won precedence (see
   * pickRentRoll's source field).
   *
   * `loanTerms` is intentionally NOT in this map — it's caller-provided via
   * the build-and-ingest route's `loanTerms` form field (Ticket K), not
   * extractor-produced. When a future extractLoanTerms adapter ships (parallel
   * to Ticket I's extractASR), it'll start emitting a 'loanTerms' key here.
   * Similarly, pca / appraisal will get adapter producers in later batches
   * and gain entries then.
   *
   * Part of the JCS-canonical hash input: bumping any adapter version
   * produces a new ExtractionResultId (same discipline as
   * extractionEngineVersion).
   */
  readonly extractorVersions: Record<string, string>;
}

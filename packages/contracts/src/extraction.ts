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
  't12',
  'pca',
  'appraisal',
  'asr',
  'seller_uw',
  'loan_terms',
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
    readonly totalOperatingExpenses: number | null;
  };
  readonly noi: number | null;
  readonly vacancyLoss: number | null;
}

/* ------------------------------------ PCA ----------------------------------- */

export interface PCAExtraction {
  readonly immediateRepairs: number | null;       // dollars
  readonly nearTermRepairs: number | null;        // dollars (year 1-5 typically)
  readonly structural: {
    readonly roof: string | null;                 // condition narrative
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
  readonly t12: OperatingStatementExtraction | null;
  readonly pca: PCAExtraction | null;
  readonly appraisal: AppraisalExtraction | null;
  readonly sellerUw: SellerUWExtraction | null;
  /**
   * Full operating-statement projection of the seller's underwriting column (the right-most
   * column in a Seller CF workbook — labels vary: "GS U/W", "Seller U/W", "Issuer UW"). Distinct
   * from `sellerUw` above, which carries only three summary fields (NOI / rent growth / vacancy)
   * consumed by the judgment source-cascade. This field mirrors the shape of `t12` so the same
   * downstream renderers can treat In-Place and Seller-UW columns symmetrically.
   *
   * Engine bump 1.0 → 1.1 introduced this field; pre-1.1 extractions did not carry it.
   */
  readonly sellerUwOperatingStatement: OperatingStatementExtraction | null;
  readonly asr: ASRExtraction | null;
  readonly loanTerms: LoanTermsExtraction | null;

  readonly sourceDocuments: readonly SourceDocumentRef[];
}

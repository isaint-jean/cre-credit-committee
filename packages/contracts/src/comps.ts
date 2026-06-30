/**
 * CRE loan/sale COMP records sourced from CMBS deals' SEC/EDGAR disclosures —
 * Form ABS-EE, Exhibit EX-102 (Schedule AL asset-data XML, Reg AB II /
 * 17 CFR 229.1125). Federally-defined fields → deterministic parse (no AI).
 *
 * ★ Comp basis = the issuer's AS-UNDERWRITTEN (securitization) snapshot — the
 *   standard comp basis. EX-102 carries LOAN/SALE comps (financials + value +
 *   coverage), NOT lease comps.
 *
 * ★ Pari-passu caveat: `loanPieceAmount` (= EX-102 originalLoanAmount) is the
 *   FILING DEAL'S PIECE of a split loan, NOT the whole-loan balance, so the
 *   piece-based LTV is NOT a reliable property LTV — flagged `ltvReliable:false`.
 *   Property financials (value/NOI/revenue/occupancy/SF/type) + DSCR are clean.
 */

/** Decoded property type (from EX-102 propertyTypeCode). 'Other' = unmapped. */
export type CmbsPropertyType =
  | 'Office' | 'Industrial' | 'Multifamily' | 'Retail'
  | 'Self-Storage' | 'Mixed-Use' | 'Lodging' | 'Health-Care' | 'Other';

export interface CompRecord {
  // — provenance (the SEC-primary source tier) —
  readonly sourceDeal: string;            // e.g. "BMARK 2024-V8"
  readonly assetNumber: string | null;    // Prospectus Loan ID within the deal
  readonly filingDate: string | null;     // ISO; the ABS-EE filing date
  readonly filingAccession: string | null;

  // — location —
  readonly propertyName: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly county: string | null;

  // — physical —
  readonly propertyType: CmbsPropertyType;
  readonly propertyTypeCodeRaw: string | null;   // raw code (pass-through if unmapped)
  readonly netRentableSF: number | null;
  readonly yearBuilt: number | null;

  // — valuation —
  readonly value: number | null;                 // valuationSecuritizationAmount
  readonly valuationDate: string | null;         // ISO
  readonly valuationSource: string | null;       // decoded (e.g. "MAI appraisal")
  readonly valuationSourceCodeRaw: string | null;

  // — financials (as-underwritten / securitization basis) —
  readonly noi: number | null;
  readonly ncf: number | null;
  readonly revenue: number | null;
  readonly operatingExpenses: number | null;
  readonly financialsDate: string | null;        // ISO

  // — occupancy (0..1 fraction; securitization/stabilized basis) —
  readonly occupancyPct: number | null;

  // — coverage (whole-loan, NOI basis — clean) —
  readonly dscr: number | null;

  // — computed —
  readonly capRate: number | null;               // noi / value

  // — loan (PIECE — pari-passu caveat) —
  readonly loanPieceAmount: number | null;       // this deal's piece, NOT whole-loan
  readonly ltvPiece: number | null;              // loanPieceAmount / value (NOT reliable)
  readonly ltvBasis: 'piece_only';
  readonly ltvReliable: false;                   // always false — piece, not whole-loan
  readonly interestRate: number | null;
  readonly originationDate: string | null;       // ISO
  readonly originatorName: string | null;

  // — tenant —
  readonly largestTenant: string | null;
  readonly largestTenantSF: number | null;
  readonly largestTenantLeaseExpiry: string | null;
}

/** Result of parsing one EX-102 asset-data file. */
export interface CmbsCompExtraction {
  readonly sourceDeal: string;
  readonly filingDate: string | null;
  readonly filingAccession: string | null;
  readonly comps: ReadonlyArray<CompRecord>;
  readonly assetCount: number;
}

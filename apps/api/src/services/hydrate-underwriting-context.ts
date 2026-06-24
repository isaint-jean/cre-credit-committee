/**
 * Hydration layer: ExtractionResult + AdjustedInputs → UnderwritingContext.
 *
 * Single canonical mapping that unifies the legacy numeric pipeline
 * (AdjustedInputs, derived from analysis.uwModel) with the new structured
 * extraction surface (analysis.extractionResult.descriptors / structural /
 * comparablesLinkageRefs).
 *
 * Hard rules:
 *   - Pure deterministic transformation. No I/O, no clock reads, no
 *     randomness, no inference, no library / example matching.
 *   - Same (analysis, adjustedInputs, mode) → same output, byte-for-byte.
 *   - Precedence policy is EXPLICIT (see PRECEDENCE below). Never silent.
 *   - Schema and render are NOT touched by this module. Atomic blocks land
 *     on UnderwritingContext as optional state that v7+ schemas can
 *     consume; the v6 schema does not read them.
 *
 * PRECEDENCE between AdjustedInputs and extractionResult.structural:
 *   For any logical field both surfaces could carry, AdjustedInputs WINS
 *   when its value is a finite number. extractionResult.structural is the
 *   fallback when AdjustedInputs has null / undefined / NaN. Rationale:
 *   AdjustedInputs is the established judgment-engine output that already
 *   incorporates missing-data penalties and overrides; the new extraction
 *   surface is raw and unjudged. The fallback path lets fields the legacy
 *   pipeline does not carry (yearBuilt, units, etc.) come through from
 *   extraction without contaminating the canonical numeric values.
 *
 *   For fields with no AdjustedInputs equivalent (propertyName, address,
 *   yearBuilt, occupancy, borrowerName, sponsorName, comparablesLinkageRefs),
 *   the property atoms layer prefers analysis.propertyMetadata (Batch 1H
 *   AI extractor) as PRIMARY and falls back to extractionResult.descriptors
 *   / structural. See buildPropertyAtoms below. Borrower/sponsor and the
 *   comparables refs are extractionResult-only (no Batch 1H equivalent).
 *
 *   AdjustedInputs is NOT BYPASSED — the route still composes it and feeds
 *   it to the schema layer separately. The hydrator only reads
 *   AdjustedInputs as a precedence input for the loan atoms; it does not
 *   modify or replace it.
 */
import type { AssetProfile } from '@cre/contracts';
import { ASSET_TYPE_LABELS } from '@cre/contracts';
import type {
  AdjustedInputs,
  Analysis,
  AssetType,
  PropertyLoanSummary,
  ConclusionAndEscrows,
  PropertyDetailNarrative,
  OperatingProFormaNarrative,
  StressScenarioNarrative,
  ThirdPartyReports,
  BorrowerProfile,
  MarketNarrative,
  SiteInspection,
  ComparablesNarrative,
  RollUpAggregation,
  UnderwritingContext,
  UnderwritingLoanAtoms,
  UnderwritingMode,
  UnderwritingPartyAtoms,
  UnderwritingPropertyAtoms,
} from '@cre/shared';
import type {
  FieldAuthorityRegistry,
  ResolvedRegistry,
} from './field-authority.types.js';
import {
  resolveFieldAuthorityRegistry,
  type ResolverSources,
} from './field-authority.resolver.js';

export interface HydrationSources {
  analysis: Analysis;
  adjustedInputs: AdjustedInputs;
  mode: UnderwritingMode;
  /**
   * Optional field-authority registry. When supplied, the hydrator runs the
   * registry resolver alongside the existing atomic-block flow and surfaces
   * its events on the returned HydrationOutcome. Existing context shape is
   * preserved — registry output does NOT overwrite atomic blocks today;
   * promotion happens cell-by-cell as render-schema entries land.
   */
  registry?: FieldAuthorityRegistry;
  /** Asset class for asset-aware overrides. Required when `registry` is set. */
  assetClass?: AssetType;
  /**
   * Optional asset profile. When supplied, `assetProfile.propertyType` is used
   * as a TERTIARY fallback for `property.type` (after propertyMetadata and
   * the extraction descriptors). Callers without an AssetProfile in scope
   * may omit it — the property-type cell simply stays at the prior
   * precedence chain's result.
   */
  assetProfile?: AssetProfile;
}

export interface HydrationOutcome {
  context: UnderwritingContext;
  /** Present iff a registry was supplied. Caller forwards events to the
   *  observability service; the hydrator never logs. */
  resolvedRegistry?: ResolvedRegistry;
}

/**
 * Returns the first finite number from the candidate list. Skips null,
 * undefined, NaN. Does NOT skip 0 (a legitimate value, e.g. ioMonths=0).
 */
function pickFirstFiniteNumber(candidates: Array<number | null | undefined>): number | null {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Returns the first non-null/non-empty string from the candidate list.
 */
function pickFirstString(candidates: Array<string | null | undefined>): string | null {
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Returns the first finite number from the candidate list.
 */
function pickFirstNumber(candidates: Array<number | null | undefined>): number | null {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Convert an ISO date string to an Excel date SERIAL number so the workbook's
 * date-formatted cells (e.g. Third Party Reports Summary!E4/E7, numFmt
 * "mm-dd-yy") render a clean date instead of the raw ISO string
 * "2023-07-13T00:00:00.000Z". Emitting a number (not text) lets Excel apply the
 * cell's existing date format. Excel's epoch is 1899-12-30 (serial 1 =
 * 1900-01-01); the standard days-since-epoch offset is exact for all dates the
 * appraisal carries (≫ 1900-03-01, past Excel's fictional 1900-02-29). Null /
 * unparseable → null (honest-blank, never 0).
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
function isoDateToExcelSerial(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.round((ms - EXCEL_EPOCH_MS) / 86_400_000);
}

// --- Atomic block builders -------------------------------------------------

// Property atoms precedence (Batch 1H integration):
//   analysis.propertyMetadata  (PRIMARY — clean ASR-AI extractor, Batch 1H)
//   extractionResult.descriptors / structural  (FALLBACK — older extractor
//     that can return template-resident placeholder text like "Management"
//     from the BP Spiral E3 cell; only trustworthy when no Batch 1H value)
// Rationale: propertyMetadata is sourced via a dedicated AI call against
// the source ASR text. The descriptors extractor occasionally captures
// values that originate from the template artifact itself rather than the
// source document — making it strictly weaker. Prefer the new source when
// present; fall back to descriptors so analyses created before Batch 1H
// continue to populate.
function buildPropertyAtoms(
  analysis: Analysis,
  assetProfile: AssetProfile | undefined,
): UnderwritingPropertyAtoms {
  const pm   = analysis.propertyMetadata;
  const desc = analysis.extractionResult?.descriptors;
  const stru = analysis.extractionResult?.structural;
  // Tertiary fallback for `type`: assetProfile.propertyType is a real value
  // on every deal that reaches doctrine evaluation. Used only when both
  // propertyMetadata.propertySubtype and extraction-descriptor propertyType
  // are absent — typical on bundles built before the Batch 1H AI extractor
  // ran (e.g. the Sunroad phase4 calibration bundle).
  const assetProfileLabel = assetProfile?.propertyType
    ? ASSET_TYPE_LABELS[assetProfile.propertyType]
    : null;
  return {
    name:              pickFirstString([pm?.propertyName,     desc?.propertyName.value]),
    street:            pickFirstString([pm?.address,          desc?.street.value]),
    city:              pickFirstString([pm?.city,             desc?.city.value]),
    state:             pickFirstString([pm?.state,            desc?.state.value]),
    zip:               pickFirstString([pm?.zip,              desc?.zip.value]),
    // county and ownershipInterest have no descriptor / structural source;
    // propertyMetadata is the only origin today.
    county:            pickFirstString([pm?.county]),
    type:              pickFirstString([pm?.propertySubtype,  desc?.propertyType.value, assetProfileLabel]),
    yearBuilt:         pickFirstNumber([pm?.yearBuilt,        stru?.yearBuilt.value]),
    totalSquareFeet:   pickFirstNumber([pm?.totalSquareFeet,  stru?.totalSquareFeet.value]),
    units:             stru?.units.value ?? null,
    occupancy:         pickFirstNumber([pm?.occupancyPhysical, stru?.occupancy.value]),
    ownershipInterest: pickFirstString([pm?.ownershipInterest]),
    // Sprint-0 additions — propertyMetadata is the only source for these.
    msa:               pickFirstString([pm?.msa]),
    yearRenovated:     pickFirstNumber([pm?.yearRenovated]),
    buildingClass:     pickFirstString([pm?.buildingClass]),
    numberOfBuildings: pickFirstNumber([pm?.numberOfBuildings]),
    // v12 — Loan Purpose → K27 (Property & Loan Summary). propertyMetadata-only,
    // mirroring buildingClass above.
    loanPurpose:       pickFirstString([pm?.loanPurpose]),
    // v15 — Note Date → C13 (the Note_Date named range). Anchored on the
    // appraisal as-is value date — the deal's valuation as-of (≈ note/period
    // anchor), emitted as an Excel date serial. (maturity − term is NOT used:
    // the reachable termMonths is the REMAINING term from analysisAsOfDate, not
    // the original note-to-maturity term, so it would point at the 2026 as-of.)
    // Honest-blank: null when no appraisal date → the period labels go blank,
    // never 1899 (epoch) or a today-leaked date.
    noteDate:          isoDateToExcelSerial(analysis.appraisalExtraction?.asIsValueDate ?? null),
  };
}

function buildLoanAtoms(
  analysis: Analysis,
  adjustedInputs: AdjustedInputs,
): UnderwritingLoanAtoms {
  const stru = analysis.extractionResult?.structural;
  // Per the v7 field-authority migration policy, extraction.structural is the
  // PRIMARY source. On graph-spine analyses that slot is not populated (the
  // new composer doesn't write extraction.structural — a known two-sided drop).
  // analysis.uwModel.loanDetails is the read-back of LoanTermsExtraction values
  // threaded through the synthesizer (see synthesize-uw-model-from-graph.ts);
  // when extraction.structural is empty, lift these values so the workbook's
  // Amortization_Term / Interest_Only_Period named ranges render and dependent
  // EDATE formulas don't error. Precedence stays single-source-per-value
  // (no double counting); the fallback only fires when the primary is null.
  const ld = analysis.uwModel?.loanDetails;
  return {
    termMonths: pickFirstFiniteNumber([
      stru?.loanTermMonths.value,        // resolvedContext-derived primary
      ld?.termMonths,                    // graph-spine fallback
      adjustedInputs.loan.termMonths,    // explicit fallback (term only)
    ]),
    amortizationMonths: pickFirstFiniteNumber([
      stru?.amortizationMonths.value,    // primary
      ld?.amortizationMonths,            // graph-spine fallback (load-bearing for workbook EDATE chain)
    ]),
    ioMonths: pickFirstFiniteNumber([
      stru?.ioMonths.value,              // primary
      ld?.ioMonths,                      // graph-spine fallback
    ]),
  };
}

function buildPartyAtoms(analysis: Analysis): UnderwritingPartyAtoms {
  // PRIMARY: the standalone partiesExtraction record (Sprint-2 parties seam,
  // populated by extract-parties-from-asr.ts and stamped onto analyses.data
  // via the run-once persist script). FALLBACK: the legacy data-extraction
  // service's descriptors slot, present only on classic ingest paths.
  const parties = analysis.partiesExtraction;
  const desc = analysis.extractionResult?.descriptors;
  return {
    borrowerName: pickFirstString([parties?.borrowerName, desc?.borrowerName.value]),
    sponsorName:  pickFirstString([parties?.sponsorName,  desc?.sponsorName.value]),
  };
}

function buildComparablesLinkageRefs(analysis: Analysis): string[] {
  return [...(analysis.extractionResult?.comparablesLinkageRefs ?? [])];
}

// --- Narrative section defaults --------------------------------------------
// All narrative sections are shipped null at this stage. The resolver
// translates null → DATA_NOT_PROVIDED. A future producer (or the next
// hydration phase) may compose narrative strings from the atomic blocks.

function emptyPropertyLoanSummary(): PropertyLoanSummary {
  return {
    propertyDescription:        null,
    loanTermsSummary:           null,
    sourcesAndUses:             null,
    ownershipSummary:           null,
    equityAndCashFlowAnalysis:  null,
    historicalOwnership:        null,
    annualCashFlowsCommentary:  null,
    generalAssetComments:       null,
    tenancySummaryCommentary:   null,
  };
}
function emptyConclusionAndEscrows(): ConclusionAndEscrows {
  return {
    loanSummary:             null,
    strengths:               [],
    weaknesses:              [],
    mitigants:               [],
    escrowSummary:           null,
    loanStructureCommentary: null,
  };
}
function emptyPropertyDetail(): PropertyDetailNarrative {
  return { propertyInformation: null, propertyRights: null, management: null, demographics: null, comments: null };
}
function emptyOperatingProForma(): OperatingProFormaNarrative {
  return { historicalOperatingCommentary: null, year1ProFormaCommentary: null, tenYearProFormaCommentary: null };
}
function emptyStress(): StressScenarioNarrative {
  return { stressMethodology: null, revenueDownsideCommentary: null, expenseUpsideCommentary: null, noiAndDscrCommentary: null };
}
function emptyTPR(): ThirdPartyReports {
  return { appraisalSummary: null, environmentalSummary: null, propertyConditionSummary: null };
}
function emptyBorrower(): BorrowerProfile {
  return { borrowerProfile: null, sponsorshipStrength: null };
}
function emptyMarket(): MarketNarrative {
  return { marketOverview: null, submarketTrends: null };
}
function defaultSiteInspection(): SiteInspection {
  // Per BP Spire spec, this tab is structurally inapplicable today.
  return { inspectionNotes: 'NOT_AVAILABLE', photos: 'NOT_AVAILABLE', maps: 'NOT_AVAILABLE' };
}
function defaultComparables(): ComparablesNarrative {
  return { leaseComps: 'REQUIRES_EXTERNAL_DATA', salesComps: 'REQUIRES_EXTERNAL_DATA', cmbsComps: 'REQUIRES_EXTERNAL_DATA' };
}

function buildRollUpStub(): RollUpAggregation {
  // Single-loan deals export with rollUpAggregation === null. Roll-up mode
  // requires a populated block; until a portfolio aggregator service lands,
  // ship a deterministic placeholder so the render-service invariant
  // (rollUpAggregation iff mode === 'roll_up') holds.
  return {
    loanCount: 1,
    aggregationMethodology: 'DATA_NOT_PROVIDED',
    normalizationCommentary: 'DATA_NOT_PROVIDED',
    constituentLoanIds: [],
  };
}

// --- Public entry point ----------------------------------------------------

/**
 * Produce the canonical UnderwritingContext for a deal. Pure deterministic
 * transformation over the three input surfaces (analysis, adjustedInputs,
 * mode). No I/O. No library lookups. No inference.
 */
export function hydrateUnderwritingContext(
  s: HydrationSources,
): UnderwritingContext {
  return {
    underwritingMode: s.mode,

    // Existing narrative sections — resolver translates null → sentinel.
    propertyLoanSummary:  emptyPropertyLoanSummary(),
    conclusionAndEscrows: emptyConclusionAndEscrows(),
    propertyDetail:       emptyPropertyDetail(),
    operatingProForma:    emptyOperatingProForma(),
    stressScenario:       emptyStress(),
    thirdPartyReports:    emptyTPR(),
    borrower:             emptyBorrower(),
    market:               emptyMarket(),
    siteInspection:       defaultSiteInspection(),
    comparables:          defaultComparables(),

    rollUpAggregation: s.mode === 'roll_up' ? buildRollUpStub() : null,

    // NEW atomic blocks — populated from extractionResult + AdjustedInputs.
    property:               buildPropertyAtoms(s.analysis, s.assetProfile),
    loan:                   buildLoanAtoms(s.analysis, s.adjustedInputs),
    parties:                buildPartyAtoms(s.analysis),
    comparablesLinkageRefs: buildComparablesLinkageRefs(s.analysis),

    // Sunroad appraisal-ingest — appraisal atoms surfaced for column J +
    // Conclusions. All-null when `analysis.appraisalExtraction` is absent.
    appraisal: buildAppraisalAtoms(s.analysis),
    // Sprint-2 PCA atoms — two values surfaced for Third Party Reports
    // Summary E24/E25 and Conclusions & Escrows D50 escrow row.
    pca: buildPcaAtoms(s.analysis),
    // Sprint-1 Column L issuer-UW atoms — seller GS U/W column for
    // Operating ProForma L9–L40.
    issuerUw: buildIssuerUwAtoms(s.analysis),
    // T12 historical-actuals atoms (column H). Same shape as issuerUw.
    t12: buildT12Atoms(s.analysis),
    // Sources & Uses atoms — ASR S&U table for Property & Loan Summary
    // F28–F31 / K30. All-null when `analysis.sourcesAndUses` is absent.
    sourcesUses: buildSourcesUsesAtoms(s.analysis),
  };
}

/** Atom-builder for Sources & Uses cells. Returns all-null when absent. */
function buildSourcesUsesAtoms(analysis: Analysis): Record<string, number | null> {
  const su = analysis.sourcesAndUses;
  return {
    loanAmount:           su?.loanAmount ?? null,
    loanPayoff:           su?.loanPayoff ?? null,
    returnOfEquity:       su?.returnOfEquity ?? null,
    unfundedObligations:  su?.unfundedObligations ?? null,
    capitalExpenditures:  su?.capitalExpenditures ?? null,
    closingCosts:         su?.closingCosts ?? null,
    purchasePrice:        su?.purchasePrice ?? null,
    totalCostBasis:       su?.totalCostBasis ?? null,
  };
}

/** Atom-builder for appraisal-sourced cells. Returns all-null when absent. */
function buildAppraisalAtoms(analysis: Analysis): Record<string, number | string | null> {
  const apx = analysis.appraisalExtraction;
  if (!apx) {
    return {
      pgr: null, economicOccupancy: null, physicalOccupancy: null, badDebt: null,
      otherIncomeGross: null, netEffectiveReimbursements: null,
      expensesGeneralAdmin: null, expensesRepairsMaintenance: null,
      expensesUtilities: null, expensesOtherVariable: null, expensesManagement: null,
      expensesTaxes: null, expensesInsurance: null, capex: null,
      asIsValue: null, asStabilizedValue: null, landValue: null,
      overallCapRate: null, terminalCapRate: null, discountRate: null,
      stabilizedNOI: null, currentNOI: null, stabilizationMonths: null,
      grossBuildingArea: null, numberOfStories: null,
      perAppraisalCapex: null,
    };
  }
  const sp = apx.stabilizedProForma;
  const cp = apx.currentProForma;
  // Economic occupancy (J6) derives from vacancyPct so the template's J10 vacancy-loss formula
  // (= -J9*(1-J6)) reproduces the appraiser's stated vacancyLoss exactly.
  const economicOccupancy = sp?.vacancyPct !== null && sp?.vacancyPct !== undefined
    ? 1 - sp.vacancyPct
    : null;
  // J11 Bad Debt = credit loss (negative)
  const badDebt = sp?.creditLoss ?? null;
  // J26 "Other (variable)" rolls Janitorial + Nonreimbursable Landlord so the
  // expense subtotal ties to stated totalOperatingExpenses.
  const expensesOtherVariable = (sp?.janitorial ?? 0) + (sp?.nonreimbursableLandlord ?? 0);
  return {
    pgr:                            sp?.potentialRentalIncome ?? null,
    economicOccupancy,
    physicalOccupancy:              apx.stabilizedOccupancy ?? null,
    badDebt,
    otherIncomeGross:               sp?.otherIncomeGross ?? null,
    netEffectiveReimbursements:     sp?.netEffectiveReimbursements ?? null,
    expensesGeneralAdmin:           sp?.generalOperating ?? null,
    expensesRepairsMaintenance:     sp?.repairsMaintenance ?? null,
    expensesUtilities:              sp?.utilities ?? null,
    expensesOtherVariable:          expensesOtherVariable || null,
    expensesManagement:             sp?.managementFee ?? null,
    expensesTaxes:                  sp?.realEstateTaxes ?? null,
    expensesInsurance:              sp?.insurance ?? null,
    capex:                          sp?.replacementReserves ?? null,
    asIsValue:                      apx.asIsValue ?? null,
    asStabilizedValue:              apx.asStabilizedValue ?? null,
    landValue:                      apx.landValue ?? null,
    overallCapRate:                 apx.overallCapRate ?? null,
    terminalCapRate:                apx.terminalCapRate ?? null,
    discountRate:                   apx.discountRate ?? null,
    stabilizedNOI:                  sp?.netOperatingIncome ?? null,
    currentNOI:                     cp?.netOperatingIncome ?? null,
    stabilizationMonths:            apx.stabilizationMonths ?? null,
    grossBuildingArea:              apx.grossBuildingArea ?? null,
    numberOfStories:                apx.numberOfStories ?? null,
    // Per-Appraisal escrow recommendation (Conclusions & Escrows D49). CBRE
    // does not break out replacement-reserves as a stabilized pro-forma line
    // ($0 there); the appraiser's capex equivalent is the Nonreimbursable
    // Landlord deduction, which we surface here separately so D49 reflects
    // an escrow target rather than the literal $0 row.
    //
    // Phase B — field-name fix: read directly from the extracted
    // `stabilizedProForma.nonreimbursableLandlord` ($54,952 for Sunroad,
    // already in the bundle) instead of `perAppraisalReserves.replacement
    // Reserves` (which the extractor never populates because the appraisal's
    // literal "Replacement Reserves" pro-forma row is $0; the operative
    // escrow figure lives one row up as "Nonreimbursable Landlord
    // Expense"). The atom is still labeled `perAppraisalCapex` because
    // that's the schema-side contract; only the read path changes.
    perAppraisalCapex:              apx.stabilizedProForma?.nonreimbursableLandlord ?? null,
    // Sprint-2: dates lifted for Third Party Reports Summary E4 / E7.
    // Emit Excel date SERIALS (numbers) so the cells' "mm-dd-yy" format renders
    // a clean date, not the raw ISO string ("2023-07-13T00:00:00.000Z").
    asIsValueDate:                  isoDateToExcelSerial(apx.asIsValueDate),
    asStabilizedValueDate:          isoDateToExcelSerial(apx.asStabilizedValueDate),
    insurableValue:                 apx.insurableValue ?? null,
  };
}

// Sprint-2: PCA atoms. Surfaces the two PCA values consumed by the Third
// Party Reports Summary tab + Conclusions & Escrows D50 escrow row. All-null
// when extractionResult.pca is absent (no PCA ingested). Adding new PCA
// surfaces beyond these two (firm/date/seismic/RECs) requires extending
// extract-pca.ts first — those fields are not in the contract today.
// Sprint-1: Issuer-UW atoms. The seller's GS U/W column lifted off the
// graph-spine ExtractionResult.sellerUwOperatingStatement. Feeds Operating
// ProForma column L. economicOccupancy is derived from vacancyLoss / PGR so
// the template's L10 vacancy formula reproduces the issuer's stated value.
// expensesOtherVariable rolls janitorial into the "Other (variable)" row
// (same convention as the appraisal J26 wiring).
function buildIssuerUwAtoms(analysis: Analysis): Record<string, number | string | null> {
  const uw = analysis.issuerUwExtraction;
  if (!uw) {
    return {
      pgr: null, economicOccupancy: null, badDebt: null,
      uwAdjustments: null, otherIncome: null, reimbursements: null,
      expensesGeneralAdmin: null, expensesRepairsMaintenance: null,
      expensesUtilities: null, expensesOtherVariable: null,
      expensesManagement: null, expensesTaxes: null, expensesInsurance: null,
      capex: null, tenantImprovements: null, leasingCommissions: null,
    };
  }
  const pgr = uw.income.grossPotentialRent;
  const economicOccupancy =
    typeof pgr === 'number' && pgr > 0 && typeof uw.vacancyLoss === 'number'
      ? 1 - (-uw.vacancyLoss / pgr)
      : null;
  return {
    pgr,
    economicOccupancy,
    badDebt:                       null,
    uwAdjustments:                 uw.income.uwAdjustments ?? null,
    otherIncome:                   uw.income.otherIncome ?? null,
    reimbursements:                uw.expenses.reimbursements ?? null,
    expensesGeneralAdmin:          uw.expenses.generalAndAdmin ?? null,
    expensesRepairsMaintenance:    uw.expenses.repairsMaintenance ?? null,
    expensesUtilities:             uw.expenses.utilities ?? null,
    expensesOtherVariable:         uw.expenses.janitorial ?? null,
    expensesManagement:            uw.expenses.managementFees ?? null,
    expensesTaxes:                 uw.expenses.taxes ?? null,
    expensesInsurance:             uw.expenses.insurance ?? null,
    capex:                         uw.belowNoiAdjustments.replacementReserves ?? null,
    tenantImprovements:            uw.belowNoiAdjustments.tenantImprovements ?? null,
    leasingCommissions:            uw.belowNoiAdjustments.leasingCommissions ?? null,
  };
}

/** Atom-builder for the T12 historical column (H). Same mapping as
 *  buildIssuerUwAtoms; reads analysis.t12Extraction. All-null when absent. */
function buildT12Atoms(analysis: Analysis): Record<string, number | string | null> {
  const t12 = analysis.t12Extraction;
  // v18 — display notes (independent of the numeric extraction).
  const vintage = analysis.t12Notes?.vintage ?? null;
  const creditSignal = analysis.t12Notes?.creditSignal ?? null;
  if (!t12) {
    return {
      pgr: null, economicOccupancy: null, badDebt: null,
      uwAdjustments: null, otherIncome: null, reimbursements: null,
      expensesGeneralAdmin: null, expensesRepairsMaintenance: null,
      expensesUtilities: null, expensesOtherVariable: null,
      expensesManagement: null, expensesTaxes: null, expensesInsurance: null,
      capex: null, tenantImprovements: null, leasingCommissions: null,
      totalIncome: null, periodYear: null,
      vintage, creditSignal,
    };
  }
  // v22 — total income (t12 carries no PGI breakdown, only the total) + the
  // period year parsed from e.g. "Trailing 12 (2/29/2024)" → 2024. Drive the
  // Operating History T12 column (H17 total revenues → NOI formula) + row-3
  // year headers (kills the YEAR(Note_Date)/YEAR(TODAY()) template-formula bug).
  const periodYear = (() => {
    const m = t12.period?.match(/(\d{4})\s*\)/) ?? t12.period?.match(/\b(\d{4})\b/);
    return m ? Number(m[1]) : null;
  })();
  const pgr = t12.income.grossPotentialRent;
  const economicOccupancy =
    typeof pgr === 'number' && pgr > 0 && typeof t12.vacancyLoss === 'number'
      ? 1 - (-t12.vacancyLoss / pgr)
      : null;
  return {
    pgr,
    economicOccupancy,
    badDebt:                       null,
    uwAdjustments:                 t12.income.uwAdjustments ?? null,
    otherIncome:                   t12.income.otherIncome ?? null,
    reimbursements:                t12.expenses.reimbursements ?? null,
    expensesGeneralAdmin:          t12.expenses.generalAndAdmin ?? null,
    expensesRepairsMaintenance:    t12.expenses.repairsMaintenance ?? null,
    expensesUtilities:             t12.expenses.utilities ?? null,
    expensesOtherVariable:         t12.expenses.janitorial ?? null,
    expensesManagement:            t12.expenses.managementFees ?? null,
    expensesTaxes:                 t12.expenses.taxes ?? null,
    expensesInsurance:             t12.expenses.insurance ?? null,
    capex:                         t12.belowNoiAdjustments.replacementReserves ?? null,
    tenantImprovements:            t12.belowNoiAdjustments.tenantImprovements ?? null,
    leasingCommissions:            t12.belowNoiAdjustments.leasingCommissions ?? null,
    totalIncome:                   t12.income.totalIncome ?? null,
    periodYear,
    vintage, creditSignal,
  };
}

function buildPcaAtoms(analysis: Analysis): Record<string, number | string | null> {
  const pca = analysis.pcaExtraction;
  if (!pca) {
    return {
      replacementReservesPerSfPerYearInflated: null,
      immediateRepairs:                        null,
    };
  }
  return {
    replacementReservesPerSfPerYearInflated: pca.replacementReservesPerSfPerYearInflated ?? null,
    immediateRepairs:                        pca.immediateRepairs ?? null,
  };
}

/**
 * Combined entry point: runs the existing atomic-block hydration AND, when
 * a field-authority registry is supplied, runs the two-phase registry
 * resolver. Registry output is returned alongside the context — caller
 * decides what to do with the events (typically: forward to the
 * observability service).
 *
 * The registry path is purely additive: existing UnderwritingContext shape
 * is unchanged. Cells with resolutionState === 'mapped' or 'derived'
 * produce real values in `resolvedRegistry.fields`; 'unmapped' cells are
 * blank with AWAITING_CONTEXT_SHAPE events.
 */
export function hydrateWithRegistry(
  s: HydrationSources,
): HydrationOutcome {
  const context = hydrateUnderwritingContext(s);
  if (!s.registry) return { context };

  if (!s.assetClass) {
    // Caller gave us a registry but no asset class — without an assetClass
    // we cannot apply suppressedFor / assetOverrides correctly. Return the
    // context without resolving rather than guessing.
    return { context };
  }

  // Build the registry resolver's source bag. The 'context' surface mirrors
  // the eventual UnderwritingContext shape — most paths declared on FieldRef
  // bindings remain `unmapped` today, so the source bag is sparsely populated
  // from the existing atomic blocks.
  const resolverSources: ResolverSources = {
    context: contextSourceBag(context),
    adjustedInputs: s.adjustedInputs,
    assetClass: s.assetClass,
    mode: s.mode,
  };

  const { resolved } = resolveFieldAuthorityRegistry(s.registry, resolverSources);
  return { context, resolvedRegistry: resolved };
}

/**
 * Adapter from the existing UnderwritingContext shape (3 atomic blocks +
 * narratives) into the flat dotted-path bag the registry resolver reads.
 *
 * Only the paths that the registry's currently-`mapped` entries reference
 * are populated. All other extraction paths declared by `unmapped` entries
 * resolve to undefined → no candidate → AWAITING_CONTEXT_SHAPE event.
 */
function contextSourceBag(ctx: UnderwritingContext): Record<string, unknown> {
  const bag: Record<string, unknown> = {};

  if (ctx.property) {
    bag.property = {
      name:              ctx.property.name,
      street:            ctx.property.street,
      city:              ctx.property.city,
      state:             ctx.property.state,
      zip:               ctx.property.zip,
      county:            ctx.property.county,
      type:              ctx.property.type,
      yearBuilt:         ctx.property.yearBuilt,
      totalSquareFeet:   ctx.property.totalSquareFeet,
      occupancy:         ctx.property.occupancy,
      ownershipInterest: ctx.property.ownershipInterest,
    };
  }
  if (ctx.loan) {
    bag.loan = {
      termMonths:         ctx.loan.termMonths,
      amortizationMonths: ctx.loan.amortizationMonths,
      ioMonths:           ctx.loan.ioMonths,
    };
  }
  if (ctx.parties) {
    bag.parties = {
      borrowerName: ctx.parties.borrowerName,
      sponsorName:  ctx.parties.sponsorName,
    };
  }
  return bag;
}

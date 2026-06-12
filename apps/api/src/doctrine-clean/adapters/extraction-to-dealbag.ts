/**
 * doctrine-clean / adapters / extraction-to-dealbag.ts
 *
 * Clean-room INPUT adapter: ExtractionResult + PropertyMetadata → DealBag.
 *
 * Pure function. Reads ONLY raw extraction + property metadata. NEVER reads:
 *   - AdjustedInputs (any field — .raw or .adjusted)
 *   - valuationConclusion (judgment-derived value with caps/haircuts)
 *   - metrics.noi (judgment-derived NOI with cap + source cascade)
 *   - handbook output
 *   - any judgment-engine-derived field
 *
 * The fence is the load-bearing discipline: the clean doctrine's input path
 * is severed from the contaminated judgment engine. We read the issuer's
 * raw numbers and apply our own provenanced normalization downstream.
 *
 * SOURCE MAP — resolved in step 2 of the retire-old discovery:
 *
 *   RAW READS (9):
 *     assetType         — caller-provided (cleanest source is AssetProfile.propertyType
 *                         which is pass-through from extraction; the AssetProfile RECORD
 *                         exists but we do NOT read it because its `marketLiquidity`
 *                         sibling field is judgment-laden — we accept assetType as an
 *                         explicit input parameter, falling back to a heuristic over
 *                         PropertyMetadata.propertySubtype if not provided)
 *     subType           — PropertyMetadata.propertySubtype
 *     loanAmount        — extraction.loanTerms.loanAmount
 *     coupon            — extraction.loanTerms.interestRate
 *     concludedValue    — pickConcludedValue: appraisal.valueConclusion ?? asr.impliedValue
 *     uwY1Noi           — pickIssuerNoi: sellerUwOperatingStatement.noi
 *                         ?? sellerUw.underwrittenNOI ?? asr.underwrittenNOI
 *     t12Noi            — extraction.t12Actual.noi (universally null today until class-(b) lands)
 *     occupancy         — pickOccupancy: propertyMetadata.occupancyEconomic
 *                         ?? occupancyPhysical ?? 1 − sellerUw.underwrittenVacancy
 *     amortMonths       — extraction.loanTerms.amortization
 *
 *   TRIVIAL CLEAN DERIVATIONS (4):
 *     largestTenantPct  — sum baseRentMonthly per tenant over rentRoll.units, top/total
 *                         (annualizes baseRentMonthly × 12; pure data reduction)
 *     tenantDataStatus  — state machine: na-by-asset-type / multi-tenant-parsed
 *                         / single-tenant / parse-failed / null
 *     pctIncomeExpiringWithinTerm — share of annualized rent with leaseEnd < maturityDate
 *     ioYears           — extraction.loanTerms.interestOnlyPeriod / 12
 *
 *   FIRST-CUTOVER DECISIONS:
 *     marketTier        — 'Unknown'. Cap-rate dim treats Unknown as 0 bps; matches current
 *                         corpus state. Clean-source via DBRS / MSCI-RCA primary-market
 *                         lists is a SEPARATE later task.
 *     termYears         — null. Refi dim degenerates gracefully to IO-no-paydown on missing
 *                         term. We do NOT use AdjustedInputs.loan.termMonths.raw as a
 *                         stop-gap (stays 100% off judgment output). Add originationDate
 *                         to extraction as a SEPARATE later task.
 *
 * NO IMPORTS FROM JUDGMENT / OLD DOCTRINE / HANDBOOK / VALUATION-CONCLUSION.
 */
import type {
  ExtractionResult,
  RentRollExtraction,
  ISODateTime,
} from '@cre/contracts';
import type { PropertyMetadata } from '@cre/contracts';
import type { AssetType } from '@cre/contracts';
import type { DealBag } from '../scoring/evaluate-deal.js';

export interface AdapterOptions {
  /**
   * Explicit asset-type classification, when the caller has it (e.g. from
   * AssetProfile.propertyType which is pass-through from extraction).
   * When null/undefined, the adapter falls back to a heuristic over
   * PropertyMetadata.propertySubtype. The adapter NEVER reads
   * AssetProfile.marketLiquidity (judgment-laden curated table).
   */
  readonly explicitAssetType?: AssetType | null;
}

/* ---------------- raw-read pick helpers (pure data reduction) -------------- */

/**
 * Pick the issuer's underwritten Y1 NOI. Three RAW sources, in agency
 * preference order:
 *   1. sellerUwOperatingStatement.noi (GS U/W column inside the CF workbook
 *      — the issuer's full UW projection, most internally consistent)
 *   2. sellerUw.underwrittenNOI (the narrative SellerUW document — three
 *      summary fields only)
 *   3. asr.underwrittenNOI (the ASR document)
 *
 * We deliberately do NOT read AdjustedInputs.metrics.noi (judgment-laden:
 * NOI cap + source cascade + library substitution + missing-data penalty).
 * The clean doctrine wants the raw issuer figure as input; its own
 * sustainable-cashflow normalization applies the haircuts.
 */
export function pickIssuerNoi(extraction: ExtractionResult): number | null {
  if (extraction.sellerUwOperatingStatement?.noi !== undefined &&
      extraction.sellerUwOperatingStatement?.noi !== null) {
    return extraction.sellerUwOperatingStatement.noi;
  }
  if (extraction.sellerUw?.underwrittenNOI !== undefined &&
      extraction.sellerUw?.underwrittenNOI !== null) {
    return extraction.sellerUw.underwrittenNOI;
  }
  if (extraction.asr?.underwrittenNOI !== undefined &&
      extraction.asr?.underwrittenNOI !== null) {
    return extraction.asr.underwrittenNOI;
  }
  return null;
}

/**
 * Pick the issuer's concluded value. Two RAW sources:
 *   1. appraisal.valueConclusion (the appraised value — preferred)
 *   2. asr.impliedValue (ASR's implied value — fallback)
 *
 * We deliberately do NOT read valuationConclusion.finalValue (judgment-
 * derived: passes through buildValuationConclusion with caps/haircuts).
 * The clean doctrine wants the raw issuer concluded value as the
 * comparator against its own stressed-value computation.
 */
export function pickConcludedValue(extraction: ExtractionResult): number | null {
  if (extraction.appraisal?.valueConclusion !== undefined &&
      extraction.appraisal?.valueConclusion !== null) {
    return extraction.appraisal.valueConclusion;
  }
  if (extraction.asr?.impliedValue !== undefined &&
      extraction.asr?.impliedValue !== null) {
    return extraction.asr.impliedValue;
  }
  return null;
}

/**
 * Pick underwritten occupancy in [0, 1]. Three RAW sources:
 *   1. PropertyMetadata.occupancyEconomic (preferred — economic basis)
 *   2. PropertyMetadata.occupancyPhysical (physical basis)
 *   3. 1 − extraction.sellerUw.underwrittenVacancy (derived from sellerUw)
 */
export function pickOccupancy(
  propertyMetadata: PropertyMetadata | null,
  extraction: ExtractionResult,
): number | null {
  if (propertyMetadata?.occupancyEconomic !== undefined &&
      propertyMetadata?.occupancyEconomic !== null) {
    return propertyMetadata.occupancyEconomic;
  }
  if (propertyMetadata?.occupancyPhysical !== undefined &&
      propertyMetadata?.occupancyPhysical !== null) {
    return propertyMetadata.occupancyPhysical;
  }
  const uv = extraction.sellerUw?.underwrittenVacancy;
  if (uv !== undefined && uv !== null && uv >= 0 && uv <= 1) {
    return 1 - uv;
  }
  return null;
}

/* ----------------- trivial clean derivations from rent roll --------------- */

/**
 * Compute the top tenant's annualized-rent share from the rent roll.
 * Sums baseRentMonthly per tenant name (or inPlaceRentMonthly as fallback),
 * annualizes (× 12), then picks the top-share tenant. Vacant units
 * (tenantName === null) are excluded.
 *
 * Returns null when rentRoll is null OR no occupied units have rent.
 *
 * This is the rent-basis (per spec v2 §5 preferred — base-rent share); the
 * dim is informed via the `largestTenantBasis` field on its input. We pass
 * 'base-rent' from this adapter (not 'NRA' like the clean-corpus body-page
 * extractor — that uses SF share). Asset class is needed for the
 * applicability gate; the dim handles it.
 */
export function deriveTopTenantShare(rentRoll: RentRollExtraction | null): number | null {
  if (rentRoll === null) return null;
  const occupied = rentRoll.units.filter(u => u.tenantName !== null);
  if (occupied.length === 0) return null;
  // Group by tenantName; aggregate annualized rent. Prefer baseRentMonthly;
  // fall back to inPlaceRentMonthly when baseRent is unavailable.
  const byTenant: Map<string, number> = new Map();
  for (const u of occupied) {
    const monthly = u.baseRentMonthly ?? u.inPlaceRentMonthly;
    if (monthly === null || monthly <= 0) continue;
    const annual = monthly * 12;
    const prev = byTenant.get(u.tenantName!) ?? 0;
    byTenant.set(u.tenantName!, prev + annual);
  }
  if (byTenant.size === 0) return null;
  const total = Array.from(byTenant.values()).reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  const top = Math.max(...Array.from(byTenant.values()));
  return top / total;
}

/**
 * Tenant-based asset classes per the agency convention. Mirrors the
 * dim 5 / dim 6 applicability gates (must stay in sync; the constant
 * lives here only because the adapter routes on it independently of
 * the dim's risk math).
 */
const TENANT_BASED_TYPES: ReadonlySet<string> = new Set([
  'Retail',
  'Office',
  'Industrial',
  'MixedUse',
]);

const UNIT_OR_ROOM_BASED_TYPES: ReadonlySet<string> = new Set([
  'Hotel',
  'Multifamily',
  'MHC',
  'SelfStorage',
]);

export type TenantDataStatus =
  | 'multi-tenant-parsed'
  | 'single-tenant'
  | 'na-by-asset-type'
  | 'parse-failed'
  | null;

/**
 * Derive the tenant-data status. State machine:
 *   - assetType ∈ {Hotel, Multifamily, MHC, SelfStorage}: 'na-by-asset-type'
 *   - rentRoll has ≥ 2 distinct occupied tenant names: 'multi-tenant-parsed'
 *   - rentRoll has exactly 1 occupied tenant: 'single-tenant'
 *   - assetType tenant-based but rentRoll is null: 'parse-failed'
 *   - assetType null/unknown and rentRoll null: null
 */
export function deriveTenantDataStatus(
  rentRoll: RentRollExtraction | null,
  assetType: AssetType | null,
): TenantDataStatus {
  if (assetType !== null && UNIT_OR_ROOM_BASED_TYPES.has(assetType)) {
    return 'na-by-asset-type';
  }
  if (rentRoll === null) {
    if (assetType !== null && TENANT_BASED_TYPES.has(assetType)) return 'parse-failed';
    return null;
  }
  const occupiedNames = new Set(
    rentRoll.units
      .filter(u => u.tenantName !== null)
      .map(u => u.tenantName!),
  );
  if (occupiedNames.size === 0) return 'parse-failed';
  if (occupiedNames.size === 1) return 'single-tenant';
  return 'multi-tenant-parsed';
}

/**
 * Compute the share of annualized rent expiring before the loan maturity.
 * Sums baseRentMonthly × 12 per unit; flags units whose leaseEnd precedes
 * maturityDate; returns flagged / total.
 *
 * Returns null when rentRoll is null OR maturityDate is null.
 */
export function deriveRolloverShare(
  rentRoll: RentRollExtraction | null,
  maturityDate: ISODateTime | null,
): number | null {
  if (rentRoll === null || maturityDate === null) return null;
  const matDate = new Date(maturityDate);
  if (Number.isNaN(matDate.getTime())) return null;
  let totalAnnual = 0;
  let expiringAnnual = 0;
  for (const u of rentRoll.units) {
    if (u.tenantName === null) continue;
    const monthly = u.baseRentMonthly ?? u.inPlaceRentMonthly;
    if (monthly === null || monthly <= 0) continue;
    const annual = monthly * 12;
    totalAnnual += annual;
    if (u.leaseEnd !== null) {
      const endDate = new Date(u.leaseEnd);
      if (!Number.isNaN(endDate.getTime()) && endDate < matDate) {
        expiringAnnual += annual;
      }
    }
  }
  if (totalAnnual <= 0) return null;
  return expiringAnnual / totalAnnual;
}

/* ---------------- assetType-from-subtype heuristic fallback --------------- */

/**
 * Heuristic mapping from PropertyMetadata.propertySubtype free-form strings
 * to the contracts' AssetType enum. Used ONLY when the caller does not
 * provide an explicitAssetType. The mapping is conservative; unrecognized
 * strings return null (downstream dims route to HITL).
 */
function deriveAssetTypeFromSubtype(propertySubtype: string | null): AssetType | null {
  if (propertySubtype === null) return null;
  const s = propertySubtype.toLowerCase();
  if (/\boffice\b|cbd|suburban\s*office|medical\s*office/.test(s))    return 'Office';
  if (/\bmultifamily\b|garden|mid.?rise|high.?rise|student\s*housing/.test(s)) return 'Multifamily';
  if (/\bhotel\b|hospitality|full\s*service|limited\s*service|select\s*service|extended.?stay|resort|boutique/.test(s)) return 'Hotel';
  if (/\bindustrial\b|warehouse|distribution|flex|cold\s*storage|logistics/.test(s)) return 'Industrial';
  if (/\bself.?storage\b/.test(s))                                    return 'SelfStorage';
  if (/\bmanufactured\s*housing\b|\bmhc\b|mobile\s*home/.test(s))     return 'MHC';
  if (/\bmixed.?use\b/.test(s))                                       return 'MixedUse';
  if (/\bretail\b|\bmall\b|\bmills\b|\boutlets?\b|galleria|anchored|unanchored|strip|shopping/.test(s)) return 'Retail';
  return null;
}

/* ----------------------------- main adapter ------------------------------ */

/**
 * Adapt ExtractionResult + PropertyMetadata → DealBag.
 *
 * Pure function; no I/O, no global state. Returns a DealBag with every
 * field deterministically sourced from raw extraction + property metadata
 * + (optionally) an explicit assetType pass-through.
 */
export function adaptExtractionToDealBag(
  extraction: ExtractionResult,
  propertyMetadata: PropertyMetadata | null,
  options?: AdapterOptions,
): DealBag {
  // Asset type — explicit override (clean caller path) > heuristic fallback.
  const assetType: AssetType | null =
    options?.explicitAssetType !== undefined && options.explicitAssetType !== null
      ? options.explicitAssetType
      : deriveAssetTypeFromSubtype(propertyMetadata?.propertySubtype ?? null);

  // Sub-type — verbatim from PropertyMetadata (free-form string the dims
  // interpret heuristically: "Mall", "Mills", "Outlets", "Anchored", "CBD",
  // "Full Service", "Suburban", "Student", "Various", etc.)
  const subType = propertyMetadata?.propertySubtype ?? null;

  // Property name — pass through; not consumed by scoring but used by the
  // dim-8 mall-name detection.
  const propertyName = propertyMetadata?.propertyName ?? null;

  // Raw loan terms.
  const loanAmount = extraction.loanTerms?.loanAmount ?? null;
  const coupon = extraction.loanTerms?.interestRate ?? null;
  const amortMonths = extraction.loanTerms?.amortization ?? null;
  const interestOnlyPeriodMonths = extraction.loanTerms?.interestOnlyPeriod ?? null;
  const ioYears = interestOnlyPeriodMonths !== null && interestOnlyPeriodMonths >= 0
    ? interestOnlyPeriodMonths / 12
    : null;

  // Raw value + NOI.
  const concludedValue = pickConcludedValue(extraction);
  const uwY1Noi = pickIssuerNoi(extraction);
  const t12Noi = extraction.t12Actual?.noi ?? null;

  // Occupancy.
  const underwrittenOccupancy = pickOccupancy(propertyMetadata, extraction);

  // Tenant-table derivations.
  const rentRoll = extraction.rentRoll;
  const largestTenantPct = deriveTopTenantShare(rentRoll);
  const tenantDataStatus = deriveTenantDataStatus(rentRoll, assetType);
  const pctIncomeExpiringWithinTerm = deriveRolloverShare(
    rentRoll,
    extraction.loanTerms?.maturityDate ?? null,
  );

  return {
    propertyName,
    assetType,
    subType,
    loanAmount,
    coupon,
    concludedValue,
    uwY1Noi,
    t12Noi,
    underwrittenOccupancy,
    largestTenantPct,
    // base-rent share derived from rentRoll (per spec v2 §5 preferred basis).
    largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm,
    tenantDataStatus,
    amortMonths,
    ioYears,
    // First-cutover decisions documented in the header:
    termYears: null,           // refi dim degenerates to IO-no-paydown
    marketTier: 'Unknown',     // cap-rate dim treats Unknown as 0 bps
  };
}

/**
 * Asset-class applicability predicates (audit §6.4 + 3c2 design check §B.3).
 *
 * Distinguishes "applicable but missing" from "not applicable":
 *   - Applicable + raw null  → substitute from library/benchmark + emit penalty
 *   - Not applicable         → adjusted=0, source=MANUAL, no penalty (zero is the correct value)
 *
 * v1.0 defaults shipped per audit §E.2 (industry-typical conventions). Bank-specific
 * overrides via manifesto land in v1.1.
 */

import type {
  AssetProfile,
  ExtractionResult,
} from '@cre/contracts';

/* ---------------------------------- helpers --------------------------------- */

const RESIDENTIAL_TYPES = new Set<AssetProfile['propertyType']>(['Multifamily', 'Hotel']);
const TENANT_DRIVEN_TYPES = new Set<AssetProfile['propertyType']>(['Office', 'Retail', 'Industrial']);
const PAYROLL_TYPES = new Set<AssetProfile['propertyType']>(['Hotel', 'MHC', 'Multifamily']);

function rolloverWithinTermFraction(
  extraction: ExtractionResult,
  termMonths: number | null,
): number {
  // Approximate fraction of income (annualized) expiring within `termMonths`. Returns 0 if
  // no rent roll OR no term info; conservative — applicability for upfrontTiLc / monthlyTiLc
  // defaults to false in that case.
  if (extraction.rentRoll === null || termMonths === null) return 0;
  if (termMonths <= 0) return 0;

  const now = new Date(extraction.analysisAsOfDate).getTime();
  const cutoff = now + termMonths * 30.4375 * 24 * 60 * 60 * 1000;

  let totalAnnualRent = 0;
  let expiringAnnualRent = 0;
  for (const u of extraction.rentRoll.units) {
    if (u.inPlaceRentMonthly === null) continue;
    const annual = u.inPlaceRentMonthly * 12;
    totalAnnualRent += annual;
    if (u.leaseEnd === null) continue;
    const end = new Date(u.leaseEnd).getTime();
    if (Number.isFinite(end) && end <= cutoff) {
      expiringAnnualRent += annual;
    }
  }
  return totalAnnualRent > 0 ? expiringAnnualRent / totalAnnualRent : 0;
}

/* --------------------------------- predicates ------------------------------- */

export function concessionsApplies(profile: AssetProfile): boolean {
  return RESIDENTIAL_TYPES.has(profile.propertyType);
}

export function payrollApplies(profile: AssetProfile): boolean {
  return PAYROLL_TYPES.has(profile.propertyType);
}

export function ioPeriodApplies(extraction: ExtractionResult): boolean {
  const io = extraction.loanTerms?.interestOnlyPeriod ?? null;
  return io !== null && io > 0;
}

export function upfrontCapexApplies(extraction: ExtractionResult): boolean {
  const ir = extraction.pca?.immediateRepairs ?? null;
  return ir !== null && ir > 0;
}

export function upfrontTiLcApplies(args: {
  readonly profile: AssetProfile;
  readonly extraction: ExtractionResult;
  readonly termMonths: number | null;
}): boolean {
  if (!TENANT_DRIVEN_TYPES.has(args.profile.propertyType)) return false;
  return rolloverWithinTermFraction(args.extraction, args.termMonths) > 0.15;
}

export function monthlyTiLcApplies(args: {
  readonly profile: AssetProfile;
  readonly extraction: ExtractionResult;
  readonly termMonths: number | null;
}): boolean {
  return upfrontTiLcApplies(args);
}

export function monthlyCapexApplies(termMonths: number | null): boolean {
  return termMonths !== null && termMonths > 60;
}

export function pcaImmediateRepairsApplies(extraction: ExtractionResult): boolean {
  return extraction.pca !== null;
}

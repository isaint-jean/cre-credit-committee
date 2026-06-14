/**
 * computeRefiWindowRollover — pure, deterministic computation of the per-tenant
 * lease-rollover schedule against loan maturity + a configurable refinancing-window
 * buffer (N months). The output (`RefiWindowRolloverFacts`) is the first member of
 * the per-principle LLM context bundle's `computedFacts` map (sub-batch: Phase 1 of
 * the "read deal data before asset-class priors" gate).
 *
 * Discipline:
 *   - Pure function. No I/O. No clock. No Math.random. Deterministic over inputs.
 *   - Spec-clean (§2.3): reads `RentRoll` (the graph node) and `AdjustedInputs.loan.maturityDate`,
 *     NEVER imports `ExtractionResult`. The judgment orchestrator threads `maturityDate`
 *     from `LoanTermsExtraction.maturityDate` onto `AdjustedInputs.loan` at Stage 4;
 *     downstream consumers (Stage 5+) read this denormalized field rather than
 *     re-entering extraction.
 *   - Strict null fidelity: `aggregateRolloverFraction` IS `null` in the insufficient-data
 *     case, NOT 0. Per-tenant `expiresWithinRefiWindow` is `null` when `leaseEnd` is null
 *     (no synthesizing).
 *
 * Verdict semantics:
 *   - `'no_rollover_in_refi_window'`  — sourceDataComplete=true AND aggregateRolloverFraction === 0
 *   - `'rollover_in_refi_window'`     — sourceDataComplete=true AND aggregateRolloverFraction > 0
 *   - `'insufficient_data'`           — rentRoll null OR termMonths null OR maturityDate null
 *                                       OR every line has leaseEnd null. perTenantSchedule
 *                                       is still emitted with nulls so the LLM can see the gap.
 *
 * The buffer ("refinancing window") is a NAMED PARAMETER — it is a proxy for the
 * take-out lender's window past maturity, not a universal truth. Today the default is
 * 12 months; in the future the bank's manifesto can override it (out of scope here).
 */

import type { ISODateTime, RentRoll } from '@cre/contracts';

export interface RefiWindowRolloverTenantLine {
  readonly tenantName: string | null;
  readonly suite: string | null;
  readonly squareFeet: number | null;
  readonly leaseEnd: ISODateTime | null;
  /**
   * Null when `leaseEnd` is null OR when `maturityPlusWindowDate` is null
   * (insufficient maturity/term data). True iff `leaseEnd <= maturityPlusWindowDate`.
   */
  readonly expiresWithinRefiWindow: boolean | null;
  readonly inPlaceRentAnnual: number | null;
}

export interface RefiWindowRolloverFacts {
  /** The buffer N (months added to termMonths/maturity for the cutoff). */
  readonly refiWindowMonths: number;
  readonly termMonths: number | null;
  readonly maturityDate: ISODateTime | null;
  /** maturityDate + refiWindowMonths, when computable; null otherwise. */
  readonly maturityPlusWindowDate: ISODateTime | null;
  /**
   * Aggregate fraction of annualized in-place rent whose lease expires on or
   * before `maturityPlusWindowDate`. Denominator is the sum of in-place
   * annual rent across tenants with non-null `inPlaceRentAnnual`. Null when
   * `sourceDataComplete` is false. NOT zero — strict null fidelity per the
   * "absence is not zero" discipline (architecture §8).
   */
  readonly aggregateRolloverFraction: number | null;
  readonly perTenantSchedule: ReadonlyArray<RefiWindowRolloverTenantLine>;
  /**
   * True iff: rentRoll is non-null AND maturityDate is non-null AND
   * termMonths is non-null AND EVERY tenant line has a non-null leaseEnd.
   * False otherwise — single gap (e.g., one missing leaseEnd, or missing
   * maturityDate) flips this to false so the verdict downgrades to
   * insufficient_data and the LLM is prompted to ask for the missing input.
   */
  readonly sourceDataComplete: boolean;
  readonly verdict:
    | 'no_rollover_in_refi_window'
    | 'rollover_in_refi_window'
    | 'insufficient_data';
}

export interface ComputeRefiWindowRolloverArgs {
  readonly rentRoll: RentRoll | null;
  /**
   * Loan maturity ISO timestamp (read off `AdjustedInputs.loan.maturityDate`).
   * Distinct from termMonths — both are required for sourceDataComplete=true
   * so the verdict can downgrade cleanly when either is absent.
   */
  readonly maturityDate: ISODateTime | null;
  readonly termMonths: number | null;
  /** The analysis-as-of date; reserved for future use (today the gate is anchored on maturityDate). */
  readonly analysisAsOfDate: ISODateTime;
  /** Default 12 months. The take-out lender's refinancing window past maturity. */
  readonly refiWindowMonths?: number;
}

const DAYS_PER_MONTH_AVG = 30.4375;
const MS_PER_DAY = 86_400_000;

/**
 * Add N months to an ISO date by adding `N * 30.4375 * 86_400_000` ms. Approximation
 * tolerant enough for the gate (we're answering "before/after maturity + ~year",
 * not balance-sheet date arithmetic). Returns null when the input is unparseable.
 */
function addMonths(iso: ISODateTime, months: number): ISODateTime | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const out = new Date(t + months * DAYS_PER_MONTH_AVG * MS_PER_DAY);
  return out.toISOString();
}

export function computeRefiWindowRollover(
  args: ComputeRefiWindowRolloverArgs,
): RefiWindowRolloverFacts {
  const refiWindowMonths = args.refiWindowMonths ?? 12;
  const { rentRoll, maturityDate, termMonths } = args;

  const maturityPlusWindowDate =
    maturityDate !== null ? addMonths(maturityDate, refiWindowMonths) : null;
  const cutoffMs =
    maturityPlusWindowDate !== null ? Date.parse(maturityPlusWindowDate) : null;

  // GATED — refi-window's tenant-lease-rollover analysis is meaningless
  // for multifamily / MHC / hotel / self-storage (no tenant-lease term;
  // dim 6 routes those to N/A by asset class). Filter to tenant-kind
  // lines so the analysis honestly applies to its intended scope.
  // A multifamily input → empty perTenantSchedule, everyLeaseEndPresent
  // false (no tenant lines), sourceDataComplete=false →
  // verdict='insufficient_data' — the honest degraded result.
  // Back-compat: skip explicit `kind: 'unit'` only. Untyped legacy lines
  // (persisted before the discriminant landed) default to tenant.
  const tenantLines = rentRoll === null
    ? []
    : rentRoll.lines.filter(
        (l): l is Extract<typeof l, { kind: 'tenant' }> => l.kind !== 'unit',
      );

  // Build per-tenant schedule first — surfaced even on insufficient data so the
  // LLM can see exactly which leases are missing dates and ask for them by name.
  const perTenantSchedule: RefiWindowRolloverTenantLine[] = [];
  for (const line of tenantLines) {
    const leaseEnd = line.leaseEnd;
    let expiresWithinRefiWindow: boolean | null;
    if (leaseEnd === null || cutoffMs === null || !Number.isFinite(cutoffMs)) {
      expiresWithinRefiWindow = null;
    } else {
      const end = Date.parse(leaseEnd);
      expiresWithinRefiWindow = Number.isFinite(end) ? end <= cutoffMs : null;
    }
    perTenantSchedule.push({
      tenantName: line.tenantName,
      suite: line.suite,
      squareFeet: line.squareFeet,
      leaseEnd,
      expiresWithinRefiWindow,
      inPlaceRentAnnual: line.inPlaceRentAnnual,
    });
  }

  // sourceDataComplete checks ALL three pillars: rent roll present, maturity present,
  // term present, and every tenant has leaseEnd. A single missing leaseEnd flips
  // sourceDataComplete=false → verdict=insufficient_data.
  const everyLeaseEndPresent =
    tenantLines.length > 0 &&
    tenantLines.every((l) => l.leaseEnd !== null);
  const sourceDataComplete =
    rentRoll !== null &&
    maturityDate !== null &&
    termMonths !== null &&
    everyLeaseEndPresent;

  // Aggregate fraction: null when data incomplete; otherwise sum(expiring rent) / sum(rent).
  // Denominator includes only lines with non-null inPlaceRentAnnual.
  let aggregateRolloverFraction: number | null = null;
  if (sourceDataComplete && rentRoll !== null && cutoffMs !== null) {
    let total = 0;
    let expiring = 0;
    for (const line of tenantLines) {
      const rent = line.inPlaceRentAnnual;
      if (rent === null) continue;
      total += rent;
      const end = line.leaseEnd !== null ? Date.parse(line.leaseEnd) : NaN;
      if (Number.isFinite(end) && end <= cutoffMs) {
        expiring += rent;
      }
    }
    aggregateRolloverFraction = total > 0 ? expiring / total : 0;
  }

  let verdict: RefiWindowRolloverFacts['verdict'];
  if (!sourceDataComplete || aggregateRolloverFraction === null) {
    verdict = 'insufficient_data';
  } else if (aggregateRolloverFraction === 0) {
    verdict = 'no_rollover_in_refi_window';
  } else {
    verdict = 'rollover_in_refi_window';
  }

  return {
    refiWindowMonths,
    termMonths,
    maturityDate,
    maturityPlusWindowDate,
    aggregateRolloverFraction,
    perTenantSchedule,
    sourceDataComplete,
    verdict,
  };
}

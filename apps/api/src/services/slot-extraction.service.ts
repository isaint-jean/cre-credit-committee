/**
 * Slot-extraction projection (Data Room Tier 2c). PURE display projections of the
 * hydrated extraction nodes into the boundary-honoring DTOs — the raw
 * ExtractionResult / RentRoll node never leaves the server (§2.3 display-read rule).
 * Credit-free: extraction happened at ingest; this only surfaces it.
 */
import type {
  ASRExtraction,
  AsrCashFlowColumnDTO,
  AsrSlotExtraction,
  AsrSourceUseDTO,
  PCAExtraction,
  PcaSlotExtraction,
  RentRoll,
  RentRollLine,
  RentRollSlotExtraction,
  RentRollUnitDTO,
} from '@cre/contracts';

export const RENT_ROLL_PAGE_SIZE = 50;

function tenantDetail(sqft: number | null): string | null {
  return sqft != null ? `${Math.round(sqft).toLocaleString('en-US')} SF` : null;
}

function lineToDTO(l: RentRollLine): RentRollUnitDTO {
  if (l.kind === 'tenant') {
    return {
      label: l.tenantName ?? l.suite ?? '(unnamed)',
      status: l.status,
      leaseStart: l.leaseStart,
      leaseEnd: l.leaseEnd,
      inPlaceRent: l.inPlaceRentAnnual,
      marketRent: l.marketRentAnnual,
      rentPeriod: 'annual',
      detail: tenantDetail(l.squareFeet),
      leaseType: l.leaseType,
    };
  }
  // residential/MHC unit line
  const bedBath = [
    l.bedrooms != null ? `${l.bedrooms}BR` : null,
    l.bathrooms != null ? `${l.bathrooms}BA` : null,
  ].filter(Boolean).join('/');
  const detail = l.unitType ?? (bedBath || tenantDetail(l.squareFeet));
  return {
    label: l.unitId,
    status: l.status,
    leaseStart: l.leaseStart,
    leaseEnd: l.leaseEndOrMTM,
    inPlaceRent: l.inPlaceRentMonthly,
    marketRent: l.marketRentMonthly,
    rentPeriod: 'monthly',
    detail,
    leaseType: null,
  };
}

/**
 * Project a hydrated RentRoll node → display DTO (summary + a bounded page of rows).
 * Summary excludes ancillary unit lines (isResidential === false), mirroring the
 * engine's own totalUnits/occupiedUnits filter convention. Page-bounded (default 50)
 * because MF rent rolls run to thousands of units.
 */
export function projectRentRoll(rentRoll: RentRoll, offset = 0, limit = RENT_ROLL_PAGE_SIZE): RentRollSlotExtraction {
  const lines = rentRoll.lines;
  const counted = lines.filter((l) => !(l.kind === 'unit' && l.isResidential === false));
  const totalUnits = counted.length;
  const occupiedUnits = counted.filter((l) => l.status === 'OCCUPIED').length;
  const occupancyPct = totalUnits > 0 ? occupiedUnits / totalUnits : null;

  const safeOffset = Math.max(0, offset);
  const page = lines.slice(safeOffset, safeOffset + limit).map(lineToDTO);

  return {
    kind: 'rent_roll',
    asOfDate: rentRoll.asOfDate,
    propertyName: rentRoll.propertyName,
    source: rentRoll.source,
    summary: { totalUnits, occupiedUnits, occupancyPct },
    units: page,
    totalCount: lines.length,
    offset: safeOffset,
    limit,
  };
}

/**
 * Project ExtractionResult.pca (PCAExtraction) → display DTO. Surfaces Table 1
 * repair totals, the Table 2 inflated per-year capex schedule, and the four
 * system narratives. Boundary-honoring: the raw ExtractionResult never leaves the
 * server. Null-safe: an absent schedule projects to []. No pagination — PCA
 * evaluation periods are ~10-20 years.
 */
export function projectPca(pca: PCAExtraction): PcaSlotExtraction {
  const capexSchedule = (pca.capexScheduleInflated ?? []).map((e) => ({ year: e.year, amount: e.amount }));
  return {
    kind: 'pca',
    immediateRepairs: pca.immediateRepairs,
    shortTermRepairs: pca.shortTermRepairs,
    evaluationPeriodYears: pca.evaluationPeriodYears,
    inflationRate: pca.inflationRate,
    reservePerSfPerYearInflated: pca.replacementReservesPerSfPerYearInflated,
    capexSchedule,
    narratives: {
      roof: pca.structural.roof,
      hvac: pca.structural.hvac,
      plumbing: pca.structural.plumbing,
      electrical: pca.structural.electrical,
    },
  };
}

/**
 * Project ExtractionResult.asr (ASRExtraction) → display DTO. Surfaces the
 * valuation triple, the deterministically-parsed Sources & Uses (split into
 * present source/use lines, honest-blank nulls dropped), and the Underwritten
 * Cash Flows ladder (one entry per present column). Boundary-honoring: the raw
 * ExtractionResult never leaves the server. Null-safe / bounded — no pagination.
 */
export function projectAsr(asr: ASRExtraction): AsrSlotExtraction {
  const sources: AsrSourceUseDTO[] = [];
  const uses: AsrSourceUseDTO[] = [];
  const push = (arr: AsrSourceUseDTO[], label: string, amount: number | null | undefined): void => {
    if (amount != null) arr.push({ label, amount });
  };
  const su = asr.sourcesAndUses ?? null;
  if (su) {
    push(sources, 'Loan amount', su.loanAmount);
    push(sources, 'Sponsor equity', su.sponsorEquity ?? asr.sponsorEquity);
    push(uses, 'Purchase price', su.purchasePrice);
    push(uses, 'Loan payoff', su.loanPayoff);
    push(uses, 'Return of equity', su.returnOfEquity);
    push(uses, 'Unfunded obligations', su.unfundedObligations);
    push(uses, 'LL obligations / gap rent', su.llObligationsGapRent);
    push(uses, 'GSA rent reserve', su.gsaRentReserve);
    push(uses, 'Capital expenditures', su.capitalExpenditures);
    push(uses, 'Closing reserves & capex', su.closingReservesCapex);
    push(uses, 'Closing costs', su.closingCosts);
  }

  const cf = asr.underwrittenCashFlows ?? null;
  const cashFlows: AsrCashFlowColumnDTO[] = [];
  if (cf) {
    const cols: ReadonlyArray<readonly [keyof typeof cf, string]> = [
      ['y2021', '2021'], ['y2022', '2022'], ['y2023', '2023'], ['t12', 'T-12'], ['appraisal', 'Appraisal'], ['uw', 'U/W'],
    ];
    for (const [key, label] of cols) {
      const c = cf[key];
      const col: AsrCashFlowColumnDTO = {
        label,
        potentialGrossRevenue: c.potentialGrossRevenue,
        effectiveGrossRevenue: c.effectiveGrossRevenue,
        totalExpenses: c.totalExpenses,
        netOperatingIncome: c.netOperatingIncome,
        netCashFlow: c.netCashFlow,
      };
      // include a column only when it carries at least one surfaced figure
      if (col.potentialGrossRevenue != null || col.effectiveGrossRevenue != null || col.totalExpenses != null || col.netOperatingIncome != null || col.netCashFlow != null) {
        cashFlows.push(col);
      }
    }
  }

  return {
    kind: 'asr',
    underwrittenNOI: asr.underwrittenNOI,
    impliedValue: asr.impliedValue,
    impliedCapRate: asr.impliedCapRate,
    priorDebtPayoff: asr.priorDebtPayoff,
    sponsorEquity: asr.sponsorEquity ?? null,
    sources,
    uses,
    cashFlows,
  };
}

/**
 * Slot-extraction display DTOs (Data Room Tier 2c) — the boundary-honoring
 * projection of a slot's ingest-time extraction for buyer display.
 *
 * ★ These are DISPLAY DTOs, not the raw ExtractionResult. Per the §2.3 isolation
 *   rule, `extractionResult` is readable for narrative/AUDIT DISPLAY (not by
 *   producers); the endpoint projects the hydrated node to one of these small
 *   shapes and returns it — the raw internal record never leaves the server.
 *
 * Credit-free: extraction already happened at ingest; this only surfaces it.
 */

/** One rent-roll row, normalized across the tenant/unit discriminated union. */
export interface RentRollUnitDTO {
  /** tenantName ?? suite ?? unitId — the row's human label. */
  readonly label: string;
  readonly status: string; // TenantStatus (OCCUPIED / VACANT / …)
  readonly leaseStart: string | null;
  readonly leaseEnd: string | null; // leaseEnd (tenant) or leaseEndOrMTM (unit; null = MTM)
  readonly inPlaceRent: number | null;
  readonly marketRent: number | null;
  /** 'annual' for office/retail tenant lines, 'monthly' for residential units. */
  readonly rentPeriod: 'annual' | 'monthly';
  /** SF (office/retail) or "2BR/2BA · Studio" (residential) — display detail. */
  readonly detail: string | null;
  readonly leaseType: string | null; // tenant lines only
}

export interface RentRollSlotExtraction {
  readonly kind: 'rent_roll';
  readonly asOfDate: string | null;
  readonly propertyName: string | null;
  readonly source: string;
  readonly summary: {
    readonly totalUnits: number;
    readonly occupiedUnits: number;
    /** physical occupancy = occupied / total (0..1), or null when total is 0. */
    readonly occupancyPct: number | null;
  };
  /** The page of rows (bounded — see totalCount / offset / limit). */
  readonly units: readonly RentRollUnitDTO[];
  readonly totalCount: number;
  readonly offset: number;
  readonly limit: number;
}

/** One year of the PCA Table-2 replacement-reserve (capex) schedule. */
export interface PcaCapexYearDTO {
  readonly year: number; // 1-indexed
  readonly amount: number; // inflated dollars; 0 for years with no scheduled capex
}

/**
 * Property Condition Assessment display projection (Data Room Tier 2c, pca variant).
 * ★ Projected from ExtractionResult.pca (PCAExtraction) — the raw record stays server-side.
 *   The underlying extraction carries repair *totals* (Table 1's Immediate / Short-Term
 *   columns), not itemized line lists, so the DTO surfaces the dollar totals directly.
 *   Null-safe: absent fields stay null; an absent schedule is [].
 */
export interface PcaSlotExtraction {
  readonly kind: 'pca';
  /** Table 1 "Immediate Repair" total dollars — reserved up-front at closing. */
  readonly immediateRepairs: number | null;
  /** Table 1 "Short-Term Cost" total dollars — addressed within ~2 years. */
  readonly shortTermRepairs: number | null;
  /** Table 2 evaluation-period length (e.g. 12 for a 12-year schedule). */
  readonly evaluationPeriodYears: number | null;
  /** Annual inflation rate applied to the schedule — decimal fraction (0.025 = 2.5%). */
  readonly inflationRate: number | null;
  /** Average annual replacement reserve, inflated $/SF/yr (PCA-reported cross-check). */
  readonly reservePerSfPerYearInflated: number | null;
  /** Year-by-year inflated capex schedule (bounded ~10-20 rows; [] when absent). */
  readonly capexSchedule: readonly PcaCapexYearDTO[];
  /** Condition narratives for the four major building systems. */
  readonly narratives: {
    readonly roof: string | null;
    readonly hvac: string | null;
    readonly plumbing: string | null;
    readonly electrical: string | null;
  };
}

/** One line of the ASR Sources & Uses table — a present (non-null) figure only. */
export interface AsrSourceUseDTO {
  readonly label: string;
  readonly amount: number;
}

/** One column of the ASR "Underwritten Cash Flows" ladder (a year / T-12 / appraisal / U-W). */
export interface AsrCashFlowColumnDTO {
  readonly label: string; // '2021' | '2022' | '2023' | 'T-12' | 'Appraisal' | 'U/W'
  readonly potentialGrossRevenue: number | null;
  readonly effectiveGrossRevenue: number | null;
  readonly totalExpenses: number | null;
  readonly netOperatingIncome: number | null;
  readonly netCashFlow: number | null;
}

/**
 * Analytical Summary Report display projection (Data Room Tier 2c, asr variant).
 * ★ Projected from ExtractionResult.asr (ASRExtraction) — the raw record stays
 *   server-side. Faithful to the real extraction: the valuation triple (implied
 *   cap rate is often null — the ASR may not state it), the deterministically
 *   parsed Sources & Uses split into present source/use lines, and the multi-year
 *   Underwritten Cash Flows ladder. Null-safe: absent lines are omitted; an absent
 *   cash-flow table projects to [].
 */
export interface AsrSlotExtraction {
  readonly kind: 'asr';
  /** ASR's underwritten NOI (the U/W column's NOI). */
  readonly underwrittenNOI: number | null;
  /** Implied value from the ASR (e.g. appraised / concluded value). */
  readonly impliedValue: number | null;
  /** Implied cap rate — 0..1 fraction; null when the ASR doesn't state it. */
  readonly impliedCapRate: number | null;
  /** Existing-debt payoff (refinance deals); null otherwise. */
  readonly priorDebtPayoff: number | null;
  /** New sponsor equity contributed alongside the loan; null when absent. */
  readonly sponsorEquity: number | null;
  /** Sources side of the S&U table (present lines only). */
  readonly sources: readonly AsrSourceUseDTO[];
  /** Uses side of the S&U table (present lines only). */
  readonly uses: readonly AsrSourceUseDTO[];
  /** Underwritten Cash Flows ladder, one entry per present column ([] when absent). */
  readonly cashFlows: readonly AsrCashFlowColumnDTO[];
}

/** The slot-extraction union grows as the appraisal variant is added. */
export type SlotExtraction = RentRollSlotExtraction | PcaSlotExtraction | AsrSlotExtraction;

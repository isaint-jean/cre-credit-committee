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

/** The slot-extraction union grows as asr/appraisal variants are added. */
export type SlotExtraction = RentRollSlotExtraction | PcaSlotExtraction;

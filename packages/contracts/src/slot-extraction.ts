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

/** The slot-extraction union grows as pca/asr/appraisal variants are added. */
export type SlotExtraction = RentRollSlotExtraction;

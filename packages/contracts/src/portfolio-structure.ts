/**
 * Manual portfolio definition — the Phase-A reachability path. A servicer defines
 * ONE loan's N properties (name/geo/type + value/NOI/NCF/occupancy + the allocated
 * loan amount) by hand, so the already-built aggregator/composer/export can run on a
 * real cross-collateralized loan without waiting on per-property doc extraction (Phase B).
 *
 * ★ DISPLAY/EXPORT-ONLY, MINT-SAFE. This is servicer human input — it rides the additive
 *   servicer_inputs TEXT column (fieldType 'portfolio_structure'), exactly like site photos
 *   and the checklist. It NEVER mutates the minted ExtractionResult / doctrine / 640 head.
 *   Honest-blank: fields the servicer omits stay null, never fabricated.
 */
import type { PropertyComponent } from './extraction.js';

/** The subset of a property a servicer supplies by hand (the rest is honest-blank). */
export interface ManualPortfolioProperty {
  readonly propertyName: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly propertyType: string | null;
  readonly netRentableSF: number | null;
  readonly value: number | null;
  readonly noi: number | null;
  readonly ncf: number | null;
  readonly occupancyPct: number | null;      // 0..1 fraction
  /** The whole-loan balance allocated to this property (drives the SUMPRODUCT weights). */
  readonly allocatedLoanAmount: number | null;
}

export interface ManualPortfolioDefinition {
  readonly properties: readonly ManualPortfolioProperty[];
  /** Optional whole-loan annual debt service — enables the aggregate DSCR honestly. */
  readonly wholeLoanDebtService: number | null;
}

export const EMPTY_PORTFOLIO_DEFINITION: ManualPortfolioDefinition = {
  properties: [],
  wholeLoanDebtService: null,
};

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

/** Parse the stored JSON defensively — malformed / legacy → empty (never throws). */
export function parseManualPortfolio(raw: string | null | undefined): ManualPortfolioDefinition {
  if (!raw) return EMPTY_PORTFOLIO_DEFINITION;
  try {
    const o = JSON.parse(raw) as Partial<ManualPortfolioDefinition>;
    const properties = Array.isArray(o.properties)
      ? o.properties.map((p) => {
          const q = (p ?? {}) as Partial<ManualPortfolioProperty>;
          return {
            propertyName: strOrNull(q.propertyName),
            address: strOrNull(q.address),
            city: strOrNull(q.city),
            state: strOrNull(q.state),
            propertyType: strOrNull(q.propertyType),
            netRentableSF: numOrNull(q.netRentableSF),
            value: numOrNull(q.value),
            noi: numOrNull(q.noi),
            ncf: numOrNull(q.ncf),
            occupancyPct: numOrNull(q.occupancyPct),
            allocatedLoanAmount: numOrNull(q.allocatedLoanAmount),
          };
        })
      : [];
    return { properties, wholeLoanDebtService: numOrNull(o.wholeLoanDebtService) };
  } catch {
    return EMPTY_PORTFOLIO_DEFINITION;
  }
}

/** Serialize a manual definition back to the stored JSON. */
export function serializeManualPortfolio(def: ManualPortfolioDefinition): string {
  return JSON.stringify({
    properties: def.properties.map((p) => ({
      propertyName: p.propertyName,
      address: p.address,
      city: p.city,
      state: p.state,
      propertyType: p.propertyType,
      netRentableSF: p.netRentableSF,
      value: p.value,
      noi: p.noi,
      ncf: p.ncf,
      occupancyPct: p.occupancyPct,
      allocatedLoanAmount: p.allocatedLoanAmount,
    })),
    wholeLoanDebtService: def.wholeLoanDebtService,
  });
}

/**
 * Normalize a manual definition → PropertyComponent[] the aggregator/composer consume.
 * Ordinal is 1-based by array position; componentId / parentAssetNumber / the doc-only
 * fields (zip, yearBuilt, valuationDate, revenue) are honest-blank; capRate is computed
 * from noi/value when both are present (mirrors the EX-102 component's derived capRate).
 */
export function manualPortfolioToComponents(def: ManualPortfolioDefinition): PropertyComponent[] {
  return def.properties.map((p, i) => ({
    ordinal: i + 1,
    componentId: null,
    parentAssetNumber: null,
    propertyName: p.propertyName,
    address: p.address,
    city: p.city,
    state: p.state,
    zip: null,
    propertyType: p.propertyType,
    netRentableSF: p.netRentableSF,
    yearBuilt: null,
    value: p.value,
    valuationDate: null,
    noi: p.noi,
    ncf: p.ncf,
    revenue: null,
    occupancyPct: p.occupancyPct,
    capRate: p.value !== null && p.value > 0 && p.noi !== null ? p.noi / p.value : null,
    allocatedLoanAmount: p.allocatedLoanAmount,
  }));
}

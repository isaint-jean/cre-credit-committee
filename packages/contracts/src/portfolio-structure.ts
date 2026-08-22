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

  // — Phase B 1a line-item set (all optional; honest-blank when omitted) —
  readonly originalBalance: number | null;
  readonly cutoffBalance: number | null;
  readonly pgi: number | null;
  readonly otherIncome: number | null;
  readonly expenseReimbursements: number | null;
  readonly egi: number | null;
  readonly operatingExpenses: number | null;
  readonly replacementReserves: number | null;
  readonly tiLc: number | null;
  readonly otherCapEx: number | null;
  readonly rolloverPctWithinTerm: number | null;   // 0..1 share expiring within term
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
            originalBalance: numOrNull(q.originalBalance),
            cutoffBalance: numOrNull(q.cutoffBalance),
            pgi: numOrNull(q.pgi),
            otherIncome: numOrNull(q.otherIncome),
            expenseReimbursements: numOrNull(q.expenseReimbursements),
            egi: numOrNull(q.egi),
            operatingExpenses: numOrNull(q.operatingExpenses),
            replacementReserves: numOrNull(q.replacementReserves),
            tiLc: numOrNull(q.tiLc),
            otherCapEx: numOrNull(q.otherCapEx),
            rolloverPctWithinTerm: numOrNull(q.rolloverPctWithinTerm),
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
      originalBalance: p.originalBalance,
      cutoffBalance: p.cutoffBalance,
      pgi: p.pgi,
      otherIncome: p.otherIncome,
      expenseReimbursements: p.expenseReimbursements,
      egi: p.egi,
      operatingExpenses: p.operatingExpenses,
      replacementReserves: p.replacementReserves,
      tiLc: p.tiLc,
      otherCapEx: p.otherCapEx,
      rolloverPctWithinTerm: p.rolloverPctWithinTerm,
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
    originalBalance: p.originalBalance,
    cutoffBalance: p.cutoffBalance,
    pgi: p.pgi,
    otherIncome: p.otherIncome,
    expenseReimbursements: p.expenseReimbursements,
    egi: p.egi,
    operatingExpenses: p.operatingExpenses,
    replacementReserves: p.replacementReserves,
    tiLc: p.tiLc,
    otherCapEx: p.otherCapEx,
    rolloverPctWithinTerm: p.rolloverPctWithinTerm,
  }));
}

/**
 * Field-bag assembler — maps the deal's HydratedRecordGraph (+ optional
 * PropertyMetadata) into the untyped FieldBag the handbook engine
 * consumes.
 *
 * This is the integration boundary between the api's deal-shaped data
 * and the engine's handbook-shaped contract. The handbook references
 * 31 distinct field paths (as of commit f981fec); this assembler
 * populates 15 of them with values pulled or derived from real data,
 * and leaves the remaining 16 undefined.
 *
 * Why 16 stay undefined:
 *   - 11 are "captured-in-documents but not typed-extracted" (category C
 *     from the recon report). They'll populate when extraction tickets
 *     land — most of those are tracked in #35.
 *   - 4 are "not captured anywhere" (category D), inert by design.
 *   - 1 (years_until_franchise_expiration_from_loan_maturity) is
 *     conceptually derivable but blocked on a missing extraction —
 *     the franchise expiration DATE isn't extracted today, only a
 *     boolean "expires within term."
 *
 * The engine handles undefined fields gracefully: principles whose
 * deterministic checks require an undefined field skip with reason
 * 'missing_field'. The assembler's contract is just: surface what you
 * have, return undefined for what you don't.
 *
 * Build-time safety: a separate test file calls
 * `assertNoUnknownFields(handbook, KNOWN_FIELDS)` from the engine's lint
 * module against the KNOWN_FIELDS constant exported here. If a new
 * handbook principle introduces a 32nd field path, CI fails until this
 * assembler is updated — either with a real implementation, or with an
 * explicit "leave undefined for now" entry.
 */

import type {
  HydratedRecordGraph,
  PropertyMetadata,
  StressScenarioOutput,
} from '@cre/contracts';
import type { FieldBag, FieldValue } from '@cre/handbook-engine';

// =============================================================================
// Public API
// =============================================================================

export interface AssemblerInputs {
  readonly graph: HydratedRecordGraph;
  /**
   * PropertyMetadata is persisted best-effort (recon report §1 noted
   * commit d53c67b). It is not part of the typed HydratedRecordGraph.
   * The assembler passes through `null` cleanly — every field derived
   * from metadata returns undefined when metadata is absent.
   */
  readonly propertyMetadata: PropertyMetadata | null;
  /**
   * Used for the two age derivations (building_age,
   * years_since_last_renovation). The assembler uses the calendar
   * year of this date.
   *
   * For new-spine ingestion, the natural source is
   * adjustedInputs.analysisAsOfDate (an ISODateTime); the caller is
   * responsible for parsing that to a Date.
   */
  readonly asOfDate: Date;
}

/**
 * The canonical set of field paths the handbook engine recognizes. Used
 * by the build-time lint test that asserts every handbook-referenced
 * field is either populated or intentionally undefined here.
 *
 * Sourced by manual inspection of the 31 paths in the engine's lint
 * output (commit f981fec). Update whenever new principles are added to
 * the handbook.
 */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'annual_room_revenue',
  'appraised_dark_value',
  'asset_type',
  'building_age',
  'building_class',
  'capex_projection',
  'cash_out_amount',
  'debt_service',
  'debt_yield',
  'dscr',
  'has_recent_substantial_renovation',
  'hotel_service_level',
  'loan_amount',
  'loan_purpose',
  'location_type',
  'mall_class',
  'mall_occupancy_cost_ratio',
  'msa',
  'noi_projection',
  'park_owned_home_pct',
  'pip_reserve_per_key',
  'property_sub_type',
  'reserves',
  'stressed_dscr_top_3_removed',
  'tenancy_type',
  'tenant_categories',
  'trade_area_sf_per_capita',
  'utility_infrastructure_type',
  'years_of_stable_operating_history',
  'years_since_last_renovation',
  'years_until_franchise_expiration_from_loan_maturity',
]);

/**
 * Field paths the assembler intentionally leaves undefined in v1.
 * Tracking this explicitly (rather than as silent omissions) lets us
 * write a test that asserts the assembler's behavior is intentional:
 *   - KNOWN_FIELDS = POPULATED_FIELDS ∪ INTENTIONALLY_UNDEFINED_FIELDS
 *   - the two sets are disjoint
 *
 * When a field moves from "undefined" to "populated" (because an
 * extraction ticket landed, or new derivation was added), update both
 * sets and the bag-building logic together.
 */
export const INTENTIONALLY_UNDEFINED_FIELDS: ReadonlySet<string> = new Set([
  // Category C — captured in documents but not yet typed-extracted (ticket #35).
  // When extraction work lands, add real lookups here.
  'annual_room_revenue',
  // NOTE: capex_projection was moved to POPULATED_FIELDS by the PCA producer
  // ticket (Phase 1+2 ship). The C.2 deferral rationale documented here is
  // historical; the present implementation projects bag['capex_projection']
  // from AdjustedCapitalReserves.capexScheduleInflated. See buildFieldBag
  // below for the projection + the KNOWN LIMITATION on per-year accuracy.
  'cash_out_amount',
  'debt_service',             // per-period array; see ticket TBD
  'hotel_service_level',
  'loan_purpose',
  'location_type',
  'mall_class',
  'noi_projection',           // per-period array; see ticket TBD
  'tenant_categories',
  'utility_infrastructure_type',
  // Category D — not captured anywhere; structurally absent.
  'appraised_dark_value',
  'has_recent_substantial_renovation',
  'mall_occupancy_cost_ratio',
  'trade_area_sf_per_capita',
  // Category B-blocked — derivable in principle, but the underlying input
  // field isn't extracted yet (franchise_expiration_date is missing).
  'years_until_franchise_expiration_from_loan_maturity',
  // Category B-policy — derivable but requires a policy-layer definition
  // of "stable operating history" that isn't formalized yet.
  'years_of_stable_operating_history',
]);

/**
 * The 15 fields the v1 assembler actually populates with values pulled
 * or derived from real data. Sourced from the recon report's
 * classification of (A) direct + the three trivial (B) derivations.
 * Plus stressed_dscr_top_3_removed which is a named-scenario lookup,
 * `reserves` which is a unit-converted projection from
 * AdjustedInputs.capitalReserves.monthlyReplacementReserves (C.2),
 * and `capex_projection` which is a per-year array projection from
 * AdjustedInputs.capitalReserves.capexScheduleInflated (PCA producer
 * ticket Phase 1+2 — anchors P-IV-RET-6's sum_over_term array operand).
 *
 * NOTE: Exported for test introspection; not used by the assembler
 * itself at runtime. The set is implicit in `buildFieldBag` below.
 */
export const POPULATED_FIELDS: ReadonlySet<string> = new Set([
  // Direct projections (A)
  'asset_type',
  'capex_projection',
  'debt_yield',
  'dscr',
  'loan_amount',
  'msa',
  'building_class',
  'property_sub_type',
  'park_owned_home_pct',
  'pip_reserve_per_key',
  'reserves',
  'stressed_dscr_top_3_removed',
  // Derivations (B)
  'building_age',
  'years_since_last_renovation',
  'tenancy_type',
]);

// =============================================================================
// Implementation
// =============================================================================

const TENANT_REMOVAL_TOP_3_SCENARIO_NAME = 'Remove T1+T2+T3';

/**
 * Build the field bag from deal records.
 *
 * Contract: every field path in KNOWN_FIELDS appears as a key in the
 * returned bag, with either a real value or `undefined`. This makes the
 * bag's surface match the engine's expectations and lets the engine
 * distinguish "field was projected as missing" from "field was never
 * known."
 *
 * In practice, the engine's missing-field detection (commit f981fec
 * evaluator.ts line 105) treats `undefined` and "key absent" identically.
 * The contract above is for human auditing, not engine correctness.
 */
export function buildFieldBag(inputs: AssemblerInputs): FieldBag {
  const { graph, propertyMetadata, asOfDate } = inputs;
  const bag: Record<string, FieldValue> = {};

  // === Direct projections from AdjustedInputs ===
  bag['debt_yield'] = graph.adjustedInputs.metrics.debtYield;
  bag['dscr'] = graph.adjustedInputs.metrics.dscr;
  bag['loan_amount'] = graph.adjustedInputs.loan.loanAmount.adjusted;

  // reserves: scalar (annual dollars) projected from the monthly replacement
  // reserve rate. Was initially documented as "broadcast across loan term";
  // that framing was incorrect per the v8 §10.4 Errata investigation — the
  // engine's `sum_over_term` does NOT auto-broadcast scalars by loan_term.
  // What actually happens: `evaluateFormulaAsArray` lifts a scalar to a
  // length-1 array, and any element-wise op against a real array operand
  // broadcasts the length-1 entry to that array's length. So `bag['reserves']`
  // only behaves as "constant annual rate across N years" when ANOTHER
  // operand in the same op (now `capex_projection` from the PCA producer
  // ticket) is a real length-N array. With both operands populated,
  // P-IV-RET-6's `sum_over_term( noi_projection - (debt_service + reserves +
  // capex_projection) )` would compute correctly — but `noi_projection` and
  // `debt_service` remain INTENTIONALLY_UNDEFINED, so the deterministic
  // check still skips with 'missing_field'. PCA work advances #43 from 3/4
  // missing operands to 2/4.
  bag['reserves'] =
    graph.adjustedInputs.capitalReserves.monthlyReplacementReserves.adjusted * 12;

  // capex_projection: per-year array (one entry per year of the PCA's
  // evaluation period). PCA producer ticket Phase 1+2: projected from
  // capitalReserves.capexScheduleInflated, stripping the {year, amount}
  // objects down to just the amounts in year order. Defensive sort-by-year
  // ensures positional correctness even if the underlying array order
  // drifts (current builder is a pass-through that preserves AI output
  // order; cheap insurance).
  //
  // KNOWN LIMITATION inherited from the PCA extractor: per-year amount
  // placement is approximately 50-60% accurate on the Sunroad fixture
  // (PDF text extraction loses column positions; see extract-pca.ts file
  // header). The SUM of this array is reliable; year-by-year placements
  // are not. P-IV-RET-6's sum_over_term reads the sum, so the formula
  // tolerates the inaccuracy. Year-precise consumers (populator E35-M35,
  // audit-trail displays) should not rely on per-year accuracy.
  // `!== null` (strict): contract guarantees the field is
  // `ReadonlyArray<...> | null`. Fixture-cast leak path closed in
  // <SHIP-HASH> per #48 (test-handbook-field-bag.ts factory cleanup
  // removed the as-unknown-as casts that previously allowed undefined
  // to reach this read).
  const capexSchedule = graph.adjustedInputs.capitalReserves.capexScheduleInflated;
  if (capexSchedule !== null) {
    const sorted = [...capexSchedule].sort((a, b) => a.year - b.year);
    bag['capex_projection'] = sorted.map((entry) => entry.amount);
  } else {
    // Set explicitly to undefined so bag keys match KNOWN_FIELDS (the
    // assembler contract guarantees every known path appears as a key in
    // the bag, with either a real value or `undefined`).
    bag['capex_projection'] = undefined;
  }

  // === Direct projection from AssetProfile ===
  // assetProfile.propertyType is the PascalCase enum the handbook uses
  // for its asset_type field_equals/field_in conditions.
  bag['asset_type'] = graph.assetProfile.propertyType;

  // === Direct projections from NarrativeFacts (with handbook-name remapping) ===
  // pipBudgetPerKey → pip_reserve_per_key: semantically the same number,
  // different names on each side. The recon report flagged this on row 21.
  bag['pip_reserve_per_key'] = nullToUndefined(
    graph.narrativeFacts.pipBudgetPerKey,
  );
  bag['park_owned_home_pct'] = nullToUndefined(
    graph.narrativeFacts.parkOwnedHomesPct,
  );

  // === Derived: tenancy_type ===
  // NarrativeFacts.isSingleTenant: boolean | null
  // Handbook expects string: 'Single-Tenant' | 'Multi-Tenant'
  // Three states: true → 'Single-Tenant', false → 'Multi-Tenant', null → undefined
  bag['tenancy_type'] = deriveTenancyType(graph.narrativeFacts.isSingleTenant);

  // === Direct projection from StressOutputs ===
  // Named-scenario lookup. Three null/absent states all collapse to undefined:
  //   - scenario not produced (wrong stress method) → undefined
  //   - scenario produced but dscr null (missing rent-roll ranks) → undefined
  //   - scenario produced but dscr null (impossible composite) → undefined
  bag['stressed_dscr_top_3_removed'] = lookupTop3RemovedDscr(
    graph.stressOutputs.scenarios,
  );

  // === Projections from PropertyMetadata (null-tolerant) ===
  // PropertyMetadata is persisted best-effort, not part of the typed
  // HydratedRecordGraph. When absent, every metadata-derived field
  // returns undefined.
  bag['msa'] = nullToUndefined(propertyMetadata?.msa);
  bag['building_class'] = nullToUndefined(propertyMetadata?.buildingClass);
  bag['property_sub_type'] = nullToUndefined(propertyMetadata?.propertySubtype);
  bag['building_age'] = deriveBuildingAge(
    propertyMetadata?.yearBuilt ?? null,
    asOfDate,
  );
  bag['years_since_last_renovation'] = deriveYearsSinceRenovation(
    propertyMetadata?.yearRenovated ?? null,
    asOfDate,
  );

  // === Intentionally undefined (16 fields) ===
  // We set them explicitly so the bag's key set equals KNOWN_FIELDS.
  // This is purely for human auditing: the engine treats undefined and
  // key-absent identically, but having all 31 keys present in the bag
  // makes it easier to inspect what the assembler "saw" for a given deal.
  for (const path of INTENTIONALLY_UNDEFINED_FIELDS) {
    bag[path] = undefined;
  }

  return bag;
}

// =============================================================================
// Helpers
// =============================================================================

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

function deriveTenancyType(
  isSingleTenant: boolean | null,
): 'Single-Tenant' | 'Multi-Tenant' | undefined {
  if (isSingleTenant === true) return 'Single-Tenant';
  if (isSingleTenant === false) return 'Multi-Tenant';
  return undefined;
}

function deriveBuildingAge(
  yearBuilt: number | null,
  asOfDate: Date,
): number | undefined {
  if (yearBuilt === null) return undefined;
  if (!Number.isFinite(yearBuilt)) return undefined;
  const age = asOfDate.getFullYear() - yearBuilt;
  // Defensive: if year_built is in the future or the asOfDate is malformed,
  // the result is meaningless. Return undefined rather than a negative age.
  if (age < 0) return undefined;
  return age;
}

function deriveYearsSinceRenovation(
  yearRenovated: number | null,
  asOfDate: Date,
): number | undefined {
  if (yearRenovated === null) return undefined;
  if (!Number.isFinite(yearRenovated)) return undefined;
  const years = asOfDate.getFullYear() - yearRenovated;
  if (years < 0) return undefined;
  return years;
}

function lookupTop3RemovedDscr(
  scenarios: readonly StressScenarioOutput[],
): number | undefined {
  for (const scenario of scenarios) {
    if (scenario.name === TENANT_REMOVAL_TOP_3_SCENARIO_NAME) {
      // dscr: number | null per StressScenarioOutput contract.
      // Null means "scenario was produced but couldn't be measured" —
      // e.g., rent-roll missing ranks, or impossible composite.
      // Collapse to undefined for engine consumption.
      return scenario.dscr === null ? undefined : scenario.dscr;
    }
  }
  return undefined;
}

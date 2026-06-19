/**
 * Conservative lease-up doctrine — "contracted-basis" NOI producer.
 *
 * Sits OUTSIDE doctrine-clean by design: it legitimately needs to read both
 * raw extraction (rent-roll signed-lease filter) AND the judgment engine's
 * `AdjustedInputs.income.vacancyPct.adjusted` + `metrics.expenseRatio` so it
 * REUSES the existing expense discipline (library-floor vacancy + expense
 * ratio) without duplicating those policy constants. The doctrine-clean
 * fence (`adapters/extraction-to-dealbag.ts:6-15`) is preserved by NOT
 * inlining this into the clean-room adapter — the production caller
 * (`evaluate-from-adjusted-inputs.ts`) computes the figure here and passes
 * it INTO the adapter via the new `uwY1NoiOverride` option.
 *
 * The change is revenue-side only:
 *   - Revenue: Σ inPlaceRentAnnual for rent-roll lines with
 *              kind === 'tenant' AND status ∈ {'OCCUPIED', 'PRELEASED'}.
 *              Speculative / vacant space contributes ZERO.
 *   - Expenses: REUSE the engine's library-floor expense discipline —
 *              EGI = contractedRevenue × (1 − vacancyPct.adjusted)
 *              TOE = EGI × metrics.expenseRatio
 *              contractedNoi = EGI − TOE
 *              (Other income is NOT added — the conservative posture credits
 *              contracted rent only, not ancillary income streams that may
 *              not exist during lease-up.)
 *
 * Honest-blank rule: returns `null` when ANY required input is missing
 * (rent roll absent, lease-up predicate false, vacancyPct/expenseRatio
 * unavailable). The doctrine-clean adapter then falls back to its existing
 * `pickIssuerNoi` cascade. This preserves "not-applicable" deals
 * (stabilized) unchanged — by construction, not by accident.
 */

import type { AdjustedInputs, RentRoll } from '@cre/contracts';

export interface ContractedNoiTrace {
  readonly contractedRevenue: number | null;
  readonly qualifyingTenants: number;
  readonly excludedTenants: number;
  readonly vacancyPct: number | null;
  readonly expenseRatio: number | null;
  readonly egi: number | null;
  readonly toe: number | null;
  readonly contractedNoi: number | null;
  readonly note: string;
}

export interface ComputeContractedNoiInput {
  /**
   * The RICH RentRoll graph node (TenantRentRollLine shape), NOT the
   * leaner ExtractionResult.rentRoll (TenantUnit shape) — only the graph
   * node carries `status` ∈ {OCCUPIED, PRELEASED, VACANT, …} and
   * `inPlaceRentAnnual`. Producers should resolve the RentRoll via
   * `DoctrineEvaluation.rentRollId` (or the equivalent bundle field) and
   * pass it here. `null` when the deal has no rent roll — contractedNoi
   * computation then returns null and the adapter falls back to
   * pickIssuerNoi.
   */
  readonly rentRoll: RentRoll | null;
  readonly adjustedInputs: AdjustedInputs;
  readonly isLeaseUpDeal: boolean;
}

const QUALIFYING_STATUSES = new Set(['OCCUPIED', 'PRELEASED']);

export function computeContractedNoi(
  input: ComputeContractedNoiInput,
): ContractedNoiTrace {
  // Deliberate guard #1: not a lease-up → return null. Stabilized deals stay
  // on the existing pickIssuerNoi cascade with NO behavior change.
  if (!input.isLeaseUpDeal) {
    return {
      contractedRevenue: null,
      qualifyingTenants: 0,
      excludedTenants: 0,
      vacancyPct: null,
      expenseRatio: null,
      egi: null,
      toe: null,
      contractedNoi: null,
      note: 'predicate=false; not a lease-up deal — leaving sustainableNoi to the existing pickIssuerNoi cascade',
    };
  }

  // Deliberate guard #2: no rent roll → can't compute contracted revenue.
  const lines = readRentRollLines(input.rentRoll);
  if (lines === null) {
    return {
      contractedRevenue: null,
      qualifyingTenants: 0,
      excludedTenants: 0,
      vacancyPct: null,
      expenseRatio: null,
      egi: null,
      toe: null,
      contractedNoi: null,
      note: 'predicate=true but rent roll absent on extraction — falling back to sustainableNoi via existing cascade',
    };
  }

  // Revenue filter: sum contracted rent for OCCUPIED + PRELEASED tenant
  // lines with a present inPlaceRentAnnual. Speculative/vacant excluded.
  let contractedRevenue = 0;
  let qualifyingTenants = 0;
  let excludedTenants = 0;
  for (const line of lines) {
    if (line.kind !== 'tenant') { excludedTenants++; continue; }
    if (!QUALIFYING_STATUSES.has(line.status)) { excludedTenants++; continue; }
    if (line.inPlaceRentAnnual === null) { excludedTenants++; continue; }
    contractedRevenue += line.inPlaceRentAnnual;
    qualifyingTenants++;
  }

  if (qualifyingTenants === 0) {
    return {
      contractedRevenue: 0,
      qualifyingTenants: 0,
      excludedTenants,
      vacancyPct: null,
      expenseRatio: null,
      egi: null,
      toe: null,
      contractedNoi: null,
      note: `predicate=true but no qualifying tenants (OCCUPIED/PRELEASED with inPlaceRentAnnual non-null); excluded=${excludedTenants}. Falling back to sustainableNoi via existing cascade.`,
    };
  }

  // Reuse engine's vacancy floor + expense ratio.
  const vacancyPct = input.adjustedInputs.income.vacancyPct.adjusted;
  const expenseRatio = input.adjustedInputs.metrics.expenseRatio;
  if (
    vacancyPct === null || !Number.isFinite(vacancyPct) ||
    expenseRatio === null || !Number.isFinite(expenseRatio)
  ) {
    return {
      contractedRevenue,
      qualifyingTenants,
      excludedTenants,
      vacancyPct,
      expenseRatio,
      egi: null,
      toe: null,
      contractedNoi: null,
      note: `predicate=true and contractedRevenue computed ($${Math.round(contractedRevenue).toLocaleString()}), but vacancyPct (${vacancyPct}) or expenseRatio (${expenseRatio}) unavailable on AdjustedInputs. Falling back.`,
    };
  }

  const egi = contractedRevenue * (1 - vacancyPct);
  const toe = egi * expenseRatio;
  const contractedNoi = egi - toe;

  return {
    contractedRevenue,
    qualifyingTenants,
    excludedTenants,
    vacancyPct,
    expenseRatio,
    egi,
    toe,
    contractedNoi,
    note:
      `contracted basis: ${qualifyingTenants} qualifying tenant(s), ` +
      `${excludedTenants} excluded; ` +
      `revenue $${Math.round(contractedRevenue).toLocaleString()} × ` +
      `(1 − ${(vacancyPct * 100).toFixed(2)}% vac) × ` +
      `(1 − ${(expenseRatio * 100).toFixed(2)}% exp) = ` +
      `NOI $${Math.round(contractedNoi).toLocaleString()}`,
  };
}

interface NormalizedRentRollLine {
  kind: 'tenant' | 'unit';
  status: string;
  inPlaceRentAnnual: number | null;
}

function readRentRollLines(rentRoll: unknown): readonly NormalizedRentRollLine[] | null {
  if (rentRoll === null || rentRoll === undefined || typeof rentRoll !== 'object') return null;
  const obj = rentRoll as { lines?: unknown };
  if (!Array.isArray(obj.lines)) return null;
  const out: NormalizedRentRollLine[] = [];
  for (const raw of obj.lines) {
    if (raw === null || typeof raw !== 'object') continue;
    const l = raw as { kind?: unknown; status?: unknown; inPlaceRentAnnual?: unknown };
    const kind = l.kind === 'tenant' ? 'tenant' : l.kind === 'unit' ? 'unit' : null;
    if (kind === null) continue;
    const status = typeof l.status === 'string' ? l.status : 'UNKNOWN';
    const rent =
      typeof l.inPlaceRentAnnual === 'number' && Number.isFinite(l.inPlaceRentAnnual)
        ? l.inPlaceRentAnnual
        : null;
    out.push({ kind, status, inPlaceRentAnnual: rent });
  }
  return out;
}

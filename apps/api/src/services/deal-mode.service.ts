/**
 * deal-mode.service — the persisted deal-level "single_loan vs roll_up" flag. The ONE source of
 * truth that silos portfolio from single-loan: it drives the portfolio-input visibility, the
 * Create-Workbook export routing, and the dashboard Loan Type column — so they can't disagree.
 *
 * ★ SOURCE OF TRUTH = the DATA TAPE. Portfolio-ness comes from the tape's per-loan property
 *   count (the "Properties per Loan" column ∪ the decimal-breakout-row count), DERIVED at
 *   intake by deriveDealModesFromTape → deal_mode. A servicer can OVERRIDE via the toggle; the
 *   override wins (a companion 'deal_mode_source' marks 'manual' so a re-ingest never clobbers
 *   it). No-tape / user-created deals (no tape row) → no derived value → the toggle is the
 *   source (default single_loan).
 *
 * Rides the additive servicer_inputs store (fieldTypes 'deal_mode' + 'deal_mode_source'). No
 * schema change; MINT-SAFE — deal metadata, never a minted input.
 */
import { getServicerInput, upsertServicerInput, resolveLoanForAnalysis } from './servicer-inputs.service.js';
import { servicerInputsStore } from '../storage/servicer-inputs-store.js';
import type { PoolStore } from '../storage/pool-store.js';
import type { PoolId } from '@cre/contracts';

export type DealMode = 'single_loan' | 'roll_up';
export type DealModeSource = 'tape' | 'manual';

const FIELD = 'deal_mode' as const;
const SOURCE_FIELD = 'deal_mode_source' as const;

/** The deal's effective mode (default 'single_loan' when unset). */
export function getDealMode(poolId: string, loanInPoolId: string): DealMode {
  return getServicerInput(poolId, loanInPoolId, FIELD)?.value === 'roll_up' ? 'roll_up' : 'single_loan';
}

/** How the mode was set — 'manual' (servicer override), 'tape' (derived), or null (unset/default). */
export function getDealModeSource(poolId: string, loanInPoolId: string): DealModeSource | null {
  const v = getServicerInput(poolId, loanInPoolId, SOURCE_FIELD)?.value;
  return v === 'manual' || v === 'tape' ? v : null;
}

/** Write the mode with its source. Manual (the toggle) always wins over a later tape derive. */
function writeMode(poolId: string, loanInPoolId: string, mode: DealMode, source: DealModeSource, author: string): DealMode {
  upsertServicerInput({ poolId, loanInPoolId, fieldType: FIELD, value: mode, author });
  upsertServicerInput({ poolId, loanInPoolId, fieldType: SOURCE_FIELD, value: source, author });
  return mode;
}

/** Persist the servicer's MANUAL override (the toggle) — always takes precedence over the tape. */
export function setDealMode(args: { poolId: string; loanInPoolId: string; mode: DealMode; author: string }): DealMode {
  const value: DealMode = args.mode === 'roll_up' ? 'roll_up' : 'single_loan';
  return writeMode(args.poolId, args.loanInPoolId, value, 'manual', args.author);
}

/**
 * Set the mode FROM THE TAPE (propertyCount > 1 ⇒ roll_up). Respects a manual override: if the
 * current source is 'manual', this is a no-op (the servicer's choice stands across re-ingests).
 * Returns the resulting effective mode.
 */
export function setDealModeFromTape(args: { poolId: string; loanInPoolId: string; propertyCount: number | null | undefined; author?: string }): DealMode {
  if (getDealModeSource(args.poolId, args.loanInPoolId) === 'manual') return getDealMode(args.poolId, args.loanInPoolId);
  const mode: DealMode = (args.propertyCount ?? 1) > 1 ? 'roll_up' : 'single_loan';
  return writeMode(args.poolId, args.loanInPoolId, mode, 'tape', args.author ?? 'tape-ingest');
}

/**
 * ★ Derive deal_mode from a freshly-ingested tape's rows — the intake wiring. Joins each row to
 * its loan by originatorLoanRef (the stable identity the tape ingest keys on) and sets the
 * tape-derived mode. Manual overrides are preserved. Returns the # of loans updated.
 */
export function deriveDealModesFromTape(
  store: PoolStore,
  poolId: string,
  rows: ReadonlyArray<{ readonly originatorLoanRef: string | null; readonly propertyCount?: number | null }>,
): number {
  const loanIdByRef = new Map<string, string>();
  for (const k of store.listLoanNameKeysForPool(poolId as PoolId)) {
    if (k.originatorLoanRef !== null) loanIdByRef.set(k.originatorLoanRef, k.loanInPoolId);
  }
  let updated = 0;
  for (const row of rows) {
    if (row.originatorLoanRef === null) continue;
    const loanInPoolId = loanIdByRef.get(row.originatorLoanRef);
    if (loanInPoolId === undefined) continue;
    setDealModeFromTape({ poolId, loanInPoolId, propertyCount: row.propertyCount ?? 1 });
    updated += 1;
  }
  return updated;
}

/** The deal's mode resolved by analysis (graph revision → loan). Default 'single_loan'. */
export function resolveDealModeForAnalysis(graphRevisionId: string | null | undefined): DealMode {
  const loan = resolveLoanForAnalysis(graphRevisionId);
  if (loan === null) return 'single_loan';
  return getDealMode(loan.poolId, loan.loanInPoolId);
}

/** Pool ids with at least one loan marked 'roll_up' — the dashboard's portfolio set (1 query). */
export function listPortfolioPoolIds(): string[] {
  return servicerInputsStore().distinctPoolIdsWithFieldValue(FIELD, 'roll_up');
}

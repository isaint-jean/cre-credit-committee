/**
 * deal-mode.service — the persisted deal-level "single_loan vs roll_up" flag. This is the ONE
 * source of truth that silos portfolio from single-loan: it drives the portfolio-input
 * visibility (deal-room), the Create-Workbook export routing, and the dashboard Loan Type
 * column — so they can never disagree.
 *
 * Set by an explicit servicer toggle (the on-ramp), NOT derived from property count (which
 * would be circular — the portfolio-structure input is what defines the properties). Rides the
 * additive servicer_inputs store (fieldType 'deal_mode'); absent → 'single_loan'. MINT-SAFE:
 * deal metadata, never a minted input; single-loan deals never write it (default).
 */
import { getServicerInput, upsertServicerInput, resolveLoanForAnalysis } from './servicer-inputs.service.js';
import { servicerInputsStore } from '../storage/servicer-inputs-store.js';

export type DealMode = 'single_loan' | 'roll_up';

const FIELD = 'deal_mode' as const;

/** The deal's mode (default 'single_loan' when unset). */
export function getDealMode(poolId: string, loanInPoolId: string): DealMode {
  return getServicerInput(poolId, loanInPoolId, FIELD)?.value === 'roll_up' ? 'roll_up' : 'single_loan';
}

/** Persist the deal's mode (servicer toggle). Returns the stored value. */
export function setDealMode(args: { poolId: string; loanInPoolId: string; mode: DealMode; author: string }): DealMode {
  const value: DealMode = args.mode === 'roll_up' ? 'roll_up' : 'single_loan';
  upsertServicerInput({ poolId: args.poolId, loanInPoolId: args.loanInPoolId, fieldType: FIELD, value, author: args.author });
  return value;
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

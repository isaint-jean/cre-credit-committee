/**
 * Buyer-diff SUGGESTIONS — the accept/reject-able line-level adjustments the
 * engine actually made, derived from the frozen AdjustedInputs. These are the
 * decidable items the calm view iterates + the Part-B markup generator renders.
 *
 * ★ Only ENGINE-REAL adjustments are decidable (never fabricated): vacancy + total
 * opex + cap rate move directly (a line-item `adjustments[]` fired); NOI + value are
 * the headline consequences (state 'adjustment' on the buyer diff). AGREEMENT and
 * CAN'T-VERIFY findings are NOT decidable — nothing to accept/reject / it's a
 * "provide-a-doc" ask.
 *
 * ★ The "why" is the STRUCTURED ledger (AdjustmentEntry.ruleId/reason) — NO LLM,
 * deterministic, no hallucination. This is why v1 needs no live credits.
 */
import type { AdjustedInputs, ExtractionResult } from '@cre/contracts';

export type BuyerDiffDecision = 'accepted' | 'rejected' | 'pending';

export interface BuyerDiffWhy {
  readonly ruleId: string;
  readonly reason: string;
}

export interface BuyerDiffSuggestion {
  /** Stable decision key (mirrors the buyer-diff metric / driver name). */
  readonly findingId: string;
  readonly label: string;
  readonly issuer: number | null;
  readonly buyer: number | null;
  readonly deltaPct: number | null;
  readonly format: 'pct' | 'usd';
  /** The structured why — rule id + reason from the judgment ledger. */
  readonly why: readonly BuyerDiffWhy[];
  /** Evidence-grounded question a buyer asks (the calm-view phrasing). */
  readonly question: string;
  /** Current decision (merged from the sibling store; pending by default). */
  readonly decision: BuyerDiffDecision;
}

function whyOf(adjustments: ReadonlyArray<{ ruleId: string; reason: string }>): BuyerDiffWhy[] {
  return adjustments.map((a) => ({ ruleId: a.ruleId, reason: a.reason }));
}
function dpct(iss: number | null, buy: number | null): number | null {
  if (iss === null || buy === null || iss === 0) return null;
  return (buy - iss) / Math.abs(iss);
}

/**
 * Build the decidable suggestion list (the ~5 real adjustments). NO decisions
 * merged here — the route merges the stored decisions. `pending` placeholder.
 */
export function buildBuyerDiffSuggestions(
  ai: AdjustedInputs,
  ex: ExtractionResult,
): BuyerDiffSuggestion[] {
  const m = ai.metrics;
  const vac = ai.income.vacancyPct;
  const opex = ai.expenses.totalOperatingExpenses;
  const cap = ai.assumptions.capRate;
  const issuerValue = ex.asr?.impliedValue ?? ex.appraisal?.asIsValue ?? null;
  const issuerNoi = m.issuerStatedNoiSellerUw ?? m.issuerStatedNoiAsr ?? m.trailingActualNoi ?? m.inPlaceNoi;

  const raw: Array<Omit<BuyerDiffSuggestion, 'decision'> & { moved: boolean }> = [
    {
      findingId: 'vacancy', label: 'Vacancy (economic)', issuer: vac.raw, buyer: vac.adjusted,
      deltaPct: dpct(vac.raw, vac.adjusted), format: 'pct', why: whyOf(vac.adjustments),
      question: `Why is vacancy at ${pct(vac.raw)} when a buyer holds ${pct(vac.adjusted)}? A buyer underwrites the submarket median — concessions mean effective rents don't hold at face.`,
      moved: vac.adjustments.length > 0,
    },
    {
      findingId: 'totalOpEx', label: 'Total Operating Expenses', issuer: opex.raw, buyer: opex.adjusted,
      deltaPct: dpct(opex.raw, opex.adjusted), format: 'usd', why: whyOf(opex.adjustments),
      question: `Are expenses under-run vs market? A buyer floors total opex to the market expense ratio (${usd(opex.raw)} → ${usd(opex.adjusted)}).`,
      moved: opex.adjustments.length > 0,
    },
    {
      findingId: 'capRate', label: 'Cap Rate', issuer: cap.raw, buyer: cap.adjusted,
      deltaPct: dpct(cap.raw, cap.adjusted), format: 'pct', why: whyOf(cap.adjustments),
      question: `Does the cap rate price the concentration? A buyer widens +${Math.round((cap.adjusted - (cap.raw ?? 0)) * 10000)} bps for tenancy concentration.`,
      moved: cap.adjustments.length > 0,
    },
    {
      findingId: 'noi', label: 'Net Operating Income', issuer: issuerNoi, buyer: m.noi,
      deltaPct: dpct(issuerNoi, m.noi), format: 'usd',
      // NOI is derived — its why is the constituent drivers (vacancy + opex).
      why: [...whyOf(vac.adjustments), ...whyOf(opex.adjustments)],
      question: `Would a buyer accept this NOI? Our independent underwrite is ${usd(m.noi)} vs the issuer's ${usd(issuerNoi)} — the vacancy + expense discipline above.`,
      moved: m.noi !== null && issuerNoi !== null && Math.abs((m.noi - issuerNoi) / (issuerNoi || 1)) > 0.005,
    },
    {
      findingId: 'value', label: 'Value (implied)', issuer: issuerValue, buyer: m.value,
      deltaPct: dpct(issuerValue, m.value), format: 'usd',
      why: [{ ruleId: 'DERIVED', reason: 'lower buyer NOI capitalized at the wider buyer cap rate' }],
      question: `Does value hold? It falls out of the lower NOI at the wider cap (${usd(issuerValue)} → ${usd(m.value)}).`,
      moved: m.value !== null && issuerValue !== null && Math.abs((m.value - issuerValue) / (issuerValue || 1)) > 0.005,
    },
  ];
  // Only ENGINE-REAL adjustments are decidable — drop anything that didn't move.
  return raw.filter((s) => s.moved).map(({ moved: _m, ...s }) => ({ ...s, decision: 'pending' as const }));
}

function pct(v: number | null): string { return v === null ? '—' : `${(v * 100).toFixed(1)}%`; }
function usd(v: number | null): string { return v === null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`; }

/** Merge stored decisions onto the suggestion list (absent → pending). */
export function mergeDecisions(
  suggestions: BuyerDiffSuggestion[],
  stored: ReadonlyArray<{ findingId: string; decision: BuyerDiffDecision }>,
): BuyerDiffSuggestion[] {
  const byId = new Map(stored.map((d) => [d.findingId, d.decision]));
  return suggestions.map((s) => ({ ...s, decision: byId.get(s.findingId) ?? 'pending' }));
}

/** The set of valid decidable findingIds (for PUT validation). */
export function decidableFindingIds(suggestions: BuyerDiffSuggestion[]): Set<string> {
  return new Set(suggestions.map((s) => s.findingId));
}

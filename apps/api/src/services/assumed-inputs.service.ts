/**
 * assumed-inputs — surface which of a verdict's inputs are ASSUMED (substituted
 * from a market benchmark / defaulted), not SOURCED from the deal's documents.
 *
 * ★ WHY (a B-piece buyer must know which numbers are facts vs assumptions): 640's
 * score ran on a 6.5% interest rate that is a BENCHMARK SUBSTITUTION
 * (JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK — the ASR is pre-pricing and states
 * no coupon), and its annual debt service ($26M) is derived from that assumed
 * rate — so DSCR / coverage rest on an assumption. An assumed input is NOT a
 * sourced input; the completeness surface must say so.
 *
 * Mechanism: a substituted/defaulted line item carries `raw === null` (nothing
 * extracted) + `adjusted` (the assumed value) + an AdjustmentEntry whose ruleId
 * records the substitution (adjustSubstituteOnly / defaulting). READ-ONLY.
 */

/** One assumed (non-sourced) input in a verdict. */
export interface AssumedInput {
  /** Dotted path in AdjustedInputs, e.g. 'loan.interestRate'. */
  readonly path: string;
  /** Human label, e.g. 'Interest rate'. */
  readonly label: string;
  /** The assumed value the score used. */
  readonly assumedValue: number | null;
  /** The rule that recorded the assumption (null for a bare MANUAL fill). */
  readonly ruleId: string | null;
  /** The recorded reason, when present. */
  readonly reason: string | null;
  /** True for inputs that feed DSCR / debt-yield / coverage (the load-bearing ones). */
  readonly feedsCoverage: boolean;
}

/** Friendly labels + coverage-dependency for the load-bearing loan/income paths. */
const LABELS: Record<string, { label: string; feedsCoverage: boolean }> = {
  'loan.interestRate': { label: 'Interest rate / coupon', feedsCoverage: true },
  'loan.debtServiceAnnual': { label: 'Annual debt service', feedsCoverage: true },
  'loan.maturityBalance': { label: 'Maturity balance', feedsCoverage: false },
  'loan.ioPeriodMonths': { label: 'Interest-only period', feedsCoverage: false },
  'income.effectiveGrossIncome': { label: 'Effective gross income', feedsCoverage: true },
};

function looksSubstituted(ruleId: string): boolean {
  return /SUBSTITUT|BENCHMARK|DEFAULT/i.test(ruleId);
}

interface LineItemish {
  raw: unknown;
  adjusted: unknown;
  source?: unknown;
  adjustments?: Array<{ ruleId?: string; reason?: string }>;
}

function isLineItem(o: unknown): o is LineItemish {
  return !!o && typeof o === 'object' && 'raw' in o && 'adjusted' in o && Array.isArray((o as LineItemish).adjustments);
}

/**
 * Walk an AdjustedInputs tree and collect the inputs that were ASSUMED (raw null)
 * with either a named substitution/benchmark/default rule OR a labelled
 * load-bearing loan/income path. Conservative-zero fills with no rule and no
 * label are omitted (they're not a hidden assumption a buyer needs flagged).
 */
export function getAssumedInputs(adjustedInputs: unknown): AssumedInput[] {
  const out: AssumedInput[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return;
    if (isLineItem(node)) {
      if (node.raw === null) {
        const sub = (node.adjustments ?? []).find((a) => a.ruleId && looksSubstituted(a.ruleId));
        const label = LABELS[path];
        if (sub || label) {
          out.push({
            path,
            label: label?.label ?? path,
            assumedValue: typeof node.adjusted === 'number' ? node.adjusted : null,
            ruleId: sub?.ruleId ?? null,
            reason: sub?.reason ?? null,
            feedsCoverage: label?.feedsCoverage ?? false,
          });
        }
      }
      return; // a line item is a leaf — don't descend into its fields
    }
    for (const k of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    }
  };
  walk(adjustedInputs, '');
  // Load-bearing coverage inputs first.
  return out.sort((a, b) => Number(b.feedsCoverage) - Number(a.feedsCoverage));
}

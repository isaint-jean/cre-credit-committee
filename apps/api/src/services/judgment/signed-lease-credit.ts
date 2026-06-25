import type { RentRoll } from '@cre/contracts';

/**
 * Signed-lease (PRELEASED) credit to the sustainable trailing NOI — a B-piece
 * underwriting rule: a SIGNED lease earns credit even pre-commencement (it has
 * cleared the leasing process), while LOIs / speculative lease-up do not.
 *
 * The trailing T-12 alone under-states sustainable income when a large signed
 * lease commences just after the trailing window (e.g. Sunroad's GSA: PRELEASED,
 * commencing 2024-06-01, vacant in the Feb-2024 T-12). This adds the contractual
 * rent of PRELEASED leases — net of operating expenses, full-annual, additive
 * over T-12 — to produce a defensible "contractual-in-place" sustainable NOI.
 *
 * ★ Window keys off the RENT ROLL's as-of date (the deal vintage), NOT the
 *   analysis as-of — a vintage-2024 rent roll evaluated in a 2026 demo must
 *   still measure commencement against 2024.
 * ★ Inert by construction: no PRELEASED-in-window leases → returns t12Noi
 *   unchanged (no regression on deals the rule doesn't apply to).
 *
 * PURE — no store, no LLM, deterministic. Feeds `dealBag.t12Noi` via the
 * adapter's `t12NoiOverride`, which becomes the sustainable-cashflow base in
 * `evaluateDeal`.
 *
 * Validated (Sunroad): 3,863,872 + 5,168,982 × (1 − 0.30) = 7,482,159.
 */
export interface SignedLeaseCreditResult {
  /** Sustainable NOI after the signed-lease credit (equals t12Noi when none apply). */
  readonly noi: number;
  /** Human-readable audit string for the memo/workbook ("T12 only" when inert). */
  readonly provenance: string;
  /** Names of the leases credited (empty when inert). */
  readonly creditedTenants: readonly string[];
}

export function computeSignedLeaseCreditedNoi(args: {
  readonly rentRoll: RentRoll | null;
  readonly t12Noi: number;
  readonly expenseRatio: number;
  /** The RENT ROLL's as-of date (deal vintage) — NOT the analysis as-of. */
  readonly asOfDate: string | null;
  readonly windowMonths?: number;
}): SignedLeaseCreditResult {
  const { rentRoll, t12Noi, expenseRatio, asOfDate, windowMonths = 12 } = args;
  const NONE: SignedLeaseCreditResult = { noi: t12Noi, provenance: 'T12 only', creditedTenants: [] };

  if (rentRoll === null || asOfDate === null) return NONE;
  const asOf = new Date(asOfDate);
  if (Number.isNaN(asOf.getTime())) return NONE;
  const windowEnd = new Date(asOf);
  windowEnd.setMonth(windowEnd.getMonth() + windowMonths);

  const credited: { readonly name: string; readonly rent: number }[] = [];
  for (const line of rentRoll.lines) {
    // RentRollLine is a discriminated union; only tenant leases carry a
    // contractual annual rent + a signed status. Unit (multifamily) rows are
    // not signed commercial leases — skip.
    if (line.kind !== 'tenant') continue;
    if (line.status !== 'PRELEASED') continue;
    if (line.leaseStart === null) continue;
    const start = new Date(line.leaseStart);
    if (Number.isNaN(start.getTime())) continue;
    // Must commence in the FUTURE as-of the rent roll (PRELEASED ⇒ not yet
    // commenced) AND within the window. A past leaseStart is effectively
    // in-place (its income is already in the T-12) — skip to avoid double-count.
    if (start < asOf) continue;
    if (start > windowEnd) continue;
    if (typeof line.inPlaceRentAnnual !== 'number' || !Number.isFinite(line.inPlaceRentAnnual)) continue;
    credited.push({ name: line.tenantName ?? '(unnamed)', rent: line.inPlaceRentAnnual });
  }
  if (credited.length === 0) return NONE;

  const netFactor = 1 - expenseRatio;
  const creditNoi = credited.reduce((sum, c) => sum + c.rent * netFactor, 0);
  const provenance =
    'T12 + signed-lease credit: ' +
    credited
      .map((c) => `${c.name} $${Math.round(c.rent).toLocaleString()} × (1−${expenseRatio}) net`)
      .join('; ');

  return {
    noi: t12Noi + creditNoi,
    provenance,
    creditedTenants: credited.map((c) => c.name),
  };
}

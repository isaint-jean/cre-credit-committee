/**
 * annexA-verify — issuer-agnostic identity verification + verdict layer for
 * 424B5 Annex A loan-level data.
 *
 * Shared between the per-issuer walkers (currently WFRBS 2013-C11; CGCMT
 * 2013-GC15 in progress 2026-06-14). Each walker produces an
 * `ExtractedLoan` of this exact shape, then passes it (plus a sibling
 * lookup) to `verify()`. The verdict semantics are doc-agnostic and
 * single-sourced here.
 *
 * Carved out 2026-06-14 from calibration-annexA-wfrbs-shelf-generalizer.ts.
 * Pure refactor — no behavior change. WFRBS shelf 72 CLEAN / 0 FLAGGED /
 * 0 UNCHECKED + Loan #17 14/14 regression byte-identical pre- vs post-move.
 */

/* ──────────────────────────────────────────────────────────────────────── */
/* Group-construct types                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Pari-passu split-loan combination. The trust holds ONE note of a
 * multi-note whole loan; the issuer's stated LTV/DSCR/DY are computed on
 * the combined whole-loan basis. The combined balance is captured at
 * extraction time from the footnote prose (single scalar; no sibling
 * lookup needed at verify time).
 */
export interface PariPassuCombination {
  readonly noteNumber: string;
  readonly totalNotes: number;
  readonly combinedCutOffBalance: number;
}

/**
 * Cross-collat GROUP MEMBERSHIP (extraction-side, not aggregated).
 *
 * Distinct from pari-passu (which is one whole loan split into two notes
 * sharing the trust). Cross-collat is N DISTINCT loans, each with its own
 * loanAmount / concludedValue / NOI, whose stated LTV/DSCR/DY ratios in
 * the prospectus are computed on the GROUP-AGGREGATE basis.
 *
 * Stored here is JUST the group identity + sibling list. The aggregated
 * denominator (sum of loanAmounts) and numerators (sum of concludedValues
 * / statedRatioNumerators) are computed at verify-time from the sibling
 * records — they are NOT baked onto the loan, so each loan keeps its own
 * extracted trust-slice values untouched.
 *
 * Mutually exclusive with PariPassuCombination by construction (the
 * per-issuer parsers key on disjoint footnote sentence shapes); verify()
 * asserts a loan never has both set.
 */
export interface CrossCollatGroup {
  readonly groupId: string;               // synthetic — derived from sorted memberIds
  readonly memberIds: readonly number[];  // sorted ascending
}

/* ──────────────────────────────────────────────────────────────────────── */
/* ExtractedLoan — the cross-issuer contract                                */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * The per-loan record each issuer walker produces. Issuer-neutral — every
 * field is a parsed semantic value, not a layout artifact. Adding a new
 * shelf walker means producing this shape via whatever parsing the
 * specific prospectus format requires; the verify() contract is
 * unchanged.
 *
 * Field caveats noted at the walker layer (NOT contract leaks):
 *   - `uwY1Revenue` / `uwY1OpEx` are carried for downstream display/audit;
 *     verify() does not read them.
 *
 * ★ KEY ROLE-BASED FIELDS (do not confuse with NOI / NCF accounting names):
 *
 *   `statedRatioNumerator` — the cashflow figure the issuer USED as the
 *     numerator for the stated DY (uwDebtYield) and DSCR (uwDscr) ratios.
 *     For WFRBS 2013-C11 this is the property's UW NOI. For CGCMT
 *     2013-GC15 this is the property's UW NCF. The contract carries the
 *     issuer-chosen value so that verify() can foot the stated ratios
 *     without any NOI-vs-NCF accounting knowledge. The field name
 *     deliberately avoids "NOI" or "NCF" — populate with WHATEVER the
 *     issuer used to compute the ratios appearing in `uwDebtYield` and
 *     `uwDscr`.
 *
 *   `uwDscr` / `uwDebtYield` — the issuer's STATED ratio values, read
 *     verbatim from the prospectus column. Whether the issuer computed
 *     these on NOI or NCF is encoded into `statedRatioNumerator` (NOT
 *     into the field name).
 */
export interface ExtractedLoan {
  readonly controlNumber: number;
  // T1-equivalent
  readonly generalPropertyType: string | null;
  readonly specificPropertyType: string | null;
  // T2-equivalent
  readonly loanAmount: number | null;     // == originalLoanAmount (THIS trust's slice)
  readonly maturityDate: string | null;
  // T3-equivalent
  readonly coupon: number | null;
  readonly originalTermMonths: number | null;
  readonly ioMonths: number | null;
  // T4-equivalent (load-bearing ratios — stated values)
  readonly amortMonths: number | null;
  readonly concludedValue: number | null;  // == appraised
  readonly uwDscr: number | null;          // STATED DSCR — verify() reads this
  readonly concludedLtv: number | null;
  readonly uwDebtYield: number | null;     // STATED DY — verify() reads this
  // T5-equivalent
  readonly t12Noi: number | null;
  readonly t12Egi: number | null;
  readonly t12OpEx: number | null;
  readonly occupancyCurrent: number | null;
  // T6-equivalent
  readonly statedRatioNumerator: number | null;  // ★ numerator behind uwDscr + uwDebtYield (NOI on WFRBS, NCF on CGCMT)
  readonly uwY1Revenue: number | null;
  readonly uwY1OpEx: number | null;
  // Footnote-derived group memberships (issuer-agnostic shapes)
  readonly pariPassuCombination: PariPassuCombination | null;
  readonly crossCollatGroup: CrossCollatGroup | null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Verdict surface + tolerances                                             */
/* ──────────────────────────────────────────────────────────────────────── */

export type IdentityCheck = 'LTV' | 'DY' | 'DSCR' | 'T5_FOOT' | 'DY_NOI';
export const LTV_TOL     = 0.005;   // 50 bps
export const DY_TOL      = 0.005;   // 50 bps
export const DSCR_TOL    = 0.25;    // 0.25x — loose
export const T5_FOOT_TOL = 0.005;   // 0.5% of EGI — TTM EGI − OpEx − NOI must foot

export interface CheckFailure {
  readonly check: IdentityCheck;
  readonly stated: number | null;
  readonly derived: number | null;
  readonly delta: number | null;
  readonly tolerance: number;
}

export interface Verdict {
  readonly status: 'CLEAN' | 'FLAGGED' | 'UNCHECKED';
  readonly failures: readonly CheckFailure[];
  readonly reason: string;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Issuer-neutral formatters (used inside verify's failure messages and    */
/* re-exported for walker-side display tables)                              */
/* ──────────────────────────────────────────────────────────────────────── */

export function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}
export function fmtPct(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(d) + '%';
}
export function fmtNum(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Annualized debt service for an amortizing loan.                          */
/* ──────────────────────────────────────────────────────────────────────── */

export function computeAnnualDs(loan: number, rate: number, amortMonths: number): number | null {
  if (amortMonths === 0) return loan * rate;  // IO
  const r = rate / 12;
  if (r <= 0) return null;
  const n = amortMonths;
  const monthly = loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  return monthly * 12;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* verify — the verdict layer                                               */
/* ──────────────────────────────────────────────────────────────────────── */

export function verify(loan: ExtractedLoan, loanLookup: ReadonlyMap<number, ExtractedLoan>): Verdict {
  const failures: CheckFailure[] = [];
  // Track per-check execution. The three LOAD-BEARING identities (LTV, DY,
  // DSCR) interrelate loan size, value, and NOI — when at least one ran we
  // actually verified something about the deal. T5_FOOT is purely INTRA-row
  // (TTM EGI − OpEx ≈ TTM NOI) and validates the TTM triple's internal
  // consistency only; it does NOT verify the cross-table relationships and
  // MUST NOT promote a loan with all-null load-bearing inputs to CLEAN.
  // Pre-2026-06-14 the single `allUnverifiable` flag conflated these, which
  // produced silent-CLEAN verdicts whenever T5_FOOT happened to run on a
  // loan whose loanAmount/concludedValue/statedRatioNumerator were all null (~12 loans
  // on the WFRBS 2013-C11 shelf alone — see the Loan #1 walker-bug
  // diagnosis from 2026-06-14).
  const ran = { LTV: false, DY: false, DSCR: false, T5_FOOT: false };

  // ★ Group-aware identity basis. THREE bases possible, in precedence order:
  //
  //   1. pariPassuCombination — pari-passu split-loan: the trust holds one
  //      note of a multi-note whole loan. denom = combined whole-loan
  //      balance (a SINGLE pre-extracted scalar, no sibling lookup needed).
  //      Numerator (concludedValue, statedRatioNumerator) stays the property's own — the
  //      property is ONE asset, just split into two notes for trust-vs-
  //      external ownership.
  //
  //   2. crossCollatGroup — N DISTINCT loans on N DISTINCT properties,
  //      cross-collateralized as a group. The issuer's stated LTV/DSCR/DY
  //      are computed against the GROUP AGGREGATE: SUM of all members'
  //      loanAmounts on one side, SUM of all members' concludedValues /
  //      statedRatioNumerators on the other. The aggregation is computed HERE at
  //      verify-time from sibling records (via `loanLookup`); we never
  //      mutate any ExtractedLoan record.
  //
  //   3. neither — standalone: denom = own loanAmount, numerators = own
  //      concludedValue / statedRatioNumerator. The vast majority of loans.
  //
  // Pari-passu and cross-collat are MUTUALLY EXCLUSIVE by parser-shape
  // construction (their footnote sentences don't overlap). We assert it
  // here as a runtime guard against a future parser bug.
  if (loan.pariPassuCombination !== null && loan.crossCollatGroup !== null) {
    throw new Error(
      `INVARIANT: loan #${loan.controlNumber} is tagged BOTH pari-passu AND ` +
      `cross-collat — these are mutually exclusive group constructs. Re-check ` +
      `the parsers.`,
    );
  }

  // Compute (denom, ltvNumerator, dyNumerator) under the precedence above.
  // ltvNumerator = aggregated concludedValue for LTV's denominator side
  //               (so the identity is denom / ltvNumerator).
  // dyNumerator  = aggregated statedRatioNumerator for DY/DSCR's numerator side.
  let denom: number | null;
  let ltvDenom: number | null;     // value side of LTV
  let dyNoi: number | null;        // NOI side of DY/DSCR
  if (loan.pariPassuCombination !== null) {
    denom    = loan.pariPassuCombination.combinedCutOffBalance;
    ltvDenom = loan.concludedValue;   // property's own appraisal (whole-loan IS this single property)
    dyNoi    = loan.statedRatioNumerator;   // property's own stated-ratio numerator (issuer-chosen NOI or NCF)
  } else if (loan.crossCollatGroup !== null) {
    // Sum from sibling records. If ANY member is missing a field, the
    // aggregate is null (and the corresponding identity check skips —
    // honest UNCHECKED rather than partial-foot misreport).
    const members = loan.crossCollatGroup.memberIds.map(id => loanLookup.get(id)).filter((x): x is ExtractedLoan => x !== undefined);
    const sumOrNull = (values: ReadonlyArray<number | null>): number | null =>
      values.every(v => v !== null) ? values.reduce<number>((s, v) => s + (v as number), 0) : null;
    denom    = sumOrNull(members.map(m => m.loanAmount));
    ltvDenom = sumOrNull(members.map(m => m.concludedValue));
    dyNoi    = sumOrNull(members.map(m => m.statedRatioNumerator));
  } else {
    denom    = loan.loanAmount;
    ltvDenom = loan.concludedValue;
    dyNoi    = loan.statedRatioNumerator;
  }

  // LTV: derived = denom / ltvDenom
  if (denom !== null && ltvDenom !== null && loan.concludedLtv !== null && ltvDenom > 0) {
    ran.LTV = true;
    const derived = denom / ltvDenom;
    const delta = Math.abs(derived - loan.concludedLtv);
    if (delta > LTV_TOL) failures.push({ check: 'LTV', stated: loan.concludedLtv, derived, delta, tolerance: LTV_TOL });
  }

  // DY: derived = dyNoi / denom
  if (dyNoi !== null && denom !== null && loan.uwDebtYield !== null && denom > 0) {
    ran.DY = true;
    const derived = dyNoi / denom;
    const delta = Math.abs(derived - loan.uwDebtYield);
    if (delta > DY_TOL) failures.push({ check: 'DY', stated: loan.uwDebtYield, derived, delta, tolerance: DY_TOL });
  }

  // DSCR: derived = dyNoi / computedDs(denom, coupon, amortMonths) — LOOSE
  if (dyNoi !== null && denom !== null && loan.coupon !== null && loan.amortMonths !== null && loan.uwDscr !== null && denom > 0) {
    ran.DSCR = true;
    const ds = computeAnnualDs(denom, loan.coupon, loan.amortMonths);
    if (ds !== null && ds > 0) {
      const derived = dyNoi / ds;
      const delta = Math.abs(derived - loan.uwDscr);
      if (delta > DSCR_TOL) failures.push({ check: 'DSCR', stated: loan.uwDscr, derived, delta, tolerance: DSCR_TOL });
    }
  }

  // T5 intra-foot: stated TTM NOI ≈ stated TTM EGI − stated TTM OpEx
  // (the prospectus's three stated TTM figures must foot — tight tolerance).
  // INFORMATIONAL: see ran.LTV/DY/DSCR for verdict gating; this check alone
  // never promotes UNCHECKED to CLEAN.
  if (loan.t12Egi !== null && loan.t12OpEx !== null && loan.t12Noi !== null && loan.t12Egi > 0) {
    ran.T5_FOOT = true;
    const derived = loan.t12Egi - loan.t12OpEx;
    const delta = Math.abs(derived - loan.t12Noi);
    const rel = delta / loan.t12Egi;
    if (rel > T5_FOOT_TOL) failures.push({ check: 'T5_FOOT', stated: loan.t12Noi, derived, delta: rel, tolerance: T5_FOOT_TOL });
  }

  const loadBearingRan = ran.LTV || ran.DY || ran.DSCR;
  if (!loadBearingRan) {
    // UNCHECKED — no load-bearing identity could run. List the null inputs so
    // the cause is visible (and so the eventual walker fix knows what to
    // populate). `denom`-derivation note: when loanAmount AND pari-passu are
    // both null, denom is null and ALL three load-bearing identities skip
    // regardless of the other inputs.
    const nullInputs: string[] = [];
    if (denom === null) {
      nullInputs.push(
        loan.pariPassuCombination !== null ? 'pariPassuDenom'
        : loan.crossCollatGroup !== null    ? `crossCollatGroupLoanAmount(${loan.crossCollatGroup.groupId})`
        : 'loanAmount',
      );
    }
    if (ltvDenom === null) {
      nullInputs.push(loan.crossCollatGroup !== null ? `crossCollatGroupConcludedValue(${loan.crossCollatGroup.groupId})` : 'concludedValue');
    }
    if (dyNoi === null) {
      nullInputs.push(loan.crossCollatGroup !== null ? `crossCollatGroupStatedRatioNumerator(${loan.crossCollatGroup.groupId})` : 'statedRatioNumerator');
    }
    if (loan.concludedLtv === null) nullInputs.push('concludedLtv');
    if (loan.uwDebtYield === null) nullInputs.push('uwDebtYield');
    if (loan.uwDscr === null) nullInputs.push('uwDscr');
    if (loan.coupon === null) nullInputs.push('coupon');
    if (loan.amortMonths === null) nullInputs.push('amortMonths');
    const t5tag = ran.T5_FOOT
      ? (failures.some(f => f.check === 'T5_FOOT') ? '; T5_FOOT ran AND FAILED' : '; T5_FOOT ran (informational only — no promotion)')
      : '';
    return { status: 'UNCHECKED', failures: [], reason: `no load-bearing identity ran — null: ${nullInputs.join(', ') || '(none)'}${t5tag}` };
  }
  if (failures.length === 0) {
    const ranList = (['LTV', 'DY', 'DSCR', 'T5_FOOT'] as const).filter(k => ran[k]).join('+');
    return { status: 'CLEAN', failures: [], reason: `${ranList} within tolerance` };
  }
  const fmtFailure = (f: CheckFailure): string => {
    if (f.check === 'DSCR') {
      return `${f.check}: stated=${fmtNum(f.stated, 2)}x derived=${fmtNum(f.derived, 2)}x |Δ|=${fmtNum(f.delta, 2)}x`;
    }
    if (f.check === 'T5_FOOT') {
      return `${f.check}: stated=${fmtUsd(f.stated)} derived=${fmtUsd(f.derived)} (EGI − OpEx) rel-|Δ|=${fmtPct(f.delta, 2)}`;
    }
    return `${f.check}: stated=${fmtPct(f.stated, 2)} derived=${fmtPct(f.derived, 2)} |Δ|=${fmtPct(f.delta, 2)}`;
  };
  return { status: 'FLAGGED', failures, reason: failures.map(fmtFailure).join(' · ') };
}

/**
 * Rollover Summary calc (Property Detail - Comm, Part B). PURE compute — no
 * render, no schema, no DB. Reproduces the OK-TO-PRINT rollover from the rent
 * roll we already extract.
 *
 * Anchor: lease-expiration buckets are relative to the LOAN START (proven to
 * reproduce the key; the rent-roll asOf is ~1 month off and mis-buckets a
 * boundary lease). loanStartDate is an INPUT — the caller derives it (today as
 * maturityDate − term; later a real extracted origination date can replace it
 * with no calc change). See memory: rollover-loan-start-extraction.
 *
 * Bucket rule (validated): yearBucket = floor(monthsBetween(loanStart, leaseEnd) / 12) + 1.
 *
 * Tier rule mirrors applyRentRollSizeTier (template-engine.service.ts:2175) —
 * SF≥100k → M (Large), SF<10k → T (Temp), else L (Small). Reused, not re-derived.
 */

export interface RolloverInputLine {
  readonly squareFeet: number | null;
  readonly leaseStart: string | null;
  readonly leaseEnd: string | null;
  readonly inPlaceRentAnnual: number | null;
  readonly recoveriesAnnual: number | null;
}

export interface RolloverYearRow {
  readonly year: number;                 // 1..10
  readonly tenants: number;
  readonly totalSf: number;
  readonly pctSf: number;                // of total NRA
  readonly cumulativeSf: number;
  readonly cumulativeSfPct: number;
  readonly avgGrossRentPsf: number | null;
  readonly totalGrossRent: number;       // in-place + recoveries
  readonly pctUwRent: number;            // of total UW gross rent
  readonly cumulativeRent: number;
  readonly cumulativeRentPct: number;
}

export type RolloverTierRow = 'Large' | 'Small' | 'Temp';

export interface RolloverMatrixCell {
  readonly tier: RolloverTierRow;
  readonly startYear: number;            // calendar lease-start year
  readonly avgNetRentPsf: number | null; // SF-weighted in-place (net) rent PSF
  readonly count: number;
}

export interface RolloverSummary {
  readonly years: ReadonlyArray<RolloverYearRow>;       // exactly 10 rows
  /**
   * Net-rents-by-start-year × tier matrix — DEFERRED (null). The per-year rows
   * above reproduce the key exactly; the matrix does NOT: the key's "Net Rent"
   * is a lower measure (net-effective / starting at commencement) than our face
   * `inPlaceRentAnnual`, so a face-basis matrix would ship wrong values. Gated
   * on resolving the rent basis + confirming we extract the inputs — see memory
   * follow-up `rollover-matrix-net-rent-basis`. When built, reuse the tier rule
   * from applyRentRollSizeTier (template-engine.service.ts:2175).
   */
  readonly matrix: ReadonlyArray<RolloverMatrixCell> | null;
  readonly totalNra: number;
  readonly totalUwGrossRent: number;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

export function computeRolloverSummary(
  lines: ReadonlyArray<RolloverInputLine>,
  loanStartDate: string,
): RolloverSummary {
  const loanStart = new Date(loanStartDate);
  const totalNra = lines.reduce((s, l) => s + (l.squareFeet ?? 0), 0);
  // %UW denominator = total UW gross rent, computed from the rent roll (NOT hardcoded).
  const totalUwGrossRent = lines.reduce(
    (s, l) => s + ((l.inPlaceRentAnnual ?? 0) + (l.recoveriesAnnual ?? 0)),
    0,
  );

  const buckets = new Map<number, { n: number; sf: number; gross: number }>();
  for (const l of lines) {
    if (!l.leaseEnd) continue;
    const yr = Math.floor(monthsBetween(loanStart, new Date(l.leaseEnd)) / 12) + 1;
    const gross = (l.inPlaceRentAnnual ?? 0) + (l.recoveriesAnnual ?? 0);
    const b = buckets.get(yr) ?? { n: 0, sf: 0, gross: 0 };
    b.n += 1; b.sf += l.squareFeet ?? 0; b.gross += gross;
    buckets.set(yr, b);
  }

  const years: RolloverYearRow[] = [];
  let cumSf = 0;
  let cumRent = 0;
  for (let yr = 1; yr <= 10; yr++) {
    const b = buckets.get(yr) ?? { n: 0, sf: 0, gross: 0 };
    cumSf += b.sf;
    cumRent += b.gross;
    years.push({
      year: yr,
      tenants: b.n,
      totalSf: b.sf,
      pctSf: totalNra > 0 ? b.sf / totalNra : 0,
      cumulativeSf: cumSf,
      cumulativeSfPct: totalNra > 0 ? cumSf / totalNra : 0,
      avgGrossRentPsf: b.sf > 0 ? b.gross / b.sf : null,
      totalGrossRent: b.gross,
      pctUwRent: totalUwGrossRent > 0 ? b.gross / totalUwGrossRent : 0,
      cumulativeRent: cumRent,
      cumulativeRentPct: totalUwGrossRent > 0 ? cumRent / totalUwGrossRent : 0,
    });
  }

  // Net-rents-by-start-year × tier matrix: DEFERRED. A face-`inPlaceRentAnnual`
  // basis does NOT reproduce the key (key uses a lower net-effective/starting
  // rent). Returning null rather than shipping wrong values — see
  // RolloverSummary.matrix doc + memory `rollover-matrix-net-rent-basis`.
  return { years, matrix: null, totalNra, totalUwGrossRent };
}

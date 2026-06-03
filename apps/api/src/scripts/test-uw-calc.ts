/**
 * Tests for `@cre/shared/utils/uw-calc` (legacy primitives still routed
 * through `synthesizeUwModelFromGraph` → `recalculateFullModel`).
 *
 *   npx tsx apps/api/src/scripts/test-uw-calc.ts
 *
 * Surface focus: IO-only debt service. The legacy entry point used to
 * gate `amortizationYears > 0` at the top, returning null for every
 * IO-only loan; `recalculateFullModel` then propagated that null into
 * `dscr`, leaving Conclusions & Escrows!I16 AWAITING_INPUT on every
 * IO-only deal. The fix unifies behavior with the new-spine
 * `judgment/amortization.ts:annualDebtService` — IO-only loans report
 * `loanAmount * (annualRate / 100)`.
 *
 * Unit convention reminder: in this legacy primitive `annualRate` is
 * PERCENT (e.g. 7.9 for 7.9%) — see uw-calc.ts:65 monthlyRate = annualRate / 100 / 12.
 */
import { calculateAnnualDebtService } from '@cre/shared';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertClose(a: number | null, b: number, eps: number, m: string): void {
  if (a === null) { fail(`${m} (actual=null, expected=${b})`); return; }
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

console.log('calculateAnnualDebtService (legacy uw-calc primitive):');

// --- Amortizing P&I (unchanged behavior; regression coverage) -----------
{
  // $100k @ 6% / 30y → annual ≈ $7,194.62
  const r = calculateAnnualDebtService(100_000, 6, 30);
  assertClose(r, 7194.62, 0.5, '$100k @ 6% / 30y → ~$7,194 annual');
}
{
  // $1M @ 7% / 30y → annual ≈ $79,836.30
  const r = calculateAnnualDebtService(1_000_000, 7, 30);
  assertClose(r, 79_836.30, 1, '$1M @ 7% / 30y → ~$79,836 annual');
}

// --- IO-only loans (THIS IS THE FIX — was returning null before) --------
{
  // Sunroad: $82.46M @ 7.9% IO-only → $6,514,340 annual.
  const r = calculateAnnualDebtService(82_460_000, 7.9, 0);
  assertClose(r, 6_514_340, 1, 'IO-only Sunroad: $82.46M @ 7.9% → $6,514,340 annual');
}
{
  // Round-number: $1M @ 5% IO-only → $50,000 annual.
  const r = calculateAnnualDebtService(1_000_000, 5, 0);
  assertClose(r, 50_000, 0.01, 'IO-only: $1M @ 5% → $50k annual');
}
{
  // Defensive: negative or NaN amortizationYears → treated as IO-only.
  const r = calculateAnnualDebtService(1_000_000, 5, -1);
  assertClose(r, 50_000, 0.01, 'Negative amortizationYears → IO-only');
}
{
  const r = calculateAnnualDebtService(1_000_000, 5, NaN);
  assertClose(r, 50_000, 0.01, 'NaN amortizationYears → IO-only');
}

// --- Invalid inputs still return null -----------------------------------
{
  assertEqual(calculateAnnualDebtService(0, 5, 30), null, 'zero loanAmount → null');
  assertEqual(calculateAnnualDebtService(1_000_000, 0, 30), null, 'zero annualRate → null');
  assertEqual(calculateAnnualDebtService(NaN, 5, 30), null, 'NaN loanAmount → null');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Tests for amortization helpers.
 *
 *   npm run test:judgment-amortization
 */

import { annualDebtService, maturityBalance } from '../services/judgment/amortization.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertClose(a: number, b: number, eps: number, m: string): void {
  Math.abs(a - b) <= eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b}, eps=${eps})`);
}
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

console.log('annualDebtService:');

{
  // 100k loan, 6%, 30y amortization → annual debt service ≈ 7.19k
  const r = annualDebtService({ loanAmount: 100_000, interestRate: 0.06, amortizationMonths: 360 });
  // Standard formula yields monthly ≈ 599.55, annual ≈ 7194.6
  assertClose(r, 7194.62, 0.5, '100k @ 6% / 30y → ~$7,194 annual');
}
{
  // 1M loan, 7%, 30y → annual ≈ 79,836.30
  const r = annualDebtService({ loanAmount: 1_000_000, interestRate: 0.07, amortizationMonths: 360 });
  assertClose(r, 79836.30, 1, '1M @ 7% / 30y → ~$79,836 annual');
}
{
  // Zero interest → straight amortization
  const r = annualDebtService({ loanAmount: 1_200_000, interestRate: 0, amortizationMonths: 120 });
  assertClose(r, 120_000, 0.01, '1.2M @ 0% / 10y → 120k/yr');
}
{
  assertEqual(annualDebtService({ loanAmount: 0, interestRate: 0.07, amortizationMonths: 360 }), 0, 'zero loan → 0');
  assertEqual(annualDebtService({ loanAmount: 100_000, interestRate: 0.07, amortizationMonths: 0 }), 0, 'zero amort → 0');
}

console.log('\nmaturityBalance:');

{
  // 100k, 6%, 360m amortization, term=120m (10y of a 30y) → balance ≈ 83,686
  const r = maturityBalance({ loanAmount: 100_000, interestRate: 0.06, amortizationMonths: 360, termMonths: 120 });
  assertClose(r, 83686.40, 1, '100k 6%/30y at month 120 → ~$83,686');
}
{
  // term >= amortization → 0 (paid off)
  const r = maturityBalance({ loanAmount: 100_000, interestRate: 0.06, amortizationMonths: 360, termMonths: 360 });
  assertClose(r, 0, 0.01, 'paid off at maturity');
}
{
  // term=0 → full balance remains
  const r = maturityBalance({ loanAmount: 1_000_000, interestRate: 0.07, amortizationMonths: 360, termMonths: 0 });
  assertEqual(r, 1_000_000, 'term=0 → full balance');
}
{
  // Zero interest, half-term → half paid
  const r = maturityBalance({ loanAmount: 1_200_000, interestRate: 0, amortizationMonths: 120, termMonths: 60 });
  assertClose(r, 600_000, 0.01, '0% rate, half term → half balance');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

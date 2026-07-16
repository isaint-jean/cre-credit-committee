/**
 * PROOF — maturityBalance() IO branch (the balloon-on-IO fix, mirrors the
 * annualDebtService IO branch). tsx src/scripts/proof-maturity-balance-io.ts
 */
import { maturityBalance } from '../services/judgment/amortization.js';
let p = 0, f = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? '  ok  ' : '  FAIL ') + m); c ? p++ : f++; };

// ★ IO loan (amort 0) balloons at the FULL loan amount — was $0.
ok(maturityBalance({ loanAmount: 400_000_000, interestRate: 0.065, amortizationMonths: 0, termMonths: 60 }) === 400_000_000,
  '★ 640 IO ($400M / 60mo / amort 0) → balloon $400M (was $0 via the amort-assuming return-0 gate)');
// amort <= 0 (defensive) also → full loan.
ok(maturityBalance({ loanAmount: 100_000_000, interestRate: 0.06, amortizationMonths: -1, termMonths: 60 }) === 100_000_000,
  '   amort <= 0 (defensive) → full loan');
// AMORTIZING unchanged: 30yr amort / 10yr term → partial paydown (not 0, not full).
const bAmort = maturityBalance({ loanAmount: 100_000_000, interestRate: 0.06, amortizationMonths: 360, termMonths: 120 });
ok(bAmort > 80_000_000 && bAmort < 100_000_000, '   amortizing (30yr amort, 10yr term) → partial paydown $' + (bAmort / 1e6).toFixed(1) + 'M (UNCHANGED)');
// fully amortized (term >= amort, amort > 0) → 0 (UNCHANGED).
ok(maturityBalance({ loanAmount: 100_000_000, interestRate: 0.06, amortizationMonths: 120, termMonths: 120 }) === 0,
  '   fully amortized (term = amort > 0) → $0 (UNCHANGED — the IO branch is guarded on amort<=0)');

console.log('\n  RESULT: ' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);

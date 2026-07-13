import { extractAsrLoanTermsLlm, type LoanTermsLlmCall } from '../services/extract-asr-loan-terms-llm.js';
const stub = (obj: object): LoanTermsLlmCall => async () => JSON.stringify(obj);
const deps = (obj: object) => ({ llmCall: stub(obj), creditsAvailable: () => true });
const F = (v: unknown, q: string | null) => ({ value: v, sourceQuote: q });
(async () => {
  let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { console.log((c ? '  ok  ' : '  FAIL ') + m); c ? pass++ : fail++; };

  // Test 1 — ★ the LIVE 640 case: full-term IO, LLM returned amortizationMonths NULL
  const r1 = await extractAsrLoanTermsLlm(
    'Lender presents a $400,000,000, 5-year, fixed rate, interest-only loan (the "Loan").', 'h1',
    deps({ loanAmountWhole: F(400000000, '$400,000,000'), loanAmountTrustPiece: F(null, null), coupon: F(null, null),
      amortizationMonths: F(null, null), interestOnlyMonths: F(null, null), termPhrase: F('5-year', '5-year'),
      originationDate: F(null, null), maturityDate: F(null, null) }));
  ok(r1.loanTerms?.amortization === 0, '★ FULL-TERM IO (LLM amort=null) → rule DERIVES amortization=0, cited (got ' + r1.loanTerms?.amortization + ')');
  ok(r1.loanTerms?.termMonths === 60, '   termMonths 60 intact');

  // Test 2 — ★ NARROW: partial IO (2yr IO on a 10yr loan) → must NOT be zeroed
  const r2 = await extractAsrLoanTermsLlm(
    'A $100,000,000 10-year loan with a 2-year interest-only period, then amortizing over 30 years.', 'h2',
    deps({ loanAmountWhole: F(100000000, '$100,000,000'), loanAmountTrustPiece: F(null, null), coupon: F(null, null),
      amortizationMonths: F(null, null), interestOnlyMonths: F(24, '2-year interest-only period'), termPhrase: F('10-year', '10-year'),
      originationDate: F(null, null), maturityDate: F(null, null) }));
  ok(r2.loanTerms?.amortization === null, '★ PARTIAL IO (IO 24mo < term 120mo) → amortization NOT zeroed (honest null, got ' + r2.loanTerms?.amortization + ')');

  // Test 3 — amortizing loan with a real amortization → rule does NOT overwrite it
  const r3 = await extractAsrLoanTermsLlm(
    'A $50,000,000 10-year loan with a 30-year amortization schedule.', 'h3',
    deps({ loanAmountWhole: F(50000000, '$50,000,000'), loanAmountTrustPiece: F(null, null), coupon: F(null, null),
      amortizationMonths: F(360, '30-year amortization'), interestOnlyMonths: F(null, null), termPhrase: F('10-year', '10-year'),
      originationDate: F(null, null), maturityDate: F(null, null) }));
  ok(r3.loanTerms?.amortization === 360, '   AMORTIZING (real 360mo) → rule does NOT overwrite (got ' + r3.loanTerms?.amortization + ')');

  console.log('\n  RESULT: ' + pass + ' passed, ' + fail + ' failed');
})();

/**
 * proof-refi-deleveraging-reconcile.ts — proof for the REFI_BELOW_PRIOR_PAYOFF
 * source-reconciliation build (Isabelle's call: a deleveraging refi where the
 * sources cover the payoff is a SOFT review flag, not a HARD halt).
 *
 * Exercises, READ-ONLY (no cre.db writes, no minting of a 640 revision):
 *   [A] sponsorEquity extraction — parses the REAL 640 BMO ASR blob's rawText
 *       via parseSourcesAndUses → expect ≈ $104.1M (deterministic, no LLM).
 *   [B] gate reconciliation — 640-shaped input (loan $400M, priorDebtPayoff
 *       $500M, sponsorEquity $104.1M, Refinance) → SOFT REFI_DELEVERAGING,
 *       hardHalt=false → the underwrite would PROCEED.
 *   [C] a genuinely-broken refi (loan+equity < payoff) → HARD REFI_BELOW_PRIOR_PAYOFF.
 *   [D] sponsorEquity null / unknown → HARD (conservative fallback).
 *   [E] non-refi / acquisition (priorDebtPayoff null) → NO finding (unchanged).
 *
 * Run: npx tsx src/scripts/proof-refi-deleveraging-reconcile.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { parsePdf } from '../services/pdf-parser.service.js';
import { parseSourcesAndUses } from '../services/extract-asr.js';
import { runDataIntegrityGate, type DataIntegrityReport } from '../services/data-integrity/gate.js';
import type { AdjustedInputs, ExtractionResult, PropertyMetadata } from '@cre/contracts';

const B640_ASR =
  '.data/blobs/c8/c8fb5726bfa602e9006f354aa385d87a21be027dfeb74784a699530cd1b41b96.bin';

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? 'null' : `$${Math.round(n).toLocaleString('en-US')}`;
}
function line(t = ''): void { console.log(t); }
function hr(): void { line('─'.repeat(78)); }

/* Minimal gate inputs — only the fields the REFI check reads are meaningful;
 * the rest are benign nulls so the other layers stay quiet. */
function makeGateArgs(opts: {
  loanAmount: number | null;
  priorDebtPayoff: number | null;
  sponsorEquity: number | null;
  loanPurpose: 'Refinance' | 'Acquisition' | null;
}): {
  adjustedInputs: AdjustedInputs;
  extraction: ExtractionResult;
  propertyMetadata: PropertyMetadata | null;
  netRentableArea: number | null;
} {
  const li = (v: number | null) => ({ adjusted: v, source: 'EXTRACTED' as const });
  const adjustedInputs = {
    loan: {
      loanAmount: li(opts.loanAmount),
      interestRate: li(null),
      amortizationMonths: li(null),
      ioPeriodMonths: li(null),
      termMonths: li(null),
      debtServiceAnnual: li(null),
    },
    income: {},
    expenses: {},
    metrics: { ltvAppraisal: null, dscr: null, debtYield: null, noi: null },
    assumptions: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as AdjustedInputs;
  const extraction = {
    asr: {
      impliedValue: null, impliedCapRate: null, underwrittenNOI: null,
      priorDebtPayoff: opts.priorDebtPayoff,
      sponsorEquity: opts.sponsorEquity,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ExtractionResult;
  const propertyMetadata = opts.loanPurpose === null
    ? null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : ({ loanPurpose: opts.loanPurpose } as any as PropertyMetadata);
  return { adjustedInputs, extraction, propertyMetadata, netRentableArea: null };
}

function refiFinding(r: DataIntegrityReport) {
  return r.findings.find(
    (f) => f.check === 'REFI_DELEVERAGING' || f.check === 'REFI_BELOW_PRIOR_PAYOFF',
  );
}

async function main(): Promise<void> {
  let pass = 0, fail = 0;
  const ok = (cond: boolean, msg: string) => { if (cond) { pass++; line(`  ✓ ${msg}`); } else { fail++; line(`  ✗ ${msg}`); } };

  hr(); line('REFI DELEVERAGING SOURCE-RECONCILIATION — PROOF (read-only)'); hr();

  /* ── [A] sponsorEquity extraction from the real 640 BMO ASR blob ── */
  line('\n[A] sponsorEquity extraction — real 640 BMO ASR blob (deterministic, no LLM)');
  let asr640Equity: number | null = null;
  let asr640Payoff: number | null = null;
  if (existsSync(B640_ASR)) {
    const parsed = await parsePdf(readFileSync(B640_ASR));
    const su = parseSourcesAndUses(parsed.rawText);
    asr640Equity = su?.sponsorEquity ?? null;
    asr640Payoff = su?.loanPayoff ?? null;
    line(`    parsed 640 ASR rawText (${parsed.rawText.length} chars)`);
    line(`    sourcesAndUses.sponsorEquity = ${fmt(asr640Equity)}`);
    line(`    sourcesAndUses.loanPayoff    = ${fmt(asr640Payoff)}`);
    // 640 ASR states "a new $104.1MM sponsor equity contribution to refinance $500.0MM"
    ok(asr640Equity !== null && Math.abs(asr640Equity - 104_100_000) < 200_000,
      `640 sponsorEquity ≈ $104.1M (got ${fmt(asr640Equity)})`);
    ok(asr640Payoff === 500_000_000,
      `640 priorDebtPayoff (existing debt) = $500M (got ${fmt(asr640Payoff)})`);

    // ── [A2] the SAME extracted 640 figures through the gate → SOFT, proceeds ──
    line('\n[A2] gate on the REAL extracted 640 figures (loan $400M + extracted equity ≥ extracted payoff)');
    const rReal = runDataIntegrityGate(makeGateArgs({
      loanAmount: 400_000_000,
      priorDebtPayoff: asr640Payoff,
      sponsorEquity: asr640Equity,
      loanPurpose: 'Refinance',
    }));
    const fReal = refiFinding(rReal);
    line(`    finding = ${fReal?.check ?? 'NONE'} / severity=${fReal?.severity ?? '—'}  hardHalt=${rReal.hardHalt}`);
    ok(fReal?.check === 'REFI_DELEVERAGING' && rReal.hardHalt === false,
      'real 640 figures → SOFT REFI_DELEVERAGING, hardHalt=false (underwrite proceeds)');
  } else {
    line(`    ⚠ 640 blob not found at ${B640_ASR} — falling back to synthetic ASR text`);
    const synthetic =
      'Sources & Uses. This transaction is supported by a new $104.1MM sponsor ' +
      'equity contribution to refinance $500.0MM of existing debt.';
    const su = parseSourcesAndUses(synthetic);
    asr640Equity = su?.sponsorEquity ?? null;
    line(`    (fixture) sourcesAndUses.sponsorEquity = ${fmt(asr640Equity)}`);
    ok(asr640Equity === 104_100_000, `fixture sponsorEquity parses to $104.1M (got ${fmt(asr640Equity)})`);
  }

  /* ── [A3] loanPayoff/sponsorEquity parser regression on synthetic surfaces ── */
  line('\n[A3] parser regression — Loan-Payoff (Sunroad-style) + acquisition (no false match)');
  const sunroadStyle =
    'Sources & Uses\nLoan Amount $85,000,000\nLoan Payoff1 $65,365,379\n' +
    'Return of Equity $15,000,000\nClosing Costs $1,200,000';
  const suSun = parseSourcesAndUses(sunroadStyle);
  ok(suSun?.loanPayoff === 65_365_379, `Sunroad-style Loan Payoff → $65.37M (got ${fmt(suSun?.loanPayoff ?? null)})`);
  ok((suSun?.sponsorEquity ?? null) === null, 'no sponsorEquity on a return-of-equity refi (returnOfEquity ≠ sponsorEquity)');
  const acqStyle = 'Sources & Uses\nLoan Amount $50,000,000\nPurchase Price $70,000,000\nClosing Costs $900,000';
  const suAcq = parseSourcesAndUses(acqStyle);
  ok((suAcq?.loanPayoff ?? null) === null, 'acquisition text → loanPayoff null (no existing-debt false match)');

  /* ── [B] 640-shaped gate input → SOFT, underwrite proceeds ── */
  line('\n[B] gate reconciliation — 640-shaped: loan $400M + equity $104.1M ≥ $500M payoff');
  const r640 = runDataIntegrityGate(makeGateArgs({
    loanAmount: 400_000_000,
    priorDebtPayoff: 500_000_000,
    sponsorEquity: 104_100_000,
    loanPurpose: 'Refinance',
  }));
  const f640 = refiFinding(r640);
  line(`    finding = ${f640?.check ?? 'NONE'} / severity=${f640?.severity ?? '—'}`);
  line(`    hardHalt = ${r640.hardHalt}  (hard=${r640.hardCount} soft=${r640.softCount} warn=${r640.warnCount})`);
  ok(f640?.check === 'REFI_DELEVERAGING', 'emits SOFT REFI_DELEVERAGING (not HARD)');
  ok(f640?.severity === 'SOFT', 'severity is SOFT');
  ok(r640.hardHalt === false, 'hardHalt=false → underwrite PROCEEDS');

  /* ── [C] genuinely-broken refi: loan + equity STILL below payoff → HARD ── */
  line('\n[C] broken refi — loan $300M + equity $50M < $500M payoff (sources do NOT reconcile)');
  const rBroken = runDataIntegrityGate(makeGateArgs({
    loanAmount: 300_000_000,
    priorDebtPayoff: 500_000_000,
    sponsorEquity: 50_000_000,
    loanPurpose: 'Refinance',
  }));
  const fBroken = refiFinding(rBroken);
  line(`    finding = ${fBroken?.check ?? 'NONE'} / severity=${fBroken?.severity ?? '—'}  hardHalt=${rBroken.hardHalt}`);
  ok(fBroken?.check === 'REFI_BELOW_PRIOR_PAYOFF' && fBroken.severity === 'HARD', 'HARD REFI_BELOW_PRIOR_PAYOFF fires');
  ok(rBroken.hardHalt === true, 'hardHalt=true (real error still halts)');

  /* ── [D] sponsorEquity null → cannot confirm → HARD (conservative fallback) ── */
  line('\n[D] unconfirmed refi — loan $400M below $500M payoff, sponsorEquity NULL → HARD');
  const rNull = runDataIntegrityGate(makeGateArgs({
    loanAmount: 400_000_000,
    priorDebtPayoff: 500_000_000,
    sponsorEquity: null,
    loanPurpose: 'Refinance',
  }));
  const fNull = refiFinding(rNull);
  line(`    finding = ${fNull?.check ?? 'NONE'} / severity=${fNull?.severity ?? '—'}  hardHalt=${rNull.hardHalt}`);
  ok(fNull?.check === 'REFI_BELOW_PRIOR_PAYOFF' && fNull.severity === 'HARD', 'HARD halt on null equity (no soften)');
  ok(rNull.hardHalt === true, 'hardHalt=true (conservative fallback)');

  /* ── [E] acquisition / non-refi (priorDebtPayoff null) → NO finding ── */
  line('\n[E] acquisition — priorDebtPayoff null, loanPurpose Acquisition → NO finding');
  const rAcq = runDataIntegrityGate(makeGateArgs({
    loanAmount: 400_000_000,
    priorDebtPayoff: null,
    sponsorEquity: null,
    loanPurpose: 'Acquisition',
  }));
  ok(refiFinding(rAcq) === undefined, 'no REFI finding on acquisition (unchanged behavior)');
  ok(rAcq.hardHalt === false, 'hardHalt=false');

  hr();
  line(`RESULT: ${pass} passed, ${fail} failed`);
  hr();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

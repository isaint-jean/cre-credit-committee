/**
 * Unit tests for the buyer-diff read projection (projectBuyerDiff) — the three
 * states (agreement / adjustment / can't-verify) and the issuer↔ours framing. The
 * producer (buildBuyerDiffCrossCheck) + its score-safety are covered by
 * test:ingest-pipeline (findings populated) + preflight-readiness.ts --verify
 * (byte-identical score) + proof-buyer-diff.ts (Sunroad/640 lit up).
 *
 *   npm run test:buyer-diff
 */
import { projectBuyerDiff, type BuyerDiffState } from '../services/buyer-diff.service.js';
import { renderBuyerDiffHtml } from '../services/render-buyer-diff-html.js';
import type { CrossCheckDriver, CrossCheckFinding, CrossCheckResult } from '@cre/contracts';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function eq<T>(a: T, b: T, m: string): void { a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`); }

function finding(metric: string, issuer: number | null, ours: number | null, drivers: CrossCheckDriver[] = []): CrossCheckFinding {
  return {
    metric,
    bank: { value: issuer, source: 'SELLER_UW' },
    rawExtracted: { value: issuer, source: 'SELLER_UW' },
    adjusted: { value: ours },
    bpFinal: { value: ours },
    drivers,
    delta: { vsBank: null, vsBankPct: null },
    conservatismStatus: 'NEUTRAL',
  };
}
function result(findings: CrossCheckFinding[]): CrossCheckResult {
  return { id: 'x'.repeat(64) as never, analysisAsOfDate: '2026-01-01T00:00:00Z' as never, adjustedInputsId: 'a'.repeat(64) as never, findings, overallAdjustmentBias: 'neutral' };
}
const driver: CrossCheckDriver = { input: 'income.vacancyPct', change: 0.02, reason: 'vacancy raised to library median (0.10)', ruleId: 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN' as never };

console.log('The three states fall out — and never collapse:');
{
  const rows = projectBuyerDiff(result([
    finding('loanAmount', 400_000_000, 400_000_000),                 // equal, no why → AGREEMENT
    finding('noi', 10_000_000, 8_275_000, [driver]),                 // differs + why   → ADJUSTMENT
    finding('dscr', null, 1.27),                                     // issuer null     → CAN'T-VERIFY
    finding('debtService', 6_500_000, null),                         // ours null       → CAN'T-VERIFY
  ]));
  const by = (m: string): BuyerDiffState => rows.find(r => r.metric === m)!.state;
  eq(by('loanAmount'), 'agreement', 'issuer==ours, no adjustment → AGREEMENT');
  eq(by('noi'), 'adjustment', 'issuer≠ours + drivers → ADJUSTMENT');
  eq(by('dscr'), 'cant-verify', 'issuer null → CAN\'T-VERIFY (not agreement)');
  eq(by('debtService'), 'cant-verify', 'ours null → CAN\'T-VERIFY');

  const noi = rows.find(r => r.metric === 'noi')!;
  eq(noi.delta, 8_275_000 - 10_000_000, 'delta = ours − issuer (negative: buyer lowered NOI)');
  assert(noi.deltaPct !== null && Math.abs(noi.deltaPct - (-0.1725)) < 1e-9, 'deltaPct = (ours−issuer)/|issuer|');
  eq(noi.why.length, 1, 'the WHY carries through (one driver)');
  eq(noi.why[0]!.ruleId as string, 'JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN', 'driver ruleId preserved (structured why)');
  eq(noi.conservatism, 'CONSERVATIVE', 'ours NOI < issuer, lower-is-conservative → CONSERVATIVE');
}

console.log('\nAdjustment with zero delta but a real driver still reads ADJUSTMENT (why present):');
{
  const rows = projectBuyerDiff(result([finding('interestRate', 0.07, 0.07, [driver])]));
  eq(rows[0]!.state, 'adjustment', 'a driver fired even at ~0 delta → ADJUSTMENT (not silent agreement)');
}

console.log('\nCan\'t-verify never collapses into agreement even when the other side is 0:');
{
  const rows = projectBuyerDiff(result([finding('value', null, 0)]));
  eq(rows[0]!.state, 'cant-verify', 'issuer null → CAN\'T-VERIFY even though ours=0');
}

console.log('\nHigher-is-conservative metric (cap rate): ours above issuer → CONSERVATIVE:');
{
  const rows = projectBuyerDiff(result([finding('capRate', 0.0625, 0.0665, [driver])]));
  eq(rows[0]!.conservatism, 'CONSERVATIVE', 'cap rate widened (ours>issuer) → CONSERVATIVE');
  eq(rows[0]!.state, 'adjustment', 'widened cap → ADJUSTMENT');
}

console.log('\nView (renderBuyerDiffHtml) — tri-state visual + toggle + can\'t-verify ≠ agreement:');
{
  const rows = projectBuyerDiff(result([
    finding('loanAmount', 400_000_000, 400_000_000),          // agreement
    finding('noi', 10_172_320, 8_275_187, [driver]),          // adjustment (money-shot)
    finding('dscr', null, 1.27),                              // can't-verify
  ]));
  const html = renderBuyerDiffHtml({ id: 'x', dealRef: 'TEST-DEAL' }, rows, 'INSUFFICIENT_DATA');
  assert(html.includes('row agreement') && html.includes('row adjustment') && html.includes('row cant-verify'), 'all three states render as distinct row classes');
  assert(html.includes('show changes') && html.includes('.hide-changes'), 'the show/hide-changes toggle + its CSS mode are present');
  assert(html.includes("can't verify") && html.includes('insufficient data') && html.includes('Provide'), "can't-verify reads as insufficient-data (provide X), NOT agreement");
  assert(html.includes('$8,275,187') && html.includes('18.6%'), 'NOI money-shot renders our number + the delta %');
  assert(html.includes('JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN'), 'the structured why (ruleId) renders in the view');
  assert(html.includes('buyer accepts'), 'agreement row reads as accepted-as-is');
  // hide-changes mode hides the issuer + why columns via CSS (present in the stylesheet).
  assert(/body\.hide-changes[^}]*td\.issuer[^}]*display:\s*none/.test(html.replace(/\n/g, ' ')), 'hide-changes CSS collapses to the clean buyer-adjusted column');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} buyer-diff: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

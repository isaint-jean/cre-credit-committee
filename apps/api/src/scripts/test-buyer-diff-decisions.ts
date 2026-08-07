/**
 * Part A tests — buyer-diff decisions store + suggestion service.
 *   - decidable set = ENGINE-REAL adjustments only (moved lines); non-moved excluded.
 *   - store put/get/upsert roundtrip (mutable sibling).
 *   - mergeDecisions overlays stored decisions (pending default).
 * The AIR-GAP (decisions never change the score) is proven separately by
 * preflight-readiness.ts --verify staying byte-identical + a grep gate.
 *
 *   npm run test:buyer-diff-decisions
 */
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { buildBuyerDiffSuggestions, mergeDecisions, decidableFindingIds } from '../services/buyer-diff-suggestions.service.js';
import type { AdjustedInputs, ExtractionResult, CrossCheckResultId } from '@cre/contracts';

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));
const eq = <T>(a: T, b: T, m: string) => (a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)})`));

const li = (raw: number | null, adjusted: number, moved: boolean) => ({
  raw, adjusted, source: 'SELLER_UW',
  adjustments: moved ? [{ ruleId: 'JE_TEST_RULE', delta: adjusted - (raw ?? 0), reason: 'raised to market' }] : [],
});
function makeAI(opts: { vacMoved?: boolean } = {}): AdjustedInputs {
  return {
    metrics: { noi: 8_275_187, value: 124_438_898, dscr: 1.27, issuerStatedNoiSellerUw: 10_172_320,
               issuerStatedNoiAsr: null, trailingActualNoi: null, inPlaceNoi: null },
    income: { vacancyPct: li(0.034, opts.vacMoved === false ? 0.034 : 0.10, opts.vacMoved !== false),
              grossRentalIncome: li(12_997_217, 12_997_217, false), effectiveGrossIncome: li(null, 11_821_695, false) },
    expenses: { totalOperatingExpenses: li(3_455_762, 3_546_509, true) },
    assumptions: { capRate: li(0.0625, 0.0665, true) },
  } as unknown as AdjustedInputs;
}
const EX = { dealRef: 'TEST', asr: { impliedValue: 133_000_000 }, appraisal: null } as unknown as ExtractionResult;

console.log('Suggestions — only ENGINE-REAL adjustments are decidable:');
{
  const s = buildBuyerDiffSuggestions(makeAI(), EX);
  const ids = s.map((x) => x.findingId).sort();
  eq(ids.join(','), 'capRate,noi,totalOpEx,vacancy,value', '5 adjustments: vacancy, totalOpEx, capRate, noi, value');
  const vac = s.find((x) => x.findingId === 'vacancy')!;
  eq(vac.issuer, 0.034, 'vacancy issuer = raw'); eq(vac.buyer, 0.10, 'vacancy buyer = adjusted');
  assert(vac.why.length === 1 && vac.why[0]!.ruleId === 'JE_TEST_RULE', 'why is the STRUCTURED ledger reason (no LLM)');
  assert(vac.question.includes('3.4%') && vac.question.includes('10.0%'), 'evidence-grounded question wording (3.4% vs 10%)');
  const noi = s.find((x) => x.findingId === 'noi')!;
  assert(noi.why.length >= 1, 'NOI why aggregates its drivers (vacancy + opex)');
  assert(s.every((x) => x.decision === 'pending'), 'all pending before any decision');
}

console.log('\nA line the engine did NOT move is NOT decidable:');
{
  const s = buildBuyerDiffSuggestions(makeAI({ vacMoved: false }), EX);
  assert(!s.some((x) => x.findingId === 'vacancy'), 'vacancy excluded when raw==adjusted + no adjustment (never fabricated)');
  eq(s.length, 4, 'only the 4 that actually moved remain');
}

console.log('\nStore — put/get/upsert (mutable sibling); merge overlays decisions:');
{
  const store = new RecordGraphStore(':memory:');
  try { (store as unknown as { db: { pragma: (s: string) => void } }).db.pragma('foreign_keys = OFF'); } catch { /* */ }
  const ccid = 'c'.repeat(64) as CrossCheckResultId;
  eq(store.getBuyerDiffDecisions(ccid).length, 0, 'no decisions initially (all pending)');
  store.putBuyerDiffDecision(ccid, 'noi', 'accepted');
  store.putBuyerDiffDecision(ccid, 'capRate', 'rejected');
  const got = store.getBuyerDiffDecisions(ccid);
  eq(got.length, 2, 'two decisions stored');
  eq(got.find((d) => d.findingId === 'noi')?.decision, 'accepted', 'noi accepted');
  eq(got.find((d) => d.findingId === 'capRate')?.decision, 'rejected', 'capRate rejected');
  // upsert — change a decision
  store.putBuyerDiffDecision(ccid, 'noi', 'rejected');
  eq(store.getBuyerDiffDecisions(ccid).find((d) => d.findingId === 'noi')?.decision, 'rejected', 'upsert flips noi to rejected');
  eq(store.getBuyerDiffDecisions(ccid).length, 2, 'upsert did not duplicate (PK per finding)');

  const merged = mergeDecisions(buildBuyerDiffSuggestions(makeAI(), EX), got);
  eq(merged.find((x) => x.findingId === 'noi')?.decision, 'accepted', 'merge overlays stored decision onto suggestion');
  eq(merged.find((x) => x.findingId === 'value')?.decision, 'pending', 'undecided finding stays pending');
  store.close();
}

console.log('\ndecidableFindingIds gates PUT validation:');
{
  const ids = decidableFindingIds(buildBuyerDiffSuggestions(makeAI(), EX));
  assert(ids.has('noi') && ids.has('vacancy'), 'adjustments are decidable');
  assert(!ids.has('loanAmount') && !ids.has('dscr'), 'agreement / can\'t-verify are NOT decidable (nothing to accept/reject)');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} buyer-diff-decisions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

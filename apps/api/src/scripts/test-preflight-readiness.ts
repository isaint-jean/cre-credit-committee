/**
 * Unit tests for the pre-flight readiness pure functions (ledger grouping +
 * reverse rollup). The BYTE-IDENTICAL derived-verdict proof is the integration
 * gate `preflight-readiness.ts --verify` (runs the real evaluateFromAdjustedInputs
 * against a scratch store on 640 + Sunroad and asserts == the minted heads).
 *
 *   npm run test:preflight-readiness
 */
import { buildLedger, buildUnlocks, type PreFlightField } from '../services/pre-flight-readiness.service.js';
import type { IntakeFieldResult } from '../services/intake-completeness.service.js';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void { a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`); }

function field(id: string, state: IntakeFieldResult['state'], sources: IntakeFieldResult['sources'] = [], extra: Partial<IntakeFieldResult> = {}): IntakeFieldResult {
  return { id, section: 'S', field: id, state, feeds: `${id} feeds`, blocks: `${id} blocks`, sources, criticality: 'Required', tier: 'A', ...extra };
}

/* ---- Part A: ledger grouping (PRODUCE / BLANK / MISSING / decision / N-A) --- */
console.log('Ledger grouping — the three states + the two non-gap buckets:');
{
  const fields: IntakeFieldResult[] = [
    field('a', 'populated'),
    field('b', 'populated'),
    field('c', 'in-PDF-not-extracted', ['appraisal']),
    field('d', 'not-in-any-doc', ['seller_uw']),
    field('e', 'decision-blank'),
    field('f', 'not-applicable'),
  ];
  const l = buildLedger(fields);
  assertEqual(l.produce.map(f => f.id).join(','), 'a,b', 'populated → PRODUCE');
  assertEqual(l.blankInDoc.map(f => f.id).join(','), 'c', 'in-PDF-not-extracted → BLANK-in-doc');
  assertEqual(l.missing.map(f => f.id).join(','), 'd', 'not-in-any-doc → MISSING');
  assertEqual(l.decision.map(f => f.id).join(','), 'e', 'decision-blank → decision (not a gap)');
  assertEqual(l.notApplicable.map(f => f.id).join(','), 'f', 'not-applicable → separate (not a gap)');
  assertEqual(l.counts.produce, 2, 'count.produce');
  assertEqual(l.counts.sourceable, 4, 'count.sourceable = produce+blank+missing (excludes decision + N-A)');
  // feeds/blocks carried through
  assert(l.blankInDoc[0]!.feeds === 'c feeds' && l.blankInDoc[0]!.blocks === 'c blocks', 'field carries feeds + blocks from the binding');
}

/* ---- searchStatus: unverified, never confirmed-missing ------------------- */
console.log('searchStatus — unavailable shows as UNVERIFIED (carried through):');
{
  const fields = [field('x', 'not-in-any-doc', ['asr'], { searchStatus: 'unavailable' })];
  const l = buildLedger(fields);
  assertEqual(l.missing[0]!.searchStatus, 'unavailable', 'searchStatus unavailable is carried (UI must render UNVERIFIED, not confirmed-missing)');
  const noStatus = buildLedger([field('y', 'not-in-any-doc', ['asr'])]);
  assertEqual(noStatus.missing[0]!.searchStatus, undefined, 'no exhaustive search → no searchStatus (missing means "no key + no doc", not "confirmed absent")');
}

/* ---- Part C: reverse rollup (add doc X unlocks N) ----------------------- */
console.log('Reverse rollup — doc → fields it would unlock, honest (only real bindings):');
{
  const gaps: PreFlightField[] = [
    { id: 'in_place_noi', section: 'Income', field: 'In-place / T12 NOI', feeds: 'DSCR, debt yield', blocks: 'no coverage', sources: ['seller_uw', 't12', 'in_place', 'asr'], criticality: 'Required' },
    { id: 'opex', section: 'Income', field: 'Operating expenses', feeds: 'Expense ratio; NOI', blocks: 'no NOI', sources: ['seller_uw', 't12', 'in_place'], criticality: 'Required' },
    { id: 'as_is_value', section: 'Value', field: 'As-is value', feeds: 'LTV; value basis', blocks: 'loan-basis only', sources: ['appraisal', 'asr'], criticality: 'Required' },
    { id: 'sponsor', section: 'Sponsor', field: 'Sponsor net worth', feeds: 'Recourse', blocks: 'guaranty blocked', sources: [], criticality: 'Required' }, // no doc sources it
  ];
  const unlocks = buildUnlocks(gaps);
  const bySeller = unlocks.find(u => u.doc === 'seller_uw')!;
  assert(bySeller.unlocksFields.includes('In-place / T12 NOI') && bySeller.unlocksFields.includes('Operating expenses'), 'seller_uw unlocks the income fields it sources');
  assert(bySeller.unlocksOutputs.includes('DSCR, debt yield') && bySeller.unlocksOutputs.includes('Expense ratio; NOI'), 'rolls up the downstream outputs (deduped)');
  const byAppraisal = unlocks.find(u => u.doc === 'appraisal')!;
  assertEqual(byAppraisal.unlocksFields.join(','), 'As-is value', 'appraisal unlocks only the field its binding sources — no overpromise');
  // Honesty: a field with NO source doc (sponsor) appears in NO unlock entry.
  assert(!unlocks.some(u => u.unlocksFields.includes('Sponsor net worth')), 'a field no doc sources is NOT claimed unlockable by any doc (honest — it is a genuine gap with no fix-by-upload)');
  // Ordering: most-unlocking doc first.
  assert(unlocks[0]!.unlocksFields.length >= unlocks[unlocks.length - 1]!.unlocksFields.length, 'docs sorted most-unlocking first (highest-leverage upload)');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} preflight-readiness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import { buildHandbookEvaluation } from '../services/handbook/build-handbook-evaluation.js';
import type { BuildHandbookEvaluationArgs } from '../services/handbook/build-handbook-evaluation.js';
import { computeHandbookEvaluationId } from '../util/content-hash.js';
import type {
  AdjustedInputs,
  AdjustedInputsId,
  AssetProfile,
  HandbookEvaluation,
  ISODateTime,
  NarrativeFacts,
  PropertyMetadata,
  PropertyMetadataId,
  StressOutputs,
} from '@cre/contracts';

// =============================================================================
// Hand-rolled runner
// =============================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}
function fail(m: string): void {
  failed++;
  failures.push(m);
  console.error(`  FAIL  ${m}`);
}
function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(m);
  else fail(`${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}
function assertTruthy(value: unknown, m: string): void {
  if (value) ok(m);
  else fail(`${m} (value was ${JSON.stringify(value)})`);
}

// =============================================================================
// Fixtures
// =============================================================================

function makeArgs(overrides: Partial<BuildHandbookEvaluationArgs> = {}): BuildHandbookEvaluationArgs {
  const adjustedInputs = {
    id: 'aaaa' as AdjustedInputsId,
    loan: { loanAmount: { raw: 30_000_000, adjusted: 30_000_000 } },
    metrics: { dscr: 1.10, debtYield: 0.085 },
  } as unknown as AdjustedInputs;

  const assetProfile = { propertyType: 'Office' } as unknown as AssetProfile;
  const narrativeFacts = {
    isSingleTenant: false,
    pipBudgetPerKey: null,
    parkOwnedHomesPct: null,
  } as unknown as NarrativeFacts;
  const stressOutputs = {
    method: 'TENANT_REMOVAL',
    scenarios: [{ name: 'Remove T1+T2+T3', dscr: 0.92 }],
  } as unknown as StressOutputs;
  const propertyMetadata = {
    id: 'pmpmpmpm' as PropertyMetadataId,
    propertySubtype: 'Suburban Office',
    buildingClass: 'B',
    msa: 'Atlanta-Sandy Springs-Alpharetta, GA MSA',
    yearBuilt: 1996,
    yearRenovated: null,
  } as unknown as PropertyMetadata;

  return {
    adjustedInputs,
    assetProfile,
    narrativeFacts,
    stressOutputs,
    propertyMetadata,
    analysisAsOfDate: '2026-01-01T00:00:00.000Z' as ISODateTime,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

console.log('\n=== Record construction ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertTruthy(eval_.id, 'record has an id');
  assertEqual(eval_.adjustedInputsId, 'aaaa', 'adjustedInputsId FKs to AdjustedInputs');
  assertEqual(eval_.handbookVersion, '2026.1', 'handbookVersion stamped from handbook constant');
  assertEqual(eval_.engineVersion, '1.0.0', 'engineVersion stamped as constant');
  assertEqual(eval_.analysisAsOfDate, '2026-01-01T00:00:00.000Z', 'analysisAsOfDate preserved');
  assertTruthy(eval_.fieldBagSnapshot, 'fieldBagSnapshot present');
  assertTruthy(Array.isArray(eval_.firedFlags), 'firedFlags is array');
  assertTruthy(Array.isArray(eval_.skippedPrinciples), 'skippedPrinciples is array');
})();

console.log('\n=== Id consistency (store will recompute and verify) ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  const { id, ...body } = eval_;
  const recomputed = computeHandbookEvaluationId(body);
  assertEqual(id, recomputed, 'producer-computed id matches recomputation from body');
})();

console.log('\n=== Engine output propagates (adapted to real handbook) ===');

// Fixture (Office, Class B, DSCR 1.10, stressed DSCR 0.92) should fire at
// least P-IV-OFF-2 (Class B office). Real engine returns ~80 skips total.
(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertTruthy(
    eval_.firedFlags.length >= 1,
    'at least one flag fires for Class B office with low DSCR',
  );
  const offTwo = eval_.firedFlags.find((f) => f.principleId === 'P-IV-OFF-2');
  assertTruthy(offTwo, 'P-IV-OFF-2 (Class B office) fires for this fixture');
})();

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertTruthy(
    eval_.skippedPrinciples.length >= 1,
    'at least one skipped principle (real engine returns many)',
  );
  // Spot-check: principles that need fields the fixture doesn't populate
  // should skip with reason 'missing_field' or 'trigger_inactive'.
  const reasons = new Set(eval_.skippedPrinciples.map((s) => s.reason));
  assertTruthy(
    reasons.has('missing_field') || reasons.has('trigger_inactive'),
    'skips include at least one missing_field or trigger_inactive (data-gap diagnostics)',
  );
})();

console.log('\n=== fieldBagSnapshot reflects assembler output ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  assertEqual(eval_.fieldBagSnapshot['asset_type'], 'Office', 'snapshot includes asset_type');
  assertEqual(eval_.fieldBagSnapshot['dscr'], 1.10, 'snapshot includes dscr');
  assertEqual(
    eval_.fieldBagSnapshot['building_class'],
    'B',
    'snapshot includes building_class (from metadata)',
  );
})();

console.log('\n=== Null PropertyMetadata: producer succeeds, metadata fields absent ===');

(() => {
  const args = makeArgs({ propertyMetadata: null });
  const eval_ = buildHandbookEvaluation(args);
  assertTruthy(eval_.id, 'record built successfully with null propertyMetadata');
  assertEqual(eval_.fieldBagSnapshot['msa'], undefined, 'msa undefined when metadata null');
  assertEqual(
    eval_.fieldBagSnapshot['building_class'],
    undefined,
    'building_class undefined when metadata null',
  );
  assertEqual(eval_.fieldBagSnapshot['asset_type'], 'Office', 'asset_type still present');
})();

console.log('\n=== Determinism: same inputs → same id ===');

(() => {
  const eval1 = buildHandbookEvaluation(makeArgs());
  const eval2 = buildHandbookEvaluation(makeArgs());
  assertEqual(eval1.id, eval2.id, 'same inputs produce same id');
})();

console.log('\n=== Different inputs → different ids ===');

(() => {
  const eval1 = buildHandbookEvaluation(makeArgs());
  const eval2 = buildHandbookEvaluation(
    makeArgs({
      adjustedInputs: {
        id: 'bbbb' as AdjustedInputsId,
        loan: { loanAmount: { raw: 5_000_000, adjusted: 5_000_000 } },
        metrics: { dscr: 2.50, debtYield: 0.15 },
      } as unknown as AdjustedInputs,
    }),
  );
  if (eval1.id === eval2.id) {
    fail('different inputs produced identical ids (content-hash should differ)');
  } else {
    ok('different inputs produce different ids');
  }
})();

console.log('\n=== JSON round-trip preserves all fields ===');

(() => {
  const eval_ = buildHandbookEvaluation(makeArgs());
  const round = JSON.parse(JSON.stringify(eval_)) as HandbookEvaluation;
  assertEqual(round.handbookVersion, eval_.handbookVersion, 'handbookVersion survives round-trip');
  assertEqual(round.firedFlags.length, eval_.firedFlags.length, 'firedFlags survives');
  assertEqual(
    round.skippedPrinciples.length,
    eval_.skippedPrinciples.length,
    'skippedPrinciples survives',
  );
  assertEqual(round.fieldBagSnapshot['asset_type'], 'Office', 'snapshot survives');
})();

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

/**
 * Tests for the CreditManifesto contract.
 *
 *   npm run test:manifesto-contract
 *
 * Verifies shape, content-hash idempotency, branded rule-id behavior, enum coverage, and that
 * the contract supports both legacy free-form `condition` strings and structured threshold
 * fields.
 */

import {
  MANIFESTO_COMPARISON_OPERATORS,
  MANIFESTO_CONTRACT_VERSION,
  MANIFESTO_OUTCOMES,
} from '@cre/contracts';
import type {
  CreditManifesto,
  CreditManifestoRuleId,
  ManifestoRule,
} from '@cre/contracts';
import { computeCreditManifestoId } from '../util/content-hash.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------------- fixtures ------------------------------- */

function makeRule(ruleId: string, overrides: Partial<ManifestoRule> = {}): ManifestoRule {
  return {
    ruleId: ruleId as CreditManifestoRuleId,
    metricName: 'dscr',
    condition: 'DSCR must be >= 1.20x at all times',
    thresholdValue: 1.20,
    comparisonOperator: '>=',
    outcome: 'Fail',
    weight: 10,
    assetTypes: ['Office', 'Retail'],
    sourceText: 'Section 3.2 of credit manifesto',
    pageReference: 7,
    ...overrides,
  };
}

function makeManifestoBody() {
  const rules: readonly ManifestoRule[] = [
    makeRule('rule-dscr-floor'),
    makeRule('rule-ltv-cap', {
      metricName: 'ltv',
      condition: 'LTV must not exceed 75%',
      thresholdValue: 0.75,
      comparisonOperator: '<=',
      outcome: 'Watchlist',
      assetTypes: ['all'],
    }),
    makeRule('rule-debt-yield-min', {
      metricName: 'debtYield',
      condition: 'Debt yield >= 8% required',
      thresholdValue: 0.08,
      comparisonOperator: '>=',
      outcome: 'Pass',
      weight: 15,
    }),
  ];
  return {
    analysisAsOfDate: AS_OF,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules,
  };
}

/* --------------------------------- run -------------------------------- */

console.log('Shape:');
{
  const body = makeManifestoBody();
  const id = computeCreditManifestoId(body);
  const manifesto: CreditManifesto = { id, ...body } as CreditManifesto;

  assert(/^[0-9a-f]{64}$/.test(id), 'id is 64-char hex');
  assertEqual(manifesto.manifestoContractVersion, '1.0', 'contract version stamped');
  assertEqual(manifesto.rules.length, 3, '3 rules');
  assertEqual(manifesto.rules[0]?.metricName ?? '', 'dscr', 'first rule metricName preserved');
  assertEqual(manifesto.rules[0]?.thresholdValue ?? null, 1.20, 'numeric threshold preserved');
}

console.log('\nIdempotency:');
{
  const a = computeCreditManifestoId(makeManifestoBody());
  const b = computeCreditManifestoId(makeManifestoBody());
  assertEqual(a, b, 'same content → same id');

  const altered = { ...makeManifestoBody(), rules: [...makeManifestoBody().rules, makeRule('rule-extra')] };
  const c = computeCreditManifestoId(altered);
  assert(a !== c, 'different rule list → different id');
}

console.log('\nEnum coverage:');
{
  assertEqual(MANIFESTO_COMPARISON_OPERATORS.length, 9, '9 comparison operators');
  for (const op of ['>', '>=', '<', '<=', '==', '!=', 'contains', 'between', 'qualitative']) {
    assert(MANIFESTO_COMPARISON_OPERATORS.includes(op as never), `operator '${op}' enumerated`);
  }

  assertEqual(MANIFESTO_OUTCOMES.length, 3, '3 outcomes');
  for (const o of ['Pass', 'Fail', 'Watchlist']) {
    assert(MANIFESTO_OUTCOMES.includes(o as never), `outcome '${o}' enumerated`);
  }
}

console.log('\nBranded rule id:');
{
  // Branded type — string IS the runtime representation but the type system prevents
  // cross-assignment. We can't directly assert a compile error here, but verify the runtime
  // value is a plain string usable as a map key etc.
  const id = 'rule-abc-123' as CreditManifestoRuleId;
  const rule = makeRule(id);
  assertEqual(rule.ruleId as string, 'rule-abc-123', 'branded rule id preserved as string at runtime');
}

console.log('\nField shape coverage:');
{
  const body = makeManifestoBody();
  const r0 = body.rules[0];
  assert(r0 !== undefined, 'first rule exists');
  if (r0) {
    assert(typeof r0.ruleId === 'string', 'ruleId is string');
    assert(typeof r0.metricName === 'string', 'metricName is string');
    assert(typeof r0.condition === 'string', 'condition is string (free-form, v1.0)');
    assert(typeof r0.weight === 'number', 'weight is number');
    assert(Array.isArray(r0.assetTypes), 'assetTypes is array');
    assert(typeof r0.sourceText === 'string', 'sourceText is string');
    assert(typeof r0.pageReference === 'number' || r0.pageReference === null, 'pageReference is number|null');
  }
}

console.log('\nNull threshold + string threshold:');
{
  const ruleNullThreshold = makeRule('rule-qual', {
    thresholdValue: null,
    comparisonOperator: 'qualitative',
  });
  assertEqual(ruleNullThreshold.thresholdValue, null, 'null threshold preserved');

  const ruleStringThreshold = makeRule('rule-text', {
    thresholdValue: 'investment-grade',
    comparisonOperator: 'contains',
  });
  assertEqual(ruleStringThreshold.thresholdValue, 'investment-grade', 'string threshold preserved');
}

console.log('\nAsset types — `["all"]` sentinel:');
{
  const allRule = makeRule('rule-all', { assetTypes: ['all'] });
  assertEqual(allRule.assetTypes.length, 1, 'all-sentinel has length 1');
  assertEqual(allRule.assetTypes[0] as string, 'all', "all-sentinel value is 'all'");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

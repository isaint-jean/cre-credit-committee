/**
 * Unit test — llm_principle_eval_cache (Phase 1 of LLM_CONTEXT evaluator).
 *
 *   npx tsx apps/api/src/scripts/test-llm-principle-eval-cache.ts
 *
 * Covers:
 *   - miss returns null
 *   - insert + immediate lookup returns the stored payload byte-identical
 *   - second insert with same key is a no-op (idempotent)
 *   - different model_version → different cache row (no collision)
 *   - different context_hash → different cache row
 *   - different handbook_engine_version → different cache row
 */

import { RecordGraphStore } from '../storage/record-graph-store.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const store = new RecordGraphStore(':memory:');

const baseKey = {
  principleId: 'P-III-6',
  contextHash: 'a'.repeat(64),
  handbookEngineVersion: '1.1.0',
  modelVersion: 'claude-sonnet-4-5-20250929',
};

const samplePayload = JSON.stringify({
  fired: true,
  severity: 'high',
  flag_message: 'DSCR 0.91 below 1.20 stress floor',
  evidenceQuotes: ['NOI 793,800', 'Annual debt service 878,199'],
});

console.log('1. miss → null');
{
  const result = store.getLlmPrincipleEval(baseKey);
  assertEqual(result, null, '1.1 fresh cache returns null on miss');
}

console.log('\n2. insert + lookup — byte-identical');
{
  const ins = store.insertLlmPrincipleEval({ ...baseKey, resultPayload: samplePayload });
  assertEqual(ins.inserted, true, '2.1 first insert reports inserted=true');
  const out = store.getLlmPrincipleEval(baseKey);
  assertEqual(out, samplePayload, '2.2 lookup returns the stored payload byte-identical');
}

console.log('\n3. idempotent re-insert');
{
  const otherPayload = JSON.stringify({ fired: false, severity: 'high', flag_message: 'no fire', evidenceQuotes: [] });
  const ins = store.insertLlmPrincipleEval({ ...baseKey, resultPayload: otherPayload });
  assertEqual(ins.inserted, false, '3.1 second insert with same key reports inserted=false (ON CONFLICT DO NOTHING)');
  const out = store.getLlmPrincipleEval(baseKey);
  assertEqual(out, samplePayload, '3.2 stored payload UNCHANGED (first writer wins)');
}

console.log('\n4. different modelVersion → distinct cache row');
{
  const newerModel = { ...baseKey, modelVersion: 'claude-opus-5-2026-12-01' };
  assertEqual(store.getLlmPrincipleEval(newerModel), null, '4.1 different modelVersion misses');
  const altPayload = JSON.stringify({ fired: true, severity: 'critical', flag_message: 'newer model says', evidenceQuotes: [] });
  store.insertLlmPrincipleEval({ ...newerModel, resultPayload: altPayload });
  assertEqual(store.getLlmPrincipleEval(newerModel), altPayload, '4.2 newer-model row stored independently');
  assertEqual(store.getLlmPrincipleEval(baseKey), samplePayload, '4.3 original row unaffected');
}

console.log('\n5. different contextHash → distinct cache row');
{
  const otherCtx = { ...baseKey, contextHash: 'b'.repeat(64) };
  assertEqual(store.getLlmPrincipleEval(otherCtx), null, '5.1 different contextHash misses');
}

console.log('\n6. different handbookEngineVersion → distinct cache row');
{
  const otherEngine = { ...baseKey, handbookEngineVersion: '1.2.0' };
  assertEqual(store.getLlmPrincipleEval(otherEngine), null, '6.1 different engineVersion misses');
}

console.log('\n7. different principleId → distinct cache row');
{
  const otherPid = { ...baseKey, principleId: 'P-III-8' };
  assertEqual(store.getLlmPrincipleEval(otherPid), null, '7.1 different principleId misses');
}

store.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

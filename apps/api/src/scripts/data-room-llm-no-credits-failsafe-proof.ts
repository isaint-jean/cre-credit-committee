/**
 * PROOF — the NO-CREDITS fail-safe for Tier 3.5 (run in isolation).
 *
 *   ANTHROPIC_API_KEY= DOTENV_CONFIG_PATH=/dev/null \
 *     npx tsx src/scripts/data-room-llm-no-credits-failsafe-proof.ts
 *
 * This process is launched with NO API key AND with dotenv pointed away from the
 * real .env, so `env.anthropicApiKey` resolves to '' → `creditsAvailable()` is
 * false → the LLM tier is SKIPPED ENTIRELY (no network call). We inject a stub
 * that WOULD confidently route a real loan+docType; it must NEVER be invoked, and
 * the doc must HELD. This proves the credit gate short-circuits before any call.
 *
 * Real cre.db is never opened (pool loans are a tiny fixture).
 */

import assert from 'node:assert';
import {
  classifyByLlm,
  creditsAvailable,
  type LlmRouteCall,
} from '../services/data-room/llm-smart-route.service.js';
import {
  classifyFileCascade,
  verdictFor,
  type PoolLoanNameKey,
} from '../services/data-room-classify.service.js';

async function main() {
  console.log('\n=== NO-CREDITS FAIL-SAFE PROOF ===');
  const live = creditsAvailable();
  console.log(`creditsAvailable() = ${live} (expected false — key unset + dotenv off)`);
  assert.strictEqual(live, false, 'credit gate must report FALSE when no key is present');

  const poolLoans: PoolLoanNameKey[] = [
    { loanInPoolId: 'ec9d2cfb-4baa-4347-bacc-84786d645da9', originatorLoanRef: '640 5th avenue', propertyName: null },
  ];

  let called = 0;
  const wouldRoute: LlmRouteCall = async () => {
    called++;
    return JSON.stringify({
      loanInPoolId: 'ec9d2cfb-4baa-4347-bacc-84786d645da9',
      docType: 'cf',
      confidence: 0.99,
      reason: 'would route confidently — but credits are out',
    });
  };

  // Direct service call: credit gate must short-circuit BEFORE the stub runs.
  const r = await classifyByLlm('640 Fifth Historical Occupancy.xlsx', 'operating statement', poolLoans, wouldRoute);
  assert.strictEqual(called, 0, 'LLM call must NOT be invoked when credits are out');
  assert.strictEqual(r.loanInPoolId, null, 'no-credits → loan null');
  assert.strictEqual(r.docType, null, 'no-credits → docType null');
  assert.strictEqual(r.note, null, 'no-credits → no provenance note');

  // Through the cascade: the doc HELDs exactly as today.
  const h = await classifyFileCascade(
    { fileName: '640 Fifth Historical Occupancy.xlsx', bytes: Buffer.alloc(0) },
    poolLoans,
    { llmCall: wouldRoute },
  );
  assert.strictEqual(verdictFor(h.docType, h.loanInPoolId).action, 'confirm', 'no-credits → HELD');
  assert.strictEqual(called, 0, 'cascade path also never called the LLM');

  console.log('  ✓ credits out → LLM SKIPPED (0 calls) → doc HELDs (today\'s behavior). No crash, no fabrication.');
  console.log('=== PASSED ===\n');
}

main().catch((e) => {
  console.error('PROOF FAILED:', e);
  process.exit(1);
});

/**
 * test-appraisal-adapter — unit tests for runAppraisalAdapter.
 *
 *   cd apps/api && npx tsx src/scripts/test-appraisal-adapter.ts
 *
 * Three cases (mirrors the structure of pca/asr/cf adapter tests):
 *   1. ABSENT path is implicit at the composer level — the adapter is never
 *      called when the slot is undefined. We assert this indirectly by
 *      verifying the adapter returns a clean ExtractorOutcome shape when
 *      handed a real input (the composer's absent-slot path is exercised
 *      by build-extraction-result tests).
 *   2. NON-CBRE buffer (random PDF-shaped bytes) → 'empty' via the 3-anchor
 *      sentinel (asIsValue + NRA + yearBuilt all null).
 *   3. The Sunroad CBRE PDF (deterministic regex hit) → 'ok' with
 *      asIsValue = 122,000,000 and a SourceDocumentRef of kind 'appraisal'.
 */
import { readFileSync } from 'node:fs';
import { runAppraisalAdapter } from '../services/extraction/adapters/appraisal.adapter.js';
import type { SlotInput } from '../services/extraction/extractor-outcome.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const SUNROAD_APPRAISAL = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/.data/source-docs/3327fd55-e382-4286-8378-64d33a11e518/appraisal/132b5d07f307ee1b8ce2fa0aba87a6f04d94bdd5d432a1c4307f1f83ad04ff1d.pdf';

(async () => {

  /* ----- Case 1 — ABSENT path semantics (mocked-deps cleanly resolve) ---- */

  console.log('Sentinel "no anchors" → empty (extractor produced an all-null shell):');
  {
    const slot: SlotInput = { buffer: Buffer.from('fake-pdf-bytes'), filename: 'fake.pdf' };
    const result = await runAppraisalAdapter(slot, {
      // Stub extractor: returns a shape with the 3 sentinel anchors null.
      // Cast through unknown to bypass the strict AppraisalExtraction shape
      // (which has many more fields); the adapter only inspects the 3 anchors.
      extractCbreAppraisal: async () => ({
        asIsValue: null,
        netRentableArea: null,
        yearBuilt: null,
        asStabilizedValue: null,
        overallCapRate: null,
        valueConclusion: null,
        capRate: null,
        methodology: null,
      } as unknown as Awaited<ReturnType<typeof import('../services/extract-cbre-appraisal.js').extractCbreAppraisal>>),
    });
    assertEqual(result.status, 'empty', '3-anchor compound (asIsValue + NRA + yearBuilt all null) → empty');
  }

  /* ----- Case 2 — asIsValue null but yearBuilt populated → still 'ok' ---- */

  console.log('\nPartial match (asIsValue null but yearBuilt populated) → ok (not "empty"):');
  {
    const slot: SlotInput = { buffer: Buffer.from('fake-pdf-bytes'), filename: 'fake.pdf' };
    const result = await runAppraisalAdapter(slot, {
      extractCbreAppraisal: async () => ({
        asIsValue: null,
        asStabilizedValue: null,
        netRentableArea: null,
        yearBuilt: 2008,             // identity anchor matched
        overallCapRate: null,
        valueConclusion: null,
        capRate: null,
        methodology: null,
      } as unknown as Awaited<ReturnType<typeof import('../services/extract-cbre-appraisal.js').extractCbreAppraisal>>),
    });
    assertEqual(result.status, 'ok', 'yearBuilt populated alone → ok (not empty)');
  }

  /* ----- Case 3 — Stabilized deal with real asIsValue but null asStab ---- */

  console.log('\nStabilized deal (real asIsValue, null asStabilizedValue) → ok:');
  {
    const slot: SlotInput = { buffer: Buffer.from('fake-pdf-bytes'), filename: 'fake.pdf' };
    const result = await runAppraisalAdapter(slot, {
      extractCbreAppraisal: async () => ({
        asIsValue: 122_000_000,
        asStabilizedValue: null,    // legitimate for stabilized deals
        netRentableArea: null,
        yearBuilt: null,
        overallCapRate: null,
        valueConclusion: 122_000_000,
        capRate: null,
        methodology: 'Income Capitalization Approach',
      } as unknown as Awaited<ReturnType<typeof import('../services/extract-cbre-appraisal.js').extractCbreAppraisal>>),
    });
    assertEqual(result.status, 'ok', 'stabilized deal (asIsValue populated, asStabilizedValue null) → ok');
  }

  /* ----- Case 4 — extractor throws → 'failed' --------------------------- */

  console.log('\nExtractor throws → failed:');
  {
    const slot: SlotInput = { buffer: Buffer.from('fake'), filename: 'fake.pdf' };
    const result = await runAppraisalAdapter(slot, {
      extractCbreAppraisal: async () => { throw new Error('synthetic'); },
    });
    assertEqual(result.status, 'failed', 'extractor throw → failed');
    if (result.status === 'failed') {
      assertEqual(result.error.name, 'extractCbreAppraisalThrew', 'error.name = extractCbreAppraisalThrew');
    }
  }

  /* ----- Case 5 — Real Sunroad CBRE PDF → 'ok' + asIsValue 122M --------- */

  console.log('\nReal Sunroad CBRE PDF → ok with asIsValue $122M + appraisal sourceRef:');
  {
    const buf = readFileSync(SUNROAD_APPRAISAL);
    const slot: SlotInput = { buffer: buf, filename: 'sunroad-appraisal.pdf' };
    const result = await runAppraisalAdapter(slot);
    assertEqual(result.status, 'ok', 'Sunroad CBRE PDF → ok');
    if (result.status === 'ok') {
      assertEqual(result.value?.asIsValue ?? null, 122_000_000, 'asIsValue = $122,000,000');
      assertEqual(result.sourceRefs.length, 1, 'one sourceRef emitted');
      assertEqual(result.sourceRefs[0]?.kind, 'appraisal', 'sourceRef.kind = appraisal');
      assertEqual(result.adapterVersion, '1.0', 'adapterVersion = 1.0');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

})().catch((err) => { console.error('Unhandled:', err); process.exit(2); });

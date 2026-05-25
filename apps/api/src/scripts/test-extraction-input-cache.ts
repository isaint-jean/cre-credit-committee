/**
 * Tests for the extraction-input-cache layer of Tier B (issue #10).
 *
 *   tsx src/scripts/test-extraction-input-cache.ts
 *
 * Two surfaces:
 *   - util/extraction-cache-key.ts pure helper — determinism, sensitivity to
 *     slot-hash and version changes, insensitivity to key ordering
 *   - record-graph-store.ts ops — insertExtractionInputCache,
 *     getExtractionInputCacheByKey, FK constraint to extraction_results
 */

import type {
  ContentHash,
  ExtractionResult,
  ExtractionResultId,
} from '@cre/contracts';
import { EXTRACTION_ENGINE_VERSION } from '@cre/contracts';
import { computeExtractionResultId } from '../util/content-hash.js';
import { computeExtractionInputKey } from '../util/extraction-cache-key.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function failPrint(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : failPrint(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : failPrint(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const HASH_A = ('a'.repeat(64)) as ContentHash;
const HASH_B = ('b'.repeat(64)) as ContentHash;
const HASH_C = ('c'.repeat(64)) as ContentHash;
const VERSIONS: Record<string, string> = {
  cf: '0.1.0',
  rentRoll: '0.1.0',
  asr: '0.2.0',
  engine: EXTRACTION_ENGINE_VERSION,
};

/* ----------------------- computeExtractionInputKey ------------------------ */

console.log('computeExtractionInputKey — determinism and sensitivity:');
{
  /* 1. Same inputs → same key */
  const k1 = computeExtractionInputKey({
    slotHashes: { cf: HASH_A, rentRoll: HASH_B, asr: HASH_C, pca: null },
    extractorVersions: VERSIONS,
  });
  const k2 = computeExtractionInputKey({
    slotHashes: { cf: HASH_A, rentRoll: HASH_B, asr: HASH_C, pca: null },
    extractorVersions: VERSIONS,
  });
  assertEqual(k1, k2, '1.1 same inputs → same key');
  assert(/^[0-9a-f]{64}$/.test(k1), '1.2 key is 64-char lowercase hex');
}

{
  /* 2. Different slot hash → different key */
  const k1 = computeExtractionInputKey({
    slotHashes: { cf: HASH_A, rentRoll: null, asr: null, pca: null },
    extractorVersions: VERSIONS,
  });
  const k2 = computeExtractionInputKey({
    slotHashes: { cf: HASH_B, rentRoll: null, asr: null, pca: null },
    extractorVersions: VERSIONS,
  });
  assert(k1 !== k2, '2.1 different cf slot hash → different key');
}

{
  /* 3. Different extractor version → different key */
  const slots = { cf: HASH_A, rentRoll: HASH_B, asr: HASH_C, pca: null };
  const k1 = computeExtractionInputKey({
    slotHashes: slots,
    extractorVersions: { ...VERSIONS, asr: '0.2.0' },
  });
  const k2 = computeExtractionInputKey({
    slotHashes: slots,
    extractorVersions: { ...VERSIONS, asr: '0.3.0' }, // hypothetical bump
  });
  assert(k1 !== k2, '3.1 different asr version → different key');
}

{
  /* 4. Null slots distinguishable from present slots */
  const k1 = computeExtractionInputKey({
    slotHashes: { cf: HASH_A, rentRoll: null, asr: null, pca: null },
    extractorVersions: VERSIONS,
  });
  const k2 = computeExtractionInputKey({
    slotHashes: { cf: HASH_A, rentRoll: HASH_A, asr: null, pca: null },
    extractorVersions: VERSIONS,
  });
  assert(k1 !== k2, '4.1 adding a slot changes the key');
}

{
  /* 5. JCS canonicalization makes key insensitive to source-spelling key
        ordering. Two args with the same logical content but different JS
        object construction should produce the same key. */
  const args1: Parameters<typeof computeExtractionInputKey>[0] = {
    slotHashes: { cf: HASH_A, rentRoll: HASH_B, asr: HASH_C, pca: null },
    extractorVersions: { cf: '0.1.0', rentRoll: '0.1.0', asr: '0.2.0', engine: EXTRACTION_ENGINE_VERSION },
  };
  // Different insertion order, same logical content
  const args2: Parameters<typeof computeExtractionInputKey>[0] = {
    extractorVersions: { engine: EXTRACTION_ENGINE_VERSION, asr: '0.2.0', rentRoll: '0.1.0', cf: '0.1.0' },
    slotHashes: { asr: HASH_C, cf: HASH_A, rentRoll: HASH_B, pca: null },
  };
  const k1 = computeExtractionInputKey(args1);
  const k2 = computeExtractionInputKey(args2);
  assertEqual(k1, k2, '5.1 key insensitive to JS object key insertion order (JCS canonical)');
}

/* ----------------------- record-graph-store cache ops --------------------- */

console.log('\nrecord-graph-store — extraction_input_cache ops:');
{
  const store = new RecordGraphStore(':memory:');

  // We need a real extraction_results row to satisfy the FK. Build a minimal
  // valid record (lots of nulls per the contract's degraded-state allowance).
  const extBody = {
    analysisAsOfDate: '2026-05-21T00:00:00Z',
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'TEST',
    rentRoll: null, t12: null, pca: null, appraisal: null,
    asr: null, sellerUw: null, sellerUwOperatingStatement: null, loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {} as Record<string, string>,
  };
  const extId = computeExtractionResultId(extBody);
  const extRecord = { id: extId, ...extBody } as ExtractionResult;
  store.insertExtractionResult(extRecord);

  /* 6. Insert + get round-trip */
  const cacheKey = computeExtractionInputKey({
    slotHashes: { cf: HASH_A, rentRoll: null, asr: null, pca: null },
    extractorVersions: VERSIONS,
  });
  const r1 = store.insertExtractionInputCache({
    cacheKey,
    extractionResultId: extId,
    propertyMetadataId: null,
    cfHash: HASH_A,
    rentRollHash: null,
    asrHash: null,
    extractorVersions: VERSIONS,
  });
  assertEqual(r1.inserted, true, '6.1 first insert reports inserted=true');

  const lookup = store.getExtractionInputCacheByKey(cacheKey);
  assertEqual(lookup?.extractionResultId ?? null, extId, '6.2 lookup returns stored extractionResultId');
  assertEqual(lookup?.propertyMetadataId ?? null, null, '6.3 lookup returns stored propertyMetadataId (null in this case)');

  /* 7. Idempotent re-insert */
  const r2 = store.insertExtractionInputCache({
    cacheKey,
    extractionResultId: extId,
    propertyMetadataId: null,
    cfHash: HASH_A,
    rentRollHash: null,
    asrHash: null,
    extractorVersions: VERSIONS,
  });
  assertEqual(r2.inserted, false, '7.1 re-insert of same cache_key → inserted=false');

  /* 8. Lookup miss returns null */
  const missingKey = ('0'.repeat(64)) as ContentHash;
  const missing = store.getExtractionInputCacheByKey(missingKey);
  assertEqual(missing, null, '8.1 unknown cache_key → null');

  /* 9. FK constraint: inserting with an unknown extraction_result_id throws */
  let threw: Error | null = null;
  try {
    store.insertExtractionInputCache({
      cacheKey: ('f'.repeat(64)) as ContentHash,
      extractionResultId: ('e'.repeat(64)) as ExtractionResultId,
      propertyMetadataId: null,
      cfHash: null, rentRollHash: null, asrHash: null,
      extractorVersions: VERSIONS,
    });
  } catch (e) { threw = e as Error; }
  assert(threw !== null, '9.1 FK violation on unknown extraction_result_id → throws');

  store.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

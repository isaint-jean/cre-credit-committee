/**
 * PROOF harness — FIX 2: deal-creation seeds a matchable loan (the follow-on to
 * the FIX-1 ordinal bridge).
 *
 *   npx tsx apps/api/src/scripts/fix2-seed-single-loan-proof.ts
 *
 * Runs the REAL PoolStore against a TEMP sqlite db (the real cre.db is NEVER
 * opened). Proves three things end to end, all through the SAME seams the live
 * routes use:
 *
 *   GATE A (create→seed→route) — POST-create with propertyName "640 Fifth Ave"
 *     (via seedSingleLoan) writes ONE loan_in_pool row → listLoanNameKeysForPool
 *     returns it → a doc whose page-1 text says "640 5th Avenue" classifies to
 *     that seeded loan via classifyLoanFromContent + the FIX-1 ordinal bridge
 *     (fifth↔5th).
 *
 *   GATE B (existing pools unaffected) — a create WITHOUT propertyName seeds NO
 *     loan (the pool is a byte-identical shell: zero loan_in_pool rows). A
 *     separately tape-loaded pool's own loan is untouched.
 *
 *   GATE C (honest / deterministic-or-refuse) — the seeded loan is a real
 *     user-supplied target, but the router still REFUSES a doc with no clean
 *     signal (the generic "1b. 2019 detailed financials" that correctly held in
 *     FIX 1) → classifyLoanFromContent returns null. No fake match.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fix2-seed-'));
  const dbPath = path.join(tmpRoot, 'cre.db');

  const { PoolStore } = await import('../storage/pool-store.js');
  const { classifyLoanFromContent, classifyLoanFromFilename } = await import(
    '../services/data-room-classify.service.js'
  );

  const log = (m: string) => process.stdout.write(m + '\n');
  const store = new PoolStore(dbPath); // TEMP db — real cre.db never touched.

  /* ─────────────────────────────────────────────────────────────────────────
   * GATE A — create → seed → route
   * ─────────────────────────────────────────────────────────────────────── */
  log('── GATE A: create a single-property deal → seed a matchable loan → route ──');

  // Mirror the route's create path: mint a pool SHELL, then seed one loan from
  // the supplied property name (exactly what pool.routes.ts POST / does when
  // propertyName is present).
  const poolA = {
    id: 'pool-fix2-A' as any,
    shelfName: '640 Fifth Ave (single-property)',
    vintage: 2024,
    seller: null,
    createdAt: new Date().toISOString(),
    tapeIds: [] as any[],
    currentTapeId: null,
    closedAt: null,
  };
  store.createPool(poolA as any);
  const seeded = store.seedSingleLoan(poolA.id, '640 Fifth Ave');
  log(`  seeded loan id=${seeded.id}`);
  log(`    propertyName=${JSON.stringify(seeded.propertyName)} originatorLoanRef=${JSON.stringify(seeded.originatorLoanRef)}`);
  log(`    assetType=${JSON.stringify(seeded.assetType)} addedOnTape=${JSON.stringify(seeded.addedOnTape)}`);

  // A) the loan_in_pool row exists with that name (read back via the SAME read
  //    the classify seam uses).
  const keysA = store.listLoanNameKeysForPool(poolA.id);
  assert.strictEqual(keysA.length, 1, 'GATE A: exactly one seeded loan expected');
  assert.strictEqual(keysA[0]!.propertyName, '640 Fifth Ave', 'GATE A: propertyName persisted');
  assert.strictEqual(keysA[0]!.loanInPoolId, seeded.id, 'GATE A: id round-trips');
  log(`  ✓ loan_in_pool row present via listLoanNameKeysForPool (name="${keysA[0]!.propertyName}")`);

  // B) a doc whose page-1 CONTENT says "640 5th Avenue" (numeral) classifies to
  //    the seeded "640 Fifth Ave" (word) loan — this is the FIX-1 ordinal bridge
  //    (fifth↔5th) firing through the content classifier.
  const docPageText =
    'CONFIDENTIAL OFFERING MEMORANDUM\n' +
    '640 5th Avenue, New York, NY 10019\n' +
    'A trophy retail-and-office condominium on Fifth Avenue.\n' +
    'Detailed financial statements follow.';
  const contentMatch = classifyLoanFromContent(docPageText, keysA);
  log(`  content classify("640 5th Avenue …") → ${contentMatch === null ? 'null (REFUSE)' : contentMatch}`);
  assert.strictEqual(contentMatch, seeded.id, 'GATE A: 640 5th Avenue doc must route to the seeded loan');
  log('  ✓ create→seed→route chain proven end to end (content tier + ordinal bridge)');

  // The EXACT filename tier routes it when the filename normalizes to the SAME
  // key the seeded loan carries — a "640 Fifth Ave.pdf" drop for a loan the user
  // typed as "640 5th Avenue" (numeral). The FILENAME side goes through
  // normalizeForMatch (which HAS the FIX-1 ordinal bridge: fifth→5th), so the
  // filename collapses to "640 5th avenue" and matches the seeded numeral name.
  const poolA2 = {
    id: 'pool-fix2-A2' as any,
    shelfName: '640 5th Avenue (numeral form)',
    vintage: 2024, seller: null,
    createdAt: new Date().toISOString(),
    tapeIds: [] as any[], currentTapeId: null, closedAt: null,
  };
  store.createPool(poolA2 as any);
  const seeded2 = store.seedSingleLoan(poolA2.id, '640 5th Avenue');
  const keysA2 = store.listLoanNameKeysForPool(poolA2.id);
  const fileMatch = classifyLoanFromFilename('640 Fifth Avenue.pdf', keysA2);
  log(`  filename classify("640 Fifth Avenue.pdf") vs loan "640 5th Avenue" → ${fileMatch === null ? 'null' : fileMatch}`);
  assert.strictEqual(fileMatch, seeded2.id, 'GATE A: filename tier routes via the ordinal bridge (fifth→5th on the filename side)');
  log('  ✓ filename tier routes too — the FIX-1 ordinal bridge fires on the filename side');

  // ★ HONEST FINDING (documented, NOT a gate — an asymmetry inherited from FIX 1):
  // the EXACT filename tier bridges ordinals ONLY on the FILENAME side
  // (classifyLoanFromFilename runs the filename through normalizeForMatch but the
  // pool-loan name only through normalizePropertyName, which has no ordinal
  // bridge). So a loan the user typed with a WORD ordinal ("640 Fifth Ave") is NOT
  // reached by a numeral filename via the exact tier (loan key "640 fifth ave" ≠
  // target "640 5th ave"). The CONTENT tier (matchFileToDeal) runs BOTH sides
  // through normalizeForMatch, so it DOES bridge — which is exactly the path GATE A
  // proves above. NET: for FIX-2's goal (routing this deal's docs), the content
  // tier is the reliable seam and it works regardless of which ordinal form the
  // user typed; a symmetric ordinal bridge on the loan side of the filename tier
  // is a small, safe follow-on to FIX 1 (out of scope here).
  const wordLoanKeys = store.listLoanNameKeysForPool(poolA.id); // seeded "640 Fifth Ave" (word)
  const wordExact = classifyLoanFromFilename('640 5th Avenue.pdf', wordLoanKeys);
  log(`  filename classify("640 5th Avenue.pdf") vs loan "640 Fifth Ave" → ${wordExact === null ? 'null (loan-side ordinal not bridged in exact tier; content tier covers it)' : wordExact}`);
  assert.strictEqual(wordExact, null, 'documented asymmetry: exact-tier ordinal bridge is filename-side-only');
  const wordContent = classifyLoanFromContent(docPageText, wordLoanKeys);
  assert.strictEqual(wordContent, seeded.id, 'content tier bridges the word-ordinal loan (the reliable FIX-2 seam)');
  log('  ✓ honest: word-ordinal loan is reached by the CONTENT tier (the seam FIX 2 relies on)');

  /* ─────────────────────────────────────────────────────────────────────────
   * GATE B — existing tape-loaded pools unaffected
   * ─────────────────────────────────────────────────────────────────────── */
  log('\n── GATE B: create WITHOUT propertyName seeds NO loan; tape pool untouched ──');

  const poolShell = {
    id: 'pool-fix2-shell' as any,
    shelfName: 'BMARK 2024-V8 (CMBS shell)',
    vintage: 2024,
    seller: 'BMARK',
    createdAt: new Date().toISOString(),
    tapeIds: [] as any[],
    currentTapeId: null,
    closedAt: null,
  };
  store.createPool(poolShell as any);
  // No seedSingleLoan call (the route skips it when propertyName is absent).
  const keysShell = store.listLoanNameKeysForPool(poolShell.id);
  assert.strictEqual(keysShell.length, 0, 'GATE B: a name-less create must seed ZERO loans');
  log('  ✓ create without propertyName → 0 loan_in_pool rows (byte-identical shell)');

  // A tape-loaded pool's loan (inserted via the normal insert path) is untouched
  // by the seed feature — it coexists cleanly.
  const poolBmark = {
    id: 'pool-fix2-bmark' as any,
    shelfName: 'BMARK loaded',
    vintage: 2024,
    seller: 'BMARK',
    createdAt: new Date().toISOString(),
    tapeIds: [] as any[],
    currentTapeId: null,
    closedAt: null,
  };
  store.createPool(poolBmark as any);
  store.insertLoanInPool({
    id: 'lip-bmark-existing' as any,
    poolId: poolBmark.id,
    dealRef: 'engine-rev-abc',
    addedOnTape: 'tape-real-hash' as any,
    originatorLoanRef: 'BMARK-556',
    propertyName: '556 Third Avenue',
    assetType: 'Office' as any,
    currentDispositionId: null,
    lifecycleStatus: null,
  } as any);
  const keysBmark = store.listLoanNameKeysForPool(poolBmark.id);
  assert.strictEqual(keysBmark.length, 1, 'GATE B: tape-loaded loan present');
  assert.strictEqual(keysBmark[0]!.propertyName, '556 Third Avenue', 'GATE B: tape loan untouched');
  // The seeded pool-A loan is NOT visible in the BMARK pool (pool-scoping holds).
  assert.ok(!keysBmark.some((k) => k.loanInPoolId === seeded.id), 'GATE B: seeded loan does not leak across pools');
  log('  ✓ tape-loaded pool loan untouched, pool-scoping holds (seed does not leak)');

  /* ─────────────────────────────────────────────────────────────────────────
   * GATE C — honest / deterministic-or-refuse
   * ─────────────────────────────────────────────────────────────────────── */
  log('\n── GATE C: router still REFUSES a doc with no clean signal ──');

  // The FIX-1 "1b. 2019 detailed financials" case: a generic doc name with no
  // property address in its content. Even with a seeded loan present, the content
  // classifier must REFUSE (return null) — never fabricate a match.
  const genericPageText =
    '1b. 2019 Detailed Financials\n' +
    'Operating statement — trailing twelve months.\n' +
    'Total revenue, operating expenses, net operating income.';
  const genericMatch = classifyLoanFromContent(genericPageText, keysA);
  log(`  content classify("1b. 2019 detailed financials …") → ${genericMatch === null ? 'null (REFUSE)' : genericMatch}`);
  assert.strictEqual(genericMatch, null, 'GATE C: generic doc with no property signal must HOLD (null)');
  log('  ✓ honest refuse holds — generic doc routes to no loan (deterministic-or-refuse)');

  // Also: a filename with no clean property token refuses.
  const genericFile = classifyLoanFromFilename('1b. 2019 detailed financials.pdf', keysA);
  assert.strictEqual(genericFile, null, 'GATE C: generic filename must refuse too');
  log('  ✓ generic filename also refuses');

  store.close?.();
  log('\nALL GATES PASSED — create→seed→route proven; existing pools unaffected; honest refuse holds.');
  log(`(temp db: ${dbPath} — real cre.db never opened)`);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});

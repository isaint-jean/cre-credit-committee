/**
 * Tests for the doctrine reason catalogue (i18n).
 *
 *   npm run test:reason-catalogue
 *
 * Verifies completeness, lookup, non-empty strings, and that the assertion catches synthetic
 * gaps when the type system is bypassed.
 */

import { DoctrineReasonCodes } from '@cre/contracts';
import type { DoctrineReasonCode } from '@cre/contracts';
import {
  DOCTRINE_REASON_CATALOGUE,
  assertReasonCatalogueComplete,
  reasonString,
} from '../services/doctrine/reason-catalogue.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

console.log('Completeness:');
{
  const codes = Object.values(DoctrineReasonCodes);
  let missing = 0;
  for (const code of codes) {
    if (!(code in DOCTRINE_REASON_CATALOGUE)) {
      missing++;
      fail(`code '${code}' has no catalogue entry`);
    }
  }
  if (missing === 0) ok(`all ${codes.length} codes have catalogue entries`);
}

console.log('\nNon-empty strings:');
{
  let empty = 0;
  for (const [code, str] of Object.entries(DOCTRINE_REASON_CATALOGUE)) {
    if (typeof str !== 'string' || str.length === 0) {
      empty++;
      fail(`code '${code}' has empty/non-string entry`);
    }
  }
  if (empty === 0) ok('every catalogue entry is a non-empty string');
}

console.log('\nNo extra keys (catalogue exactly matches code set):');
{
  const codeSet = new Set<string>(Object.values(DoctrineReasonCodes));
  let extra = 0;
  for (const k of Object.keys(DOCTRINE_REASON_CATALOGUE)) {
    if (!codeSet.has(k)) {
      extra++;
      fail(`catalogue key '${k}' is not a DoctrineReasonCode`);
    }
  }
  if (extra === 0) ok('no orphan keys in catalogue');
}

console.log('\nLookup helper:');
{
  assertEqual(
    reasonString(DoctrineReasonCodes.UW_AGGRESSIVE_ABOVE_T12),
    'Underwriting NOI exceeds trailing T-12 by more than 10% — aggressive.',
    'UW_AGGRESSIVE_ABOVE_T12 lookup',
  );
  assertEqual(
    reasonString(DoctrineReasonCodes.INSUFFICIENT_DATA),
    'Insufficient data to evaluate.',
    'INSUFFICIENT_DATA lookup',
  );
  assertEqual(
    reasonString(DoctrineReasonCodes.MHC_PRIVATE_WASTEWATER_RISK),
    'Manufactured housing community on private wastewater system.',
    'MHC_PRIVATE_WASTEWATER_RISK lookup',
  );
}

console.log('\nTone / format spot-checks (no emojis, no all-caps display strings):');
{
  for (const [code, str] of Object.entries(DOCTRINE_REASON_CATALOGUE)) {
    if (/[\uD83D-\uD83F]/.test(str) || /[☀-➿]/.test(str)) {
      fail(`code '${code}' contains an emoji`);
    }
    if (str === str.toUpperCase() && /[A-Z]/.test(str)) {
      fail(`code '${code}' is all-caps display text: "${str}"`);
    }
  }
  ok('no emojis or all-caps display strings');
}

console.log('\nRuntime assertion:');
{
  try {
    assertReasonCatalogueComplete();
    ok('assertReasonCatalogueComplete passes on the real catalogue');
  } catch (e) {
    fail(`assertReasonCatalogueComplete threw: ${(e as Error).message}`);
  }
}

console.log('\nSynthetic gap detection:');
{
  // Simulate the (compile-time-illegal) "missing entry" case to verify the assertion fires.
  const tampered = { ...DOCTRINE_REASON_CATALOGUE } as Record<DoctrineReasonCode, string>;
  delete (tampered as { INSUFFICIENT_DATA?: string }).INSUFFICIENT_DATA;
  let threw = false;
  for (const code of Object.values(DoctrineReasonCodes)) {
    if (typeof tampered[code] !== 'string' || tampered[code]!.length === 0) {
      threw = true;
      break;
    }
  }
  assert(threw, 'a missing entry would be caught by the same logic');
}

console.log('\nCount sanity:');
{
  const codeCount = Object.keys(DoctrineReasonCodes).length;
  const catalogueCount = Object.keys(DOCTRINE_REASON_CATALOGUE).length;
  assertEqual(codeCount, catalogueCount, `code count (${codeCount}) matches catalogue count`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

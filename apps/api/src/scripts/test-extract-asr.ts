/**
 * Tests for parseAsrAiResponse — the pure parser inside extract-asr.ts.
 * Exercises JSON extraction, type/format normalization (money, cap rate),
 * placeholder-string detection, and the all-null → null contract.
 *
 *   tsx src/scripts/test-extract-asr.ts
 */

import { parseAsrAiResponse } from '../services/extract-asr.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }

/* 1. Happy path — all three fields populated, cap rate already a fraction */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 12_500_000,
    impliedCapRate: 0.065,
    underwrittenNOI: 812_500,
  }));
  assert(r !== null, '1a. happy path returns non-null');
  assert(r?.impliedValue === 12_500_000, '1b. impliedValue preserved');
  assert(r?.impliedCapRate === 0.065, '1c. fractional cap rate preserved');
  assert(r?.underwrittenNOI === 812_500, '1d. NOI preserved');
}

/* 2. Cap rate as percent (e.g. 6.5) — normalized to fraction (0.065) */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 10_000_000,
    impliedCapRate: 6.5,
    underwrittenNOI: 650_000,
  }));
  assert(r !== null, '2a. percent cap rate parses');
  assert(r?.impliedCapRate === 0.065, '2b. 6.5 normalized to 0.065');
}

/* 3. Cap rate edge case — exactly 1.0 treated as fraction (100%, unrealistic but literal) */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 1_000_000,
    impliedCapRate: 1,
    underwrittenNOI: 1_000_000,
  }));
  assert(r?.impliedCapRate === 1, '3. cap rate = 1 preserved as fraction');
}

/* 4. Partial JSON — some fields null, returns record with mixed values */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 8_000_000,
    impliedCapRate: null,
    underwrittenNOI: null,
  }));
  assert(r !== null, '4a. partial fields still returns record');
  assert(r?.impliedValue === 8_000_000, '4b. populated field preserved');
  assert(r?.impliedCapRate === null, '4c. null cap rate stays null');
  assert(r?.underwrittenNOI === null, '4d. null NOI stays null');
}

/* 5. All-null fields → null (no fabricated empty record) */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: null,
    impliedCapRate: null,
    underwrittenNOI: null,
  }));
  assert(r === null, '5. all-null fields → null');
}

/* 6. Malformed JSON → null (no throw) */
{
  const r = parseAsrAiResponse('this is not JSON at all');
  assert(r === null, '6. malformed input → null');
}

/* 7. Placeholder strings ("N/A", "TBD") map to null */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 'N/A',
    impliedCapRate: 'TBD',
    underwrittenNOI: 'Not Provided',
  }));
  assert(r === null, '7. all placeholder strings → null record');
}

/* 8. Empty string and whitespace map to null */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: '',
    impliedCapRate: '   ',
    underwrittenNOI: 500_000,
  }));
  assert(r !== null, '8a. some populated → non-null record');
  assert(r?.impliedValue === null, '8b. empty string → null');
  assert(r?.impliedCapRate === null, '8c. whitespace string → null');
  assert(r?.underwrittenNOI === 500_000, '8d. NOI preserved');
}

/* 9. Currency-formatted strings parse (e.g. "$12,500,000") */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: '$12,500,000',
    impliedCapRate: '6.50%',
    underwrittenNOI: '$812,500',
  }));
  assert(r?.impliedValue === 12_500_000, '9a. $-formatted value parses');
  assert(r?.impliedCapRate === 0.065, '9b. percent-suffixed cap rate parses & normalizes');
  assert(r?.underwrittenNOI === 812_500, '9c. $-formatted NOI parses');
}

/* 10. Non-finite numbers (NaN, Infinity) → null */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 'not a number',
    impliedCapRate: 0.06,
    underwrittenNOI: 700_000,
  }));
  assert(r?.impliedValue === null, '10a. unparseable string → null');
  assert(r?.impliedCapRate === 0.06, '10b. valid cap rate preserved');
  assert(r?.underwrittenNOI === 700_000, '10c. NOI preserved');
}

/* 11. Negative cap rate → null (negative cap rates are nonsensical) */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 10_000_000,
    impliedCapRate: -0.05,
    underwrittenNOI: 500_000,
  }));
  assert(r?.impliedCapRate === null, '11a. negative cap rate → null');
  assert(r?.impliedValue === 10_000_000, '11b. impliedValue still preserved');
}

/* 12. Negative NOI and value are valid (losses, distressed pricing) */
{
  const r = parseAsrAiResponse(JSON.stringify({
    impliedValue: 5_000_000,
    impliedCapRate: 0.07,
    underwrittenNOI: -50_000,
  }));
  assert(r?.underwrittenNOI === -50_000, '12. negative NOI preserved (losses are valid)');
}

/* 13. JSON wrapped in prose (extractJSON pulls the blob) */
{
  const wrapped = 'Here are the extracted values:\n\n```json\n' +
    JSON.stringify({ impliedValue: 9_000_000, impliedCapRate: 5.5, underwrittenNOI: 495_000 }) +
    '\n```\n\nThank you.';
  const r = parseAsrAiResponse(wrapped);
  assert(r?.impliedValue === 9_000_000, '13a. JSON inside prose extracted');
  assert(r?.impliedCapRate === 0.055, '13b. cap rate normalized from prose-wrapped JSON');
  assert(r?.underwrittenNOI === 495_000, '13c. NOI extracted from prose-wrapped JSON');
}

/* 14. Already-parsed object (direct shortcut) */
{
  const r = parseAsrAiResponse({
    impliedValue: 7_500_000,
    impliedCapRate: 0.06,
    underwrittenNOI: 450_000,
  });
  assert(r?.impliedValue === 7_500_000, '14. object input bypasses JSON parse');
}

/* 15. Non-object input → null */
{
  assert(parseAsrAiResponse(42 as unknown) === null, '15a. number input → null');
  assert(parseAsrAiResponse(null as unknown) === null, '15b. null input → null');
  assert(parseAsrAiResponse([] as unknown) === null, '15c. array input not coerced to record');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

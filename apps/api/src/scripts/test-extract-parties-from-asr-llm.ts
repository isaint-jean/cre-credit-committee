/**
 * Tests for the LLM-primary parties extractor (extract-parties-from-asr-llm.ts).
 *
 *   npm run test:extract-parties-from-asr-llm
 *
 * Deterministic — a stub LLM returns recorded JSON; the parser + cite-or-discard
 * chain runs off it with no live call. Proves:
 *   - multi-principal extraction (a JV → two cited principals);
 *   - CITE-OR-DISCARD (a name whose quote isn't in the doc, or whose quote
 *     doesn't contain the name → dropped);
 *   - the GENUINE-GAP invariant (only a defined term / SPV → null, no fabrication);
 *   - honest not-found (nothing citeable → parties null);
 *   - credit-gate ($0 when no credits) + cache ($0 on the second call);
 *   - fail-safe (malformed output → null).
 */
import {
  parsePartiesLlmResponse,
  extractPartiesFromAsrLlm,
  InMemoryPartiesLlmCache,
  type PartiesLlmCall,
} from '../services/extract-parties-from-asr-llm.js';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

// A faithful slice of 640's real BMO ASR §3 Sponsorship Overview prose (the
// names + verbatim context the LLM would quote).
const DOC_640 =
  'Sponsorship Overview. Vornado Realty Trust and Crown Acquisitions (the "JV Partners," ' +
  'collectively, the "Sponsor") to refinance the existing debt on 640 Fifth Avenue (the "Property"). ' +
  'Founded in 1982, Vornado Realty Trust is a fully-integrated Real Estate Investment Trust. ' +
  'The Sponsor will contribute over $100.0MM of new equity.';

/* ---- multi-principal (the JV) + cite-or-discard -------------------------- */
console.log('Multi-principal — a JV yields TWO cited principals:');
{
  const resp = JSON.stringify({
    borrowerEntity: { value: null, sourceQuote: null },
    sponsorPrincipals: [
      { value: 'Vornado Realty Trust', sourceQuote: 'Vornado Realty Trust and Crown Acquisitions' },
      { value: 'Crown Acquisitions', sourceQuote: 'Vornado Realty Trust and Crown Acquisitions' },
    ],
  });
  const r = parsePartiesLlmResponse(resp, DOC_640);
  assert(r.parties !== null, 'parties produced');
  assertEqual(JSON.stringify(r.parties!.sponsors), JSON.stringify(['Vornado Realty Trust', 'Crown Acquisitions']), 'both principals cited, in order');
  assertEqual(r.parties!.sponsorName, 'Vornado Realty Trust', 'sponsorName back-compat = first principal');
  assertEqual(r.parties!.borrowerName, null, 'borrower SPV not named → null (not forced)');
}

/* ---- cite-or-discard: quote must appear AND contain the name -------------- */
console.log('Cite-or-discard — un-grounded / mis-cited names are dropped:');
{
  const resp = JSON.stringify({
    borrowerEntity: { value: null, sourceQuote: null },
    sponsorPrincipals: [
      { value: 'Vornado Realty Trust', sourceQuote: 'Vornado Realty Trust and Crown Acquisitions' }, // cited
      { value: 'Blackstone Inc.', sourceQuote: 'Blackstone is a leading investor' },                 // quote NOT in doc → drop
      { value: 'Crown Acquisitions', sourceQuote: 'Founded in 1982, Vornado Realty Trust is' },      // quote in doc but does NOT contain the name → drop
    ],
  });
  const r = parsePartiesLlmResponse(resp, DOC_640);
  assertEqual(JSON.stringify(r.parties!.sponsors), JSON.stringify(['Vornado Realty Trust']), 'only the properly-grounded principal survives');
  assert(!JSON.stringify(r.parties!.sponsors).includes('Blackstone'), 'a name NOT present in the document is discarded (anti-fabrication)');
  assert(!JSON.stringify(r.parties!.sponsors).includes('Crown'), 'a name whose cited quote does not contain it is discarded (mis-citation)');
}

/* ---- GENUINE-GAP invariant: only a defined term / SPV → null ------------- */
console.log('Genuine-gap — a filing naming only a defined term / SPV yields no principal:');
{
  const gapDoc = 'The Borrower is a single-purpose Delaware limited liability company. The Sponsor will guarantee customary carve-outs.';
  const resp = JSON.stringify({
    borrowerEntity: { value: 'the Borrower', sourceQuote: 'The Borrower is a single-purpose Delaware' }, // placeholder → drop
    sponsorPrincipals: [
      { value: 'the Sponsor', sourceQuote: 'The Sponsor will guarantee customary carve-outs' }, // placeholder → drop
      { value: 'Sponsor', sourceQuote: 'The Sponsor will guarantee' },                            // placeholder → drop
    ],
  });
  const r = parsePartiesLlmResponse(resp, gapDoc);
  assertEqual(r.parties, null, 'no real name → parties null → "cannot assess" correctly stands (no fabrication)');
}

/* ---- honest not-found: empty principals + no borrower → null ------------- */
console.log('Honest not-found:');
{
  const r = parsePartiesLlmResponse(JSON.stringify({ borrowerEntity: { value: null, sourceQuote: null }, sponsorPrincipals: [] }), DOC_640);
  assertEqual(r.parties, null, 'nothing citeable → null');
  assertEqual(parsePartiesLlmResponse('not json at all', DOC_640).parties, null, 'malformed output → null (fail-safe)');
  assertEqual(parsePartiesLlmResponse(JSON.stringify({}), DOC_640).parties, null, 'empty object → null');
}

/* ---- borrower SPV when genuinely named ----------------------------------- */
console.log('Borrower entity when genuinely named:');
{
  const doc = 'Summary of Terms. Borrowing Entity: 640 Fifth Avenue Owner LLC, a Delaware limited liability company.';
  const resp = JSON.stringify({
    borrowerEntity: { value: '640 Fifth Avenue Owner LLC', sourceQuote: 'Borrowing Entity: 640 Fifth Avenue Owner LLC, a Delaware' },
    sponsorPrincipals: [],
  });
  const r = parsePartiesLlmResponse(resp, doc);
  assertEqual(r.parties!.borrowerName, '640 Fifth Avenue Owner LLC', 'a genuinely-named SPV is captured');
  assertEqual(JSON.stringify(r.parties!.sponsors), '[]', 'no principal named → empty sponsors (honest)');
  assertEqual(r.parties!.sponsorName, null, 'sponsorName null when no principal');
}

/* ---- dedupe principals --------------------------------------------------- */
console.log('Dedupe:');
{
  const resp = JSON.stringify({
    borrowerEntity: { value: null, sourceQuote: null },
    sponsorPrincipals: [
      { value: 'Vornado Realty Trust', sourceQuote: 'Vornado Realty Trust and Crown' },
      { value: 'vornado realty trust', sourceQuote: 'Vornado Realty Trust and Crown' }, // case-dupe → drop
    ],
  });
  const r = parsePartiesLlmResponse(resp, DOC_640);
  assertEqual(r.parties!.sponsors!.length, 1, 'case-insensitive duplicate principal collapsed to one');
}

/* ---- credit-gate + cache (deterministic, no live call) ------------------- */
void (async () => {
  console.log('Credit gate — no credits → $0, parties null:');
  {
    let calls = 0;
    const stub: PartiesLlmCall = async () => { calls++; return '{}'; };
    const r = await extractPartiesFromAsrLlm(DOC_640, 'hash-1', { llmCall: stub, creditsAvailable: () => false });
    assertEqual(r.parties, null, 'no credits → null');
    assertEqual(r.llmCalled, false, 'no credits → the LLM is NOT called ($0)');
    assertEqual(calls, 0, 'stub never invoked');
  }

  console.log('Cache — second call is a $0 hit:');
  {
    const cache = new InMemoryPartiesLlmCache();
    let calls = 0;
    const stub: PartiesLlmCall = async () => {
      calls++;
      return JSON.stringify({ borrowerEntity: { value: null, sourceQuote: null }, sponsorPrincipals: [{ value: 'Vornado Realty Trust', sourceQuote: 'Vornado Realty Trust and Crown' }] });
    };
    const r1 = await extractPartiesFromAsrLlm(DOC_640, 'hash-2', { llmCall: stub, creditsAvailable: () => true, cache });
    assertEqual(r1.llmCalled, true, 'first call hits the LLM');
    assertEqual(r1.parties!.sponsors![0], 'Vornado Realty Trust', 'first call extracts');
    const r2 = await extractPartiesFromAsrLlm(DOC_640, 'hash-2', { llmCall: stub, creditsAvailable: () => true, cache });
    assertEqual(r2.fromCache, true, 'second call served from cache');
    assertEqual(r2.llmCalled, false, 'second call makes ZERO LLM calls');
    assertEqual(calls, 1, 'the LLM was called exactly once across two invocations');
    assertEqual(JSON.stringify(r2.parties), JSON.stringify(r1.parties), 'cached result is identical');
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} extract-parties-from-asr-llm: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

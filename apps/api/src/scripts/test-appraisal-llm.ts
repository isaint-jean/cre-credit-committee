/**
 * Deterministic tests for the appraisal LLM-primary core extractor
 * (extract-cbre-appraisal-llm.ts) + the adapter merge. No live call — a stub LLM
 * seam replays fixture JSON so the parse + cite-or-discard + normalization + cache
 * + fail-safe chain is exercised deterministically. The REAL-doc falsification
 * (does a live LLM read Lexington's values?) is the separate proof
 * `proof-appraisal-llm-lexington.ts`.
 *
 *   npm run test:appraisal-llm
 */
import {
  parseAppraisalLlmResponse,
  extractCbreAppraisalLlm,
  InMemoryAppraisalLlmCache,
  type AppraisalLlmCall,
} from '../services/extract-cbre-appraisal-llm.js';
import { runAppraisalAdapter } from '../services/extraction/adapters/appraisal.adapter.js';
import type { AppraisalExtraction, SourceDocumentKind } from '@cre/contracts';

let passed = 0, failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function eq<T>(a: T, b: T, m: string): void { a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`); }

/* A synthetic appraisal text carrying the quotes the fixture LLM will cite. Cite-
   or-discard verifies each quote appears here (whitespace-normalized). */
const DOC = [
  'APPRAISAL REPORT — Lexington Grand, 186 Roy Truesdell Road, Lugoff, Kershaw County, South Carolina.',
  'As Is Market Value (As Restricted With Real Estate Tax Exemption) Leased Fee Interest January 18, 2024 $6,575,000',
  'The overall capitalization rate concluded for the subject is 6.00%.',
  'Prospective Market Value As Stabilized $7,150,000.',
  'Concluded stabilized net operating income of $394,500.',
  'Based on the rent roll, the subject property is 90.63% occupied.',
  'The improvements were constructed in 2009.',
  'The primary approach relied upon is the Income Capitalization Approach.',
].join('\n');

function goodResponse(): string {
  return JSON.stringify({
    asIsValue: { value: 6_575_000, sourceQuote: 'Leased Fee Interest January 18, 2024 $6,575,000' },
    asStabilizedValue: { value: 7_150_000, sourceQuote: 'As Stabilized $7,150,000' },
    overallCapRate: { value: 6.00, sourceQuote: 'the subject is 6.00%' },
    terminalCapRate: { value: null, sourceQuote: null },
    stabilizedNoi: { value: 394_500, sourceQuote: 'net operating income of $394,500' },
    currentOccupancyPhysical: { value: 90.63, sourceQuote: 'is 90.63% occupied' },
    yearBuilt: { value: 2009, sourceQuote: 'constructed in 2009' },
    city: { value: 'Lugoff', sourceQuote: 'Lugoff, Kershaw County' },
    state: { value: 'SC', sourceQuote: 'South Carolina' },
    interestAppraised: { value: 'Leased Fee', sourceQuote: 'Leased Fee Interest' },
    methodology: { value: 'Income Capitalization Approach', sourceQuote: 'Income Capitalization Approach' },
  });
}

/* ---- Parse + cite-or-discard + normalization ----------------------------- */
console.log('Parse — cite-or-discard grounds every value in the doc + normalizes units:');
{
  const r = parseAppraisalLlmResponse(goodResponse(), DOC);
  eq(r.asIsValue, 6_575_000, 'asIsValue extracted (cited)');
  eq(r.asStabilizedValue, 7_150_000, 'asStabilizedValue extracted');
  eq(r.overallCapRate, 0.06, 'cap rate 6.00 → 0.06 fraction');
  eq(r.terminalCapRate, null, 'terminal cap null (honest)');
  eq(r.stabilizedNoi, 394_500, 'stabilized NOI extracted');
  eq(r.currentOccupancyPhysical, 0.9063, 'occupancy 90.63 → 0.9063 fraction');
  eq(r.yearBuilt, 2009, 'yearBuilt extracted');
  eq(r.city, 'Lugoff', 'city = subject (Lugoff) — never Sunroad');
  eq(r.state, 'SC', 'state = SC');
  eq(r.interestAppraised, 'Leased Fee', 'interest appraised extracted');
  eq(r.methodology, 'Income Capitalization Approach', 'methodology extracted');
}

console.log('\nDecimal-fraction inputs normalize idempotently (0.06 stays 0.06):');
{
  const resp = JSON.stringify({
    overallCapRate: { value: 0.06, sourceQuote: 'the subject is 6.00%' },
    currentOccupancyPhysical: { value: 0.9063, sourceQuote: 'is 90.63% occupied' },
  });
  const r = parseAppraisalLlmResponse(resp, DOC);
  eq(r.overallCapRate, 0.06, 'cap rate already-fraction stays 0.06');
  eq(r.currentOccupancyPhysical, 0.9063, 'occupancy already-fraction stays 0.9063');
}

console.log('\nCite-or-discard — a fabricated (un-citeable) quote is DISCARDED → null:');
{
  const resp = JSON.stringify({
    asIsValue: { value: 99_000_000, sourceQuote: 'the value is $99,000,000' }, // NOT in DOC
    overallCapRate: { value: 6.00, sourceQuote: 'the subject is 6.00%' },      // in DOC
  });
  const r = parseAppraisalLlmResponse(resp, DOC);
  eq(r.asIsValue, null, 'fabricated asIsValue discarded (quote not in doc)');
  eq(r.overallCapRate, 0.06, 'grounded cap rate survives');
  const t = r.traces.find((x) => x.field === 'asIsValue');
  assert(t !== undefined && t.cited === false, 'trace records the discard (cited=false)');
}

console.log('\nNull-not-fabricate — a value with no quote is dropped:');
{
  const resp = JSON.stringify({ asIsValue: { value: 6_575_000, sourceQuote: null } });
  const r = parseAppraisalLlmResponse(resp, DOC);
  eq(r.asIsValue, null, 'value without a sourceQuote → null (never fabricate)');
}

console.log('\nMalformed LLM output → all null (fail-safe), never throws:');
{
  const r = parseAppraisalLlmResponse('not json at all', DOC);
  eq(r.asIsValue, null, 'malformed → asIsValue null');
  eq(r.overallCapRate, null, 'malformed → cap null');
}

/* ---- Runner: cache + credit gate + fail-safe ----------------------------- */
(async () => {
  console.log('\nRunner — cache: first call hits LLM, second is $0 from cache:');
  {
    const cache = new InMemoryAppraisalLlmCache();
    let calls = 0;
    const stub: AppraisalLlmCall = async () => { calls++; return goodResponse(); };
    const r1 = await extractCbreAppraisalLlm(DOC, 'hashA', { llmCall: stub, creditsAvailable: () => true, cache });
    eq(r1.asIsValue, 6_575_000, 'first call extracts');
    eq(r1.llmCalled, true, 'first call made a live call');
    eq(r1.fromCache, false, 'first call not from cache');
    const r2 = await extractCbreAppraisalLlm(DOC, 'hashA', { llmCall: stub, creditsAvailable: () => true, cache });
    eq(r2.asIsValue, 6_575_000, 'second call same value');
    eq(r2.fromCache, true, 'second call from cache');
    eq(r2.llmCalled, false, 'second call made NO live call ($0)');
    eq(calls, 1, 'exactly one LLM call across two invocations (cache by docHash+version)');
  }

  console.log('\nRunner — credit gate: no credits → NO call, all null:');
  {
    let calls = 0;
    const stub: AppraisalLlmCall = async () => { calls++; return goodResponse(); };
    const r = await extractCbreAppraisalLlm(DOC, 'hashB', { llmCall: stub, creditsAvailable: () => false });
    eq(r.asIsValue, null, 'no credits → null');
    eq(calls, 0, 'no credits → LLM NOT called ($0)');
    eq(r.llmCalled, false, 'llmCalled false');
  }

  console.log('\nRunner — fail-safe: LLM throws → all null, never crashes:');
  {
    const stub: AppraisalLlmCall = async () => { throw new Error('simulated LLM failure'); };
    const r = await extractCbreAppraisalLlm(DOC, 'hashC', { llmCall: stub, creditsAvailable: () => true });
    eq(r.asIsValue, null, 'LLM error → asIsValue null');
    eq(r.overallCapRate, null, 'LLM error → cap null');
  }

  /* ---- Adapter merge: regex WINS where present; LLM fills nulls ----------- */
  console.log('\nAdapter — LLM fallback fires when regex misses core; REGEX WINS on overlap:');
  {
    // Regex returns a PARTIAL record: asIsValue present (regex extracted it) but
    // cap rate + occupancy + stabilized NOI null → fallback fires to fill them.
    const regexPartial = {
      asIsValue: 120_000_000,            // regex got this — must NOT be overwritten
      asStabilizedValue: null,
      overallCapRate: null,
      terminalCapRate: null,
      currentOccupancyPhysical: null,
      yearBuilt: null,
      city: null, state: null, interestAppraised: null, methodology: null,
      netRentableArea: 100_000,
      stabilizedProForma: { netOperatingIncome: null } as never,
      valueConclusion: 120_000_000, capRate: null,
    } as unknown as AppraisalExtraction;

    const stub: AppraisalLlmCall = async () => JSON.stringify({
      asIsValue: { value: 6_575_000, sourceQuote: 'Leased Fee Interest January 18, 2024 $6,575,000' }, // different — regex must win
      overallCapRate: { value: 6.00, sourceQuote: 'the subject is 6.00%' },
      stabilizedNoi: { value: 394_500, sourceQuote: 'net operating income of $394,500' },
      currentOccupancyPhysical: { value: 90.63, sourceQuote: 'is 90.63% occupied' },
    });

    const outcome = await runAppraisalAdapter(
      { buffer: Buffer.from('fake'), filename: 'appr.pdf' } as never,
      {
        extractCbreAppraisal: async () => regexPartial,
        loadAppraisalText: async () => DOC,
        appraisalLlm: { llmCall: stub, creditsAvailable: () => true },
      } as never,
    );
    assert(outcome.status === 'ok', 'adapter status ok');
    const v = (outcome as { value: AppraisalExtraction }).value;
    eq(v.asIsValue, 120_000_000, 'REGEX WINS: asIsValue stays the regex 120M (LLM 6.575M NOT applied)');
    eq(v.overallCapRate, 0.06, 'LLM FILLS: cap rate 0.06 (regex was null)');
    eq(v.currentOccupancyPhysical, 0.9063, 'LLM FILLS: occupancy 0.9063 (regex was null)');
    eq(v.stabilizedProForma?.netOperatingIncome ?? null, 394_500, 'LLM FILLS: stabilized NOI (regex was null)');
  }

  console.log('\nAdapter — regex core COMPLETE → LLM never fires (free fast path):');
  {
    const regexComplete = {
      asIsValue: 122_000_000, overallCapRate: 0.063, currentOccupancyPhysical: 0.468,
      netRentableArea: 274_758, yearBuilt: 2008,
      stabilizedProForma: { netOperatingIncome: 8_603_831 } as never,
      valueConclusion: 122_000_000, capRate: 0.063,
    } as unknown as AppraisalExtraction;
    let calls = 0;
    const stub: AppraisalLlmCall = async () => { calls++; return '{}'; };
    const outcome = await runAppraisalAdapter(
      { buffer: Buffer.from('fake'), filename: 'appr.pdf' } as never,
      {
        extractCbreAppraisal: async () => regexComplete,
        loadAppraisalText: async () => DOC,
        appraisalLlm: { llmCall: stub, creditsAvailable: () => true },
      } as never,
    );
    assert(outcome.status === 'ok', 'adapter status ok');
    eq(calls, 0, 'regex core complete → LLM NOT called (Sunroad free path preserved)');
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} appraisal-llm: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });

void (null as unknown as SourceDocumentKind);

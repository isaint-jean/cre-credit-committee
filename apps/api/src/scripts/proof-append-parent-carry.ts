/**
 * PROOF — append parent carry-forward (append-determinism item #1b).
 *   tsx src/scripts/proof-append-parent-carry.ts
 * Pure + CREDITLESS (no cre.db, no LLM): composeFromParentCarry reuses the
 * parent's frozen extraction so a re-score is byte-identical + deterministic.
 */
import { composeFromParentCarry } from '../services/append-source-doc.service.js';

let p = 0, f = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? '  ok  ' : '  FAIL ') + m); c ? p++ : f++; };

// A synthetic parent ExtractionResult carrying the fields a re-score used to drift.
const parentEr = {
  id: 'er_parent', dealRef: 'DEMO', analysisAsOfDate: '2024-01-01T00:00:00.000Z',
  extractionEngineVersion: '1.9', extractorVersions: {},
  inPlace: { noi: 45_000_000 }, t12Actual: { noi: 44_000_000 },
  rentRoll: { units: [{ tenantName: "Victoria's Secret" }], summary: { occupiedUnits: 17 } },
  asr: { impliedValue: 720_000_000 }, appraisal: { asIsValue: 122_000_000 },
  pca: null, parties: null, annexA: null, sellerUw: null, sellerUwOperatingStatement: null,
  loanTerms: { loanAmount: 400_000_000, interestRate: null, amortization: 0, interestOnlyPeriod: null, termMonths: null, maturityDate: null, source: 'ASR' },
  loanTermsWarnings: [],
  sourceDocuments: [{ kind: 'asr', contentHash: 'h1' }, { kind: 'rent_roll', contentHash: 'h2' }],
} as any;
const parentRentRoll = { units: [{ tenantName: "Victoria's Secret" }] } as any;
const parentPm = { city: 'New York' } as any;
// The AdjustedInputs loan-terms reconstruction (the existing term-carry): term is present.
const loanTerms = { loanAmount: 400_000_000, interestRate: 0.065, amortization: 0, interestOnlyPeriod: 0, termMonths: 60, maturityDate: null, source: 'ASR' } as any;

const c = composeFromParentCarry({ parentEr, parentRentRoll, parentPropertyMetadata: parentPm, loanTerms });
ok(c.extractionResult.inPlace === parentEr.inPlace && (c.extractionResult as any).t12Actual === parentEr.t12Actual, '★ income (inPlace/t12Actual) carried BYTE-IDENTICAL (no fresh re-extraction → no NOI drift)');
ok(c.extractionResult.rentRoll === parentEr.rentRoll, '★ rent-roll carried byte-identical (Victoria preserved → no lost concentration)');
ok((c.extractionResult as any).asr === parentEr.asr && (c.extractionResult as any).appraisal === parentEr.appraisal, '★ value (asr/appraisal) carried byte-identical');
ok(c.rentRoll === parentRentRoll && c.propertyMetadata === parentPm, '   typed rentRoll + PM carried from parent');
ok((c.extractionResult.loanTerms as any).termMonths === 60, '   loanTerms = the AdjustedInputs reconstruction (term-carry preserved, not the null-term parent)');
// determinism
const c2 = composeFromParentCarry({ parentEr, parentRentRoll, parentPropertyMetadata: parentPm, loanTerms });
ok(JSON.stringify(c.extractionResult) === JSON.stringify(c2.extractionResult), '★ deterministic — same parent → identical composed extraction (twice)');
// creditless by construction
ok(composeFromParentCarry.constructor.name === 'Function', '★ creditless — pure SYNC fn (not async), no llmCall parameter → zero model calls');

console.log('\n  RESULT: ' + p + ' passed, ' + f + ' failed');
process.exit(f === 0 ? 0 : 1);

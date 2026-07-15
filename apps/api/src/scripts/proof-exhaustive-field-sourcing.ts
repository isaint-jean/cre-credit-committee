/**
 * PROOF — exhaustive field sourcing safeguards (deterministic, no live LLM).
 *   tsx src/scripts/proof-exhaustive-field-sourcing.ts
 *
 * Exercises the cite-or-discard / cache / credit-gate / fail-safe chain off a
 * stubbed LLM seam + synthetic docs. The LIVE cross-doc behaviour (finding
 * environmental status in the ESA, NOI in the cash flow, GSA-not-applicable) is
 * proven separately against 640's real documents.
 */
import {
  sourceOneField,
  InMemoryExhaustiveSourcingCache,
  type DealDocText,
  type FieldQuery,
  type ExhaustiveLlmCall,
} from '../services/exhaustive-field-sourcing.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? '  ok  ' : '  FAIL ') + m); c ? pass++ : fail++; };

const DOCS: DealDocText[] = [
  { docType: 'phase_i_esa', fileName: 'ESA.pdf', fileHash: 'h_esa', text: 'Section 1.0 Conclusions. This assessment identified no evidence of recognized environmental conditions (RECs) at the subject property.' },
  { docType: 'cf', fileName: 'T12.xlsx', fileHash: 'h_cf', text: 'Operating Statement TTM. Net Operating Income 53799654. Total Operating Expenses 19449959.' },
];
const DSH = 'dsh-fixed';
const Q = (id: string): FieldQuery => ({ id, field: id, hint: id, keywords: [], preferDocTypes: [] });
const stub = (obj: object): ExhaustiveLlmCall => async () => JSON.stringify(obj);
const deps = (llmCall: ExhaustiveLlmCall, cache = new InMemoryExhaustiveSourcingCache(), credits = true) =>
  ({ llmCall, cache, creditsAvailable: () => credits });

(async () => {
  // 1 — found + quote present in a doc → populated, cited to that doc.
  const r1 = await sourceOneField(Q('environmental_status'), DOCS, DSH,
    deps(stub({ found: true, value: 'No RECs identified', sourceQuote: 'no evidence of recognized environmental conditions', docName: 'ESA.pdf' })));
  ok(r1.found && r1.searched && r1.docName === 'ESA.pdf', '★ found + citeable quote → found=true, cited to ESA.pdf (got ' + JSON.stringify([r1.found, r1.docName]) + ')');

  // 2 — CITE-OR-DISCARD: quote NOT present in any doc → discarded → EARNED blank.
  const r2 = await sourceOneField(Q('in_place_noi'), DOCS, DSH,
    deps(stub({ found: true, value: '$99,999,999', sourceQuote: 'a figure that is not in any document', docName: 'T12.xlsx' })));
  ok(!r2.found && r2.searched, '★ un-citeable quote → DISCARDED (found=false) but searched=true (earned blank; got ' + JSON.stringify([r2.found, r2.searched]) + ')');

  // 3 — CACHE replay: 2nd call with the SAME cache → no LLM, searched=false.
  const sharedCache = new InMemoryExhaustiveSourcingCache();
  let calls = 0;
  const counting: ExhaustiveLlmCall = async (o) => { calls++; return stub({ found: true, value: 'NOI', sourceQuote: 'Net Operating Income 53799654', docName: 'T12.xlsx' })(o); };
  const c1 = await sourceOneField(Q('in_place_noi'), DOCS, DSH, deps(counting, sharedCache));
  const c2 = await sourceOneField(Q('in_place_noi'), DOCS, DSH, deps(counting, sharedCache));
  ok(c1.found && c1.searched && c2.found && !c2.searched && calls === 1, '★ CACHE: 1st searches (calls=1), 2nd replays $0 (searched=false; calls=' + calls + ')');

  // 4 — NO CREDITS → skipped without a call; NOT a searched blank (searched=false).
  const r4 = await sourceOneField(Q('opex'), DOCS, DSH, deps(stub({ found: true, sourceQuote: 'Total Operating Expenses 19449959', docName: 'T12.xlsx' }), new InMemoryExhaustiveSourcingCache(), false));
  ok(!r4.found && !r4.searched, '★ no credits → skipped, found=false + searched=false (no false blank claim; got ' + JSON.stringify([r4.found, r4.searched]) + ')');

  // 5 — LLM throws → FAIL-SAFE (found=false, searched=false, never crashes).
  const thrower: ExhaustiveLlmCall = async () => { throw new Error('boom'); };
  const r5 = await sourceOneField(Q('gpr'), DOCS, DSH, deps(thrower));
  ok(!r5.found && !r5.searched, '★ LLM error → fail-safe found=false, no crash (got ' + JSON.stringify([r5.found, r5.searched]) + ')');

  console.log('\n  RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();

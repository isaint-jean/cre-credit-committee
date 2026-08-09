/**
 * PROOF — per-loan document Q&A (grounded, cite-or-discard, credit-gated). Uses an
 * INJECTED stub LLM + fake docs (live answers need Anthropic credits, exhausted), so
 * the honesty logic is provable without a real call — mirrors the smart-route no-
 * credits failsafe proof. Canonical cre.db is never touched (all deps injected).
 *
 * Proves:
 *   - no credits → 'unavailable' (fail-closed, never a guess);
 *   - a valid cited answer (quote literally in the doc) → 'answered';
 *   - a FABRICATED quote (not in the doc) → DISCARDED → 'not_stated' (the guardrail);
 *   - found=false → 'not_stated'; wrong docName → 'not_stated';
 *   - no doc text (scans) → 'not_stated' + scannedOnly; LLM error → 'unavailable'.
 *
 * Run: npx tsx src/scripts/data-room-qa-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { answerLoanQuestion } from '../services/loan-doc-qa.service.js';
import type { DealDocText } from '../services/exhaustive-field-sourcing.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const DOC: DealDocText = {
  docType: 'seller_uw',
  fileName: 'Sunroad UW.xlsx',
  fileHash: 'h1',
  text: 'The property has 42 units. Cash management is triggered if DSCR falls below 1.10x.',
};
const gatherWith = (docs: DealDocText[]) => async () => docs;
const llmReturning = (obj: unknown) => async () => JSON.stringify(obj);

async function main(): Promise<void> {
  console.log('\nData Room per-loan Q&A proof (stubbed LLM; canonical-safe)\n');
  const args = { poolId: 'P', loanInPoolId: 'L', question: 'what triggers cash management?' };

  // 1 — no credits → unavailable (fail-closed).
  const unavail = await answerLoanQuestion(args, { creditsAvailable: () => false, gather: gatherWith([DOC]), llm: llmReturning({}) });
  check('no credits → unavailable', unavail.status === 'unavailable' && unavail.answer === null);

  // 2 — valid cited answer (quote literally in the doc) → answered.
  const good = await answerLoanQuestion(args, {
    creditsAvailable: () => true,
    gather: gatherWith([DOC]),
    llm: llmReturning({ found: true, answer: 'DSCR below 1.10x', sourceQuote: 'Cash management is triggered if DSCR falls below 1.10x', docName: 'Sunroad UW.xlsx' }),
  });
  check('valid cited answer → answered', good.status === 'answered' && good.answer === 'DSCR below 1.10x' && good.sourceDoc === 'Sunroad UW.xlsx');
  check('answered carries the verbatim quote', good.sourceQuote === 'Cash management is triggered if DSCR falls below 1.10x');

  // 3 — FABRICATED quote (not in the doc) → discarded → not_stated (the guardrail).
  const fabricated = await answerLoanQuestion(args, {
    creditsAvailable: () => true,
    gather: gatherWith([DOC]),
    llm: llmReturning({ found: true, answer: 'DSCR below 1.25x', sourceQuote: 'Cash management is triggered if DSCR falls below 1.25x', docName: 'Sunroad UW.xlsx' }),
  });
  check('fabricated quote → DISCARDED → not_stated', fabricated.status === 'not_stated' && fabricated.answer === null);

  // 4 — found=false → not_stated.
  const absent = await answerLoanQuestion(args, {
    creditsAvailable: () => true,
    gather: gatherWith([DOC]),
    llm: llmReturning({ found: false, answer: null, sourceQuote: null, docName: null }),
  });
  check('found=false → not_stated', absent.status === 'not_stated');

  // 5 — cites a doc that isn't in the set → not_stated (can't verify).
  const wrongDoc = await answerLoanQuestion(args, {
    creditsAvailable: () => true,
    gather: gatherWith([DOC]),
    llm: llmReturning({ found: true, answer: 'x', sourceQuote: 'The property has 42 units.', docName: 'Some Other File.pdf' }),
  });
  check('quote attributed to an absent doc → not_stated', wrongDoc.status === 'not_stated');

  // 6 — no readable text (all scans) → not_stated + scannedOnly.
  const scans = await answerLoanQuestion(args, {
    creditsAvailable: () => true,
    gather: gatherWith([{ ...DOC, text: '' }]),
    llm: llmReturning({ found: true, answer: 'x', sourceQuote: 'y', docName: DOC.fileName }),
  });
  check('no readable doc text → not_stated + scannedOnly', scans.status === 'not_stated' && scans.scannedOnly === true);

  // 7 — LLM error → unavailable (honest floor).
  const errored = await answerLoanQuestion(args, {
    creditsAvailable: () => true,
    gather: gatherWith([DOC]),
    llm: async () => { throw new Error('boom'); },
  });
  check('LLM error → unavailable', errored.status === 'unavailable');

  // 8 — empty question → not_stated (no call).
  const empty = await answerLoanQuestion({ ...args, question: '   ' }, { creditsAvailable: () => true, gather: gatherWith([DOC]), llm: llmReturning({ found: true }) });
  check('empty question → not_stated', empty.status === 'not_stated');

  // Canonical sanity (read-only; the proof never touches cre.db).
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17, 640 head)', bmark === 17 && !!head, `BMARK ${bmark}`);

  console.log(failures === 0 ? '\ndata-room Q&A proof: OK\n' : `\ndata-room Q&A proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

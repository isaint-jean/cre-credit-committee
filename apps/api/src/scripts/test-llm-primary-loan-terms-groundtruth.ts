/**
 * GROUND-TRUTH HARNESS — LLM-primary loan-terms extraction.
 * (P1: whole-loan-gated loanAmount. THIS EXTENSION: full 5-term set —
 *  loanAmount + termMonths + maturityDate + coupon + amortization/IO — clearing
 *  the JE_TERM_MONTHS_MISSING gate P1 left open.)
 *
 *   tsx src/scripts/test-llm-primary-loan-terms-groundtruth.ts
 *
 * Proves the compose (de-anchor + LLM fallback + whole/piece) and the four
 * determinism safeguards (cite-or-discard, caching, null-not-fabricate, temp-0)
 * against KNOWN answers on the two real ASRs, read-only from the real cre.db
 * blob store. The real cre.db is NEVER written; no revision is minted.
 *
 * DUAL-MODE. Credit-fluctuation-aware: LIVE Sonnet proofs when credits are
 * available (real number-transcription accuracy); the LOGIC proofs
 * (cite-or-discard, caching, no-credits fail-safe, whole-not-piece) always run
 * off the INJECTABLE seam with fixture LLM outputs so they are deterministic and
 * free regardless of credit state. Each proof's mode is printed.
 *
 * GROUND TRUTH (from the ASR text — see recon):
 *   - Sunroad (MS ASR): loanAmount = $82,460,000, extracted by the FREE
 *     deterministic regex (MS anchor present) — the LLM never fires.
 *   - 640 (BMO/MS Summary-of-Terms ASR): the regex finds no anchor → null → the
 *     LLM fallback reads the WHOLE loan = $400,000,000 (the lender "is pleased
 *     to present a $400,000,000 ... loan", "fully comprised of a $300.0MM senior
 *     mortgage note and a $100.0MM mezzanine note"). The "$57,000,000" in that
 *     ASR is "Minimum UNOI" — an NOI COVENANT, not a loan piece: the whole-vs-
 *     piece trap. Gate on $400M; never on $57M / $300M.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtractionResult } from '@cre/contracts';
import { parseDocument } from '../services/document-parser.service.js';
import { runAsrAdapter, DEFAULT_ASR_DEPS } from '../services/extraction/adapters/asr.adapter.js';
import type { AsrAdapterDeps } from '../services/extraction/adapters/asr.adapter.js';
import type { SlotInput } from '../services/extraction/extractor-outcome.js';
import type { ExtractAsrLoanTermsLlmDeps } from '../services/extract-asr-loan-terms-llm.js';
import {
  extractAsrLoanTermsLlm,
  parseLoanTermsLlmResponse,
  InMemoryLoanTermsLlmCache,
  ASR_LOAN_TERMS_LLM_VERSION,
  type LoanTermsLlmCall,
} from '../services/extract-asr-loan-terms-llm.js';
import { buildLoanAmount, buildTermMonths } from '../services/judgment/line-item-builders.js';
import { termPhraseToMonths } from '../services/extract-asr-loan-terms-llm.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEq<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const BLOBS = path.join(process.cwd(), '.data', 'blobs');
const SUNROAD = '505ac5b1701f0f951254dbc45e51d2c6ebfd809e343b35fccd5d5fd84c46ac05';
const P640 = 'c8fb5726bfa602e9006f354aa385d87a21be027dfeb74784a699530cd1b41b96';

function blobPath(hash: string): string {
  return path.join(BLOBS, hash.slice(0, 2), `${hash}.bin`);
}
function readBlob(hash: string): Buffer {
  return readFileSync(blobPath(hash));
}
function slotFor(hash: string, filename: string): SlotInput {
  return { buffer: readBlob(hash), filename } as SlotInput;
}

/** Minimal ExtractionResult carrying only what buildLoanAmount reads. */
function extractionWith(loanTerms: ExtractionResult['loanTerms']): ExtractionResult {
  return { loanTerms } as unknown as ExtractionResult;
}

/** True iff buildLoanAmount produced a value (i.e. did NOT throw the fail-closed
 *  JE_LOAN_AMOUNT_MISSING). Returns the resolved loan amount or throws. */
function underwriteLoanAmount(loanTerms: ExtractionResult['loanTerms']): number {
  const li = buildLoanAmount({ extraction: extractionWith(loanTerms) });
  return li.adjusted;
}

/** Runs buildTermMonths — throws JE_TERM_MONTHS_MISSING if neither a maturity
 *  date nor an explicit termMonths reaches the engine. Returns the adjusted
 *  term (months). analysisAsOfDate is threaded so the maturity-date path
 *  (maturityDate − asOf) can compute; the explicit-term path ignores it. */
function underwriteTermMonths(loanTerms: ExtractionResult['loanTerms'], analysisAsOfDate: string): number {
  const extraction = { loanTerms, analysisAsOfDate } as unknown as ExtractionResult;
  const li = buildTermMonths({ extraction, analysisAsOfDate });
  return li.adjusted;
}

const AS_OF = '2024-06-11T00:00:00.000Z'; // 640's analysis-as-of (funded RAP date)

/** Adapter deps = defaults + injected loan-terms-LLM deps. */
function depsWith(loanTermsLlm: ExtractAsrLoanTermsLlmDeps): AsrAdapterDeps {
  return { ...DEFAULT_ASR_DEPS, loanTermsLlm };
}

const anthropicKeyPresent = (process.env['ANTHROPIC_API_KEY'] ?? '').trim().length > 0;

async function main(): Promise<void> {
  console.log('=================================================================');
  console.log('LLM-PRIMARY LOAN-TERMS GROUND-TRUTH HARNESS');
  console.log(`credits: ${anthropicKeyPresent ? 'LIVE (real Sonnet where noted)' : 'OUT (fixture-only)'}`);
  console.log('=================================================================\n');

  /* ============================================================= *
   * PROOF 1 — SUNROAD: exact $82,460,000 via the FREE regex path  *
   * ============================================================= */
  console.log('PROOF 1 — Sunroad exact $82.46M (deterministic regex path, no LLM):');
  {
    // A throwing LLM seam PROVES the regex path did not touch the LLM: if the
    // adapter had fallen through to the LLM, this stub would throw.
    const throwingLlm: LoanTermsLlmCall = async () => { throw new Error('LLM must NOT be called for Sunroad'); };
    const outcome = await runAsrAdapter(
      slotFor(SUNROAD, 'Sunroad Centrum - ASR FINAL.pdf'),
    );
    assertEq(outcome.status, 'ok', '1.1 Sunroad adapter status ok');
    const lt = outcome.status === 'ok' ? outcome.value.loanTerms : null;
    assertEq(lt?.loanAmount ?? null, 82_460_000, '1.2 Sunroad loanAmount EXACT $82,460,000');
    assertEq(lt?.source ?? null, 'ASR', "1.3 Sunroad source tagged 'ASR' (regex path)");
    const piece = outcome.status === 'ok' ? outcome.value.loanAmountTrustPiece : 'n/a';
    assertEq(piece, null, '1.4 Sunroad loanAmountTrustPiece null (whole loan, regex path leaves piece null)');
    // Prove the free path: run the adapter with a THROWING LLM seam; if the
    // regex satisfied the gate, the throwing seam is never reached → ok.
    const outcome2 = await runAsrAdapter(
      slotFor(SUNROAD, 'Sunroad Centrum - ASR FINAL.pdf'),
      depsWith({ llmCall: throwingLlm, creditsAvailable: () => true }),
    );
    assertEq(outcome2.status, 'ok', '1.5 Sunroad resolves with a THROWING LLM seam injected → regex is the free path (LLM never called)');
    const lt2 = outcome2.status === 'ok' ? outcome2.value.loanTerms : null;
    assertEq(lt2?.loanAmount ?? null, 82_460_000, '1.6 Sunroad still EXACT $82.46M with throwing LLM seam (mode: DETERMINISTIC regex, $0)');
    // And it underwrites (buildLoanAmount does not throw).
    let threw = false; let amt = NaN;
    try { amt = underwriteLoanAmount(lt2); } catch { threw = true; }
    assert(!threw, '1.7 Sunroad reaches engine: buildLoanAmount did NOT throw JE_LOAN_AMOUNT_MISSING');
    assertEq(amt, 82_460_000, '1.8 Sunroad engine loanAmount = $82,460,000');

    // ★★ NO REGRESSION — ALL Sunroad loan terms unchanged via the regex path.
    assertEq(lt2?.interestRate ?? null, 0.0791, '1.9 Sunroad coupon 7.91% unchanged (regex)');
    assertEq(lt2?.amortization ?? null, 0, '1.10 Sunroad amortization 0 unchanged (regex)');
    assertEq(lt2?.interestOnlyPeriod ?? null, 60, '1.11 Sunroad IO 60mo unchanged (regex)');
    assertEq(lt2?.maturityDate ?? null, '2029-05-06T00:00:00.000Z', '1.12 Sunroad maturityDate 2029-05-06 unchanged (regex)');
    assertEq(lt2?.termMonths ?? null, null, '1.13 Sunroad termMonths absent (regex path uses maturityDate; termMonths is LLM-path-only)');
    // ★ Sunroad's termMonths still resolves via the maturityDate − asOf path (the
    //   PRIMARY path is untouched — the explicit-term fallback is additive).
    let termThrew = false; let sunTerm = NaN;
    // 2024-05-06 → 2029-05-06 = 60 months.
    try { sunTerm = underwriteTermMonths(lt2, '2024-05-06T00:00:00.000Z'); } catch { termThrew = true; }
    assert(!termThrew, '1.14 Sunroad reaches engine: buildTermMonths did NOT throw (maturityDate path, unchanged)');
    assertEq(sunTerm, 60, '1.15 Sunroad engine termMonths = 60 (maturityDate − asOf, primary path)');
  }

  /* ============================================================= *
   * PROOF 2 — 640: WHOLE loan $400M via LLM fallback → underwrites *
   * ============================================================= */
  console.log('\nPROOF 2 — 640 WHOLE loan $400M via LLM fallback → underwrites (temp/in-memory, real cre.db untouched):');
  {
    // Real Sonnet when live; else a fixture stub replaying the exact structured
    // output Sonnet returns for 640 (verbatim quotes copied from the ASR text).
    const p640Text = (await parseDocument(readBlob(P640), '640.pdf', 'application/pdf')).rawText;
    const wholeQuote = 'Morgan Stanley (the “Lender”) is pleased to present a $400,000,000, 5-year, fixed rate, interest-only loan';
    const fixture640: string = JSON.stringify({
      loanAmountWhole: { value: 400000000, sourceQuote: wholeQuote },
      loanAmountTrustPiece: { value: 300000000, sourceQuote: 'a $300.0MM senior mortgage note' },
      // "fixed rate" with NO numeric rate → coupon honestly null.
      coupon: { value: null, sourceQuote: null },
      // "interest-only loan" → full-term IO → amortization 0.
      amortizationMonths: { value: 0, sourceQuote: 'interest-only loan' },
      interestOnlyMonths: { value: null, sourceQuote: null },
      // ★ the loan TERM stated verbatim ("5-year") in the same sentence.
      termPhrase: { value: '5-year', sourceQuote: wholeQuote },
      // 640's ASR states NO loan origination/note date (the only date is the
      // appraisal "effective 3/15/24") → origination null → maturity NOT derived.
      originationDate: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const mode = anthropicKeyPresent ? 'REAL SONNET' : 'FIXTURE';
    const cache = new InMemoryLoanTermsLlmCache();
    const fixtureLlm: LoanTermsLlmCall = async () => fixture640;
    const llmDeps: ExtractAsrLoanTermsLlmDeps = anthropicKeyPresent
      ? { cache }                                   // live seam, real credit gate
      : { cache, llmCall: fixtureLlm, creditsAvailable: () => true };

    const outcome = await runAsrAdapter(
      slotFor(P640, '640 Fifth Ave - Funded RAP (2024-06-11).pdf'),
      depsWith(llmDeps),
    );
    console.log(`  (mode: ${mode})`);
    assertEq(outcome.status, 'ok', '2.1 640 adapter status ok');
    const lt = outcome.status === 'ok' ? outcome.value.loanTerms : null;
    assert(lt !== null, '2.2 640 loanTerms NON-null (regex would have been null — LLM fallback fired)');
    assertEq(lt?.loanAmount ?? null, 400_000_000, '2.3 640 gating loanAmount = WHOLE $400,000,000');
    assertEq(lt?.source ?? null, 'ASR', "2.4 640 source tagged 'ASR'");
    // Traceability: the whole-loan quote is literally in the doc.
    assert(
      p640Text.replace(/\s+/g, ' ').toLowerCase().includes('is pleased to present a $400,000,000'),
      '2.5 640 whole-loan quote is verbatim-present in the ASR text (traceable, not fabricated)',
    );
    // ★ UNDERWRITES: buildLoanAmount no longer throws.
    let threw = false; let amt = NaN;
    try { amt = underwriteLoanAmount(lt); } catch { threw = true; }
    assert(!threw, '2.6 640 reaches engine: buildLoanAmount did NOT throw JE_LOAN_AMOUNT_MISSING');
    assertEq(amt, 400_000_000, '2.7 640 engine gating loanAmount = $400,000,000 (WHOLE)');

    // ★★ THE 5-TERM + GATE PROOF runs off the FIXTURE (deterministic, credit-
    // independent — the harness's own discipline: LOGIC proofs use the injectable
    // seam so they replay identically). The fixture quotes are VERBATIM-verified
    // against the real 640 doc below (2.14), so this is grounded, not invented.
    const cache2 = new InMemoryLoanTermsLlmCache();
    const outcomeFix = await runAsrAdapter(
      slotFor(P640, '640 Fifth Ave - Funded RAP (2024-06-11).pdf'),
      depsWith({ cache: cache2, llmCall: fixtureLlm, creditsAvailable: () => true }),
    );
    const ltF = outcomeFix.status === 'ok' ? outcomeFix.value.loanTerms : null;
    assert(ltF !== null, '2.8 640 (fixture) loanTerms NON-null');
    // ★★ ALL FIVE TERMS present on the LoanTermsExtraction, each honestly.
    assertEq(ltF?.loanAmount ?? null, 400_000_000, '2.9 640 loanAmount = WHOLE $400M');
    assertEq(ltF?.termMonths ?? null, 60, '2.10 640 termMonths = 60 (from cited "5-year")');
    assertEq(ltF?.amortization ?? null, 0, '2.11 640 amortization = 0 (interest-only, cited)');
    assertEq(ltF?.interestRate ?? null, null, '2.12 640 coupon null ("fixed rate" has no numeric rate — honest null-not-fabricate)');
    assertEq(ltF?.maturityDate ?? null, null, '2.13 640 maturityDate null (no maturity/origination date in ASR — not fabricated)');
    // ★★ THE MAIN GATE: buildTermMonths no longer throws JE_TERM_MONTHS_MISSING.
    let termThrew = false; let term = NaN;
    try { term = underwriteTermMonths(ltF, AS_OF); } catch { termThrew = true; }
    assert(!termThrew, '2.14 ★★ 640 reaches engine: buildTermMonths did NOT throw JE_TERM_MONTHS_MISSING (the gate P1 left open)');
    assertEq(term, 60, '2.15 640 engine termMonths = 60 (explicit-term fallback, no maturity date needed)');

    // Verify every FIXTURE quote is verbatim-present in the real doc (grounding).
    const docNorm = p640Text.replace(/\s+/g, ' ').toLowerCase();
    assert(docNorm.includes('is pleased to present a $400,000,000, 5-year, fixed rate, interest-only loan'),
      '2.16 640 whole-loan+"5-year" quote is verbatim-present in the ASR (fixture grounded, not fabricated)');
    assert(docNorm.includes('interest-only loan'),
      '2.17 640 "interest-only loan" quote verbatim-present (amortization=0 grounded)');
  }

  /* ============================================================= *
   * PROOF 3 — WHOLE-not-PIECE: gate on $400M, never $57M/$300M     *
   * ============================================================= */
  console.log('\nPROOF 3 — whole-not-piece (fixture, deterministic):');
  {
    const p640Text = (await parseDocument(readBlob(P640), '640.pdf', 'application/pdf')).rawText;
    // Fixture where the model correctly labels whole=400M, piece=300M(senior).
    const resp = JSON.stringify({
      loanAmountWhole: { value: 400000000, sourceQuote: 'present a $400,000,000, 5-year, fixed rate, interest-only loan' },
      loanAmountTrustPiece: { value: 300000000, sourceQuote: 'a $300.0MM senior mortgage note' },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const r = parseLoanTermsLlmResponse(resp, p640Text);
    assertEq(r.loanTerms?.loanAmount ?? null, 400_000_000, '3.1 gating loanAmount is the WHOLE $400M');
    assertEq(r.loanAmountTrustPiece, 300_000_000, '3.2 piece ($300M senior) held on the SEPARATE labeled field, not gating');
    assert((r.loanTerms?.loanAmount ?? 0) !== r.loanAmountTrustPiece, '3.3 gating amount ≠ piece amount (piece never masquerades as whole)');

    // Adversarial: a model that returns ONLY a piece (whole null) must NOT
    // promote the piece — engine refuses (hold-to-null).
    const pieceOnly = JSON.stringify({
      loanAmountWhole: { value: null, sourceQuote: null },
      loanAmountTrustPiece: { value: 300000000, sourceQuote: 'a $300.0MM senior mortgage note' },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const r2 = parseLoanTermsLlmResponse(pieceOnly, p640Text);
    assertEq(r2.loanTerms, null, '3.4 piece-only (whole null) → loanTerms null (whole-not-piece: engine refuses, piece NOT promoted)');
    assert(r2.warnings.some((w) => /whole-not-piece/i.test(w)), '3.5 whole-not-piece HOLD surfaced as a data-quality warning');
  }

  /* ============================================================= *
   * PROOF 4 — CITE-OR-DISCARD: un-citeable value → null           *
   * ============================================================= */
  console.log('\nPROOF 4 — cite-or-discard (fixture, deterministic):');
  {
    const docText = 'The loan amount is $250,000,000 per the term sheet. Coupon: 6.50%.';
    // Fabricated loan amount ($999M) with a quote that is NOT in the doc.
    const fabricated = JSON.stringify({
      loanAmountWhole: { value: 999000000, sourceQuote: 'the whole loan is $999,000,000' },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: 6.5, sourceQuote: 'Coupon: 6.50%' },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const r = parseLoanTermsLlmResponse(fabricated, docText);
    assertEq(r.loanTerms?.loanAmount ?? null, null, '4.1 un-citeable $999M DISCARDED → loanAmount null (no fabrication reaches engine)');
    assertEq(r.loanTerms?.interestRate ?? null, 0.065, '4.2 citeable coupon 6.50% survives (quote present in doc)');
    const t = r.traces.find((x) => x.field === 'loanAmountWhole');
    assertEq(t?.cited ?? true, false, '4.3 trace records loanAmountWhole as NOT cited (discarded)');

    // Truly-grounded value passes.
    const grounded = JSON.stringify({
      loanAmountWhole: { value: 250000000, sourceQuote: 'The loan amount is $250,000,000' },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const r2 = parseLoanTermsLlmResponse(grounded, docText);
    assertEq(r2.loanTerms?.loanAmount ?? null, 250_000_000, '4.4 grounded $250M (verbatim quote present) survives');
  }

  /* ============================================================= *
   * PROOF 5 — null-not-fabricate: genuinely-absent field → null   *
   * ============================================================= */
  console.log('\nPROOF 5 — null-not-fabricate (fixture, deterministic):');
  {
    const docText = 'A commercial mortgage. No amounts stated here.';
    const allNull = JSON.stringify({
      loanAmountWhole: { value: null, sourceQuote: null },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const r = parseLoanTermsLlmResponse(allNull, docText);
    assertEq(r.loanTerms, null, '5.1 all-null → loanTerms null');
    // And a null loanAmount makes the engine refuse.
    let threw = false;
    try { underwriteLoanAmount(null); } catch { threw = true; }
    assert(threw, '5.2 null loanTerms → buildLoanAmount THROWS JE_LOAN_AMOUNT_MISSING (honest floor holds)');
    // ★ null-not-fabricate for TERM: an absent term → termMonths null → the
    // engine refuses termMonths honestly (JE_TERM_MONTHS_MISSING).
    let termThrew = false;
    try { underwriteTermMonths({ loanAmount: 1, interestRate: null, amortization: null, interestOnlyPeriod: null, termMonths: null, maturityDate: null, source: 'ASR' } as ExtractionResult['loanTerms'], AS_OF); } catch { termThrew = true; }
    assert(termThrew, '5.3 termMonths null + no maturity → buildTermMonths THROWS JE_TERM_MONTHS_MISSING (honest floor holds)');
  }

  /* ============================================================= *
   * PROOF 5T — termMonths normalization + maturity derivation +   *
   *            term cite-or-discard (fixture, deterministic)      *
   * ============================================================= */
  console.log('\nPROOF 5T — termMonths normalization / derivation / cite-or-discard (fixture, deterministic):');
  {
    // (a) DETERMINISTIC NORMALIZATION — the module converts the phrase, not the LLM.
    assertEq(termPhraseToMonths('5-year'), 60, '5T.1 "5-year" → 60');
    assertEq(termPhraseToMonths('60-month'), 60, '5T.2 "60-month" → 60');
    assertEq(termPhraseToMonths('ten year'), 120, '5T.3 "ten year" → 120');
    assertEq(termPhraseToMonths('10 yr'), 120, '5T.4 "10 yr" → 120');
    assertEq(termPhraseToMonths('84 mos'), 84, '5T.5 "84 mos" → 84');
    assertEq(termPhraseToMonths('fixed rate'), null, '5T.6 "fixed rate" (no tenor) → null');

    // (b) CITE-OR-DISCARD for the term: a quote that does NOT contain the term
    //     phrase is DISCARDED (term must be pinned to the sentence stating it).
    const docText = 'The loan is a 7-year facility with a balloon. Coupon: 6.50%.';
    const misCited = JSON.stringify({
      loanAmountWhole: { value: null, sourceQuote: null },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: 6.5, sourceQuote: 'Coupon: 6.50%' },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      // term claims "5-year" but cites a quote that says "Coupon: 6.50%" — the
      // quote is in the doc but does NOT state the term → discard.
      termPhrase: { value: '5-year', sourceQuote: 'Coupon: 6.50%' },
      originationDate: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const rMis = parseLoanTermsLlmResponse(misCited, docText);
    assertEq(rMis.loanTerms?.termMonths ?? null, null, '5T.7 term quote that does NOT contain the term phrase → termMonths DISCARDED to null');
    assertEq(rMis.loanTerms?.interestRate ?? null, 0.065, '5T.8 (unrelated) coupon still survives its own valid citation');

    // A properly-cited term (quote contains "7-year") survives.
    const wellCited = JSON.stringify({
      loanAmountWhole: { value: null, sourceQuote: null },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      termPhrase: { value: '7-year', sourceQuote: 'The loan is a 7-year facility' },
      originationDate: { value: null, sourceQuote: null },
      maturityDate: { value: null, sourceQuote: null },
    });
    const rWell = parseLoanTermsLlmResponse(wellCited, docText);
    assertEq(rWell.loanTerms?.termMonths ?? null, 84, '5T.9 well-cited "7-year" (quote states it) → termMonths 84');

    // (c) MATURITY DERIVATION — origination + term when no maturity stated.
    const derivDoc = 'Note Date: 6/1/2024. The loan has a 5-year term.';
    const deriv = JSON.stringify({
      loanAmountWhole: { value: null, sourceQuote: null },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      termPhrase: { value: '5-year', sourceQuote: 'a 5-year term' },
      originationDate: { value: '6/1/2024', sourceQuote: 'Note Date: 6/1/2024' },
      maturityDate: { value: null, sourceQuote: null },
    });
    const rDeriv = parseLoanTermsLlmResponse(deriv, derivDoc);
    assertEq(rDeriv.loanTerms?.termMonths ?? null, 60, '5T.10 term 60 survives');
    assertEq(rDeriv.loanTerms?.maturityDate ?? null, '2029-06-01T00:00:00.000Z', '5T.11 maturityDate DERIVED = origination 6/1/2024 + 60mo = 6/1/2029');
    assert(rDeriv.warnings.some((w) => /derived/i.test(w)), '5T.12 derivation surfaced as a data-quality warning');

    // (d) A STATED maturity date WINS over derivation.
    const statedDoc = 'Note Date: 6/1/2024. Maturity Date: 12/1/2030. 5-year term.';
    const stated = JSON.stringify({
      loanAmountWhole: { value: null, sourceQuote: null },
      loanAmountTrustPiece: { value: null, sourceQuote: null },
      coupon: { value: null, sourceQuote: null },
      amortizationMonths: { value: null, sourceQuote: null },
      interestOnlyMonths: { value: null, sourceQuote: null },
      termPhrase: { value: '5-year', sourceQuote: '5-year term' },
      originationDate: { value: '6/1/2024', sourceQuote: 'Note Date: 6/1/2024' },
      maturityDate: { value: '12/1/2030', sourceQuote: 'Maturity Date: 12/1/2030' },
    });
    const rStated = parseLoanTermsLlmResponse(stated, statedDoc);
    assertEq(rStated.loanTerms?.maturityDate ?? null, '2030-12-01T00:00:00.000Z', '5T.13 explicitly-stated maturity date WINS over origination+term derivation');
  }

  /* ============================================================= *
   * PROOF 6 — CACHING: 2nd extract of same doc-version → $0        *
   * ============================================================= */
  console.log('\nPROOF 6 — caching: extract-once-per-doc-version, re-underwrite is $0 (fixture seam counts calls):');
  {
    const docText = 'Loan Amount: $123,456,000 whole.';
    let calls = 0;
    const countingLlm: LoanTermsLlmCall = async () => {
      calls++;
      return JSON.stringify({
        loanAmountWhole: { value: 123456000, sourceQuote: 'Loan Amount: $123,456,000' },
        loanAmountTrustPiece: { value: null, sourceQuote: null },
        coupon: { value: null, sourceQuote: null },
        amortizationMonths: { value: null, sourceQuote: null },
        interestOnlyMonths: { value: null, sourceQuote: null },
        maturityDate: { value: null, sourceQuote: null },
      });
    };
    const cache = new InMemoryLoanTermsLlmCache();
    const docHash = 'deadbeef'.repeat(8);
    const deps = { cache, llmCall: countingLlm, creditsAvailable: () => true };

    const first = await extractAsrLoanTermsLlm(docText, docHash, deps);
    assertEq(first.llmCalled, true, '6.1 first extract → LLM called (llmCalled=true)');
    assertEq(first.fromCache, false, '6.2 first extract → not from cache');
    assertEq(first.loanTerms?.loanAmount ?? null, 123_456_000, '6.3 first extract value correct');
    assertEq(calls, 1, '6.4 exactly ONE LLM call so far');

    const second = await extractAsrLoanTermsLlm(docText, docHash, deps);
    assertEq(second.fromCache, true, '6.5 second extract (same docHash+version) → fromCache=true');
    assertEq(second.llmCalled, false, '6.6 second extract → NO LLM call ($0)');
    assertEq(calls, 1, '6.7 call count STILL 1 (cache short-circuited the 2nd call)');
    assertEq(second.loanTerms?.loanAmount ?? null, 123_456_000, '6.8 cached value byte-identical to first (deterministic re-read)');

    // Version bump busts the cache (clean re-extract).
    const third = await extractAsrLoanTermsLlm(docText, docHash, { ...deps, extractorVersion: '9.9.9' });
    assertEq(third.llmCalled, true, '6.9 extractorVersion bump → cache MISS → LLM called (clean re-extract)');
    assertEq(calls, 2, '6.10 call count now 2 (version-busted)');

    // ★ CONCRETE version bump: this extension changed the SCHEMA (5 terms) so the
    //   module version moved 1.0.0 → 2.0.0, which busts any stored P1
    //   loan-amount-only cache entry (an old '1.0.0' key never HITs for the new
    //   default version). Simulate: seed a '1.0.0' entry, extract at the current
    //   (2.0.0) default → MISS → LLM re-called (5-term re-extract).
    assertEq(ASR_LOAN_TERMS_LLM_VERSION, '2.0.0', '6.11 module version bumped to 2.0.0 (schema changed: 5 terms)');
    const cache2 = new InMemoryLoanTermsLlmCache();
    // Pretend a P1 (1.0.0) run stored a loan-amount-only result for this doc.
    cache2.put(docHash, '1.0.0', {
      loanTerms: { loanAmount: 123456000, interestRate: null, amortization: null, interestOnlyPeriod: null, maturityDate: null, source: 'ASR' },
      loanAmountTrustPiece: null, traces: [], warnings: [], fromCache: false, llmCalled: false,
    });
    let v2calls = 0;
    const v2Llm: LoanTermsLlmCall = async () => {
      v2calls++;
      return JSON.stringify({
        loanAmountWhole: { value: 123456000, sourceQuote: 'Loan Amount: $123,456,000' },
        loanAmountTrustPiece: { value: null, sourceQuote: null },
        coupon: { value: null, sourceQuote: null },
        amortizationMonths: { value: null, sourceQuote: null },
        interestOnlyMonths: { value: null, sourceQuote: null },
        termPhrase: { value: null, sourceQuote: null },
        originationDate: { value: null, sourceQuote: null },
        maturityDate: { value: null, sourceQuote: null },
      });
    };
    // Default version (2.0.0) → the 1.0.0 entry is a MISS → re-extract.
    const busted = await extractAsrLoanTermsLlm(docText, docHash, { cache: cache2, llmCall: v2Llm, creditsAvailable: () => true });
    assertEq(busted.fromCache, false, '6.12 P1 (1.0.0) cache entry does NOT hit under 2.0.0 → cache MISS');
    assertEq(busted.llmCalled, true, '6.13 → clean re-extract under the new schema (LLM called)');
    assertEq(v2calls, 1, '6.14 exactly one re-extract call (old loan-amount-only entry busted)');
    // And the SECOND 2.0.0 extract now hits the freshly-stored 2.0.0 entry ($0).
    const busted2 = await extractAsrLoanTermsLlm(docText, docHash, { cache: cache2, llmCall: v2Llm, creditsAvailable: () => true });
    assertEq(busted2.fromCache, true, '6.15 2nd 2.0.0 extract → fromCache=true (new-version entry now stored)');
    assertEq(v2calls, 1, '6.16 call count still 1 (2.0.0 entry served from cache, $0)');
  }

  /* ============================================================= *
   * PROOF 7 — no-credits fail-safe: null → honest refusal         *
   * ============================================================= */
  console.log('\nPROOF 7 — no-credits fail-safe (fixture, deterministic):');
  {
    const docText = 'Loan Amount: $500,000,000.';
    let calls = 0;
    const llm: LoanTermsLlmCall = async () => { calls++; return '{}'; };
    // creditsAvailable() → false ⇒ the call is skipped entirely.
    const r = await extractAsrLoanTermsLlm(docText, 'x'.repeat(64), {
      llmCall: llm,
      creditsAvailable: () => false,
    });
    assertEq(r.loanTerms, null, '7.1 no credits → loanTerms null (honest floor)');
    assertEq(r.llmCalled, false, '7.2 no credits → NO LLM call (credit-gated, $0)');
    assertEq(calls, 0, '7.3 LLM seam never invoked when credits out');
    // Fail-safe on LLM error: a throwing seam → null, never crashes.
    const throwing: LoanTermsLlmCall = async () => { throw new Error('boom'); };
    const r2 = await extractAsrLoanTermsLlm(docText, 'y'.repeat(64), {
      llmCall: throwing,
      creditsAvailable: () => true,
    });
    assertEq(r2.loanTerms, null, '7.4 LLM error → loanTerms null (fail-safe, never crashes, never fabricates)');
  }

  /* ============================================================= *
   * PROOF 8 — LIVE Sonnet on both ASRs (only when credits live)   *
   * ============================================================= */
  console.log('\nPROOF 8 — LIVE Sonnet real extraction on both ASRs:');
  if (!anthropicKeyPresent) {
    console.log('  (SKIPPED — credits OUT; logic proven above via fixtures)');
  } else {
    // 640 via real Sonnet (no cache → forces a real call).
    const p640Text = (await parseDocument(readBlob(P640), '640.pdf', 'application/pdf')).rawText;
    const p640Hash = P640;
    const live640 = await extractAsrLoanTermsLlm(p640Text, p640Hash, {}); // real seam, real credit gate, no cache
    console.log(`  [live 640] loanAmount(whole)=${live640.loanTerms?.loanAmount}, piece=${live640.loanAmountTrustPiece}, llmCalled=${live640.llmCalled}`);
    for (const t of live640.traces) console.log(`     trace ${t.field}: cited=${t.cited} quote=${t.sourceQuote ? '"' + t.sourceQuote.slice(0, 70) + '"' : 'null'}`);
    assertEq(live640.llmCalled, true, '8.1 [live] 640 made a real Sonnet call');
    assertEq(live640.loanTerms?.loanAmount ?? null, 400_000_000, '8.2 [live] 640 WHOLE loan = $400,000,000 (real Sonnet, temp 0)');
    assert(
      live640.loanAmountTrustPiece === null || live640.loanAmountTrustPiece < 400_000_000,
      '8.3 [live] 640 piece (if any) is a strict sub-slice of the whole (never the $57M Minimum-UNOI covenant as gating)',
    );
    assert(
      (live640.loanTerms?.loanAmount ?? 0) !== 57_000_000,
      '8.4 [live] 640 gating amount is NOT the $57M Minimum UNOI covenant (whole-not-piece trap avoided)',
    );
    // ★ [live] TERM: real Sonnet extracts the 640 term ("5-year" / "Five (5) Year")
    //   → termMonths 60 → the engine clears JE_TERM_MONTHS_MISSING on real output.
    console.log(`  [live 640] termMonths=${live640.loanTerms?.termMonths}, maturityDate=${live640.loanTerms?.maturityDate}`);
    assertEq(live640.loanTerms?.termMonths ?? null, 60, '8.5 [live] 640 termMonths = 60 (real Sonnet cites the 5-year term; normalizer robust to "Five (5) Year")');
    let liveTermThrew = false; let liveTerm = NaN;
    try { liveTerm = underwriteTermMonths(live640.loanTerms, AS_OF); } catch { liveTermThrew = true; }
    assert(!liveTermThrew, '8.6 [live] 640 buildTermMonths did NOT throw JE_TERM_MONTHS_MISSING on REAL Sonnet output');
    assertEq(liveTerm, 60, '8.7 [live] 640 engine termMonths = 60 on real output');

    // Sunroad via real Sonnet DIRECTLY on the LLM extractor (bypassing the regex
    // fast-path) to confirm the LLM ALSO reads the exact number when asked.
    const sunText = (await parseDocument(readBlob(SUNROAD), 'sunroad.pdf', 'application/pdf')).rawText;
    const liveSun = await extractAsrLoanTermsLlm(sunText, SUNROAD, {});
    console.log(`  [live Sunroad-LLM] loanAmount=${liveSun.loanTerms?.loanAmount}`);
    assertEq(liveSun.loanTerms?.loanAmount ?? null, 82_460_000, '8.8 [live] Sunroad LLM ALSO reads EXACT $82,460,000 (corroborates the regex; in prod the regex fast-path wins first, $0)');
  }

  console.log(`\n=================================================================`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('=================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS THREW:', e); process.exit(1); });

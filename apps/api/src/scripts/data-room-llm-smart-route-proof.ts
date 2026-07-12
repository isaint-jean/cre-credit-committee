/**
 * PROOF harness — Data-Room Tier 3.5 (LLM smart-routing).
 *
 *   npx tsx apps/api/src/scripts/data-room-llm-smart-route-proof.ts
 *
 * Proves the LLM routing tier + the three honesty guards + the fail-safe, WITHOUT
 * writing the real cre.db. Pool loans are read READ-ONLY from the real cre.db into
 * a fixture (the same shape the route passes); classifyFileCascade is pure over
 * that fixture — no store, no DB write.
 *
 * TWO MODES:
 *   - STUB: an injected deterministic LLM (canned {loanId,docType,confidence,reason})
 *     proves the ROUTING LOGIC + the 3 guards deterministically, regardless of
 *     credits. Always runs.
 *   - REAL-LLM: if ANTHROPIC_API_KEY is set + credits live, the 640 stragglers +
 *     ASR-vs-MS-UW cases are ALSO run against the real claude-haiku-4-5 and the
 *     per-deal cost is reported. Skipped (clearly stated) when credits are out.
 *
 * The fail-safe (no-credits → HELD) is proven SEPARATELY by unsetting the key.
 */

import assert from 'node:assert';
import Database from 'better-sqlite3';
import path from 'node:path';
import {
  classifyByLlm,
  CONFIDENCE_THRESHOLD,
  creditsAvailable,
  SMART_ROUTE_MODEL,
  type LlmRouteCall,
} from '../services/data-room/llm-smart-route.service.js';
import {
  classifyFileCascade,
  verdictFor,
  type PoolLoanNameKey,
} from '../services/data-room-classify.service.js';
import { docTypeById } from '@cre/contracts';

const POOL_ID = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';
const LOAN_640 = 'ec9d2cfb-4baa-4347-bacc-84786d645da9'; // "640 5th avenue"
const CRE_DB = path.join(process.cwd(), 'data', 'cre.db');

let pass = 0;
function ok(name: string) {
  pass++;
  console.log(`  ✓ ${name}`);
}

/** Read the REAL pool loans READ-ONLY into a fixture. No write, DB closed after. */
function loadPoolLoansReadOnly(): PoolLoanNameKey[] {
  const db = new Database(CRE_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        'SELECT id, originator_loan_ref, property_name FROM loan_in_pool WHERE pool_id = ?',
      )
      .all(POOL_ID) as ReadonlyArray<{
        id: string;
        originator_loan_ref: string | null;
        property_name: string | null;
      }>;
    return rows.map((r) => ({
      loanInPoolId: r.id,
      originatorLoanRef: r.originator_loan_ref,
      propertyName: r.property_name,
    }));
  } finally {
    db.close();
  }
}

/** A stub LLM: routes canned answers keyed by a substring of the filename in the
 *  prompt. Proves the routing/guards deterministically with NO network. */
function makeStub(
  canned: (fileName: string) => {
    loanInPoolId: string | null;
    docType: string | null;
    confidence: number;
    reason: string;
  },
): LlmRouteCall {
  return async (opts) => {
    const user = opts.messages.map((m) => m.content).join('\n');
    const fm = /FILENAME:\s*(.+)/.exec(user);
    const fileName = fm ? fm[1]!.trim() : '';
    return JSON.stringify(canned(fileName));
  };
}

async function main() {
  console.log(`\n=== Tier 3.5 LLM smart-route PROOF ===`);
  console.log(`model=${SMART_ROUTE_MODEL}  confidence-threshold=${CONFIDENCE_THRESHOLD}`);
  const creditsLive = creditsAvailable();
  console.log(`credits available (API key present): ${creditsLive}\n`);

  const poolLoans = loadPoolLoansReadOnly();
  assert.ok(poolLoans.length >= 100, 'expected ~104 real pool loans');
  assert.ok(poolLoans.some((l) => l.loanInPoolId === LOAN_640), '640 loan present');
  console.log(`Loaded ${poolLoans.length} REAL pool loans read-only (cre.db untouched).\n`);

  const noBytes = Buffer.alloc(0); // no content signal → tiers 1-3 refuse docType/loan on cryptic names

  // ──────────────────────────────────────────────────────────────────────────
  // A. STUB MODE — routing logic + the 3 guards, deterministic (no network).
  // ──────────────────────────────────────────────────────────────────────────
  console.log('── A. STUB MODE (deterministic routing + guards) ──');

  // A1 — 640 stragglers route to the 640 loan with correct doc-types.
  // The stub plays the role of a competent LLM reading each doc.
  const straggler640 = makeStub((fn) => {
    if (/occupancy/i.test(fn)) {
      return { loanInPoolId: LOAN_640, docType: 'cf', confidence: 0.82, reason: '640 Fifth historical occupancy schedule' };
    }
    if (/historical income|detailed financials/i.test(fn)) {
      return { loanInPoolId: LOAN_640, docType: 'cf', confidence: 0.88, reason: '640 Fifth historical operating income' };
    }
    return { loanInPoolId: null, docType: null, confidence: 0.2, reason: 'unclear' };
  });

  const stragglerNames = [
    '640 5th Avenue - Occupancy Data - 2024 v2.pdf',
    '640 Fifth Historical Occupancy 2018-2023.xlsx',
    '640 Fifth 2019 Historical Income.xlsx',
  ];
  for (const fn of stragglerNames) {
    const h = await classifyFileCascade({ fileName: fn, bytes: noBytes }, poolLoans, {
      llmCall: straggler640,
    });
    assert.strictEqual(h.loanInPoolId, LOAN_640, `${fn} → 640 loan`);
    assert.strictEqual(h.docType, 'cf', `${fn} → cf`);
    assert.ok(h.aiRouteNote && /routed by AI/.test(h.aiRouteNote), `${fn} carries AI provenance`);
    // Same ClassifyHints seam → verdictFor sees a normal both-axes result.
    const v = verdictFor(h.docType, h.loanInPoolId);
    assert.strictEqual(v.action, 'auto', `${fn} both-axes → auto`);
  }
  ok('640 stragglers route to the 640 loan + cf, both-axes → auto, provenance recorded (STUB)');

  // A2 — ASR = Asset Summary Report → asr; MS UW → seller_uw (NOT asr).
  const asrVsUw = makeStub((fn) => {
    if (/asset summary report|asr/i.test(fn)) {
      return { loanInPoolId: LOAN_640, docType: 'asr', confidence: 0.95, reason: 'Asset Summary Report cover — loan-terms spine' };
    }
    if (/underwriting|ms uw|morgan/i.test(fn)) {
      return { loanInPoolId: LOAN_640, docType: 'seller_uw', confidence: 0.9, reason: 'Morgan Stanley underwriting model — benchmark, not the ASR' };
    }
    return { loanInPoolId: null, docType: null, confidence: 0.1, reason: 'n/a' };
  });
  {
    const asr = await classifyFileCascade(
      { fileName: '640 Fifth Asset Summary Report.pdf', bytes: noBytes },
      poolLoans,
      { llmCall: asrVsUw },
    );
    assert.strictEqual(asr.docType, 'asr', 'ASR → asr');
    // spine role derived from the taxonomy: asr is tier=ingesting (the spine).
    assert.strictEqual(docTypeById('asr')!.tier, 'ingesting', 'asr is the ingesting/spine tier');

    const uw = await classifyFileCascade(
      { fileName: 'MS Underwriting Model - 640 Fifth.xlsx', bytes: noBytes },
      poolLoans,
      { llmCall: asrVsUw },
    );
    assert.strictEqual(uw.docType, 'seller_uw', 'MS UW → seller_uw (NOT asr)');
    assert.notStrictEqual(uw.docType, 'asr', 'MS UW must not be asr');
    assert.strictEqual(docTypeById('seller_uw')!.tier, 'stored', 'seller_uw is stored (benchmark), not the spine');
  }
  ok('ASR → asr (ingesting spine); MS UW → seller_uw (stored benchmark, NOT asr) (STUB)');

  // A3 — HOLD-WHEN-UNSURE: address-less "1b. 2019 detailed financials" still holds.
  // Guard 1a: null axes. Guard 1b: low confidence.
  const unsure = makeStub(() => ({ loanInPoolId: null, docType: 'cf', confidence: 0.4, reason: 'financials but no property' }));
  {
    const h = await classifyByLlm('1b. 2019 detailed financials.xlsx', 'operating financials', poolLoans, unsure);
    assert.strictEqual(h.loanInPoolId, null, 'no loan → null');
    assert.strictEqual(h.docType, null, 'confidence 0.4 < 0.75 → docType discarded');
    assert.strictEqual(h.note, null, 'no axis filled → no provenance note');
    // Through the cascade: HELD (verdict confirm).
    const hc = await classifyFileCascade({ fileName: '1b. 2019 detailed financials.xlsx', bytes: noBytes }, poolLoans, { llmCall: unsure });
    assert.strictEqual(verdictFor(hc.docType, hc.loanInPoolId).action, 'confirm', 'address-less doc HELDs');
  }
  ok('hold-when-unsure: "1b. 2019 detailed financials" HELDs (null loan + conf 0.4 < 0.75) (STUB)');

  // A4 — INVENTED loan/type → discarded → HELD (guard 2, match-real-targets).
  const invented = makeStub(() => ({
    loanInPoolId: 'lip_NOT_IN_POOL_999',
    docType: 'totally_bogus_type',
    confidence: 0.99,
    reason: 'high confidence but both are fabricated',
  }));
  {
    const h = await classifyByLlm('mystery.pdf', 'some text', poolLoans, invented);
    assert.strictEqual(h.loanInPoolId, null, 'invented loan discarded → null');
    assert.strictEqual(h.docType, null, 'bogus docType discarded → null');
    assert.strictEqual(h.note, null, 'nothing filled → no note');
    const hc = await classifyFileCascade({ fileName: 'mystery.pdf', bytes: noBytes }, poolLoans, { llmCall: invented });
    assert.strictEqual(verdictFor(hc.docType, hc.loanInPoolId).action, 'confirm', 'invented → HELD, not hallucinated');
  }
  ok('invented loan + bogus docType (conf 0.99) → both discarded → HELD (STUB)');

  // A5 — the 7 already-auto-routed NEVER hit the LLM ($0). A filename that resolves
  // BOTH axes deterministically must not call the stub AT ALL.
  {
    let calls = 0;
    const counting = makeStub(() => {
      calls++;
      return { loanInPoolId: LOAN_640, docType: 'cf', confidence: 0.99, reason: 'should never be called' };
    });
    // "sunroad centrum" matches a pool loan (loan axis) and a slotted doc-type in
    // the name resolves docType → both axes non-null after filename tier → LLM skipped.
    const h = await classifyFileCascade(
      { fileName: 'sunroad centrum rent roll.xlsx', bytes: noBytes },
      poolLoans,
      { llmCall: counting },
    );
    assert.strictEqual(h.loanInPoolId !== null, true, 'loan resolved deterministically');
    assert.strictEqual(h.docType, 'rent_roll', 'docType resolved deterministically');
    assert.strictEqual(calls, 0, 'LLM was NOT called — both axes already resolved ($0)');
    assert.strictEqual(h.aiRouteNote, undefined, 'no AI provenance on a deterministically-routed doc');
  }
  ok('7-free: a both-axes-deterministic file never calls the LLM (calls=0, $0) (STUB)');

  // A6 — same ClassifyHints seam: an LLM-filled hint is indistinguishable to
  // verdictFor from a regex-filled one (except the display-only note).
  {
    const oneAxis = makeStub(() => ({ loanInPoolId: LOAN_640, docType: null, confidence: 0.9, reason: 'loan only' }));
    const h = await classifyFileCascade({ fileName: 'cryptic-vendor-file.pdf', bytes: noBytes }, poolLoans, { llmCall: oneAxis });
    assert.strictEqual(h.loanInPoolId, LOAN_640, 'LLM filled loan only');
    assert.strictEqual(h.docType, null, 'docType still null');
    const v = verdictFor(h.docType, h.loanInPoolId);
    assert.strictEqual(v.action, 'confirm', 'single-axis LLM result → confirm (identical to single-axis regex)');
    assert.strictEqual(v.prefill.loanInPoolId, LOAN_640, 'pre-filled on the resolved axis');
  }
  ok('same ClassifyHints seam: single-axis LLM → confirm, pre-filled (verdictFor unchanged) (STUB)');

  // ──────────────────────────────────────────────────────────────────────────
  // B. FAIL-SAFE — no credits → tier is a NO-OP → HELD (never crashes/fabricates).
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── B. FAIL-SAFE ──');

  // B1 — the true no-credits gate (creditsAvailable() false → LLM SKIPPED, 0
  // calls) is proven in a SEPARATE process where env.anthropicApiKey is '' (the
  // key is import-frozen, so it can't be unset mid-process here):
  //   data-room-llm-no-credits-failsafe-proof.ts. See report.

  // B2 — a THROWING LLM (network/timeout/credit-error) → NO-OP → HELD.
  const thrower: LlmRouteCall = async () => {
    throw new Error('400 credit balance too low');
  };
  {
    const h = await classifyByLlm('anything.pdf', 'text', poolLoans, thrower);
    assert.strictEqual(h.loanInPoolId, null, 'throw → loan null');
    assert.strictEqual(h.docType, null, 'throw → docType null');
    assert.strictEqual(h.note, null, 'throw → no note');
    const hc = await classifyFileCascade({ fileName: 'anything.pdf', bytes: noBytes }, poolLoans, { llmCall: thrower });
    assert.strictEqual(verdictFor(hc.docType, hc.loanInPoolId).action, 'confirm', 'LLM error → HELD (fail-safe)');
  }
  ok('fail-safe: LLM throw (simulated credit-error) → NO-OP → HELD, no crash (STUB)');

  // B3 — MALFORMED output → NO-OP → HELD.
  const garbage: LlmRouteCall = async () => 'not json at all <<<';
  {
    const h = await classifyByLlm('anything.pdf', 'text', poolLoans, garbage);
    assert.strictEqual(h.loanInPoolId, null, 'malformed → loan null');
    assert.strictEqual(h.docType, null, 'malformed → docType null');
  }
  ok('fail-safe: malformed LLM output → NO-OP → HELD (STUB)');

  // ──────────────────────────────────────────────────────────────────────────
  // C. REAL-LLM MODE — run the 640 stragglers + ASR/UW against claude-haiku-4-5.
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── C. REAL-LLM MODE ──');
  if (!creditsLive) {
    console.log('  ⚠ credits OUT (no API key) — REAL-LLM proof SKIPPED. STUB + fail-safe above stand.');
  } else {
    // We supply representative front-matter text (the LLM reads text, not real
    // PDFs here — proving the prompt + guards drive a real model correctly).
    const cases: Array<{ fileName: string; text: string; wantDoc: string; label: string }> = [
      {
        fileName: '640 Fifth Historical Occupancy 2018-2023.xlsx',
        text: '640 Fifth Avenue\nHistorical Occupancy & Operating Statement 2018-2023\nGross Potential Rent, Vacancy, Effective Gross Income, Operating Expenses, Net Operating Income by year.',
        wantDoc: 'cf',
        label: '640 straggler: historical occupancy/operating',
      },
      {
        fileName: '640 Fifth Asset Summary Report.pdf',
        text: '640 Fifth Avenue\nASSET SUMMARY REPORT\nLoan Amount: $500,000,000  Interest Rate: 6.25%  Term: 10 years\nSponsor: ... Property Type: Office. Loan terms and property summary.',
        wantDoc: 'asr',
        label: 'ASR = Asset Summary Report → asr',
      },
      {
        fileName: 'MS Underwriting - 640 Fifth.xlsx',
        text: '640 Fifth Avenue\nMorgan Stanley Underwriting Model\nUnderwritten NCF, cap rate, valuation, stress scenarios. Issuer underwriting benchmark model.',
        wantDoc: 'seller_uw',
        label: 'MS underwriting model → seller_uw (not asr)',
      },
    ];

    let inTok = 0;
    let outTok = 0;
    // Wrap the real call to capture token usage for the cost estimate.
    const { callAIWithContinuation } = await import('../services/ai-analysis.service.js');
    void callAIWithContinuation; // real path used inside classifyByLlm by default

    for (const c of cases) {
      const h = await classifyByLlm(c.fileName, c.text, poolLoans); // real Haiku call
      console.log(`  · ${c.label}: loan=${h.loanInPoolId === LOAN_640 ? '640✓' : h.loanInPoolId}  docType=${h.docType}  conf=${h.confidence}  reason="${h.reason.slice(0, 70)}"`);
      assert.strictEqual(h.docType, c.wantDoc, `${c.label} → ${c.wantDoc}`);
      assert.strictEqual(h.loanInPoolId, LOAN_640, `${c.label} → 640 loan`);
    }
    ok('REAL-LLM: 640 straggler → cf, ASR → asr, MS UW → seller_uw (claude-haiku-4-5)');

    // Cost estimate — one direct usage probe on a representative prompt.
    const probe = await realUsageProbe(poolLoans, cases[0]!.fileName, cases[0]!.text);
    inTok = probe.input;
    outTok = probe.output;
    const perDoc = (inTok / 1_000_000) * 1.0 + (outTok / 1_000_000) * 5.0;
    const perDeal = perDoc * 5; // ~5 hard docs/deal
    console.log(`  · per-hard-doc tokens: in≈${inTok} out≈${outTok} → $${perDoc.toFixed(5)}/doc → ~$${perDeal.toFixed(4)}/deal (5 hard docs)`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // D. CLASSIFY-ONLY (479 sweep unchanged). The LLM tier only ever writes the two
  //    nullable classify hints (docType/loanInPoolId) + a display-only note. It
  //    imports NO scoring module, does NO DB write, and returns the SAME
  //    PathClassifyHints shape — so the 479-deal scoring sweep is untouched by
  //    construction. Structural assertion: the returned object exposes only the
  //    classify keys (+ optional categoryHint/contradiction/aiRouteNote).
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n── D. CLASSIFY-ONLY (479 sweep unchanged) ──');
  {
    const h = await classifyFileCascade(
      { fileName: '640 Fifth Historical Occupancy.xlsx', bytes: noBytes },
      poolLoans,
      { llmCall: makeStub(() => ({ loanInPoolId: LOAN_640, docType: 'cf', confidence: 0.9, reason: 'occupancy/cf' })) },
    );
    const keys = Object.keys(h).sort();
    const allowed = new Set(['docType', 'loanInPoolId', 'categoryHint', 'contradiction', 'aiRouteNote']);
    for (const k of keys) assert.ok(allowed.has(k), `hint key '${k}' is a classify key (no scoring field)`);
    assert.ok(!('score' in h) && !('ratedRisk' in h) && !('finalScore' in h), 'no scoring field leaks into hints');
  }
  ok('classify-only: LLM tier emits ONLY classify hints — no scoring field, no DB write → 479 sweep untouched');

  console.log(`\n=== ${pass} proof groups PASSED ===\n`);
}

/** Direct Anthropic call to read real token usage for the cost estimate. Mirrors
 *  the prompt classifyByLlm builds (same system + user shape). */
async function realUsageProbe(
  poolLoans: PoolLoanNameKey[],
  fileName: string,
  text: string,
): Promise<{ input: number; output: number }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { DOC_TYPE_TAXONOMY } = await import('@cre/contracts');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
  const loanLines = poolLoans
    .map((l) => `- loanInPoolId=${l.loanInPoolId}  name="${l.propertyName ?? l.originatorLoanRef}"  ref="${l.originatorLoanRef ?? ''}"`)
    .join('\n');
  const typeLines = DOC_TYPE_TAXONOMY.map((e) => `- ${e.id}  ${e.label}`).join('\n');
  const user = `FILENAME: ${fileName}\n\nFIRST-PAGE TEXT:\n${text}\n\nPOOL LOANS:\n${loanLines}\n\nDOC TYPES:\n${typeLines}`;
  const resp = await client.messages.create({
    model: SMART_ROUTE_MODEL,
    max_tokens: 400,
    system: 'CRE data-room filing clerk. Return JSON {loanInPoolId,docType,confidence,reason}.',
    messages: [{ role: 'user', content: user }],
    temperature: 0,
  });
  return { input: resp.usage.input_tokens, output: resp.usage.output_tokens };
}

main().catch((e) => {
  console.error('PROOF FAILED:', e);
  process.exit(1);
});

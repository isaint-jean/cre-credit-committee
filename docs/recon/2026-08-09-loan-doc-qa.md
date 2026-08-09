# Per-loan document Q&A — recon + build plan

**Date:** 2026-08-09
**Status:** PLAN + BUILT (a)+(b) credit-gated dark. Live answers need Anthropic credits (exhausted).

A buyer asks a question in the Verdict panel → answered from the LOAN's documents with a verbatim
citation, or "not stated in these documents" — NEVER guessed.

## 1. Document text is reachable — the gatherer already exists
`gatherDealDocTexts(poolId, loanInPoolId)` (`exhaustive-field-sourcing.ts:165`) returns the full text of
every doc for a loan (routed + held) as `{ docType, fileName, fileHash, text }[]`. PDFs parse via
`unpdf`, XLSX via `xlsx` (cell-addressed → citeable). **Caveat:** scanned/image-only PDFs have no text
layer → parse empty, skipped gracefully → facts only on scanned pages correctly come back "not stated".

## 2. Context size — handled by `excerptDoc`
`excerptDoc(text, keywords)` returns docs ≤90 KB whole; huge docs → head (28 KB) + keyword-windowed
excerpts, truncation flagged (never silent). The one new bit: derive keywords from the free-form question
(tokenize) to drive the windows.

## 3. Reuse — client + citation + honesty doctrine all exist
- LLM: `callAIWithContinuation({ model: CLAUDE_MODEL, temperature, system, messages, max_tokens })`
  (`ai-analysis.service.ts`), model `claude-sonnet-4-6`, one-shot.
- Citation: **cite-or-discard** — the model returns a verbatim `sourceQuote` + `docName`, and the code
  verifies the quote LITERALLY appears in that doc (whitespace-normalized via `normalizeWs`); if not →
  discard → not_stated. This is the hallucination guardrail, reused verbatim from field-sourcing.
- Honesty: mirror the field-sourcing system prompt ("answer ONLY if the docs literally state it; cite a
  short verbatim quote + which doc; else 'not stated in these documents'; NEVER infer/compute/guess").
- Credit gate: `env.anthropicApiKey` non-empty (same as the data-room smart-route). No credits → fail
  closed to `unavailable` (never a crash, never an ungrounded guess).

## 4. Build (this arc)
- **(a) `POST /pools/:poolId/loans/:loanInPoolId/ask { question }`** → `{ status, answer, sourceDoc,
  sourceQuote, scannedOnly }`, status ∈ `answered | not_stated | unavailable`. Flow: deal-access gate
  (pool param) → credit gate → gatherDealDocTexts → excerpt (question keywords) → one grounded
  temperature-0 call → cite-or-discard. Read-only, NO persistence.
- **(b)** an ask box in the Verdict/LoanAnalysisSummary panel (ephemeral result; cleared on close).

## 5. Honest flags
- **Credits exhausted** → ships dark: returns `unavailable` until the key has budget. Live answers can't
  be tested until then; the cite-or-discard + refusal logic IS unit-tested now with a stubbed LLM.
- **Hallucination risk** (chattiest surface) — mitigated by cite-or-discard (unverifiable quote dropped)
  + "not stated" refusal + temperature 0.
- **Image-only docs** can't be queried → a small "some documents are scans, not machine-readable" note so
  absence isn't mistaken for a gap.
- **Ephemeral by default** — no storage. Optional `doc_qa_log(loan, user, question, answer, sourceDoc,
  at)` deferred (opt-in engagement/audit data; default off).

# ASR provenance recon — is the real Asset Summary Report present, and what has the `asr` extractor been running on?

**Date:** 2026-08-10 · **Mode:** read-only recon (cre.db baseline, 640 head `221235987967` intact) · **Trigger:** concern that "Annual Statement of Rents" was mis-typed as `asr`, so the genuine Asset Summary Report might be missing and the `asr`-derived numbers (Sunroad NOI $9.29M / value $133M) might be garbage.

## Headline — the premise is inverted

The `asr` slot holds **genuine Asset Summary Reports** for both demo deals; the `asr`-derived numbers are **real and trustworthy**; there is **no "Annual Statement of Rents" file anywhere in the corpus**. The only actual defect is a **cosmetic mislabel** in the docType taxonomy (now fixed). No document needs re-sourcing.

## 1. What's actually in the `asr` slot (Sunroad / 640)

Direct `data_room_doc` read — the two `asr`-typed docs are genuine ASRs:

| deal | `asr`-slot file |
|---|---|
| Sunroad | `Sunroad Centrum - ASR FINAL.pdf` (final Asset Summary Report) |
| 640 5th Ave | `640 Fifth Ave - Funded ASR (2024-06-11).pdf` (Funded Asset Summary Report) |

Neither is a rent statement. 640's actual rent statement — `N064 - Rent Roll 4.29.24.PDF` — is correctly filed in the **`rent_roll`** slot, not `asr`. No rent statement is masquerading as an ASR.

## 2. Where the NOI / value numbers came from — trustworthy

Confirmed three independent ways:

- **Persisted provenance:** Sunroad's `ExtractionResult` carries `dealRef = "Sunroad Centrum (final ASR + appraisal)"`; the numbers reconcile to the **final** ASR:
  - Sunroad: `underwrittenNOI $9,294,609 · impliedValue $133M · S&U loanAmount $82.46M · loanPayoff $63.93M` (asr extractor v0.4.0)
  - 640: `underwrittenNOI $56.19M · impliedValue $720M · loanPayoff $500M` (asr extractor v0.5.0)
- **Content evidence:** `pdftotext` over the on-disk ASR PDF shows a **Goldman Sachs IBD offering document** — Sources & Uses table, Underwritten Cash Flows ladder, Kearny Mesa Sub-Market Overview, Phase-I environmental. **None of these sections can exist in a rent statement** (a bare tenant/rent ledger). That is the definitive tell.
- **Extractor design:** `apps/api/src/services/extract-asr.ts` parses exactly those ASR-only sections (S&U, environmental, sub-market, underwritten cash flows, borrower summary). It expects an Asset Summary Report and got one.

*(Version note: persisted extractions are from older adapter versions — Sunroad `asr` 0.4.0, 640 0.5.0; the current adapter is 0.7.0. A re-underwrite re-extracts from the same real PDFs — version drift, not a correctness issue.)*

## 3. Does a genuine Asset Summary Report exist? — YES, present, correctly slotted, ingested

Not missing, not mis-slotted, not un-ingested. Both deals have a real ASR in the `asr` slot with `ingest=1`, and both produced valid extractions. There has always been a real ASR here (older adapter versions + the "final ASR + appraisal" dealRef prove the canonical was minted from genuine ASRs).

## 4. Root cause — a mislabeled taxonomy entry (the only bug)

`packages/contracts/src/doctype-taxonomy.ts` defined:

```ts
{ id: 'asr', label: 'Annual Statement of Rents (ASR)', … slot: 'asr', engineInput: 'asrPdf' }
```

The **label was wrong.** The slot is the **Asset Summary Report**:

- classifier regex matches `ASR | Anticipated Sale Report | Acquisition Sale Report` (`packages/shared/src/utils/source-doc-classify.ts:156`) — not rent statements;
- the extractor parses Asset-Summary-Report sections.

The UI renders `docTypeById(id).label`, so this single string surfaced everywhere (tree category, verdict panel, the 📊 ASR toggle) as "Annual Statement of Rents" — which is exactly what made the `asr` slot look like it was for rent statements. **A naming defect, not a data defect.**

**Fix applied:** relabel `'asr'` → **"Asset Summary Report (ASR)"** (label only; `id`/`slot`/`engineInput`/`category`/classifier/extractor all unchanged — pure label, no behavior change).

## 5. Dependency — what underwriting would lose without a real ASR (it doesn't)

The ASR's load-bearing contribution is **loan terms** (loanAmount/rate/maturity) + **parties**. Missing loanAmount → `JE_LOAN_AMOUNT_MISSING` → the engine **refuses honestly**. The ASR's NOI / value / cash-flows are **not primary scoring inputs**:

- `underwrittenCashFlows` are explicitly *"Display/extraction only — NOT read by scoring"* (`packages/contracts/src/extraction.ts:633`);
- scoring's NOI cascade is `sellerUw ?? asr ?? t12 ?? in-place` — ASR NOI is a **fallback** behind seller-UW;
- value derivation reads the **appraisal**.

So the engine already degrades honestly without an ASR — but both ASRs are present, so none of that fires.

## Honest flag

- ✅ **The `asr`-derived numbers we've been showing are REAL. No re-sourcing needed.**
- ⚠️ Latent classifier risk (not currently triggered): the classifier matches the bare token "ASR" in a filename, so a file literally named "Annual Statement of Rents (ASR).pdf" *could* be pulled into this slot. No such file exists today; flag only.

## Optional follow-ups (Isabelle's call — NOT auto-applied; canonical untouched)

1. **Re-slot 640's "Funded RAP":** `640 Fifth Ave - Funded RAP (2024-06-11).pdf` is filed under **appraisal**, alongside the genuine `640 Fifth Avenue Amended Appraisal Report`. A RAP is a deal/rating summary, not an appraisal — arguably mis-slotted, but harmless (the real appraisal is present). Flagged; not auto-moved.
2. **640 appraisal-parse gap → separate ticket:** the CBRE-specific appraisal extractor didn't parse 640's amended-appraisal format, so 640's appraisal extraction is `null` (an extraction-coverage gap, not a missing doc). Worth its own ticket if 640's value card matters.

## Scope of the fix in this change

- Relabel `asr` docType → "Asset Summary Report (ASR)" (label only).
- File this recon.
- No id/slot/engineInput/classifier/extractor changes; canonical byte-identical (BMARK 17, 640 head `221235987967` intact).

/**
 * `COMMITTEE_MEMO_MANIFEST` — append-only registry of canonical-content
 * hashes per `CommitteeMemoVersion`.
 *
 * Mirrors the `MITIGATION_ENGINE_MANIFEST` pattern. Boot check
 * (`apps/api/src/util/committee-memo-boot-check.ts`) recomputes the
 * hash of the frozen committee-memo FORMAT snapshot at startup and
 * compares against the entry for `COMMITTEE_MEMO_VERSION`. If they
 * disagree, the api refuses to start with `COMMITTEE_MEMO_FORMAT_DRIFT`.
 *
 * The hashed state covers the memo's SHAPE only:
 *   - MEMO_SECTION_ORDER (the section render order)
 *   - MEMO_SECTION_HEADINGS (visible h2 strings)
 *   - MEMO_RESTRUCTURE_TITLES (cut vs hold variant section title)
 *   - MEMO_RESTRUCTURE_SUBHEADS (callout h3 strings)
 *   - MEMO_CALLOUT_LABELS (recommended-package headline labels)
 *   - MEMO_NULL_SENTINEL ('—' missing-data string)
 *
 * NOT covered (intentionally):
 *   - Per-deal numeric figures (the engines produce those; their
 *     manifests cover them).
 *   - LLM narrative prose (NARRATIVE_ENGINE_MANIFEST covers the
 *     prompt-template snapshot that shapes it).
 *   - CSS / styling (display layer, not document shape).
 *
 * Workflow when changing memo format:
 *   1. Edit apps/api/src/services/render-memo/committee-memo-format.ts.
 *   2. Bump COMMITTEE_MEMO_VERSION in versioning.ts AND extend the
 *      CommitteeMemoVersion union.
 *   3. Run `npm run committee-memo:print-hash` (in apps/api).
 *   4. APPEND a new entry below — DO NOT edit existing entries.
 *   5. Run `npm run check:committee-memo` to verify the gate passes.
 */

import type { CommitteeMemoVersion } from './versioning.js';
import type { ContentHash } from './identity.js';

export type CommitteeMemoManifest = { readonly [V in CommitteeMemoVersion]: ContentHash };

export const COMMITTEE_MEMO_MANIFEST: CommitteeMemoManifest = {
  // v1.0 (2026-06-12) — initial register. Captures the shape of the
  // committee memo as shipped through commit 4efb130 (the funded-exit
  // single-source move). 8-section order, current section/callout
  // headings, '—' null sentinel. Hash populated by the boot-check
  // printer; if you see __COMMITTEE_MEMO_V1_HASH__ here, run
  // `npm run committee-memo:print-hash` and replace the placeholder.
  '1.0': '3638b2992461af7b6653d74e763c92f8ccec1263804d6e9b381ed777b19fff51' as ContentHash,
  // v1.1 — Phase C "Open Items / Data Required" section added (2026-06-20).
  // MEMO_SECTION_ORDER widens by one entry (open_items appended after
  // committee_recommendation); MEMO_SECTION_HEADINGS adds the new h2 string.
  // No reordering, no callout-label changes, no null-sentinel change — the
  // existing 8 entries are preserved verbatim and the new section appends.
  //
  // Hash placeholder pending `npm run committee-memo:print-hash` after the
  // memo-format constants land. The boot-check rejects mismatches so a
  // stale hash is caught at startup.
  '1.1': '49f582eae808b7e48ceab0e203653199f34cb25d253ffd6df3655b9b43a84d61' as ContentHash,
  // v1.2 — Data Quality section (data-integrity gate SOFT + provenance
  // WARN findings). Append-only widening: MEMO_SECTION_ORDER adds
  // 'data_quality' between 'open_items' and 'footer'; MEMO_SECTION_HEADINGS
  // adds the new h2 string. Suppressed entirely when the report has no
  // findings — v1.1 pinned templates keep their original 8-section
  // shape; only deals with WARN/SOFT findings render the new section.
  //
  // Hash placeholder pending `npm run committee-memo:print-hash`.
  '1.2': '66e0d2b819da8187b05ae23c1cd1152229b88fbe2c2a544e753479c53fe06544' as ContentHash,
  // v2.0 (2026-07-26) — memo v2 MAJOR restructure to Isabelle's institutional
  // 13-section, narrative-first order. MEMO_SECTION_ORDER is re-architected
  // (Investment Overview, Investment Merits, Key Credit Risks, Sponsor
  // Assessment, Tenant Analysis, Market & Competitive Position, Exit & Refinance
  // Analysis, Appraisal & Value Challenge, Underwriting Validation, Data Quality
  // Review, Credit Structure, Investment Committee View, Final Recommendation);
  // MEMO_SECTION_HEADINGS is replaced with the 13 new h2 strings. §1–10 are
  // narrative and do not lead with ratios; §11 Credit Structure is the first
  // place leverage ratios and sized mitigants appear. Restructure titles /
  // subheads / callout labels / null sentinel are unchanged (the restructuring
  // callout now lives inside Credit Structure). Hash registered via
  // `npm run committee-memo:print-hash`.
  '2.0': '086a6d1c1ea268f295d5325ce205595e2eadfecb558050fb1e2518d09aa9c6d2' as ContentHash,
  // v2.1 (2026-08-14) — RED-FLAGS-FIRST reprioritization (display-only). MEMO_SECTION_ORDER
  // is reordered so the reader hits the due-diligence red flags (Key Credit Risks, Sponsor,
  // Data Quality, Underwriting Validation) BEFORE "what's clean" (Investment Merits);
  // Key Credit Risks renders due-diligence flags first + a demoted "Financial-metric risks"
  // sub-section (render-time classification via flag-categories.ts). MEMO_SECTION_HEADINGS
  // reframes credit_structure to "If Pursued: Structure & Conditions". No mint / doctrine
  // change. Hash registered via `npm run committee-memo:print-hash`.
  '2.1': 'dec41d67332795816734a3ff4e1dce88b9283d9a7f2270b40327e4a3817cea12' as ContentHash,
};

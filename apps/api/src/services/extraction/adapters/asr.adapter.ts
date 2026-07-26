/**
 * ASR adapter — sole call site of parseDocument + ASR-sourced extractors in
 * the composer path.
 *
 * Two-function split:
 *   - runAsrAdapter(slot)          external entry point; what the composer calls
 *   - runAsrAdapterOnDocument(...)  internal core; what tests call directly
 *
 * The split exists because parseDocument produces an intermediate typed value
 * (ParsedDocument) that's the substrate for THREE downstream extractor calls.
 * Tests that exercise the adapter's coordination logic should not have to
 * round-trip through PDF byte parsing — they synthesize ParsedDocument inputs
 * directly and call runAsrAdapterOnDocument.
 *
 * Status mapping (Option C):
 *
 *   - parseDocument throws (corrupt PDF / unsupported format) → 'failed'
 *     (the only failure mode unique to runAsrAdapter; the inner function
 *     never re-parses bytes)
 *   - all three sub-extractors rejected                         → 'failed'
 *     (reachable as of v0.2.0 / Ticket I (#6); DEFAULT_ASR_DEPS.extractAsr
 *     is now extractASR(doc), which can throw on AI/network failure. The
 *     prior v0.1.0 placeholder always resolved to null, which made this
 *     branch dead-but-correct.)
 *   - mix of throws/nulls with no non-null value               → 'empty'
 *     (rejections collapse to null via unwrapOrWarn; the slot did its job,
 *     the document simply didn't carry the thing)
 *   - at least one non-null value                              → 'ok'
 *     (value carries the populated subset; sourceRefs emit one per kind)
 *
 * SourceDocumentRef emission on 'ok': one ref per populated kind, all
 * sharing the same bufferHash. 'empty' and 'failed' emit zero refs (same
 * discipline as CF and rent-roll adapters — don't stamp a kind we didn't
 * actually extract).
 *
 * The Promise.allSettled array order is LOAD-BEARING. See the inline comment
 * immediately above the array literal.
 *
 * Adapter version is local (ASR_ADAPTER_VERSION). Ticket D will harvest
 * per-extractor versions into a new ExtractionResult field; until then the
 * composer projects only EXTRACTION_ENGINE_VERSION into the result.
 */

import type {
  ASRExtraction,
  PartiesExtraction,
  ContentHash,
  LoanTermsExtraction,
  PropertyMetadata,
  PropertyMetadataSource,
  RentRoll,
  RentRollExtraction,
  RentRollSource,
  SourceDocumentRef,
} from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { parseDocument } from '../../document-parser.service.js';
import { extractRentRollFromDocument } from '../../extract-rent-roll-from-document.js';
import { extractPropertyMetadata } from '../../extract-property-metadata.js';
import { extractASR } from '../../extract-asr.js';
import { extractAsrLoanTerms } from '../../extract-asr-loan-terms.js';
import {
  extractAsrLoanTermsLlm,
  type ExtractAsrLoanTermsLlmDeps,
} from '../../extract-asr-loan-terms-llm.js';
import {
  extractRentRollFromDocumentLlm,
  type ExtractRentRollLlmDeps,
  type RentRollCompleteness,
} from '../../extract-rent-roll-from-document-llm.js';
import { parsePartiesFromAsrText } from '../../extract-parties-from-asr.js';
import {
  extractPartiesFromAsrLlm,
  type ExtractPartiesFromAsrLlmDeps,
} from '../../extract-parties-from-asr-llm.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';
import { projectToRentRollExtraction } from './rent-roll.adapter.js';

/** Bump when this adapter's contract with downstream changes. Stamped into
 *  ExtractionResult.extractorVersions['asr'] by the composer's version
 *  harvester (Ticket D).
 *
 *  History:
 *    0.1.0 — initial. DEFAULT_ASR_DEPS.extractAsr was a null-returning
 *            placeholder; the `asr` field was always null in production.
 *    0.2.0 — Ticket I (#6). DEFAULT_ASR_DEPS.extractAsr is now extractASR
 *            (AI-driven). Adapter coordination/contract unchanged.
 *    0.4.0 — ASR "Underwritten Cash Flows" table parse (extractAsrCashFlows)
 *            added to extractASR → ASRExtraction.underwrittenCashFlows. Bumped
 *            to cache-bust so a re-ingest re-extracts the new field.
 *    0.5.0 — DE-ANCHORED loan terms. When the deterministic regex
 *            (extractAsrLoanTerms) finds no MS anchor OR a null loanAmount, an
 *            LLM-primary FALLBACK (extractAsrLoanTermsLlm) reads the WHOLE ASR
 *            text → structured loan terms, gating on the WHOLE loan (piece is a
 *            separate labeled field). Fixes non-MS ASRs (e.g. 640/BMO) that
 *            broke the single-anchor regex. Sunroad still resolves via the free
 *            regex path (no LLM). Bumped to cache-bust a re-extract.
 *    0.6.0 — DE-ANCHORED rent roll + COMPLETENESS GUARD. When the best-effort
 *            document rent-roll read under-reads (null OR a roll whose Σ rents
 *            can't be PROVEN complete), an LLM-primary FALLBACK
 *            (extractRentRollFromDocumentLlm) reads ALL tenants over the whole
 *            doc, then a completeness guard reconciles Σ rents to the roll's own
 *            stated total. Only a RECONCILED roll is emitted as the fallback;
 *            an UNRECONCILED (partial) roll is dropped to null so income-
 *            concentration + rollover stay EXCLUDED (never scored on a partial
 *            roll). Fixes 640/Vornado ANNUALREP under-read. Bumped to cache-bust.
 *    0.6.1 — MULTI-ANCHOR TERM. extractAsrLoanTermsLlm now derives termMonths
 *            from the already-cited loan-amount quote when the dedicated
 *            termPhrase field returns uncited on a fresh re-extraction — the term
 *            reads the same every run (fixes the 640 re-score's
 *            JE_TERM_MONTHS_MISSING, an LLM-non-determinism failure). Bumped to
 *            cache-bust the poisoned null-term extraction.
 *    0.6.2 — MULTI-ANCHOR TERM #3 (doc-grounded). 0.6.1 derived the term from
 *            the LLM's loan-amount QUOTE, but that quote varies run-to-run (a
 *            fresh 640 run cited a terse "$400,000,000" with no term → re-failed
 *            JE_TERM_MONTHS_MISSING). extractAsrLoanTermsLlm now reads the term
 *            straight from the DOCUMENT beside the loan figure
 *            (deriveTermFromDocFigure) — LLM-quote-independent, so the term is
 *            deterministic across re-runs. Bumped to cache-bust.
 *    0.7.0 — LLM-PRIMARY PARTIES FALLBACK. When the regex parties extractor
 *            finds no borrower/sponsor label (non-Goldman ASR — 640/BMO names
 *            the sponsor "Vornado Realty Trust and Crown Acquisitions" in a
 *            prose "Sponsorship Overview", never in Goldman labels), the adapter
 *            reads the whole doc with extractPartiesFromAsrLlm (cite-or-discard,
 *            multi-principal). Regex stays the free fast path; Sunroad unchanged.
 *            Bumped to cache-bust so 640 re-extracts with the new fallback. */
export const ASR_ADAPTER_VERSION = '0.7.0';

/**
 * One outcome value covers three ExtractionResult-relevant fields PLUS one
 * auxiliary record. propertyMetadata has no ExtractionResult slot — the
 * composer's output widens to carry it sibling-style per Finding 2 decision 2a.
 * rentRollFallback feeds pickRentRoll() in the composer's projection step.
 *
 * As of v0.2.0, `asr` carries the AI-extracted broker headline numbers
 * (implied value / cap rate / underwritten NOI) when present, else null.
 *
 * Phase 1 (rent-roll-node): `rentRollFallbackTyped` carries the typed
 * `RentRoll` corresponding to `rentRollFallback`. The lossy projection
 * (`rentRollFallback`) still flows into ExtractionResult via pickRentRoll;
 * the typed shape is captured alongside so the ingest layer can persist it
 * as a first-class graph node when the ASR fallback wins precedence.
 * Always non-null when `rentRollFallback` is non-null; null otherwise.
 */
export interface AsrAdapterValue {
  readonly asr: ASRExtraction | null;
  readonly propertyMetadata: PropertyMetadata | null;
  readonly rentRollFallback: RentRollExtraction | null;
  readonly rentRollFallbackTyped: RentRoll | null;
  /** ★ Completeness verdict for the LLM-primary rent-roll fallback, when it ran.
   *  null when the LLM fallback did not fire (deterministic read sufficed, or no
   *  rent-roll data at all). When present with reconciled=false, the fallback's
   *  roll was DROPPED (rentRollFallback null) — a partial roll is never emitted,
   *  keeping concentration / rollover excluded. Observability / audit only.
   *  Optional so pre-existing test fixtures that build AsrAdapterValue literals
   *  don't need updating; production always sets it (null when the LLM fallback
   *  did not fire). */
  readonly rentRollCompleteness?: RentRollCompleteness | null;
  /** Counterparty identity (borrower / sponsor / guarantor) from the ASR.
   *  Null when the regex matched neither name — same "absent" semantic as
   *  propertyMetadata-null (sub-extractor returned no usable data). */
  readonly parties: PartiesExtraction | null;
  /** Loan-terms block parsed from the ASR's "Loan Terms" structured table
   *  (extractAsrLoanTerms — deterministic regex; no AI). Stamped with
   *  source='ASR'. The composer uses this when the caller's request body
   *  did NOT supply a loanTerms override; the caller's value still wins
   *  when present (explicit override per the precedence rule). Null when
   *  the anchor "Original Principal Balance:" was not found in the
   *  extracted text. */
  readonly loanTerms: LoanTermsExtraction | null;
  /** Internal-consistency warnings surfaced during loan-terms parsing
   *  (e.g. balloon ≠ original principal for IO loans). Always empty when
   *  loanTerms is null. Empty even when loanTerms is non-null if all
   *  cross-checks passed. */
  readonly loanTermsWarnings: readonly string[];
  /** ★ WHOLE-vs-PIECE. When the ASR splits the loan into a trust / senior /
   *  mezzanine PIECE, that piece amount is captured HERE for exposure
   *  disclosure only — it is NEVER the gating loanAmount (that's the WHOLE
   *  loan on `loanTerms.loanAmount`) and NEVER a credit metric. Null when the
   *  loan is whole or when the LLM fallback did not run / could not cite a
   *  piece. Sourced from the LLM fallback; the deterministic regex path leaves
   *  it null (the MS block does not disambiguate whole/piece). */
  readonly loanAmountTrustPiece: number | null;
}

/**
 * Sub-extractor dependencies. Both adapter entry points take this as an
 * optional final parameter (defaulting to DEFAULT_ASR_DEPS). Production
 * code calls the adapter without supplying deps; tests pass mocked deps
 * to control sub-extractor behavior without making AI calls.
 *
 * Ticket I (#6) shipped extractASR; only DEFAULT_ASR_DEPS.extractAsr
 * changed at that point — the adapter body and the array order stayed
 * untouched, validating this dep-injection seam end-to-end.
 */
export interface AsrAdapterDeps {
  readonly extractRentRoll:
    (doc: ParsedDocument, source: RentRollSource) => Promise<RentRoll | null>;
  readonly extractPropertyMetadata:
    (doc: ParsedDocument, source: PropertyMetadataSource) => Promise<PropertyMetadata | null>;
  readonly extractAsr:
    (doc: ParsedDocument) => Promise<ASRExtraction | null>;
  /** parties parser. Wrapped async so it slots into the adapter's
   *  Promise.allSettled fan-out with the same rejection-isolation safety net
   *  as the other sub-extractors. The underlying pure parser is synchronous
   *  regex work and won't throw under normal inputs — the async wrapper +
   *  unwrapOrWarn give the defensive belt-and-suspenders the existing 3
   *  sub-extractors already wear. Returns null when neither name matched. */
  readonly parseParties:
    (pages: readonly string[]) => Promise<PartiesExtraction | null>;
  /** ★ LLM-primary loan-terms FALLBACK deps. The de-anchor path (regex null /
   *  missing loanAmount → LLM) passes these through to extractAsrLoanTermsLlm.
   *  Production uses live Sonnet + the env credit gate; tests inject a stub LLM
   *  seam + in-memory cache to exercise the logic deterministically without a
   *  live call. Undefined ⇒ the extractor's own defaults (real call, env gate,
   *  no cache). */
  readonly loanTermsLlm?: ExtractAsrLoanTermsLlmDeps;
  /** ★ LLM-primary PARTIES FALLBACK deps. The de-anchor path (regex found no
   *  borrower/sponsor label → LLM reads the whole doc for the borrower entity +
   *  sponsor principals, cite-or-discard). Production uses live Sonnet + the env
   *  credit gate; tests inject a stub LLM seam + in-memory cache. Undefined ⇒ the
   *  extractor's own defaults (real call, env gate, no cache). */
  readonly partiesLlm?: ExtractPartiesFromAsrLlmDeps;
  /** ★ LLM-primary rent-roll FALLBACK deps. The de-anchor path (deterministic
   *  doc read under-reads → LLM reads all tenants + completeness guard) passes
   *  these through to extractRentRollFromDocumentLlm. Production uses live Sonnet
   *  + the env credit gate; tests inject a stub LLM seam + in-memory cache to
   *  exercise the logic deterministically. Undefined ⇒ the extractor's own
   *  defaults (real call, env gate, no cache). */
  readonly rentRollLlm?: ExtractRentRollLlmDeps;
}

export const DEFAULT_ASR_DEPS: AsrAdapterDeps = {
  extractRentRoll: extractRentRollFromDocument,
  extractPropertyMetadata: extractPropertyMetadata,
  extractAsr: extractASR,
  parseParties: async (pages) => {
    const result = parsePartiesFromAsrText(pages);
    return result.borrowerName === null && result.sponsorName === null ? null : result;
  },
};

/**
 * Unwrap a Promise.allSettled result by position. Fulfilled-with-null and
 * rejected both collapse to null in the return value; rejections also log a
 * grep-friendly warning tagged by sub-extractor so the throw is visible at
 * debug time.
 *
 * Log format (stable, grep-able):
 *   [asr.adapter] sub-extractor rejected: <diagnosticTag>: <message> TODO(observability)
 *
 * TODO(observability): promote each call site to a typed log event when
 * observability infrastructure lands. The console.warn is a stopgap.
 *
 * Private to this file. If a second multi-extractor adapter materializes,
 * lift to extractor-outcome.ts then — not before.
 */
function unwrapOrWarn<T>(
  result: PromiseSettledResult<T | null>,
  diagnosticTag: string,
): T | null {
  if (result.status === 'fulfilled') return result.value;
  const reason = result.reason as Error | undefined;
  const message = reason?.message ?? String(result.reason);
  // eslint-disable-next-line no-console -- TODO(observability): typed log event
  console.warn(
    `[asr.adapter] sub-extractor rejected: ${diagnosticTag}: ${message} TODO(observability)`,
  );
  return null;
}

/**
 * External entry point.
 *
 *   1. Hash the buffer (for sourceRefs + so the inner function gets a hash
 *      without re-touching bytes).
 *   2. parseDocument(buffer, filename, 'application/pdf'). mimeType is
 *      hardcoded: the slot is named asrPdf by contract; threading mimeType
 *      through SlotInput would duplicate the format commitment the slot
 *      name already carries.
 *   3. Delegate to runAsrAdapterOnDocument(doc, bufferHash).
 *   4. Patch the returned outcome's durationMs to include parseDocument
 *      time (decision (b): operationally more useful for the composer).
 *
 * parseDocument-throws is the ONE failure mode unique to this function.
 */
export async function runAsrAdapter(
  slot: SlotInput,
  deps: AsrAdapterDeps = DEFAULT_ASR_DEPS,
): Promise<ExtractorOutcome<AsrAdapterValue>> {
  const t0 = Date.now();
  const bufferHash = computeBufferContentHash(slot.buffer);

  let doc: ParsedDocument;
  try {
    doc = await parseDocument(slot.buffer, slot.filename, 'application/pdf');
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: ASR_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'parseDocumentThrew',
        message: `${e?.name ?? 'Error'}: ${e?.message ?? 'parseDocument failed'}`,
      },
    };
  }

  const inner = await runAsrAdapterOnDocument(doc, bufferHash, deps);
  // Decision (b): outer durationMs includes parseDocument time, so the composer
  // sees total wallclock for this slot. Inner durationMs is overwritten.
  return { ...inner, durationMs: Date.now() - t0 };
}

/**
 * Internal core. Exported so tests can synthesize ParsedDocument inputs and
 * call directly without going through PDF byte parsing.
 *
 * bufferHash is passed in because the bytes are gone by the time this
 * function runs.
 */
export async function runAsrAdapterOnDocument(
  doc: ParsedDocument,
  bufferHash: ContentHash,
  deps: AsrAdapterDeps = DEFAULT_ASR_DEPS,
): Promise<ExtractorOutcome<AsrAdapterValue>> {
  const t0 = Date.now();

  // ORDER IS LOAD-BEARING. Indices map by position to the local variables
  // unpacked below. If you reorder this array (e.g., alphabetize it), you
  // MUST update the three unwrapOrWarn calls AND the status-mapping logic
  // that follows.
  //
  //   Index 0 — AI rent-roll fallback   → RentRoll | null
  //               (deps.extractRentRoll with source='asr_table')
  //   Index 1 — property metadata        → PropertyMetadata | null
  //               (deps.extractPropertyMetadata with source='asr_extraction')
  //   Index 2 — ASR extraction           → ASRExtraction | null
  //               (deps.extractAsr; default in DEFAULT_ASR_DEPS is extractASR
  //                as of v0.2.0 / Ticket I (#6). Tests inject mocks here to
  //                avoid live AI calls.)
  const results = await Promise.allSettled<
    [Promise<RentRoll | null>, Promise<PropertyMetadata | null>, Promise<ASRExtraction | null>, Promise<PartiesExtraction | null>]
  >([
    deps.extractRentRoll(doc, 'asr_table'),
    deps.extractPropertyMetadata(doc, 'asr_extraction'),
    deps.extractAsr(doc),
    deps.parseParties([doc.rawText]),
  ]);

  // Unwrap by position. Throws collapse to null + console.warn.
  const rentRollLegacy = unwrapOrWarn(results[0]!, 'AI:RentRoll');
  const propertyMetadata = unwrapOrWarn(results[1]!, 'AI:PropertyMetadata');
  const asr = unwrapOrWarn(results[2]!, 'AI:ASR');
  let parties = unwrapOrWarn(results[3]!, 'Parties');

  // Project rent-roll legacy → spine shape (reuses rent-roll.adapter.ts's
  // documented lossy projection — same field mapping, same caveats).
  let rentRollFallback = rentRollLegacy === null
    ? null
    : projectToRentRollExtraction(rentRollLegacy);
  let rentRollTyped: RentRoll | null = rentRollLegacy;
  let rentRollCompleteness: RentRollCompleteness | null = null;

  // v0.6.0 — DE-ANCHOR the rent roll + COMPLETENESS GUARD. The best-effort
  // document rent-roll read (deps.extractRentRoll) UNDER-READS a dense,
  // non-standard roll (640's Vornado ANNUALREP: a tenant spans a multi-line
  // block terminated by "TENANT TOTAL:"). An under-read roll silently mis-prices
  // tenant concentration + drops rollover from applicability. We fire the
  // LLM-primary reader over the WHOLE doc, then RECONCILE Σ tenant rents to the
  // roll's own stated total to PROVE completeness (rows-dropped is invisible
  // without the arithmetic). Decision:
  //   - LLM reconciles (proven complete) → use the LLM roll (replaces under-read).
  //   - LLM does NOT reconcile → DROP the rent roll to null. We do NOT trust the
  //     deterministic under-read either (it's unproven), so concentration /
  //     rollover stay EXCLUDED — the honest floor, never scoring a partial roll.
  //   - LLM did not fire (no credits, empty doc) → keep the deterministic result
  //     (today's behavior; free path preserved).
  // Only run when the ASR doc actually carries a rent-roll signal (a "TENANT
  // TOTAL" / "RENT ROLL" marker), so a plain ASR with no roll never pays for a
  // call. Sunroad's roll comes via the dedicated rent_roll_file slot (a separate
  // adapter), so this ASR-side path does not disturb it.
  const docHasRentRollSignal =
    /rent\s*roll|tenant\s*total|annualized\s+tenant/i.test(doc.rawText);
  if (docHasRentRollSignal) {
    const rrLlm = await extractRentRollFromDocumentLlm(
      doc.rawText, bufferHash, 'asr_table', deps.rentRollLlm,
    );
    if (rrLlm.llmCalled || rrLlm.fromCache) {
      rentRollCompleteness = rrLlm.completeness;
      if (rrLlm.rentRoll !== null && rrLlm.completeness.reconciled) {
        // Proven-complete roll wins — replaces the under-read.
        rentRollTyped = rrLlm.rentRoll;
        rentRollFallback = projectToRentRollExtraction(rrLlm.rentRoll);
      } else if (rrLlm.rentRoll !== null && !rrLlm.completeness.reconciled) {
        // Read something, but could NOT prove it complete → EXCLUDE the roll.
        // Dropping to null makes deriveTopTenantShare / deriveRolloverShare
        // return null downstream → dims route to HITL/N-A (never scored partial).
        rentRollTyped = null;
        rentRollFallback = null;
      }
      // rrLlm.rentRoll === null (no citeable tenants) → keep deterministic result.
    }
  }

  // 'failed' if all three sub-extractors rejected. Reachable as of v0.2.0
  // (Ticket I #6): extractASR is now an AI call that can throw on
  // network/API failure. Test-asr-adapter.ts case 8 exercises this branch
  // (all three deps reject → status 'failed' / error 'allSubExtractorsThrew').
  const allRejected = results.every((r) => r.status === 'rejected');
  if (allRejected) {
    const causes = results.map((r) => {
      const e = r.status === 'rejected' ? (r.reason as Error | undefined) : undefined;
      return `${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'}`;
    });
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: ASR_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: 'allSubExtractorsThrew',
        message: `all three sub-extractors rejected; causes: [${causes.join(' | ')}]`,
      },
    };
  }

  // DE-ANCHOR the parties. When the regex found no borrower/sponsor label
  // (non-Goldman ASR — 640/BMO names the sponsor in a "Sponsorship Overview"
  // prose section, never in the Goldman labels), read the WHOLE doc with the
  // LLM and extract the borrower entity + sponsor PRINCIPALS (a JV names
  // several), cite-or-discard. Credit-gated + fail-safe: no credits / error →
  // null → the sponsor-DD lane stays could-not-search (honest floor). Sunroad
  // hits the regex first and never reaches here (free path preserved).
  if (parties === null) {
    const partiesLlm = await extractPartiesFromAsrLlm(doc.rawText, bufferHash, deps.partiesLlm);
    if (partiesLlm.parties !== null) {
      parties = partiesLlm.parties;
    }
  }

  const hasAsr = asr !== null;
  const hasPm = propertyMetadata !== null;
  const hasRrf = rentRollFallback !== null;
  const hasParties = parties !== null;

  // v0.3.0 — Loan-terms block. Deterministic regex parser first (fast + free +
  // reproducible). Runs after the async sub-extractors so its result is
  // deterministic w.r.t. the parsed doc text.
  const regexResult = extractAsrLoanTerms(doc);
  let loanTerms = regexResult.loanTerms;
  let loanTermsWarnings: readonly string[] = regexResult.warnings;
  let loanAmountTrustPiece: number | null = null;

  // v0.5.0 — DE-ANCHOR. When the regex found no MS anchor (loanTerms === null)
  // OR anchored but produced a null gating loanAmount, fall back to the
  // LLM-primary reader over the WHOLE ASR text. This fixes non-MS layouts
  // (640/BMO) that the single `Original Principal Balance:` anchor missed.
  // The LLM path is credit-gated + fail-safe: no credits / error → all-null →
  // engine refuses (today's honest floor). Sunroad hits the regex and never
  // reaches here (free path preserved).
  const needsLlmFallback = loanTerms === null || loanTerms.loanAmount === null;
  if (needsLlmFallback) {
    const llm = await extractAsrLoanTermsLlm(doc.rawText, bufferHash, deps.loanTermsLlm);
    if (llm.loanTerms !== null) {
      loanTerms = llm.loanTerms;
      loanTermsWarnings = [...regexResult.warnings, ...llm.warnings];
    } else if (llm.warnings.length > 0) {
      // No usable loan terms, but surface the LLM's data-quality warnings
      // (e.g. whole-not-piece hold) into the memo channel.
      loanTermsWarnings = [...regexResult.warnings, ...llm.warnings];
    }
    loanAmountTrustPiece = llm.loanAmountTrustPiece;
  }
  const hasLoanTerms = loanTerms !== null;

  if (!hasAsr && !hasPm && !hasRrf && !hasParties && !hasLoanTerms) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: ASR_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'parsed document; no extractor produced data',
    };
  }

  // ok path: emit one sourceRef per populated kind, all sharing bufferHash.
  // Same physical document, distinct semantic extractions — contract-allowed
  // dual/triple-kind emission (mirrors the CF adapter's dual-kind pattern).
  const refs: SourceDocumentRef[] = [];
  if (hasAsr) refs.push({ kind: 'asr', contentHash: bufferHash });
  if (hasPm) refs.push({ kind: 'property_metadata', contentHash: bufferHash });
  if (hasRrf) refs.push({ kind: 'rent_roll', contentHash: bufferHash });

  // parties does not emit a separate sourceRef — the parties data is derived
  // from the same ASR text already covered by the 'asr' / 'property_metadata'
  // refs above. Adding a 'parties' kind would widen SourceDocumentKind for
  // no traceability gain. See contract extraction.ts SourceDocumentKind union.
  // loanTerms similarly is derived from the same ASR text → covered by the
  // 'asr' ref when both are present; no separate kind.

  return {
    status: 'ok',
    value: {
      asr,
      propertyMetadata,
      rentRollFallback,
      // Phase 1 (rent-roll-node): carry the typed RentRoll alongside the lossy
      // projection. Non-null whenever rentRollFallback is non-null (same source).
      // v0.6.0: this is the RECONCILED-LLM roll when the completeness guard won,
      // the deterministic roll otherwise, or null when an unreconciled roll was
      // dropped — kept in lockstep with rentRollFallback above.
      rentRollFallbackTyped: rentRollTyped,
      rentRollCompleteness,
      parties,
      loanTerms,
      loanTermsWarnings,
      loanAmountTrustPiece,
    },
    sourceRefs: refs,
    adapterVersion: ASR_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}

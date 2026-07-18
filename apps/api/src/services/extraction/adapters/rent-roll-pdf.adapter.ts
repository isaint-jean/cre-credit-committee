/**
 * Rent-roll PDF adapter — the LLM-primary reader for a DEDICATED rent-roll doc
 * that arrives as a PDF (not XLSX).
 *
 * WHY THIS EXISTS. The composer's rent_roll slot historically ran ONLY the XLSX
 * parser (`runRentRollAdapter`). A dedicated rent-roll PDF — e.g. 640 Fifth
 * Ave's Vornado "ANNULREP - ANNUALIZED TENANT RENT ROLL" exported to PDF
 * (`N064 - Rent Roll 4.29.24.PDF`) — could not be parsed as XLSX → 0 units →
 * `pickRentRoll` fell through to the ASR-embedded narrative fallback, which
 * reads the deal WRITE-UP (rents stated as "% of UW Total Rent", no citeable
 * dollar table) → 0 citeable tenants → tenant concentration / rollover
 * EXCLUDED. The clean roll table — the EXACT ANNULREP format
 * `extractRentRollFromDocumentLlm` was hand-tuned for (`TENANT TOTAL:` lines,
 * the ~$74.6M `BLDG. TOTAL`) — was never fed to the extractor.
 *
 * THE FIX (plumbing only — the extractor + prompt already fit). Parse the PDF to
 * text and run the SAME LLM-primary reader the ASR fallback uses, with the SAME
 * completeness-guard discipline: a roll is trusted ONLY when Σ tenant rents
 * RECONCILE to the roll's own stated grand total (rows-dropped is invisible
 * without the arithmetic). Outcomes:
 *   - reconciled roll                → 'ok'    (used; replaces nothing — it IS the roll)
 *   - roll read but NOT reconciled   → 'empty' (EXCLUDED — never score a partial roll;
 *                                               falls to ASR fallback / honest floor)
 *   - no citeable tenants            → 'empty' (honest floor)
 *   - PDF parse threw                → 'failed'
 *
 * Emits the SAME `ExtractorOutcome<RentRollAdapterValue>` shape as the XLSX
 * adapter, so `pickRentRoll`, the extractorVersions stamping, and the
 * `rent_roll` sourceRef emission are all UNCHANGED — a dedicated roll doc (PDF
 * or XLSX) beats the ASR-embedded narrative, exactly as before for XLSX.
 */

import type { SourceDocumentRef } from '@cre/contracts';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { parseDocument } from '../../document-parser.service.js';
import {
  extractRentRollFromDocumentLlm,
  RENT_ROLL_LLM_VERSION,
  type ExtractRentRollLlmDeps,
} from '../../extract-rent-roll-from-document-llm.js';
import { projectToRentRollExtraction, type RentRollAdapterValue } from './rent-roll.adapter.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/** Version stamped into ExtractionResult.extractorVersions['rentRoll'] when a
 *  PDF roll wins precedence. Distinct from the XLSX adapter's version so the
 *  per-slot merge trigger can tell which extractor produced the roll. */
export const RENT_ROLL_PDF_ADAPTER_VERSION = `rent-roll-pdf-llm/${RENT_ROLL_LLM_VERSION}`;

export interface RentRollPdfAdapterDeps {
  /** Injectable LLM seam for the underlying reader (proofs pass a stub). */
  readonly rentRollLlm?: ExtractRentRollLlmDeps;
}

export async function runRentRollPdfAdapter(
  slot: SlotInput,
  deps: RentRollPdfAdapterDeps = {},
): Promise<ExtractorOutcome<RentRollAdapterValue>> {
  const t0 = Date.now();

  // 1. Parse the PDF to text. A parse throw → 'failed' (mirrors the XLSX
  //    adapter routing a corrupt buffer to 'failed').
  let rawText: string;
  try {
    const parsed = await parseDocument(slot.buffer, slot.filename, 'application/pdf');
    rawText = parsed.rawText;
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: RENT_ROLL_PDF_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: e?.name ?? 'RentRollPdfParseError',
        message: e?.message ?? 'rent-roll PDF parse failed',
      },
    };
  }

  // 2. LLM-primary read + completeness guard (fail-safe: never throws, never
  //    fabricates — no credits / error → null roll → 'empty' below).
  const bufferHash = computeBufferContentHash(slot.buffer);
  const rrLlm = await extractRentRollFromDocumentLlm(
    rawText, bufferHash, 'rent_roll_file', deps.rentRollLlm,
  );

  // 3. Completeness gate — a RECONCILED roll wins; anything less is EXCLUDED
  //    (never score a partial roll — the honest floor).
  if (rrLlm.rentRoll !== null && rrLlm.completeness.reconciled) {
    const refs: SourceDocumentRef[] = [{ kind: 'rent_roll', contentHash: bufferHash }];
    return {
      status: 'ok',
      value: { projection: projectToRentRollExtraction(rrLlm.rentRoll), typed: rrLlm.rentRoll },
      sourceRefs: refs,
      adapterVersion: RENT_ROLL_PDF_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
    };
  }

  return {
    status: 'empty',
    sourceRefs: [],
    adapterVersion: RENT_ROLL_PDF_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
    reason: rrLlm.rentRoll === null
      ? 'rent-roll PDF: LLM produced no citeable tenants'
      : 'rent-roll PDF: roll read but did NOT reconcile to the stated total — EXCLUDED (never score a partial roll)',
  };
}

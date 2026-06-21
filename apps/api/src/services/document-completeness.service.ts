/**
 * Document-Completeness Ledger — a DERIVED meta-layer (no write, no LLM, no
 * doctrine). Turns honest-blank into an explicit "to finish this underwriting
 * you still need doc X" signal, computed from corpus/extraction/overlay state
 * plus the field-authority registry's per-cell required-source map.
 *
 * Correctness invariants (see the build brief):
 *  1. PRESENCE = sourceDocuments.kind ∪ populated-overlay implications. A doc
 *     stamped as an overlay (e.g. t12Extraction) bypasses the extraction
 *     pipeline and is NOT in sourceDocuments — counting only sourceDocuments
 *     would falsely report it missing while the workbook shows it populated.
 *  2. BLOCKED = registry primary absent AND every fallback absent AND not
 *     derived/manualInput AND the cell is ACTUALLY BLANK in the render. The
 *     last clause collapses theoretical counts to truth: the loanDocs primary
 *     covers 35 cells, but Original_Balance / Coupon / Balloon_Term / etc. are
 *     populated from the ASR — they must NOT be flagged as blocked.
 *  3. COVERAGE HONESTY: render cells with no registry entry are surfaced as
 *     "not yet doc-mapped" — silence must not read as complete. Appraisal
 *     presence is explicitly "not checked" (no SourceDocument equivalent).
 */
import type { FieldAuthorityRegistry, SourceDocument } from './field-authority.types.js';
import type { SourceDocumentKind } from '@cre/contracts';

/** Verified bridge: extraction-side kind → registry-side SourceDocument.
 *  null = no registry equivalent (never satisfies or blocks a registry cell). */
const KIND_TO_SOURCE_DOCUMENT: Record<SourceDocumentKind, SourceDocument | null> = {
  rent_roll: 'rentRoll',
  in_place: 't12',          // operating statement (registry 't12' = the CF)
  seller_uw: 't12',         // issuer-UW column of the operating statement (NOT servicerStatement)
  t12: 't12',
  asr: 'asr',
  property_metadata: 'asr', // extracted from the ASR
  pca: 'pca',
  appraisal: null,          // no SourceDocument equivalent — out of registry scope
  loan_terms: null,         // ASR-derived loan terms ≠ loanDocs (actual loan documents)
} as unknown as Record<SourceDocumentKind, SourceDocument | null>;

/** Which registry SourceDocument a populated overlay implies is present. */
export interface OverlayPresence {
  t12Extraction?: boolean;
  issuerUwExtraction?: boolean;
  sourcesAndUses?: boolean;
  pcaExtraction?: boolean;
  partiesExtraction?: boolean;
  appraisalExtraction?: boolean;
}
const OVERLAY_TO_SOURCE_DOCUMENT: Record<keyof OverlayPresence, SourceDocument | null> = {
  t12Extraction: 't12',
  issuerUwExtraction: 't12',
  sourcesAndUses: 'asr',
  pcaExtraction: 'pca',
  partiesExtraction: 'asr',
  appraisalExtraction: null,
};

const NOT_DOC_GATED = new Set<SourceDocument>(['derived', 'manualInput']);

export interface DocumentCompleteness {
  present: SourceDocument[];
  missing: Array<{ document: SourceDocument; blockedCellCount: number; sampleCells: string[] }>;
  coverage: {
    /** Registry cells mapped to a required doc (the universe the ledger knows). */
    registryDocMappedCells: number;
    /** Of those, how many are rendered in THIS workbook (what the ledger evaluated). */
    evaluatedInThisView: number;
    /** Registry-mapped cells NOT rendered in this variant (not evaluated here). */
    notRenderedInThisView: number;
    /** Honest caveats — never let silence read as "complete". */
    appraisalNote: string;
  };
}

/** Human-readable section lines for the workbook render (criterion-3 surface). */
export function formatCompletenessSection(dc: DocumentCompleteness): { present: string; missing: string; coverage: string } {
  const DOC_LABEL: Partial<Record<SourceDocument, string>> = {
    asr: 'ASR', t12: 'Operating Statement', rentRoll: 'Rent Roll', pca: 'PCA',
    loanDocs: 'Loan Docs', closingStatement: 'Closing Statement', leaseAbstract: 'Lease Abstracts',
    intercreditor: 'Intercreditor', servicerStatement: 'Servicer Statement', survey: 'Survey',
  };
  const lbl = (d: SourceDocument) => DOC_LABEL[d] ?? d;
  const present = `Docs present: ${dc.present.map(lbl).join(', ') || '(none)'}.`;
  const missing = dc.missing.length === 0
    ? 'To complete: no rendered cell is blocked by a missing document.'
    : `To complete, provide: ${dc.missing.map((m) => `${lbl(m.document)} (${m.blockedCellCount} blank cell${m.blockedCellCount === 1 ? '' : 's'}: ${m.sampleCells.join(', ')})`).join('; ')}.`;
  const c = dc.coverage;
  const coverage = `Ledger scope: evaluated ${c.evaluatedInThisView} of ${c.registryDocMappedCells} doc-mapped cells in this view (${c.notRenderedInThisView} mapped cells not rendered here). Appraisal presence not checked. Data rows, totals, and unmapped cells are not doc-checked.`;
  return { present, missing, coverage };
}

export interface DocumentCompletenessInput {
  sourceDocumentKinds: readonly SourceDocumentKind[];
  overlayPresence: OverlayPresence;
  registry: FieldAuthorityRegistry;
  /** range (== registry cellAddress) → rendered value. null/absent = blank. */
  renderedValueByRange: Map<string, unknown>;
}

export function computeDocumentCompleteness(input: DocumentCompletenessInput): DocumentCompleteness {
  const { sourceDocumentKinds, overlayPresence, registry, renderedValueByRange } = input;

  // (1) PRESENCE = bridge(kinds) ∪ overlay-implied
  const present = new Set<SourceDocument>();
  for (const k of sourceDocumentKinds) {
    const d = KIND_TO_SOURCE_DOCUMENT[k];
    if (d) present.add(d);
  }
  for (const [overlay, on] of Object.entries(overlayPresence)) {
    if (!on) continue;
    const d = OVERLAY_TO_SOURCE_DOCUMENT[overlay as keyof OverlayPresence];
    if (d) present.add(d);
  }

  // (2) BLOCKED per cell
  const fields = Object.values(registry.fields);
  const blockedByDoc = new Map<SourceDocument, string[]>();
  for (const f of fields) {
    const req = f.primary.document;
    const hasRenderBinding = renderedValueByRange.has(f.cellAddress);
    if (NOT_DOC_GATED.has(req)) continue;
    const allAbsent =
      !present.has(req) && f.fallbacks.every((fb) => !present.has(fb.document));
    if (!allAbsent) continue; // a present source (primary or fallback) covers it
    if (!hasRenderBinding) continue; // not rendered → can't be "actually-blank-in-render"
    const value = renderedValueByRange.get(f.cellAddress);
    const blank = value === null || value === undefined || value === '';
    if (!blank) continue; // SANITY GATE — populated cell is not blocked
    const list = blockedByDoc.get(req) ?? [];
    list.push(f.cellAddress);
    blockedByDoc.set(req, list);
  }

  const missing = [...blockedByDoc.entries()]
    .map(([document, cells]) => ({ document, blockedCellCount: cells.length, sampleCells: cells.slice(0, 4) }))
    .sort((a, b) => b.blockedCellCount - a.blockedCellCount);

  // (3) COVERAGE — honest scope. The universe is doc-gated registry cells
  // (exclude derived/manualInput, which carry no required-doc); report how many
  // were rendered+evaluated here vs not present in this variant.
  const docGated = fields.filter((f) => !NOT_DOC_GATED.has(f.primary.document));
  const registryDocMappedCells = docGated.length;
  const evaluatedInThisView = docGated.filter((f) => renderedValueByRange.has(f.cellAddress)).length;

  return {
    present: [...present].sort(),
    missing,
    coverage: {
      registryDocMappedCells,
      evaluatedInThisView,
      notRenderedInThisView: registryDocMappedCells - evaluatedInThisView,
      appraisalNote: 'appraisal presence not checked (no required-doc mapping)',
    },
  };
}

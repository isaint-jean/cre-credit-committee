/**
 * DOC-TYPE TAXONOMY — the single authoritative source of truth for the CRE
 * data-room / intake document types (Data-Room Phase 1, Deliverable 1).
 *
 * Historically four parallel lists carried overlapping slices of this knowledge:
 *   1. SOURCE_DOC_SLOTS       (packages/shared/src/types/source-docs.ts)   — the
 *                              per-deal upload slots (asr/cf/rent_roll/pca/…).
 *   2. SLOT_TO_INPUT          (append-source-doc.service.ts)              — the
 *                              slot → composer InputSlots map (ingest-critical).
 *   3. DQ_UPLOAD_SLOT         (web RenderedAnalysisView.tsx)              — the
 *                              DQ-code → append-slot presentation map.
 *   4. source_doc_types       (intake-completeness-map.json / .service.ts) — the
 *                              intake doc-type roster (adds in_place, loan_terms).
 *
 * This constant unifies them into ONE taxonomy of THREE tiers, and encodes the
 * five divergence seams between them as EXPLICIT, machine-checkable data (not
 * prose). The parallel lists must either DERIVE from this taxonomy or be
 * CROSS-CHECKED against it by a consistency test — never drift as a 4th list.
 *
 * ⚠ SCOPE: this is a taxonomy CONSTANT (data + derivations). It does NOT touch
 * ingest logic, the governed compose pipeline, or the registry. The load-bearing
 * SLOT_TO_INPUT map stays physically in the service (safety); the consistency
 * test asserts it agrees with `engineInput` here.
 *
 * ── The three tiers ──────────────────────────────────────────────────────────
 *   (a) 'ingesting'   — has an upload slot AND routes to a composer engine input
 *                        (asr, cf, rent_roll, pca, appraisal).
 *   (b) 'stored'      — has an upload slot but is STORED-not-extracted; engine
 *                        input is null (seller_uw, t12).
 *   (c) 'room_only'   — data-room-only doc types with no engine upload slot
 *                        (loan_terms, legal, title, insurance, closing, leases,
 *                        sponsor_pfs, phase_i_esa, om).
 *
 * ── The five encoded divergence seams ───────────────────────────────────────
 *   1. cf is COMPOSITE — the single `cf` upload slot fans out to TWO intake
 *      doc-types ['in_place','t12'] and answers TWO DQ codes. Encoded via
 *      `composite` + `dqCodes`.
 *   2. loan_terms is REQUEST-ONLY — `requestOnly: true`, `slot: null`. This is
 *      the JE_LOAN_TERMS_MISSING gap: the flag requests a doc that has no upload
 *      slot (loan terms are reconstructed from the parent's AdjustedInputs).
 *   3. seller_uw / t12 are STORED with NULL engine input — tier 'stored',
 *      `engineInput: null`.
 *   4. asr has NO DQ code — it is required-earlier (ingest minimum), so a
 *      missing-doc DQ flag never fires for it. Encoded via `noDqCode: true`.
 *   5. DQ slots ⊂ input slots — the DQ-clearable set (rent_roll/pca/appraisal +
 *      the cf composite) is a documented SUBSET of the upload slots. Derived
 *      helper `DQ_CLEARABLE_SLOTS` makes the subset relationship explicit.
 */

import type { SourceDocumentKind } from './extraction.js';

/** Composer InputSlots keys (mirror of apps/api extractor-outcome.ts InputSlots).
 *  Kept here as a string-literal union so the taxonomy can name engine inputs
 *  without importing api service code (contracts imports nothing from services).
 *  The consistency test binds this to the real SLOT_TO_INPUT map. */
export type EngineInputSlot =
  | 'asrPdf'
  | 'sellerCfXlsx'
  | 'rentRollXlsx'
  | 'pcaPdf'
  | 'appraisalPdf';

/** Upload-slot id (the per-deal source-doc slot the originator uploads into). */
export type DocTypeSlot =
  | 'asr'
  | 'cf'
  | 'rent_roll'
  | 'pca'
  | 'appraisal'
  | 'seller_uw'
  | 't12';

export type DocTypeTier = 'ingesting' | 'stored' | 'room_only';

/**
 * Data-Room CATEGORY — the HUMAN folder, a level ABOVE doc-types. Doc-types stay
 * the engine's routing keys (asr/cf/rent_roll/…); categories are how a person
 * browses / downloads the room ("give me the Legal folder"). Every doc-type maps
 * to exactly one category via DOC_TYPE_CATEGORY (derived below). This is NOT a
 * parallel list: the mapping lives ON each DocTypeEntry (the one source).
 *
 *   ASRs                 — the annual statement of rents (the deal's rent record).
 *   Excels               — the SELLER / issuer underwriting only (kept under the
 *                          buyer-familiar name "Excels"). NOT a format bucket: it
 *                          holds seller_uw and nothing else.
 *   Financial Statements — operating financials (cf/t12/rent_roll/occupancy) +
 *                          sponsor credit (sponsor_pfs).
 *   Third-Party Reports  — independent expert reports (appraisal/pca/phase_i_esa).
 *   Insurance            — insurance (promoted out of Legal to its own folder).
 *   Legal                — legal instruments & closing set (legal/title/closing/
 *                          leases/loan_terms).
 *   General              — honest home for loose fits that would MISFILE anywhere
 *                          else (om). See the loose-fit note below.
 */
export type DocTypeCategory =
  | 'ASRs'
  | 'Excels'
  | 'Financial Statements'
  | 'Third-Party Reports'
  | 'Insurance'
  | 'Legal'
  | 'General';

/** The categories in browse / download order (rents → seller UW → financials →
 *  expert reports → insurance → legal → catch-all). The one ordering source for
 *  UI + zip folder listing. */
export const CATEGORIES_IN_ORDER: readonly DocTypeCategory[] = [
  'ASRs',
  'Excels',
  'Financial Statements',
  'Third-Party Reports',
  'Insurance',
  'Legal',
  'General',
] as const;

/** One doc-type in the authoritative taxonomy. */
export interface DocTypeEntry {
  /** Stable identity for this doc type. */
  readonly id: string;
  /** Human label for the data room / request UI. */
  readonly label: string;
  /** The human data-room folder this doc-type files under (level above tier). */
  readonly category: DocTypeCategory;
  readonly tier: DocTypeTier;
  /** Upload slot id, or null for request-only / room-only doc types. */
  readonly slot: DocTypeSlot | null;
  /** Composer InputSlots key. null for tier 'stored' (stored-not-extracted),
   *  composite (see `composite`), or room-only doc types. */
  readonly engineInput: EngineInputSlot | null;
  /** SEAM 1 — a composite slot fans out to these intake doc-types. Present only
   *  on `cf`, which yields ['in_place','t12']. */
  readonly composite?: readonly SourceDocumentKind[];
  /** DQ codes this doc-type's upload slot answers (missing-doc flags). Empty for
   *  doc types with no DQ code (asr — SEAM 4) or no slot (room-only, request-only). */
  readonly dqCodes?: readonly string[];
  /** SEAM 2 — a doc that is requested (has a DQ code) but has no upload slot; the
   *  request action shows, the upload action hides. Only `loan_terms`. */
  readonly requestOnly?: boolean;
  /** SEAM 4 — required-earlier (ingest minimum); no missing-doc DQ code fires. */
  readonly noDqCode?: boolean;
}

/**
 * THE authoritative doc-type taxonomy. Order: tier (a) → (b) → (c).
 */
export const DOC_TYPE_TAXONOMY: readonly DocTypeEntry[] = [
  // ── (a) engine-ingesting ────────────────────────────────────────────────
  {
    id: 'asr',
    label: 'Annual Statement of Rents (ASR)',
    category: 'ASRs',
    tier: 'ingesting',
    slot: 'asr',
    engineInput: 'asrPdf',
    // SEAM 4 — required-earlier; ingest minimum. No missing-doc DQ code fires.
    noDqCode: true,
    dqCodes: [],
  },
  {
    id: 'cf',
    label: 'Cash-flow / operating statement (T-12 + in-place)',
    category: 'Financial Statements',
    tier: 'ingesting',
    slot: 'cf',
    engineInput: 'sellerCfXlsx',
    // SEAM 1 — one slot fans out to two intake doc-types + answers two DQ codes.
    composite: ['in_place', 't12'],
    dqCodes: ['JE_TRAILING_ACTUALS_MISSING', 'JE_IN_PLACE_MISSING'],
  },
  {
    id: 'rent_roll',
    label: 'Rent roll',
    category: 'Financial Statements',
    tier: 'ingesting',
    slot: 'rent_roll',
    engineInput: 'rentRollXlsx',
    dqCodes: ['JE_RENT_ROLL_MISSING', 'JE_RENT_ROLL_UNIT_INCOMPLETE'],
  },
  {
    id: 'pca',
    label: 'Property condition assessment (PCA)',
    category: 'Third-Party Reports',
    tier: 'ingesting',
    slot: 'pca',
    engineInput: 'pcaPdf',
    dqCodes: ['JE_PCA_MISSING'],
  },
  {
    id: 'appraisal',
    label: 'Appraisal',
    category: 'Third-Party Reports',
    tier: 'ingesting',
    slot: 'appraisal',
    engineInput: 'appraisalPdf',
    dqCodes: ['JE_APPRAISAL_MISSING'],
  },

  // ── (b) engine-stored-not-extracted ─────────────────────────────────────
  {
    id: 'seller_uw',
    label: 'Seller / issuer underwriting',
    category: 'Excels',
    tier: 'stored',
    slot: 'seller_uw',
    // SEAM 3 — stored, not a composer input.
    engineInput: null,
    dqCodes: [],
  },
  {
    id: 't12',
    label: 'Trailing-12 operating statement (stored)',
    category: 'Financial Statements',
    tier: 'stored',
    slot: 't12',
    // SEAM 3 — stored, not a composer input.
    engineInput: null,
    dqCodes: [],
  },

  // ── (c) room-only ───────────────────────────────────────────────────────
  {
    id: 'loan_terms',
    label: 'Loan terms / term sheet',
    category: 'Legal',
    tier: 'room_only',
    slot: null,
    engineInput: null,
    // SEAM 2 — request-only: has a DQ code but no upload slot.
    requestOnly: true,
    dqCodes: ['JE_LOAN_TERMS_MISSING'],
  },
  { id: 'legal', label: 'Legal / org docs', category: 'Legal', tier: 'room_only', slot: null, engineInput: null },
  { id: 'title', label: 'Title', category: 'Legal', tier: 'room_only', slot: null, engineInput: null },
  { id: 'insurance', label: 'Insurance', category: 'Insurance', tier: 'room_only', slot: null, engineInput: null },
  { id: 'closing', label: 'Closing', category: 'Legal', tier: 'room_only', slot: null, engineInput: null },
  { id: 'leases', label: 'Leases', category: 'Legal', tier: 'room_only', slot: null, engineInput: null },
  // occupancy / lease-up history — operating data adjacent to the rent roll but
  // NOT a composer input (no occupancy extractor). Homed in 'Financial Statements'
  // beside the operating financials it belongs with (was 'Excels' when that bucket
  // was format-flavored; Excels is now seller_uw only).
  { id: 'occupancy', label: 'Occupancy / lease-up history', category: 'Financial Statements', tier: 'room_only', slot: null, engineInput: null },
  // sponsor_pfs (sponsor personal financial statement / REO schedule) is a borrower
  // CREDIT / financial doc — homed in 'Financial Statements' (Isabelle's call; the
  // prior 'General' placement treated it as an unclassifiable loose fit).
  { id: 'sponsor_pfs', label: 'Sponsor PFS / REO schedule', category: 'Financial Statements', tier: 'room_only', slot: null, engineInput: null },
  { id: 'phase_i_esa', label: 'Phase I ESA', category: 'Third-Party Reports', tier: 'room_only', slot: null, engineInput: null },
  // om (offering memorandum) is a marketing / offering document. The vision hints
  // OM≈prospectus→Legal, but an OM is not a binding legal instrument; sitting it
  // beside title/closing/loan_terms would imply it is. 'General' is the honest
  // home (never-misfile wins over the vision's optional Legal placement).
  { id: 'om', label: 'Offering memorandum (OM)', category: 'General', tier: 'room_only', slot: null, engineInput: null },
] as const;

/* ------------------------------------------------------------------ */
/* Derivations — the taxonomy is the source; these are pure projections */
/* ------------------------------------------------------------------ */

/** Entries that carry an upload slot (tiers 'ingesting' + 'stored'). */
export const SLOTTED_DOC_TYPES: readonly DocTypeEntry[] = DOC_TYPE_TAXONOMY.filter(
  (e): e is DocTypeEntry & { slot: DocTypeSlot } => e.slot !== null,
);

/** The upload-slot id list. Equivalent to SOURCE_DOC_SLOTS (order-independent). */
export const DOC_TYPE_SLOTS: readonly DocTypeSlot[] = SLOTTED_DOC_TYPES.map(
  (e) => e.slot as DocTypeSlot,
);

/** slot → engine input map (null = stored-not-extracted). Mirrors SLOT_TO_INPUT.
 *  The consistency test asserts this agrees with the real service map. */
export const SLOT_TO_ENGINE_INPUT: Readonly<Record<DocTypeSlot, EngineInputSlot | null>> =
  Object.fromEntries(
    SLOTTED_DOC_TYPES.map((e) => [e.slot as DocTypeSlot, e.engineInput]),
  ) as Record<DocTypeSlot, EngineInputSlot | null>;

/** SEAM 5 — DQ code → upload slot (the DQ-clearable presentation map).
 *  Derived from every entry that has BOTH a slot and dqCodes. Request-only
 *  doc types (loan_terms) are EXCLUDED here by construction (slot === null),
 *  which is exactly the JE_LOAN_TERMS_MISSING gap. Mirrors web DQ_UPLOAD_SLOT. */
export const DQ_CODE_TO_SLOT: Readonly<Record<string, DocTypeSlot>> = Object.fromEntries(
  DOC_TYPE_TAXONOMY.flatMap((e) =>
    e.slot !== null ? (e.dqCodes ?? []).map((code) => [code, e.slot as DocTypeSlot]) : [],
  ),
);

/** SEAM 5 — the DQ-clearable slot set is a documented SUBSET of upload slots.
 *  (rent_roll, cf, pca, appraisal — NOT asr [no DQ code], NOT seller_uw/t12
 *  [no DQ code], NOT loan_terms [no slot].) */
export const DQ_CLEARABLE_SLOTS: readonly DocTypeSlot[] = Array.from(
  new Set(Object.values(DQ_CODE_TO_SLOT)),
);

/** Look up a taxonomy entry by id. */
export function docTypeById(id: string): DocTypeEntry | undefined {
  return DOC_TYPE_TAXONOMY.find((e) => e.id === id);
}

/** Look up a taxonomy entry by upload-slot id. */
export function docTypeBySlot(slot: DocTypeSlot): DocTypeEntry | undefined {
  return DOC_TYPE_TAXONOMY.find((e) => e.slot === slot);
}

/* ------------------------------------------------------------------ */
/* Category derivations — the human folder above doc-types            */
/* ------------------------------------------------------------------ */

/** docType id → category. Pure projection of the entry's `category` field; the
 *  ONE source is DOC_TYPE_TAXONOMY (no parallel category list anywhere). Used by
 *  the data-room download path tree and the by-category store projection. */
export const DOC_TYPE_CATEGORY: Readonly<Record<string, DocTypeCategory>> = Object.fromEntries(
  DOC_TYPE_TAXONOMY.map((e) => [e.id, e.category]),
);

/** Look up the category for a docType id (undefined if unknown). */
export function categoryOfDocType(docTypeId: string): DocTypeCategory | undefined {
  return DOC_TYPE_CATEGORY[docTypeId];
}

/** Doc-type ids grouped by category, categories emitted in CATEGORIES_IN_ORDER,
 *  and within a category in taxonomy order. Only categories that actually own a
 *  doc-type are emitted. */
export function docTypesByCategory(): ReadonlyArray<{
  readonly category: DocTypeCategory;
  readonly docTypes: readonly DocTypeEntry[];
}> {
  return CATEGORIES_IN_ORDER.map((category) => ({
    category,
    docTypes: DOC_TYPE_TAXONOMY.filter((e) => e.category === category),
  })).filter((g) => g.docTypes.length > 0);
}

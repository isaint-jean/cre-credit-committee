/**
 * Doc-type taxonomy consistency guard — regression test.
 *
 *   npm run check:doctype-taxonomy
 *   tsx src/scripts/check-doctype-taxonomy.ts
 *
 * What this guards (Data-Room Phase 1, Deliverable 1):
 *
 *   The @cre/contracts DOC_TYPE_TAXONOMY is the SINGLE authoritative source of
 *   truth for the CRE data-room / intake doc types. Historically four parallel
 *   lists carried overlapping slices of this knowledge. To ensure the taxonomy
 *   is NOT a 4th parallel list, each existing consumer is either DERIVED from it
 *   or CROSS-CHECKED against it here so nothing can silently drift:
 *
 *     1. SOURCE_DOC_SLOTS  (@cre/shared source-docs.ts)  — CROSS-CHECKED.
 *        Left in place (shared cannot depend on contracts without reversing the
 *        package layering, and `SourceDocSlot` types the ingest map). This test
 *        asserts the taxonomy's slotted doc types == SOURCE_DOC_SLOTS (as sets).
 *
 *     2. SLOT_TO_INPUT  (append-source-doc.service.ts)  — CROSS-CHECKED.
 *        INGEST-CRITICAL; deliberately NOT rewired. This test asserts it agrees
 *        with the taxonomy's SLOT_TO_ENGINE_INPUT map slot-for-slot.
 *
 *     3. DQ_UPLOAD_SLOT  (web RenderedAnalysisView.tsx)  — DERIVED.
 *        Re-expressed as `= DQ_CODE_TO_SLOT` (taxonomy derivation). This test
 *        pins the intended DQ-code → slot values so the derivation can't drift.
 *
 *     4. source_doc_types  (intake-completeness map / service)  — CROSS-CHECKED.
 *        Asserts every doc-type kind referenced by the 30 intake bindings is a
 *        known taxonomy id (the intake roster ⊆ taxonomy universe).
 *
 *   Plus the five divergence seams are asserted as encoded, not prose:
 *     SEAM 1 cf is composite → ['in_place','t12'] + 2 DQ codes.
 *     SEAM 2 loan_terms is request-only (slot=null, requestOnly, has a DQ code).
 *     SEAM 3 seller_uw / t12 are stored with engineInput=null.
 *     SEAM 4 asr has no DQ code (noDqCode).
 *     SEAM 5 DQ slots ⊂ input slots.
 *
 *   On any violation, throws and exits 1; run it in check:engines / CI to bind
 *   the four lists to the single source.
 */
import {
  DOC_TYPE_TAXONOMY,
  DOC_TYPE_SLOTS,
  SLOT_TO_ENGINE_INPUT,
  DQ_CODE_TO_SLOT,
  DQ_CLEARABLE_SLOTS,
  SLOTTED_DOC_TYPES,
  DOC_TYPE_CATEGORY,
  CATEGORIES_IN_ORDER,
  docTypesByCategory,
  docTypeById,
  type DocTypeSlot,
  type DocTypeCategory,
} from '@cre/contracts';
import { SOURCE_DOC_SLOTS } from '@cre/shared';
import { SLOT_TO_INPUT } from '../services/append-source-doc.service.js';
import { INTAKE_FIELD_BINDINGS } from '../services/intake-completeness.service.js';

class TaxonomyConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyConsistencyError';
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new TaxonomyConsistencyError(message);
}

function assertSameSet(a: readonly string[], b: readonly string[], label: string): void {
  const sa = new Set(a);
  const sb = new Set(b);
  const onlyA = [...sa].filter((x) => !sb.has(x));
  const onlyB = [...sb].filter((x) => !sa.has(x));
  assert(
    onlyA.length === 0 && onlyB.length === 0,
    `${label} disagree — only in taxonomy: [${onlyA.join(', ')}]; only in list: [${onlyB.join(', ')}]`,
  );
}

function main(): void {
  console.log('doc-type taxonomy consistency guard:');

  // ── LIST 1 — SOURCE_DOC_SLOTS (CROSS-CHECK) ────────────────────────────────
  assertSameSet(
    DOC_TYPE_SLOTS as readonly string[],
    SOURCE_DOC_SLOTS as readonly string[],
    'SOURCE_DOC_SLOTS vs taxonomy slotted doc-types',
  );
  console.log(`  ✓ SOURCE_DOC_SLOTS == taxonomy slots (${SOURCE_DOC_SLOTS.length}): [${[...SOURCE_DOC_SLOTS].join(', ')}]`);

  // ── LIST 2 — SLOT_TO_INPUT (CROSS-CHECK; ingest-critical, NOT rewired) ──────
  assertSameSet(
    Object.keys(SLOT_TO_INPUT),
    Object.keys(SLOT_TO_ENGINE_INPUT),
    'SLOT_TO_INPUT keys vs taxonomy SLOT_TO_ENGINE_INPUT keys',
  );
  for (const slot of Object.keys(SLOT_TO_INPUT) as DocTypeSlot[]) {
    const svc = SLOT_TO_INPUT[slot];
    const tax = SLOT_TO_ENGINE_INPUT[slot];
    assert(
      svc === tax,
      `SLOT_TO_INPUT['${slot}'] = ${String(svc)} but taxonomy engineInput = ${String(tax)}`,
    );
  }
  console.log('  ✓ SLOT_TO_INPUT (ingest-critical) agrees with taxonomy engineInput slot-for-slot');

  // ── LIST 3 — DQ_UPLOAD_SLOT (DERIVED from DQ_CODE_TO_SLOT) ──────────────────
  // Pin the intended DQ-code → slot values so the derivation can't drift.
  const EXPECTED_DQ_TO_SLOT: Readonly<Record<string, DocTypeSlot>> = {
    JE_RENT_ROLL_MISSING: 'rent_roll',
    JE_RENT_ROLL_UNIT_INCOMPLETE: 'rent_roll',
    JE_TRAILING_ACTUALS_MISSING: 'cf',
    JE_IN_PLACE_MISSING: 'cf',
    JE_PCA_MISSING: 'pca',
    JE_APPRAISAL_MISSING: 'appraisal',
  };
  assertSameSet(Object.keys(DQ_CODE_TO_SLOT), Object.keys(EXPECTED_DQ_TO_SLOT), 'DQ_CODE_TO_SLOT codes');
  for (const code of Object.keys(EXPECTED_DQ_TO_SLOT)) {
    assert(
      DQ_CODE_TO_SLOT[code] === EXPECTED_DQ_TO_SLOT[code],
      `DQ_CODE_TO_SLOT['${code}'] = ${String(DQ_CODE_TO_SLOT[code])} but expected ${EXPECTED_DQ_TO_SLOT[code]}`,
    );
  }
  // JE_LOAN_TERMS_MISSING must NOT resolve to a slot (request-only gap).
  assert(
    DQ_CODE_TO_SLOT['JE_LOAN_TERMS_MISSING'] === undefined,
    'JE_LOAN_TERMS_MISSING must be absent from DQ_CODE_TO_SLOT (request-only gap)',
  );
  console.log(`  ✓ DQ_UPLOAD_SLOT (web, derived) == DQ_CODE_TO_SLOT (${Object.keys(DQ_CODE_TO_SLOT).length} codes); JE_LOAN_TERMS_MISSING has no slot`);

  // ── LIST 4 — intake source_doc_types (CROSS-CHECK: roster ⊆ taxonomy) ───────
  // The intake roster works in SourceDocumentKind space, which SPLITS the `cf`
  // slot into its composite fanout targets (in_place / t12 — SEAM 1). So the
  // known universe = taxonomy ids ∪ every entry's composite targets. A kind
  // outside that union is a genuine drift.
  const knownKinds = new Set<string>(DOC_TYPE_TAXONOMY.map((e) => e.id));
  for (const e of DOC_TYPE_TAXONOMY) for (const c of e.composite ?? []) knownKinds.add(c);
  const intakeKinds = new Set<string>();
  for (const b of INTAKE_FIELD_BINDINGS) for (const k of b.source_doc_types) intakeKinds.add(k);
  const unknown = [...intakeKinds].filter((k) => !knownKinds.has(k));
  assert(
    unknown.length === 0,
    `intake source_doc_types references doc-type kinds absent from the taxonomy (ids ∪ composite fanout): [${unknown.join(', ')}]`,
  );
  // And confirm `in_place` is present ONLY via the cf composite (not a top-level
  // id) — i.e. the split is the taxonomy's, exactly as SEAM 1 documents it.
  assert(docTypeById('in_place') === undefined, 'in_place must not be a top-level taxonomy id (it is a cf composite target)');
  assert(intakeKinds.has('in_place'), 'intake roster expected to reference in_place (cf composite target)');
  console.log(`  ✓ intake source_doc_types (${intakeKinds.size} kinds) ⊆ taxonomy ids ∪ cf composite (in_place via cf)`);

  // ── SEAM 1 — cf is composite ───────────────────────────────────────────────
  const cf = docTypeById('cf');
  assert(cf !== undefined && cf.slot === 'cf', 'cf entry missing / wrong slot');
  assertSameSet(cf!.composite ?? [], ['in_place', 't12'], 'SEAM1 cf.composite');
  assertSameSet(cf!.dqCodes ?? [], ['JE_TRAILING_ACTUALS_MISSING', 'JE_IN_PLACE_MISSING'], 'SEAM1 cf.dqCodes');
  console.log('  ✓ SEAM 1: cf composite → [in_place, t12] + 2 DQ codes');

  // ── SEAM 2 — loan_terms is request-only ────────────────────────────────────
  const loanTerms = docTypeById('loan_terms');
  assert(loanTerms !== undefined, 'loan_terms entry missing');
  assert(loanTerms!.tier === 'room_only', 'SEAM2 loan_terms tier must be room_only');
  assert(loanTerms!.slot === null, 'SEAM2 loan_terms slot must be null (request-only)');
  assert(loanTerms!.requestOnly === true, 'SEAM2 loan_terms.requestOnly must be true');
  assertSameSet(loanTerms!.dqCodes ?? [], ['JE_LOAN_TERMS_MISSING'], 'SEAM2 loan_terms.dqCodes');
  console.log('  ✓ SEAM 2: loan_terms request-only (slot=null, requestOnly, JE_LOAN_TERMS_MISSING)');

  // ── SEAM 3 — seller_uw / t12 stored with null engine input ─────────────────
  for (const id of ['seller_uw', 't12']) {
    const e = docTypeById(id);
    assert(e !== undefined, `${id} entry missing`);
    assert(e!.tier === 'stored', `SEAM3 ${id} tier must be stored`);
    assert(e!.engineInput === null, `SEAM3 ${id} engineInput must be null`);
  }
  console.log('  ✓ SEAM 3: seller_uw / t12 tier=stored, engineInput=null');

  // ── SEAM 4 — asr has no DQ code ────────────────────────────────────────────
  const asr = docTypeById('asr');
  assert(asr !== undefined, 'asr entry missing');
  assert(asr!.noDqCode === true, 'SEAM4 asr.noDqCode must be true');
  assert((asr!.dqCodes ?? []).length === 0, 'SEAM4 asr must have no DQ codes');
  console.log('  ✓ SEAM 4: asr noDqCode (required-earlier, no missing-doc flag)');

  // ── SEAM 5 — DQ slots ⊂ input slots ────────────────────────────────────────
  const inputSlots = new Set(DOC_TYPE_SLOTS as readonly string[]);
  const strictSubset =
    DQ_CLEARABLE_SLOTS.every((s) => inputSlots.has(s)) &&
    DQ_CLEARABLE_SLOTS.length < inputSlots.size;
  assert(
    strictSubset,
    `SEAM5 DQ-clearable slots must be a strict subset of input slots — DQ: [${DQ_CLEARABLE_SLOTS.join(', ')}], input: [${[...inputSlots].join(', ')}]`,
  );
  console.log(`  ✓ SEAM 5: DQ-clearable slots (${DQ_CLEARABLE_SLOTS.length}) ⊂ input slots (${inputSlots.size})`);

  // ── Sanity — tier partition covers the required rosters ────────────────────
  const ingesting = DOC_TYPE_TAXONOMY.filter((e) => e.tier === 'ingesting').map((e) => e.id);
  const stored = DOC_TYPE_TAXONOMY.filter((e) => e.tier === 'stored').map((e) => e.id);
  const roomOnly = DOC_TYPE_TAXONOMY.filter((e) => e.tier === 'room_only').map((e) => e.id);
  assertSameSet(ingesting, ['asr', 'cf', 'rent_roll', 'pca', 'appraisal'], 'tier=ingesting roster');
  assertSameSet(stored, ['seller_uw', 't12'], 'tier=stored roster');
  assertSameSet(
    roomOnly,
    ['loan_terms', 'legal', 'title', 'insurance', 'closing', 'leases', 'occupancy', 'sponsor_pfs', 'phase_i_esa', 'om'],
    'tier=room_only roster',
  );
  assert(SLOTTED_DOC_TYPES.length === 7, `expected 7 slotted doc types, got ${SLOTTED_DOC_TYPES.length}`);
  console.log(`  ✓ tiers: ingesting(${ingesting.length}) + stored(${stored.length}) + room_only(${roomOnly.length}) = ${DOC_TYPE_TAXONOMY.length}`);

  // ── CATEGORY — every doc-type has a valid category (the human folder) ───────
  // Data Room v2 SLICE 1(C): a level ABOVE doc-types. One source (the entry's
  // `category` field); DOC_TYPE_CATEGORY / docTypesByCategory are derivations.
  const VALID_CATEGORIES = new Set<DocTypeCategory>(CATEGORIES_IN_ORDER);
  assert(CATEGORIES_IN_ORDER.length === new Set(CATEGORIES_IN_ORDER).size, 'CATEGORIES_IN_ORDER has duplicates');
  for (const e of DOC_TYPE_TAXONOMY) {
    assert(
      VALID_CATEGORIES.has(e.category),
      `doc-type '${e.id}' has invalid category '${String(e.category)}' (not in CATEGORIES_IN_ORDER)`,
    );
    assert(
      DOC_TYPE_CATEGORY[e.id] === e.category,
      `DOC_TYPE_CATEGORY['${e.id}'] = ${String(DOC_TYPE_CATEGORY[e.id])} but entry.category = ${e.category}`,
    );
  }
  // DOC_TYPE_CATEGORY covers EXACTLY the taxonomy ids (no drift either way).
  assertSameSet(Object.keys(DOC_TYPE_CATEGORY), DOC_TYPE_TAXONOMY.map((e) => e.id), 'DOC_TYPE_CATEGORY keys vs taxonomy ids');

  // The category grouping is COMPLETE and NON-LOSSY: every doc-type appears in
  // exactly one category group, and the union of groups == the whole taxonomy.
  const grouped = docTypesByCategory();
  const groupedIds = grouped.flatMap((g) => g.docTypes.map((d) => d.id));
  assert(groupedIds.length === DOC_TYPE_TAXONOMY.length, `docTypesByCategory emits ${groupedIds.length} doc-types, taxonomy has ${DOC_TYPE_TAXONOMY.length}`);
  assert(groupedIds.length === new Set(groupedIds).size, 'docTypesByCategory placed a doc-type in more than one category');
  assertSameSet(groupedIds, DOC_TYPE_TAXONOMY.map((e) => e.id), 'docTypesByCategory union vs taxonomy ids');
  for (const g of grouped) assert(VALID_CATEGORIES.has(g.category), `docTypesByCategory emitted unknown category '${String(g.category)}'`);

  // Pin the intended category MAP so the placement can't silently drift. Updated
  // to the Chunk-2 re-map (commit e45beb5): 'Excels' is now seller_uw ONLY (no
  // longer a format bucket) — cf/rent_roll/t12/occupancy moved to 'Financial
  // Statements' beside the operating financials they belong with; sponsor_pfs
  // moved General → 'Financial Statements' (a borrower credit doc, Isabelle's
  // call); insurance promoted Legal → its own 'Insurance' folder. The sole
  // remaining loose-fit is 'om' → General (never-misfile). These are the INTENDED
  // categories (each rationale is documented on the taxonomy entry), not whatever
  // the taxonomy happens to say.
  const EXPECTED_CATEGORY: Readonly<Record<string, DocTypeCategory>> = {
    asr: 'ASRs',
    cf: 'Financial Statements',
    rent_roll: 'Financial Statements',
    seller_uw: 'Excels',
    t12: 'Financial Statements',
    appraisal: 'Third-Party Reports',
    pca: 'Third-Party Reports',
    phase_i_esa: 'Third-Party Reports',
    legal: 'Legal',
    title: 'Legal',
    insurance: 'Insurance',
    closing: 'Legal',
    leases: 'Legal',
    occupancy: 'Financial Statements',
    loan_terms: 'Legal',
    sponsor_pfs: 'Financial Statements',
    om: 'General',
  };
  assertSameSet(Object.keys(EXPECTED_CATEGORY), DOC_TYPE_TAXONOMY.map((e) => e.id), 'EXPECTED_CATEGORY coverage vs taxonomy');
  for (const id of Object.keys(EXPECTED_CATEGORY)) {
    assert(
      DOC_TYPE_CATEGORY[id] === EXPECTED_CATEGORY[id],
      `category drift: '${id}' is '${String(DOC_TYPE_CATEGORY[id])}' but pinned to '${EXPECTED_CATEGORY[id]}'`,
    );
  }
  // ★ Loose-fit is NOT misfiled: 'om' must NOT land in Legal / Third-Party /
  // Excels (the never-misfile rule). Post-Chunk-2, 'om' is the ONLY loose-fit —
  // sponsor_pfs got a real home ('Financial Statements'), pinned above.
  for (const id of ['om']) {
    const cat = DOC_TYPE_CATEGORY[id];
    assert(
      cat !== 'Legal' && cat !== 'Third-Party Reports' && cat !== 'Excels',
      `loose-fit '${id}' must not be force-filed into Legal/Third-Party/Excels — got '${String(cat)}'`,
    );
  }
  const catCounts = grouped.map((g) => `${g.category}(${g.docTypes.length})`).join(' + ');
  console.log(`  ✓ category: every doc-type homed; groups complete & non-lossy: ${catCounts}`);
  console.log('  ✓ loose-fit honestly homed: om → General (never-misfile)');

  console.log('doc-type taxonomy consistency guard: ok');
}

try {
  main();
  process.exit(0);
} catch (err) {
  if (err instanceof TaxonomyConsistencyError) {
    console.error(`doc-type taxonomy consistency guard FAILED: ${err.message}`);
  } else {
    console.error('doc-type taxonomy consistency guard FAILED with unexpected error:', err);
  }
  process.exit(1);
}

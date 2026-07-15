/**
 * Intake-Completeness (field-level) — a DERIVED, ADVISORY meta-layer. Sibling to
 * `document-completeness.service.ts`; it does NOT extend that cell/registry
 * service (whose render-blank BLOCKED test is load-bearing for the A55/A56/A57
 * sentinels). This one answers a different question: for each of the 30 locked
 * INTAKE FIELDS, is the underwriting fact sourced, in-a-doc-but-not-extracted,
 * absent from every doc, or an underwriter decision?
 *
 * Correctness (see docs/recon/2026-07-01-intake-binding.md §3):
 *   K = the field's extraction_key (primary OR any fallback) resolves to a
 *       non-null / non-empty value on the projected analysis (spine overlay).
 *   D = at least one of the field's source_doc_types is present, using the SAME
 *       PRESENCE union as document-completeness (sourceDocumentKinds ∪
 *       populated-overlay implications). No-slot doc types → D=false structurally.
 *
 *   Ceiling-state, evaluated in this order (decision short-circuits, never nags):
 *     decision-blank        := tier === 'Decision'
 *     populated             := K
 *     in-PDF-not-extracted  := ¬K ∧ D
 *     not-in-any-doc        := ¬K ∧ ¬D
 *
 * Posture: ADVISORY only. This service NEVER blocks export. It reads extraction
 * keys, never writes them; doctrine stays frozen (annexA stays null — the
 * unwired whole-loan path resolves K=false and, with no slot, D=false → the
 * honest not-in-any-doc it deserves).
 *
 * The binding table below is the machine copy of docs/specs/
 * intake-completeness-map.json (the human-editable config-of-record). It is
 * embedded rather than imported because the map lives outside the api tsconfig
 * rootDir (./src) and must survive the dist build. Keep the two in sync — the
 * map JSON is authoritative for the field roster / keys / sources.
 */
import type { SourceDocumentKind } from '@cre/contracts';
import type { Analysis } from '@cre/shared';
import type { OverlayPresence } from './document-completeness.service.js';

// ---------------------------------------------------------------------------
// PRESENCE bridges — the SAME derivation document-completeness.service uses,
// specialized to the intake source_doc_types enum (SOURCE_DOCUMENT_KINDS).
// Kept local (not imported) because the doc-completeness bridges map to the
// registry SourceDocument space (rentRoll/t12/asr/pca/…), whereas the intake
// layer works directly in SourceDocumentKind space. D is computed here as the
// union of (a) kinds actually present on the ExtractionResult and (b) the kinds
// implied by a populated legacy overlay — the identical union PRESENCE uses.
// ---------------------------------------------------------------------------

/** Which SourceDocumentKind a populated legacy overlay implies is present. */
const OVERLAY_TO_KIND: Record<keyof OverlayPresence, SourceDocumentKind | null> = {
  t12Extraction: 't12',
  issuerUwExtraction: 'seller_uw',
  sourcesAndUses: 'asr',
  pcaExtraction: 'pca',
  partiesExtraction: 'asr',
  appraisalExtraction: 'appraisal',
};

// ---------------------------------------------------------------------------
// Binding table (machine copy of intake-completeness-map.json).
// ---------------------------------------------------------------------------

export type IntakeState =
  | 'populated'
  | 'in-PDF-not-extracted'
  | 'not-in-any-doc'
  | 'decision-blank';

export interface IntakeFieldBinding {
  readonly id: string;
  readonly section: string;
  readonly field: string;
  readonly feeds: string;
  readonly blocks_if_missing: string;
  readonly criticality: string;
  readonly tier: string;
  /** Primary extraction key ("none — …" for no-path / decision fields). */
  readonly extraction_key: string;
  readonly fallback_keys: readonly string[];
  readonly source_doc_types: readonly SourceDocumentKind[];
}

export interface IntakeFieldResult {
  readonly id: string;
  readonly section: string;
  readonly field: string;
  readonly state: IntakeState;
  readonly feeds: string;
  /** blocks_if_missing (the downstream this field gates). */
  readonly blocks: string;
  /** source_doc_types (where this fact usually lives). */
  readonly sources: readonly SourceDocumentKind[];
  readonly criticality: string;
  readonly tier: string;
}

export interface IntakeCompletenessSummary {
  readonly sourced: number;
  readonly total: number;
  /** in-PDF-not-extracted ∪ not-in-any-doc — the follow-up list. */
  readonly needs: readonly IntakeFieldResult[];
  readonly decisionBlanks: readonly IntakeFieldResult[];
  /** Required-criticality fields NOT populated — warns loudly, never blocks. */
  readonly requiredMissing: readonly IntakeFieldResult[];
}

export interface IntakeCompleteness {
  readonly fields: readonly IntakeFieldResult[];
  readonly summary: IntakeCompletenessSummary;
}

/**
 * The 30 locked intake bindings. Source of truth: docs/specs/
 * intake-completeness-map.json — keep in sync.
 */
export const INTAKE_FIELD_BINDINGS: readonly IntakeFieldBinding[] = [
  { id: 'gpr', section: 'Income', field: 'Gross potential rent (GPR)', feeds: 'Income build; rent-roll reconciliation', blocks_if_missing: "Income section can't be built", criticality: 'Required', tier: 'A', extraction_key: 'inPlace.income.grossPotentialRent', fallback_keys: ['asr.underwrittenCashFlows.t12.potentialGrossRevenue', 'asr.underwrittenCashFlows.uw.potentialGrossRevenue', 'rentRoll.summary.grossPotentialRent', 'underwrittenCashFlows.t12.potentialGrossRevenue', 'underwrittenCashFlows.uw.potentialGrossRevenue'], source_doc_types: ['rent_roll', 'asr', 'seller_uw'] },
  { id: 'in_place_noi', section: 'Income', field: 'In-place / T12 NOI', feeds: 'DSCR, debt yield, in-place value', blocks_if_missing: 'No in-place coverage metrics', criticality: 'Required', tier: 'A', extraction_key: 't12Actual.noi', fallback_keys: ['inPlace.noi', 't12Extraction.noi', 'asr.underwrittenCashFlows.t12.netOperatingIncome', 'underwrittenCashFlows.t12.netOperatingIncome'], source_doc_types: ['seller_uw', 't12', 'in_place', 'asr'] },
  { id: 'vacancy_credit_loss', section: 'Income', field: 'Vacancy / credit loss', feeds: 'Effective gross income', blocks_if_missing: 'EGI over/understated', criticality: 'Required', tier: 'B', extraction_key: 'inPlace.vacancyLoss', fallback_keys: ['t12Actual.vacancyLoss', 'appraisalExtraction.stabilizedProForma.vacancyLoss', 'appraisalExtraction.stabilizedProForma.creditLoss'], source_doc_types: ['rent_roll', 'appraisal', 'seller_uw', 'in_place'] },
  { id: 'opex', section: 'Income', field: 'Operating expenses (by line)', feeds: 'Expense ratio; NOI', blocks_if_missing: "NOI can't be computed", criticality: 'Required', tier: 'A', extraction_key: 't12Actual.totalOperatingExpenses', fallback_keys: ['sellerUwOperatingStatement.totalOperatingExpenses', 'inPlace.totalOperatingExpenses', 'appraisalExtraction.stabilizedProForma.totalOperatingExpenses'], source_doc_types: ['seller_uw', 't12', 'in_place', 'appraisal'] },
  { id: 'reimbursements', section: 'Income', field: 'Reimbursements / recoveries', feeds: 'Effective gross income', blocks_if_missing: 'Recoveries missing → EGI off', criticality: 'Enhancing', tier: 'B', extraction_key: 't12Actual.expenses.reimbursements', fallback_keys: ['appraisalExtraction.stabilizedProForma.netEffectiveReimbursements'], source_doc_types: ['appraisal', 'rent_roll', 'seller_uw'] },
  { id: 'stabilized_noi', section: 'Income', field: 'Stabilized pro-forma NOI', feeds: 'Stabilized value; exit metrics', blocks_if_missing: 'Stabilized metrics blank', criticality: 'Required', tier: 'B', extraction_key: 'appraisalExtraction.stabilizedProForma.netOperatingIncome', fallback_keys: ['sellerUw.underwrittenNOI', 'asr.underwrittenCashFlows.uw.netOperatingIncome'], source_doc_types: ['appraisal', 'asr', 'seller_uw'] },
  { id: 'as_is_value', section: 'Value', field: 'As-is appraised value', feeds: 'LTV; value basis', blocks_if_missing: 'Value defaults to loan-basis only', criticality: 'Required', tier: 'A', extraction_key: 'appraisalExtraction.asIsValue', fallback_keys: ['appraisalExtraction.valueConclusion', 'asr.impliedValue'], source_doc_types: ['appraisal', 'asr'] },
  { id: 'stabilized_value', section: 'Value', field: 'Stabilized / prospective value', feeds: 'Stabilized LTV; exit', blocks_if_missing: 'Stabilized LTV blank', criticality: 'Required', tier: 'A', extraction_key: 'appraisalExtraction.asStabilizedValue', fallback_keys: [], source_doc_types: ['appraisal', 'asr'] },
  { id: 'cap_rate', section: 'Value', field: 'Cap rate (as-is & stabilized basis)', feeds: 'Cap-rate comparison to comps', blocks_if_missing: 'Cap-rate comparison blocked', criticality: 'Required', tier: 'B', extraction_key: 'appraisalExtraction.overallCapRate', fallback_keys: ['appraisalExtraction.terminalCapRate', 'appraisalExtraction.capRate', 'asr.impliedCapRate'], source_doc_types: ['appraisal', 'asr'] },
  { id: 'extraordinary_assumptions', section: 'Value', field: 'Extraordinary assumptions / hypotheticals', feeds: 'Value reliability caveat', blocks_if_missing: 'Value read as unconditional', criticality: 'Enhancing', tier: 'B', extraction_key: 'none — not extracted today', fallback_keys: [], source_doc_types: ['appraisal'] },
  { id: 'loan_amount', section: 'Leverage & coverage', field: 'Loan amount / proceeds', feeds: 'LTV; debt yield; DSCR', blocks_if_missing: 'Leverage metrics blank', criticality: 'Required', tier: 'A', extraction_key: 'loanTerms.loanAmount', fallback_keys: ['asr.sourcesAndUses.loanAmount', 'sourcesAndUses.loanAmount', 'annexA.loanAmount'], source_doc_types: ['loan_terms', 'asr'] },
  { id: 'interest_rate', section: 'Leverage & coverage', field: 'Interest rate / coupon', feeds: 'Debt service; DSCR', blocks_if_missing: "DSCR can't compute", criticality: 'Required', tier: 'A', extraction_key: 'loanTerms.interestRate', fallback_keys: ['annexA.coupon'], source_doc_types: ['loan_terms', 'asr'] },
  { id: 'amortization', section: 'Leverage & coverage', field: 'Amortization / IO terms', feeds: 'Amortizing DSCR', blocks_if_missing: 'Amort DSCR blank', criticality: 'Required', tier: 'A', extraction_key: 'loanTerms.amortization', fallback_keys: ['loanTerms.interestOnlyPeriod', 'annexA.amortMonths', 'annexA.ioYears'], source_doc_types: ['loan_terms', 'asr'] },
  // The whole loan IS loanTerms.loanAmount — per whole-vs-piece doctrine the
  // extracted loanAmount is ALWAYS the whole ($400M for 640 = $300M senior +
  // $100M mezz); the trust PIECE lives on loanAmountTrustPiece (exposure only).
  // Bound here so a whole loan the engine already scored on isn't reported unsourced.
  { id: 'whole_loan_balance', section: 'Leverage & coverage', field: 'Whole-loan balance (if pari-passu)', feeds: 'Whole-loan debt yield', blocks_if_missing: 'Piece-level DY misleads', criticality: 'Required', tier: 'A', extraction_key: 'loanTerms.loanAmount', fallback_keys: ['annexA.pariPassuCombination.combinedCutOffBalance', 'sourcesAndUses.loanAmount', 'asr.sourcesAndUses.loanAmount'], source_doc_types: ['loan_terms', 'asr'] },
  { id: 'maturity', section: 'Leverage & coverage', field: 'Maturity / term', feeds: 'Refi / exit analysis', blocks_if_missing: 'Term metrics blank', criticality: 'Enhancing', tier: 'A', extraction_key: 'loanTerms.maturityDate', fallback_keys: ['annexA.maturityDate'], source_doc_types: ['loan_terms', 'asr'] },
  { id: 'physical_occupancy', section: 'Occupancy & rollover', field: 'Physical occupancy (current)', feeds: 'Occupancy basis; lease-up flag', blocks_if_missing: "Can't flag lease-up", criticality: 'Required', tier: 'A', extraction_key: 'appraisalExtraction.currentOccupancyPhysical', fallback_keys: ['rentRoll.summary.occupiedUnits', 'annexA.occupancyCurrent'], source_doc_types: ['rent_roll', 'appraisal'] },
  { id: 'anchor_tenant', section: 'Occupancy & rollover', field: 'Anchor tenant & % of NRA', feeds: 'Tenant concentration', blocks_if_missing: 'Concentration risk blank', criticality: 'Required', tier: 'B', extraction_key: 'rentRoll.units', fallback_keys: ['annexA.largestTenant'], source_doc_types: ['rent_roll'] },
  { id: 'lease_rollover', section: 'Occupancy & rollover', field: 'Lease expirations / rollover schedule', feeds: 'Rollover analysis', blocks_if_missing: 'Rollover risk blank', criticality: 'Required', tier: 'B', extraction_key: 'rentRoll.units', fallback_keys: ['annexA.leaseExpirationLargest'], source_doc_types: ['rent_roll'] },
  { id: 'gsa_lease_terms', section: 'Occupancy & rollover', field: 'GSA lease terms (renewal, termination)', feeds: 'Anchor durability', blocks_if_missing: 'Anchor rollover analysis blocked', criticality: 'Required', tier: 'B', extraction_key: 'none — not extracted today', fallback_keys: [], source_doc_types: ['appraisal'] },
  { id: 'walt', section: 'Occupancy & rollover', field: 'WALT (weighted avg lease term)', feeds: 'Rollover / exit', blocks_if_missing: 'WALT blank', criticality: 'Enhancing', tier: 'B', extraction_key: 'rentRoll.units', fallback_keys: ['appraisalExtraction.leasingAssumptions.avgLeaseTermMonths'], source_doc_types: ['rent_roll'] },
  { id: 'pca_immediate_repairs', section: 'Physical', field: 'Immediate repairs (PCA)', feeds: 'Immediate reserve sizing', blocks_if_missing: 'Immediate reserve unsized', criticality: 'Required', tier: 'A', extraction_key: 'pcaExtraction.immediateRepairs', fallback_keys: ['pca.immediateRepairs'], source_doc_types: ['pca'] },
  { id: 'replacement_reserves', section: 'Physical', field: 'Replacement reserves', feeds: 'Ongoing reserve line', blocks_if_missing: 'Reserve line blank', criticality: 'Required', tier: 'B', extraction_key: 'pcaExtraction.replacementReservesPerSfPerYearInflated', fallback_keys: ['pca.replacementReservesPerSfPerYearInflated', 'appraisalExtraction.perAppraisalReserves.replacementReserves'], source_doc_types: ['pca', 'appraisal'] },
  { id: 'year_built', section: 'Physical', field: 'Year built / renovated', feeds: 'Age & condition context', blocks_if_missing: 'Condition context missing', criticality: 'Enhancing', tier: 'A', extraction_key: 'appraisalExtraction.yearBuilt', fallback_keys: ['propertyMetadata.yearBuilt'], source_doc_types: ['appraisal', 'pca'] },
  { id: 'environmental_status', section: 'Environmental', field: 'Environmental status (Phase I REC)', feeds: 'Environmental risk line', blocks_if_missing: 'Env risk line blank', criticality: 'Required', tier: 'B', extraction_key: 'environmentalSummary.findingsAcceptable', fallback_keys: ['environmentalSummary.firm', 'environmentalSummary.phaseIReportDate', 'environmentalSummary.phaseIIRecommended', 'asr.environmentalSummary.findingsAcceptable'], source_doc_types: ['asr'] },
  { id: 'sponsor_net_worth', section: 'Sponsor', field: 'Sponsor net worth & liquidity', feeds: 'Recourse / guaranty analysis', blocks_if_missing: 'Guaranty analysis blocked', criticality: 'Required', tier: 'B', extraction_key: 'none — not extracted today', fallback_keys: [], source_doc_types: [] },
  { id: 'sponsor_track_record', section: 'Sponsor', field: 'Sponsor track record / prior defaults', feeds: 'Disqualifying-flag review', blocks_if_missing: 'Sponsor character unassessed', criticality: 'Required (screen)', tier: 'C', extraction_key: 'none — not extracted today', fallback_keys: [], source_doc_types: [] },
  { id: 'borrower_spe', section: 'Sponsor', field: 'Borrower / SPE structure', feeds: 'Recourse enforceability', blocks_if_missing: 'Structure risk blank', criticality: 'Enhancing', tier: 'B', extraction_key: 'none — not extracted today', fallback_keys: [], source_doc_types: [] },
  { id: 'final_reserves', section: 'Structure (decision)', field: 'Final underwritten reserves', feeds: 'Reserve conclusions', blocks_if_missing: '— (not missing)', criticality: 'Decision', tier: 'C', extraction_key: 'none — underwriter decision (deal room)', fallback_keys: [], source_doc_types: [] },
  { id: 'cash_management', section: 'Structure (decision)', field: 'Cash management / lockbox', feeds: 'Structure conclusions', blocks_if_missing: '— (not missing)', criticality: 'Decision', tier: 'C', extraction_key: 'none — underwriter decision (deal room)', fallback_keys: [], source_doc_types: [] },
  { id: 'recourse_conclusion', section: 'Structure (decision)', field: 'Recourse / guaranty conclusion', feeds: 'Structure conclusions', blocks_if_missing: '— (not missing)', criticality: 'Decision', tier: 'C', extraction_key: 'none — underwriter decision (deal room)', fallback_keys: [], source_doc_types: [] },
];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** true for the sentinel "no path" keys, which always resolve K=false. */
function isNoPathKey(key: string): boolean {
  return key.startsWith('none —') || key.startsWith('none -');
}

/**
 * Resolve a dotted path against a root object. Spine sub-records (inPlace,
 * t12Actual, loanTerms, asr, rentRoll, pca, appraisal, sellerUw,
 * sellerUwOperatingStatement, annexA, parties) live on
 * `analysis.extractionResult`; overlays (appraisalExtraction, pcaExtraction,
 * environmentalSummary, …) live directly on the analysis. We resolve against a
 * merged view where the overlay-scoped analysis wins at the top level and the
 * spine ExtractionResult is a fallback for the leading segment.
 */
function resolvePath(analysis: Analysis, path: string): unknown {
  const segments = path.split('.');
  const head = segments[0];
  const er = (analysis as { extractionResult?: unknown }).extractionResult;
  // Prefer the overlay-scoped analysis root; fall back to the spine ER for the
  // leading segment (inPlace / t12Actual / loanTerms / asr / rentRoll / …).
  let node: unknown;
  const analysisRecord = analysis as unknown as Record<string, unknown>;
  const fromAnalysis = analysisRecord[head];
  if (fromAnalysis !== undefined && fromAnalysis !== null) {
    node = fromAnalysis;
  } else if (er && typeof er === 'object' && head in (er as Record<string, unknown>)) {
    node = (er as Record<string, unknown>)[head];
  } else {
    node = fromAnalysis; // undefined/null — path dead-ends
  }
  for (let i = 1; i < segments.length; i++) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segments[i]];
  }
  return node;
}

/** A resolved value counts as present unless null/undefined/''/empty-array/all-null record. */
function isPresentValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') {
    // A sub-record is present only if at least one own value is itself present.
    return Object.values(v as Record<string, unknown>).some((x) => isPresentValue(x));
  }
  return true; // booleans (incl. false) are a real signal
}

/** K — does the primary or ANY fallback key resolve to a present value? */
function resolveK(analysis: Analysis, binding: IntakeFieldBinding): boolean {
  const keys = [binding.extraction_key, ...binding.fallback_keys];
  for (const key of keys) {
    if (isNoPathKey(key)) continue;
    if (isPresentValue(resolvePath(analysis, key))) return true;
  }
  return false;
}

/** The PRESENCE union of SourceDocumentKinds (kinds ∪ overlay-implied). */
function computePresentKinds(
  sourceDocumentKinds: readonly SourceDocumentKind[],
  overlayPresence: OverlayPresence,
): ReadonlySet<SourceDocumentKind> {
  const present = new Set<SourceDocumentKind>(sourceDocumentKinds);
  for (const [overlay, on] of Object.entries(overlayPresence)) {
    if (!on) continue;
    const kind = OVERLAY_TO_KIND[overlay as keyof OverlayPresence];
    if (kind) present.add(kind);
  }
  return present;
}

export interface IntakeCompletenessInput {
  readonly analysis: Analysis;
  readonly sourceDocumentKinds: readonly SourceDocumentKind[];
  readonly overlayPresence: OverlayPresence;
}

/** Compute the 30-field intake completeness ledger. ADVISORY — never blocks. */
export function computeIntakeCompleteness(input: IntakeCompletenessInput): IntakeCompleteness {
  const { analysis, sourceDocumentKinds, overlayPresence } = input;
  const presentKinds = computePresentKinds(sourceDocumentKinds, overlayPresence);

  const fields: IntakeFieldResult[] = INTAKE_FIELD_BINDINGS.map((b) => {
    const k = resolveK(analysis, b);
    const d = b.source_doc_types.some((kind) => presentKinds.has(kind));
    let state: IntakeState;
    if (b.tier === 'Decision' || b.criticality === 'Decision') {
      state = 'decision-blank'; // short-circuit — never nags
    } else if (k) {
      state = 'populated';
    } else if (d) {
      state = 'in-PDF-not-extracted';
    } else {
      state = 'not-in-any-doc';
    }
    return {
      id: b.id,
      section: b.section,
      field: b.field,
      state,
      feeds: b.feeds,
      blocks: b.blocks_if_missing,
      sources: b.source_doc_types,
      criticality: b.criticality,
      tier: b.tier,
    };
  });

  const decisionBlanks = fields.filter((f) => f.state === 'decision-blank');
  const needs = fields.filter(
    (f) => f.state === 'in-PDF-not-extracted' || f.state === 'not-in-any-doc',
  );
  const sourced = fields.filter((f) => f.state === 'populated').length;
  // total = the sourceable universe (exclude decision-blanks — they are not "missing").
  const total = fields.length - decisionBlanks.length;
  const requiredMissing = fields.filter(
    (f) =>
      f.state !== 'populated' &&
      f.state !== 'decision-blank' &&
      f.criticality.startsWith('Required'),
  );

  return {
    fields,
    summary: { sourced, total, needs, decisionBlanks, requiredMissing },
  };
}

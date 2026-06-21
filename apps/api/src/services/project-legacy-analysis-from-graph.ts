/**
 * Read-through projection — overlay graph substrate onto a legacy Analysis.
 *
 * When a legacy Analysis carries `graphRevisionId` (set by the promote-from-graph
 * operation), this projection fills the legacy substrate fields from the linked
 * new-spine records (NarrativeEvaluation, DoctrineEvaluation) so the legacy view
 * renders real handbook output instead of legacy LLM output.
 *
 * Current scope:
 *   - executiveSummary     ← NarrativeEvaluation.executiveSummary
 *   - creditScore          ← DoctrineEvaluation.{finalScore, ratingBand, componentScores}
 *   - uwModel              ← synthesizeUwModelFromGraph (AdjustedInputs +
 *                             StressOutputs + PropertyMetadata best-effort);
 *                             ONLY when the legacy uwModel is null. Preserves
 *                             any analyst-edited legacy uwModel that's already
 *                             populated.
 *   - stressScenarios      ← StressOutputs.scenarios[] (legacy stress shape);
 *                             ONLY when the legacy stressScenarios is empty.
 *                             Promoted records preload graph-computed scenarios
 *                             so the stress tab shows real results without a
 *                             manual click.
 *   - mitigationsNarrative ← NarrativeEvaluation.mitigationSuggestions (prose).
 *                             Read-time only — the legacy mitigations[] cards
 *                             array is left untouched. The page chooses which
 *                             surface to render based on graphRevisionId.
 *
 * Fallback: when `graphRevisionId` is null/undefined, OR when any of the linked
 * records cannot be resolved, the corresponding legacy field is left unchanged —
 * preserving legacy behavior for unlinked analyses and degrading gracefully for
 * partial graph state.
 *
 * Numbers projected into legacy must match what the new-spine view would show.
 * `rendered-analysis.ts` projects `DoctrineEvaluation.componentScores` as
 * `RenderedComponentScore[]` with renamed `componentId → name` (bijective
 * passthrough); this projector applies the same bijection into the legacy
 * `CreditScoreCategory[]` shape, so the Score tab and the new-spine view
 * agree on the score values.
 */

import {
  NARRATIVE_ENGINE_VERSION,
  SNAPSHOT_PRODUCER_VERSION,
  type CrossCheckResult,
  type DoctrineComponentScore,
  type DoctrineEvaluation,
  type DoctrineRenderSnapshot,
  type ExtractionResultId,
  type FiredFlag,
  type HandbookEvaluation,
  type NarrativeEvaluation,
  type RatingBand,
  type RevisionId,
  type RiskType,
  type StressOutputs,
  type StressScenarioOutput,
} from '@cre/contracts';
import { handbook } from '@cre/handbook-data';
import type {
  Analysis,
  CreditScore,
  CreditScoreCategory,
  Finding,
  FindingCategory,
  Recommendation,
  Severity,
  StressScenario,
  ValidationCheck,
  ValidationResult,
} from '@cre/shared';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import { synthesizeUwModelFromGraph } from './synthesize-uw-model-from-graph.js';

export function projectLegacyAnalysisFromGraph(
  analysis: Analysis,
  store: RecordGraphStore,
): Analysis {
  const link = analysis.graphRevisionId;
  if (link === null || link === undefined || link.length === 0) {
    return analysis;
  }

  const envelope = store.getRevisionEnvelope(link as RevisionId);
  if (envelope === null) {
    return analysis;
  }

  const narrative = store.getLatestNarrativeForAdjustedInputs(
    envelope.adjustedInputsId,
    NARRATIVE_ENGINE_VERSION,
  );
  const doctrine = store.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  const handbook = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  const crossCheck = doctrine !== null
    ? store.getCrossCheckResult(doctrine.crossCheckResultId)
    : null;

  // Independent fallbacks: if NE is missing keep legacy executiveSummary; if DE
  // is missing keep legacy creditScore. Either projection alone is still useful.
  const projectedExecutiveSummary = narrative !== null
    ? projectExecutiveSummary(narrative)
    : analysis.executiveSummary;
  // PR (ii) — snapshot-aware projection. Pull the snapshot (if present) so
  // projectCreditScore can read the new-doctrine recommendation from it
  // instead of falling back to the legacy `'further_review'` constant.
  const renderSnapshot = doctrine !== null
    ? store.getDoctrineRenderSnapshot(envelope.doctrineEvaluationId)
    : null;
  const projectedCreditScore = doctrine !== null
    ? projectCreditScore(doctrine, renderSnapshot)
    : analysis.creditScore;

  // uwModel: synthesize ONLY when the legacy slot is null (promote-from-graph
  // initial state). If an analyst-edited legacy uwModel already exists, keep it.
  // If synthesis returns null (graph chain doesn't resolve), keep whatever's
  // there. The synthesis function performs its own envelope lookup, so this
  // overlay is safe to call without precomputed records.
  const projectedUwModel = analysis.uwModel === null
    ? (synthesizeUwModelFromGraph(link as RevisionId, store) ?? analysis.uwModel)
    : analysis.uwModel;

  // stressScenarios: project from StressOutputs ONLY when the legacy
  // stressScenarios array is empty (promote-from-graph initial state). Any
  // already-populated legacy stress (e.g. from a prior handleRunStress) is
  // preserved. DE resolution gates this: without DE we can't reach
  // stressOutputsId, so the projection is short-circuited.
  let projectedStressScenarios = analysis.stressScenarios;
  if ((analysis.stressScenarios?.length ?? 0) === 0 && doctrine !== null) {
    const stressOutputs = store.getStressOutputs(doctrine.stressOutputsId);
    if (stressOutputs !== null) {
      projectedStressScenarios = projectStressScenarios(stressOutputs);
    }
  }

  // mitigationsNarrative: passthrough of NE.mitigationSuggestions when NE
  // resolves; null otherwise. Independent of the legacy `mitigations[]` cards
  // — the projector never touches that array. The page chooses which surface
  // to render based on analysis.graphRevisionId.
  const projectedMitigationsNarrative = narrative !== null
    ? narrative.mitigationSuggestions
    : (analysis.mitigationsNarrative ?? null);

  // SUNROAD-UI-FIX — 5 missing tile-facing surfaces.
  //
  // findings: bijective 1:1 map from handbook firedFlags. Only overlay when
  // the legacy slot is the promote-from-graph empty [] (don't clobber any
  // analyst-edited legacy findings).
  let projectedFindings = analysis.findings;
  if ((analysis.findings?.length ?? 0) === 0 && handbook !== null) {
    projectedFindings = handbook.firedFlags.map(projectFinding);
  }

  // Version-info fields: project only when each legacy slot is empty —
  // preserves any analyst-set legacy values.
  const projectedInputHash = (analysis.inputHash && analysis.inputHash.length > 0)
    ? analysis.inputHash
    : (doctrine !== null ? (doctrine.extractionResultId as string) : analysis.inputHash);

  const projectedManifestoVersion = (analysis.manifestoVersion && analysis.manifestoVersion.length > 0)
    ? analysis.manifestoVersion
    : (handbook !== null ? `handbook ${handbook.handbookVersion}` : analysis.manifestoVersion);

  const projectedModelLogicVersion = (analysis.modelLogicVersion && analysis.modelLogicVersion.length > 0)
    ? analysis.modelLogicVersion
    : formatModelLogicVersion(envelope.doctrineVersion, envelope.judgmentEngineVersion, narrative);

  // validationResult: derive from cross-check honestly.
  //   findings.length > 0 → passed:false, each finding as a check entry.
  //   findings.length === 0 AND bias === 'neutral' → passed:true, one summary check
  //     ("Cross-check produced no conservatism findings; bias neutral").
  //   Else (rare: empty findings but non-neutral bias) → leave undefined →
  //     UI shows "NOT VALIDATED" (more honest than fake-pass).
  const projectedValidationResult = analysis.validationResult !== undefined
    ? analysis.validationResult
    : (crossCheck !== null ? projectValidationResult(crossCheck) : undefined);

  // Sprint-0: PropertyMetadata read-side projection. The ingest writes PM to
  // the property_metadata table and links it to the ExtractionResult via the
  // extraction_input_cache row; here we resolve it back so
  // hydrateUnderwritingContext.buildPropertyAtoms reads `analysis.propertyMetadata`
  // as PRIMARY (per the precedence at hydrate-underwriting-context.ts:147)
  // and the V9_SHARED_ENTRIES `c.property.*` selectors populate. Only overlay
  // when the legacy slot is empty — preserves analyst-edited PM. Resolution
  // requires the doctrine to be present (we need the extractionResultId join).
  let projectedPropertyMetadata = analysis.propertyMetadata;
  if (
    (projectedPropertyMetadata === null || projectedPropertyMetadata === undefined) &&
    doctrine !== null
  ) {
    const pm = store.getPropertyMetadataByExtractionResultId(
      doctrine.extractionResultId as ExtractionResultId,
    );
    if (pm !== null) projectedPropertyMetadata = pm;
  }

  // Appraisal read-side projection (mirrors PCA/issuerUw seam). Lifts
  // er.appraisal off the graph store when the legacy slot is empty —
  // NULL-only fill, never clobber an analyst-edited value. With the
  // composer now populating er.appraisal via the appraisal.adapter,
  // this overlay is what carries it through to analysis.appraisalExtraction
  // and from there to every c.appraisal.* atom + render-schema selector.
  let projectedAppraisalExtraction = analysis.appraisalExtraction;
  if (
    (projectedAppraisalExtraction === null || projectedAppraisalExtraction === undefined) &&
    doctrine !== null
  ) {
    const er = store.getExtractionResult(doctrine.extractionResultId);
    if (er?.appraisal) projectedAppraisalExtraction = er.appraisal;
  }

  // Parties read-side projection (mirrors the appraisal seam). With
  // asr.adapter now producing parties as a 4th sub-extractor and the
  // composer threading it through er.parties, this overlay carries it
  // to analysis.partiesExtraction. NULL-only fill — never overwrite
  // an analyst-edited value. buildPartyAtoms reads
  // analysis.partiesExtraction PRIMARY (legacy descriptors FALLBACK).
  let projectedPartiesExtraction = analysis.partiesExtraction;
  if (
    (projectedPartiesExtraction === null || projectedPartiesExtraction === undefined) &&
    doctrine !== null
  ) {
    const er = store.getExtractionResult(doctrine.extractionResultId);
    if (er?.parties) projectedPartiesExtraction = er.parties;
  }

  // Sources & Uses read-side projection (mirrors the appraisal / parties seam).
  // The ASR sub-extractor parses the S&U table onto er.asr.sourcesAndUses; this
  // overlay carries it to analysis.sourcesAndUses and from there to the
  // c.sourcesAndUses.* atoms + render-schema v14 selectors. NULL-only fill.
  let projectedSourcesAndUses = analysis.sourcesAndUses;
  if (
    (projectedSourcesAndUses === null || projectedSourcesAndUses === undefined) &&
    doctrine !== null
  ) {
    const er = store.getExtractionResult(doctrine.extractionResultId);
    if (er?.asr?.sourcesAndUses) projectedSourcesAndUses = er.asr.sourcesAndUses;
  }

  // Sunroad appraisal-ingest: merge AppraisalExtraction identity fields into
  // PropertyMetadata where PM is null (NEVER overwrite the ASR-AI source per
  // Sprint-0 honest-blank discipline). Fills address/zip/county/yearBuilt
  // when the appraisal supplies them. Reads `projectedAppraisalExtraction`
  // (preferred — picks up the composer-populated value) and falls back to
  // `analysis.appraisalExtraction` for older persist-script-populated rows.
  const appraisal = projectedAppraisalExtraction;
  if (appraisal && projectedPropertyMetadata) {
    projectedPropertyMetadata = {
      ...projectedPropertyMetadata,
      address:    projectedPropertyMetadata.address    ?? appraisal.addressFull ?? null,
      zip:        projectedPropertyMetadata.zip        ?? appraisal.zip ?? null,
      county:     projectedPropertyMetadata.county     ?? appraisal.county ?? null,
      yearBuilt:  projectedPropertyMetadata.yearBuilt  ?? appraisal.yearBuilt ?? null,
    };
  }

  // Sprint-2 PCA read-side projection. analysis.pcaExtraction is sourced
  // from the graph store's ExtractionResult.pca; we surface only the PCA
  // sub-record so the legacy ExtractionResult shape (different contract,
  // pre-spine) is not entangled. Mirrors the appraisalExtraction overlay
  // semantics: pure read-side, NULL-only fill, no overwrite of an
  // analyst-edited value.
  let projectedPcaExtraction = analysis.pcaExtraction;
  let projectedIssuerUwExtraction = analysis.issuerUwExtraction;
  // T12 historical overlay — analysis.t12Extraction PRIMARY (stamped on the
  // analyses row), fallback er.t12Actual. Mirrors the issuer-UW seam.
  let projectedT12Extraction = analysis.t12Extraction;
  if (
    (projectedPcaExtraction === null || projectedPcaExtraction === undefined ||
     projectedIssuerUwExtraction === null || projectedIssuerUwExtraction === undefined ||
     projectedT12Extraction === null || projectedT12Extraction === undefined) &&
    doctrine !== null
  ) {
    const er = store.getExtractionResult(doctrine.extractionResultId);
    if (er?.pca && (projectedPcaExtraction === null || projectedPcaExtraction === undefined)) {
      projectedPcaExtraction = er.pca;
    }
    if (er?.sellerUwOperatingStatement && (projectedIssuerUwExtraction === null || projectedIssuerUwExtraction === undefined)) {
      projectedIssuerUwExtraction = er.sellerUwOperatingStatement;
    }
    if (er?.t12Actual && (projectedT12Extraction === null || projectedT12Extraction === undefined)) {
      projectedT12Extraction = er.t12Actual;
    }
  }

  return {
    ...analysis,
    executiveSummary: projectedExecutiveSummary,
    creditScore: projectedCreditScore,
    uwModel: projectedUwModel,
    stressScenarios: projectedStressScenarios,
    mitigationsNarrative: projectedMitigationsNarrative,
    findings: projectedFindings,
    inputHash: projectedInputHash,
    manifestoVersion: projectedManifestoVersion,
    modelLogicVersion: projectedModelLogicVersion,
    validationResult: projectedValidationResult,
    propertyMetadata: projectedPropertyMetadata,
    pcaExtraction: projectedPcaExtraction,
    issuerUwExtraction: projectedIssuerUwExtraction,
    t12Extraction: projectedT12Extraction,
    appraisalExtraction: projectedAppraisalExtraction,
    partiesExtraction: projectedPartiesExtraction,
    sourcesAndUses: projectedSourcesAndUses,
  };
}

/**
 * Project graph StressOutputs into legacy StressScenario[] shape.
 *
 * Field map (StressScenarioOutput → StressScenario):
 *   - name                     ← name (verbatim)
 *   - results.noi              ← noi (null coerced to 0 — legacy requires
 *                                 number; graph noi may be null for
 *                                 not-computable scenarios)
 *   - results.dscr/ltv/        ← passthrough (legacy already nullable)
 *     debtYield/impliedValue
 *   - results.dscrBreached/    ← breaches.includes(metric) ? true :
 *     ltvBreached/                skipped.includes(metric) ? null : false
 *     debtYieldBreached
 *   - breaksCovenants          ← breaches.length > 0
 *   - covenantBreaches         ← humanized breach strings
 *   - covenantSkips            ← humanized skip strings
 *   - adjustments              ← all zeros (graph stores STRESS_METHOD per-run,
 *                                 not per-scenario delta values; the legacy
 *                                 adjustments object isn't displayed in the
 *                                 stress tab — purely structural).
 */
function projectStressScenarios(stressOutputs: StressOutputs): StressScenario[] {
  return stressOutputs.scenarios.map(projectStressScenario);
}

function projectStressScenario(s: StressScenarioOutput): StressScenario {
  const dscrBreached = breachFlag(s.breaches, s.skipped, 'DSCR');
  const ltvBreached = breachFlag(s.breaches, s.skipped, 'LTV');
  const debtYieldBreached = breachFlag(s.breaches, s.skipped, 'DEBT_YIELD');
  return {
    name: s.name,
    adjustments: { vacancyDelta: 0, rentDelta: 0, capRateDelta: 0, interestRateDelta: 0 },
    results: {
      noi: s.noi ?? 0,
      dscr: s.dscr,
      ltv: s.ltv,
      debtYield: s.debtYield,
      impliedValue: s.value,
      dscrBreached,
      ltvBreached,
      debtYieldBreached,
    },
    breaksCovenants: s.breaches.length > 0,
    covenantBreaches: s.breaches.map(humanizeBreach),
    covenantSkips: s.skipped.map(humanizeBreach),
  };
}

function breachFlag(
  breaches: readonly StressScenarioOutput['breaches'][number][],
  skipped: readonly StressScenarioOutput['skipped'][number][],
  metric: 'DSCR' | 'LTV' | 'DEBT_YIELD',
): boolean | null {
  if (breaches.includes(metric)) return true;
  if (skipped.includes(metric)) return null;
  return false;
}

function humanizeBreach(b: 'DSCR' | 'LTV' | 'DEBT_YIELD'): string {
  switch (b) {
    case 'DSCR':       return 'DSCR covenant';
    case 'LTV':        return 'LTV covenant';
    case 'DEBT_YIELD': return 'Debt Yield covenant';
  }
}

function projectExecutiveSummary(narrative: NarrativeEvaluation): string {
  return narrative.executiveSummary;
}

/**
 * Project DoctrineEvaluation → legacy CreditScore.
 *
 * Mapped fields:
 *   - overall          ← finalScore (rounded; legacy display is an int)
 *   - riskTier         ← ratingBand mapped to legacy 4-tier vocabulary
 *   - categories[]     ← componentScores[] (bijective, see projectCategory)
 *
 * Unmapped fields (no DoctrineEvaluation source — defaulted):
 *   - recommendation   = 'further_review' (safe non-actionable)
 *   - narrative        = '' (Score tab hides the card when falsy)
 *   - whyThisScore     = ''
 *   - howToImprove     = ''
 *
 * Per-category `tier` is intentionally left undefined here; the route handler
 * re-runs `applyCreditPolicyBandsToAnalysis` after projection, which decorates
 * each category with the doctrine-owned `classifyCategoryTier(score)` band.
 */
function projectCreditScore(
  doctrine: DoctrineEvaluation,
  renderSnapshot: DoctrineRenderSnapshot | null,
): CreditScore {
  // Sunroad-UI-fix Part B: thread the doctrine coverage-gate signal so the
  // UI can render "InsufficientData" instead of a misleading "0/100".
  //   When the engine's coverage gate fired, doctrine.flags includes
  //   'INSUFFICIENT_COVERAGE_GATE' AND finalScore is clamped to 0. That 0 is
  //   a sentinel ("refuse to rate"), NOT a real score — surface that as a
  //   distinct riskTier value rather than rendering it as a number.
  const gated = doctrine.flags.includes('INSUFFICIENT_COVERAGE_GATE');
  // PR (ii) — recommendation comes from the snapshot when present + supported
  // (true new-doctrine verdict). Without a snapshot the rating card
  // continues to show the legacy `'further_review'` sentinel — the safe
  // non-actionable signal indicating the rating axis isn't decided here.
  return {
    overall: Math.round(doctrine.finalScore),
    categories: doctrine.componentScores.map(projectCategory),
    recommendation: recommendationFromSnapshot(renderSnapshot),
    narrative: '',
    riskTier: gated ? 'insufficient_data' : ratingBandToRiskTier(doctrine.ratingBand),
    whyThisScore: '',
    howToImprove: '',
  };
}

/**
 * Map the snapshot's new-doctrine recommendation to the legacy `Recommendation`
 * union. Producer-side widths must match (see DoctrineRenderSnapshot contract);
 * widening producer → reader is a coordinated SNAPSHOT_PRODUCER_VERSION bump.
 *
 *   Approve              → 'approve'
 *   ApproveWithConditions → 'approve_with_conditions'
 *   Decline              → 'decline'
 *   InsufficientData     → 'further_review'   (legacy non-actionable)
 */
function recommendationFromSnapshot(
  renderSnapshot: DoctrineRenderSnapshot | null,
): Recommendation {
  if (renderSnapshot === null) return 'further_review';
  if (renderSnapshot.snapshotProducerVersion !== SNAPSHOT_PRODUCER_VERSION) return 'further_review';
  switch (renderSnapshot.rating.recommendation) {
    case 'Approve':                return 'approve';
    case 'ApproveWithConditions':  return 'approve_with_conditions';
    case 'Decline':                return 'decline';
    case 'InsufficientData':       return 'further_review';
  }
}

function projectCategory(c: DoctrineComponentScore): CreditScoreCategory {
  return {
    // Vocabulary mismatch — DoctrineComponentId is not in the FindingCategory
    // enum, but page.tsx displays it via `cat.category.replace('_', ' ')`
    // which renders cleanly ("Market Alignment", "Data Confidence"). Mirrors
    // rendered-analysis.ts:197 which uses componentId directly as `name`.
    category: c.componentId as unknown as FindingCategory,
    score: c.score,
    maxScore: 100,
    weight: c.weight,
    weightedScore: c.contribution,
    findings: [],
    explanation: '',
  };
}

/**
 * Map doctrine 4-band vocabulary to legacy 4-tier vocabulary.
 *   Strong     (>=75) → strong
 *   Acceptable (>=60) → acceptable
 *   Weak       (>=50) → watchlist   (closest analog; both yellow-zone)
 *   High Risk  (>= 0) → high_risk
 *
 * The two threshold sets are NOT aligned (doctrine: 75/60/50/0; legacy:
 * 85/70/50/—). When projecting, the DOCTRINE band wins per "numbers projected
 * into legacy must match what the new-spine view would show".
 */
function ratingBandToRiskTier(band: RatingBand): CreditScore['riskTier'] {
  switch (band) {
    case 'Strong':     return 'strong';
    case 'Acceptable': return 'acceptable';
    case 'Weak':       return 'watchlist';
    case 'High Risk':  return 'high_risk';
  }
}

/* ----------------------- Sunroad-UI-fix helpers --------------------------- */

/**
 * Map a handbook FiredFlag (the new-spine truth) → legacy Finding shape.
 * Bijective 1:1 — every fired flag becomes exactly one Finding, no drops,
 * no duplicates, no invented entries. Severity passes through verbatim
 * (FiredFlag.severity and legacy Severity share the same 4-tier vocabulary
 * 'critical' | 'high' | 'medium' | 'low').
 *
 * Category derives from the principle-id prefix (legacy field, kept for
 * downstream compatibility):
 *   P-I-*   → 'sponsor'        (sponsor / borrower)
 *   P-II-*  → 'cash_flow'      (income / NOI / data quality)
 *   P-III-* → 'loan_structure' (stress / leverage / refi)
 *   P-IV-*  → 'expense'        (reserves / capital)
 *   else    → 'market'         (fallback)
 *
 * riskType is the content-driven category for the UI's Red Flags card
 * header. Source of truth is the principle definition in handbook.json
 * (Principle.riskType). The projector reads it at read time from the
 * loaded handbook catalog — no eval-time denormalization, no payload
 * migration. Fallback 'risk_flag' if the principleId isn't in the
 * catalog (impossible by design today; defensive only).
 *
 * Title is the first sentence of flag_message (or the whole message when
 * short); explanation is the full flag_message; pageReferences is empty
 * because FiredFlag carries no document anchors today.
 */
function projectFinding(flag: FiredFlag): Finding {
  const msg = flag.flag_message ?? '';
  const firstSentenceEnd = msg.search(/[.!?](\s|$)/);
  const title = firstSentenceEnd > 20
    ? msg.slice(0, firstSentenceEnd + 1)
    : (msg.length > 0 ? msg.slice(0, 120) : flag.principleId);
  return {
    id: flag.principleId,
    category: categoryForPrincipleId(flag.principleId),
    riskType: riskTypeForPrincipleId(flag.principleId),
    severity: flag.severity as Severity,
    title,
    explanation: msg,
    confidence: 'high',
    pageReferences: [],
    appliedRuleId: flag.principleId,
    impact: { description: msg },
  };
}

const RISK_TYPE_BY_PRINCIPLE_ID: ReadonlyMap<string, RiskType> = new Map(
  handbook.principles.map((p) => [p.id, p.riskType] as const),
);

function riskTypeForPrincipleId(principleId: string): RiskType | 'risk_flag' {
  return RISK_TYPE_BY_PRINCIPLE_ID.get(principleId) ?? 'risk_flag';
}

function categoryForPrincipleId(principleId: string): FindingCategory {
  if (principleId.startsWith('P-I-'))   return 'sponsor';
  if (principleId.startsWith('P-II-'))  return 'cash_flow';
  if (principleId.startsWith('P-III-')) return 'loan_structure';
  if (principleId.startsWith('P-IV-'))  return 'expense';
  return 'market';
}

/**
 * Compose the legacy `modelLogicVersion` display string from the envelope's
 * version fields + the narrative-engine version. Compact format fits the
 * UI's `text-text-primary font-mono` tile.
 *
 * The envelope carries doctrine + judgment + stress + valuation versions;
 * the narrative engine version is on the narrative payload itself. Mitigation
 * engine isn't versioned per-record (uses MITIGATION_ENGINE_VERSION constant
 * from contracts), so it's not surfaced here.
 */
function formatModelLogicVersion(
  doctrineVersion: string,
  judgmentEngineVersion: string,
  narrative: NarrativeEvaluation | null,
): string {
  const parts = [`D${doctrineVersion}`, `J${judgmentEngineVersion}`];
  if (narrative !== null) parts.push(`N${narrative.engineVersion}`);
  return parts.join(' · ');
}

/**
 * Project CrossCheckResult → legacy ValidationResult honestly.
 *
 * When the cross-check produced FINDINGS (real conservatism divergences),
 * each becomes a failed ValidationCheck; passed=false.
 *
 * When findings is empty AND bias is 'neutral' (the cross-check ran cleanly,
 * nothing to flag), emit a single summary check noting the clean run;
 * passed=true.
 *
 * When findings is empty BUT bias is something else (rare honest case where
 * the cross-check couldn't make a meaningful determination), return
 * undefined so the UI shows "NOT VALIDATED" rather than a fake-pass.
 */
function projectValidationResult(crossCheck: CrossCheckResult): ValidationResult | undefined {
  const timestamp = new Date().toISOString();
  if (crossCheck.findings.length > 0) {
    const checks: ValidationCheck[] = crossCheck.findings.map((f) => ({
      name: `${f.metric} (bank → bp-final)`,
      category: 'data_consistency',
      passed: f.conservatismStatus !== 'NON_CONSERVATIVE',
      details: `bank=${f.bank.value ?? '—'} → bpFinal=${f.bpFinal.value ?? '—'} · status=${f.conservatismStatus}`,
    }));
    const errors = checks.filter((c) => !c.passed);
    return { passed: errors.length === 0, checks, errors, timestamp };
  }
  if (crossCheck.overallAdjustmentBias === 'neutral') {
    const check: ValidationCheck = {
      name: 'Cross-check (overall)',
      category: 'data_consistency',
      passed: true,
      details: 'No conservatism divergence findings; overall adjustment bias neutral.',
    };
    return { passed: true, checks: [check], errors: [], timestamp };
  }
  return undefined;
}

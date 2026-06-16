/**
 * renderMemoForAnalysis — build the Credit Committee Memorandum HTML for a
 * legacy Analysis whose graph chain has completed (graphRevisionId present).
 *
 * The memo renderer (`buildCommitteeMemo`) already exists and is stable; this
 * service is the orchestration shim that loads the analysis's persisted
 * substrate and reconstructs the two deterministic pieces that aren't stored
 * (the in-memory `dealResult` + `composedMitigationPackage`). The narrative is
 * read from the spine; no LLM calls fire here.
 *
 * Flow:
 *   1. Resolve analysis → graphRevisionId → envelope.
 *   2. Fetch DE / narrative / extractionResult / adjustedInputs / assetProfile /
 *      handbookEvaluation from the graph spine.
 *   3. Rebuild dealBag via adaptExtractionToDealBag and re-run evaluateDeal
 *      (deterministic; no LLM).
 *   4. Re-run composeMitigations with the same recomputeAtLoan callback shape
 *      evaluate-and-narrate.ts uses (deterministic; no LLM).
 *   5. Call buildCommitteeMemo.
 *
 * Honesty constraints:
 *   - Returns `{ ok: false, reason }` on any missing substrate — the route
 *     translates to HTTP 404/409 so the UI never serves a broken memo.
 *   - PropertyMetadata is passed as null until the Slice-2 follow-on persists
 *     it. The renderer handles null gracefully (uses MEMO_NULL_SENTINEL).
 *   - operatorSuppliedValue is intentionally undefined — analyses that needed
 *     one (Sunroad's appraised-value substitute) carry that decision in the
 *     in-DB analysis already; re-computing here without it would yield a
 *     different dealResult than what the analyst validated, so we don't try.
 *     The memo reflects what the graph chain ACTUALLY produced.
 */
import { NARRATIVE_ENGINE_VERSION } from '@cre/contracts';
import type { Analysis } from '@cre/shared';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import { adaptExtractionToDealBag, evaluateDeal } from '../../doctrine-clean/index.js';
import { composeMitigations, type DealComputeState } from '../mitigation/compose-mitigations.js';
import { synthesizeUwModelFromInputs } from '../synthesize-uw-model-from-graph.js';
import { recomputeAiAtLoan } from '../evaluate-and-narrate.js';
import { buildCommitteeMemo } from './build-committee-memo.js';

export type RenderMemoResult =
  | { readonly ok: true; readonly html: string }
  | { readonly ok: false; readonly reason: string; readonly code: 'NO_GRAPH_LINK' | 'ENVELOPE_MISSING' | 'NARRATIVE_MISSING' | 'DOCTRINE_MISSING' | 'HANDBOOK_MISSING' | 'EXTRACTION_MISSING' | 'ADJUSTED_INPUTS_MISSING' | 'ASSET_PROFILE_MISSING' };

export function renderMemoForAnalysis(
  analysis: Analysis,
  store: RecordGraphStore,
): RenderMemoResult {
  const link = analysis.graphRevisionId;
  if (!link || link.length === 0) {
    return { ok: false, reason: 'Analysis has no graphRevisionId — the credit committee memo requires a completed graph chain.', code: 'NO_GRAPH_LINK' };
  }
  const envelope = store.getRevisionEnvelope(link as never);
  if (envelope === null) {
    return { ok: false, reason: `Revision envelope ${link.slice(0, 16)}… not found in the graph spine.`, code: 'ENVELOPE_MISSING' };
  }
  const narrative = store.getLatestNarrativeForAdjustedInputs(envelope.adjustedInputsId, NARRATIVE_ENGINE_VERSION);
  if (narrative === null) {
    return { ok: false, reason: `Narrative (engine v${NARRATIVE_ENGINE_VERSION}) not found for this analysis. The chain may not have completed the narrative stage.`, code: 'NARRATIVE_MISSING' };
  }
  const doctrine = store.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (doctrine === null) {
    return { ok: false, reason: 'Doctrine evaluation not resolvable from this envelope.', code: 'DOCTRINE_MISSING' };
  }
  const handbook = store.getLatestHandbookEvaluationForAdjustedInputs(envelope.adjustedInputsId);
  if (handbook === null) {
    return { ok: false, reason: 'Handbook evaluation not resolvable for this analysis.', code: 'HANDBOOK_MISSING' };
  }
  const extraction = store.getExtractionResult(doctrine.extractionResultId);
  if (extraction === null) {
    return { ok: false, reason: 'ExtractionResult not found — the deal bag cannot be reconstructed.', code: 'EXTRACTION_MISSING' };
  }
  const adjustedInputs = store.getAdjustedInputs(envelope.adjustedInputsId);
  if (adjustedInputs === null) {
    return { ok: false, reason: 'AdjustedInputs not found in store.', code: 'ADJUSTED_INPUTS_MISSING' };
  }
  const assetProfile = store.getAssetProfile(doctrine.assetProfileId);
  if (assetProfile === null) {
    return { ok: false, reason: 'AssetProfile not found in store.', code: 'ASSET_PROFILE_MISSING' };
  }

  // Reconstruct the in-memory dealResult + composedMitigationPackage
  // deterministically (no LLM). Same pattern as evaluate-and-narrate.ts:231-247.
  const dealBag = adaptExtractionToDealBag(extraction, null, {
    explicitAssetType: assetProfile.propertyType,
  });
  const dealResult = evaluateDeal(dealBag);
  const uwModel = synthesizeUwModelFromInputs(adjustedInputs, null);
  const composedMitigationPackage = composeMitigations({
    adjustedInputs,
    uwModel,
    dealResult,
    firedFlags: handbook.firedFlags,
    recomputeAtLoan: (newLoanAmount: number): DealComputeState => {
      const aiPrime = recomputeAiAtLoan(adjustedInputs, newLoanAmount);
      const uwPrime = synthesizeUwModelFromInputs(aiPrime, null);
      const bagPrime = { ...dealBag, loanAmount: newLoanAmount };
      const dealResultPrime = evaluateDeal(bagPrime);
      return { adjustedInputs: aiPrime, uwModel: uwPrime, dealResult: dealResultPrime };
    },
  });

  // Appraisal disclosure (optional). Pulled from analysis.appraisalExtraction
  // — when present, surfaces As-Is / As-Stabilized / OAR / going-in vs
  // stabilized coverage inside the Stressed Credit Profile section. No-op
  // when no appraisal has been ingested.
  const apx = analysis.appraisalExtraction;
  const appraisalDisclosure = apx
    ? {
        asIsValue:           apx.asIsValue ?? null,
        asStabilizedValue:   apx.asStabilizedValue ?? null,
        stabilizationMonths: apx.stabilizationMonths ?? null,
        overallCapRate:      apx.overallCapRate ?? null,
        stabilizedNOI:       apx.stabilizedProForma?.netOperatingIncome ?? null,
        currentNOI:          apx.currentProForma?.netOperatingIncome ?? null,
        loanAmount:          adjustedInputs.loan.loanAmount.adjusted,
        annualDebtService:   adjustedInputs.loan.debtServiceAnnual.adjusted,
      }
    : undefined;

  const html = buildCommitteeMemo({
    dealName: analysis.name,
    memoDate: new Date().toISOString().slice(0, 10),
    narrative,
    dealResult,
    composedMitigationPackage,
    appraisalDisclosure,
  });
  return { ok: true, html };
}

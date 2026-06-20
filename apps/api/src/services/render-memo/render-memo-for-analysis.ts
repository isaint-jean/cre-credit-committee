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
 *   - PropertyMetadata is resolved via getPropertyMetadataByExtractionResultId
 *     (matches the producer path); null when no PM record exists. The renderer
 *     handles null gracefully (uses MEMO_NULL_SENTINEL).
 *   - operatorSuppliedValue is intentionally undefined — analyses that needed
 *     one (Sunroad's appraised-value substitute) carry that decision in the
 *     in-DB analysis already; re-computing here without it would yield a
 *     different dealResult than what the analyst validated, so we don't try.
 *     The memo reflects what the graph chain ACTUALLY produced.
 */
import {
  DOCTRINE_VERSION,
  NARRATIVE_ENGINE_VERSION,
  SNAPSHOT_PRODUCER_VERSION,
} from '@cre/contracts';
import type { Analysis } from '@cre/shared';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import { adaptExtractionToDealBag, evaluateDeal } from '../../doctrine-clean/index.js';
import { detectLeaseUp } from '../../doctrine-clean/normalization/lease-up-detection.js';
import { composeMitigations, type ComposedMitigationPackage, type DealComputeState } from '../mitigation/compose-mitigations.js';
import { computeContractedNoi } from '../contracted-basis.js';
import { synthesizeUwModelFromInputs } from '../synthesize-uw-model-from-graph.js';
import { recomputeAiAtLoan } from '../evaluate-and-narrate.js';
import { buildCommitteeMemo, type MemoRenderSource } from './build-committee-memo.js';
import { runDataIntegrityGate } from '../data-integrity/gate.js';
import {
  cleanDoctrineFindingsFromSnapshot,
  composedFromSnapshot,
  loadRenderSnapshot,
} from './snapshot-readers.js';
import {
  resolveNoiBasis,
  shapeNoiBasisFromSnapshot,
} from '../noi-basis.js';

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

  // Data Quality section (v1.2) — re-run the data-integrity gate at render
  // time against the persisted state. Inputs (AdjustedInputs source tags,
  // metrics, extraction, PropertyMetadata, rentRoll NRA) are all available
  // here; running fresh keeps the surface decoupled from any persisted
  // contract change. HARD findings would have prevented persistence
  // already; at render time we expect only SOFT + provenance WARNs. The
  // section renderer suppresses itself if the report is empty, so legacy
  // memos render byte-identical when there are no findings.
  const renderTimeRentRoll = doctrine.rentRollId ? store.getRentRoll(doctrine.rentRollId) : null;
  const renderTimePm = store.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId);
  let renderTimeNra: number | null = null;
  if (renderTimeRentRoll !== null) {
    let total = 0;
    let any = false;
    for (const l of renderTimeRentRoll.lines) {
      if (l.kind !== 'tenant') continue;
      const sf = (l as { squareFeet?: number | null }).squareFeet;
      if (typeof sf === 'number' && Number.isFinite(sf) && sf > 0) { total += sf; any = true; }
    }
    if (any) renderTimeNra = total;
  }
  const dataIntegrityReport = runDataIntegrityGate({
    adjustedInputs,
    extraction,
    propertyMetadata: renderTimePm,
    netRentableArea: renderTimeNra,
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

  // ── PR (ii) read-instead-of-recompute branch ─────────────────────────
  // Prefer the persisted snapshot when present + supported-version (true
  // pin-faithfulness: numbers were captured at eval-write time under THIS
  // deal's pinned doctrine). Fall back to recompute when absent — produces
  // a HEAD-doctrine memo and a visible "NOT pin-faithful" footer banner.
  const snapshot = loadRenderSnapshot(envelope.doctrineEvaluationId, store);
  if (snapshot !== null) {
    const renderSource: MemoRenderSource = {
      kind: 'snapshot',
      capturedAt: snapshot.capturedAt,
      snapshotProducerVersion: snapshot.snapshotProducerVersion,
      pinnedDoctrineVersion: envelope.doctrineVersion,
    };
    // NOI-basis disclosure (Option C): prefer v1.1 snapshot's noiBasis;
    // on absence (v1.0 snapshot) the helper falls through to a deterministic
    // recompute below via resolveNoiBasis. Keep both paths consistent —
    // snapshot is the pin-faithful source.
    const noiBasis = snapshot.noiBasis !== undefined
      ? shapeNoiBasisFromSnapshot(snapshot.noiBasis, adjustedInputs.metrics.noi)
      : resolveNoiBasis(analysis, store);
    const html = buildCommitteeMemo({
      dealName: analysis.name,
      memoDate: new Date().toISOString().slice(0, 10),
      narrative,
      // dealResult intentionally omitted — buildCommitteeMemo uses the
      // supplied auth + findings instead of re-projecting.
      composedMitigationPackage: composedFromSnapshot(snapshot),
      auth: snapshot.authoritativeNumbers,
      findings: cleanDoctrineFindingsFromSnapshot(snapshot),
      renderSource,
      appraisalDisclosure,
      noiBasis,
      dataIntegrityReport,
    });
    return { ok: true, html };
  }

  // ── recompute fallback ───────────────────────────────────────────────
  // No snapshot (pre-PR-i evals, baselines, future producer-version drift).
  // Reconstruct the in-memory dealResult + composedMitigationPackage
  // deterministically (no LLM). Mirrors evaluate-and-narrate.ts:198-247 +
  // the live-write / re-narrate path: lease-up detection routes the
  // contracted-NOI override into adaptExtractionToDealBag so the memo's
  // auth-block (rating label, stressedValue, stressedLtv, exitDscr) matches
  // what the persisted doctrine-1.5 eval reflects. Without this, the renderer
  // would fall through to pickIssuerNoi and produce auth numbers that contradict
  // the persisted eval + the narrative prose (memo lead/body mismatch).
  //
  // Honest-blank: detectLeaseUp false → computeContractedNoi returns null →
  // override is null → adapter uses existing pickIssuerNoi cascade.
  // Stabilized deals are unchanged by construction.
  const propertyMetadata = store.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId) ?? null;
  const rentRoll = doctrine.rentRollId ? store.getRentRoll(doctrine.rentRollId) : null;
  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: assetProfile.propertyType,
    uwY1NoiOverride: contractedTrace.contractedNoi,
  });
  const dealResult = evaluateDeal(dealBag);
  const uwModel = synthesizeUwModelFromInputs(adjustedInputs, propertyMetadata);
  const composedMitigationPackage: ComposedMitigationPackage = composeMitigations({
    adjustedInputs,
    uwModel,
    dealResult,
    firedFlags: handbook.firedFlags,
    // bagPrime inherits dealBag's uwY1Noi via spread — the override flows through
    // the composition recompute path unchanged. Mirrors evaluate-and-narrate.ts:237-245.
    recomputeAtLoan: (newLoanAmount: number): DealComputeState => {
      const aiPrime = recomputeAiAtLoan(adjustedInputs, newLoanAmount);
      const uwPrime = synthesizeUwModelFromInputs(aiPrime, propertyMetadata);
      const bagPrime = { ...dealBag, loanAmount: newLoanAmount };
      const dealResultPrime = evaluateDeal(bagPrime);
      return { adjustedInputs: aiPrime, uwModel: uwPrime, dealResult: dealResultPrime };
    },
  });

  const renderSource: MemoRenderSource = {
    kind: 'recompute',
    pinnedDoctrineVersion: envelope.doctrineVersion,
    headDoctrineVersion: DOCTRINE_VERSION,
  };
  // NOI-basis disclosure via deterministic recompute (no snapshot to read).
  const noiBasis = resolveNoiBasis(analysis, store);
  const html = buildCommitteeMemo({
    dealName: analysis.name,
    memoDate: new Date().toISOString().slice(0, 10),
    narrative,
    dealResult,
    composedMitigationPackage,
    renderSource,
    appraisalDisclosure,
    noiBasis,
    dataIntegrityReport,
  });
  return { ok: true, html };
}

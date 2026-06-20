/**
 * Sunroad re-narrate under v1.8 — surfaces the data-gated handbook ledger
 * in the new "Open Items / Data Required" section. Contained sibling write
 * (doctrine eval + envelope + snapshot byte-identical; only NarrativeEvaluation
 * re-keys; rendered_analyses cache auto-invalidates via narrative_id).
 *
 * Reads the current pinned handbook + mitigation + dealResult, re-runs
 * buildNarrative under engine v1.8, inserts the new NarrativeEvaluation,
 * then renders the committee memo and prints the Open Items section so
 * the brief's final-validate gate can verify the refi-gap prose is present.
 */
import { store } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { buildNarrative } from '../services/narrative/build-narrative.js';
import { composeMitigations, type DealComputeState } from '../services/mitigation/compose-mitigations.js';
import { recomputeAiAtLoan } from '../services/evaluate-and-narrate.js';
import { synthesizeUwModelFromInputs } from '../services/synthesize-uw-model-from-graph.js';
import { adaptExtractionToDealBag, evaluateDeal } from '../doctrine-clean/index.js';
import { detectLeaseUp } from '../doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '../services/contracted-basis.js';
import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import type { RevisionId } from '@cre/contracts';

const TARGET = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';

(async () => {
  const a = store.getAnalysis(TARGET);
  if (!a?.graphRevisionId) { console.error('analysis missing'); process.exit(2); }
  const env = recordGraphStore.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
  const doctrine = recordGraphStore.getDoctrineEvaluation(env.doctrineEvaluationId)!;
  const adjustedInputs = recordGraphStore.getAdjustedInputs(env.adjustedInputsId)!;
  const extraction = recordGraphStore.getExtractionResult(doctrine.extractionResultId)!;
  const assetProfile = recordGraphStore.getAssetProfile(doctrine.assetProfileId)!;
  const rentRoll = doctrine.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;
  const pm = recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId)!;
  const he = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(env.adjustedInputsId)!;
  const mps = recordGraphStore.getLatestMitigationProposalSetForAdjustedInputs(env.adjustedInputsId, MITIGATION_ENGINE_VERSION)!;

  // Replay the inputs the original narrative producer received.
  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  const dealBag = adaptExtractionToDealBag(extraction, pm, {
    explicitAssetType: assetProfile.propertyType,
    uwY1NoiOverride: contractedTrace.contractedNoi,
  });
  const dealResult = evaluateDeal(dealBag);
  const uwModel = synthesizeUwModelFromInputs(adjustedInputs, pm);
  const composed = composeMitigations({
    adjustedInputs,
    uwModel,
    dealResult,
    firedFlags: he.firedFlags,
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const aiPrime = recomputeAiAtLoan(adjustedInputs, newLoan);
      const uwPrime = synthesizeUwModelFromInputs(aiPrime, pm);
      const bagPrime = { ...dealBag, loanAmount: newLoan };
      const drPrime = evaluateDeal(bagPrime);
      return { adjustedInputs: aiPrime, uwModel: uwPrime, dealResult: drPrime };
    },
  });

  console.log('Pre-write pinned-core anchors:');
  console.log(`  doctrine eval     : ${doctrine.id}`);
  console.log(`  envelope          : ${env.revisionId}`);
  const oldSnap = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  console.log(`  snapshot          : ${oldSnap?.id ?? '(none)'}`);
  console.log(`  current narrative : (replaced by re-narrate below)`);

  console.log('\nRe-narrating under engineVersion=1.8 (live LLM call)…');
  const newNarrative = await buildNarrative({
    handbookEvaluation: he,
    adjustedInputsId: env.adjustedInputsId,
    analysisAsOfDate: doctrine.analysisAsOfDate,
    dataConfidence: adjustedInputs.dataConfidence,
    dataQualityFlags: adjustedInputs.dataQualityFlags,
    mitigationProposalSet: mps,
    dealResult,
    composedMitigationPackage: composed,
  });

  const ins = recordGraphStore.insertNarrative(newNarrative);
  console.log(`\n${ins.inserted ? '✓ inserted' : '⚠ already existed'} NarrativeEvaluation ${newNarrative.id}`);
  console.log(`  engineVersion: ${newNarrative.engineVersion}`);
  console.log(`  openItems consumedSkipped: ${newNarrative.openItemsConsumedSkippedPrincipleIds.length} principles`);

  console.log('\nPost-write pinned-core anchors (must match pre-write):');
  const postEnv = recordGraphStore.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
  const postDoc = recordGraphStore.getDoctrineEvaluation(postEnv.doctrineEvaluationId)!;
  const postSnap = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  console.log(`  doctrine eval ${postDoc.id === doctrine.id ? '✓ unchanged' : '✗ CHANGED'}`);
  console.log(`  envelope      ${postEnv.revisionId === env.revisionId ? '✓ unchanged' : '✗ CHANGED'}`);
  console.log(`  snapshot      ${postSnap?.id === oldSnap?.id ? '✓ unchanged' : '✗ CHANGED'}`);
  console.log(`  metrics.noi   ${adjustedInputs.metrics.noi}  (column-P NOI baseline)`);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('Rendered openItemsAndDataRequired (verbatim):');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(newNarrative.openItemsAndDataRequired);
  console.log('══════════════════════════════════════════════════════════════════');

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });

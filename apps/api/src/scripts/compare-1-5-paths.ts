/**
 * Apples-to-apples comparison under doctrine 1.5 code with TWO paths:
 *   A. fall-through (uwY1NoiOverride=null, pickIssuerNoi cascade) — what 1.3
 *      would have produced in the same code; isolates the lease-up effect
 *      from the codebase delta.
 *   B. contracted basis (uwY1NoiOverride=$8.57M) — the new doctrine.
 *
 * Both run in the same process; nothing persisted.
 */
import { store } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';
import { recordGraphStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/record-graph-store.js';
import { adaptExtractionToDealBag, evaluateDeal } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/index.js';
import { detectLeaseUp } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/contracted-basis.js';

const TARGET = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';

(async () => {
  const anchor = store.getAnalysis(TARGET);
  if (!anchor?.graphRevisionId) { console.error('no anchor'); process.exit(2); }
  const envelope = recordGraphStore.getRevisionEnvelope(anchor.graphRevisionId as never);
  if (!envelope) { console.error('no envelope'); process.exit(2); }
  const doctrine = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId)!;
  const adjustedInputs = recordGraphStore.getAdjustedInputs(envelope.adjustedInputsId)!;
  const extraction = recordGraphStore.getExtractionResult(doctrine.extractionResultId)!;
  const assetProfile = recordGraphStore.getAssetProfile(doctrine.assetProfileId)!;
  const propertyMetadata = recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId) ?? null;
  const rentRoll = doctrine.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;

  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  const contractedTrace = computeContractedNoi({ rentRoll, adjustedInputs, isLeaseUpDeal: leaseUpTrace.isLeaseUp });

  function run(label: string, uwY1NoiOverride: number | null): void {
    const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
      explicitAssetType: assetProfile.propertyType,
      uwY1NoiOverride,
    });
    const r = evaluateDeal(dealBag);
    const dims = r.dimensions;
    const d7d = (dims.capRateValuationStress.derivedOutputs as Record<string, number | null>) ?? {};
    const d2d = (dims.coverageDscr.derivedOutputs as Record<string, number | null>) ?? {};
    console.log(`\n=== ${label} ===`);
    console.log(`  DealBag.uwY1Noi:     $${(dealBag.uwY1Noi ?? 0).toLocaleString()}`);
    console.log(`  dim 7 tier=${dims.capRateValuationStress.tier}  risk=${dims.capRateValuationStress.riskContribution}`);
    console.log(`    stressedValue=$${Math.round(d7d.stressedValue ?? 0).toLocaleString()}`);
    console.log(`    valuationAggressiveness=${((d7d.valuationAggressiveness ?? 0) * 100).toFixed(2)}%`);
    console.log(`    stressedCapRateGoingIn=${((d7d.stressedCapRateGoingIn ?? 0) * 100).toFixed(2)}%`);
    console.log(`    stressedLtv=${((d7d.stressedLtv ?? 0) * 100).toFixed(2)}%`);
    console.log(`  dim 1 tier=${dims.leverageLtv.tier}  risk=${dims.leverageLtv.riskContribution}`);
    console.log(`  dim 2 tier=${dims.coverageDscr.tier}  risk=${dims.coverageDscr.riskContribution}  stressedDscr=${(d2d.stressedDscr ?? 0).toFixed(2)}x`);
    console.log(`  dim 3 tier=${dims.debtYield.tier}  risk=${dims.debtYield.riskContribution}`);
    console.log(`  dim 4 tier=${dims.refinanceFeasibility.tier}  risk=${dims.refinanceFeasibility.riskContribution}`);
    console.log(`  dim 5 tier=${dims.incomeConcentration.tier}  risk=${dims.incomeConcentration.riskContribution}`);
    console.log(`  dim 6 tier=${dims.rollover.tier}  risk=${dims.rollover.riskContribution}`);
    console.log(`  dim 7 tier=${dims.capRateValuationStress.tier}  risk=${dims.capRateValuationStress.riskContribution}`);
    console.log(`  dim 8 tier=${dims.assetClass.tier}  risk=${dims.assetClass.riskContribution}`);
    const rating = r.rating as unknown as { recommendation?: string; ratingBand?: string; ratedRisk?: number };
    console.log(`  RATING: ${rating?.recommendation} (band=${rating?.ratingBand}  ratedRisk=${rating?.ratedRisk?.toFixed(3)})`);
  }

  run('A. fall-through (uwY1NoiOverride=null — what 1.5 codebase would produce without the lease-up routing)', null);
  run('B. contracted ($8.57M, with other-income fix)', contractedTrace.contractedNoi);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

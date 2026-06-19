/**
 * Sunroad ONE-SHOT — produce a render snapshot for the existing
 * DoctrineEvaluation 5b48a8f4 (Sunroad / 71edb76c, doctrine 1.5).
 *
 * Why this is correct:
 *   - 5b48a8f4 was produced by the live re-eval at doctrine 1.5 (PR
 *     [live-write-71edb76c-doctrine-1-5]). HEAD code is at DOCTRINE_VERSION
 *     '1.5' too, so running HEAD doctrine over the eval's persisted bundle
 *     reproduces THE SAME render state the eval reflects — the snapshot is
 *     pin-faithful by construction, not silently misrepresenting a pinned
 *     state.
 *
 * What this does NOT do:
 *   - Touch any other eval. NO baseline back-fill. The 5 baselines (pinned
 *     at 1.3) stay snapshot-less and the renderer falls back + flags them.
 *   - Mutate the envelope, doctrine eval, AdjustedInputs, analyses row, or
 *     narrative. Pure sibling-record insert; idempotent on
 *     ON CONFLICT(doctrine_evaluation_id) DO NOTHING.
 *
 *   cd apps/api && npx tsx src/scripts/sunroad-one-shot-snapshot.ts
 */
import { store } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import {
  adaptExtractionToDealBag,
  evaluateDeal,
} from '../doctrine-clean/index.js';
import { detectLeaseUp } from '../doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '../services/contracted-basis.js';
import { synthesizeUwModelFromInputs } from '../services/synthesize-uw-model-from-graph.js';
import {
  composeMitigations,
  type DealComputeState,
} from '../services/mitigation/compose-mitigations.js';
import { recomputeAiAtLoan } from '../services/evaluate-and-narrate.js';
import { projectAuthoritativeNumbers } from '../services/narrative/build-narrative.js';
import { computeDoctrineRenderSnapshotId } from '../util/content-hash.js';
import {
  DOCTRINE_VERSION,
  SNAPSHOT_PRODUCER_VERSION,
  extractDoctrineRenderSnapshotHashInput,
  type DoctrineRenderSnapshot,
  type DoctrineRenderSnapshotId,
  type RevisionId,
  type SnapshotDimOutput,
} from '@cre/contracts';

const TARGET = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';

function section(t: string): void {
  console.log('\n================================================================');
  console.log(t);
  console.log('================================================================');
}

function abort(msg: string): never {
  console.error(`\n  ✗ ABORT — ${msg}`);
  process.exit(2);
}

function sanitizeForCanonicalJson(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitizeForCanonicalJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForCanonicalJson(v);
    }
    return out;
  }
  return value;
}

(async () => {
  /* ─────────────── PRE-FLIGHT ─────────────── */
  section('PRE-FLIGHT');

  if (DOCTRINE_VERSION !== '1.5') abort(`DOCTRINE_VERSION=${DOCTRINE_VERSION}, expected '1.5' — HEAD doctrine must match Sunroad's pinned version for this one-shot to be correct.`);
  console.log(`  ✓ DOCTRINE_VERSION = '1.5' (matches Sunroad's pinned eval)`);

  const anchor = store.getAnalysis(TARGET);
  if (!anchor?.graphRevisionId) abort('Sunroad analysis or graphRevisionId missing');
  const env = recordGraphStore.getRevisionEnvelope(anchor.graphRevisionId as RevisionId);
  if (!env) abort('envelope missing');
  if (env.doctrineVersion !== '1.5') abort(`envelope at ${env.doctrineVersion}; expected '1.5'`);
  console.log(`  ✓ envelope ${env.revisionId.slice(0, 16)}… ordinal=${env.revisionOrdinal}  doctrine=1.5`);

  const doctrine = recordGraphStore.getDoctrineEvaluation(env.doctrineEvaluationId);
  if (!doctrine) abort('doctrine eval missing');
  console.log(`  ✓ doctrine eval ${doctrine.id.slice(0, 16)}…  ratingBand=${(doctrine as unknown as { ratingBand?: string }).ratingBand}`);

  const existingSnap = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  if (existingSnap !== null) {
    console.log(`  ⚠ snapshot already exists (id=${existingSnap.id.slice(0, 16)}…)  ON CONFLICT will no-op this run.`);
  }

  const adjustedInputs = recordGraphStore.getAdjustedInputs(env.adjustedInputsId)!;
  const extraction     = recordGraphStore.getExtractionResult(doctrine.extractionResultId)!;
  const assetProfile   = recordGraphStore.getAssetProfile(doctrine.assetProfileId)!;
  const propertyMetadata = recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId) ?? null;
  const rentRoll = doctrine.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;
  const handbook = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(env.adjustedInputsId);
  if (!handbook) abort('handbook eval missing');

  /* ─────────────── RE-DERIVE doctrine-1.5 state ─────────────── */
  section('RE-DERIVE');

  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  if (!leaseUpTrace.isLeaseUp) abort('lease-up predicate false');
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  if (contractedTrace.contractedNoi === null) abort('contractedNoi null');
  console.log(`  ✓ contractedNoi = $${Math.round(contractedTrace.contractedNoi).toLocaleString()}`);

  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: assetProfile.propertyType,
    uwY1NoiOverride: contractedTrace.contractedNoi,
  });
  const dealResult = evaluateDeal(dealBag);
  const r = dealResult.rating as unknown as { recommendation?: string; ratedRisk?: number; band?: string };
  console.log(`  ✓ dealResult: recommendation=${r.recommendation}  band=${r.band}  ratedRisk=${r.ratedRisk?.toFixed(3)}`);
  if (r.recommendation !== 'ApproveWithConditions') abort(`recommendation=${r.recommendation} != 'ApproveWithConditions' — refuse to snapshot`);

  const uwModel = synthesizeUwModelFromInputs(adjustedInputs, propertyMetadata);
  const composed = composeMitigations({
    adjustedInputs,
    uwModel,
    dealResult,
    firedFlags: handbook.firedFlags,
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const aiPrime = recomputeAiAtLoan(adjustedInputs, newLoan);
      const uwPrime = synthesizeUwModelFromInputs(aiPrime, propertyMetadata);
      const bagPrime = { ...dealBag, loanAmount: newLoan };
      const dealResultPrime = evaluateDeal(bagPrime);
      return { adjustedInputs: aiPrime, uwModel: uwPrime, dealResult: dealResultPrime };
    },
  });
  console.log(`  ✓ composed package: finalLoanAmount=$${Math.round(composed.reconciliation.finalLoanAmount).toLocaleString()}  proposals=${composed.proposals.length}`);

  /* ─────────────── BUILD + INSERT snapshot ─────────────── */
  section('SNAPSHOT WRITE');

  const dimOutputs: Record<string, SnapshotDimOutput> = {};
  for (const c of dealResult.allDimensions) {
    dimOutputs[c.dimensionId] = {
      tier: c.tier ?? 'unknown',
      applicability: c.applicability,
      derivedOutputs: (c.derivedOutputs ?? {}) as Readonly<Record<string, number | string | null>>,
    };
  }

  const ratingSnap = {
    recommendation: (r.recommendation ?? 'InsufficientData') as 'Approve' | 'ApproveWithConditions' | 'Decline' | 'InsufficientData',
    band: (r.band ?? null) as 'Strong' | 'Acceptable' | 'Watch' | 'Elevated' | 'Decline' | null,
    ratedRisk: r.ratedRisk ?? null,
  };

  const sanitizedBody = sanitizeForCanonicalJson({
    doctrineEvaluationId: doctrine.id,
    snapshotProducerVersion: SNAPSHOT_PRODUCER_VERSION,
    rating: ratingSnap,
    dimOutputs,
    authoritativeNumbers: projectAuthoritativeNumbers(dealResult, composed),
    composedMitigationPackage: {
      proposals:              composed.proposals,
      initialProposals:       composed.initialProposals,
      finalLoanAmount:        composed.finalLoanAmount,
      reconciliation:         composed.reconciliation as unknown as Readonly<Record<string, unknown>>,
      sponsorBurdenProfile:   composed.sponsorBurdenProfile as unknown as Readonly<Record<string, unknown>>,
      fundedExitProjection:   composed.fundedExitProjection as unknown as Readonly<Record<string, unknown>>,
      finalState:             composed.finalState as unknown as Readonly<Record<string, unknown>>,
    },
  }) as Pick<DoctrineRenderSnapshot,
    | 'doctrineEvaluationId'
    | 'snapshotProducerVersion'
    | 'rating'
    | 'dimOutputs'
    | 'authoritativeNumbers'
    | 'composedMitigationPackage'>;

  const body: Omit<DoctrineRenderSnapshot, 'id'> = {
    ...sanitizedBody,
    capturedAt: new Date().toISOString(),
  };
  const snapshot: DoctrineRenderSnapshot = {
    id: computeDoctrineRenderSnapshotId(
      extractDoctrineRenderSnapshotHashInput(body),
    ) as DoctrineRenderSnapshotId,
    ...body,
  };
  const insert = recordGraphStore.insertDoctrineRenderSnapshot(snapshot);
  if (insert.inserted) {
    console.log(`  ✓ inserted snapshot id=${snapshot.id.slice(0, 16)}…`);
  } else {
    console.log(`  ⚠ snapshot already existed — ON CONFLICT(doctrine_evaluation_id) DO NOTHING fired.`);
  }
  console.log(`    keyed to doctrine_evaluation_id = ${doctrine.id.slice(0, 16)}…`);
  console.log(`    capturedAt                      = ${snapshot.capturedAt}`);
  console.log(`    rating.recommendation           = ${snapshot.rating.recommendation}`);
  console.log(`    auth.stressedValue              = $${snapshot.authoritativeNumbers.stressedValue?.toFixed(0)}`);
  console.log(`    auth.stressedLtv                = ${((snapshot.authoritativeNumbers.stressedLtv ?? 0) * 100).toFixed(2)}%`);
  console.log(`    auth.exitDscrBaseline           = ${snapshot.authoritativeNumbers.exitDscrBaseline?.toFixed(2)}x`);

  /* ─────────────── VERIFY snapshot is readable ─────────────── */
  section('VERIFY');
  const reFetched = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  if (!reFetched) abort('post-insert getDoctrineRenderSnapshot returned null');
  if (reFetched.rating.recommendation !== 'ApproveWithConditions') {
    abort(`persisted rating.recommendation=${reFetched.rating.recommendation} != 'ApproveWithConditions'`);
  }
  console.log(`  ✓ snapshot round-trips: rating=${reFetched.rating.recommendation}  band=${reFetched.rating.band}`);

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });

/**
 * Sunroad RE-SNAPSHOT to v1.1 — adds noiBasis (judgmentNoi + contractedNoi) so
 * the memo + workbook callouts read pin-faithfully from snapshot.
 *
 * Why this is authorized:
 *   - The producer was bumped 1.0 → 1.1 (Option C); new evals stamp 1.1.
 *   - Sunroad's existing snapshot is at 1.0 (no noiBasis). The reader's
 *     fallback would compute the disclosure deterministically — correct but
 *     not pin-faithful. Isabelle authorized a Sunroad-only re-snapshot to
 *     1.1 so the canonical deal's callout reads from snapshot.
 *
 * What this does NOT do:
 *   - Touch any other eval. NO baseline back-fill.
 *   - Mutate the envelope, doctrine eval, AdjustedInputs, analyses row, or
 *     narrative. ONLY the doctrine_render_snapshots row for Sunroad's eval.
 *   - The new snapshot id WILL differ from the old (1.0 → 1.1 + new noiBasis
 *     field changes the canonical-JSON hash). The eval id stays the same.
 *
 *   cd apps/api && npx tsx src/scripts/sunroad-re-snapshot-v1-1.ts
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
import {
  recomputeAiAtLoan,
  NOI_BASIS_DIVERGENCE_REASON,
} from '../services/evaluate-and-narrate.js';
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
  section('PRE-FLIGHT');
  if (DOCTRINE_VERSION !== '1.5') abort(`DOCTRINE_VERSION=${DOCTRINE_VERSION}, expected '1.5'`);
  if (SNAPSHOT_PRODUCER_VERSION !== '1.1') abort(`SNAPSHOT_PRODUCER_VERSION=${SNAPSHOT_PRODUCER_VERSION}, expected '1.1'`);
  console.log(`  ✓ DOCTRINE_VERSION=1.5, SNAPSHOT_PRODUCER_VERSION=1.1`);

  const anchor = store.getAnalysis(TARGET)!;
  const env = recordGraphStore.getRevisionEnvelope(anchor.graphRevisionId as RevisionId)!;
  const doctrine = recordGraphStore.getDoctrineEvaluation(env.doctrineEvaluationId)!;
  const adjustedInputs = recordGraphStore.getAdjustedInputs(env.adjustedInputsId)!;
  const extraction = recordGraphStore.getExtractionResult(doctrine.extractionResultId)!;
  const assetProfile = recordGraphStore.getAssetProfile(doctrine.assetProfileId)!;
  const propertyMetadata = recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId) ?? null;
  const rentRoll = doctrine.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;
  const handbook = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(env.adjustedInputsId)!;

  const existingSnap = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  console.log(`  pre-write snapshot id: ${existingSnap?.id.slice(0, 16) ?? 'none'}…  version=${existingSnap?.snapshotProducerVersion ?? 'n/a'}`);

  /* ─────────────── RE-DERIVE state ─────────────── */
  section('RE-DERIVE');
  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  if (!leaseUpTrace.isLeaseUp) abort('lease-up predicate false');
  const contractedTrace = computeContractedNoi({ rentRoll, adjustedInputs, isLeaseUpDeal: leaseUpTrace.isLeaseUp });
  if (contractedTrace.contractedNoi === null) abort('contractedNoi null');
  console.log(`  contractedNoi   = $${Math.round(contractedTrace.contractedNoi).toLocaleString()}`);
  const judgmentNoi = (adjustedInputs.metrics as { noi?: number | null }).noi ?? null;
  console.log(`  judgmentNoi     = $${judgmentNoi !== null ? Math.round(judgmentNoi).toLocaleString() : 'null'}`);
  console.log(`  divergence      = $${judgmentNoi !== null ? Math.round(contractedTrace.contractedNoi - judgmentNoi).toLocaleString() : 'n/a'}`);

  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: assetProfile.propertyType,
    uwY1NoiOverride: contractedTrace.contractedNoi,
  });
  const dealResult = evaluateDeal(dealBag);
  const r = dealResult.rating as unknown as { recommendation?: string; ratedRisk?: number; band?: string };
  if (r.recommendation !== 'ApproveWithConditions') abort(`recommendation=${r.recommendation}`);

  const uwModel = synthesizeUwModelFromInputs(adjustedInputs, propertyMetadata);
  const composed = composeMitigations({
    adjustedInputs,
    uwModel,
    dealResult,
    firedFlags: handbook.firedFlags,
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const aiPrime = recomputeAiAtLoan(adjustedInputs, newLoan);
      const uwPrime = synthesizeUwModelFromInputs(aiPrime, propertyMetadata);
      return { adjustedInputs: aiPrime, uwModel: uwPrime, dealResult: evaluateDeal({ ...dealBag, loanAmount: newLoan }) };
    },
  });

  /* ─────────────── BUILD v1.1 snapshot ─────────────── */
  section('BUILD v1.1 SNAPSHOT');
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
      proposals: composed.proposals,
      initialProposals: composed.initialProposals,
      finalLoanAmount: composed.finalLoanAmount,
      reconciliation: composed.reconciliation as unknown as Readonly<Record<string, unknown>>,
      sponsorBurdenProfile: composed.sponsorBurdenProfile as unknown as Readonly<Record<string, unknown>>,
      fundedExitProjection: composed.fundedExitProjection as unknown as Readonly<Record<string, unknown>>,
      finalState: composed.finalState as unknown as Readonly<Record<string, unknown>>,
    },
    noiBasis: {
      judgmentNoi,
      contractedNoi: contractedTrace.contractedNoi,
      divergenceReason: NOI_BASIS_DIVERGENCE_REASON,
    },
  }) as Pick<DoctrineRenderSnapshot,
    | 'doctrineEvaluationId' | 'snapshotProducerVersion' | 'rating'
    | 'dimOutputs' | 'authoritativeNumbers' | 'composedMitigationPackage'
    | 'noiBasis'>;
  const body: Omit<DoctrineRenderSnapshot, 'id'> = { ...sanitizedBody, capturedAt: new Date().toISOString() };
  const snapshot: DoctrineRenderSnapshot = {
    id: computeDoctrineRenderSnapshotId(extractDoctrineRenderSnapshotHashInput(body)) as DoctrineRenderSnapshotId,
    ...body,
  };
  console.log(`  new snapshot id: ${snapshot.id.slice(0, 16)}…`);
  console.log(`  new noiBasis   : judgment $${Math.round(snapshot.noiBasis!.judgmentNoi!).toLocaleString()}  contracted $${Math.round(snapshot.noiBasis!.contractedNoi!).toLocaleString()}`);

  /* ─────────────── DELETE old + INSERT new ─────────────── */
  section('REPLACE');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (recordGraphStore as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => { changes: number } } } }).db;
  const del = db.prepare('DELETE FROM doctrine_render_snapshots WHERE doctrine_evaluation_id = ?').run(env.doctrineEvaluationId);
  console.log(`  deleted ${del.changes} pre-existing snapshot row(s)`);
  const ins = recordGraphStore.insertDoctrineRenderSnapshot(snapshot);
  if (!ins.inserted) abort('insert no-op — unexpected');
  console.log(`  inserted v1.1 snapshot`);

  /* ─────────────── VERIFY ─────────────── */
  section('VERIFY');
  const re = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId)!;
  console.log(`  read-back id       : ${re.id.slice(0, 16)}…`);
  console.log(`  read-back version  : ${re.snapshotProducerVersion}`);
  console.log(`  read-back noiBasis : judgment=${re.noiBasis?.judgmentNoi}  contracted=${re.noiBasis?.contractedNoi}`);
  if (re.snapshotProducerVersion !== '1.1') abort('version not 1.1');
  if (!re.noiBasis || re.noiBasis.contractedNoi !== contractedTrace.contractedNoi) abort('noiBasis missing or wrong');

  // No-cascade confirmation: eval + envelope ids unchanged.
  const reEnv = recordGraphStore.getRevisionEnvelope(anchor.graphRevisionId as RevisionId)!;
  console.log(`  envelope unchanged : ${reEnv.revisionId === env.revisionId ? '✓' : '✗'}`);
  console.log(`  eval unchanged     : ${reEnv.doctrineEvaluationId === env.doctrineEvaluationId ? '✓' : '✗'}`);

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });

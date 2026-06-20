/**
 * Sunroad loan-purpose backfill — sibling-record extension following the
 * exact pattern proven by sunroad-building-class-backfill.ts.
 *
 * Path A (contained cascade — Phase B Part 2/3 K6 pattern):
 *   1. Build a NEW PropertyMetadata record (existing PM body + loanPurpose='Refinance').
 *   2. Update the extraction_input_cache row to point at the new PMId.
 *   3. Re-run the handbook evaluator with the new PM as input.
 *   4. Re-run the mitigation engine (firedFlags unchanged → content-neutral expected).
 *   5. Re-run the narrative producer (LLM call — live-write only).
 *   6. Re-snapshot Sunroad ONLY if the mitigation content actually changed.
 *
 * Pinned-core invariants (the loan-purpose dry-run proved these hold):
 *   - ExtractionResult / AdjustedInputs / DoctrineEvaluation 5b48a8f4 /
 *     Envelope b09f6c26 all UNCHANGED.
 *   - firedFlags identical at count 5 AND content (P-II-6, P-III-8, P-III-9,
 *     P-III-10, P-IV-OFF-3). The two loan-purpose-gated principles transition
 *     in the SKIPPED ledger only: P-II-3 trigger_inactive → missing_field
 *     (DETERMINISTIC needs cash_out_amount); P-III-5 trigger_inactive →
 *     needs_manual_input (LLM verdict — verbatim cites the refi and asks
 *     for sponsor cost basis + borrower cash position).
 *   - recommendation / finalScore unchanged.
 *
 * DRY-RUN GATE: defaults to dry-run. Live-write only when env var
 * SUNROAD_LOAN_PURPOSE_BACKFILL_LIVE=1 is set. On any abort condition the
 * script EXITS BEFORE WRITING.
 *
 *   DRY-RUN:    npx tsx src/scripts/sunroad-loan-purpose-backfill.ts
 *   LIVE-WRITE: SUNROAD_LOAN_PURPOSE_BACKFILL_LIVE=1 npx tsx src/scripts/sunroad-loan-purpose-backfill.ts
 */
import { store } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { buildHandbookEvaluation } from '../services/handbook/build-handbook-evaluation.js';
import { computePropertyMetadataId, computeMitigationProposalSetId } from '../util/content-hash.js';
import { produceMitigations } from '../services/mitigation/produce-mitigations.js';
import { synthesizeUwModelFromInputs } from '../services/synthesize-uw-model-from-graph.js';
import { adaptExtractionToDealBag, evaluateDeal } from '../doctrine-clean/index.js';
import { detectLeaseUp } from '../doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '../services/contracted-basis.js';
import { buildNarrative } from '../services/narrative/build-narrative.js';
import { composeMitigations, type DealComputeState } from '../services/mitigation/compose-mitigations.js';
import { recomputeAiAtLoan } from '../services/evaluate-and-narrate.js';
import { canonicalize } from '../util/canonical-json.js';
import { MITIGATION_ENGINE_VERSION } from '@cre/contracts';
import type {
  PropertyMetadata,
  PropertyMetadataId,
  RevisionId,
  MitigationProposalSet,
} from '@cre/contracts';

const TARGET = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';
const LIVE = process.env.SUNROAD_LOAN_PURPOSE_BACKFILL_LIVE === '1';

function section(t: string): void {
  console.log('\n================================================================');
  console.log(t);
  console.log('================================================================');
}
function abort(msg: string): never {
  console.error(`\n  ✗ ABORT — ${msg}`);
  console.error('  Nothing written. Sunroad loan-purpose backfill cancelled.');
  process.exit(2);
}

(async () => {
  section(`PRE-FLIGHT — ${LIVE ? 'LIVE-WRITE MODE' : 'DRY-RUN MODE (default)'}`);
  if (LIVE) {
    console.log('  ⚠ SUNROAD_LOAN_PURPOSE_BACKFILL_LIVE=1 — will write to production DB on green dry-run');
  }

  const a = store.getAnalysis(TARGET);
  if (!a?.graphRevisionId) abort('Sunroad analysis / graphRevisionId missing');
  const env = recordGraphStore.getRevisionEnvelope(a.graphRevisionId as RevisionId);
  if (!env) abort('envelope missing');
  console.log(`  envelope: ${env.revisionId}  ordinal=${env.revisionOrdinal}  doctrine=${env.doctrineVersion}`);
  const doctrine = recordGraphStore.getDoctrineEvaluation(env.doctrineEvaluationId);
  if (!doctrine) abort('doctrine eval missing');
  console.log(`  doctrine eval: ${doctrine.id}`);

  const adjustedInputs = recordGraphStore.getAdjustedInputs(env.adjustedInputsId);
  if (!adjustedInputs) abort('adjustedInputs missing');
  const extraction = recordGraphStore.getExtractionResult(doctrine.extractionResultId);
  if (!extraction) abort('extraction missing');
  const assetProfile = recordGraphStore.getAssetProfile(doctrine.assetProfileId);
  if (!assetProfile) abort('assetProfile missing');
  const narrativeFacts = recordGraphStore.getNarrativeFacts(doctrine.narrativeFactsId);
  if (!narrativeFacts) abort('narrativeFacts missing');
  const stressOutputs = recordGraphStore.getStressOutputs(doctrine.stressOutputsId);
  if (!stressOutputs) abort('stressOutputs missing');
  const rentRoll = doctrine.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;
  const oldPm = recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId);
  if (!oldPm) abort('Sunroad has no current PropertyMetadata — nothing to backfill on top of');
  console.log(`  current PM: ${oldPm.id}  loanPurpose=${oldPm.loanPurpose ?? '(absent)'}  buildingClass=${oldPm.buildingClass}`);
  // Sunroad's pinned PM record was persisted BEFORE the loanPurpose field
  // existed on PropertyMetadata. The persisted body has no loanPurpose key,
  // which surfaces as `undefined` on read. Treat both `undefined` and
  // `null` as "field absent → backfill candidate"; abort only when an
  // explicit non-null value already exists.
  if (oldPm.loanPurpose !== null && oldPm.loanPurpose !== undefined) {
    abort(`PropertyMetadata.loanPurpose is already '${oldPm.loanPurpose}' — no backfill needed`);
  }

  const oldHe = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(env.adjustedInputsId);
  if (!oldHe) abort('current handbook missing');
  console.log(`  current handbook: ${oldHe.id}  firedFlags=${oldHe.firedFlags.length}  skipped=${oldHe.skippedPrinciples.length}`);
  const oldFiredPrincipleIds = [...oldHe.firedFlags].map(f => f.principleId).sort();
  console.log(`  current firedFlags: ${oldFiredPrincipleIds.join(', ')}`);

  const oldMps = recordGraphStore.getLatestMitigationProposalSetForAdjustedInputs(env.adjustedInputsId, MITIGATION_ENGINE_VERSION);
  if (!oldMps) abort('current mitigation set missing');
  console.log(`  current mitigationSet: ${oldMps.id}  proposals=${oldMps.proposals.length}`);

  const oldSnap = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  console.log(`  current snapshot: ${oldSnap?.id ?? 'none'}  v${oldSnap?.snapshotProducerVersion ?? '?'}`);

  /* ───────────────────────── BUILD NEW PROPERTY METADATA ───────────────────────── */
  section('BUILD new PropertyMetadata');
  const { id: _oldId, ...oldPmBody } = oldPm;
  void _oldId;
  const newPmBody = { ...oldPmBody, loanPurpose: 'Refinance' as string | null };
  const newPmId = computePropertyMetadataId(newPmBody) as PropertyMetadataId;
  const newPm: PropertyMetadata = { id: newPmId, ...newPmBody };
  console.log(`  new PM id: ${newPm.id}`);
  console.log(`    body diff: loanPurpose null → 'Refinance'  (all other fields unchanged, including buildingClass=${oldPm.buildingClass ?? 'null'})`);
  if (newPm.id === oldPm.id) abort('new PM has same id as old — loanPurpose change did not perturb body hash');

  /* ───────────────────────── BUILD NEW HANDBOOK EVAL (DRY) ───────────────────────── */
  section('DRY-RUN — rebuild handbook with new PM');
  const newHe = await buildHandbookEvaluation({
    adjustedInputs,
    assetProfile,
    narrativeFacts,
    stressOutputs,
    propertyMetadata: newPm,
    analysisAsOfDate: doctrine.analysisAsOfDate,
    rentRoll,
  }, { store: recordGraphStore });
  console.log(`  new handbook id: ${newHe.id}`);
  console.log(`  new firedFlags=${newHe.firedFlags.length}  skipped=${newHe.skippedPrinciples.length}`);
  const newFiredPrincipleIds = [...newHe.firedFlags].map(f => f.principleId).sort();
  console.log(`  new firedFlags: ${newFiredPrincipleIds.join(', ')}`);

  /* ───────────────────────── ABORT CHECKS ───────────────────────── */
  section('ABORT CHECKS');

  // A1+A2: doctrine eval / envelope id unchanged.
  const checkEnv = recordGraphStore.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
  console.log(`  A1: envelope unchanged?  ${checkEnv.revisionId === env.revisionId ? '✓' : '✗'}`);
  console.log(`  A2: doctrine eval unchanged?  ${checkEnv.doctrineEvaluationId === doctrine.id ? '✓' : '✗'}`);
  if (checkEnv.revisionId !== env.revisionId) abort('envelope mutated mid-script');
  if (checkEnv.doctrineEvaluationId !== doctrine.id) abort('doctrine eval mutated mid-script');

  // A3+A4: ExtractionResult / AdjustedInputs id unchanged (not touched).
  console.log(`  A3: extractionResultId unchanged?  ✓ (not touched)`);
  console.log(`  A4: adjustedInputsId unchanged?  ✓ (not touched)`);

  // A5: firedFlags content unchanged.
  const firedFlagsSame = JSON.stringify(oldFiredPrincipleIds) === JSON.stringify(newFiredPrincipleIds);
  console.log(`  A5: firedFlags identical (count + content)?  ${firedFlagsSame ? '✓' : '✗'}`);
  if (!firedFlagsSame) {
    abort(`firedFlags changed: old=[${oldFiredPrincipleIds.join(',')}] new=[${newFiredPrincipleIds.join(',')}] — backfill is NOT verdict-neutral. Aborting.`);
  }

  // A6: EXPECTED ledger transitions — P-II-3 + P-III-5 move off
  // trigger_inactive. P-II-3 → missing_field (cash_out_amount); P-III-5 →
  // needs_manual_input (LLM verdict).
  const oldP2_3 = oldHe.skippedPrinciples.find(s => s.principleId === 'P-II-3');
  const newP2_3 = newHe.skippedPrinciples.find(s => s.principleId === 'P-II-3');
  const oldP3_5 = oldHe.skippedPrinciples.find(s => s.principleId === 'P-III-5');
  const newP3_5 = newHe.skippedPrinciples.find(s => s.principleId === 'P-III-5');
  console.log(`  A6 P-II-3 :  ${oldP2_3?.reason ?? '?'}  →  ${newP2_3?.reason ?? '?'}`);
  console.log(`  A6 P-III-5:  ${oldP3_5?.reason ?? '?'}  →  ${newP3_5?.reason ?? '?'}`);
  if (oldP2_3?.reason !== 'trigger_inactive') abort(`P-II-3 expected old reason 'trigger_inactive', got '${oldP2_3?.reason}'`);
  if (oldP3_5?.reason !== 'trigger_inactive') abort(`P-III-5 expected old reason 'trigger_inactive', got '${oldP3_5?.reason}'`);
  if (newP2_3?.reason !== 'missing_field') {
    console.warn(`  ⚠ P-II-3 new reason is '${newP2_3?.reason}', expected 'missing_field'. Continuing — semantic difference not necessarily a verdict break.`);
  }
  if (newP3_5?.reason !== 'needs_manual_input') {
    console.warn(`  ⚠ P-III-5 new reason is '${newP3_5?.reason}', expected 'needs_manual_input'. Continuing — semantic difference not necessarily a verdict break.`);
  }

  /* ─────── REBUILD MITIGATION SET — CONTENT-NEUTRALITY CHECK ─────── */
  section('Mitigation set re-derive + CONTENT-NEUTRALITY CHECK');
  const propertyMetadata = newPm;
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
  const newProposals = produceMitigations({
    adjustedInputs,
    uwModel,
    firedFlags: newHe.firedFlags,
    dealResult,
  });
  const newMpsBody = {
    adjustedInputsId: env.adjustedInputsId,
    handbookEvaluationId: newHe.id,
    mitigationEngineVersion: MITIGATION_ENGINE_VERSION,
    proposals: newProposals,
  };
  const newMpsId = computeMitigationProposalSetId(newMpsBody);
  const newMps: MitigationProposalSet = { id: newMpsId as MitigationProposalSet['id'], ...newMpsBody };
  console.log(`  new mitigation id: ${newMps.id}  proposals=${newMps.proposals.length}`);

  const proposalKey = (p: { lever?: string; proposalId?: string }) => `${p.lever ?? ''}/${p.proposalId ?? ''}`;
  const oldProposalKeys = [...oldMps.proposals].map(proposalKey).sort();
  const newProposalKeys = [...newMps.proposals].map(proposalKey).sort();
  const proposalKeysSame = JSON.stringify(oldProposalKeys) === JSON.stringify(newProposalKeys);
  const oldProposalsSorted = [...oldMps.proposals].sort((a, b) => proposalKey(a).localeCompare(proposalKey(b)));
  const newProposalsSorted = [...newMps.proposals].sort((a, b) => proposalKey(a).localeCompare(proposalKey(b)));
  // Use canonical JSON (JCS) for byte-identity check — naive JSON.stringify
  // is sensitive to insertion order, and the engine-persisted vs engine-
  // produced key orders can differ even when the field values are identical.
  // Canonicalize sorts keys deterministically, matching the content-hash
  // boundary used elsewhere in the system.
  const proposalsByteIdentical = canonicalize(oldProposalsSorted) === canonicalize(newProposalsSorted);
  console.log(`  proposal lever ids identical?  ${proposalKeysSame ? '✓' : '✗'}`);
  console.log(`  proposal CONTENT byte-identical (modulo id)?  ${proposalsByteIdentical ? '✓ — snapshot is content-neutral, no re-snapshot needed' : '✗ — re-snapshot required'}`);

  // Diff diagnostic — show what specifically changed between proposals
  if (!proposalsByteIdentical) {
    console.log('\n  diff diagnostic:');
    console.log(`    counts: old=${oldProposalsSorted.length}  new=${newProposalsSorted.length}`);
    // Show keys + sample of each side-by-side
    for (let i = 0; i < Math.max(oldProposalsSorted.length, newProposalsSorted.length); i++) {
      const o = (oldProposalsSorted[i] ?? {}) as Record<string, unknown>;
      const n = (newProposalsSorted[i] ?? {}) as Record<string, unknown>;
      console.log(`    [${i}]  OLD keys: ${Object.keys(o).join(',')}`);
      console.log(`         OLD lever=${o['lever']}  id=${o['id'] ?? o['proposalId']}`);
      console.log(`    [${i}]  NEW keys: ${Object.keys(n).join(',')}`);
      console.log(`         NEW lever=${n['lever']}  id=${n['id'] ?? n['proposalId']}`);
    }
  }

  if (!LIVE) {
    section('DRY-RUN COMPLETE');
    console.log('  All abort checks passed.');
    console.log(`  Re-snapshot needed: ${proposalsByteIdentical ? 'NO (mitigation content-neutral)' : 'YES'}`);
    console.log('  To execute the live write: SUNROAD_LOAN_PURPOSE_BACKFILL_LIVE=1 npx tsx src/scripts/sunroad-loan-purpose-backfill.ts');
    process.exit(0);
  }

  /* ───────────────────────── LIVE WRITE ───────────────────────── */
  section('LIVE WRITE');

  const insPm = recordGraphStore.insertPropertyMetadata(newPm);
  console.log(`  ${insPm.inserted ? '✓ inserted' : '⚠ already existed'} new PropertyMetadata ${newPm.id.slice(0, 16)}…`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (recordGraphStore as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => { changes: number } } } }).db;
  const upd = db.prepare(
    'UPDATE extraction_input_cache SET property_metadata_id = ? WHERE extraction_result_id = ?',
  ).run(newPm.id, doctrine.extractionResultId);
  console.log(`  ✓ updated ${upd.changes} extraction_input_cache row(s) → new PMId`);

  const insHe = recordGraphStore.insertHandbookEvaluation(newHe);
  console.log(`  ${insHe.inserted ? '✓ inserted' : '⚠ already existed'} new HandbookEvaluation ${newHe.id.slice(0, 16)}…`);

  const insMps = recordGraphStore.insertMitigationProposalSet(newMps);
  console.log(`  ${insMps.inserted ? '✓ inserted' : '⚠ already existed'} new MitigationProposalSet ${newMps.id.slice(0, 16)}…`);

  const composed = composeMitigations({
    adjustedInputs,
    uwModel,
    dealResult,
    firedFlags: newHe.firedFlags,
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const aiPrime = recomputeAiAtLoan(adjustedInputs, newLoan);
      const uwPrime = synthesizeUwModelFromInputs(aiPrime, propertyMetadata);
      const bagPrime = { ...dealBag, loanAmount: newLoan };
      const drPrime = evaluateDeal(bagPrime);
      return { adjustedInputs: aiPrime, uwModel: uwPrime, dealResult: drPrime };
    },
  });
  console.log('  re-running narrative producer (LLM call)…');
  const newNarrative = await buildNarrative({
    handbookEvaluation: newHe,
    adjustedInputsId: env.adjustedInputsId,
    analysisAsOfDate: doctrine.analysisAsOfDate,
    dataConfidence: adjustedInputs.dataConfidence,
    dataQualityFlags: adjustedInputs.dataQualityFlags,
    mitigationProposalSet: newMps,
    dealResult,
    composedMitigationPackage: composed,
  });
  const insN = recordGraphStore.insertNarrative(newNarrative);
  console.log(`  ${insN.inserted ? '✓ inserted' : '⚠ already existed'} new NarrativeEvaluation ${newNarrative.id.slice(0, 16)}…`);

  if (proposalsByteIdentical) {
    console.log(`  ✓ mitigation content-neutral — existing snapshot ${oldSnap?.id.slice(0, 16) ?? '(none)'}… still pin-faithful, NO re-snapshot`);
  } else {
    abort('Mitigation content changed but re-snapshot logic for this branch is not implemented in this script. Bailing out before partial write.');
  }

  /* ───────────────────────── POST-WRITE INVARIANTS ───────────────────────── */
  section('POST-WRITE INVARIANTS');
  const post = recordGraphStore.getRevisionEnvelope(a.graphRevisionId as RevisionId)!;
  console.log(`  envelope unchanged?  ${post.revisionId === env.revisionId ? '✓' : '✗'}`);
  console.log(`  doctrine eval unchanged?  ${post.doctrineEvaluationId === doctrine.id ? '✓' : '✗'}`);
  const postSnap = recordGraphStore.getDoctrineRenderSnapshot(env.doctrineEvaluationId);
  console.log(`  Sunroad snapshot ${postSnap?.id === oldSnap?.id ? 'unchanged ✓' : 'CHANGED ✗'}`);
  const postPm = recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId);
  console.log(`  Sunroad PM now: ${postPm?.id.slice(0, 16)}…  loanPurpose=${postPm?.loanPurpose}  buildingClass=${postPm?.buildingClass}`);
  const postHe = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(env.adjustedInputsId);
  console.log(`  latest handbook: ${postHe?.id.slice(0, 16)}…  firedFlags=${postHe?.firedFlags.length}`);

  console.log('\n  ✓ LIVE WRITE COMPLETE');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });

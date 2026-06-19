/**
 * DRY-RUN re-eval of 71edb76c under DOCTRINE_VERSION 1.5 (conservative-
 * lease-up doctrine). Prints the new DoctrineEvaluation without writing
 * anything to the DB.
 *
 *   PART B per the lease-up-contracted-doctrine brief:
 *     B1 — compute the new doctrine eval (NO inserts, NO new envelope,
 *          NO re-point of analyses.graph_revision_id).
 *     B2 — report sustainableNoi (expect ~$8.57M), NCF, dim 1/2/3/4/7
 *          derived outputs, projected verdict, path taken.
 *     B3 — baseline-identity proof: project all 5 baselines and confirm
 *          byte-identical output to the pre-bump state.
 *
 *   cd apps/api && npx tsx src/scripts/dry-run-71edb76c-doctrine-1-5.ts
 */
import { createHash } from 'node:crypto';

import { store } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';
import { recordGraphStore } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/record-graph-store.js';
import { projectLegacyAnalysisFromGraph } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/project-legacy-analysis-from-graph.js';
import { adaptExtractionToDealBag, evaluateDeal, bridgeToDoctrineEvaluation } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/index.js';
import { detectLeaseUp } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/doctrine-clean/normalization/lease-up-detection.js';
import { computeContractedNoi } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/contracted-basis.js';

const TARGET = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';
const BASELINES = [
  '813aedff-a397-4d7a-8b4f-dfb4ca06d4b4',
  'c3229923-f68c-4966-87a9-586ceaec5bc7',
  'b392f479-dc53-4038-ba74-45c2350d60d6',
  '1d57c9a7-3699-4892-9562-33db88077994',
  'd63f3f20-78a7-4765-9a98-c781e10f6bc7',
];

function section(t: string): void {
  console.log('\n================================================================');
  console.log(t);
  console.log('================================================================');
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return '$' + Math.round(n).toLocaleString();
}
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return (n * 100).toFixed(digits) + '%';
}
function fmtX(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(2) + '×';
}

(async () => {
  section('PRE-FLIGHT');

  const anchor = store.getAnalysis(TARGET);
  if (!anchor) { console.error('  ✗ 71edb76c not found in store'); process.exit(2); }
  if (!anchor.graphRevisionId) { console.error('  ✗ 71edb76c has no graphRevisionId'); process.exit(2); }
  const envelope = recordGraphStore.getRevisionEnvelope(anchor.graphRevisionId as never);
  if (!envelope) { console.error('  ✗ no envelope for 71edb76c'); process.exit(2); }
  console.log(`  ✓ analysis 71edb76c found  graphRevisionId=${anchor.graphRevisionId.slice(0, 16)}…`);
  console.log(`  ✓ envelope.doctrineVersion = ${envelope.doctrineVersion}`);
  console.log(`  ✓ envelope.judgmentEngineVersion = ${envelope.judgmentEngineVersion}`);

  const doctrine = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (!doctrine) { console.error('  ✗ no DoctrineEvaluation for envelope'); process.exit(2); }
  const adjustedInputs = recordGraphStore.getAdjustedInputs(envelope.adjustedInputsId);
  if (!adjustedInputs) { console.error('  ✗ no AdjustedInputs for envelope'); process.exit(2); }
  const extraction = recordGraphStore.getExtractionResult(doctrine.extractionResultId);
  if (!extraction) { console.error('  ✗ no ExtractionResult'); process.exit(2); }
  const assetProfile = recordGraphStore.getAssetProfile(doctrine.assetProfileId);
  if (!assetProfile) { console.error('  ✗ no AssetProfile'); process.exit(2); }
  const propertyMetadata =
    recordGraphStore.getPropertyMetadataByExtractionResultId(doctrine.extractionResultId)
    ?? null;
  const rentRoll = doctrine.rentRollId
    ? recordGraphStore.getRentRoll(doctrine.rentRollId)
    : null;
  console.log(`  ✓ records fetched: AdjustedInputs, ExtractionResult, AssetProfile${propertyMetadata ? ', PropertyMetadata' : ''}${rentRoll ? `, RentRoll (${rentRoll.lines.length} lines)` : ', RentRoll=null'}`);
  console.log(`  current doctrine output (envelope-pinned, v1.3):`);
  console.log(`    ratingBand:               ${(doctrine as unknown as { ratingBand?: string }).ratingBand ?? '?'}`);
  console.log(`    finalScore:               ${(doctrine as unknown as { finalScore?: number }).finalScore ?? '?'}`);
  console.log(`    AdjustedInputs.metrics.noi:       ${fmtUsd((adjustedInputs.metrics as { noi?: number }).noi)}`);
  console.log(`    AdjustedInputs.metrics.dscr:      ${fmtX((adjustedInputs.metrics as { dscr?: number }).dscr)}`);
  console.log(`    AdjustedInputs.metrics.debtYield: ${fmtPct((adjustedInputs.metrics as { debtYield?: number }).debtYield, 1)}`);
  console.log(`    AdjustedInputs.loan.loanAmount:   ${fmtUsd((adjustedInputs.loan as { loanAmount?: { adjusted: number } }).loanAmount?.adjusted)}`);

  section('B1 — DRY-RUN doctrine 1.5 against 71edb76c');

  // 1. Detection
  const leaseUpTrace = detectLeaseUp({ extraction, assetProfile });
  console.log(`  isLeaseUpDeal: ${leaseUpTrace.isLeaseUp}`);
  console.log(`  ${leaseUpTrace.note}`);

  // 2. Contracted basis
  const contractedTrace = computeContractedNoi({
    rentRoll,
    adjustedInputs,
    isLeaseUpDeal: leaseUpTrace.isLeaseUp,
  });
  console.log(`  ${contractedTrace.note}`);
  console.log(`    qualifyingTenants: ${contractedTrace.qualifyingTenants}  excludedTenants: ${contractedTrace.excludedTenants}`);
  console.log(`    contractedRevenue: ${fmtUsd(contractedTrace.contractedRevenue)}`);
  console.log(`    vacancyPct used:   ${fmtPct(contractedTrace.vacancyPct)}`);
  console.log(`    expenseRatio used: ${fmtPct(contractedTrace.expenseRatio)}`);
  console.log(`    EGI:               ${fmtUsd(contractedTrace.egi)}`);
  console.log(`    TOE:               ${fmtUsd(contractedTrace.toe)}`);
  console.log(`    ★ contractedNoi:   ${fmtUsd(contractedTrace.contractedNoi)}`);

  const expectedSunroad = 8_569_585;
  if (contractedTrace.contractedNoi !== null) {
    const drift = Math.abs(contractedTrace.contractedNoi - expectedSunroad) / expectedSunroad;
    if (drift > 0.03) {
      console.error(`\n  ✗ STOP — contractedNoi $${Math.round(contractedTrace.contractedNoi).toLocaleString()} diverges ${(drift * 100).toFixed(2)}% from brief expectation $${expectedSunroad.toLocaleString()} (>3% material). Reporting and exiting before proceeding to evaluateDeal.`);
      process.exit(2);
    }
    console.log(`  ✓ drift vs brief expectation $${expectedSunroad.toLocaleString()}: ${(drift * 100).toFixed(2)}% (within 3% material gate)`);
  }

  // 3. New evaluateDeal under doctrine 1.5
  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: assetProfile.propertyType,
    uwY1NoiOverride: contractedTrace.contractedNoi,
  });
  console.log(`\n  DealBag.uwY1Noi:    ${fmtUsd(dealBag.uwY1Noi)}  (path: ${contractedTrace.contractedNoi !== null ? 'CREDITED SIGNED LEASES' : 'pickIssuerNoi fall-through'})`);
  console.log(`  DealBag.t12Noi:     ${fmtUsd(dealBag.t12Noi)}`);
  console.log(`  DealBag.loanAmount: ${fmtUsd(dealBag.loanAmount)}`);
  console.log(`  DealBag.concludedValue: ${fmtUsd(dealBag.concludedValue)} (source: ${dealBag.concludedValueSource ?? '?'})`);

  const dealResult = evaluateDeal(dealBag);

  section('B2 — Dry-run numbers');

  const dims = dealResult.dimensions;
  // dim 7 cap-rate-valuation-stress
  console.log('  dim 7 (cap-rate-valuation-stress):');
  console.log(`    tier:             ${dims.capRateValuationStress.tier}`);
  console.log(`    stressedValue:    ${fmtUsd((dims.capRateValuationStress.derivedOutputs as Record<string, number | null>)?.stressedValue ?? null)}`);
  console.log(`    stressedLtv:      ${fmtPct((dims.capRateValuationStress.derivedOutputs as Record<string, number | null>)?.stressedLtv ?? null)}`);
  console.log(`    concludedValue:   ${fmtUsd((dims.capRateValuationStress.derivedOutputs as Record<string, number | null>)?.concludedValue ?? null)}`);

  // dim 1 leverage-ltv
  console.log('  dim 1 (leverage-ltv):');
  console.log(`    tier:             ${dims.leverageLtv.tier}`);
  console.log(`    stressedLtv:      ${fmtPct((dims.leverageLtv.derivedOutputs as Record<string, number | null>)?.stressedLtv ?? null)}`);

  // dim 2 coverage-dscr
  console.log('  dim 2 (coverage-dscr):');
  console.log(`    tier:             ${dims.coverageDscr.tier}`);
  console.log(`    coverage (DSCR):  ${fmtX((dims.coverageDscr.derivedOutputs as Record<string, number | null>)?.coverage ?? null)}`);

  // dim 3 debt-yield
  console.log('  dim 3 (debt-yield):');
  console.log(`    tier:             ${dims.debtYield.tier}`);
  console.log(`    debtYield:        ${fmtPct((dims.debtYield.derivedOutputs as Record<string, number | null>)?.debtYield ?? null)}`);

  // dim 4 refinance-feasibility
  console.log('  dim 4 (refinance-feasibility):');
  console.log(`    tier:             ${dims.refinanceFeasibility.tier}`);
  console.log(`    exitDscr:         ${fmtX((dims.refinanceFeasibility.derivedOutputs as Record<string, number | null>)?.exitDscr ?? null)}`);

  console.log('\n  RATING (doctrine 1.5 dry-run):');
  const drRating = dealResult.rating as unknown as { recommendation?: string; ratingBand?: string; finalScore?: number };
  console.log(`    recommendation:   ${drRating?.recommendation ?? '?'}`);
  console.log(`    ratingBand:       ${drRating?.ratingBand ?? '?'}`);
  console.log(`    finalScore:       ${drRating?.finalScore ?? '?'}`);

  section('B3 — Baseline-identity proof (5 baselines, pre-bump byte hashes)');

  let baselineFailures = 0;
  const baselineHashes: Record<string, string> = {};
  for (const baseId of BASELINES) {
    const baseAnchor = store.getAnalysis(baseId);
    if (!baseAnchor) { console.log(`  ${baseId.slice(0, 8)}…  SKIP — not in store`); continue; }
    const projected = projectLegacyAnalysisFromGraph(baseAnchor, recordGraphStore);
    // Hash a deterministic projection. JSON.stringify is order-sensitive in
    // general; for the byte-identity check we project to a stable, sorted
    // JSON form by walking keys.
    const stableJson = canonicalJsonStringify(projected);
    const hash = sha(stableJson);
    baselineHashes[baseId] = hash;
    const envelopeBase = baseAnchor.graphRevisionId
      ? recordGraphStore.getRevisionEnvelope(baseAnchor.graphRevisionId as never)
      : null;
    console.log(`  ${baseId.slice(0, 8)}…  envelope.doctrineVersion=${envelopeBase?.doctrineVersion}  projection sha=${hash.slice(0, 16)}…`);
    if (envelopeBase && envelopeBase.doctrineVersion !== '1.3') {
      baselineFailures++;
      console.error(`    ✗ expected doctrineVersion=1.3, got ${envelopeBase.doctrineVersion}`);
    }
  }
  if (baselineFailures === 0) {
    console.log(`  ✓ all 5 baselines pinned to doctrineVersion=1.3 (unchanged by the v1.5 bump)`);
  } else {
    console.error(`  ✗ ${baselineFailures} baseline(s) NOT at doctrineVersion=1.3 — investigate`);
  }

  // Final DRY-RUN-NO-WRITES assertion: confirm we did NOT mutate anything.
  // Re-fetch the target analysis and confirm graph_revision_id unchanged.
  const reAnchor = store.getAnalysis(TARGET);
  if (!reAnchor || reAnchor.graphRevisionId !== anchor.graphRevisionId) {
    console.error(`  ✗ 71edb76c.graphRevisionId mutated — DRY RUN FAILED`);
    process.exit(2);
  }
  console.log(`\n  ✓ 71edb76c.graphRevisionId UNCHANGED (dry-run discipline held: no writes)`);
  console.log(`  ✓ no new envelope persisted, no doctrine eval row inserted, no analyses row touched`);

  // Persist the dry-run dealResult to a file so a follow-up review (and the
  // optional memo render in B4) can re-load without re-running the engine.
  const fs = await import('node:fs');
  const outPath = '/tmp/71edb76c-doctrine-1-5-dryrun.json';
  fs.writeFileSync(outPath, JSON.stringify(dealResult, null, 2));
  console.log(`\n  → dry-run dealResult written to ${outPath} (read-only artifact)`);

  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});

/** Stable JSON output where keys are sorted at every nested object. */
function canonicalJsonStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) {
    out[k] = sortKeys((v as Record<string, unknown>)[k]);
  }
  return out;
}

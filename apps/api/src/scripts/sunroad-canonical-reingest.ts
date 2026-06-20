/**
 * Sunroad canonical re-ingest — PERSISTS the corrective re-underwrite.
 *
 * Reproduces the dry-run's input shape exactly:
 *   - Loads the existing Sunroad ExtractionResult, swaps loanTerms to
 *     SUNROAD_LOAN_TERMS_ASR, re-ids (same operation the dry-run did
 *     in-memory).
 *   - Reuses the existing PropertyMetadata, AssetProfile, LibrarySnapshot
 *     loaded from the graph (no fresh LLM extraction → no LLM-extractor
 *     nondeterminism). MarketBenchmarks + CreditManifesto are constructed
 *     fresh with the same content the dry-run used (deterministic content
 *     hash → same IDs).
 *   - Calls ingestExtractionResult on the corrected ExtractionResult →
 *     persists the new lineage chain (judgment → doctrine → handbook →
 *     mitigation → narrative).
 *   - Re-points the existing Sunroad analysis row's graph_revision_id at
 *     the new envelope. Old envelope/records stay in SQLite — rollback
 *     by repointing.
 *
 * Strict id-parity:
 *   ExtractionResult, AdjustedInputs, DoctrineEvaluation, MitigationProposalSet
 *   are deterministic given identical inputs → IDs reproduce the dry-run.
 *   HandbookEvaluation + NarrativeEvaluation include LLM-derived prose; the
 *   LLM_CONTEXT eval cache + same context bundle → cache hits → same prose
 *   → same IDs. If LLM cache is cold for a principle, fresh LLM call may
 *   produce slightly different prose → ID may differ. Substantive parity
 *   (fired flag SET, ratingBand, finalScore) is the load-bearing test.
 */
import { store as sqliteStore } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { ingestExtractionResult } from '../services/ingest-extraction-result.js';
import {
  ASSET_TYPES,
  MANIFESTO_CONTRACT_VERSION,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import {
  computeExtractionResultId,
  computeMarketBenchmarksId,
  computeCreditManifestoId,
} from '../util/content-hash.js';
import type {
  AssetType, CreditManifesto, ISODateTime,
  LoanTermsExtraction, MarketBenchmarks,
  RevisionId, ExtractionResult, ExtractionResultId,
} from '@cre/contracts';

const TARGET = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';

const SUNROAD_LOAN_TERMS_ASR: LoanTermsExtraction = {
  loanAmount:        85_000_000,
  interestRate:      0.0716,
  amortization:      0,
  interestOnlyPeriod: 60,
  maturityDate:      '2028-09-06T00:00:00Z' as ISODateTime,
};

const emptyByAssetType = <T>(v: T): Record<AssetType, T> => {
  const o = {} as Record<AssetType, T>;
  for (const at of ASSET_TYPES) o[at] = v;
  return o;
};

function makeBenchmarks(asOf: ISODateTime): MarketBenchmarks {
  const body = {
    asOfDate: asOf,
    capRates: { ...emptyByAssetType<number | null>(null), Office: 0.075 } as never,
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Office: 0.10 } as never,
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.50), Office: 8.50 } as never,
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

function makeManifesto(asOf: ISODateTime): CreditManifesto {
  const body = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('Sunroad canonical re-ingest — PERSIST (writes to SQLite)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  TARGET           : ${TARGET}`);
  console.log(`  loan terms       : $${SUNROAD_LOAN_TERMS_ASR.loanAmount!.toLocaleString()} · ${(SUNROAD_LOAN_TERMS_ASR.interestRate! * 100).toFixed(2)}% · IO ${SUNROAD_LOAN_TERMS_ASR.interestOnlyPeriod}mo · maturity ${SUNROAD_LOAN_TERMS_ASR.maturityDate?.slice(0, 10)}`);

  // 1. Load existing pinned graph state — re-use ALL of it (no fresh LLM extraction).
  const oldAnalysis = sqliteStore.getAnalysis(TARGET);
  if (!oldAnalysis) { console.error('FATAL: target analysis missing'); process.exit(2); }
  const oldEnvelopeId = oldAnalysis.graphRevisionId as RevisionId;
  const oldEnv = recordGraphStore.getRevisionEnvelope(oldEnvelopeId)!;
  const oldDoctrine = recordGraphStore.getDoctrineEvaluation(oldEnv.doctrineEvaluationId)!;
  const oldExt = recordGraphStore.getExtractionResult(oldDoctrine.extractionResultId)!;
  const librarySnapshot = recordGraphStore.getLibrarySnapshot(oldDoctrine.librarySnapshotId)!;
  const rentRoll = oldDoctrine.rentRollId ? recordGraphStore.getRentRoll(oldDoctrine.rentRollId) : null;
  const pm = recordGraphStore.getPropertyMetadataByExtractionResultId(oldDoctrine.extractionResultId);

  const asOf = oldDoctrine.analysisAsOfDate;
  console.log(`  AS_OF (from pinned doctrine): ${asOf}`);
  console.log(`  existing graphRev: ${oldEnvelopeId}`);
  console.log(`  existing library : ${librarySnapshot.id.slice(0, 16)}…`);

  // 2. Build corrected ExtractionResult — same body, new loanTerms, new id.
  const { id: _oldExtId, ...extBody } = oldExt;
  void _oldExtId;
  const correctedExtBody = { ...extBody, loanTerms: SUNROAD_LOAN_TERMS_ASR };
  const correctedExtId = computeExtractionResultId(correctedExtBody) as ExtractionResultId;
  const correctedExt: ExtractionResult = { id: correctedExtId, ...correctedExtBody } as ExtractionResult;
  console.log(`\n  ★ new extraction id: ${correctedExtId}`);

  // 3. Build deterministic benchmarks + manifesto (same content as dry-run).
  const marketBenchmarks = makeBenchmarks(asOf);
  const creditManifesto = makeManifesto(asOf);

  console.log('\nStep 1 — ingestExtractionResult (judgment → doctrine → handbook → mitigation → narrative)');
  console.log('  Real LLM calls for any LLM_CONTEXT principles not in cache.\n');
  const t1 = Date.now();
  const ingest = await ingestExtractionResult(
    {
      extractionResult: correctedExt,
      propertyType: 'Office' as AssetType,
      marketLiquidityHint: 'Primary',
      librarySnapshotId: librarySnapshot.id,
      marketBenchmarks,
      creditManifesto,
      analysisAsOfDate: asOf,
      rentRoll,
      propertyMetadata: pm,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    recordGraphStore,
  );
  console.log(`  ingest ms     : ${Date.now() - t1}`);
  console.log(`  ★ new rootId  : ${ingest.rootId}`);

  // 4. Read the new graph for parity comparison.
  const newEnv = recordGraphStore.getRevisionEnvelope(ingest.rootId);
  if (!newEnv) { console.error('FATAL: new envelope null'); process.exit(2); }
  const newDoctrine = recordGraphStore.getDoctrineEvaluation(newEnv.doctrineEvaluationId)!;
  const newAi = recordGraphStore.getAdjustedInputs(newEnv.adjustedInputsId)!;
  const newHe = recordGraphStore.getLatestHandbookEvaluationForAdjustedInputs(newEnv.adjustedInputsId)!;
  const newNe = recordGraphStore.getLatestNarrativeForAdjustedInputs(newEnv.adjustedInputsId, NARRATIVE_ENGINE_VERSION);

  // Mitigation set id — pull most recent for the new adjustedInputs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (recordGraphStore as unknown as { db: any }).db;
  const mpsRow = db.prepare(
    'SELECT id FROM mitigation_proposal_sets WHERE adjusted_inputs_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(newEnv.adjustedInputsId);
  const newMpsId = mpsRow?.id ?? '(none)';

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('PART 3 — DRY-RUN PARITY GATE');
  console.log('═══════════════════════════════════════════════════════════════════');
  const expected = {
    extraction:  'd5fbe8f5dda8e450',
    adjusted:    '2beab3acc7cc5039',
    doctrine:    '4aa576e01eab051d',
    handbook:    'd3ee04f95babad5e',
    mitigation:  'a6b395001b11a2e5',
    narrative:   '0557ddd84114fea4',
  };
  const got = {
    extraction:  correctedExtId,
    adjusted:    newAi.id,
    doctrine:    newDoctrine.id,
    handbook:    newHe.id,
    mitigation:  String(newMpsId),
    narrative:   newNe?.id ?? '(none)',
  };
  function checkParity(label: string, exp: string, actual: string): boolean {
    const matches = actual.startsWith(exp);
    console.log(`  ${label.padEnd(13)} expect=${exp}…  got=${actual.slice(0, 17)}  ${matches ? '✓ id-parity' : '✗ DIVERGED'}`);
    return matches;
  }
  const eOk = checkParity('extraction',   expected.extraction,   got.extraction);
  const aOk = checkParity('adjusted',     expected.adjusted,     got.adjusted);
  const dOk = checkParity('doctrine',     expected.doctrine,     got.doctrine);
  const hOk = checkParity('handbook',     expected.handbook,     got.handbook);
  const mOk = checkParity('mitigation',   expected.mitigation,   got.mitigation);
  const nOk = checkParity('narrative',    expected.narrative,    got.narrative);

  const deterministicOk = eOk && aOk && dOk && mOk;

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('PART 4 — POST-PERSIST SANITY GATE');
  console.log('═══════════════════════════════════════════════════════════════════');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = newDoctrine as any;
  console.log(`  doctrine.ratingBand   : ${ev.ratingBand}`);
  console.log(`  doctrine.finalScore   : ${ev.finalScore ?? ev.mechanicalScore}`);
  console.log(`  loan.loanAmount       : $${Number(newAi.loan.loanAmount.adjusted).toLocaleString()}`);
  console.log(`  loan.interestRate     : ${(Number(newAi.loan.interestRate.adjusted) * 100).toFixed(4)}%`);
  console.log(`  loan.ioPeriodMonths   : ${newAi.loan.ioPeriodMonths.adjusted}`);
  console.log(`  loan.maturityDate     : ${(newAi.loan as unknown as { maturityDate: string }).maturityDate}`);
  console.log(`  loan.debtServiceAnnual: $${Number(newAi.loan.debtServiceAnnual.adjusted).toLocaleString()}`);
  console.log(`  metrics.ltvAppraisal  : ${(Number(newAi.metrics.ltvAppraisal) * 100).toFixed(2)}%`);
  console.log(`  metrics.dscr          : ${Number(newAi.metrics.dscr).toFixed(2)}x`);
  console.log(`  metrics.debtYield     : ${(Number(newAi.metrics.debtYield) * 100).toFixed(2)}%`);
  console.log(`  metrics.noi           : $${Number(newAi.metrics.noi).toLocaleString()}`);
  console.log(`  Loan PSF              : $${(Number(newAi.loan.loanAmount.adjusted) / 274_758).toFixed(0)}`);

  const sanityChecks: Array<[string, boolean]> = [
    ['loanAmount = $85M',    Number(newAi.loan.loanAmount.adjusted) === 85_000_000],
    ['LTV ≈ 69.7%',          Math.abs(Number(newAi.metrics.ltvAppraisal) - 0.697) < 0.01],
    ['DSCR ≈ 1.40x',         Math.abs(Number(newAi.metrics.dscr) - 1.40) < 0.05],
    ['DY ≈ 10.0%',           Math.abs(Number(newAi.metrics.debtYield) - 0.10) < 0.005],
    ['Loan PSF = $309',      Math.abs((Number(newAi.loan.loanAmount.adjusted) / 274_758) - 309) < 1],
    ['IO DS ~$6.0-6.2M',     Math.abs(Number(newAi.loan.debtServiceAnnual.adjusted) - 6_086_000) < 200_000],
    ['ratingBand = High Risk', ev.ratingBand === 'High Risk'],
    ['finalScore ≈ 36',      Math.abs(Number(ev.finalScore) - 36.6) < 5],
  ];
  let sanityPass = true;
  console.log('\n  sanity checks:');
  for (const [label, ok] of sanityChecks) {
    console.log(`    ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) sanityPass = false;
  }

  console.log('\n--- firedFlags (corrected, persisted) ---');
  console.log(`  count: ${newHe.firedFlags.length}`);
  for (const f of newHe.firedFlags) console.log(`    ${f.principleId} sev=${f.severity}`);

  // Substance-parity check on fired flag SET.
  const expectedFiredSet = new Set(['P-II-6', 'P-III-6', 'P-III-8', 'P-III-9', 'P-IV-OFF-4']);
  const actualFiredSet = new Set(newHe.firedFlags.map(f => f.principleId));
  const sameFiredSet = expectedFiredSet.size === actualFiredSet.size
    && [...expectedFiredSet].every(id => actualFiredSet.has(id));
  console.log(`\n  firedFlag SET (vs dry-run): ${sameFiredSet ? '✓ matches' : '⚠ differs'}`);
  if (!sameFiredSet) {
    console.log(`    expected: [${[...expectedFiredSet].sort().join(', ')}]`);
    console.log(`    actual  : [${[...actualFiredSet].sort().join(', ')}]`);
  }

  if (!sanityPass) {
    console.error('\n✗ HALT: sanity gate failure — analysis row NOT re-pointed; existing canonical preserved.');
    process.exit(2);
  }
  if (!deterministicOk) {
    console.error('\n✗ HALT: deterministic-record parity failed — analysis row NOT re-pointed.');
    console.error('  Existing canonical preserved. Investigate divergence cause before retry.');
    process.exit(2);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('Re-pointing analysis row → new envelope');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  OLD graphRevisionId: ${oldEnvelopeId}`);
  console.log(`  NEW graphRevisionId: ${ingest.rootId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlDb = (sqliteStore as unknown as { db: any }).db;
  const updResult = sqlDb.prepare(
    'UPDATE analyses SET graph_revision_id = ?, updated_at = ? WHERE id = ?',
  ).run(ingest.rootId, new Date().toISOString(), TARGET);
  console.log(`  rows updated: ${updResult.changes}`);

  if (updResult.changes !== 1) {
    console.error('FATAL: analysis row update affected 0 or >1 rows');
    process.exit(2);
  }

  const updatedAnalysis = sqliteStore.getAnalysis(TARGET);
  console.log(`  verified: analysis now points at ${updatedAnalysis?.graphRevisionId}`);

  console.log('\n★ RE-INGEST COMPLETE');
  console.log(`  Sunroad now canonical at $85M / 7.16% / IO / 2028-09-06.`);
  console.log(`  Old envelope ${oldEnvelopeId.slice(0, 16)}… preserved in SQLite (rollback by repointing).`);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });

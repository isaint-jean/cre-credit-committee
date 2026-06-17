/**
 * Model-A boundary guard — regression test.
 *
 *   npm run check:model-a-boundary
 *
 * What this guards:
 *
 *   The Annex A stage-1 contract states that issuer-stated figures (the
 *   ExtractionResult.annexA slot) NEVER reach the system's underwritten
 *   answer-key. Specifically: `annexA.uwY1Noi` (the issuer's prospectus-
 *   disclosed UW NOI) MUST NOT flow into:
 *     - the doctrine-clean DealBag (DealBag.uwY1Noi must stay null on
 *       Annex-A-only deals), which feeds the sustainable-cashflow spine
 *     - `AdjustedInputs.metrics.noi` (the judgment-engine answer key)
 *
 *   Stage-2 foundation upheld this by construction (apply-judgment-
 *   adjustments + adaptExtractionToDealBag do not import the annexA slot).
 *   The v8.1 resolver wiring will be tempted to add `extraction.annexA?.uwY1Noi`
 *   as a fallback inside `pickIssuerNoi()` at
 *   apps/api/src/doctrine-clean/adapters/extraction-to-dealbag.ts:138, or to
 *   route it into the apply-judgment-adjustments NOI cascade. This guard is
 *   precisely the regression test for that mistake (which CC tripped on the
 *   first attempt of stage 2 and corrected — see commit 34f3bce body).
 *
 *   On any violation, throws MODEL_A_BOUNDARY_VIOLATION and exits 1; the
 *   pre-commit hook and CI workflow both invoke this runner so the leak
 *   cannot land.
 *
 * Method:
 *
 *   1. Construct a REAL Annex-A-only ExtractionResult fixture. Other slots
 *      (rentRoll, inPlace, t12Actual, sellerUw, sellerUwOperatingStatement,
 *      pca, appraisal, asr, loanTerms) all null. The Annex A payload is the
 *      Stage-1 hand-decoded values for WFRBS 2013-C11 / Loan #17.
 *   2. Run the REAL pipeline:
 *        ExtractionResult → applyJudgmentAdjustments → AdjustedInputs
 *        ExtractionResult → adaptExtractionToDealBag → DealBag → evaluateDeal
 *   3. Assert (leak surface):
 *        AdjustedInputs.metrics.noi === null
 *        AdjustedInputs.metrics.dscr === null, debtYield === null
 *        DealBag.uwY1Noi === null         ← pickIssuerNoi must not pick from annexA
 *        DealBag.t12Noi === null
 *        sustainable NCF === null         ← spine input null
 *        spine dims HITL/null (cap-rate-valuation-stress, leverage-ltv,
 *          coverage-dscr, debt-yield, refinance-feasibility)
 *      Assert (preservation):
 *        extraction.annexA.uwY1Noi === ORIGINAL_ISSUER_UW_NOI
 *          (the value is quarantined on the typed slot, not lost — the
 *           lender-facing renderer will surface it with [ISSUER] badge)
 */

import { applyJudgmentAdjustments } from '../services/judgment/apply-judgment-adjustments.js';
import { adaptExtractionToDealBag, evaluateDeal } from '../doctrine-clean/index.js';
import { computeExtractionResultId, computeAssetProfileId, computeLibrarySnapshotId, computeCreditManifestoId, computeMarketBenchmarksId } from '../util/content-hash.js';
import { EXTRACTION_ENGINE_VERSION, MANIFESTO_CONTRACT_VERSION } from '@cre/contracts';
import type {
  ExtractionResult,
  AssetProfile,
  LibrarySnapshot,
  CreditManifesto,
  MarketBenchmarks,
  AnnexAExtraction,
  ContentHash,
  ISODateTime,
} from '@cre/contracts';

const AS_OF: ISODateTime = '2026-06-13T00:00:00Z' as ISODateTime;
// ★ CORRECTED 2026-06-13 — swapped in lockstep with the AnnexAExtraction
// payload (the spike's hand-decode labels for "UW NOI" and "TTM NOI" were
// inverted vs prospectus column-header truth; see annexA.adapter.ts:167-195
// for the two-identity proof).
const ORIGINAL_ISSUER_UW_NOI = 2_823_742;   // canonical Loan-#17 issuer UW NOI (prospectus "UW Net Operating Income" col)
const ORIGINAL_ISSUER_TTM_NOI = 3_330_324;  // canonical Loan-#17 issuer TTM NOI (prospectus "Most Recent NOI" col)

class ModelABoundaryViolationError extends Error {
  override readonly name = 'MODEL_A_BOUNDARY_VIOLATION';
  constructor(message: string) {
    super(`[MODEL_A_BOUNDARY_VIOLATION] an issuer-stated figure reached the system's underwritten output — check the annexA routing. ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, fieldName: string): void {
  if (actual !== expected) {
    throw new ModelABoundaryViolationError(
      `${fieldName}: expected ${expected === null ? 'null' : JSON.stringify(expected)}, got ${actual === null ? 'null' : JSON.stringify(actual)}`,
    );
  }
}

/* -------------------------------------------------------------------- */

const LOAN_17_ANNEXA: AnnexAExtraction = {
  loanAmount: 15_000_000,
  termYears: 5,
  amortMonths: 300,
  ioYears: 0,
  coupon: 0.04677,
  maturityDate: '2018-01-01T00:00:00Z' as ISODateTime,
  assetType: 'Hotel',
  subType: 'Limited Service + Full Service (mixed)',
  occupancyCurrent: 0.812,
  t12Noi: ORIGINAL_ISSUER_TTM_NOI,
  t12Egi: 8_785_777,
  t12OpEx: 5_962_035,
  priorPeriodNoi: 1_763_001,
  uwY1Noi: ORIGINAL_ISSUER_UW_NOI,
  uwDscr: 2.77,
  uwDebtYield: 0.189,
  concludedValue: 25_100_000,
  concludedLtv: 0.597,
  pipOrCapexReserve: 2_557_500,
  tiLcReserve: null,
  largestTenant: null,
  leaseExpirationLargest: null,
  pariPassuCombination: null,   // #17 Minot Hotel Portfolio — single-trust loan
};

function makeAnnexAOnlyExtraction(): ExtractionResult {
  const body = {
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: 'WFRBS-2013-C11-LOAN-17',
    rentRoll: null,
    inPlace: null,
    t12Actual: null,
    pca: null,
    appraisal: null,
    sellerUw: null,
    sellerUwOperatingStatement: null,
    asr: null,
    parties: null,
    loanTerms: null,
    annexA: LOAN_17_ANNEXA,
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

function makeProfile(): AssetProfile {
  const body = { propertyType: 'Hotel' as const, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function emptyByAssetType<T = null>(value: T = null as never): Record<string, T> {
  return { Office: value, Multifamily: value, Industrial: value, Retail: value, Hotel: value, SelfStorage: value, MHC: value, MixedUse: value, Other: value } as Record<string, T>;
}

function makeSnapshot(): LibrarySnapshot {
  const byAssetType = emptyByAssetType<LibrarySnapshot['byAssetType'][keyof LibrarySnapshot['byAssetType']]>(null);
  byAssetType.Hotel = {
    vacancy: { median: 0.30, p25: 0.20, p75: 0.40 },
    expenseRatio: { median: 0.65, p25: 0.60, p75: 0.70 },
    capRate: { median: 0.085, p25: 0.080, p75: 0.090 },
    dscr: { median: 1.30, p25: 1.20, p75: 1.40 },
    treasury10YAtClose: { median: 0.04, p25: 0.035, p75: 0.045 },
    n: 25,
  };
  const body = { asOf: AS_OF, approvedDealsTableHash: 'a'.repeat(64) as ContentHash, byAssetType };
  return { id: computeLibrarySnapshotId(body), ...body } as LibrarySnapshot;
}

function makeManifesto(): CreditManifesto {
  const body = { analysisAsOfDate: AS_OF, manifestoContractVersion: MANIFESTO_CONTRACT_VERSION, rules: [] };
  return { id: computeCreditManifestoId(body), ...body } as CreditManifesto;
}

function makeBenchmarks(): MarketBenchmarks {
  const body = {
    asOfDate: AS_OF,
    capRates: { ...emptyByAssetType<number | null>(null), Hotel: 0.085 },
    vacancyRates: { ...emptyByAssetType<number | null>(0.05), Hotel: 0.30 },
    expensesPerSqFt: { ...emptyByAssetType<number | null>(8.5), Hotel: 8.5 },
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  return { id: computeMarketBenchmarksId(body), ...body } as MarketBenchmarks;
}

/* -------------------------------------------------------------------- */

function main(): void {
  console.log('model-a boundary guard — Annex-A-only fixture (WFRBS 2013-C11 / Loan #17)');
  const extraction = makeAnnexAOnlyExtraction();
  const assetProfile = makeProfile();
  const librarySnapshot = makeSnapshot();
  const manifesto = makeManifesto();
  const marketBenchmarks = makeBenchmarks();

  // (1) JUDGMENT path — the real pipeline producing the answer-key NOI.
  //
  // Two possible boundary-OK shapes:
  //
  //   (a) STRONGEST — judgment THROWS (e.g., JE_GROSS_RENTAL_INCOME_MISSING)
  //       because it has no operating-statement / rent-roll source. The
  //       cascade explicitly refuses to manufacture a number. This is the
  //       behavior today (the line-item builders insist on a real income
  //       source and won't fall back to annexA).
  //
  //   (b) WEAKER — judgment SUCCEEDS but metrics.noi is null (e.g., if a
  //       future cascade widening adds null-safe paths that produce
  //       AdjustedInputs without an income source).
  //
  // The LEAK shape — what this guard catches — is: judgment SUCCEEDS and
  // metrics.noi is NON-NULL (the issuer's annexA revenue / NOI fed the
  // cascade and produced a system-underwritten figure). Either route
  // through annexA.t12Egi (would let buildGrossRentalIncome succeed) or
  // directly into the NOI cascade would land here.
  let judgmentRefusal: Error | null = null;
  let adjustedInputs: ReturnType<typeof applyJudgmentAdjustments> | null = null;
  try {
    adjustedInputs = applyJudgmentAdjustments({
      extraction, assetProfile, librarySnapshot, manifesto, marketBenchmarks,
      analysisAsOfDate: AS_OF,
    });
  } catch (err) {
    judgmentRefusal = err as Error;
  }

  if (judgmentRefusal !== null) {
    // (a) STRONGEST — boundary held by refusal. Confirm the refusal is the
    // "no income source" family, not some unrelated error.
    const msg = judgmentRefusal.message;
    if (!/JE_GROSS_RENTAL_INCOME_MISSING|no T-12|rent-roll|sellerUw|inPlace/.test(msg)) {
      throw new ModelABoundaryViolationError(
        `applyJudgmentAdjustments threw an unexpected error (not the income-source-missing family): ${msg}`,
      );
    }
    console.log(`  ✓ judgment REFUSED to underwrite — JE_GROSS_RENTAL_INCOME_MISSING (strongest boundary)`);
  } else {
    // (b) WEAKER — judgment produced AdjustedInputs. metrics.noi MUST be null.
    if (adjustedInputs === null) throw new ModelABoundaryViolationError('unreachable: judgment did not throw but adjustedInputs is null');
    assertEqual(adjustedInputs.metrics.noi, null,        'AdjustedInputs.metrics.noi');
    assertEqual(adjustedInputs.metrics.dscr, null,       'AdjustedInputs.metrics.dscr');
    assertEqual(adjustedInputs.metrics.debtYield, null,  'AdjustedInputs.metrics.debtYield');
    // The trailing-actual NOI is the truth floor (NOI-recon). Annex A's TTM
    // NOI (issuer-disclosed) MUST NOT silently become the trailing actual.
    assertEqual(adjustedInputs.metrics.trailingActualNoi, null, 'AdjustedInputs.metrics.trailingActualNoi');
    console.log(`  ✓ judgment produced AdjustedInputs but metrics.noi/dscr/debtYield/trailingActualNoi all null`);
  }

  // (2) DOCTRINE-CLEAN adapter path — where the spike's adapter MIGHT later
  // be tempted to add `extraction.annexA?.uwY1Noi` into pickIssuerNoi().
  const dealBag = adaptExtractionToDealBag(extraction, null, { explicitAssetType: 'Hotel' });

  // Load-bearing assertion #2: pickIssuerNoi() must not read annexA.
  assertEqual(dealBag.uwY1Noi, null, 'DealBag.uwY1Noi  (pickIssuerNoi() picked from annexA — boundary violated)');
  assertEqual(dealBag.t12Noi,  null, 'DealBag.t12Noi   (Annex A TTM leaked into trailing-actual)');
  // Load-bearing assertion #3: pickOccupancy() must not read annexA either.
  // underwrittenOccupancy DIRECTLY scales sustainableNoi via the DBRS
  // stabilized-floor haircut at sustainable-cashflow.ts:366-367, so issuer
  // occupancy reaching DealBag.underwrittenOccupancy on a both-sources deal
  // would shift the spine. The annexA slot must stay out of pickOccupancy().
  assertEqual(dealBag.underwrittenOccupancy, null, 'DealBag.underwrittenOccupancy  (pickOccupancy() picked from annexA — boundary violated; scales sustainableNoi)');

  // (3) Doctrine eval — confirms the spine dims route HITL on this input.
  const evalResult = evaluateDeal(dealBag);
  assertEqual(evalResult.normalization.sustainableNcf, null, 'sustainable NCF (spine input null)');
  assertEqual(evalResult.normalization.sustainableNoi, null, 'sustainable NOI (spine input null)');

  const expectedHitl = ['cap-rate-valuation-stress', 'leverage-ltv', 'coverage-dscr', 'debt-yield', 'refinance-feasibility'];
  for (const dim of evalResult.allDimensions) {
    if (expectedHitl.includes(dim.dimensionId)) {
      if (dim.applicability !== 'hitl-needed') {
        throw new ModelABoundaryViolationError(
          `dim ${dim.dimensionId}: expected applicability='hitl-needed' on Annex-A-only deal, got '${dim.applicability}' (an issuer figure plausibly fed the spine)`,
        );
      }
    }
  }

  // PRESERVATION assertions — the annexA payload itself is quarantined on
  // the typed slot, not lost. Renderers consume it with the [ISSUER] badge.
  if (extraction.annexA === null) {
    throw new ModelABoundaryViolationError(`extraction.annexA was null — the issuer cross-reference was not preserved`);
  }
  assertEqual(extraction.annexA.uwY1Noi, ORIGINAL_ISSUER_UW_NOI, 'extraction.annexA.uwY1Noi (preservation — value lost or corrupted)');
  assertEqual(extraction.annexA.t12Noi,  ORIGINAL_ISSUER_TTM_NOI, 'extraction.annexA.t12Noi (preservation)');

  // All assertions passed.
  console.log('  ✓ DealBag.uwY1Noi=null + t12Noi=null  (pickIssuerNoi() did not read annexA)');
  console.log('  ✓ DealBag.underwrittenOccupancy=null  (pickOccupancy() did not read annexA — spine sustainableNoi haircut input clean)');
  console.log('  ✓ sustainable NCF=null + spine dims HITL on cap-rate-stress / leverage-ltv / coverage-dscr / debt-yield / refinance');
  console.log(`  ✓ extraction.annexA.uwY1Noi preserved: $${(ORIGINAL_ISSUER_UW_NOI / 1_000_000).toFixed(2)}M  (quarantined on typed slot)`);
  console.log('model-a boundary guard: ok');
}

try {
  main();
  process.exit(0);
} catch (err) {
  if (err instanceof ModelABoundaryViolationError) {
    console.error(`model-a boundary guard FAILED: ${err.message}`);
  } else {
    console.error('model-a boundary guard FAILED with unexpected error:', err);
  }
  process.exit(1);
}

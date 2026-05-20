/**
 * Tests for asset-class applicability predicates.
 *
 *   npm run test:judgment-applicability
 */

import type { AssetType, AssetProfile, ExtractionResult } from '@cre/contracts';
import {
  concessionsApplies,
  ioPeriodApplies,
  monthlyCapexApplies,
  monthlyTiLcApplies,
  payrollApplies,
  pcaImmediateRepairsApplies,
  upfrontCapexApplies,
  upfrontTiLcApplies,
} from '../services/judgment/applicability.js';
import { computeAssetProfileId } from '../util/content-hash.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

function profile(t: AssetType): AssetProfile {
  const body = { propertyType: t, businessPlan: 'Stabilized' as const, marketLiquidity: 'Primary' as const };
  return { id: computeAssetProfileId(body), ...body };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    id: 'a'.repeat(64) as never,
    analysisAsOfDate: AS_OF,
    extractionEngineVersion: '1.1',
    dealRef: 'TEST', rentRoll: null, t12: null, pca: null,
    appraisal: null, sellerUw: null, sellerUwOperatingStatement: null, asr: null, loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
    ...overrides,
  };
}

console.log('concessionsApplies:');
assertEqual(concessionsApplies(profile('Multifamily')), true, 'Multifamily → true');
assertEqual(concessionsApplies(profile('Hotel')), true, 'Hotel → true');
assertEqual(concessionsApplies(profile('Office')), false, 'Office → false');
assertEqual(concessionsApplies(profile('Retail')), false, 'Retail → false');

console.log('\npayrollApplies:');
assertEqual(payrollApplies(profile('Hotel')), true, 'Hotel → true');
assertEqual(payrollApplies(profile('Multifamily')), true, 'Multifamily → true');
assertEqual(payrollApplies(profile('MHC')), true, 'MHC → true');
assertEqual(payrollApplies(profile('Office')), false, 'Office → false');

console.log('\nioPeriodApplies:');
assertEqual(ioPeriodApplies(makeExtraction()), false, 'no LoanTerms → false');
assertEqual(ioPeriodApplies(makeExtraction({
  loanTerms: { loanAmount: null, interestRate: null, amortization: null, interestOnlyPeriod: 0, maturityDate: null },
})), false, 'IO=0 → false');
assertEqual(ioPeriodApplies(makeExtraction({
  loanTerms: { loanAmount: null, interestRate: null, amortization: null, interestOnlyPeriod: 24, maturityDate: null },
})), true, 'IO=24 → true');

console.log('\nupfrontCapexApplies (PCA-driven):');
assertEqual(upfrontCapexApplies(makeExtraction()), false, 'no PCA → false');
assertEqual(upfrontCapexApplies(makeExtraction({
  pca: { immediateRepairs: 0, nearTermRepairs: null, structural: { roof: null, hvac: null, plumbing: null, electrical: null } },
})), false, 'pca but immediateRepairs=0 → false');
assertEqual(upfrontCapexApplies(makeExtraction({
  pca: { immediateRepairs: 50_000, nearTermRepairs: null, structural: { roof: null, hvac: null, plumbing: null, electrical: null } },
})), true, 'immediateRepairs > 0 → true');

console.log('\nmonthlyCapexApplies (term-driven):');
assertEqual(monthlyCapexApplies(120), true, 'term 120mo → true');
assertEqual(monthlyCapexApplies(60), false, 'term 60mo → false (boundary, not >)');
assertEqual(monthlyCapexApplies(null), false, 'null term → false');

console.log('\npcaImmediateRepairsApplies:');
assertEqual(pcaImmediateRepairsApplies(makeExtraction()), false, 'no PCA → false');
assertEqual(pcaImmediateRepairsApplies(makeExtraction({
  pca: { immediateRepairs: null, nearTermRepairs: null, structural: { roof: null, hvac: null, plumbing: null, electrical: null } },
})), true, 'PCA present (even with null repairs) → true');

console.log('\nupfrontTiLcApplies (rollover-driven):');
{
  // No rent roll → 0 rollover → false
  assertEqual(upfrontTiLcApplies({
    profile: profile('Office'),
    extraction: makeExtraction(),
    termMonths: 120,
  }), false, 'no rent roll → false');
}
{
  // Multifamily property type → false regardless
  assertEqual(upfrontTiLcApplies({
    profile: profile('Multifamily'),
    extraction: makeExtraction(),
    termMonths: 120,
  }), false, 'Multifamily → false (not tenant-driven)');
}
{
  // Office + rent roll with 50% rollover → true
  const ext = makeExtraction({
    rentRoll: {
      units: [
        { unitId: '1', tenantName: 'A', leaseStart: '2024-01-01T00:00:00Z', leaseEnd: '2027-01-01T00:00:00Z', baseRentMonthly: 5_000, inPlaceRentMonthly: 5_000, occupied: true, concessions: 0, securityDeposit: 0 },
        { unitId: '2', tenantName: 'B', leaseStart: '2024-01-01T00:00:00Z', leaseEnd: '2030-01-01T00:00:00Z', baseRentMonthly: 5_000, inPlaceRentMonthly: 5_000, occupied: true, concessions: 0, securityDeposit: 0 },
      ],
      summary: { totalUnits: 2, occupiedUnits: 2, economicOccupancy: 1.0 },
    },
  });
  // term 120mo from 2026-05-08 = ~2036-05-08; tenant 1 (expires 2027) within term, tenant 2 (2030) within term too
  // Both expire within term → 100% rollover
  assertEqual(upfrontTiLcApplies({
    profile: profile('Office'),
    extraction: ext,
    termMonths: 120,
  }), true, 'Office + 100% rollover → true');
}
{
  // Office + rent roll with all leases extending beyond term → false
  const ext = makeExtraction({
    rentRoll: {
      units: [
        { unitId: '1', tenantName: 'A', leaseStart: '2024-01-01T00:00:00Z', leaseEnd: '2050-01-01T00:00:00Z', baseRentMonthly: 5_000, inPlaceRentMonthly: 5_000, occupied: true, concessions: 0, securityDeposit: 0 },
      ],
      summary: { totalUnits: 1, occupiedUnits: 1, economicOccupancy: 1.0 },
    },
  });
  assertEqual(upfrontTiLcApplies({
    profile: profile('Office'),
    extraction: ext,
    termMonths: 120,
  }), false, 'Office + 0% rollover within term → false');
}

console.log('\nmonthlyTiLcApplies (mirrors upfrontTiLc):');
assertEqual(
  monthlyTiLcApplies({ profile: profile('Multifamily'), extraction: makeExtraction(), termMonths: 120 }),
  false,
  'mirrors upfrontTiLc (Multifamily → false)',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

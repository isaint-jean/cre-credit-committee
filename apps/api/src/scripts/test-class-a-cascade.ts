/**
 * Tests for the class-(a) cascade in the judgment line-item builders (2026-05-31).
 *
 *   tsx src/scripts/test-class-a-cascade.ts
 *
 * Class-(a) fields (reserves, taxes, reimbursements, vacancyLoss / EXPENSES)
 * cascade through `t12Actual → sellerUwOperatingStatement → inPlace`. The
 * issuer's UW column (GS U/W) wins over In-Place because it carries the
 * issuer's adjustments (Prop 13 taxes, market-rent reimbursements, normalized
 * reserves). Reading In-Place primarily on these fields silently understates
 * reserves to $0 on every deal whose In-Place column doesn't break them out.
 *
 * Covered:
 *   - replacementReserves (monthly): t12Actual → SELLER_UW → IN_PLACE → default
 *   - taxes (annual): same cascade
 *   - vacancyLoss / vacancyPct: same cascade (via vacancyPctCascade)
 *
 * Each cascade is exercised in four states:
 *   (1) all three slots present → t12Actual wins, brand T12_ACTUAL
 *   (2) t12Actual null, sellerUw + inPlace present → sellerUw wins, brand SELLER_UW
 *   (3) t12Actual + sellerUw null, inPlace present → inPlace wins, brand IN_PLACE
 *   (4) all null → MANUAL default, JE_*_DEFAULTED entry on the ledger
 */

import type { ExtractionResult, OperatingStatementExtraction } from '@cre/contracts';
import {
  buildMonthlyReplacementReserves,
  buildRealEstateTaxes,
} from '../services/judgment/line-item-builders.js';
import { pickFirstNonNull, vacancyPctCascade } from '../services/judgment/source-cascade.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assertClose(a: number | null, b: number, eps: number, m: string): void {
  if (a === null) { fail(`${m} (actual=null)`); return; }
  Math.abs(a - b) < eps ? ok(m) : fail(`${m} (actual=${a}, expected=${b})`);
}

function makeStatement(opts: {
  period: string;
  replacementReserves?: number | null;
  taxes?: number | null;
  vacancyLoss?: number | null;
  gpr?: number | null;
  noi?: number | null;
}): OperatingStatementExtraction {
  return {
    period: opts.period,
    income: {
      grossPotentialRent: opts.gpr ?? 1_000_000,
      effectiveRent: null,
      otherIncome: null,
      totalIncome: opts.gpr ?? 1_000_000,
    },
    expenses: {
      taxes: opts.taxes ?? null,
      insurance: null, utilities: null, repairsMaintenance: null,
      managementFees: null, generalAndAdmin: null, janitorial: null,
      reimbursements: null, totalOperatingExpenses: null,
    },
    noi: opts.noi ?? 0,
    vacancyLoss: opts.vacancyLoss ?? null,
    belowNoiAdjustments: {
      replacementReserves: opts.replacementReserves ?? null,
      tenantImprovements: null,
      leasingCommissions: null,
    },
  };
}

function makeExtraction(opts: {
  t12Actual?: OperatingStatementExtraction | null;
  inPlace?: OperatingStatementExtraction | null;
  sellerUwOperatingStatement?: OperatingStatementExtraction | null;
}): ExtractionResult {
  return {
    id: 'a'.repeat(64) as never,
    analysisAsOfDate: '2026-05-31T00:00:00Z' as never,
    extractionEngineVersion: '1.5' as never,
    dealRef: 'TEST',
    rentRoll: null,
    inPlace: opts.inPlace ?? null,
    t12Actual: opts.t12Actual ?? null,
    pca: null, appraisal: null,
    sellerUw: null,
    sellerUwOperatingStatement: opts.sellerUwOperatingStatement ?? null,
    asr: null, parties: null, loanTerms: null,
    annexA: null,
    sourceDocuments: [],
    extractorVersions: {},
  } as ExtractionResult;
}

/* ---------------- replacement reserves cascade ---------------------------- */

console.log('Class-(a) cascade — monthlyReplacementReserves:');

// (1) all three present → t12Actual wins
{
  const ext = makeExtraction({
    t12Actual:                  makeStatement({ period: 'T-12', replacementReserves: 12_000 }),
    sellerUwOperatingStatement: makeStatement({ period: 'GS U/W', replacementReserves: 54_952 }),
    inPlace:                    makeStatement({ period: 'In-Place', replacementReserves: 0 }),
  });
  const r = buildMonthlyReplacementReserves({ extraction: ext });
  assertClose(r.adjusted, 12_000 / 12, 1e-6, '(1) all present → t12Actual wins');
  assertEqual(r.source, 'T12_ACTUAL', '(1) brand T12_ACTUAL');
}

// (2) t12Actual null, sellerUw + inPlace present → sellerUw wins (THE Sunroad fix)
{
  const ext = makeExtraction({
    t12Actual: null,
    sellerUwOperatingStatement: makeStatement({ period: 'GS U/W', replacementReserves: 54_952 }),
    inPlace:                    makeStatement({ period: 'In-Place', replacementReserves: 0 }),
  });
  const r = buildMonthlyReplacementReserves({ extraction: ext });
  assertClose(r.adjusted, 54_952 / 12, 1e-6, '(2) sellerUw wins over In-Place → $4,579/mo (Sunroad fix)');
  assertEqual(r.source, 'SELLER_UW', '(2) brand SELLER_UW');
}

// (3) only inPlace populated → IN_PLACE
{
  const ext = makeExtraction({
    t12Actual: null,
    sellerUwOperatingStatement: null,
    inPlace: makeStatement({ period: 'In-Place', replacementReserves: 24_000 }),
  });
  const r = buildMonthlyReplacementReserves({ extraction: ext });
  assertClose(r.adjusted, 24_000 / 12, 1e-6, '(3) inPlace wins when nothing higher → IN_PLACE brand');
  assertEqual(r.source, 'IN_PLACE', '(3) brand IN_PLACE');
}

// (4) all null → MANUAL default
{
  const ext = makeExtraction({ t12Actual: null, sellerUwOperatingStatement: null, inPlace: null });
  const r = buildMonthlyReplacementReserves({ extraction: ext });
  assertEqual(r.adjusted, 0, '(4) all null → defaulted to 0');
  assertEqual(r.source, 'MANUAL', '(4) brand MANUAL');
  assert(r.adjustments.some(a => a.ruleId === 'JE_REPLACEMENT_RESERVES_DEFAULTED'),
    '(4) JE_REPLACEMENT_RESERVES_DEFAULTED entry emitted');
}

/* ---------------- taxes cascade ------------------------------------------ */

console.log('\nClass-(a) cascade — taxes:');

// (1) t12Actual wins
{
  const ext = makeExtraction({
    t12Actual:                  makeStatement({ period: 'T-12', taxes: 700_000 }),
    sellerUwOperatingStatement: makeStatement({ period: 'GS U/W', taxes: 960_500 }),
    inPlace:                    makeStatement({ period: 'In-Place', taxes: 780_092 }),
  });
  const r = buildRealEstateTaxes({ extraction: ext });
  assertClose(r.adjusted, 700_000, 1e-6, '(1) t12Actual wins');
  assertEqual(r.source, 'T12_ACTUAL', '(1) brand');
}

// (2) sellerUw wins over In-Place (this is the Prop-13 correction on Sunroad)
{
  const ext = makeExtraction({
    t12Actual: null,
    sellerUwOperatingStatement: makeStatement({ period: 'GS U/W', taxes: 960_500 }),
    inPlace:                    makeStatement({ period: 'In-Place', taxes: 780_092 }),
  });
  const r = buildRealEstateTaxes({ extraction: ext });
  assertClose(r.adjusted, 960_500, 1e-6, '(2) sellerUw wins → $960K Prop-13 reassessment (Sunroad)');
  assertEqual(r.source, 'SELLER_UW', '(2) brand');
}

// (3) inPlace fallback
{
  const ext = makeExtraction({
    t12Actual: null,
    sellerUwOperatingStatement: null,
    inPlace: makeStatement({ period: 'In-Place', taxes: 780_092 }),
  });
  const r = buildRealEstateTaxes({ extraction: ext });
  assertClose(r.adjusted, 780_092, 1e-6, '(3) inPlace fallback');
  assertEqual(r.source, 'IN_PLACE', '(3) brand');
}

// (4) all null → MANUAL (not-applicable line item)
{
  const ext = makeExtraction({ t12Actual: null, sellerUwOperatingStatement: null, inPlace: null });
  const r = buildRealEstateTaxes({ extraction: ext });
  assertEqual(r.adjusted, 0, '(4) all null → defaulted');
  assertEqual(r.source, 'MANUAL', '(4) brand MANUAL');
}

/* ---------------- vacancy cascade ----------------------------------------- */

console.log('\nClass-(a) cascade — vacancyPctCascade:');

// (1) t12Actual wins
{
  const ext = makeExtraction({
    t12Actual:                  makeStatement({ period: 'T-12', gpr: 1_000_000, vacancyLoss: 50_000 }),
    sellerUwOperatingStatement: makeStatement({ period: 'GS U/W', gpr: 1_000_000, vacancyLoss: 80_000 }),
    inPlace:                    makeStatement({ period: 'In-Place', gpr: 1_000_000, vacancyLoss: 0 }),
  });
  const picked = pickFirstNonNull(vacancyPctCascade(ext));
  assertClose(picked.value, 0.05, 1e-9, '(1) t12Actual vacancy 5%');
  assertEqual(picked.tier, 'T12_ACTUAL', '(1) brand');
}

// (2) sellerUw wins over In-Place (Sunroad-like: In-Place vacancy = 0; GS U/W applies 5%)
{
  const ext = makeExtraction({
    t12Actual: null,
    sellerUwOperatingStatement: makeStatement({ period: 'GS U/W', gpr: 1_000_000, vacancyLoss: 50_000 }),
    inPlace:                    makeStatement({ period: 'In-Place', gpr: 1_000_000, vacancyLoss: 0 }),
  });
  const picked = pickFirstNonNull(vacancyPctCascade(ext));
  assertClose(picked.value, 0.05, 1e-9, '(2) sellerUw 5% wins over In-Place 0%');
  assertEqual(picked.tier, 'SELLER_UW', '(2) brand');
}

// (3) inPlace fallback
{
  const ext = makeExtraction({
    t12Actual: null,
    sellerUwOperatingStatement: null,
    inPlace: makeStatement({ period: 'In-Place', gpr: 1_000_000, vacancyLoss: 30_000 }),
  });
  const picked = pickFirstNonNull(vacancyPctCascade(ext));
  assertClose(picked.value, 0.03, 1e-9, '(3) inPlace 3%');
  assertEqual(picked.tier, 'IN_PLACE', '(3) brand');
}

// (4) all null → MANUAL/null
{
  const ext = makeExtraction({ t12Actual: null, sellerUwOperatingStatement: null, inPlace: null });
  const picked = pickFirstNonNull(vacancyPctCascade(ext));
  assertEqual(picked.value, null, '(4) all null → value null');
  assertEqual(picked.tier, 'MANUAL', '(4) brand MANUAL');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

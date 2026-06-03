/**
 * Tests for Phase A populated-workbook cells (v9 schema).
 *
 *   npx tsx apps/api/src/scripts/test-phase-a-cells.ts
 *
 * Phase A introduces three classes of cell at v9:
 *
 *   1. CONCLUDED operating-proforma fills + DSCR/Debt Yield closures.
 *      The selector returns the engine value; writeCellValue writes it
 *      with no fill and no comment.
 *   2. AWAITING_INPUT cells (dangerous expense markup, cap-rate flip,
 *      extraction gaps). The selector returns null; writeCellValue
 *      applies the red fill (FFFFC7CE) and the cell's comment carries
 *      the expected gap text.
 *   3. HELD cells (NOI, NCF, EGI, Total OpEx). NOT in SCHEMA_V9 at
 *      ANY address — silent omission is the discipline.
 *
 * The brief's classifications are pre-approved; this script verifies
 * they propagate through projectCellBindings → applyRenderPayloadToTemplate
 * exactly as declared.
 *
 * Pure unit test — no graph / store / HTTP. The template-engine paths
 * are exercised against an in-memory ExcelJS workbook seeded with the
 * sheets the v9 schema writes into.
 */

import ExcelJS from 'exceljs';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type {
  AdjustedInputs,
  CellBindings,
  CellCommentMap,
  CellStateMap,
  ResolvedUnderwritingContext,
  RenderPayload,
} from '@cre/shared';
import { applyRenderPayloadToTemplate } from '../services/template-engine.service.js';
import {
  getSchemaAddresses,
  projectCellBindings,
} from '../services/render-schema.js';
import type { ProjectionInput } from '../services/render-schema.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

const RED_FILL_ARGB = 'FFFFC7CE';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Build an AdjustedInputs structurally adequate for v9 schema selectors. */
function makeAdjustedInputs(opts: Partial<{
  grossPotentialRent: number;
  vacancyLoss: number;
  otherIncome: number;
  realEstateTaxes: number;
  management: number;
  replacementReserves: number;
  loanAmount: number;
  interestRate: number;
  annualDebtService: number;
  noi: number;
  capRate: number;
  dscr: number;
  debtYield: number;
  impliedValue: number;
  ltv: number | null;
}> = {}): AdjustedInputs {
  const li = (v: number) => ({ raw: v, adjusted: v, delta: 0, source: 'raw' as const });
  return {
    income: {
      grossPotentialRent: li(opts.grossPotentialRent ?? 13_383_468),
      vacancyLoss:        li(opts.vacancyLoss ?? -1_338_347),
      concessions:        li(0),
      otherIncome:        li(opts.otherIncome ?? 138_000),
      effectiveGrossIncome: li(0),
    },
    expenses: {
      realEstateTaxes:        li(opts.realEstateTaxes ?? 960_500),
      insurance:              li(306_000),
      utilities:              li(276_580),
      repairsAndMaintenance:  li(0),
      management:             li(opts.management ?? 408_842),
      generalAndAdmin:        li(314_303),
      payroll:                li(0),
      // Operating-side reserves stay at 0 by design (NOI tie-out). The real
      // value lives at capitalReserves.monthlyReplacementReserves below.
      replacementReserves:    li(0),
      totalExpenses:          li(0),
    },
    capitalReserves: {
      // Sunroad: $54,952 annual / 12 = $4,579.33/mo. Surfaced here (not on
      // expenses.replacementReserves) so the NOI build-up tie-out is preserved.
      monthlyReplacementReserves: li((opts.replacementReserves ?? 54_952) / 12),
      monthlyTenantImprovements:  li(0),
      monthlyLeasingCommissions:  li(0),
      monthlyCapex:               li(0),
      upfrontReplacementReserves: li(0),
      upfrontTiLc:                li(0),
      pcaImmediateRepairs:        li(0),
    },
    loan: {
      loanAmount:         opts.loanAmount ?? 82_460_000,
      interestRate:       opts.interestRate ?? 0.079,
      rateType:           'fixed' as any,
      amortizationMonths: 0,
      termMonths:         60,
      ioMonths:           60,
    },
    metrics: {
      netOperatingIncome: opts.noi ?? 8_745_252,
      capRate:            opts.capRate ?? 0.075,
      impliedValue:       opts.impliedValue ?? 113_580_000,
      annualDebtService:  opts.annualDebtService ?? 6_514_340,
      dscr:               opts.dscr ?? 1.343,
      ltv:                opts.ltv ?? null,
      debtYield:          opts.debtYield ?? 0.106,
    },
    adjustments: [],
    confidenceReduction: 0,
  };
}

/** Build a ResolvedUnderwritingContext adequate for the v9 carry-forward
 *  property/loan/party cells. Fields are filled with deterministic placeholder
 *  values; the brand registry is bypassed by constructing a ProjectionInput
 *  directly (which is what the test does — it does not call resolveResolver). */
function makeResolvedContext(): ResolvedUnderwritingContext {
  return {
    underwritingMode: 'single_loan' as any,
    propertyLoanSummary: {} as any,
    conclusionAndEscrows: {
      loanSummary: '', strengths: '', weaknesses: '', mitigants: '',
      escrowSummary: '', loanStructureCommentary: '',
    },
    propertyDetail: {} as any,
    operatingProForma: {} as any,
    stressScenario: {} as any,
    thirdPartyReports: {} as any,
    borrower: {} as any,
    market: {} as any,
    siteInspection: {} as any,
    comparables: {} as any,
    rollUpView: {
      loanCount: 1,
      aggregationMethodology: 'n/a',
      normalizationCommentary: '',
      constituentLoanIds: '',
    },
    property: {
      name: 'Sunroad Centrum', street: '4747 Executive Dr', city: 'San Diego',
      state: 'CA', zip: '92121', county: 'San Diego', type: 'office',
      yearBuilt: 1985, totalSquareFeet: 270_000, units: 1, occupancy: 0.92,
      ownershipInterest: 'fee simple',
    },
    loan: {
      termMonths: 60, amortizationMonths: 0, ioMonths: 60,
    },
    parties: { borrowerName: 'Sunroad Centrum LLC', sponsorName: 'Sunroad Enterprises' },
    comparablesLinkageRefs: '',
  } as ResolvedUnderwritingContext;
}

function makeProjectionInput(): ProjectionInput {
  return {
    meta: { dealId: 'phase-a-test', dealName: 'Sunroad Centrum (test)', generatedAt: '2026-06-02T00:00:00Z' },
    assetClass: 'office' as any,
    structuralVariantKey: 'office_core' as any,
    underwritingMode: 'single_loan' as any,
    adjustedInputs: makeAdjustedInputs(),
    underwritingContext: {} as any,
    drivers: [],
    conservatismStatus: { approved: true, flags: [], floorBindings: [] },
    libraryBaselineMeta: {
      assetType: 'office' as any, sampleSize: null, vacancyMedian: null,
      expenseRatioMedian: null, capRateMedian: null, degraded: false,
    },
    resolvedContext: makeResolvedContext(),
  };
}

/** Build the minimal Excel template covering every sheet the v9 schema
 *  writes into for the 'office' asset class. */
async function makeTemplateBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Property & Loan Summary');
  wb.addWorksheet('Conclusions & Escrows');
  wb.addWorksheet('Operating History and Pro Forma');
  wb.addWorksheet('Borrower');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function makeRenderPayload(
  bindings: CellBindings,
  states: CellStateMap,
  comments: CellCommentMap,
): RenderPayload {
  return {
    contractVersion: RENDER_CONTRACT_VERSION,
    dealId: 'phase-a-test',
    assetClass: 'office' as any,
    structuralVariantKey: 'office_core' as any,
    underwritingMode: 'single_loan' as any,
    structuralIdentity: {
      assetClass: 'office' as any, contractVersion: RENDER_CONTRACT_VERSION,
      structuralVariantKey: 'office_core' as any, underwritingMode: 'single_loan' as any,
      fingerprint: 'phase-a-test',
    },
    visibleTabs: ['Property & Loan Summary', 'Conclusions & Escrows',
                   'Operating History and Pro Forma', 'Borrower'],
    cellBindings: bindings, cellStates: states, cellComments: comments,
    schemaAddresses: Object.keys(bindings).sort(),
    managedNamespace: { prefixes: [], literals: [], excludedSheets: [] },
    tables: [],
    conservatismStatus: { approved: true, flags: [], floorBindings: [] },
    libraryBaselineMeta: {
      assetType: 'office' as any, sampleSize: null, vacancyMedian: null,
      expenseRatioMedian: null, capRateMedian: null, degraded: false,
    },
    generatedAt: '2026-06-02T00:00:00Z',
  };
}

interface CellSnapshot {
  value: unknown;
  fillArgb: string | null;
  noteText: string | null;
}

function snapshotCell(cell: ExcelJS.Cell): CellSnapshot {
  const fill = (cell as any).fill;
  const fillArgb =
    fill && fill.type === 'pattern' && fill.fgColor && fill.fgColor.argb
      ? String(fill.fgColor.argb) : null;
  const note = (cell as any).note;
  let noteText: string | null = null;
  if (note && Array.isArray(note.texts) && note.texts.length > 0) {
    noteText = note.texts.map((t: any) => t.text).join('');
  }
  return { value: cell.value, fillArgb, noteText };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

/** v9 SCHEMA addresses we expect to find in office_core / single_loan. */
const EXPECTED_V9_ADDRESSES_OFFICE = {
  CONCLUDED: [
    // Property block (carry-forward from v7/v8)
    'Property & Loan Summary!Property_Name',
    'Property & Loan Summary!Address',
    'Property & Loan Summary!City',
    'Property & Loan Summary!State',
    'Property & Loan Summary!ZIP',
    'Property & Loan Summary!County',
    'Property & Loan Summary!Property_Type',
    'Property & Loan Summary!Year_Built',
    'Property & Loan Summary!Occupancy',
    'Property & Loan Summary!Ownership_Interest',
    // Loan block (carry-forward)
    'Property & Loan Summary!Current_Balance',
    'Property & Loan Summary!Original_Balance',
    'Property & Loan Summary!Coupon',
    'Property & Loan Summary!Annual_Debt_Service',
    'Property & Loan Summary!Balloon_Term',
    'Property & Loan Summary!Amortization_Term',
    'Property & Loan Summary!Interest_Only_Period',
    // Party block (carry-forward)
    'Borrower!Borrower',
    'Borrower!Sponsor',
    // NEW at v9 — Operating ProForma fills
    'Operating History and Pro Forma!P9',
    'Operating History and Pro Forma!P6',
    'Operating History and Pro Forma!P10',
    'Operating History and Pro Forma!P14',
    'Operating History and Pro Forma!P31',
    'Operating History and Pro Forma!P30',
    'Operating History and Pro Forma!P38',
    // NEW at v9 — Debt Yield (post loan-terms fix); diffs clean against answer key
    'Conclusions & Escrows!J16',
    // FLIPPED Phase 14 — DSCR (NOI) post Bugs 1+2 IO-only fix; now CONCLUDED
    'Conclusions & Escrows!I16',
  ],
  AWAITING_INPUT: [
    // FLIPPED v8 → v9 (cap-rate + value)
    'Conclusions & Escrows!Concluded_Cap_Rate',
    'Conclusions & Escrows!Concluded_Value',
    // NEW at v9 — dangerous expense markup pending
    'Operating History and Pro Forma!P25',
    'Operating History and Pro Forma!P22',
    'Operating History and Pro Forma!P32',
    'Operating History and Pro Forma!P39',
    'Operating History and Pro Forma!P40',
    'Operating History and Pro Forma!P15',
    // NEW at v9 — extraction / data gaps
    'Property & Loan Summary!E41',
    'Operating History and Pro Forma!P49',
    'Property & Loan Summary!K5',
    'Property & Loan Summary!K6',
  ],
} as const;

/** Held cells must NOT appear at any address in SCHEMA_V9. The brief is
 *  explicit: silent omission, not awaiting_input declaration. We verify
 *  by enumerating the schema's address set and asserting that no entry
 *  references the held rollup rows (NOI=35, NCF=44, EGI/TotalRev=17,
 *  TotalOpEx=33) on Operating History and Pro Forma's any column. */
const HELD_ROW_PATTERNS_OFFICE = [
  /Operating History and Pro Forma!.+35$/,  // NOI row
  /Operating History and Pro Forma!.+44$/,  // NCF row
  /Operating History and Pro Forma!.+17$/,  // EGI / Total Revenues row
  /Operating History and Pro Forma!.+33$/,  // Total Operating Expenses row
];

function testSchemaCompleteness(): void {
  console.log('\n[1] v9 schema address completeness — office_core / single_loan');
  const addresses = getSchemaAddresses(
    'office' as any, 'office_core' as any, 'single_loan' as any, 9,
  );
  const addrSet = new Set(addresses);

  // Concluded addresses
  for (const addr of EXPECTED_V9_ADDRESSES_OFFICE.CONCLUDED) {
    assert(addrSet.has(addr), `schema includes CONCLUDED address ${addr}`);
  }
  // Awaiting-input addresses
  for (const addr of EXPECTED_V9_ADDRESSES_OFFICE.AWAITING_INPUT) {
    assert(addrSet.has(addr), `schema includes AWAITING_INPUT address ${addr}`);
  }
  // Held rollup rows MUST NOT appear at any address
  for (const pat of HELD_ROW_PATTERNS_OFFICE) {
    const offenders = addresses.filter((a) => pat.test(a));
    assert(
      offenders.length === 0,
      `HELD row pattern ${pat} is NOT in schema (silent omission discipline)`,
    );
  }
  // Sanity: total v9 address count for office_core / single_loan is the
  // sum of concluded + awaiting_input declared above. Any drift means a
  // new entry was added without test coverage.
  const expectedTotal =
    EXPECTED_V9_ADDRESSES_OFFICE.CONCLUDED.length +
    EXPECTED_V9_ADDRESSES_OFFICE.AWAITING_INPUT.length;
  assertEqual(
    addresses.length, expectedTotal,
    `v9 schema address count for office_core / single_loan = ${expectedTotal}`,
  );
}

function testProjectionEmitsExpectedStatesAndComments(): void {
  console.log('\n[2] projectCellBindings emits cellState + comment for each v9 cell');
  const input = makeProjectionInput();
  const projection = projectCellBindings(input, 9);

  // Every concluded cell: state is 'concluded' and no comment entry.
  for (const addr of EXPECTED_V9_ADDRESSES_OFFICE.CONCLUDED) {
    assertEqual(projection.states[addr], 'concluded', `${addr}: state=concluded`);
    assertEqual(
      projection.comments[addr], undefined,
      `${addr}: NO comment entry (concluded cells never carry comments)`,
    );
  }
  // Every awaiting_input cell: state is 'awaiting_input' AND comment is non-empty.
  for (const addr of EXPECTED_V9_ADDRESSES_OFFICE.AWAITING_INPUT) {
    assertEqual(projection.states[addr], 'awaiting_input', `${addr}: state=awaiting_input`);
    const c = projection.comments[addr];
    assert(c !== undefined, `${addr}: comment entry emitted`);
    if (c !== undefined) {
      assertEqual(c.state, 'awaiting_input', `${addr}: comment state agrees`);
      assert(c.text.length > 20, `${addr}: comment text non-trivial (>20 chars)`);
    }
  }
}

function testConcludedSelectorsReturnEngineValues(): void {
  console.log('\n[3] CONCLUDED selectors return the engine value');
  const input = makeProjectionInput();
  const projection = projectCellBindings(input, 9);

  // Operating ProForma CONCLUDED fills
  assertEqual(
    projection.bindings['Operating History and Pro Forma!P9'],
    13_383_468, 'P9 = grossPotentialRent.adjusted',
  );
  assertEqual(
    projection.bindings['Operating History and Pro Forma!P14'],
    138_000, 'P14 = otherIncome.adjusted',
  );
  assertEqual(
    projection.bindings['Operating History and Pro Forma!P31'],
    960_500, 'P31 = realEstateTaxes.adjusted',
  );
  assertEqual(
    projection.bindings['Operating History and Pro Forma!P30'],
    408_842, 'P30 = management.adjusted',
  );
  // P38 = capitalReserves.monthlyReplacementReserves.adjusted × 12.
  // Float-imprecision-tolerant (54952 / 12 × 12 may yield 54951.999...).
  const p38 = projection.bindings['Operating History and Pro Forma!P38'];
  assert(typeof p38 === 'number', 'P38 is a number');
  if (typeof p38 === 'number') {
    assert(
      Math.abs(p38 - 54_952) < 0.01,
      `P38 = capitalReserves.monthlyReplacementReserves × 12 (got ${p38}, expected ~54,952)`,
    );
  }
  // Vacancy % derivation
  const p6 = projection.bindings['Operating History and Pro Forma!P6'];
  assert(typeof p6 === 'number', 'P6 vacancy pct is a number');
  if (typeof p6 === 'number') {
    assert(Math.abs(p6 - 0.10) < 0.001, `P6 vacancy pct ≈ 0.10 (got ${p6})`);
  }
  // Debt Yield closure (DSCR is awaiting_input per the loan-fix gate;
  // see testAwaitingInputSelectorsReturnNull below).
  assertEqual(
    projection.bindings['Conclusions & Escrows!J16'],
    0.106, 'J16 = debtYield (concluded — passes loan-fix gate)',
  );
}

function testAwaitingInputSelectorsReturnNull(): void {
  console.log('\n[4] AWAITING_INPUT selectors return null');
  const input = makeProjectionInput();
  const projection = projectCellBindings(input, 9);
  for (const addr of EXPECTED_V9_ADDRESSES_OFFICE.AWAITING_INPUT) {
    assertEqual(projection.bindings[addr], null, `${addr}: binding is null`);
  }
}

async function testWriteThroughTemplateEngine(): Promise<void> {
  console.log('\n[5] applyRenderPayloadToTemplate: CONCLUDED no fill, AWAITING_INPUT red fill + note');
  const input = makeProjectionInput();
  const projection = projectCellBindings(input, 9);
  const tpl = await makeTemplateBuffer();
  const payload = makeRenderPayload(projection.bindings, projection.states, projection.comments);
  const result = await applyRenderPayloadToTemplate(tpl, payload);

  // Read back the workbook and probe key cells.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.populatedBuffer as any);

  // CONCLUDED P38 — replacement reserves (capitalReserves.monthlyReplacementReserves × 12)
  const opf = wb.getWorksheet('Operating History and Pro Forma')!;
  const snapP38 = snapshotCell(opf.getCell('P38'));
  assert(
    typeof snapP38.value === 'number' && Math.abs((snapP38.value as number) - 54_952) < 0.01,
    `P38 (concluded) value written verbatim ≈ 54,952 (got ${snapP38.value})`,
  );
  assertEqual(snapP38.fillArgb, null, 'P38 (concluded) — no fill');
  assertEqual(snapP38.noteText, null, 'P38 (concluded) — no comment');

  // AWAITING_INPUT P25 — utilities
  const snapP25 = snapshotCell(opf.getCell('P25'));
  assertEqual(snapP25.value, null, 'P25 (awaiting_input) value is null');
  assertEqual(snapP25.fillArgb, RED_FILL_ARGB, `P25 (awaiting_input) RED fill (${RED_FILL_ARGB})`);

  // FLIPPED — Concluded_Cap_Rate is now awaiting_input
  const ce = wb.getWorksheet('Conclusions & Escrows')!;
  const snapCap = snapshotCell(ce.getCell('I9'));  // Concluded_Cap_Rate is named at I9
  // Named-range resolution requires a defined name; our in-memory template
  // does not declare one. We instead inspect the projection state directly
  // for the address. The fill / comment write paths are exercised by
  // test-cell-state-rendering.ts.
  assertEqual(
    projection.states['Conclusions & Escrows!Concluded_Cap_Rate'],
    'awaiting_input',
    'Concluded_Cap_Rate FLIPPED v8 → v9 (now awaiting_input)',
  );
  assertEqual(
    projection.states['Conclusions & Escrows!Concluded_Value'],
    'awaiting_input',
    'Concluded_Value FLIPPED v8 → v9 (now awaiting_input)',
  );
  void snapCap;
}

function testHeldCellsAbsent(): void {
  console.log('\n[6] HELD cells (NOI / NCF / EGI / TotalOpEx) silently omitted from v9');
  const input = makeProjectionInput();
  const projection = projectCellBindings(input, 9);
  // The held rollup rows on Operating History and Pro Forma must produce
  // ZERO bindings at any column. The schema authors must not have added
  // ANY P-column / I-column / etc. cell at rows 17 / 33 / 35 / 44.
  for (const addr of Object.keys(projection.bindings)) {
    for (const pat of HELD_ROW_PATTERNS_OFFICE) {
      assert(
        !pat.test(addr),
        `binding address ${addr} does not match held row pattern ${pat}`,
      );
    }
  }
}

(async () => {
  console.log('=== test-phase-a-cells ===');
  testSchemaCompleteness();
  testProjectionEmitsExpectedStatesAndComments();
  testConcludedSelectorsReturnEngineValues();
  testAwaitingInputSelectorsReturnNull();
  await testWriteThroughTemplateEngine();
  testHeldCellsAbsent();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});

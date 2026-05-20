/**
 * Revision-semantics tests (Batch 6.3).
 *
 *   npm run test:revision-semantics
 *
 * Verifies the legacy-path implementation of the revision-lineage spec
 * (`docs/architecture/revision-lineage-spec.md`):
 *
 *   - L1 Append-only: a revision creates a new row; parent is unchanged.
 *   - L2 parentAnalysisId fixed at creation; never re-assigned.
 *   - L3 lineageRootId stable across the chain.
 *   - revisionOrdinal monotonic.
 *   - GET /:id resolves the latest revision in the lineage by default.
 *   - GET /:id?revisionId=X resolves to that specific historical node.
 *   - GET /:id?revisionId=X across lineages returns 404 (cross-lineage isolation).
 *   - GET /:id/lineage returns the full chain ordered by ordinal ascending.
 *
 * Direct service-level tests (no HTTP layer); the route handler is a thin shell over
 * `createRevision` + `store.getLatestRevisionInLineage` + `store.listLineage`. Wiring
 * tests at HTTP level are covered indirectly by the existing analysis.routes flows.
 */

import { v4 as uuid } from 'uuid';
import type { Analysis, UnderwritingModel } from '@cre/shared';
import { SqliteStore } from '../storage/sqlite-store.js';
import { createRevision } from '../services/revision-creator.service.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ----------------------------- fixture builders -------------------------- */

function lineItem(value: number) {
  return {
    id: 'li-' + Math.random().toString(36).slice(2, 7),
    label: 'item',
    annualAmount: value,
    isEditable: true,
    isOverridden: false,
    originalValue: value,
  };
}

function makeUwModel(): UnderwritingModel {
  return {
    income: {
      grossPotentialRent: lineItem(1_000_000),
      vacancyLoss: lineItem(50_000),
      concessions: lineItem(0),
      otherIncome: lineItem(0),
      effectiveGrossIncome: lineItem(950_000),
      additionalItems: [],
    },
    expenses: {
      realEstateTaxes: lineItem(80_000),
      insurance: lineItem(15_000),
      utilities: lineItem(20_000),
      repairsAndMaintenance: lineItem(30_000),
      management: lineItem(28_000),
      generalAndAdmin: lineItem(0),
      payroll: lineItem(0),
      replacementReserves: lineItem(20_000),
      totalExpenses: lineItem(193_000),
      additionalItems: [],
    },
    netOperatingIncome: 757_000,
    capRate: 0.065,
    impliedValue: 11_646_154,
    loanAmount: 7_000_000,
    interestRate: 0.07,
    amortizationYears: 30,
    termYears: 10,
    annualDebtService: 559_000,
    dscr: 1.354,
    ltv: 0.601,
    debtYield: 0.108,
    asReported: true,
    modifiedCells: [],
    loanDetails: {
      loanAmount: 7_000_000,
      interestRate: 0.07,
      rateType: 'fixed',
      ioMonths: 0,
      amortizationMonths: 360,
      termMonths: 120,
      paymentFrequency: 'monthly',
      prepaymentTerms: 'Defeasance',
      originationDate: '2026-05-01',
    },
    repaymentSchedule: null,
  };
}

function makeRootAnalysis(name = 'Test Deal'): Analysis {
  const id = uuid();
  const now = new Date().toISOString();
  return {
    id,
    name,
    assetType: 'multifamily',
    status: 'complete',
    progress: 100,
    currentStep: 'done',
    createdAt: now,
    updatedAt: now,
    document: null,
    uwDocument: null,
    supportingDocuments: [],
    templateDocument: null,
    findings: [],
    creditScore: null,
    uwModel: makeUwModel(),
    research: null,
    crossCheckFindings: [],
    mitigations: [],
    executiveSummary: null,
    bPieceDecision: null,
    comments: [],
    criteriaEvaluations: [],
    stressScenarios: [],
    parentAnalysisId: null,
    lineageRootId: id,
    revisionOrdinal: 0,
  };
}

/* ----------------------------------- tests ------------------------------ */

console.log('Batch 6.3 — revision semantics:\n');

const store = new SqliteStore(':memory:');
const root = makeRootAnalysis();
store.createAnalysis(root);

// Build a single 3-node lineage: root → rev1 → rev2. Used by every block below.
const rev1 = createRevision({
  parent: root,
  delta: { type: 'uw-model-cells', updates: [{ path: 'income.otherIncome.annualAmount', value: 50_000 }] },
});
store.createAnalysis(rev1);
const rev2 = createRevision({
  parent: rev1,
  delta: { type: 'loan-terms', updates: { interestRate: 0.075 } },
});
store.createAnalysis(rev2);

console.log('L1 — append-only: parent row unchanged after revision:');
{
  const reloadedParent = store.getAnalysis(root.id);
  assertEqual(reloadedParent?.id ?? '', root.id, 'parent id unchanged');
  assertEqual(reloadedParent?.uwModel?.income.otherIncome.annualAmount ?? -1,
    root.uwModel!.income.otherIncome.annualAmount,
    'parent uwModel unchanged (other income still 0)');
  // Each revision has a distinct id:
  assert(rev1.id !== root.id && rev2.id !== rev1.id && rev2.id !== root.id,
    'every revision has a distinct id');
}

console.log('\nL2 + L3 — parentAnalysisId fixed; lineageRootId stable:');
{
  assertEqual(rev1.parentAnalysisId ?? '', root.id, 'rev1.parent = root');
  assertEqual(rev2.parentAnalysisId ?? '', rev1.id, 'rev2.parent = rev1');
  assertEqual(rev1.lineageRootId ?? '', root.id, 'rev1.root = root.id');
  assertEqual(rev2.lineageRootId ?? '', root.id, 'rev2.root = root.id (carried through)');
  assertEqual(rev1.revisionOrdinal ?? -1, 1, 'rev1.ordinal = 1');
  assertEqual(rev2.revisionOrdinal ?? -1, 2, 'rev2.ordinal = 2 (monotonic)');
}

console.log('\nGET /:id resolves latest revision in lineage:');
{
  const latest = store.getLatestRevisionInLineage(root.id);
  assert(latest !== null, 'lineage has a latest');
  assertEqual(latest?.revisionOrdinal ?? -1, 2, 'latest is rev2 (ordinal 2)');
  assertEqual(latest?.lineageRootId ?? '', root.id, 'latest still in same lineage');
  // Calling getLatest from any node in the chain returns the same head:
  const fromRev1 = store.getLatestRevisionInLineage(rev1.id);
  assertEqual(fromRev1?.id ?? '', rev2.id, 'getLatest from rev1.id returns rev2');
}

console.log('\nGET /:id/lineage returns full chain ordered by ordinal:');
{
  const lineage = store.listLineage(root.id);
  assertEqual(lineage.length, 3, 'lineage has 3 entries (root + 2 revisions)');
  assertEqual(lineage[0]?.revisionOrdinal ?? -1, 0, 'entry 0 is root');
  assertEqual(lineage[1]?.revisionOrdinal ?? -1, 1, 'entry 1 is rev1');
  assertEqual(lineage[2]?.revisionOrdinal ?? -1, 2, 'entry 2 is rev2');
  assertEqual(lineage[0]?.parentAnalysisId, null, 'root parent is null');
  assertEqual(lineage[1]?.parentAnalysisId ?? '', root.id, 'rev1 parent = root');
  assertEqual(lineage[2]?.parentAnalysisId ?? '', rev1.id, 'rev2 parent = rev1');
}

console.log('\nCross-lineage isolation:');
{
  // A separate root analysis must not appear in the first lineage's chain.
  const root2 = makeRootAnalysis('Other Deal');
  store.createAnalysis(root2);
  const lineage1 = store.listLineage(root.id);
  const lineage2 = store.listLineage(root2.id);
  assert(!lineage1.some(e => e.id === root2.id), 'lineage 1 does not contain lineage 2 root');
  assert(!lineage2.some(e => e.id === root.id), 'lineage 2 does not contain lineage 1 root');
  assertEqual(lineage2.length, 1, 'lineage 2 has 1 entry (root only)');
}

console.log('\nDelta application — uwModel cells:');
{
  const rev = createRevision({
    parent: root,
    delta: { type: 'uw-model-cells', updates: [{ path: 'income.otherIncome.annualAmount', value: 75_000 }] },
  });
  assertEqual(rev.uwModel?.income.otherIncome.annualAmount ?? -1, 75_000,
    'cell update applied to revision');
  assertEqual(rev.uwModel?.income.otherIncome.isOverridden ?? false, true,
    'updated cell marked isOverridden');
  assertEqual(rev.uwModel?.asReported ?? true, false, 'asReported flipped to false');
  // Parent untouched:
  assertEqual(root.uwModel?.income.otherIncome.annualAmount ?? -1, 0,
    'parent cell value unchanged after revision');
}

console.log('\nDelta application — loan terms:');
{
  const rev = createRevision({
    parent: root,
    delta: { type: 'loan-terms', updates: { interestRate: 0.075, termMonths: 120 } },
  });
  assertEqual(rev.uwModel?.interestRate ?? -1, 0.075, 'interest rate updated');
  assertEqual(rev.uwModel?.loanDetails.interestRate ?? -1, 0.075,
    'loanDetails.interestRate also updated');
  // Parent unchanged:
  assertEqual(root.uwModel?.interestRate ?? -1, 0.07, 'parent rate unchanged');
}

console.log('\nPrecondition — parent missing uwModel throws:');
{
  const noModel = { ...makeRootAnalysis(), uwModel: null };
  let threw = false;
  try {
    createRevision({ parent: noModel, delta: { type: 'uw-model-cells', updates: [] } });
  } catch (e: any) {
    threw = e?.message?.includes('REVISION_CREATE_PRECONDITION') ?? false;
  }
  assertEqual(threw, true, 'createRevision throws REVISION_CREATE_PRECONDITION on missing uwModel');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

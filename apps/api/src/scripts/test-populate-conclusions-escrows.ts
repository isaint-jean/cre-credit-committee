// Tests for Conclusions & Escrows tab populator.
//
//   npm run test:populate-conclusions-escrows

import ExcelJS from 'exceljs';
import { populateTemplate } from '../services/template-engine.service.js';
import type { LineItem, UnderwritingModel } from '@cre/shared';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

function lineItem(id: string, annual: number): LineItem {
  return { id, label: id, annualAmount: annual, isEditable: true, isOverridden: false, originalValue: annual };
}

function makeUwModel(overrides: Partial<UnderwritingModel> = {}): UnderwritingModel {
  return {
    income: {
      grossPotentialRent: lineItem('grossPotentialRent', 0),
      vacancyLoss: lineItem('vacancyLoss', 0),
      concessions: lineItem('concessions', 0),
      otherIncome: lineItem('otherIncome', 0),
      effectiveGrossIncome: lineItem('effectiveGrossIncome', 0),
      additionalItems: [],
    },
    expenses: {
      realEstateTaxes: lineItem('realEstateTaxes', 0),
      insurance: lineItem('insurance', 0),
      utilities: lineItem('utilities', 0),
      repairsAndMaintenance: lineItem('repairsAndMaintenance', 0),
      management: lineItem('management', 0),
      generalAndAdmin: lineItem('generalAndAdmin', 0),
      payroll: lineItem('payroll', 0),
      replacementReserves: lineItem('replacementReserves', 0),
      totalExpenses: lineItem('totalExpenses', 0),
      additionalItems: [],
    },
    netOperatingIncome: 10_891_776,
    capRate: 0.0464,
    impliedValue: 234_536_308,
    loanAmount: 85_000_000,
    interestRate: 7.16,
    amortizationYears: 30,
    termYears: 5,
    annualDebtService: 0,
    dscr: 0,
    ltv: 0,
    debtYield: 0,
    asReported: true,
    modifiedCells: [],
    loanDetails: {
      loanAmount: 85_000_000, interestRate: 7.16, rateType: 'fixed', ioMonths: 0,
      amortizationMonths: 360, termMonths: 60,
      paymentFrequency: 'monthly', prepaymentTerms: '', originationDate: '2026-01-01',
    },
    repaymentSchedule: null,
    ...overrides,
  };
}

async function makeConclusionsWorkbook(opts: { i7Formula?: boolean; i9Formula?: boolean; i11Formula?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Conclusions & Escrows');
  ws.getCell('G7').value = 'Eightfold Concluded Value:';
  ws.getCell('G9').value = 'Eightfold Concluded Cap Rate / LTV:';
  ws.getCell('G11').value = 'Appraisal Value:';
  if (opts.i7Formula) ws.getCell('I7').value = { formula: 'MROUND(1,1)', result: 0 } as ExcelJS.CellFormulaValue;
  if (opts.i9Formula) ws.getCell('I9').value = { formula: '0.05', result: 0.05 } as ExcelJS.CellFormulaValue;
  if (opts.i11Formula) ws.getCell('I11').value = { formula: 'B1', result: 0 } as ExcelJS.CellFormulaValue;
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

async function main(): Promise<void> {

console.log('Conclusions & Escrows: I9 ← capRate, I11 ← impliedValue');
{
  const buf = await makeConclusionsWorkbook();
  const result = await populateTemplate(buf, makeUwModel());

  assert(result.tabsPopulated.includes('Conclusions & Escrows'), 'tab marked populated');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.populatedBuffer as never);
  const ws = wb.getWorksheet('Conclusions & Escrows')!;
  assertEqual(ws.getCell('I9').value,  0.0464,      'I9 = capRate (decimal fraction)');
  assertEqual(ws.getCell('I11').value, 234_536_308, 'I11 = impliedValue');

  const fields = new Set(result.mappedFields.map((m) => m.field));
  assert(fields.has('concludedCapRate'),    'concludedCapRate in mappedFields');
  assert(fields.has('appraisalValueProxy'), 'appraisalValueProxy in mappedFields');
}

console.log('\nConclusions & Escrows: formula cells preserved (I9 / I11)');
{
  const buf = await makeConclusionsWorkbook({ i9Formula: true, i11Formula: true });
  const result = await populateTemplate(buf, makeUwModel());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.populatedBuffer as never);
  const ws = wb.getWorksheet('Conclusions & Escrows')!;
  const i9 = ws.getCell('I9').value;
  const i11 = ws.getCell('I11').value;
  assert(typeof i9  === 'object' && i9  !== null && 'formula' in i9,  'I9 formula preserved (not overwritten)');
  assert(typeof i11 === 'object' && i11 !== null && 'formula' in i11, 'I11 formula preserved (not overwritten)');
}

console.log('\nConclusions & Escrows: zero capRate skipped (no write)');
{
  const buf = await makeConclusionsWorkbook();
  const result = await populateTemplate(buf, makeUwModel({ capRate: 0 }));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.populatedBuffer as never);
  const ws = wb.getWorksheet('Conclusions & Escrows')!;
  assertEqual(ws.getCell('I9').value, null, 'capRate=0 → I9 not written');
  // I11 still writes because impliedValue is non-zero
  assertEqual(ws.getCell('I11').value, 234_536_308, 'impliedValue still writes');
}

console.log('\nConclusions & Escrows: null impliedValue skipped (no write)');
{
  const buf = await makeConclusionsWorkbook();
  const result = await populateTemplate(buf, makeUwModel({ impliedValue: null }));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.populatedBuffer as never);
  const ws = wb.getWorksheet('Conclusions & Escrows')!;
  assertEqual(ws.getCell('I11').value, null, 'impliedValue=null → I11 not written');
  assertEqual(ws.getCell('I9').value, 0.0464, 'capRate still writes');
}

console.log('\nConclusions & Escrows: I7 (formula) not touched by populator');
{
  const buf = await makeConclusionsWorkbook({ i7Formula: true });
  const result = await populateTemplate(buf, makeUwModel());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(result.populatedBuffer as never);
  const ws = wb.getWorksheet('Conclusions & Escrows')!;
  const i7 = ws.getCell('I7').value;
  assert(typeof i7 === 'object' && i7 !== null && 'formula' in i7, 'I7 formula preserved (populator does not write here)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

}

main().catch((e) => { console.error(e); process.exit(1); });

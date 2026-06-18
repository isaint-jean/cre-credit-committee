/**
 * test-write-cell-value-nan-guard — load-bearing invariant test for the
 * populator's OOXML-validity guard. The guard ensures NO code path below
 * writeCellValue can produce an OOXML-invalid file (a file with <v>NaN</v>
 * or <v>Infinity</v> in its worksheet XML, which Excel/openpyxl reject).
 *
 *   cd apps/api && npx tsx src/scripts/test-write-cell-value-nan-guard.ts
 *
 * We exercise the guard end-to-end via the real populator path (no private
 * function imports): build a one-cell payload, apply it to a minimal
 * workbook, write to buffer, then inspect the serialized XML for the
 * literal "NaN" / "Infinity" tokens that would crash Excel.
 */
import ExcelJS from 'exceljs';
import { applyRenderPayloadToTemplate } from '../services/template-engine.service.js';
import type { RenderPayload } from '@cre/shared';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void { if (a === b) ok(m); else fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }

async function makeMinimalTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.getCell('A1').value = 'label';
  // B1 is a pure input cell — populator will write through.
  // C1 is a formula referencing B1, demonstrating the cascade.
  ws.getCell('C1').value = { formula: '+B1*2', result: 0 } as ExcelJS.CellFormulaValue;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function makePayload(value: number | null): RenderPayload {
  return {
    contractVersion: 9 as never,
    assetClass: 'office',
    structuralVariantKey: 'office_core',
    underwritingMode: 'single_loan',
    cellBindings: { 'Sheet1!B1': value },
    cellStates: { 'Sheet1!B1': 'concluded' },
    cellComments: {},
    schemaAddresses: ['Sheet1!B1'],
    visibleTabs: ['Sheet1'],
    tables: [],
  } as never;
}

async function rawXmlOfSheet1(populated: Buffer): Promise<string> {
  // Unpack the xlsx (it's a zip) and read sheet1.xml directly.
  // Using exceljs to round-trip is enough for these checks — load, serialize,
  // then inspect the raw <c><v> cells.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(populated as never);
  // exceljs's `model.sheets` doesn't directly expose raw XML; rewrite to a
  // fresh buffer and unzip the sheet1 entry.
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('xl/worksheets/sheet1.xml');
  if (!entry) throw new Error('xl/worksheets/sheet1.xml missing');
  return entry.async('string');
}

(async () => {
  /* ----- Finite value sails through unchanged --------------------------- */

  console.log('Finite numeric value writes normally:');
  {
    const tpl = await makeMinimalTemplate();
    const result = await applyRenderPayloadToTemplate(tpl, makePayload(42));
    const xml = await rawXmlOfSheet1(result.populatedBuffer);
    assert(!xml.includes('>NaN<'), 'no <v>NaN</v> token in raw XML');
    assert(!xml.includes('>Infinity<'), 'no <v>Infinity</v> token');
    assert(xml.includes('>42<'), 'finite value 42 IS in raw XML');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.populatedBuffer as never);
    assertEqual(wb.getWorksheet('Sheet1')!.getCell('B1').value, 42, 'B1 read-back = 42');
  }

  /* ----- NaN guard fires: cell becomes null, no NaN in XML -------------- */

  console.log('\nNaN guard:');
  {
    const tpl = await makeMinimalTemplate();
    const result = await applyRenderPayloadToTemplate(tpl, makePayload(Number.NaN));
    const xml = await rawXmlOfSheet1(result.populatedBuffer);
    assert(!xml.includes('>NaN<'),  'no <v>NaN</v> in raw XML when input was NaN');
    assert(!xml.includes('>nan<'),  'no <v>nan</v> in raw XML (case-insensitive guard)');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.populatedBuffer as never);
    const v = wb.getWorksheet('Sheet1')!.getCell('B1').value;
    assert(v === null || v === undefined, 'B1 read-back is null/undefined (not NaN)');
  }

  /* ----- +Infinity guard fires ------------------------------------------ */

  console.log('\n+Infinity guard:');
  {
    const tpl = await makeMinimalTemplate();
    const result = await applyRenderPayloadToTemplate(tpl, makePayload(Number.POSITIVE_INFINITY));
    const xml = await rawXmlOfSheet1(result.populatedBuffer);
    assert(!xml.includes('>Infinity<'), 'no <v>Infinity</v> in raw XML when input was +Inf');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.populatedBuffer as never);
    const v = wb.getWorksheet('Sheet1')!.getCell('B1').value;
    assert(v === null || v === undefined, 'B1 read-back is null/undefined (not Infinity)');
  }

  /* ----- -Infinity guard fires ------------------------------------------ */

  console.log('\n-Infinity guard:');
  {
    const tpl = await makeMinimalTemplate();
    const result = await applyRenderPayloadToTemplate(tpl, makePayload(Number.NEGATIVE_INFINITY));
    const xml = await rawXmlOfSheet1(result.populatedBuffer);
    assert(!xml.includes('>-Infinity<'), 'no <v>-Infinity</v> in raw XML when input was -Inf');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.populatedBuffer as never);
    const v = wb.getWorksheet('Sheet1')!.getCell('B1').value;
    assert(v === null || v === undefined, 'B1 read-back is null/undefined (not -Infinity)');
  }

  /* ----- null passes through (cell stays empty, no corruption) ---------- */

  console.log('\nnull pass-through:');
  {
    const tpl = await makeMinimalTemplate();
    const result = await applyRenderPayloadToTemplate(tpl, makePayload(null));
    const xml = await rawXmlOfSheet1(result.populatedBuffer);
    assert(!xml.includes('>NaN<'), 'no NaN token');
    assert(!xml.includes('>Infinity<'), 'no Infinity token');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('Unhandled:', e); process.exit(2); });

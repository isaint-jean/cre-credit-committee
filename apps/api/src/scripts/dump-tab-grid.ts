// Dump a rectangular grid of a worksheet (cell values + formula flag),
// so we can see structure not just labels.

import ExcelJS from 'exceljs';
import * as fs from 'node:fs';

const path = process.argv[2];
const tabName = process.argv[3];
const startRow = Number(process.argv[4] || '1');
const endRow   = Number(process.argv[5] || '20');
const startCol = Number(process.argv[6] || '1');
const endCol   = Number(process.argv[7] || '20');

if (!path || !tabName) {
  console.error('usage: tsx dump-tab-grid.ts <xlsx> <tab> [r1=1 r2=20 c1=1 c2=20]');
  process.exit(1);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(path) as never);
  const ws = wb.getWorksheet(tabName);
  if (!ws) { console.error('tab not found'); process.exit(2); }
  console.log('rows=' + ws.rowCount + ' cols=' + ws.columnCount);
  for (let r = startRow; r <= Math.min(endRow, ws.rowCount); r++) {
    for (let c = startCol; c <= Math.min(endCol, ws.columnCount); c++) {
      const cell = ws.getCell(r, c);
      const v = cell.value;
      if (v === null || v === undefined) continue;
      let text: string;
      if (typeof v === 'string') text = v;
      else if (typeof v === 'number') text = String(v);
      else if (v instanceof Date) text = v.toISOString().slice(0, 10);
      else if (typeof v === 'object' && 'richText' in v) text = (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
      else if (typeof v === 'object' && 'text' in v) text = String((v as { text: unknown }).text);
      else if (typeof v === 'object' && 'result' in v) text = '=' + String((v as { result: unknown }).result);
      else if (typeof v === 'object' && 'formula' in v) text = '=' + String((v as { formula: unknown }).formula).slice(0, 30);
      else continue;
      text = text.trim().replace(/\s+/g, ' ');
      if (text.length === 0) continue;
      if (text.length > 50) text = text.slice(0, 47) + '...';
      const tag = cell.formula ? '[F]' : '   ';
      console.log(tag + ' R' + r + 'C' + c + ' ' + text);
    }
  }
})();

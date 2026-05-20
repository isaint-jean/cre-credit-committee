// One-off inspection script: dump label cells (text, non-formula) for a
// list of named tabs from a workbook, with row/col coordinates and a hint at
// the adjacent value cell. Used for Batch 1 planning.

import ExcelJS from 'exceljs';
import * as fs from 'node:fs';

const path = process.argv[2];
const tabs = process.argv.slice(3);
if (!path || tabs.length === 0) {
  console.error('usage: tsx dump-tab-labels.ts <xlsx> <tab1> [tab2 ...]');
  process.exit(1);
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(path) as never);
  for (const tabName of tabs) {
    const ws = wb.getWorksheet(tabName);
    if (!ws) { console.log(`!! TAB NOT FOUND: ${tabName}`); continue; }
    console.log('\n========== ' + tabName + ' (' + ws.rowCount + ' rows × ' + ws.columnCount + ' cols) ==========');
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const isFormula = !!cell.formula;
        const v = cell.value;
        if (v === null || v === undefined) return;
        let text: string;
        if (typeof v === 'string') text = v;
        else if (typeof v === 'number') text = String(v);
        else if (typeof v === 'boolean') text = v ? 'TRUE' : 'FALSE';
        else if (v instanceof Date) text = v.toISOString();
        else if (typeof v === 'object' && 'richText' in v) text = (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
        else if (typeof v === 'object' && 'text' in v) text = String((v as { text: unknown }).text);
        else if (typeof v === 'object' && 'result' in v) text = String((v as { result: unknown }).result);
        else return;
        text = text.trim();
        if (text.length === 0 || text.length > 100) return;
        const ref = String.fromCharCode(64 + Math.min(colNumber, 26)) + (colNumber > 26 ? '?' : '') + rowNumber;
        const tag = isFormula ? '[F]' : '   ';
        console.log(`${tag} ${ref.padEnd(6)} R${rowNumber}C${colNumber}  ${text}`);
      });
    });
  }
})();

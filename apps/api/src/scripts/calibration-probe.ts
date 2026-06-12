/**
 * Probe the asset-type label location + Operating History period-column layout
 * across several known deals. Output drives the hardened harness extractors.
 */
import * as path from 'node:path';
import ExcelJS from 'exceljs';

function strOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && v !== null && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('').trim() || null;
  }
  return null;
}
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'object' && v !== null && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
  }
  return null;
}

const ROOT = '/Users/isabellesaint-jean/Downloads/Intelligence/Archive';
const TARGETS = [
  ['Showcase Retail', '003. Showcase I.xlsm'],
  ['Sunroad Office',  '001- Sunroad Centrum - OK TO PRINT JN.xlsm'],
  ['Aloft Hotel',     '079- Aloft Hotel - Delray Beach -.xlsm'],
  ['Cortland MF',     '002- Cortland West Champions - JK with sites.xlsx'],
  ['West Fargo Industrial', '079- West Fargo Industrial Final.xlsm'],
] as const;

(async () => {
  for (const [label, file] of TARGETS) {
    console.log('\n==============================================');
    console.log(`== ${label}: ${file}`);
    console.log('==============================================');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.readFile(path.join(ROOT, file)); }
    catch (e) { console.log('  ERR open:', (e as Error).message); continue; }

    const pls = wb.getWorksheet('Property & Loan Summary');
    const ops = wb.getWorksheet('Operating History and Pro Forma');

    if (pls) {
      console.log('\n-- PLS: rows 2-9 dumping cells where col A/G contain "Type" --');
      for (let r = 2; r <= 12; r++) {
        const row = pls.getRow(r);
        // Print row with non-empty cells
        const allCells: string[] = [];
        for (let c = 1; c <= 14; c++) {
          const s = strOrNull(row.getCell(c).value);
          if (s) allCells.push(`${String.fromCharCode(64+c)}${r}="${s.slice(0,30)}"`);
        }
        if (allCells.some(s => /[Tt]ype|[Aa]sset|[Pp]roperty\s+[Ss]ub/.test(s))) {
          console.log('   ', allCells.join(' | '));
        }
      }
    }

    if (ops) {
      console.log('\n-- OPS: PERIOD HEADER scan rows 1-29 --');
      for (let r = 1; r <= 29; r++) {
        const row = ops.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= 14; c++) {
          const s = strOrNull(row.getCell(c).value);
          if (s) cells.push(`${c}=${s.slice(0,18)}`);
        }
        if (cells.length && cells.some(s => /T-?12|TTM|trailing|UW|seller|2023|2024|2022|year\s*1/i.test(s))) {
          console.log(`    r${r}: ${cells.join(' | ')}`);
        }
      }
      console.log('\n-- OPS: header scan rows 30-37 (find period labels) --');
      for (let r = 30; r <= 37; r++) {
        const row = ops.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= 14; c++) {
          const s = strOrNull(row.getCell(c).value);
          if (s) cells.push(`${c}=${s.slice(0,30)}`);
        }
        if (cells.length) console.log(`    r${r}: ${cells.join(' | ')}`);
      }
      console.log('\n-- OPS: NOI row content (all 14 cols) --');
      // Find NOI row
      for (let r = 33; r <= 45; r++) {
        const a = strOrNull(ops.getRow(r).getCell(1).value);
        if (a && /^net\s+operating\s+income/i.test(a)) {
          const row = ops.getRow(r);
          const out: string[] = [];
          for (let c = 1; c <= 14; c++) {
            const v = row.getCell(c).value;
            const n = numOrNull(v);
            const s = strOrNull(v);
            out.push(`${c}=${n !== null ? Math.round(n) : (s ?? '·')}`);
          }
          console.log(`    r${r} (NOI): ${out.join(' | ')}`);
          break;
        }
      }
    }
  }
})();

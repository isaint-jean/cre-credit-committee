/**
 * Spot-debug a single workbook through the harness's extraction path.
 * Helps diagnose why no rows are appended (probably cell layout variance).
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

async function probe(p: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  console.log('==', path.basename(p));
  console.log('  sheets:', wb.worksheets.map(w => w.name).slice(0, 6).join(' | '), '...');
  const pls = wb.getWorksheet('Property & Loan Summary');
  if (!pls) { console.log('  NO PLS sheet'); return; }
  console.log('  PLS rows 10-20:');
  for (let r = 10; r <= 20; r++) {
    const row = pls.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= 12; c++) {
      const v = row.getCell(c).value;
      const s = strOrNull(v) ?? (numOrNull(v) !== null ? String(numOrNull(v)).slice(0, 14) : '');
      if (s) cells.push(`${String.fromCharCode(64+c)}${r}=${s.slice(0,32)}`);
    }
    if (cells.length) console.log('   ', cells.slice(0, 6).join('  '));
  }
  const ops = wb.getWorksheet('Operating History and Pro Forma');
  if (ops) {
    console.log('  OPS NOI/EGI/OpEx rows (scan first match):');
    for (let r = 25; r <= 55; r++) {
      const row = ops.getRow(r);
      const a = strOrNull(row.getCell(1).value) ?? strOrNull(row.getCell(2).value);
      if (a && /^(net operating|effective gross|operating expense|gross potential)/i.test(a)) {
        const vals: string[] = [];
        for (let c = 2; c <= 12; c += 2) {
          const v = numOrNull(row.getCell(c).value);
          if (v !== null) vals.push(`col${c}=${v.toFixed(0)}`);
        }
        console.log(`    r${r} "${a.slice(0,40)}" → ${vals.join(' ')}`);
      }
    }
  }
  const ce = wb.getWorksheet('Conclusions & Escrows');
  if (ce) {
    console.log('  CE cap/value/LTV scan:');
    for (let r = 5; r <= 15; r++) {
      const row = ce.getRow(r);
      for (let c = 1; c <= 12; c++) {
        const s = strOrNull(row.getCell(c).value);
        if (s && /eightfold|concluded/i.test(s)) {
          // print this row's numeric content
          const nums = [9, 10, 11].map(cc => numOrNull(row.getCell(cc).value)).filter((v): v is number => v !== null);
          console.log(`    r${r} "${s.slice(0,40)}" nums:`, nums.map(n => n.toFixed(4)).join(' | '));
          break;
        }
      }
    }
  }
  console.log();
}

const ROOT = '/Users/isabellesaint-jean/Downloads/Intelligence/Archive';
const targets = [
  '003. Showcase I.xlsm',
  '001- Sunroad Centrum - OK TO PRINT JN.xlsm',
  '001- 1201 Third Avenue.xlsm',
  '002- Cortland West Champions - JK with sites.xlsx',
  '011- Soldier Hill Commons DRAFT UW.xlsm',
];
(async () => {
  for (const t of targets) {
    try { await probe(path.join(ROOT, t)); }
    catch (e) { console.log('ERR on', t, '→', (e as Error).message); }
  }
})();

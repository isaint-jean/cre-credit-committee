import { analyzeTemplateStructure } from '../services/template-engine.service.js';
import * as fs from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: tsx inspect-template.ts <path>'); process.exit(1); }
const buf = fs.readFileSync(path);

(async () => {
  const structure = await analyzeTemplateStructure(buf);
  console.log('=== TEMPLATE STRUCTURE ===');
  console.log('Total tabs:', structure.totalTabs);
  console.log('Total formula cells:', structure.totalFormulaCells);
  console.log('Total input cells:', structure.totalInputCells);
  console.log('');
  console.log('=== TABS ===');
  for (const t of structure.tabs) {
    console.log('[' + t.index + '] ' + t.name);
    console.log('    category=' + t.category + ' rows=' + t.rowCount + ' cols=' + t.colCount + ' formulas=' + t.formulaCells + ' inputs=' + t.inputCells);
    if (t.headers.length > 0) console.log('    headers: ' + t.headers.slice(0, 12).join(' | '));
  }
})();

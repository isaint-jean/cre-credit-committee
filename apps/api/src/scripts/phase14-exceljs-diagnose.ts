/**
 * Phase 14 — ExcelJS write-path diagnosis.
 *
 *   cd apps/api && npx tsx src/scripts/phase14-exceljs-diagnose.ts
 *
 * The Phase A populated-workbook export occasionally fails on the
 * `workbook.xlsx.writeBuffer()` call when the template carries shared-
 * formula references that downstream code mutated. Phase 13 already
 * pre-resolves sharedFormulas inline; Phase 14 promotes that workaround
 * into the template-engine. This script is the isolation diagnostic:
 *
 *   1. Load `Blank_UW_Template_v2.xlsm` and call `writeBuffer()` with NO
 *      mutations. Report success / failure.
 *   2. If (1) succeeds, sanitize conditional-formatting only and retry.
 *      (CF is already known to crash on some rules; the template-engine
 *      already calls `sanitizeConditionalFormatting`.)
 *   3. If (2) succeeds, mutate a single cell (Property & Loan Summary's
 *      Coupon defined-name) and retry.
 *   4. If (3) succeeds, run the sharedFormula pre-resolution pass and
 *      retry.
 *
 * The goal: isolate WHICH step (load / CF / mutation / sharedFormula)
 * triggers the failure, so the in-engine workaround can be scoped
 * accordingly.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  SCRIPT_DIR,
  '../../../../docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm',
);

async function loadWorkbook(): Promise<ExcelJS.Workbook> {
  const buf = readFileSync(TEMPLATE_PATH);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  return wb;
}

async function tryWrite(wb: ExcelJS.Workbook, label: string): Promise<boolean> {
  try {
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    console.log(`  [${label}] writeBuffer ok (${buf.length} bytes)`);
    return true;
  } catch (e) {
    const err = e as Error;
    console.log(`  [${label}] writeBuffer FAILED: ${err.constructor.name}: ${err.message}`);
    const stackLines = (err.stack ?? '').split('\n').slice(0, 4).join('\n    ');
    if (stackLines) console.log(`    ${stackLines}`);
    return false;
  }
}

function sanitizeConditionalFormatting(workbook: ExcelJS.Workbook): number {
  const FORMULA_TYPES = new Set([
    'expression', 'cellIs', 'top10', 'aboveAverage', 'containsText', 'timePeriod',
  ]);
  let dropped = 0;
  workbook.eachSheet((ws) => {
    const cfList = (ws as any).conditionalFormattings;
    if (!Array.isArray(cfList)) return;
    for (const cf of cfList) {
      if (!Array.isArray(cf.rules)) continue;
      cf.rules = cf.rules.filter((r: any) => {
        const t = r?.type;
        if (!FORMULA_TYPES.has(t)) return true;
        if (Array.isArray(r.formulae) && r.formulae.length > 0) return true;
        dropped++;
        return false;
      });
    }
  });
  return dropped;
}

function preResolveSharedFormulas(workbook: ExcelJS.Workbook): number {
  let resolved = 0;
  workbook.eachSheet((ws) => {
    const masters: Record<string, string> = {};
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'formula' in v && !('sharedFormula' in v) && typeof v.formula === 'string') {
          masters[cell.address] = v.formula as string;
        }
      });
    });
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'sharedFormula' in v) {
          const masterRef = v.sharedFormula as string;
          const masterFormula = masters[masterRef];
          if (masterFormula) {
            cell.value = { formula: masterFormula, result: v.result } as any;
            resolved++;
          } else {
            cell.value = v.result ?? null;
          }
        }
      });
    });
  });
  return resolved;
}

function countSharedFormulas(workbook: ExcelJS.Workbook): number {
  let count = 0;
  workbook.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as any;
        if (v && typeof v === 'object' && 'sharedFormula' in v) count++;
      });
    });
  });
  return count;
}

(async () => {
  console.log('============================================================');
  console.log('PHASE 14 — ExcelJS write-path diagnosis');
  console.log('============================================================');
  console.log(`Template: ${TEMPLATE_PATH}`);

  // --- Step 1: NO MUTATIONS
  console.log('\n[1] Load + writeBuffer (no mutations)');
  {
    const wb = await loadWorkbook();
    const sf = countSharedFormulas(wb);
    console.log(`  sharedFormula count: ${sf}`);
    await tryWrite(wb, 'no-mutation');
  }

  // --- Step 2: sanitize CF only
  console.log('\n[2] Load + sanitizeCF + writeBuffer');
  {
    const wb = await loadWorkbook();
    const dropped = sanitizeConditionalFormatting(wb);
    console.log(`  CF rules dropped: ${dropped}`);
    await tryWrite(wb, 'sanitize-cf');
  }

  // --- Step 3: single cell mutation (no preresolve)
  console.log('\n[3] Load + sanitizeCF + single cell mutation + writeBuffer');
  {
    const wb = await loadWorkbook();
    sanitizeConditionalFormatting(wb);
    const ws = wb.getWorksheet('Property & Loan Summary');
    if (ws) {
      try {
        ws.getCell('E18').value = 0.0716;
        console.log('  wrote Property & Loan Summary!E18 = 0.0716');
      } catch (e) {
        console.log(`  cell write threw: ${(e as Error).message}`);
      }
    } else {
      console.log('  Property & Loan Summary sheet missing — skipping cell write');
    }
    await tryWrite(wb, 'single-mutation');
  }

  // --- Step 4: load + preresolve + sanitizeCF + single cell mutation
  console.log('\n[4] Load + preResolveSharedFormulas + sanitizeCF + mutation + writeBuffer');
  {
    const wb = await loadWorkbook();
    const resolved = preResolveSharedFormulas(wb);
    console.log(`  sharedFormulas pre-resolved: ${resolved}`);
    sanitizeConditionalFormatting(wb);
    const ws = wb.getWorksheet('Property & Loan Summary');
    if (ws) ws.getCell('E18').value = 0.0716;
    await tryWrite(wb, 'preresolve+mutation');
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================');
})().catch((e) => {
  console.error('diagnose script threw:', e);
  process.exit(2);
});

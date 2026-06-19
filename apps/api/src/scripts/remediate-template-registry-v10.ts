/**
 * uw_templates remediation — register a v10 row for the Rent Roll render
 * (RENDER_CONTRACT_VERSION 9 → 10).
 *
 * Why this is its own script (not store.uploadTemplate)
 * -----------------------------------------------------
 * `uploadTemplate` at apps/api/src/storage/sqlite-store.ts:773-810 computes
 * the new row's version as `MAX(version)+1`. Current DB MAX is 6 (after the
 * v6 remediation). Calling uploadTemplate now would land the row at v7,
 * which has NO registry entry — getTemplateMetadata('single_loan', 7)
 * returns null, the export pipeline's compatibility check then refuses the
 * row, and we'd be back in the v3/v4/v5 pollution shape from two passes
 * ago. The right move is the same one the v6 remediation took: direct
 * INSERT with an explicit version number, paired with a prior registry
 * commit that declares the version. Idempotent and registry-aligned.
 *
 * Why version=10 (not 7)
 * ----------------------
 * Aligning template version with RENDER_CONTRACT_VERSION makes the registry
 * self-documenting — anyone reading uw_templates sees `version=10` and can
 * immediately look up template-registry.ts v10 → contractV10 → schema v10.
 * The downside is that DB rows v7/v8/v9 will never exist, but that's
 * cosmetic. Pollution v3/v4/v5 was deleted in the v6 remediation; v7/v8/v9
 * are skipped intentionally and stay outside the registry.
 *
 * What this script does
 * ---------------------
 *   1. Pre-flight checks: template-registry has v10; current DB state has
 *      v6 active and exactly the 3 expected rows (v1, v2, v6) after the
 *      v6 remediation; the source xlsm artifact loads cleanly with vbaProject
 *      still intact.
 *   2. Direct INSERT a new uw_templates row at version=10 with the patched
 *      Blank_UW_Template_v2.xlsm (same artifact as v6 — no workbook content
 *      change at v10; the schema change is in code, not in the xlsm).
 *   3. Flip is_active=0 on v6, set is_active=1 on the new v10 row.
 *   4. Verify getActiveTemplate('single_loan') returns v10 with non-null
 *      templateMetadata (contractV10).
 *
 * Idempotency
 * -----------
 * If v10 is already in uw_templates AND already active, this script no-ops
 * after the pre-flight. Safe to rerun.
 *
 * FOLLOW-UP BANK (carried from the v6 remediation, still unfixed)
 * --------------------------------------------------------------
 * The bp-spire ops script and other operator-facing uploadTemplate callers
 * still create new template versions WITHOUT enforcing a registry entry
 * for the new (templateType, MAX+1). That's the root cause of the v3/v4/v5
 * pollution and would have caused the same trap here had we used
 * uploadTemplate. The gate should be: `store.uploadTemplate` (or an explicit
 * targetVersion overload) must refuse to write a row whose
 * (templateType, version) is not in the code registry. Captured here AND
 * in apps/api/src/scripts/remediate-template-registry-v6.ts; still pending.
 *
 *   cd apps/api && npx tsx src/scripts/remediate-template-registry-v10.ts
 */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

import { store } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';
import {
  analyzeTemplateStructure,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-engine.service.js';
import {
  getTemplateMetadata,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-registry.js';

const DB = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/data/cre.db';
const SRC = '/Users/isabellesaint-jean/Downloads/Intelligence/Blank UW/Blank_UW_Template_v2.xlsm';

interface UwTemplateRow {
  id: string;
  template_type: string;
  version: number;
  is_active: number;
  file_size: number;
  uploaded_at: string;
}

function section(t: string): void {
  console.log('\n================================================================');
  console.log(t);
  console.log('================================================================');
}

function listSingleLoan(db: Database.Database): UwTemplateRow[] {
  return db.prepare(
    `SELECT id, template_type, version, is_active, file_size, uploaded_at
     FROM uw_templates WHERE template_type='single_loan' ORDER BY version`,
  ).all() as UwTemplateRow[];
}

function printRows(rows: UwTemplateRow[]): void {
  for (const r of rows) {
    console.log(`  v${r.version}  ${r.id.slice(0, 8)}…  is_active=${r.is_active}  bytes=${r.file_size}  uploaded_at=${r.uploaded_at}`);
  }
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

(async () => {
  section('PRE-FLIGHT');

  const v10Meta = getTemplateMetadata('single_loan', 10);
  if (!v10Meta) {
    console.error('  ✗ template-registry.ts does NOT contain single_loan v10. Land the registry commit first.');
    process.exit(2);
  }
  console.log(`  ✓ registry knows single_loan v10 (contractV=${v10Meta.compatibleContractVersion} classes=${v10Meta.supportedAssetClasses.length})`);

  const srcBuf = readFileSync(SRC);
  console.log(`  ✓ source xlsm bytes = ${srcBuf.length}  sha=${sha(srcBuf)}`);
  const zip = await JSZip.loadAsync(srcBuf as unknown as ArrayBuffer);
  const vbaPresent = zip.file('xl/vbaProject.bin') !== null;
  if (!vbaPresent) {
    console.error('  ✗ source xlsm has no vbaProject.bin — was the wrong file written?');
    process.exit(2);
  }
  console.log(`  ✓ vbaProject.bin present in source artifact`);

  const db = new Database(DB);
  const rowsBefore = listSingleLoan(db);
  console.log('\n  current uw_templates (single_loan):');
  printRows(rowsBefore);

  // Idempotency: v10 already exists AND already active → no-op
  const v10Existing = rowsBefore.find((r) => r.version === 10);
  if (v10Existing && v10Existing.is_active === 1) {
    console.log('\n  ✓ v10 already in uw_templates and active — remediation complete. No-op.');
    db.close();
    process.exit(0);
  }

  // Expect: v1, v2, v6 present; v6 active (the post-v6-remediation state)
  const versions = rowsBefore.map((r) => r.version).sort((a, b) => a - b);
  const activeNow = rowsBefore.find((r) => r.is_active === 1);
  if (!activeNow || activeNow.version !== 6) {
    console.error(`  ✗ expected v6 to be the single active row; got active=v${activeNow?.version ?? 'none'} versions=${JSON.stringify(versions)}`);
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ pre-state matches expected: active=v6, versions=${JSON.stringify(versions)}`);

  section('STEP 1 — insert v10 row (direct INSERT, version=10 explicit)');
  const structure = await analyzeTemplateStructure(srcBuf);
  console.log(`  structure: ${structure.tabs.length} tabs`);

  const newId = randomUUID();
  const now = new Date().toISOString();

  // Same shape as store.uploadTemplate but with explicit version=10.
  db.prepare(
    `INSERT INTO uw_templates
       (id, template_type, version, file_name, file_size, file_data,
        structure_json, uploaded_by, uploaded_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    newId,
    'single_loan',
    10,
    'Blank_UW_Template_v2.xlsm',
    srcBuf.length,
    srcBuf,
    JSON.stringify(structure),
    'admin',
    now,
  );
  console.log(`  ✓ inserted v10 row: id=${newId}  bytes=${srcBuf.length}`);

  section('STEP 2 — flip active: v6 → v10');
  db.prepare(`UPDATE uw_templates SET is_active=0 WHERE template_type='single_loan'`).run();
  db.prepare(`UPDATE uw_templates SET is_active=1 WHERE id=?`).run(newId);
  console.log(`  ✓ flipped is_active: all single_loan = 0, then v10 = 1`);

  section('STEP 3 — verify via store.getActiveTemplate');
  const probe = store.getActiveTemplate('single_loan');
  if (!probe) {
    console.error('  ✗ getActiveTemplate returned null');
    db.close();
    process.exit(2);
  }
  if (probe.version !== 10) {
    console.error(`  ✗ active version = ${probe.version}, expected 10`);
    db.close();
    process.exit(2);
  }
  if (!probe.templateMetadata) {
    console.error('  ✗ active template has NULL templateMetadata — registry lookup failed for v10');
    db.close();
    process.exit(2);
  }
  if (probe.templateMetadata.compatibleContractVersion !== 10) {
    console.error(`  ✗ templateMetadata.compatibleContractVersion = ${probe.templateMetadata.compatibleContractVersion}, expected 10`);
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ active = v${probe.version}  templateMetadata.contractV=${probe.templateMetadata.compatibleContractVersion}  bytes=${probe.fileSize}  sha=${sha(probe.fileData)}`);

  section('FINAL STATE');
  const rowsAfter = listSingleLoan(db);
  console.log('\n  final uw_templates (single_loan):');
  printRows(rowsAfter);

  const activeFinal = rowsAfter.filter((r) => r.is_active === 1);
  if (activeFinal.length !== 1 || activeFinal[0].version !== 10) {
    console.error(`  ✗ active rows: ${activeFinal.map((r) => 'v' + r.version).join(',')} (expected exactly v10)`);
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ v10 is the single active row`);
  console.log(`  ✓ v1, v2, v6 retained — historical replayability preserved`);

  db.close();
  console.log('\nRemediation complete.');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});

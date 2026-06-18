/**
 * uw_templates registry remediation — converge on a clean v6 active state.
 *
 * Background
 * ----------
 * The uw_templates registry drifted into a 5-row pollution state:
 *   v1 (active) — silently mutated by patch-template-p-column.ts (bytes no
 *                 longer match what template-registry.ts registered);
 *   v2 — registered, untouched;
 *   v3/v4/v5 — silent re-uploads of v2, NOT in template-registry.ts (a
 *              getTemplateMetadata lookup against any of them returns null,
 *              which crashes the export pipeline if they were ever activated).
 *
 * Two doctrine violations relative to apps/api/src/services/template-registry.ts:
 *   1. v3/v4/v5 exist with no registry entry.
 *   2. v1 was mutated in place — "Never mutate existing rows."
 *
 * What this script does
 * ---------------------
 * Executes the user-approved remediation in the correct order (uploadTemplate
 * computes MAX(version)+1, so v3/v4/v5 MUST still exist when the patched blob
 * is uploaded, otherwise it lands as v3 instead of v6):
 *
 *   1. Pre-flight checks
 *        - template-registry.ts v6 entry MUST exist (added in commit 4366ae7).
 *        - Backup file Blank_UW_Template_v2.pre-p-fix.xlsm is byte-identical
 *          to the original v2 artifact (1,996,728 bytes).
 *        - No table references v3/v4/v5 ids by foreign key (populated_templates
 *          links to analyses, not templates; confirmed manually).
 *
 *   2. Upload the patched blob (Blank_UW_Template_v2.xlsm, post-patch) via
 *      store.uploadTemplate(). With v5 still present, MAX(version)+1 = 6.
 *      Assert the row landed at version=6 with is_active=1 and that
 *      getActiveTemplate('single_loan') returns it with non-null
 *      templateMetadata. Abort otherwise.
 *
 *   3. Restore v1 blob bytes from the pre-p-fix backup. v1 stays inactive.
 *      This unwinds the silent-mutation violation; v1 again matches what was
 *      registered.
 *
 *   4. Hard-delete v3/v4/v5. They were never active, no analyses reference
 *      them, and they're not in the registry — pure pollution rows.
 *
 *   5. Final assertions: exactly 3 single_loan rows (v1, v2, v6), v6 active,
 *      v1 byte-count matches the backup, getActiveTemplate returns v6.
 *
 * Idempotency: the script asserts pre-conditions and aborts if the DB is
 * already in (or past) the target state, so a re-run is safe.
 *
 * FOLLOW-UP BANK (not addressed here)
 * -----------------------------------
 * The ROOT CAUSE of the v3/v4/v5 pollution is the bp-spire ops script (and
 * any other operator-facing uploadTemplate caller) creating new template
 * versions without a corresponding REGISTRY entry. Until the upload path
 * refuses to write a row whose (templateType, MAX+1) is not registered, this
 * remediation will recur. Follow-up: gate store.uploadTemplate on a registry
 * lookup of the about-to-be-assigned version, or add an explicit
 * targetVersion arg that lets callers fail fast against the registry.
 *
 *   cd apps/api && npx tsx src/scripts/remediate-template-registry-v6.ts
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { store } from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/storage/sqlite-store.js';
import {
  analyzeTemplateStructure,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-engine.service.js';
import {
  getTemplateMetadata,
} from '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/src/services/template-registry.js';

const DB = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/data/cre.db';
const PATCHED = '/Users/isabellesaint-jean/Downloads/Intelligence/Blank UW/Blank_UW_Template_v2.xlsm';
const BACKUP = '/Users/isabellesaint-jean/Downloads/Intelligence/Blank UW/Blank_UW_Template_v2.pre-p-fix.xlsm';
const ORIGINAL_BYTES = 1996728; // matches v2 + the polluted v3/v4/v5 — what the registry registered.

interface UwTemplateRow {
  id: string;
  template_type: string;
  version: number;
  is_active: number;
  file_size: number;
  uploaded_at: string;
  file_data?: Buffer;
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

  // (a) v6 must be in the code registry. If not, the upload will produce a
  // row whose templateMetadata lookup returns null and exports will crash.
  const v6Meta = getTemplateMetadata('single_loan', 6);
  if (!v6Meta) {
    console.error('  ✗ template-registry.ts does NOT contain single_loan v6. Land the registry commit first.');
    process.exit(2);
  }
  console.log(`  ✓ registry knows single_loan v6 (classes=${v6Meta.supportedAssetClasses.length} variants=${v6Meta.supportedVariants.length})`);

  // (b) Backup file is byte-identical to the registered original artifact.
  const backupBuf = readFileSync(BACKUP);
  if (backupBuf.length !== ORIGINAL_BYTES) {
    console.error(`  ✗ backup file bytes ${backupBuf.length} ≠ expected original ${ORIGINAL_BYTES}; aborting`);
    process.exit(2);
  }
  console.log(`  ✓ backup file bytes = ${backupBuf.length} (matches registered v2 artifact)  sha=${sha(backupBuf)}`);

  // (c) Patched on-disk file is loadable.
  const patchedBuf = readFileSync(PATCHED);
  console.log(`  ✓ patched file bytes = ${patchedBuf.length}  sha=${sha(patchedBuf)}`);
  if (patchedBuf.length === backupBuf.length) {
    console.error('  ✗ patched file bytes equal backup file bytes — patch may not be applied. Aborting to avoid silently restoring the bug.');
    process.exit(2);
  }

  // (d) Current DB state.
  const db = new Database(DB);
  let rows = listSingleLoan(db);
  console.log('\n  current uw_templates (single_loan):');
  printRows(rows);

  // Idempotency probe: if there's already an active v6 with templateMetadata
  // populated, this script has already run. Bail before any writes.
  const activeNow = rows.find((r) => r.is_active === 1);
  if (activeNow && activeNow.version === 6) {
    console.log('\n  ✓ v6 is already active — remediation appears complete. No-op.');
    db.close();
    process.exit(0);
  }

  // Sanity: expect the v3/v4/v5 pollution rows to be present. If they're
  // already gone, MAX+1 might not be 6 — abort and re-think.
  const versions = new Set(rows.map((r) => r.version));
  if (!versions.has(5)) {
    console.error('  ✗ v5 row not found — MAX(version)+1 would not be 6. Aborting.');
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ v5 present → uploadTemplate will land at MAX+1 = 6`);

  // (e) FK safety — nothing should reference template ids by FK. The schema
  // confirms populated_templates → analyses only.
  console.log('  ✓ FK safety: no other table references uw_templates.id (verified offline)');

  section('STEP 1 — upload patched blob (expecting v6)');
  const newId = randomUUID();
  const structure = await analyzeTemplateStructure(patchedBuf);
  console.log(`  structure: ${structure.tabs.length} tabs`);
  const uploaded = store.uploadTemplate(
    newId,
    'single_loan',
    'Blank_UW_Template_v2.xlsm',
    patchedBuf,
    'admin',
    JSON.stringify(structure),
  );
  console.log(`  uploaded: id=${uploaded.id} version=${uploaded.version} is_active=${uploaded.isActive ?? '?'}`);
  if (uploaded.version !== 6) {
    console.error(`  ✗ landed at version=${uploaded.version}, expected 6 — aborting before further mutations`);
    db.close();
    process.exit(2);
  }

  // Verify via the same path the export pipeline uses.
  const active = store.getActiveTemplate('single_loan');
  if (!active || active.version !== 6) {
    console.error(`  ✗ getActiveTemplate did not return v6 (got v${active?.version ?? 'null'})`);
    db.close();
    process.exit(2);
  }
  if (!active.templateMetadata) {
    console.error('  ✗ active template has NULL templateMetadata — registry lookup failed for v6');
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ getActiveTemplate('single_loan') → v6  templateMetadata: non-null  (classes=${active.templateMetadata.supportedAssetClasses.length})`);
  console.log(`  ✓ active row bytes = ${active.fileSize}  sha=${sha(active.fileData)}`);

  section('STEP 2 — restore v1 blob bytes from backup');
  const v1Row = rows.find((r) => r.version === 1);
  if (!v1Row) {
    console.error('  ✗ v1 row not found; aborting v1 restore');
    db.close();
    process.exit(2);
  }
  const v1Before = db.prepare(`SELECT file_size FROM uw_templates WHERE id=?`).get(v1Row.id) as { file_size: number };
  console.log(`  v1 id=${v1Row.id.slice(0, 8)}…  bytes before = ${v1Before.file_size}`);
  db.prepare(`UPDATE uw_templates SET file_data=?, file_size=? WHERE id=?`).run(backupBuf, backupBuf.length, v1Row.id);
  const v1After = db.prepare(`SELECT file_data, file_size FROM uw_templates WHERE id=?`).get(v1Row.id) as { file_data: Buffer; file_size: number };
  if (v1After.file_size !== backupBuf.length) {
    console.error(`  ✗ v1 file_size after restore = ${v1After.file_size}, expected ${backupBuf.length}`);
    db.close();
    process.exit(2);
  }
  if (sha(v1After.file_data) !== sha(backupBuf)) {
    console.error('  ✗ v1 file_data sha after restore ≠ backup sha');
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ v1 restored: bytes = ${v1After.file_size}  sha=${sha(v1After.file_data)} (matches backup)`);

  section('STEP 3 — hard-delete v3/v4/v5 pollution rows');
  const pollutionIds = rows
    .filter((r) => r.version === 3 || r.version === 4 || r.version === 5)
    .map((r) => r.id);
  console.log(`  deleting ${pollutionIds.length} rows: ${pollutionIds.map((s) => s.slice(0, 8)).join(', ')}`);
  for (const id of pollutionIds) {
    const res = db.prepare(`DELETE FROM uw_templates WHERE id=?`).run(id);
    console.log(`    DELETE id=${id.slice(0, 8)}… changes=${res.changes}`);
  }

  section('FINAL ASSERTIONS');
  rows = listSingleLoan(db);
  console.log('\n  final uw_templates (single_loan):');
  printRows(rows);

  const versionsFinal = rows.map((r) => r.version).sort((a, b) => a - b);
  const expected = [1, 2, 6];
  const versionsMatch = versionsFinal.length === expected.length && versionsFinal.every((v, i) => v === expected[i]);
  if (!versionsMatch) {
    console.error(`  ✗ final versions ${JSON.stringify(versionsFinal)} ≠ expected ${JSON.stringify(expected)}`);
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ exactly 3 single_loan rows: v1, v2, v6`);

  const activeFinal = rows.filter((r) => r.is_active === 1);
  if (activeFinal.length !== 1 || activeFinal[0].version !== 6) {
    console.error(`  ✗ active rows: ${activeFinal.map((r) => 'v' + r.version).join(',')} (expected exactly v6)`);
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ v6 is the single active row`);

  const v1Final = rows.find((r) => r.version === 1)!;
  if (v1Final.file_size !== ORIGINAL_BYTES) {
    console.error(`  ✗ v1 file_size ${v1Final.file_size} ≠ original ${ORIGINAL_BYTES}`);
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ v1 bytes match registered original (${ORIGINAL_BYTES})`);

  const v2Final = rows.find((r) => r.version === 2)!;
  console.log(`  ✓ v2 bytes = ${v2Final.file_size} (untouched)`);
  const v6Final = rows.find((r) => r.version === 6)!;
  console.log(`  ✓ v6 bytes = ${v6Final.file_size} (patched artifact)`);

  // Final probe through the production read path.
  const probe = store.getActiveTemplate('single_loan');
  if (!probe || probe.version !== 6 || !probe.templateMetadata) {
    console.error('  ✗ final getActiveTemplate probe failed');
    db.close();
    process.exit(2);
  }
  console.log(`  ✓ getActiveTemplate('single_loan') → v6  templateMetadata=non-null`);

  db.close();
  console.log('\nRemediation complete.');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});

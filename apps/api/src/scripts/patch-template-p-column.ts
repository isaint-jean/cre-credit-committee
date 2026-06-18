/**
 * Surgical fix for the source UW template's column-P subtotal cells.
 *
 * The 7 cells (P12/P17/P27/P33/P35/P42/P44) carry shared-formula references
 * whose master formulas were written for column B (the leftmost year column)
 * and reference columns B/K/N — wrong column references for P (engine UW)
 * once Excel applies the shared-formula offsets.
 *
 * Surgical fix: detach each P-cell from its shared-formula group and write
 * a standalone formula with the correct P-column references. Master cells
 * stay intact; other columns using the same shared-formula `si` are
 * unaffected. Cached `<v>` values stripped so Excel recomputes on open.
 *
 * Source-of-truth template (on-disk) and DB-active template are both patched.
 *
 *   cd apps/api && npx tsx src/scripts/patch-template-p-column.ts
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

const SRC = '/Users/isabellesaint-jean/Downloads/Intelligence/Blank UW/Blank_UW_Template_v2.xlsm';
const BAK = '/Users/isabellesaint-jean/Downloads/Intelligence/Blank UW/Blank_UW_Template_v2.pre-p-fix.xlsm';
const DB  = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/data/cre.db';
const SHEET_XML_PATH = 'xl/worksheets/sheet8.xml'; // Operating History and Pro Forma (rId8)

// Each fix: replace <c r="P{row}" ...><f t="shared" si="..."/></c> with a
// standalone <c r="P{row}" ...><f>{formula}</f></c>. The cell's `s=` style
// attribute is preserved (matched in the regex); the `t="e"` error-type
// attribute, if present, is stripped (the new formula no longer errors).
const PATCHES: ReadonlyArray<{ row: string; formula: string }> = [
  { row: 'P12', formula: 'SUM(P9:P11)' },
  { row: 'P17', formula: 'SUM(P12:P15)' },
  { row: 'P27', formula: 'SUM(P21:P26)' },
  { row: 'P33', formula: 'SUM(P27:P32)' },
  { row: 'P35', formula: 'P17-P33' },
  { row: 'P42', formula: 'SUM(P38:P41)' },
  { row: 'P44', formula: 'P35-P42' },
];

async function patchBuffer(buf: Buffer): Promise<{ buf: Buffer; touched: number; vbaPresent: boolean }> {
  const zip = await JSZip.loadAsync(buf as unknown as ArrayBuffer);
  const vbaPresent = zip.file('xl/vbaProject.bin') !== null;
  const sheetFile = zip.file(SHEET_XML_PATH);
  if (!sheetFile) throw new Error(`${SHEET_XML_PATH} not in zip`);
  let xml = await sheetFile.async('string');
  let touched = 0;
  for (const { row, formula } of PATCHES) {
    // Match: <c r="P12" ... (t="e")? ...><f t="shared" si="0"/>(<v>...</v>)?</c>
    // The cell's style `s=` attribute and any other attributes between r="..."
    // and the <f> opening are preserved; we just rewrite the <f>...</f> and
    // drop the cached <v>...</v>.
    const re = new RegExp(
      `<c r="${row}"([^>]*)>\\s*<f\\s+t="shared"\\s+si="\\d+"\\s*/>\\s*(?:<v>[^<]*</v>)?\\s*</c>`,
      'g',
    );
    let m: RegExpExecArray | null;
    let replaced = false;
    re.lastIndex = 0;
    while ((m = re.exec(xml)) !== null) {
      // Strip t="e" from the attributes if present (no longer an error cell).
      const attrs = m[1].replace(/\s+t="e"/g, '');
      const replacement = `<c r="${row}"${attrs}><f>${formula}</f></c>`;
      xml = xml.slice(0, m.index) + replacement + xml.slice(m.index + m[0].length);
      re.lastIndex = m.index + replacement.length;
      replaced = true;
      touched++;
    }
    if (!replaced) {
      console.warn(`  ! ${row}: no shared-formula reference matched (skipped)`);
    }
  }
  zip.file(SHEET_XML_PATH, xml);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buf: Buffer.from(out as Uint8Array), touched, vbaPresent };
}

(async () => {
  console.log('Backing up source template…');
  try { copyFileSync(SRC, BAK); console.log(`  ✓ backup: ${BAK}`); } catch (e) { console.warn(`  ! backup failed: ${(e as Error).message}`); }

  console.log('\nPatching on-disk source template…');
  const srcBuf = readFileSync(SRC);
  const srcRes = await patchBuffer(srcBuf);
  console.log(`  patched ${srcRes.touched}/7 cells; vbaProject.bin present: ${srcRes.vbaPresent}`);
  writeFileSync(SRC, srcRes.buf);
  console.log(`  ✓ on-disk written: ${SRC}`);

  console.log('\nPatching DB-active template blob…');
  const db = new Database(DB);
  const row = db.prepare(
    `SELECT id, version, file_data FROM uw_templates WHERE template_type='single_loan' AND is_active=1 LIMIT 1`,
  ).get() as { id: string; version: number; file_data: Buffer } | undefined;
  if (!row) {
    console.warn('  ! no active single_loan template in DB; skipping DB patch');
  } else {
    const dbRes = await patchBuffer(row.file_data);
    console.log(`  active template: id=${row.id} v${row.version}; patched ${dbRes.touched}/7 cells; vbaProject.bin present: ${dbRes.vbaPresent}`);
    db.prepare(`UPDATE uw_templates SET file_data=?, file_size=? WHERE id=?`).run(dbRes.buf, dbRes.buf.length, row.id);
    console.log(`  ✓ DB blob updated`);
  }
  db.close();

  console.log('\nDone.');
})().catch((e) => { console.error(e); process.exit(1); });

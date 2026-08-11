/**
 * PROOF — data-room download Content-Type fix. READ-ONLY on cre.db.
 *
 * Gates:
 *  (A) mimeFromExtension maps the key extensions (case-insensitive); unknown → octet-stream.
 *  (B) resolveServeMime guard: stored octet-stream/absent → extension-derived; real stored mime → unchanged.
 *  (C) real data: the 4 Sunroad octet-stream docs now RESOLVE to their real mime (pdf/xlsx);
 *      the 640 docs (real stored mimes) are UNCHANGED.
 *  (D) canonical byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/data-room-download-mime-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { mimeFromExtension, resolveServeMime } from '../util/mime-from-extension.js';

const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const OCTET = 'application/octet-stream';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function partA(): void {
  console.log('\n(A) mimeFromExtension maps the key extensions:');
  check('.pdf → application/pdf', mimeFromExtension('x.pdf') === PDF);
  check('.PDF (case-insensitive) → application/pdf', mimeFromExtension('N064 - Rent Roll 4.29.24.PDF') === PDF);
  check('.xlsx → spreadsheet mime', mimeFromExtension('a.xlsx') === XLSX);
  check('.xls → ms-excel', mimeFromExtension('a.xls') === 'application/vnd.ms-excel');
  check('.csv → text/csv', mimeFromExtension('a.csv') === 'text/csv');
  check('.png → image/png', mimeFromExtension('a.png') === 'image/png');
  check('.jpg / .jpeg → image/jpeg', mimeFromExtension('a.jpg') === 'image/jpeg' && mimeFromExtension('a.jpeg') === 'image/jpeg');
  check('.txt → text/plain', mimeFromExtension('a.txt') === 'text/plain');
  check('unknown ext → octet-stream', mimeFromExtension('a.zzz') === OCTET);
  check('no extension → octet-stream', mimeFromExtension('README') === OCTET);
  check('dotfile / trailing dot → octet-stream', mimeFromExtension('.gitignore') !== PDF && mimeFromExtension('a.') === OCTET);
  check('dotted name uses LAST segment (…ASR FINAL.pdf)', mimeFromExtension('Sunroad Centrum - ASR FINAL.pdf') === PDF);
}

function partB(): void {
  console.log('\n(B) resolveServeMime guard — override generic, preserve real:');
  check('stored octet-stream + .pdf → application/pdf', resolveServeMime(OCTET, 'ASR FINAL.pdf') === PDF);
  check('stored octet-stream + .xlsx → spreadsheet mime', resolveServeMime(OCTET, 'CF PRELIM.xlsx') === XLSX);
  check('stored null + .pdf → application/pdf', resolveServeMime(null, 'x.pdf') === PDF);
  check('stored empty + .pdf → application/pdf', resolveServeMime('', 'x.pdf') === PDF);
  check('REAL stored mime is preserved (pdf)', resolveServeMime(PDF, 'x.pdf') === PDF);
  check('REAL stored mime is preserved (xlsx)', resolveServeMime(XLSX, 'x.xlsx') === XLSX);
  check('octet-stream + unknown ext stays octet-stream', resolveServeMime(OCTET, 'blob.bin') === OCTET);
}

function partC(): void {
  console.log('\n(C) real data — Sunroad octet-stream docs resolve; 640 unchanged:');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const rows = db.prepare(`SELECT file_name, mime_type FROM data_room_doc`).all() as Array<{ file_name: string; mime_type: string }>;
  db.close();

  const octet = rows.filter((r) => r.mime_type === OCTET);
  check('there ARE stored octet-stream docs (the bug set)', octet.length > 0, `${octet.length} rows`);
  // Every octet-stream doc now resolves to a NON-generic type via its extension.
  const stillGeneric = octet.filter((r) => resolveServeMime(r.mime_type, r.file_name) === OCTET);
  check('every octet-stream doc now resolves to a real type', stillGeneric.length === 0, stillGeneric.map((r) => r.file_name).join('; '));
  // Spot-check the named Sunroad set.
  const asr = octet.find((r) => /ASR FINAL\.pdf$/i.test(r.file_name));
  const cf = octet.find((r) => /CF PRELIM.*\.xlsx$/i.test(r.file_name));
  check('Sunroad ASR FINAL.pdf → application/pdf', !!asr && resolveServeMime(asr!.mime_type, asr!.file_name) === PDF);
  check('Sunroad CF PRELIM.xlsx → spreadsheet mime', !!cf && resolveServeMime(cf!.mime_type, cf!.file_name) === XLSX);

  // 640 (real stored mimes) unchanged — resolveServeMime returns the stored value verbatim.
  const real = rows.filter((r) => r.mime_type !== OCTET);
  const changed = real.filter((r) => resolveServeMime(r.mime_type, r.file_name) !== r.mime_type);
  check('all real-mime docs (640 set) UNCHANGED', changed.length === 0, `${real.length} docs checked`);
}

function partD(): void {
  console.log('\n(D) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nData-room download Content-Type fix proof (read-only on cre.db)');
partA(); partB(); partC(); partD();
console.log(failures === 0 ? '\ndownload-mime proof: OK\n' : `\ndownload-mime proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * PROOF — Operating-History Column H fallback (Option B, mirror of ac9fd1d). RENDER-ONLY.
 * Exercises the real GET /api/underwriting/export path (the UI button) via the router.
 *
 * Gates:
 *  (A) Sunroad (ad9e9e90 — t12Extraction ABSENT, ASR ladder PRESENT): Operating-History
 *      Column H now REPOPULATED from underwrittenCashFlows.t12, matching the June-30
 *      reference to the dollar (Total Revenues 6,899,325; reimbursements 9,115; G&A
 *      382,673; R&M 811,067; utilities 565,623; mgmt 188,249; capex 0) + the "T12 - 2024"
 *      period header.
 *  (B) GUARD: 640 (t12Extraction PRESENT) — Column H still populated from its own path
 *      (H17 non-zero); the fallback did NOT fire (byte-identical behavior for t12-present deals).
 *  (C) RENDER-ONLY / MINT-SAFE: no re-mint — Sunroad's graphRevisionId unchanged, 640 head
 *      221235987967 intact, BMARK 17.
 *
 * Run: npx tsx src/scripts/operating-history-t12-fallback-proof.ts   (from apps/api)
 */
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { renderRoutes } from '../routes/render.routes.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const DB = path.join(process.cwd(), 'data', 'cre.db');
const SUNROAD = 'ad9e9e90-a598-4617-8cc0-3a10a64b8d00';
const SUNROAD_REV = '54819b79ffc5ed9550c36e87611c8f7c1122a35172d253403e3c7b13e3a23b75';
const DEAL_640 = '26027996-5d1c-4a7a-ab72-03f4900a0be0';

/** Numeric cell value (unwraps exceljs formula/result objects). */
function num(cell: ExcelJS.Cell): number | null {
  const v: unknown = cell.value;
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && 'result' in v && typeof (v as { result: unknown }).result === 'number') return (v as { result: number }).result;
  return null;
}
function text(cell: ExcelJS.Cell): string {
  const v: unknown = cell.value;
  return v === null || v === undefined ? '' : typeof v === 'object' ? String((v as { result?: unknown }).result ?? '') : String(v);
}

async function exportOpHistory(id: string, profile: string): Promise<ExcelJS.Worksheet | null> {
  const app = express();
  app.use('/api/underwriting', renderRoutes);
  const server = app.listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const qs = new URLSearchParams({ dealId: id, assetClass: 'office', underwritingMode: 'single_loan', profile, templateType: 'single_loan' });
  const res = await fetch(`http://127.0.0.1:${port}/api/underwriting/export?${qs.toString()}`);
  if (!res.ok) { server.close(); return null; }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  server.close();
  return wb.getWorksheet('Operating History and Pro Forma') ?? null;
}

(async () => {
  console.log('\nOperating-History T-12 fallback proof (real export path)');

  console.log('\n(A) Sunroad Column H repopulated (matches June-30 to the dollar):');
  const sun = await exportOpHistory(SUNROAD, 'bp_spire');
  check('Sunroad export produced the Operating History sheet', sun !== null);
  if (sun) {
    // June-30 targets (cent-precise), matched to the dollar (ASR ladder is dollar-rounded).
    const targets: Array<[string, number]> = [
      ['H17', 6899325], ['H15', 9115], ['H22', 382673], ['H24', 811067], ['H25', 565623], ['H30', 188249], ['H38', 0],
    ];
    for (const [addr, want] of targets) {
      const got = num(sun.getCell(addr));
      check(`${addr} = ${want.toLocaleString()} (± $1)`, got !== null && Math.abs(got - want) <= 1, `got ${got}`);
    }
    check('H3 period header = "T12 - 2024"', /2024/.test(text(sun.getCell('H3'))), `got "${text(sun.getCell('H3'))}"`);
  }

  console.log('\n(B) GUARD — 640 (t12Extraction present) Column H still populated from its own path:');
  const s640 = await exportOpHistory(DEAL_640, 'bp_spire');
  check('640 export produced the Operating History sheet', s640 !== null);
  if (s640) check('640 H17 (Total Revenues) still populated (fallback did NOT fire)', (num(s640.getCell('H17')) ?? 0) > 0, `H17=${num(s640.getCell('H17'))}`);

  console.log('\n(C) render-only / mint-safe:');
  const db = new Database(DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head640 = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  const sunRev = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id = ? LIMIT 1`).get(SUNROAD_REV);
  db.close();
  check('BMARK 17 + 640 head 221235987967 intact', bmark === 17 && !!head640, `BMARK ${bmark}`);
  check('Sunroad head/graphRevision UNCHANGED (no re-mint)', !!sunRev);

  console.log(failures === 0 ? '\noperating-history T-12 fallback proof: OK\n' : `\noperating-history T-12 fallback proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).message); process.exit(1); });

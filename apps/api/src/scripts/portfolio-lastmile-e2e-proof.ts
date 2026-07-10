/**
 * PORTFOLIO LAST-MILE — END-TO-END PROOF (temp cre.db copy)
 *
 * Proves the two additive steps end-to-end, ON A TEMP COPY of cre.db — the real
 * apps/api/data/cre.db is NEVER opened for writing here:
 *
 *   STEP A — ingestPortfolioFromEx102() turns Prime Storage-Blue's EX-102 blob
 *            into a PERSISTED portfolio Analysis (graph root + registry +
 *            bridged legacy row), reachable by its graph id.
 *
 *   STEP B — the ADDITIVE /export dispatch: GET /api/underwriting/export with the
 *            portfolio's graph id + underwritingMode=roll_up returns the proven
 *            38-sheet portfolio workbook (5 leaf tabs + 4 roll-up tabs), through
 *            the REAL route handler (a live Express router). Sunroad still exports
 *            its normal single-loan workbook via the SAME route (the else branch).
 *
 * MECHANISM: copies apps/api/data/cre.db → a temp dir, chdir()s there BEFORE
 * importing the route module, so the store + recordGraphStore singletons (which
 * resolve process.cwd()/data/cre.db) bind to the COPY. The comp corpus + the
 * portfolio template resolve __dirname-relative to the real repo (read-only).
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/portfolio-lastmile-e2e-proof.ts
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import type ExcelJSNS from 'exceljs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, '../..');            // apps/api
const REAL_DB = join(API_DIR, 'data', 'cre.db');
const REAL_DB_EXPECTED_SHA1 = '142ee8ee20b629ee31a078dbff947be2f8d9b915';

// A persisted LibrarySnapshot id in the real db (the Sunroad-final ingest used it).
const LIBRARY_SNAPSHOT_ID = 'c9fac1d1f98c1917d23a24ea4376b95b932dc3d4e689e193cf1798bf50c09f4f';
// A single-property Sunroad deal (legacy uuid, office, single_loan) for the
// unchanged else-branch proof.
const SUNROAD_ID = '71edb76c-eb1b-4b3d-8669-bffa7b3b9737';

const out: string[] = [];
const log = (s = '') => out.push(s);
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) pass++; else fail++;
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function sha1(p: string): string {
  return execSync(`shasum "${p}"`).toString().trim().split(/\s+/)[0];
}

async function main(): Promise<void> {
  log('PORTFOLIO LAST-MILE — END-TO-END PROOF (temp cre.db copy)');
  log(`Run: ${new Date().toISOString()}`);
  log('');

  // ── Guard: real db present + its pre-run hash ──
  if (!existsSync(REAL_DB)) throw new Error(`real cre.db not found: ${REAL_DB}`);
  const realHashBefore = sha1(REAL_DB);
  log(`Real cre.db SHA-1 (before): ${realHashBefore}`);
  check('real cre.db is the expected baseline 142ee8ee (before)',
    realHashBefore === REAL_DB_EXPECTED_SHA1, realHashBefore);

  // ── Copy → temp dir, chdir BEFORE importing the store singletons ──
  const tmp = mkdtempSync(join(tmpdir(), 'portfolio-lastmile-'));
  mkdirSync(join(tmp, 'data'), { recursive: true });
  const tmpDb = join(tmp, 'data', 'cre.db');
  copyFileSync(REAL_DB, tmpDb);
  // WAL sidecars, if any, so the copy is a coherent snapshot.
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(REAL_DB + ext)) copyFileSync(REAL_DB + ext, tmpDb + ext);
  }
  process.chdir(tmp);
  log(`Temp db: ${tmpDb} (cwd=${process.cwd()})`);
  log('');

  // Dynamic imports AFTER chdir so the singletons open the COPY.
  const { store } = await import('../storage/sqlite-store.js');
  const { recordGraphStore } = await import('../storage/record-graph-store.js');
  const { ingestPortfolioFromEx102 } = await import('../services/ingest-portfolio-ex102.service.js');
  const { renderRoutes } = await import('../routes/render.routes.js');
  const ExcelJS = (await import('exceljs')).default;
  const express = (await import('express')).default;

  /* ══════════════════════ STEP A — portfolio ingest ══════════════════════ */
  log('STEP A — ingest Prime Storage-Blue as a persisted portfolio Analysis:');
  const ingest = await ingestPortfolioFromEx102({
    recordGraphStore,
    store,
    librarySnapshotId: LIBRARY_SNAPSHOT_ID as never,
  });
  const portfolioId = ingest.rootId;
  log(`  rootId (graph AnalysisId): ${portfolioId}`);
  log(`  extractionResultId: ${ingest.extractionResultId.slice(0, 16)}…`);
  log(`  propertyCount: ${ingest.propertyCount}`);
  check('ingest produced 5 PropertyComponents', ingest.propertyCount === 5, `${ingest.propertyCount}`);

  // Registry persisted (no orphan) — the durable persist-on-ingest fix.
  const mb = recordGraphStore.getMarketBenchmarks(ingest.marketBenchmarksId as never);
  const cm = recordGraphStore.getCreditManifesto(ingest.creditManifestoId as never);
  const ctx = recordGraphStore.getRevisionEvaluationContext(portfolioId as never);
  check('market_benchmarks row persisted', mb !== null, ingest.marketBenchmarksId.slice(0, 8));
  check('credit_manifesto row persisted', cm !== null, ingest.creditManifestoId.slice(0, 8));
  check('eval-context row exists for the portfolio root', ctx !== null, '');
  check('eval-context benchmark id RESOLVES (no orphan)',
    ctx !== null && recordGraphStore.getMarketBenchmarks(ctx.marketBenchmarksId as never) !== null, '');
  check('eval-context manifesto id RESOLVES (no orphan)',
    ctx !== null && recordGraphStore.getCreditManifesto(ctx.creditManifestoId as never) !== null, '');
  // The extraction round-trips its `properties`.
  const erBack = recordGraphStore.getExtractionResult(ingest.extractionResultId as never);
  check('ExtractionResult.properties round-trips from the graph (5)',
    (erBack?.properties?.length ?? 0) === 5, `${erBack?.properties?.length ?? 0}`);
  log('');

  /* ══════════════════════ live router ══════════════════════ */
  const app = express();
  app.use('/api/underwriting', renderRoutes);
  const server = app.listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  const port = addr.port;
  const base = `http://127.0.0.1:${port}/api/underwriting/export`;

  /* ══════════════════ STEP B — /export dispatch (portfolio) ══════════════════ */
  log('STEP B — GET /export for the portfolio (roll_up) via its graph id:');
  const pQs = new URLSearchParams({
    dealId: portfolioId,
    assetClass: 'self_storage',
    underwritingMode: 'roll_up',
    profile: 'bp_spire',
    templateType: 'roll_up',
  });
  const pRes = await fetch(`${base}?${pQs}`);
  log(`  HTTP ${pRes.status} ${pRes.statusText}`);
  log(`  X-Underwriting-Mode: ${pRes.headers.get('x-underwriting-mode')}`);
  log(`  X-Portfolio-Property-Count: ${pRes.headers.get('x-portfolio-property-count')}`);
  log(`  X-Portfolio-Sheets: ${pRes.headers.get('x-portfolio-sheets')}`);
  check('portfolio /export returns 200', pRes.status === 200, `${pRes.status}`);
  check('portfolio /export tagged X-Underwriting-Mode=roll_up',
    pRes.headers.get('x-underwriting-mode') === 'roll_up', '');

  const pBuf = Buffer.from(await pRes.arrayBuffer());
  const pOut = '/tmp/portfolio-lastmile-export.xlsx';
  writeFileSync(pOut, pBuf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(pOut);
  const sheets: string[] = [];
  wb.eachSheet((ws) => sheets.push(ws.name));
  const leafTabs = sheets.filter((n) => /^P\d+ /.test(n));
  const rollUpTabs = ['Portfolio Summary', 'Concentration', 'Allocation & Release', 'Blended Pro-Forma']
    .filter((n) => sheets.includes(n));
  log(`  workbook sheets: ${sheets.length}`);
  log(`  leaf tabs (P#): ${leafTabs.length} → ${leafTabs.join(', ')}`);
  log(`  roll-up tabs: ${rollUpTabs.join(', ')}`);
  check('re-read from disk: 5 per-property leaf tabs', leafTabs.length === 5, `${leafTabs.length}`);
  check('re-read from disk: 4 roll-up tabs', rollUpTabs.length === 4, `${rollUpTabs.length}`);
  check('total sheet count is the 38-sheet portfolio workbook', sheets.length === 38, `${sheets.length}`);

  // Numbers matching the P4 render.
  const findRow = (ws: ExcelJSNS.Worksheet, label: string): number | null => {
    for (let r = 1; r <= ws.rowCount; r++)
      if (String(ws.getCell(`A${r}`).value ?? '').trim() === label) return r;
    return null;
  };
  const summary = wb.getWorksheet('Portfolio Summary')!;
  const conc = wb.getWorksheet('Concentration')!;
  const alloc = wb.getWorksheet('Allocation & Release')!;
  const blendedVal = summary.getCell(`B${findRow(summary, 'Blended value (Σ value)')!}`).value;
  const capCell = summary.getCell(`B${findRow(summary, 'Blended cap rate (ΣNOI ÷ Σvalue)')!}`).value;
  const dscrRow = findRow(summary, 'Aggregate DSCR')!;
  const dscrVal = summary.getCell(`B${dscrRow}`).value;
  const dscrLabel = summary.getCell(`C${dscrRow}`).value;
  const levelCell = conc.getCell(`B${findRow(conc, 'Concentration level')!}`).value;
  const xcCell = alloc.getCell(`B${findRow(alloc, 'Cross-collateralized')!}`).value;
  const relCell = alloc.getCell(`B${findRow(alloc, 'Release provisions')!}`).value;
  log(`  blended value = $${Number(blendedVal).toLocaleString()}`);
  log(`  blended cap = ${(Number(capCell) * 100).toFixed(3)}%`);
  log(`  concentration level = ${String(levelCell)}`);
  log(`  aggregate DSCR = ${dscrVal === null ? '(blank)' : String(dscrVal)}; label = "${String(dscrLabel)}"`);
  check('blended value = $91.2M', blendedVal === 91_200_000, `$${Number(blendedVal).toLocaleString()}`);
  check('blended cap = 5.80% (±1bp)', Math.abs(Number(capCell) - 0.05799) < 0.0001, `${(Number(capCell) * 100).toFixed(3)}%`);
  check('concentration level = "elevated"', levelCell === 'elevated', String(levelCell));

  // Union City leaf $29M / $1.80M NOI; Garfield $7.7M / $390K NOI (P4 spot-checks).
  const union = wb.getWorksheet(leafTabs[0]);
  const garfield = wb.getWorksheet(leafTabs[4]);
  const unionVal = union?.getCell('B8').value;
  const unionNoi = union?.getCell('B9').value;
  const garVal = garfield?.getCell('B8').value;
  const garNoi = garfield?.getCell('B9').value;
  log(`  ${leafTabs[0]}: value=$${Number(unionVal).toLocaleString()} NOI=$${Number(unionNoi).toLocaleString()}`);
  log(`  ${leafTabs[4]}: value=$${Number(garVal).toLocaleString()} NOI=$${Number(garNoi).toLocaleString()}`);
  check('Union City leaf = $29,000,000 / NOI $1,799,399.41',
    unionVal === 29_000_000 && Math.abs(Number(unionNoi) - 1_799_399.41) < 0.01, '');
  check('Garfield leaf = $7,700,000 / NOI $390,013.43',
    garVal === 7_700_000 && Math.abs(Number(garNoi) - 390_013.43) < 0.01, '');

  // Honest blanks.
  check('pari-passu DSCR cell BLANK (labeled n/a)',
    dscrVal === null && /n\/a — whole-loan debt service not provided/.test(String(dscrLabel)), '');
  check('cross-collateral = DATA_NOT_PROVIDED', xcCell === 'DATA_NOT_PROVIDED', String(xcCell));
  check('release provisions = DATA_NOT_PROVIDED', relCell === 'DATA_NOT_PROVIDED', String(relCell));
  log('');

  /* ══════════ STEP B (else) — Sunroad single-property UNCHANGED ══════════ */
  log('STEP B (else) — Sunroad single-property /export via the SAME route:');
  const sQs = new URLSearchParams({
    dealId: SUNROAD_ID,
    assetClass: 'office',
    underwritingMode: 'single_loan',
    profile: 'bp_spire',
    templateType: 'single_loan',
  });
  const sRes = await fetch(`${base}?${sQs}`);
  log(`  HTTP ${sRes.status} ${sRes.statusText}`);
  log(`  X-Underwriting-Mode: ${sRes.headers.get('x-underwriting-mode')}`);
  log(`  X-Template-Type: ${sRes.headers.get('x-template-type')}`);
  log(`  X-Portfolio-Property-Count (must be absent): ${sRes.headers.get('x-portfolio-property-count')}`);
  check('Sunroad /export returns 200 (else branch, single_loan)', sRes.status === 200, `${sRes.status}`);
  check('Sunroad export is NOT portfolio-tagged (no X-Portfolio-Property-Count)',
    sRes.headers.get('x-portfolio-property-count') === null, '');
  check('Sunroad export mode is single_loan (unchanged else path)',
    sRes.headers.get('x-underwriting-mode') === 'single_loan', '');
  const sBuf = Buffer.from(await sRes.arrayBuffer());
  const sWb = new ExcelJS.Workbook();
  await sWb.xlsx.readFile((writeFileSync('/tmp/portfolio-lastmile-sunroad.xlsx', sBuf), '/tmp/portfolio-lastmile-sunroad.xlsx'));
  const sSheets: string[] = [];
  sWb.eachSheet((ws) => sSheets.push(ws.name));
  const sLeafTabs = sSheets.filter((n) => /^P\d+ /.test(n));
  check('Sunroad workbook has NO portfolio leaf/roll-up tabs (single-property shape)',
    sLeafTabs.length === 0 && !sSheets.includes('Portfolio Summary'), `${sSheets.length} sheets`);
  log(`  Sunroad workbook sheets: ${sSheets.length} (portfolio tabs: ${sLeafTabs.length})`);
  log('');

  server.close();

  /* ══════════════════ real cre.db byte-unchanged ══════════════════ */
  const realHashAfter = sha1(REAL_DB);
  log('REAL cre.db byte-unchanged:');
  log(`  SHA-1 (after): ${realHashAfter}`);
  check('real cre.db SHA-1 unchanged (142ee8ee), never written',
    realHashAfter === realHashBefore && realHashAfter === REAL_DB_EXPECTED_SHA1, realHashAfter);
  log('');

  log('='.repeat(72));
  log(`E2E PROOF: ${fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`}  (pass=${pass} fail=${fail})`);
  log(`  portfolio graph id: ${portfolioId}`);
  log('='.repeat(72));
  console.log(out.join('\n'));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(out.join('\n'));
  console.log('FATAL:', (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});

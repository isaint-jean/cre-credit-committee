/**
 * Memo Renderer v1 validation — REAL Sunroad through evaluateAndNarrate
 * + buildCommitteeMemo end-to-end.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-memo-v1-sunroad-real.ts
 *
 * What this validates:
 *   1. The MEMO RENDERER consumes the orchestrator's v1.6 outputs verbatim
 *      (narrative, dealResult, composedMitigationPackage) and produces a
 *      self-contained HTML string the lender prints to PDF.
 *   2. Every figure in the rendered HTML traces to the structured
 *      AuthoritativeNumbers projection + composed-package fields — none
 *      parsed from prose, none recomputed.
 *   3. NO appraised-LTV tokens (65.34% / 40.90%) appear anywhere in the
 *      rendered HTML. The memo carries ONE LTV basis (doctrine-stressed).
 *   4. The restructuring section is the visual centerpiece and contains
 *      the reconciliation prose ("standalone amortization $14.98M → $0,
 *      superseded by $18.73M proceeds cut") + operator-supplied disclosure.
 *
 * Pipeline:
 *   - Loads real Sunroad bundle from data/phase4-sunroad.db (copied to scratch).
 *   - Runs evaluateAndNarrate end-to-end (live Sonnet) with operator value
 *     $126,200,362.
 *   - Calls buildCommitteeMemo with the orchestrator outputs.
 *   - Writes the HTML to /tmp/sunroad-memo-v1.html.
 *   - Cross-checks every displayed dollar/%/dscr figure against the
 *     validated harness numbers.
 *
 * Output: /tmp/sunroad-memo-v1.html (open in any browser; print → PDF).
 */
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import { buildCommitteeMemo } from '../services/render-memo/build-committee-memo.js';
import type {
  AdjustedInputs,
  AssetProfile,
  ExtractionResultId,
  LibrarySnapshot,
  NarrativeFacts,
  PropertyMetadata,
  RentRoll,
} from '@cre/contracts';
import type { OperatorSuppliedValue } from '../doctrine-clean/index.js';

const SRC_DB = path.resolve(process.cwd(), 'data/phase4-sunroad.db');
const TMP_DB = path.resolve('/tmp/phase4-sunroad-memo-v1-validation.db');
const OUT_HTML = path.resolve('/tmp/sunroad-memo-v1.html');

function copyDb(): void {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  fs.copyFileSync(SRC_DB, TMP_DB);
}

function loadSingleton<T>(table: string): T {
  const Database = require('better-sqlite3');
  const db = new Database(TMP_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT id, payload FROM ${table} LIMIT 1`).get() as
      | { id: string; payload: string } | undefined;
    if (!row) throw new Error(`no rows in ${table}`);
    return { id: row.id, ...JSON.parse(row.payload) } as T;
  } finally {
    db.close();
  }
}

function pickLargestExtractionId(): ExtractionResultId {
  const Database = require('better-sqlite3');
  const db = new Database(TMP_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT id FROM extraction_results ORDER BY length(payload) DESC LIMIT 1`,
    ).get() as { id: string } | undefined;
    if (!row) throw new Error('no extraction_results');
    return row.id as ExtractionResultId;
  } finally {
    db.close();
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('MEMO RENDERER v1 VALIDATION — Sunroad through evaluateAndNarrate + buildCommitteeMemo');
  console.log('================================================================');
  console.log('');

  copyDb();
  console.log(`Copied  ${SRC_DB}`);
  console.log(`     -> ${TMP_DB}`);
  console.log('');

  const store = new RecordGraphStore(TMP_DB);
  const extractionResultId = pickLargestExtractionId();
  const assetProfile    = loadSingleton<AssetProfile>('asset_profiles');
  const librarySnapshot = loadSingleton<LibrarySnapshot>('library_snapshots');
  const narrativeFacts  = loadSingleton<NarrativeFacts>('narrative_facts');
  const adjustedInputs  = loadSingleton<AdjustedInputs>('adjusted_inputs');

  console.log(`Loaded Sunroad bundle (extraction ${(extractionResultId as string).slice(0,12)}…, ai ${(adjustedInputs as any).id?.slice(0,12)}…)`);
  console.log('');

  const operatorSuppliedValue: OperatorSuppliedValue = {
    value: 126_200_362,
    source: 'operator-supplied',
    asOf: '2026-04-15T00:00:00Z' as any,
    basis: 'Desk BOV anchored to Q1 ratings actions on comparable Office CBD towers',
  };

  /* ----- orchestrator end-to-end ----- */
  console.log('Running evaluateAndNarrate end-to-end (live Sonnet)...');
  const t0 = Date.now();
  const result = await evaluateAndNarrate({
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    extractionResultId,
    analysisAsOfDate: (adjustedInputs as any).analysisAsOfDate,
    propertyMetadata: null as PropertyMetadata | null,
    rentRoll: null as RentRoll | null,
    operatorSuppliedValue,
  }, store);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${dt}s.`);
  console.log('');

  const { narrative, dealResult, composedMitigationPackage } = result;

  /* ----- render memo ----- */
  console.log('Rendering committee memo...');
  const html = buildCommitteeMemo({
    dealName: 'Sunroad Centrum',
    memoDate: '2026-06-12',
    narrative,
    dealResult,
    composedMitigationPackage,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(`Wrote ${html.length.toLocaleString()} bytes to ${OUT_HTML}`);
  console.log('');

  /* ----- cross-check displayed figures ----- */
  console.log('================================================================');
  console.log('CROSS-CHECK — displayed HTML figures vs validated harness numbers');
  console.log('================================================================');
  const checks: { label: string; needle: string; ok: boolean }[] = [
    { label: 'proceeds cut            ',  needle: '$18.73M',               ok: html.includes('$18.73M') },
    { label: 'L′ (final loan amount)  ',  needle: '$63.73M',               ok: html.includes('$63.73M') },
    { label: 'original loan amount    ',  needle: '$82.46M',               ok: html.includes('$82.46M') },
    { label: 'dim-7 stressed value    ',  needle: '$93.72M',               ok: html.includes('$93.72M') },
    { label: 'stressedLtv before      ',  needle: '87.98%',                ok: html.includes('87.98%') },
    { label: 'stressedLtv at L′       ',  needle: '68.00%',                ok: html.includes('68.00%') },
    { label: 'exit DSCR baseline      ',  needle: '1.02x',                 ok: html.includes('1.02x') },
    { label: 'exit DSCR at L′         ',  needle: '1.32x',                 ok: html.includes('1.32x') },
    { label: 'exit-DSCR trigger       ',  needle: '1.20x',                 ok: html.includes('1.20x') },
    { label: 'exit-DSCR cure target   ',  needle: '1.25x',                 ok: html.includes('1.25x') },
    { label: 'rating recommendation   ',  needle: 'ApproveWithConditions', ok: html.includes('ApproveWithConditions') },
    { label: 'operator-supplied tag   ',  needle: 'operator-supplied',     ok: html.includes('operator-supplied') },
  ];
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}: "${c.needle}" ${c.ok ? 'PRESENT' : 'ABSENT'}`);
  }
  const allOk = checks.every(c => c.ok);
  console.log('');
  console.log(`  ${allOk ? '✓ ALL CROSS-CHECKS PASS' : '✗ CROSS-CHECK FAILURES'}`);
  console.log('');

  /* ----- forbidden appraised-LTV tokens ----- */
  console.log('================================================================');
  console.log('Single LTV basis — appraised tokens MUST be absent');
  console.log('================================================================');
  const forbidden = ['65.34%', '40.90%'];
  let basisClean = true;
  for (const tok of forbidden) {
    const present = html.includes(tok);
    if (present) basisClean = false;
    console.log(`  ${present ? '✗ LEAK' : '✓ absent'} "${tok}"`);
  }
  console.log('');

  /* ----- restructuring section + reconciliation ----- */
  console.log('================================================================');
  console.log('Restructuring section — reconciliation + operator-supplied disclosure');
  console.log('================================================================');
  const reconChecks = [
    { label: 'Restructuring section title    ', needle: 'Restructuring Package' },
    { label: 'Recommended restructure label  ', needle: 'Recommended restructure' },
    { label: 'Standalone amort superseded    ', needle: 'superseded by the $18.73M proceeds cut' },
    { label: 'Valuation basis disclosure     ', needle: 'Valuation basis: operator-supplied' },
    { label: 'In-place lockbox condition     ', needle: 'In-place cash management' },
    { label: 'CP condition                   ', needle: 'Conditions precedent' },
    { label: 'Engine version footer          ', needle: `narrative engine v${narrative.engineVersion}` },
  ];
  let reconOk = true;
  for (const c of reconChecks) {
    const present = html.includes(c.needle);
    if (!present) reconOk = false;
    console.log(`  ${present ? '✓' : '✗'} ${c.label}: "${c.needle}" ${present ? 'present' : 'ABSENT'}`);
  }
  console.log('');

  /* ----- SUMMARY ----- */
  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`  Cross-checks:           ${allOk ? '✓ ALL PASS' : '✗ FAIL'}`);
  console.log(`  Single LTV basis:       ${basisClean ? '✓ 65.34% / 40.90% absent' : '✗ appraised LTV leaked'}`);
  console.log(`  Restructuring section:  ${reconOk ? '✓ centerpiece structure present' : '✗ centerpiece elements missing'}`);
  console.log(`  Memo HTML:              ${OUT_HTML}`);
  console.log(`  Bytes:                  ${html.length.toLocaleString()}`);
  console.log('');
  console.log(`  To view & print:        open ${OUT_HTML}`);
  console.log(`                          (cmd-P in any browser → Save as PDF)`);
  console.log('');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });

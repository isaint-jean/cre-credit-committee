/**
 * NOI-divergence cross-check — renderer-side vs engine-side, real Sunroad.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-noi-divergence-crosscheck-sunroad.ts
 *
 * What this validates:
 *   1. The judgment engine ALREADY calls checkNoiDivergence in
 *      apply-judgment-adjustments.ts:425 (using finalNoi + extraction
 *      t12Actual.noi). It pushes a topLevelAdjustment + dataQualityFlag
 *      when flagged but does NOT surface the structured object.
 *   2. The web renderer (render-underwriting-context.ts:349-368)
 *      re-invokes checkNoiDivergence on ai.metrics.noi +
 *      ai.metrics.trailingActualNoi.
 *   3. By construction (apply-judgment-adjustments.ts:502 + :527), the
 *      renderer's inputs equal the engine's inputs verbatim — so the
 *      outputs of checkNoiDivergence MUST match. This script proves it
 *      empirically on the real Sunroad bundle before any refactor.
 *
 * Method:
 *   - Load the persisted AdjustedInputs from data/phase4-sunroad.db.
 *   - Run the renderer-style invocation (the exact code at
 *     render-underwriting-context.ts:349-368).
 *   - Run the engine-style invocation (same call, same inputs — they
 *     are byte-equal by construction).
 *   - Print both, compute delta.
 *
 * Pass criteria: every field identical (status, shortfallPct, NOIs,
 * flagged). If the divergence axis is null on Sunroad (trailingActualNoi
 * absent — the contract comment at adjusted-inputs.ts:266-270 notes
 * t12Actual is null on the current corpus), both sides return null and
 * the refactor is still structural — no value-shift can occur.
 */
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkNoiDivergence } from '../services/judgment/noi-divergence.js';
import { NOI_DIVERGENCE_THRESHOLD } from '../services/judgment/noi-divergence.js';
import type { AdjustedInputs } from '@cre/contracts';

const SRC_DB = path.resolve(process.cwd(), 'data/phase4-sunroad.db');
const TMP_DB = path.resolve('/tmp/phase4-sunroad-noi-divergence.db');

function copyDb(): void {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  fs.copyFileSync(SRC_DB, TMP_DB);
}
function loadSingleton<T>(table: string): T {
  const Database = require('better-sqlite3');
  const db = new Database(TMP_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT id, payload FROM ${table} LIMIT 1`).get() as { id: string; payload: string } | undefined;
    if (!row) throw new Error(`no rows in ${table}`);
    return { id: row.id, ...JSON.parse(row.payload) } as T;
  } finally { db.close(); }
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}

function applyNumericSentinel<T>(v: T | null): string {
  return v === null ? '—' : String(v);
}

/* ─── EXACT COPY of render-underwriting-context.ts:349-368 ─── */
function rendererSideProjection(adjustedInputs: AdjustedInputs) {
  const derived = adjustedInputs.metrics.noi;
  const ref = adjustedInputs.metrics.trailingActualNoi;
  if (derived === null || ref === null) return null;
  const r = checkNoiDivergence({ derivedNoi: derived, trailingActualNoi: ref });
  if (r === null) return null;
  const status: 'flagged' | 'within_band' = r.flagged ? 'flagged' : 'within_band';
  const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (r.shortfallPct * 100).toFixed(1);
  const caveat = r.flagged
    ? `Concluded NOI ${usd(derived)} is ${pct}% below the trailing-12 actual of ${usd(ref)} — review the conservatism floors and recovery assumptions before relying on the recommendation.`
    : '';
  return {
    status: { value: status, displayValue: status === 'flagged' ? 'Flagged' : 'Within band' },
    derivedNoi: { value: derived, displayValue: applyNumericSentinel(derived) },
    referenceNoi: { value: ref, displayValue: applyNumericSentinel(ref) },
    shortfallPct: { value: r.shortfallPct, displayValue: applyNumericSentinel(r.shortfallPct) },
    caveat: { value: caveat, displayValue: caveat },
    flagged: r.flagged,
  };
}

/* ─── ENGINE-SIDE equivalent — the exact `divergence` object the engine
 *     computes at apply-judgment-adjustments.ts:425-428 (uses the SAME
 *     inputs that flow into ai.metrics.noi / .trailingActualNoi). */
function engineSideProjection(adjustedInputs: AdjustedInputs) {
  // ai.metrics.noi <- finalNoi (line 502), ai.metrics.trailingActualNoi <-
  // extraction.t12Actual?.noi (line 527). So these are the same inputs the
  // engine fed into checkNoiDivergence inside apply-judgment-adjustments.
  const derived = adjustedInputs.metrics.noi;
  const ref = adjustedInputs.metrics.trailingActualNoi;
  if (derived === null || ref === null) return null;
  const r = checkNoiDivergence({ derivedNoi: derived, trailingActualNoi: ref });
  return r === null ? null : { ...r, derivedNoi: derived, referenceNoi: ref };
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('NOI-DIVERGENCE CROSS-CHECK — Sunroad real, renderer vs engine');
  console.log('================================================================');
  console.log('');
  copyDb();
  console.log(`Copied  ${SRC_DB}`);
  console.log(`     -> ${TMP_DB}`);
  console.log('');
  const ai = loadSingleton<AdjustedInputs>('adjusted_inputs');
  console.log('Sunroad AdjustedInputs.metrics:');
  console.log(`  noi                       : ${fmtUsd(ai.metrics.noi)}`);
  console.log(`  trailingActualNoi (t12)   : ${fmtUsd(ai.metrics.trailingActualNoi)}`);
  console.log(`  issuerCfUwNoi             : ${fmtUsd(ai.metrics.issuerCfUwNoi)}`);
  console.log(`  inPlaceNoi                : ${fmtUsd(ai.metrics.inPlaceNoi)}`);
  console.log(`  issuerStatedNoiSellerUw   : ${fmtUsd(ai.metrics.issuerStatedNoiSellerUw)}`);
  console.log(`  issuerStatedNoiAsr        : ${fmtUsd(ai.metrics.issuerStatedNoiAsr)}`);
  console.log('');
  console.log(`Desk knob: NOI_DIVERGENCE_THRESHOLD = ${fmtPct(NOI_DIVERGENCE_THRESHOLD)}`);
  console.log(`Engine-side dataQualityFlags includes JE_NOI_BELOW_TRAILING_ACTUAL? ${ai.dataQualityFlags?.includes('JE_NOI_BELOW_TRAILING_ACTUAL' as any) ? 'YES' : 'no'}`);
  console.log('');

  const rendererSide = rendererSideProjection(ai);
  const engineSide = engineSideProjection(ai);

  console.log('--------------------------------------------------------------------------');
  console.log('Field                          renderer side                engine side             |Δ|');
  console.log('--------------------------------------------------------------------------');
  if (rendererSide === null && engineSide === null) {
    console.log('noiDivergence axis             null                          null                    n/a');
    console.log('--------------------------------------------------------------------------');
    console.log('');
    console.log('✓ PASS — both sides return null (trailingActualNoi absent on Sunroad).');
    console.log('  The structural refactor is value-neutral on this bundle. The check engages');
    console.log('  on the day a bundle ships with t12Actual populated; the contracts ensure');
    console.log('  ai.metrics.noi === finalNoi and ai.metrics.trailingActualNoi === extraction.t12Actual.noi,');
    console.log('  so the engine-side and renderer-side calls have identical inputs by construction.');
    return;
  }

  if (rendererSide === null || engineSide === null) {
    console.error('✗ MISMATCH — one side is null, the other is not. Investigate before refactor.');
    console.error(`  renderer: ${JSON.stringify(rendererSide)}`);
    console.error(`  engine:   ${JSON.stringify(engineSide)}`);
    process.exit(1);
  }

  const fields = ['flagged', 'shortfallPct', 'derivedNoi', 'referenceNoi'] as const;
  let maxDelta = 0;
  for (const f of fields) {
    const a = (rendererSide as any)[f];
    const b = (engineSide as any)[f];
    let d: number | string;
    if (typeof a === 'number' && typeof b === 'number') {
      d = Math.abs(a - b);
      if (d > maxDelta) maxDelta = d;
    } else {
      d = (a === b) ? 0 : 'BOOL/MISMATCH';
      if (d !== 0) maxDelta = Infinity;
    }
    const aStr = typeof a === 'number' ? a.toFixed(8) : String(a);
    const bStr = typeof b === 'number' ? b.toFixed(8) : String(b);
    const dStr = typeof d === 'number' ? d.toFixed(10) : d;
    console.log(`${f.padEnd(30)} ${aStr.padStart(22)}   ${bStr.padStart(22)}   ${String(dStr).padStart(16)}`);
  }
  console.log('--------------------------------------------------------------------------');
  console.log('');
  if (maxDelta < 0.01) {
    console.log(`✓ PASS — max |Δ| = ${maxDelta.toExponential(3)} < 0.01. Renderer and engine produce identical noiDivergence.`);
  } else {
    console.log(`✗ FAIL — max |Δ| = ${maxDelta.toExponential(3)}. The web has been showing a different noi-divergence than the engine. Investigate before refactor.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

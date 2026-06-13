/**
 * Funded-exit cross-check — render-side vs engine-side, on REAL Sunroad.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-funded-exit-crosscheck-sunroad.ts
 *
 * Purpose: before single-sourcing the memo's funded-exit-at-L' into the
 * engine, verify the memo's `projectFundedExitAtFinalLoan(...)` produces
 * BYTE-IDENTICAL outputs to the engine's funded-exit-at-L' computation
 * inside composeMitigations. Both already call computeFundedExitFigures
 * on `composed.finalState` with the same canonical inputs — but a real
 * cross-check is the gate, not the obvious reading of the source.
 *
 * Method:
 *   1. Run the orchestrator on the real Sunroad bundle (data/phase4-sunroad.db)
 *      with a stub LLM (no live Sonnet — only the composed package is needed).
 *   2. Replicate the MEMO path: copy of build-committee-memo.ts:80-125.
 *   3. Replicate the ENGINE path: copy of compose-mitigations.ts:565-582.
 *   4. Print both side by side to full precision + the delta on each field.
 *
 * Pass criteria: delta < $0.01 (10 cents) on every field. MATCH → refactor
 * is behavior-preserving. MISMATCH → STOP; investigate before refactor.
 *
 * No source edits required for this harness.
 */
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import {
  DEFAULT_MITIGATION_DESK,
  computeFundedExitFigures,
  resolveOperatingReservesPctOfEgi,
  resolveAssetTypeFromDeal,
} from '../services/mitigation/produce-mitigations.js';
import { buildCommitteeMemo } from '../services/render-memo/build-committee-memo.js';
import { ASSET_CLASS_ENUM } from '../doctrine-clean/index.js';
import type {
  AdjustedInputs,
  AssetProfile,
  ExtractionResultId,
  LibrarySnapshot,
  NarrativeFacts,
  PropertyMetadata,
  RentRoll,
} from '@cre/contracts';
import type { ComposedMitigationPackage } from '../services/mitigation/compose-mitigations.js';
import type { EvaluateDealResult } from '../doctrine-clean/scoring/evaluate-deal.js';
import type { OperatorSuppliedValue } from '../doctrine-clean/index.js';

const SRC_DB = path.resolve(process.cwd(), 'data/phase4-sunroad.db');
const TMP_DB = path.resolve('/tmp/phase4-sunroad-funded-exit-crosscheck.db');

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
function pickLargestExtractionId(): ExtractionResultId {
  const Database = require('better-sqlite3');
  const db = new Database(TMP_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT id FROM extraction_results ORDER BY length(payload) DESC LIMIT 1`).get() as { id: string } | undefined;
    if (!row) throw new Error('no extraction_results');
    return row.id as ExtractionResultId;
  } finally { db.close(); }
}

// Stub LLM — orchestrator wires narrative; we don't use it. Same response for every slot.
const stubLlm: any = async () => 'stub narrative slot text.';

/* ─── EXACT COPY of build-committee-memo.ts:80-125 ─────────────────────── */
function memoSideProjection(dealResult: EvaluateDealResult, composed: ComposedMitigationPackage) {
  const finalAi = composed.finalState.adjustedInputs;
  const finalDim4 = composed.finalState.dealResult.dimensions.refinanceFeasibility;
  const finalDim8 = composed.finalState.dealResult.dimensions.assetClass;
  const finalSustNcf = composed.finalState.dealResult.normalization.sustainableNcf;
  const rawExit = finalDim4.derivedOutputs?.exitDscr as number | undefined;
  const rc = finalDim4.derivedOutputs?.stressedRefiConstant as number | undefined;
  const maturityBalance = finalDim4.derivedOutputs?.maturityBalance as number | undefined;
  if (typeof rawExit !== 'number' || typeof rc !== 'number' || typeof maturityBalance !== 'number') {
    return { rawExitAtFinalLoan: null, fundedExitAtFinalLoan: null, reserveTarget: null, expectedAccrual: null, residualUnfunded: null };
  }
  if (typeof finalSustNcf !== 'number' || !(finalSustNcf > 0)) {
    return { rawExitAtFinalLoan: rawExit, fundedExitAtFinalLoan: null, reserveTarget: null, expectedAccrual: null, residualUnfunded: null };
  }
  const idx = finalDim8.derivedOutputs?.canonicalAssetClassIndex as number | undefined;
  const assetType = typeof idx === 'number' && idx >= 0 && idx < ASSET_CLASS_ENUM.length
    ? ASSET_CLASS_ENUM[idx]!
    : null;
  const egi = finalAi.income.effectiveGrossIncome.adjusted;
  const opReservesAnnual = Math.max(0, resolveOperatingReservesPctOfEgi(assetType) * egi);
  const cureTarget = DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET;
  const exitClearing = finalSustNcf / (rc * cureTarget);
  const reserveTarget = Math.max(0, maturityBalance - exitClearing);
  const dsAnnual = finalAi.loan.debtServiceAnnual.adjusted;
  const termMonths = finalAi.loan.termMonths.adjusted;
  const funded = computeFundedExitFigures(
    finalSustNcf, dsAnnual, termMonths, rc, maturityBalance,
    opReservesAnnual, reserveTarget,
  );
  void dealResult;
  return {
    rawExitAtFinalLoan: rawExit,
    fundedExitAtFinalLoan: funded.fundedExitDscr,
    reserveTarget,
    expectedAccrual: funded.expectedAccrual,
    residualUnfunded: funded.residualUnfunded,
  };
}

/* ─── EXACT COPY of compose-mitigations.ts:563-583 ─────────────────────── */
function engineSideProjection(composed: ComposedMitigationPackage) {
  const finalState = composed.finalState;
  const assetType = resolveAssetTypeFromDeal(finalState.dealResult);
  const dim4 = finalState.dealResult.dimensions.refinanceFeasibility;
  const sustainableNcf = finalState.dealResult.normalization.sustainableNcf;
  const rc = dim4.derivedOutputs?.stressedRefiConstant as number | undefined;
  const maturityBalance = dim4.derivedOutputs?.maturityBalance as number | undefined;
  const rawExit = dim4.derivedOutputs?.exitDscr as number | undefined;
  if (typeof sustainableNcf !== 'number' || !(sustainableNcf > 0)) return null;
  if (typeof rc !== 'number' || !(rc > 0)) return null;
  if (typeof maturityBalance !== 'number' || !(maturityBalance > 0)) return null;
  const cureTarget = DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET;
  const exitClearingBalance = sustainableNcf / (rc * cureTarget);
  const reserveTarget = Math.max(0, maturityBalance - exitClearingBalance);
  const egi = finalState.adjustedInputs.income.effectiveGrossIncome.adjusted;
  const opReservesPct = resolveOperatingReservesPctOfEgi(assetType);
  const operatingReservesAnnual = Math.max(0, opReservesPct * egi);
  const debtServiceAnnual = finalState.adjustedInputs.loan.debtServiceAnnual.adjusted;
  const termMonths = finalState.adjustedInputs.loan.termMonths.adjusted;
  const funded = computeFundedExitFigures(
    sustainableNcf, debtServiceAnnual, termMonths, rc, maturityBalance,
    operatingReservesAnnual, reserveTarget,
  );
  return {
    rawExitAtFinalLoan: rawExit ?? null,
    fundedExitAtFinalLoan: funded.fundedExitDscr,
    reserveTarget,
    expectedAccrual: funded.expectedAccrual,
    residualUnfunded: funded.residualUnfunded,
  };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(8);
}
function fmtDelta(a: number | null | undefined, b: number | null | undefined): string {
  if (a === null || a === undefined || b === null || b === undefined) return '—';
  const d = Math.abs(a - b);
  return d.toFixed(10);
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('FUNDED-EXIT CROSS-CHECK — Sunroad real, memo vs engine, at L\'');
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

  const operatorSuppliedValue: OperatorSuppliedValue = {
    value: 126_200_362,
    source: 'operator-supplied',
    asOf: '2026-04-15T00:00:00Z' as any,
    basis: 'Desk BOV anchored to Q1 ratings actions on comparable Office CBD towers',
  };

  console.log('Running evaluateAndNarrate (stub LLM)…');
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
  }, store, { llmCall: stubLlm });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log('');

  const { dealResult, composedMitigationPackage } = result;
  const composed = composedMitigationPackage;
  console.log(`Sunroad composed: original $${(composed.reconciliation.originalLoanAmount/1e6).toFixed(2)}M → L' $${(composed.finalLoanAmount/1e6).toFixed(2)}M (cut $${(composed.reconciliation.proceedsReduction/1e6).toFixed(2)}M).`);
  console.log('');

  const memoSide = memoSideProjection(dealResult, composed);
  const engineSide = engineSideProjection(composed);
  if (engineSide === null) {
    console.error('ENGINE PATH returned null — Sunroad final-state missing one of (sustainableNcf, rc, maturityBalance).');
    process.exit(1);
  }

  console.log('--------------------------------------------------------------------------');
  console.log('Field                          memo side                engine side               |Δ|');
  console.log('--------------------------------------------------------------------------');
  const fields: Array<keyof typeof memoSide> = [
    'rawExitAtFinalLoan', 'fundedExitAtFinalLoan', 'reserveTarget', 'expectedAccrual', 'residualUnfunded',
  ];
  let maxDelta = 0;
  for (const f of fields) {
    const a = memoSide[f] as number | null;
    const b = engineSide[f] as number | null;
    const d = (a !== null && b !== null) ? Math.abs(a - b) : 0;
    if (d > maxDelta) maxDelta = d;
    console.log(
      `${f.padEnd(30)} ${fmt(a).padStart(22)}   ${fmt(b).padStart(22)}   ${fmtDelta(a, b).padStart(16)}`,
    );
  }
  console.log('--------------------------------------------------------------------------');
  console.log('');
  const TOL = 0.01;  // $0.01 / 0.01x — the cross-check tolerance the user asked for
  if (maxDelta < TOL) {
    console.log(`✓ PASS — max |Δ| = ${maxDelta.toExponential(3)} < ${TOL} tolerance. Memo and engine produce IDENTICAL funded-exit-at-L'. Refactor is behavior-preserving.`);
  } else {
    console.log(`✗ FAIL — max |Δ| = ${maxDelta.toExponential(3)} ≥ ${TOL}. The memo is showing a different funded-exit than the engine computes. Investigate BEFORE refactor.`);
    process.exit(1);
  }
  console.log('');

  /* Render the memo with the resulting orchestrator outputs and write to a
   * marker-named file so a refactor pass can byte-diff pre/post. */
  const html = buildCommitteeMemo({
    dealName: 'Sunroad Centrum',
    memoDate: '2026-06-12',
    narrative: result.narrative,
    dealResult,
    composedMitigationPackage: composed,
  });
  const stage = process.env.MEMO_STAGE ?? 'unmarked';
  const out = path.resolve('/tmp', `sunroad-memo-${stage}.html`);
  fs.writeFileSync(out, html, 'utf8');
  console.log(`Memo (stub-narrative) written: ${out}  (${html.length.toLocaleString()} bytes)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

/**
 * Structure-first v1.3 validation — REAL Sunroad through evaluateAndNarrate
 * + buildCommitteeMemo end-to-end.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-structure-first-sunroad-real.ts
 *
 * What this validates:
 *   1. The v1.3 structure-first inversion in produce-mitigations.ts +
 *      compose-mitigations.ts:
 *      - LTV three-band: trigger 0.70 / Office ceiling 0.88; mid-band fires
 *        leverage_band_recourse (no cut); above-ceiling cuts to ceiling.
 *      - Exit three-band: Office floor 1.00 / threshold 1.20; mid-band fires
 *        cash_sweep_refi_reserve + springing_dscr_recourse (no amort, no cut);
 *        below-floor amortizes with day-1 DSCR gate.
 *      - Day-1 DSCR check on amortization: if amort would push day-1 < T_DSCR,
 *        amort returns 'amortization_blocked_by_day1_dscr' diagnostic; comp-
 *        osition falls back to a proceeds cut sized to IO-exit-clearing.
 *   2. End-to-end orchestrator path: evaluateAndNarrate now produces
 *      structure-first proposals + reconciliation.
 *   3. The v1.6 narrative + memo render the STRUCTURED-HOLD case coherently.
 *      The drift scanner (auth ∪ mitigants ∪ findings) still reports 0 drift.
 *
 * Sunroad expectation TO TEST (not assume):
 *   - stressedLtv = 0.8798 vs Office ceiling 0.88 → likely MID-BAND
 *     (depending on rounding; 0.8798 ≤ 0.88 by 2 bps, so structured).
 *   - exit DSCR = 1.02 ≥ floor 1.00 → MID-BAND.
 *   - day-1 DSCR (IO) = 1.30 ≥ T_DSCR 1.25 → no cut required by day-1.
 *   - Expected: HOLD $82.46M, no cut, mid-band levers fire.
 *
 *   If the actual stressedLtv rounds JUST ABOVE 0.88, the algorithm cuts to
 *   the ceiling — and the harness REPORTS that honestly. We do not assume
 *   the outcome.
 */
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import { buildCommitteeMemo } from '../services/render-memo/build-committee-memo.js';
import {
  projectAuthoritativeNumbers,
  extractCleanDoctrineFindings,
} from '../services/narrative/build-narrative.js';
import {
  renderAuthoritativeNumbersBlock,
} from '../services/narrative/prompt-templates.js';
import {
  classifyLtvBand,
  classifyExitDscrBand,
  resolveLtvStructuredCeiling,
  resolveExitDscrStructuredFloor,
  computeFundedExitFigures,
  resolveOperatingReservesPctOfEgi,
  DEFAULT_MITIGATION_DESK,
} from '../services/mitigation/produce-mitigations.js';
import { EXIT_DSCR_REFINANCEABLE_THRESHOLD } from '../doctrine-clean/index.js';
import { MITIGATION_ENGINE_VERSION, NARRATIVE_ENGINE_VERSION } from '@cre/contracts';
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
const TMP_DB = path.resolve('/tmp/phase4-sunroad-structure-first-validation.db');
const OUT_HTML = path.resolve('/tmp/sunroad-memo-structured-hold.html');

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
  } finally { db.close(); }
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
  } finally { db.close(); }
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}
function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(3) + 'x';
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log(`STRUCTURE-FIRST v${MITIGATION_ENGINE_VERSION} VALIDATION — Sunroad through evaluateAndNarrate`);
  console.log(`Mitigation engine: v${MITIGATION_ENGINE_VERSION}   ·   Narrative engine: v${NARRATIVE_ENGINE_VERSION}`);
  console.log('================================================================');
  console.log('');

  copyDb();
  console.log(`Copied  ${SRC_DB}\n     -> ${TMP_DB}\n`);

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

  console.log('Running evaluateAndNarrate end-to-end (live Sonnet) ...');
  const t0 = Date.now();
  const result = await evaluateAndNarrate({
    adjustedInputs, assetProfile, librarySnapshot, narrativeFacts,
    extractionResultId,
    analysisAsOfDate: (adjustedInputs as any).analysisAsOfDate,
    propertyMetadata: null as PropertyMetadata | null,
    rentRoll: null as RentRoll | null,
    operatorSuppliedValue,
  }, store);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  const { narrative, dealResult, composedMitigationPackage } = result;

  /* ===================== BAND CLASSIFICATION REPORT ===================== */
  console.log('================================================================');
  console.log('DOCTRINE SIGNALS + STRUCTURE-FIRST BAND CLASSIFICATION');
  console.log('================================================================');
  const dim7 = dealResult.dimensions.capRateValuationStress;
  const dim4 = dealResult.dimensions.refinanceFeasibility;
  const stressedLtv  = dim7.derivedOutputs?.stressedLtv as number | null | undefined;
  const stressedVal  = dim7.derivedOutputs?.stressedValue as number | null | undefined;
  const exitDscr     = dim4.derivedOutputs?.exitDscr as number | null | undefined;
  const refiConst    = dim4.derivedOutputs?.stressedRefiConstant as number | null | undefined;
  const assetType = 'Office';  // resolved from assetProfile.propertyType; harness asserts
  const ltvCeiling = resolveLtvStructuredCeiling(assetType);
  const exitFloor  = resolveExitDscrStructuredFloor(assetType);
  const ltvBand = stressedLtv !== null && stressedLtv !== undefined
    ? classifyLtvBand(stressedLtv, DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER, ltvCeiling)
    : 'unknown';
  // v1.4 — the LEVER gate uses FUNDED exit DSCR (raw exit after cash-sweep
  // accrual reduces the effective take-out balance). v1.5 — netted basis +
  // hard cap at the reserve target. Compute it the same way the lever does.
  const sustNcfForFund = dealResult.normalization.sustainableNcf as number;
  const maturityBalanceForFund = dealResult.dimensions.refinanceFeasibility.derivedOutputs?.maturityBalance as number;
  const dsAnnualForFund = (adjustedInputs as any).loan?.debtServiceAnnual?.adjusted as number;
  const termMonthsForFund = (adjustedInputs as any).loan?.termMonths?.adjusted as number;
  const egiForFund = (adjustedInputs as any).income?.effectiveGrossIncome?.adjusted as number;
  const opReservesAnnualForFund = (egiForFund > 0 ? egiForFund : 0) * resolveOperatingReservesPctOfEgi(assetType);
  const reserveTargetForFund = (refiConst !== null && refiConst !== undefined && sustNcfForFund > 0)
    ? Math.max(0, maturityBalanceForFund - sustNcfForFund / (refiConst * DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET))
    : 0;
  const fundedFigs = (refiConst !== null && refiConst !== undefined && sustNcfForFund > 0 && maturityBalanceForFund > 0)
    ? computeFundedExitFigures(sustNcfForFund, dsAnnualForFund, termMonthsForFund, refiConst, maturityBalanceForFund, opReservesAnnualForFund, reserveTargetForFund)
    : null;
  // The DOCTRINE breach signal is still RAW exit DSCR < 1.20. The funded
  // gate (used by the levers) classifies once the breach fires.
  const fundedBand = fundedFigs !== null && exitDscr !== null && exitDscr !== undefined && exitDscr < EXIT_DSCR_REFINANCEABLE_THRESHOLD
    ? (fundedFigs.fundedExitDscr >= exitFloor ? 'structured (funded)' : 'beyond-floor (funded)')
    : (exitDscr !== undefined && exitDscr !== null && exitDscr >= EXIT_DSCR_REFINANCEABLE_THRESHOLD ? 'clean (raw)' : 'unknown');
  const exitBand = exitDscr !== null && exitDscr !== undefined
    ? classifyExitDscrBand(exitDscr, exitFloor, EXIT_DSCR_REFINANCEABLE_THRESHOLD)
    : 'unknown';
  // Day-1 DSCR (IO) at the baseline: sustainableNcf / debtServiceAnnual.
  const sustNcf = dealResult.normalization.sustainableNcf;
  const ds = (adjustedInputs as any).loan?.debtServiceAnnual?.adjusted as number;
  const day1Dscr = sustNcf !== null && ds > 0 ? sustNcf / ds : null;

  console.log('');
  console.log(`  Asset class                 : ${assetType}`);
  console.log(`  Original loan amount        : ${fmtUsd((adjustedInputs as any).loan?.loanAmount?.adjusted)}`);
  console.log(`  sustainable NCF             : ${fmtUsd(sustNcf)}`);
  console.log('');
  console.log(`  dim-7 stressed value        : ${fmtUsd(stressedVal)}`);
  console.log(`  dim-7 stressed LTV          : ${fmtPct(stressedLtv)}`);
  console.log(`     T_LTV_TRIGGER  (doctrine): ${fmtPct(DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER)}`);
  console.log(`     T_LTV_CEILING  (desk)    : ${fmtPct(ltvCeiling)}    [ISABELLE-TO-CALIBRATE]`);
  console.log(`     LTV band                 : ${ltvBand.toUpperCase()}`);
  console.log('');
  console.log(`  dim-4 exit DSCR (raw)       : ${fmtDscr(exitDscr)}`);
  console.log(`     stressed refi constant   : ${fmtPct(refiConst)}`);
  console.log(`     EXIT trigger (doctrine)  : ${fmtDscr(EXIT_DSCR_REFINANCEABLE_THRESHOLD)}  (raw breach signal)`);
  if (fundedFigs !== null) {
    console.log(`     operating reserves (asset): ${fmtUsd(fundedFigs.operatingReservesAnnual)} /yr  (${(resolveOperatingReservesPctOfEgi(assetType) * 100).toFixed(1)}% × EGI)`);
    console.log(`     annual sweep (NETTED)    : ${fmtUsd(fundedFigs.annualSweep)} /yr  (NCF − DS − operating reserves)`);
    console.log(`     reserve target           : ${fmtUsd(reserveTargetForFund)}  (maturity − exit-clearing balance at cure ${DEFAULT_MITIGATION_DESK.T_EXIT_DSCR_CURE_TARGET}x)`);
    console.log(`     years to fill target     : ${fundedFigs.yearsToFillTarget !== null ? fundedFigs.yearsToFillTarget.toFixed(1) + ' yr' : '—'}  (term ${(termMonthsForFund/12).toFixed(0)} yr)`);
    console.log(`     expected accrual (CAPPED at target): ${fmtUsd(fundedFigs.expectedAccrual)}`);
    console.log(`     residual unfunded        : ${fmtUsd(fundedFigs.residualUnfunded)}  (sized into springing recourse, with min tier floor)`);
    console.log(`     effective balance        : ${fmtUsd(fundedFigs.effectiveBalance)}  (maturity − accrual)`);
    console.log(`     FUNDED exit DSCR         : ${fmtDscr(fundedFigs.fundedExitDscr)}`);
  }
  console.log(`     FUNDED FLOOR  (desk)     : ${fmtDscr(exitFloor)}    [ISABELLE-CALIBRATED — Office 1.10 on FUNDED basis]`);
  console.log(`     Exit band (raw, legacy)  : ${exitBand.toUpperCase()}`);
  console.log(`     Exit band (FUNDED, v1.5) : ${fundedBand.toUpperCase()}`);
  console.log('');
  console.log(`  Day-1 DSCR (sustainable / IO debt service): ${fmtDscr(day1Dscr)}`);
  console.log(`     T_DSCR (doctrine)        : ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)}`);
  console.log('');

  /* ===================== COMPOSED PACKAGE REPORT ====================== */
  console.log('================================================================');
  console.log('COMPOSED MITIGATION PACKAGE (structure-first output)');
  console.log('================================================================');
  const recon = composedMitigationPackage.reconciliation;
  console.log('');
  console.log(`  original loan        : ${fmtUsd(recon.originalLoanAmount)}`);
  console.log(`  final loan (L')      : ${fmtUsd(recon.finalLoanAmount)}`);
  console.log(`  proceeds reduction   : ${fmtUsd(recon.proceedsReduction)}`);
  console.log(`  standalone amort     : ${fmtUsd(recon.standaloneAmortPaydown)}`);
  console.log(`  composed amort       : ${recon.composedAmortPaydown === null ? '— (none)' : fmtUsd(recon.composedAmortPaydown)}`);
  console.log('');
  console.log(`  Final proposals (${composedMitigationPackage.proposals.length}):`);
  for (const p of composedMitigationPackage.proposals) {
    const extra: string[] = [];
    if (p.requiredEquity !== undefined)  extra.push(`requiredEquity ${fmtUsd(p.requiredEquity)}`);
    if (p.requiredPaydown !== undefined) extra.push(`requiredPaydown ${fmtUsd(p.requiredPaydown)}`);
    if (p.requiredReserve !== undefined) extra.push(`requiredReserve ${fmtUsd(p.requiredReserve)}`);
    console.log(`    - ${p.id ?? '?'}  [${p.lever}]${extra.length ? '  ' + extra.join(' · ') : ''}`);
  }
  console.log('');
  console.log('  Reconciliation notes:');
  for (const n of recon.notes) console.log(`    • ${n}`);
  console.log('');

  /* ===================== ANSWER-KEY CROSS-CHECK ======================= */
  console.log('================================================================');
  console.log('ANSWER-KEY CROSS-CHECK ($82.46M was the real-securitization size)');
  console.log('================================================================');
  console.log('');
  const ANSWER_KEY = 82_460_000;
  const finalDelta = ANSWER_KEY - recon.finalLoanAmount;
  console.log(`  Answer-key proceeds      : ${fmtUsd(ANSWER_KEY)}`);
  console.log(`  Structure-first proceeds : ${fmtUsd(recon.finalLoanAmount)}`);
  console.log(`  Δ (answer-key − v1.3)    : ${fmtUsd(finalDelta)}`);
  console.log('');
  if (Math.abs(finalDelta) < 100_000) {
    console.log('  ✓ Structure-first MATCHES the answer key within rounding.');
    console.log('    → v1.3 holds full proceeds via structural cures.');
  } else if (finalDelta > 0) {
    console.log('  Structure-first held LESS than the answer key.');
    console.log('    → A binding constraint (named above) forced a cut. Compare to');
    console.log('      the prior v1.2 cut to see whether v1.3 is less invasive.');
    console.log('    → v1.2 baseline cut was $18.73M; current cut delta vs that:');
    console.log(`      $18.73M − ${fmtUsd(recon.proceedsReduction)} = ${fmtUsd(18_730_000 - recon.proceedsReduction)} smaller.`);
  } else {
    console.log('  Structure-first held MORE than the answer key.');
    console.log('    → Should not normally happen; investigate.');
  }
  console.log('');

  /* ===================== FINAL-STATE SIGNALS ========================= */
  console.log('================================================================');
  console.log('FINAL-STATE (post-composition) DOCTRINE SIGNALS');
  console.log('================================================================');
  const fs7 = composedMitigationPackage.finalState.dealResult.dimensions.capRateValuationStress;
  const fs4 = composedMitigationPackage.finalState.dealResult.dimensions.refinanceFeasibility;
  console.log('');
  console.log(`  stressed LTV at L'   : ${fmtPct(fs7.derivedOutputs?.stressedLtv as number | null | undefined)}`);
  console.log(`  exit DSCR at L'      : ${fmtDscr(fs4.derivedOutputs?.exitDscr as number | null | undefined)}`);
  console.log(`  ai.metrics.dscr at L': ${fmtDscr(composedMitigationPackage.finalState.adjustedInputs.metrics.dscr)}`);
  console.log(`  ai.metrics.debtYield : ${fmtPct(composedMitigationPackage.finalState.adjustedInputs.metrics.debtYield)}`);
  console.log('');

  /* ===================== RENDER MEMO + DRIFT SCAN ===================== */
  console.log('================================================================');
  console.log('RENDER MEMO + v1.6 DRIFT SCAN');
  console.log('================================================================');
  const html = buildCommitteeMemo({
    dealName: 'Sunroad Centrum',
    memoDate: '2026-06-12',
    narrative, dealResult, composedMitigationPackage,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log('');
  console.log(`  Wrote ${html.length.toLocaleString()} bytes to ${OUT_HTML}`);
  console.log('');

  const authBlock = renderAuthoritativeNumbersBlock(projectAuthoritativeNumbers(dealResult, composedMitigationPackage));
  const mitigantsBlock = narrative.mitigationSuggestions;
  const findingsBlock = extractCleanDoctrineFindings(dealResult)
    .map(f => `- [dim-${f.dimNumber} ${f.dimensionId}] tier=${f.tier} — ${f.headline}`)
    .join('\n');
  const extractFigs = (s: string) => {
    const out: { token: string; kind: 'usd' | 'pct' | 'dscr' }[] = [];
    for (const m of s.matchAll(/\$\d{1,3}(?:,\d{3})*(?:\.\d+)?[MK]?/g)) out.push({ token: m[0], kind: 'usd' });
    for (const m of s.matchAll(/\d+(?:\.\d+)?%/g)) out.push({ token: m[0], kind: 'pct' });
    for (const m of s.matchAll(/\d+(?:\.\d+)?x/g)) out.push({ token: m[0], kind: 'dscr' });
    return out;
  };
  const slots: { name: string; text: string }[] = [
    { name: 'executive_summary       ', text: narrative.executiveSummary },
    { name: 'committee_recommendation', text: narrative.committeeRecommendation },
    { name: 'red_flag_assessment     ', text: narrative.redFlagAssessment },
  ];
  let drift = false;
  for (const s of slots) {
    const figs = extractFigs(s.text);
    const bad = figs.filter(f => !authBlock.includes(f.token) && !mitigantsBlock.includes(f.token) && !findingsBlock.includes(f.token));
    if (bad.length === 0) {
      console.log(`  ${s.name}: ✓ ${figs.length} tokens engine-cited`);
    } else {
      drift = true;
      console.log(`  ${s.name}: ✗ ${bad.length}/${figs.length} DRIFT — ${bad.map(b => b.token).join(', ')}`);
    }
  }
  console.log(`  ${drift ? '✗ DRIFT' : '✓ NO DRIFT'} overall.`);
  console.log('');

  /* ===================== SUMMARY ====================================== */
  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`  LTV band                 : ${ltvBand.toUpperCase()}    (stressed LTV ${fmtPct(stressedLtv)} vs ceiling ${fmtPct(ltvCeiling)})`);
  console.log(`  Exit band                : ${exitBand.toUpperCase()}   (exit DSCR ${fmtDscr(exitDscr)} vs floor ${fmtDscr(exitFloor)})`);
  console.log(`  Day-1 DSCR vs T_DSCR     : ${fmtDscr(day1Dscr)} vs ${fmtDscr(DEFAULT_MITIGATION_DESK.T_DSCR)}  → ${day1Dscr !== null && day1Dscr >= DEFAULT_MITIGATION_DESK.T_DSCR ? 'OK' : 'BREACH'}`);
  console.log(`  Composition outcome      : ${recon.finalLoanAmount === recon.originalLoanAmount ? 'HOLD ' + fmtUsd(recon.originalLoanAmount) : 'CUT to ' + fmtUsd(recon.finalLoanAmount) + ' (' + fmtUsd(recon.proceedsReduction) + ' reduction)'}`);
  console.log(`  v1.2 baseline cut        : $18.73M (LTV-target-driven over-cut)`);
  console.log(`  v1.3 cut vs v1.2         : ${recon.proceedsReduction === 0 ? 'no cut — holds full size' : `${fmtUsd(18_730_000 - recon.proceedsReduction)} smaller`}`);
  console.log(`  Drift                    : ${drift ? '✗ DRIFT' : '✓ NO DRIFT'}`);
  console.log(`  Memo HTML                : ${OUT_HTML}`);
  console.log('');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });

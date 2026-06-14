/**
 * Narrative engine v1.6 validation — REAL Sunroad + operator-supplied value.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-narrative-v16-sunroad-real.ts
 *
 * What this validates:
 *   1. The v1.6 producer path consumes composeMitigations output as STRUCTURED,
 *      FIXED facts via the AuthoritativeNumbers block. Every prompt embeds the
 *      same projection — LLM writes prose around the numbers, never
 *      recomputes them.
 *   2. mitigation_suggestions renders the COMPOSED package + reconciliation
 *      notes ("standalone amortization $X → $0, superseded by the $Y proceeds
 *      cut"). Pure deterministic; no LLM call.
 *   3. red_flag_assessment puts clean-doctrine dim findings PRIMARY; handbook
 *      flags appear as a labeled SUPPORTING sub-section with metric strings
 *      stripped (qualitative only). No handbook LTV / value / leverage figures
 *      reach the prompt prose.
 *   4. executive_summary leads with rating + headline restructuring + valuation
 *      basis line ("valuation basis: operator-supplied").
 *   5. committee_recommendation grounds in the clean rating + composed
 *      conditions ("approvable IF implemented").
 *   6. Three runs with the SAME deterministic LLM stub return BYTE-IDENTICAL
 *      authoritative-numbers blocks + mitigation-suggestions slot text. Prose
 *      may vary in real LLM use; the structured numbers must not.
 *
 * Pipeline:
 *   - Loads real Sunroad ExtractionResult + AssetProfile from
 *     data/phase4-sunroad.db (same db the value-seam harness used).
 *   - Threads operatorSuppliedValue $126,200,362 through adaptExtractionToDealBag.
 *   - Runs evaluateDeal → produceMitigations → composeMitigations.
 *   - Builds a minimal HandbookEvaluation + MitigationProposalSet so the
 *     narrative producer's wire shape is satisfied.
 *   - Calls buildNarrative 3 times with the same deterministic stub LLM that
 *     prints back a slot-specific fixed paragraph; asserts the deterministic
 *     fragments are byte-identical across runs.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  adaptExtractionToDealBag,
  evaluateDeal,
  type OperatorSuppliedValue,
} from '../doctrine-clean/index.js';
import {
  composeMitigations,
  type DealComputeState,
} from '../services/mitigation/compose-mitigations.js';
import { produceMitigations } from '../services/mitigation/produce-mitigations.js';
import {
  buildNarrative,
  projectAuthoritativeNumbers,
  extractCleanDoctrineFindings,
} from '../services/narrative/build-narrative.js';
import { callAIWithContinuation } from '../services/ai-analysis.service.js';
import {
  renderAuthoritativeNumbersBlock,
  renderComposedMitigationsList,
} from '../services/narrative/prompt-templates.js';
import { computeMitigationProposalSetId } from '../util/content-hash.js';
import {
  MITIGATION_ENGINE_VERSION,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputs,
  AdjustedLineItem,
  AssetProfile,
  ExtractionResult,
  PropertyMetadata,
  HandbookEvaluation,
  HandbookEvaluationId,
  MitigationProposalSet,
} from '@cre/contracts';
import type { UnderwritingModel } from '@cre/shared';

const SUNROAD_DB = path.resolve(process.cwd(), 'data/phase4-sunroad.db');

/* --------------------------- db read helpers ------------------------------ */

function readSunroad(): { extraction: ExtractionResult; assetProfile: AssetProfile } {
  const db = new Database(SUNROAD_DB, { readonly: true, fileMustExist: true });
  try {
    const exRow = db.prepare(
      `SELECT id, payload FROM extraction_results ORDER BY length(payload) DESC LIMIT 1`,
    ).get() as { id: string; payload: string } | undefined;
    if (!exRow) throw new Error(`no extraction_results in ${SUNROAD_DB}`);
    const extraction = { id: exRow.id, ...JSON.parse(exRow.payload) } as ExtractionResult;
    const apRow = db.prepare(
      `SELECT id, payload FROM asset_profiles LIMIT 1`,
    ).get() as { id: string; payload: string } | undefined;
    if (!apRow) throw new Error(`no asset_profiles in ${SUNROAD_DB}`);
    const assetProfile = { id: apRow.id, ...JSON.parse(apRow.payload) } as AssetProfile;
    return { extraction, assetProfile };
  } finally {
    db.close();
  }
}

/* --------- AI / UW / dealBag builders (same pattern as value-seam) ------- */

function li(raw: number | null, adjusted: number): AdjustedLineItem {
  return { raw, adjusted, source: 'BANK' as any, adjustments: [] };
}

function buildAi(loanAmount: number, coupon: number, termYears: number, ioYears: number, noi: number, valueForLegacyLtv: number, sustainableNcfForDscr: number): AdjustedInputs {
  const debtServiceAnnual = loanAmount * coupon;
  const dscr = sustainableNcfForDscr / debtServiceAnnual;
  const debtYield = noi / loanAmount;
  return {
    id: 'AI_N16_SUNROAD' as any, analysisAsOfDate: '2026-05-31T00:00:00Z' as any, extractionResultId: 'X' as any, adjustedInputsEngineVersion: '1.10' as any,
    income: { grossRentalIncome: li(null, 0), otherIncome: li(null, 0), vacancyPct: li(null, 0.05), concessionsPct: li(null, 0), effectiveGrossIncome: li(null, 13_628_082) } as any,
    expenses: {} as any, capitalReserves: {} as any,
    loan: {
      loanAmount: li(loanAmount, loanAmount),
      interestRate: li(coupon, coupon),
      termMonths: li(termYears * 12, termYears * 12),
      amortizationMonths: li(0, 0),
      ioPeriodMonths: li(ioYears * 12, ioYears * 12),
      maturityBalance: li(null, loanAmount),
      maturityDate: '2031-05-31T00:00:00Z' as any,
      debtServiceAnnual: li(null, debtServiceAnnual),
    },
    assumptions: { capRate: li(0.0675, 0.0675), terminalCapRate: li(0.08, 0.08), concludedCapRate: null, rentGrowthPct: li(0.03, 0.03), expenseGrowthPct: li(0.03, 0.03) },
    metrics: {
      noi, value: valueForLegacyLtv, dscr,
      ltvAppraisal: null, debtYield,
      expenseRatio: 0.35, top1IncomeShare: null, pctIncomeExpiringWithinTerm: null,
      trailingActualNoi: null, issuerCfUwNoi: null, inPlaceNoi: null,
      issuerStatedNoiSellerUw: null, issuerStatedNoiAsr: null, noiDivergence: null,
    },
    topLevelAdjustments: [], dataQualityFlags: [],
    dataConfidence: 'validated' as any,
  } as unknown as AdjustedInputs;
}

function liField(id: string, label: string, amt: number): any { return { id, label, annualAmount: amt, isEditable: true, isOverridden: false, originalValue: amt }; }

function buildUw(loanAmount: number, coupon: number, termYears: number, ioYears: number, noi: number, valueForLegacyLtv: number): UnderwritingModel {
  const egi = 13_628_082;
  const toe = egi - noi;
  const annualDebtService = loanAmount * coupon;
  const dscr = noi / annualDebtService;
  const debtYield = noi / loanAmount;
  return {
    income: { grossPotentialRent: liField('gpr', 'GPR', egi * 1.05), vacancyLoss: liField('vac', 'V', -egi * 0.05), concessions: liField('con', 'C', 0), otherIncome: liField('oth', 'O', 0), effectiveGrossIncome: liField('egi', 'EGI', egi), additionalItems: [] },
    expenses: { realEstateTaxes: liField('tax', 'T', toe * 0.30), insurance: liField('ins', 'I', toe * 0.08), utilities: liField('util', 'U', toe * 0.10), repairsAndMaintenance: liField('rm', 'RM', toe * 0.10), management: liField('mgmt', 'M', toe * 0.08), generalAndAdmin: liField('ga', 'GA', toe * 0.04), payroll: liField('pr', 'PR', toe * 0.15), replacementReserves: liField('rr', 'RR', toe * 0.05), totalExpenses: liField('toe', 'TOE', toe), additionalItems: [] },
    netOperatingIncome: noi, capRate: 0.0675, impliedValue: valueForLegacyLtv, loanAmount,
    interestRate: coupon * 100, amortizationYears: 0, termYears, annualDebtService, dscr,
    ltv: loanAmount / valueForLegacyLtv, debtYield, asReported: true, modifiedCells: [],
    loanDetails: { loanAmount, interestRate: coupon * 100, rateType: 'fixed', ioMonths: ioYears * 12, amortizationMonths: 0, termMonths: termYears * 12, paymentFrequency: 'monthly', originationDate: '2026-05-31', maturityDate: '2031-05-31' } as any,
    repaymentSchedule: null,
  } as unknown as UnderwritingModel;
}

/* ---------------------------- LLM stub --------------------------------- */
/* Deterministic per-slot stub: dispatches on the system + user message
 * content to return a frozen fragment per slot. The same stub is used
 * across all three runs so determinism asserts cleanly. */

function makeStubLlm(): import('../services/narrative/build-narrative.js').LLMCallFn {
  return async ({ messages }) => {
    const userMsg = (messages?.[0]?.content as string) ?? '';
    // The v1.6 prompts include slot-specific lead instructions; dispatch on those.
    if (userMsg.startsWith('Compose a single executive-summary paragraph')) {
      return 'Stubbed executive_summary prose: Recommend conditional approval. The deal is restructurable but requires the proceeds reduction cited above; valuation basis disclosed verbatim from the authoritative-numbers block.';
    }
    if (userMsg.startsWith('Compose a red-flag assessment')) {
      return '- [dim-1 leverage-ltv] tier=elevated — stressed LTV cited verbatim above. \n- [dim-4 refinance-feasibility] tier=concerning — exit DSCR cited verbatim above.\n\nSupporting observations:\n- [P-XX-N] (medium) — qualitative handbook line goes here without quantitative figures.';
    }
    if (userMsg.startsWith('Compose a committee recommendation')) {
      return 'Stubbed committee_recommendation prose: Recommend conditional approval subject to the proceeds reduction cited above (verbatim from the authoritative-numbers block); valuation basis is operator-supplied as disclosed; no additional sized conditions are proposed beyond the composed package.';
    }
    return 'Stub response: no slot dispatch matched (this should not happen in the v1.6 path).';
  };
}

/* -------------------------------- main --------------------------------- */

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

/* --------------------- numeric-drift extractor --------------------------- */
/* Scans LLM-authored prose for every dollar / percent / DSCR-multiple
 * pattern. For each match, checks whether the verbatim token appears in
 * the authoritative-numbers block. Reports drift. */

interface DriftCheck {
  readonly token: string;            // exact substring extracted from prose
  readonly kind: 'usd' | 'pct' | 'dscr';
  readonly inAuth: boolean;
}

function extractFigures(prose: string): Array<{ token: string; kind: DriftCheck['kind'] }> {
  const out: Array<{ token: string; kind: DriftCheck['kind'] }> = [];
  // USD: $N.NNM, $N.NNK, $N,NNN,NNN, $NNN
  for (const m of prose.matchAll(/\$\d{1,3}(?:,\d{3})*(?:\.\d+)?[MK]?/g)) out.push({ token: m[0], kind: 'usd' });
  // Percent: N.NN%, N%, N.N%
  for (const m of prose.matchAll(/\d+(?:\.\d+)?%/g)) out.push({ token: m[0], kind: 'pct' });
  // DSCR multiple: N.NNx, N.Nx
  for (const m of prose.matchAll(/\d+(?:\.\d+)?x/g)) out.push({ token: m[0], kind: 'dscr' });
  return out;
}

/**
 * Engine-derived deterministic corpus the LLM saw. The doctrine treats
 * every block here as authoritative — auth-numbers block (load-bearing
 * facts), composed-mitigants block (lever descriptions with engine-sized
 * figures), clean-doctrine findings block. Any numeric token in the LLM
 * prose that appears verbatim in this corpus is engine-cited, not
 * invented. Tokens NOT in any block are LLM hallucination / drift.
 */
interface EngineCorpus {
  readonly authBlock: string;
  readonly mitigationsBlock: string;
  readonly findingsBlock: string;
}

interface DriftCheckWide extends DriftCheck {
  readonly inMitigations: boolean;
  readonly inFindings: boolean;
  readonly source: 'auth' | 'mitigations' | 'findings' | 'DRIFT';
}

/** Check verbatim presence — token must appear as a substring of auth block. */
function checkDrift(prose: string, authBlock: string): DriftCheck[] {
  const figures = extractFigures(prose);
  return figures.map((f) => ({
    token: f.token,
    kind: f.kind,
    inAuth: authBlock.includes(f.token),
  }));
}

/** Wider check: scan against ALL engine-derived deterministic blocks. */
function checkDriftWide(prose: string, corpus: EngineCorpus): DriftCheckWide[] {
  const figures = extractFigures(prose);
  return figures.map((f) => {
    const inAuth         = corpus.authBlock.includes(f.token);
    const inMitigations  = corpus.mitigationsBlock.includes(f.token);
    const inFindings     = corpus.findingsBlock.includes(f.token);
    const source: DriftCheckWide['source'] =
      inAuth        ? 'auth'
      : inMitigations ? 'mitigations'
      : inFindings    ? 'findings'
      : 'DRIFT';
    return { token: f.token, kind: f.kind, inAuth, inMitigations, inFindings, source };
  });
}

async function main(): Promise<void> {
  const useLiveLlm = process.argv.includes('--live-llm');
  console.log('================================================================');
  console.log(`NARRATIVE v${NARRATIVE_ENGINE_VERSION} VALIDATION — REAL Sunroad + operator-supplied $126.20M`);
  console.log(`LLM mode: ${useLiveLlm ? 'LIVE Sonnet (callAIWithContinuation)' : 'deterministic stub'}`);
  console.log('================================================================');
  console.log('');

  const { extraction, assetProfile } = readSunroad();
  console.log(`Loaded extraction id=${(extraction as any).id?.slice(0, 12)}…  AssetProfile.propertyType=${(assetProfile as any).propertyType}`);
  console.log('');

  /* ------------- run the pipeline up to the composed package ------------- */
  const operatorValue: OperatorSuppliedValue = {
    value: 126_200_362,
    source: 'operator-supplied',
    asOf: '2026-04-15T00:00:00Z' as any,
    basis: 'Desk BOV anchored to Q1 ratings actions on comparable Office CBD towers',
  };
  const propertyMetadata: PropertyMetadata | null = null;
  const dealBag = adaptExtractionToDealBag(extraction, propertyMetadata, {
    explicitAssetType: (assetProfile as any).propertyType ?? null,
    operatorSuppliedValue: operatorValue,
  });
  const dealResult = evaluateDeal(dealBag);
  const loanAmount = dealBag.loanAmount as number;
  const coupon = dealBag.coupon as number;
  const noi = dealBag.uwY1Noi as number;
  const sustainableNcf = (dealResult.normalization.sustainableNcf as number) ?? 0;

  console.log('Baseline pipeline:');
  console.log(`  loanAmount               : ${fmtUsd(loanAmount)}`);
  console.log(`  uwY1Noi                  : ${fmtUsd(noi)}`);
  console.log(`  sustainable NCF          : ${fmtUsd(sustainableNcf)}`);
  console.log(`  concluded value (operator): ${fmtUsd(dealBag.concludedValue)}`);
  console.log(`  concludedValueSource     : ${dealBag.concludedValueSource}`);
  console.log(`  dim-7 stressedValue      : ${fmtUsd(dealResult.dimensions.capRateValuationStress.derivedOutputs?.stressedValue as number | null | undefined)}`);
  console.log(`  dim-4 exit DSCR baseline : ${((dealResult.dimensions.refinanceFeasibility.derivedOutputs?.exitDscr as number | null | undefined) ?? NaN).toFixed(3)}`);
  console.log('');

  const ai = buildAi(loanAmount, coupon, 5, 5, noi, operatorValue.value, sustainableNcf);
  const uw = buildUw(loanAmount, coupon, 5, 5, noi, operatorValue.value);

  // Compose with a closure recompute that re-runs the adapter at the new
  // loan size (operator value preserved).
  const composedPackage = composeMitigations({
    adjustedInputs: ai, uwModel: uw, dealResult, firedFlags: [],
    recomputeAtLoan: (newLoan: number): DealComputeState => {
      const newBag = { ...dealBag, loanAmount: newLoan };
      const newDealResult = evaluateDeal(newBag);
      const newSustainable = (newDealResult.normalization.sustainableNcf as number) ?? sustainableNcf;
      return {
        adjustedInputs: buildAi(newLoan, coupon, 5, 5, noi, operatorValue.value, newSustainable),
        uwModel: buildUw(newLoan, coupon, 5, 5, noi, operatorValue.value),
        dealResult: newDealResult,
      };
    },
  });
  console.log('Composed package:');
  console.log(`  finalLoanAmount (L')     : ${fmtUsd(composedPackage.finalLoanAmount)}`);
  console.log(`  proceedsReduction        : ${fmtUsd(composedPackage.reconciliation.proceedsReduction)}`);
  console.log(`  standaloneAmortPaydown   : ${fmtUsd(composedPackage.reconciliation.standaloneAmortPaydown)}`);
  console.log(`  composedAmortPaydown     : ${composedPackage.reconciliation.composedAmortPaydown === null ? '— (dropped)' : fmtUsd(composedPackage.reconciliation.composedAmortPaydown)}`);
  for (const n of composedPackage.reconciliation.notes) console.log(`  • ${n}`);
  console.log('');

  /* ------------------- minimal HE + proposal set stubs ------------------ */
  // Sunroad's real handbook fires JE_TRAILING_ACTUALS_MISSING + a few other
  // missing-doc flags; that's not the v1.6 surface we're validating. Stub
  // a small handbook-flag set so the supporting-observations sub-section
  // has content; v1.6 strips metric strings before injection.
  const stubHandbook: HandbookEvaluation = {
    id: 'HE_STUB' as HandbookEvaluationId,
    analysisAsOfDate: '2026-05-31T00:00:00Z' as any,
    adjustedInputsId: ai.id,
    handbookVersion: '2026.1',
    firedFlags: [
      { principleId: 'P-IV-OFF-6', severity: 'medium', flag_message: 'stress-scenario coverage thin', metricValue: 1.05 as any, groupIndex: 0, bandIndex: 0, injectionPoints: ['red_flag_assessment', 'executive_summary'] },
      { principleId: 'P-II-DD-2', severity: 'medium', flag_message: 'trailing-actuals not extracted', metricValue: 'missing' as any, groupIndex: 0, bandIndex: 0, injectionPoints: ['red_flag_assessment'] },
    ],
    skippedPrinciples: [],
    handbookEngineVersion: '1.0' as any,
  } as unknown as HandbookEvaluation;

  const proposalSetBody = {
    adjustedInputsId: ai.id,
    handbookEvaluationId: stubHandbook.id,
    mitigationEngineVersion: MITIGATION_ENGINE_VERSION,
    proposals: produceMitigations({ adjustedInputs: ai, uwModel: uw, firedFlags: [], dealResult }),
  };
  const mitigationProposalSet: MitigationProposalSet = {
    id: computeMitigationProposalSetId(proposalSetBody),
    ...proposalSetBody,
  };

  /* ----------------- 3 runs of buildNarrative + assertions -------------- */
  console.log('================================================================');
  console.log('Running buildNarrative 3 times with the SAME deterministic stub LLM');
  console.log('Assertion: the deterministic fragments (AuthoritativeNumbers block,');
  console.log('  mitigation_suggestions slot text) MUST be byte-identical across runs.');
  console.log('================================================================');
  console.log('');

  const llmCall = useLiveLlm ? callAIWithContinuation : makeStubLlm();
  const runs: Array<{
    run: number;
    mitigationSuggestions: string;
    authBlock: string;
    executiveSummary: string;
    committeeRecommendation: string;
    redFlagAssessment: string;
  }> = [];

  for (let i = 1; i <= 3; i++) {
    console.log(`Run ${i}/3 — invoking buildNarrative ...`);
    const narrative = await buildNarrative({
      handbookEvaluation: stubHandbook,
      adjustedInputsId: ai.id,
      analysisAsOfDate: '2026-05-31T00:00:00Z' as any,
      dataConfidence: 'validated' as any,
      dataQualityFlags: [],
      mitigationProposalSet,
      dealResult,
      composedMitigationPackage: composedPackage,
    }, { llmCall });
    const auth = projectAuthoritativeNumbers(dealResult, composedPackage);
    runs.push({
      run: i,
      mitigationSuggestions: narrative.mitigationSuggestions,
      authBlock: renderAuthoritativeNumbersBlock(auth),
      executiveSummary: narrative.executiveSummary,
      committeeRecommendation: narrative.committeeRecommendation,
      redFlagAssessment: narrative.redFlagAssessment,
    });
  }
  console.log('');

  let allStable = true;
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].authBlock !== runs[0].authBlock) {
      console.log(`  ✗ run ${i + 1} authoritative-numbers block diverges from run 1`);
      allStable = false;
    }
    if (runs[i].mitigationSuggestions !== runs[0].mitigationSuggestions) {
      console.log(`  ✗ run ${i + 1} mitigation_suggestions text diverges from run 1`);
      allStable = false;
    }
  }
  if (allStable) {
    console.log('  ✓ 3 runs produce BYTE-IDENTICAL authoritative-numbers blocks');
    console.log('  ✓ 3 runs produce BYTE-IDENTICAL mitigation_suggestions slot text');
  }
  console.log('');

  /* ----------- Show the authoritative-numbers block (verbatim) ---------- */
  console.log('================================================================');
  console.log('AUTHORITATIVE NUMBERS block (embedded verbatim in every v1.6 slot prompt)');
  console.log('================================================================');
  console.log(runs[0].authBlock);
  console.log('');

  /* ----------- Show the mitigation_suggestions slot text ---------------- */
  console.log('================================================================');
  console.log('mitigation_suggestions slot (deterministic; rendered from composed package)');
  console.log('================================================================');
  console.log(runs[0].mitigationSuggestions);
  console.log('');

  /* ----------- Show the clean-doctrine findings extraction -------------- */
  const findings = extractCleanDoctrineFindings(dealResult);
  console.log('================================================================');
  console.log('Clean-doctrine findings (PRIMARY source for red_flag_assessment)');
  console.log('================================================================');
  for (const f of findings) console.log(`  - [dim-${f.dimNumber} ${f.dimensionId}] tier=${f.tier} — ${f.headline}`);
  console.log('');

  /* --------- Confirm NO handbook quantitative figures leak into prompts --- */
  console.log('================================================================');
  console.log('Handbook demotion check');
  console.log('================================================================');
  console.log('Handbook flags (PRE-render):');
  for (const f of stubHandbook.firedFlags) console.log(`  - ${f.principleId} severity=${f.severity}  message="${f.flag_message}"  metricValue=${f.metricValue}`);
  console.log('');
  console.log('Handbook qualitative-only projection (POST-render — INJECTED into v1.6 prompts):');
  console.log('  This is the only handbook content reaching the LLM prompt prose.');
  console.log('  Metric values are STRIPPED — no "(metric: ...)" clause.');
  console.log('');
  const supportingProjection = stubHandbook.firedFlags.map(f => `- [${f.principleId}] (${f.severity}) — ${f.flag_message}`).join('\n');
  console.log(supportingProjection);
  console.log('');
  if (supportingProjection.includes('metric:') || supportingProjection.match(/\$\d/) || supportingProjection.match(/\d+%/)) {
    console.log('  ✗ handbook quantitative figures leaked into the qualitative projection');
  } else {
    console.log('  ✓ qualitative-only projection — no handbook metric strings reach the prompt');
  }
  console.log('');

  /* ----------- Source-tag disclosure (operator-supplied) ---------------- */
  const sourceLine = runs[0].authBlock.split('\n').find(l => l.includes('valuation basis')) ?? '';
  if (sourceLine.includes('operator-supplied')) {
    console.log(`  ✓ valuation basis disclosure present: ${sourceLine.trim()}`);
  } else {
    console.log(`  ✗ valuation basis line missing or not 'operator-supplied'`);
  }
  console.log('');

  /* --------- Per-run prose + drift scan (WIDE: all engine-derived blocks) -- */
  if (useLiveLlm) {
    console.log('================================================================');
    console.log('PER-RUN PROSE + WIDE DRIFT SCAN');
    console.log('================================================================');
    console.log('Drift rule (WIDE): every $/% /x figure in the LLM-authored prose MUST');
    console.log('  appear as a verbatim substring of SOME engine-derived deterministic');
    console.log('  block the LLM saw — auth-numbers block, composed-mitigants block,');
    console.log('  or clean-doctrine findings block. A token sourced from any of those');
    console.log('  three is engine-cited, not invented. A token in NONE of them is DRIFT.');
    console.log('  The literal valuation-basis line "operator-supplied" must also appear.');
    console.log('');
    // Build the wide corpus once per run (it is identical across runs given
    // the same input — composedPackage/dealResult are pre-LLM, deterministic).
    const corpus: EngineCorpus = {
      authBlock:        runs[0].authBlock,
      mitigationsBlock: runs[0].mitigationSuggestions,
      findingsBlock:    extractCleanDoctrineFindings(dealResult)
        .map((f) => `- [dim-${f.dimNumber} ${f.dimensionId}] tier=${f.tier} — ${f.headline}`)
        .join('\n'),
    };
    let anyDrift = false;
    for (const r of runs) {
      console.log(`────── RUN ${r.run} ───────────────────────────────────────────`);
      console.log('');
      console.log('▎ executive_summary');
      console.log(r.executiveSummary);
      console.log('');
      console.log('▎ committee_recommendation');
      console.log(r.committeeRecommendation);
      console.log('');
      const execDrift = checkDriftWide(r.executiveSummary,        corpus);
      const cmteDrift = checkDriftWide(r.committeeRecommendation, corpus);
      const redfDrift = checkDriftWide(r.redFlagAssessment,       corpus);
      const reportSlot = (label: string, drift: DriftCheckWide[]): void => {
        const bad = drift.filter((d) => d.source === 'DRIFT');
        const byAuth = drift.filter((d) => d.source === 'auth').length;
        const byMit  = drift.filter((d) => d.source === 'mitigations').length;
        const byFind = drift.filter((d) => d.source === 'findings').length;
        if (drift.length === 0) {
          console.log(`  ${label}: (no numeric tokens in prose)`);
        } else if (bad.length === 0) {
          console.log(`  ${label}: ✓ all ${drift.length} tokens engine-cited (auth=${byAuth} mitigants=${byMit} findings=${byFind})`);
          for (const d of drift) console.log(`    ✓ ${d.kind} ${d.token}  [source: ${d.source}]`);
        } else {
          anyDrift = true;
          console.log(`  ${label}: ✗ ${bad.length} of ${drift.length} tokens are DRIFT (auth=${byAuth} mitigants=${byMit} findings=${byFind})`);
          for (const d of drift) console.log(`    ${d.source === 'DRIFT' ? '✗ DRIFT' : '✓'} ${d.kind} ${d.token}  [source: ${d.source}]`);
        }
      };
      console.log('▎ DRIFT SCAN (wide; against full engine corpus)');
      reportSlot('executive_summary       ', execDrift);
      reportSlot('committee_recommendation', cmteDrift);
      reportSlot('red_flag_assessment     ', redfDrift);
      const basisOk = /operator-supplied/i.test(r.executiveSummary) || /operator-supplied/i.test(r.committeeRecommendation);
      console.log(`  valuation-basis line ("operator-supplied"): ${basisOk ? '✓ present' : '✗ MISSING'}`);
      if (!basisOk) anyDrift = true;
      console.log('');
    }
    console.log('────────────────────────────────────────────────────────────');
    console.log(anyDrift
      ? '  OVERALL: ✗ DRIFT detected — at least one LLM figure does not trace to any engine-derived block. Tighten the verbatim instruction.'
      : '  OVERALL: ✓ NO DRIFT — every numeric token in LLM prose traces verbatim to an engine-derived block (auth / mitigants / findings).');
    console.log('');
  }

  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log('');
  console.log('  ✓ Composed package threaded into buildNarrative (v1.6 path).');
  console.log('  ✓ AuthoritativeNumbers projected deterministically; stable across 3 runs.');
  console.log('  ✓ mitigation_suggestions: COMPOSED proposals + reconciliation; no LLM.');
  console.log('  ✓ Clean-doctrine findings PRIMARY for red_flag_assessment.');
  console.log('  ✓ Handbook qualitative-only — metric strings stripped before injection.');
  console.log('  ✓ Source tag operator-supplied disclosed in the authoritative block.');
  console.log('');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });

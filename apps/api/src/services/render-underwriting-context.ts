// Stage 13 render (Batch 6.7) - read-pole semantic layer.
//
// Pure function: UnderwritingContext -> RenderedAnalysis. Section-keyed map, content-hashed.
// This is the FIRST read-side stage allowed to interpret data for presentation. Per the locked
// architectural semantics model, render performs:
//
//   - missing-data explanation (null -> sentinel string; INSUFFICIENT_DATA -> badge label)
//   - typed flag promotion to RenderBadges
//   - human-facing string formatting (canonical, byte-stable)
//
// ============================================================================
// Read-pole discipline (LOCKED). Mirrors HY1-HY7 / PJ1-PJ5 in spirit but inverts what's
// permitted: interpretation IS allowed here for display, but the following structural
// guarantees are non-negotiable. Any future change must justify conformance to every line
// or the change is rejected on first reading.
// ============================================================================
//
//   RD1 - No upstream reach-back. Render imports types from @cre/contracts plus formatting
//         utilities only. Forbidden: services/judgment/*, services/doctrine/*,
//         services/valuation.service, services/stress-test*.service, services/cross-check*.service,
//         services/extraction/*, services/asset-profiler.service, services/library-snapshot-producer.service,
//         services/narrative-facts.service, services/ingest-extraction-result, services/hydrate-record-graph,
//         services/build-underwriting-context-projection, storage/*, services/analysis-to-adjusted-inputs.adapter.
//
//   RD2 - No re-derivation. Producer outputs (NOI, DSCR, LTV, debt yield, value, mechanical
//         score, etc.) are READ from the projection. Recomputing them in render is forbidden.
//
//   RD3 - No mutation. Render is read-only. No store writes, no array mutations on input
//         records, no side effects.
//
//   RD4 - Pure function. Same UnderwritingContext -> byte-identical RenderedAnalysis.
//         No clock (new Date / Date.now / Date.parse / Date.UTC), no random, no env, no
//         filesystem, no network.
//
//   RD5 - Cell completeness. Every cell exposed in RenderedAnalysis has a non-empty
//         displayValue. Missing data surfaces as the sentinel, NOT as a missing field.
//
// ============================================================================

import type {
  MitigationProposal,
  MitigationProposalSet,
  NarrativeEvaluation,
  RecalcSnapshot,
  RenderBadge,
  RenderedAdjustment,
  RenderedAnalysis,
  RenderedAssumptionsSection,
  RenderedComponentScore,
  RenderedFinding,
  RenderedLineItem,
  RenderedLoanSection,
  RenderedMitigationProposal,
  RenderedNoiBasisCallout,
  RenderedNarrativeSection,
  RenderedRecalcSnapshot,
  RenderedStressScenario,
  RenderedStressSection,
  RenderCell,
  UnderwritingContext,
} from '@cre/contracts';
import { RENDER_VERSION } from '@cre/contracts';
import type { AdjustedLineItem } from '@cre/contracts';
import {
  applyStringSentinel,
  badgeFromFlag,
  NULL_SENTINEL,
} from './render-sentinels.js';
import { computeRenderedAnalysisId } from '../util/content-hash.js';

// 7.5 (Phase 1) + 7.6 (Phase 2 red_flag_assessment) + 7.7 (Phase 3
// mitigation_suggestions) + 7.8 (Phase 4 committee_recommendation) helper.
// Phase 4 closes the slot set — all 4 InjectionPoint slots projected.
// Bijective passthrough of the NarrativeEvaluation sibling. Reads all four
// slots' prose + producer metadata; render adds nothing of its own. Returning
// null when the narrative is absent surfaces the "no narrative composed"
// state truthfully (RA.narrative is `| null`).
function renderNarrativeSection(
  narrative: NarrativeEvaluation | null,
): RenderedNarrativeSection | null {
  if (narrative === null) return null;
  return {
    executiveSummary: narrative.executiveSummary,
    redFlagAssessment: narrative.redFlagAssessment,
    mitigationSuggestions: narrative.mitigationSuggestions,
    committeeRecommendation: narrative.committeeRecommendation,
    engineVersion: narrative.engineVersion,
    consumedFlagPrincipleIds: narrative.consumedFlagPrincipleIds,
    redFlagAssessmentConsumedFlagPrincipleIds:
      narrative.redFlagAssessmentConsumedFlagPrincipleIds,
    mitigationSuggestionsConsumedFlagPrincipleIds:
      narrative.mitigationSuggestionsConsumedFlagPrincipleIds,
    committeeRecommendationConsumedFlagPrincipleIds:
      narrative.committeeRecommendationConsumedFlagPrincipleIds,
  };
}

// FIX 1 — unit-aware line-item formatting. `applyNumericSentinel` is unit-BLIND
// (plain String()), but the UNIT is known at THIS builder from the field name.
// This map routes each named line item to the right formatter so the raw-tier
// tables render dollars with commas, rates with %, counts as integers, etc.
// Null still routes through the formatter, which returns the NULL_SENTINEL —
// preserving the missing-data semantics (never "0"). Fields not listed fall
// back to fmtDollarsFull (income/expense/loan money are the overwhelming
// majority and the sole callers here are the money/rate/count sections below).
type NumFmt = (n: number | null) => string;
const LINE_ITEM_FORMAT: Readonly<Record<string, NumFmt>> = {
  // rate / percentage line items (values are 0..1 fractions)
  vacancyPct:       fmtRate1,
  concessionsPct:   fmtRate1,
  interestRate:     fmtRate1,
  capRate:          fmtRate1,
  terminalCapRate:  fmtRate1,
  concludedCapRate: fmtRate1,
  rentGrowthPct:    fmtRate1,
  expenseGrowthPct: fmtRate1,
  // integer count line items (months)
  termMonths:         fmtCount,
  amortizationMonths: fmtCount,
  ioPeriodMonths:     fmtCount,
};
function lineItemFmt(name: string): NumFmt {
  return LINE_ITEM_FORMAT[name] ?? fmtDollarsFull;
}

// 6.9 D16/D17 helper - bijective passthrough of one AdjustedLineItem.
// NOT a derivation: every numeric value is read directly from the producer's record;
// the adjustments ledger is mapped 1:1 from AdjustmentEntry to RenderedAdjustment.
// FIX 1: the displayValue strings are now unit-aware (dollars/rate/count) chosen
// by field name; the underlying .value is untouched (machine/human split intact).
function projectLineItem(name: string, item: AdjustedLineItem): RenderedLineItem {
  const fmt = lineItemFmt(name);
  return {
    name,
    raw: { value: item.raw, displayValue: fmt(item.raw) },
    adjusted: { value: item.adjusted, displayValue: fmt(item.adjusted) },
    source: item.source,
    adjustments: item.adjustments.map((a): RenderedAdjustment => ({
      ruleId: a.ruleId,
      // Deltas carry the same unit as the line item they adjust.
      delta: { value: a.delta, displayValue: fmt(a.delta) },
      reason: a.reason,
    })),
  };
}

/* ----- mitigation projection helpers (render version 7.10) ---------------- */
// Display formatters for the four metric flavors in the mitigation recalc
// snapshot + dollar amounts. Render-side only: produces byte-stable canonical
// strings for `displayValue`; consumers read the string as-is (no client-side
// locale formatting per the read-pole convention).

function fmtDollarsCompact(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

// FIX 1 — full-comma dollar form for line-item / breakdown tables (headline
// metrics keep the compact $112.5M form via fmtDollarsCompact). Rounds to the
// whole dollar and inserts thousands separators: 7482160 -> "$7,482,160".
// Negative values keep the sign INSIDE the currency: -354055 -> "-$354,055".
function fmtDollarsFull(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
}

function fmtDscr(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return n.toFixed(2) + '×';
}

function fmtRate(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return (n * 100).toFixed(2) + '%';
}

// FIX 1 — 1-decimal percentage for headline-style rate rows (LTV 67.6%,
// debt yield 9.1%, cap / growth assumptions). Input is a 0..1 fraction.
function fmtRate1(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return (n * 100).toFixed(1) + '%';
}

// FIX 1 — plain 2-decimal number for score-like cells (finalScore, mechanical
// score, weighted aggregate, per-component score/weight/contribution). Kills
// the raw-float tail: 35.0999999999999 -> "35.10".
function fmtScore(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return n.toFixed(1);
}

// FIX 1 — integer count for month/term cells (termMonths, amortizationMonths,
// ioPeriodMonths). No decimals, no units.
function fmtCount(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return String(Math.round(n));
}

function dollarCell(n: number | null | undefined): RenderCell<number> {
  const v = n === undefined ? null : n;
  return { value: v, displayValue: fmtDollarsCompact(v) };
}

function projectRecalcSnapshot(s: RecalcSnapshot): RenderedRecalcSnapshot {
  return {
    dscr:         { value: s.dscr,         displayValue: fmtDscr(s.dscr) },
    ltv:          { value: s.ltv,          displayValue: fmtRate(s.ltv) },
    debtYield:    { value: s.debtYield,    displayValue: fmtRate(s.debtYield) },
    impliedValue: { value: s.impliedValue, displayValue: fmtDollarsCompact(s.impliedValue) },
  };
}

function projectMitigationProposal(p: MitigationProposal): RenderedMitigationProposal {
  return {
    id: p.id,
    principleIds: p.principleIds,
    lever: p.lever,
    leverKind: p.leverKind,
    title: p.title,
    description: p.description,
    structuralChanges: p.structuralChanges,
    requiredEquity:  dollarCell(p.requiredEquity),
    requiredReserve: dollarCell(p.requiredReserve),
    recalcBefore: p.recalcBefore ? projectRecalcSnapshot(p.recalcBefore) : null,
    recalcAfter:  p.recalcAfter  ? projectRecalcSnapshot(p.recalcAfter)  : null,
    targetMetric: p.targetMetric ?? null,
    coverageStatement: p.coverageStatement ?? null,
    riskReduction: p.riskReduction,
    severity: p.severity,
    bandIndex: p.bandIndex ?? null,
  };
}

function projectMitigations(
  set: MitigationProposalSet | null,
): readonly RenderedMitigationProposal[] {
  if (set === null || set.proposals.length === 0) return [];
  return set.proposals.map(projectMitigationProposal);
}

/**
 * Option C — project the NOI-basis disclosure into the RenderCell wrapper
 * the workbook consumes. Null when `shouldRender === false` (stabilized
 * deals) so the cell is absent in the rendered payload and the workbook
 * displays NOTHING extra near column P — byte-identical to pre-Option-C.
 */
function projectNoiBasisCallout(
  facts: NoiBasisFactsForRender | null,
): RenderedNoiBasisCallout | null {
  if (facts === null || !facts.shouldRender) return null;
  const judgment = facts.judgmentNoi !== null ? `$${Math.round(facts.judgmentNoi).toLocaleString()}` : '—';
  const contracted = facts.contractedNoi !== null ? `$${Math.round(facts.contractedNoi).toLocaleString()}` : '—';
  const sign = (facts.divergence ?? 0) >= 0 ? '+' : '';
  const delta = facts.divergence !== null ? `${sign}$${Math.round(facts.divergence).toLocaleString()}` : '—';
  const calloutText = `NOI basis: workbook (judgment) ${judgment}; verdict (contracted) ${contracted}; Δ ${delta}. ${facts.divergenceReason}`;
  return {
    judgmentNoi:      { value: facts.judgmentNoi ?? 0, displayValue: judgment },
    contractedNoi:    { value: facts.contractedNoi ?? 0, displayValue: contracted },
    divergence:       { value: facts.divergence ?? 0, displayValue: delta },
    calloutText:      { value: calloutText, displayValue: calloutText },
    divergenceReason: { value: facts.divergenceReason, displayValue: facts.divergenceReason },
  };
}

/**
 * Render-pole RD1 carve-out: `NoiBasisFacts` is a STRUCTURAL value (numbers +
 * strings, no behaviour) declared inline so the renderer can accept it without
 * importing from services/. The shape mirrors `NoiBasisDisclosure` from
 * services/noi-basis.ts but is contract-internal; the bridge runs OUTSIDE
 * render (in materializeRenderedAnalysisWithMeta) and passes a resolved value
 * in. Render only projects the cell — no resolution, no recompute.
 */
export interface NoiBasisFactsForRender {
  readonly shouldRender: boolean;
  readonly judgmentNoi: number | null;
  readonly contractedNoi: number | null;
  readonly divergence: number | null;
  readonly divergenceReason: string;
}

export function renderUnderwritingContext(
  ctx: UnderwritingContext,
  narrative: NarrativeEvaluation | null = null,
  mitigationSet: MitigationProposalSet | null = null,
  noiBasis: NoiBasisFactsForRender | null = null,
): RenderedAnalysis {
  const {
    rootId,
    adjustedInputs,
    doctrineEvaluation,
    valuationConclusion,
    stressOutputs,
  } = ctx;

  const doctrineFlags: readonly RenderBadge[] = doctrineEvaluation.flags.map(
    (code): RenderBadge => badgeFromFlag(code, 'warning'),
  );

  const dataQualityBadges: readonly RenderBadge[] = adjustedInputs.dataQualityFlags.map(
    (code): RenderBadge => badgeFromFlag(code, 'info'),
  );

  // 6.9 D16/D17 — per-line-item breakdowns. Explicit field-name list (NOT Object.keys)
  // to keep ordering deterministic across runs and avoid any iteration-order leak.
  // Each entry is a structural passthrough of one AdjustedLineItem; no arithmetic.
  const incomeLines: readonly RenderedLineItem[] = [
    projectLineItem('grossRentalIncome',     adjustedInputs.income.grossRentalIncome),
    projectLineItem('otherIncome',           adjustedInputs.income.otherIncome),
    projectLineItem('vacancyPct',            adjustedInputs.income.vacancyPct),
    projectLineItem('concessionsPct',        adjustedInputs.income.concessionsPct),
    projectLineItem('effectiveGrossIncome',  adjustedInputs.income.effectiveGrossIncome),
  ];
  const expenseLines: readonly RenderedLineItem[] = [
    projectLineItem('realEstateTaxes',       adjustedInputs.expenses.realEstateTaxes),
    projectLineItem('insurance',             adjustedInputs.expenses.insurance),
    projectLineItem('utilities',             adjustedInputs.expenses.utilities),
    projectLineItem('managementFee',         adjustedInputs.expenses.managementFee),
    projectLineItem('payroll',               adjustedInputs.expenses.payroll),
    projectLineItem('maintenance',           adjustedInputs.expenses.maintenance),
    projectLineItem('other',                 adjustedInputs.expenses.other),
    projectLineItem('totalOperatingExpenses',adjustedInputs.expenses.totalOperatingExpenses),
  ];

  // 7.2 D04 - findings projection. STRICT BIJECTIVE PASSTHROUGH of the producer's
  // doctrine reason ledger. Render is a deterministic translator here, not an
  // analyst: each {ruleId, reasonCode} pair from the producer becomes exactly one
  // RenderedFinding with both fields preserved exactly. Ordering preserved (.map
  // keeps array order). Count preserved (1:1). No synthesis, no inference, no
  // collapsing, no severity assignment. If the producer emits zero findings, the
  // rendered findings array is empty.
  const findings: readonly RenderedFinding[] = doctrineEvaluation.reasons.map(
    (r): RenderedFinding => ({
      ruleId: r.ruleId,
      reasonCode: r.reasonCode,
    }),
  );

  // 7.1 D20 - stress projection. Producer-emitted scenarios pass through unchanged.
  // Each metric numeric is sentinel-wrapped; breach codes promote to warning badges;
  // skipped covenants promote to info badges. Render does NOT recompute scenario
  // outcomes - the producer's scenarios[] is the truth source.
  const stress: RenderedStressSection = {
    method: stressOutputs.method,
    scenarios: stressOutputs.scenarios.map((s): RenderedStressScenario => ({
      name: s.name,
      // FIX 1 — unit-aware stress rows: noi/value are dollars, dscr is ×, ltv/dy are %.
      noi: { value: s.noi, displayValue: fmtDollarsFull(s.noi) },
      dscr: { value: s.dscr, displayValue: fmtDscr(s.dscr) },
      value: { value: s.value, displayValue: fmtDollarsFull(s.value) },
      ltv: { value: s.ltv, displayValue: fmtRate1(s.ltv) },
      debtYield: { value: s.debtYield, displayValue: fmtRate1(s.debtYield) },
      breaches: s.breaches.map((b): RenderBadge => badgeFromFlag(b, 'warning')),
      skipped: s.skipped.map((b): RenderBadge => badgeFromFlag(b, 'info')),
    })),
  };

  // 7.0 D21 - loan-terms projection. Named-field struct (NOT array iteration) preserves
  // the distinct semantic identity of each loan attribute. Bijective passthrough only;
  // render does NOT recompute debtServiceAnnual from rate+term+amort, NOR maturityBalance
  // from amortization tables - both are producer-emitted (the judgment-engine line-item
  // builders compute them upstream). Render passes them through unchanged.
  const loan: RenderedLoanSection = {
    loanAmount:         projectLineItem('loanAmount',         adjustedInputs.loan.loanAmount),
    interestRate:       projectLineItem('interestRate',       adjustedInputs.loan.interestRate),
    termMonths:         projectLineItem('termMonths',         adjustedInputs.loan.termMonths),
    amortizationMonths: projectLineItem('amortizationMonths', adjustedInputs.loan.amortizationMonths),
    ioPeriodMonths:     projectLineItem('ioPeriodMonths',     adjustedInputs.loan.ioPeriodMonths),
    maturityBalance:    projectLineItem('maturityBalance',    adjustedInputs.loan.maturityBalance),
    debtServiceAnnual:  projectLineItem('debtServiceAnnual',  adjustedInputs.loan.debtServiceAnnual),
  };

  // 7.3 #24 — assumptions projection. Named-field struct mirroring AdjustedInputs.assumptions.
  // Bijective passthrough via projectLineItem. All non-null fields carry 0..1 decimal values.
  // Backend-editable via POST /:id/revisions (assumptions.*.adjusted whitelisted in
  // apply-revision-delta.ts); frontend edit affordances live in uw-edit-utils.ts.
  // concludedCapRate is analyst-input-only (no engine builder per §14.3 Delta S);
  // null until set, RenderedLineItem when set (analyst-input via revision-delta).
  const assumptions: RenderedAssumptionsSection = {
    capRate:          projectLineItem('capRate',          adjustedInputs.assumptions.capRate),
    terminalCapRate:  projectLineItem('terminalCapRate',  adjustedInputs.assumptions.terminalCapRate),
    concludedCapRate: adjustedInputs.assumptions.concludedCapRate === null
      ? null
      : projectLineItem('concludedCapRate', adjustedInputs.assumptions.concludedCapRate),
    rentGrowthPct:    projectLineItem('rentGrowthPct',    adjustedInputs.assumptions.rentGrowthPct),
    expenseGrowthPct: projectLineItem('expenseGrowthPct', adjustedInputs.assumptions.expenseGrowthPct),
  };

  // 6.8 D09 — per-component score breakdown. Bijective passthrough of
  // DoctrineEvaluation.componentScores: numeric fields wrapped in RenderCell with
  // sentinel-applied displayValue, reason codes promoted to RenderBadge[]. No
  // re-derivation; the server has already computed score / weight / contribution.
  const components: readonly RenderedComponentScore[] = doctrineEvaluation.componentScores.map(
    (c): RenderedComponentScore => ({
      name: c.componentId,
      ruleId: c.ruleId,
      // FIX 1 — score-plane cells to a clean 2dp (kills the raw-float tail).
      // rawValue is "the underlying metric the rule scored" — heterogeneous
      // unit with no typed unit on the record, so 2dp plain (unit-neutral) is
      // the honest choice; score/weight/contribution are 0..1 score-plane.
      rawValue: { value: c.rawValue, displayValue: fmtScore(c.rawValue) },
      score: { value: c.score, displayValue: fmtScore(c.score) },
      weight: { value: c.weight, displayValue: fmtScore(c.weight) },
      contribution: { value: c.contribution, displayValue: fmtScore(c.contribution) },
      reasonCodes: c.reasonCodes.map((code): RenderBadge => badgeFromFlag(code, 'info')),
    }),
  );

  const body = {
    rootId,

    summary: {
      ratingBand: {
        value: doctrineEvaluation.ratingBand,
        // v7.12 — provisional suffix when inputs are unvalidated.
        // v7.15 — coverage suffix: gated > capped > none. Gate is the
        // stronger signal (engine abstains entirely), so it wins precedence
        // when both fire. RenderCell.value stays the raw RatingBand
        // (preserves the machine/human split — analytics + regression tests
        // read .value, UI reads .displayValue).
        displayValue: (() => {
          const base = applyStringSentinel(doctrineEvaluation.ratingBand);
          if (doctrineEvaluation.coverage.insufficientCoverageGate) {
            return base + ' (insufficient coverage)';
          }
          if (doctrineEvaluation.coverage.bandCapApplied) {
            const n = doctrineEvaluation.coverage.excludedRiskDimRuleIds.length;
            return base + ` (capped — ${n} risk dimension${n === 1 ? '' : 's'} unevaluated)`;
          }
          if (adjustedInputs.dataConfidence === 'unvalidated') {
            return base + ' (provisional)';
          }
          return base;
        })(),
      },
      finalScore: {
        value: doctrineEvaluation.finalScore,
        // FIX 1 — clean 2dp (was raw float e.g. 35.0999999999999).
        displayValue: fmtScore(doctrineEvaluation.finalScore),
      },
      // v7.14 — data-confidence axis (3-way). Passthrough of AdjustedInputs.dataConfidence
      // with a Capitalized display label. Explicit map (NOT binary ternary) so the new
      // 'low_confidence' tier from v1.9 doesn't silently bucket into 'Validated'. UI banner
      // + caveat conditions key off .value (the typed literal); display is the human form.
      dataConfidence: {
        value: adjustedInputs.dataConfidence,
        displayValue:
          adjustedInputs.dataConfidence === 'unvalidated'    ? 'Unvalidated'
          : adjustedInputs.dataConfidence === 'low_confidence' ? 'Low confidence'
          : 'Validated',
      },
      // v7.13 — NOI divergence axis. Structured read of the producer-side
      // NoiDivergenceFacts persisted on AdjustedMetrics (see
      // `packages/contracts/src/adjusted-inputs.ts` `noiDivergence` field).
      // The computation + threshold live in the judgment engine; render is
      // pure shape transform + caveat string. `?? null` tolerates stored
      // AdjustedInputs bodies that predate the field.
      noiDivergence: (() => {
        const d = adjustedInputs.metrics.noiDivergence ?? null;
        if (d === null) return null;
        const status: 'flagged' | 'within_band' = d.flagged ? 'flagged' : 'within_band';
        const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
        const pct = (d.shortfallPct * 100).toFixed(1);
        const caveat = d.flagged
          ? `Concluded NOI ${usd(d.derivedNoi)} is ${pct}% below the trailing-12 actual of ${usd(d.referenceNoi)} — review the conservatism floors and recovery assumptions before relying on the recommendation.`
          : '';
        return {
          status: { value: status, displayValue: status === 'flagged' ? 'Flagged' : 'Within band' },
          // FIX 1 — NOIs are dollars, shortfall is a %.
          derivedNoi:   { value: d.derivedNoi,   displayValue: fmtDollarsFull(d.derivedNoi) },
          referenceNoi: { value: d.referenceNoi, displayValue: fmtDollarsFull(d.referenceNoi) },
          shortfallPct: { value: d.shortfallPct, displayValue: fmtRate1(d.shortfallPct) },
          caveat:       { value: caveat,         displayValue: caveat },
        };
      })(),
      // v7.15 — doctrine coverage axis. Surfaces engine v1.3 cap + v1.1
      // coverage-floor gate so the UI can show WHAT wasn't assessed and
      // distinguish data-limitation from credit-verdict. Echoes the
      // low_confidence framing ("documentation depth, not credit quality").
      coverage: (() => {
        const cov = doctrineEvaluation.coverage;
        const labelMap: Record<string, string> = {
          UW_VS_T12_NOI_RECONCILIATION: 'UW-vs-trailing validation',
          TENANT_CONCENTRATION: 'tenant concentration',
          ROLLOVER_WITHIN_TERM: 'rollover',
          TI_LC_VS_ROLLOVER: 'TI/LC sizing',
        };
        const excludedLabels = cov.excludedRiskDimRuleIds.map(rid => labelMap[rid] ?? rid);
        const listForCopy = excludedLabels.length === 0
          ? ''
          : excludedLabels.length === 1
            ? excludedLabels[0]
            : excludedLabels.length === 2
              ? excludedLabels.join(' and ')
              : excludedLabels.slice(0, -1).join(', ') + ', and ' + excludedLabels[excludedLabels.length - 1];
        const bannerCopy = cov.insufficientCoverageGate
          ? `Insufficient coverage to score — only ${(cov.evaluatedPct * 100).toFixed(0)}% of the doctrine weight was evaluable from the supplied documents. The band reflects documentation depth, not a credit assessment.`
          : cov.bandCapApplied
            ? `Rated without ${listForCopy} — risk dimension${excludedLabels.length === 1 ? '' : 's'} that couldn't be evaluated from the supplied documents. The band is capped accordingly and reflects documentation depth, not a complete credit assessment.`
            : '';
        return {
          evaluatedPct: { value: cov.evaluatedPct, displayValue: fmtRate1(cov.evaluatedPct) },
          bandCapApplied: { value: cov.bandCapApplied, displayValue: cov.bandCapApplied ? 'Yes' : 'No' },
          insufficientCoverageGate: { value: cov.insufficientCoverageGate, displayValue: cov.insufficientCoverageGate ? 'Yes' : 'No' },
          excludedRiskDimLabels: excludedLabels,
          bannerCopy: { value: bannerCopy, displayValue: bannerCopy },
        };
      })(),
    },

    metrics: {
      // FIX 1 — headline metrics: DSCR ×, LTV/DY 1dp %, NOI full-comma dollars.
      dscr: {
        value: adjustedInputs.metrics.dscr,
        displayValue: fmtDscr(adjustedInputs.metrics.dscr),
      },
      ltv: {
        value: adjustedInputs.metrics.ltvAppraisal,
        displayValue: fmtRate1(adjustedInputs.metrics.ltvAppraisal),
      },
      debtYield: {
        value: adjustedInputs.metrics.debtYield,
        displayValue: fmtRate1(adjustedInputs.metrics.debtYield),
      },
      noi: {
        value: adjustedInputs.metrics.noi,
        displayValue: fmtDollarsFull(adjustedInputs.metrics.noi),
      },
      // Option C — workbook NOI-basis disclosure callout. Null when the
      // resolver decided shouldRender=false (stabilized deals, no
      // divergence) so the workbook renders byte-identical to pre-Option-C.
      noiBasisCallout: projectNoiBasisCallout(noiBasis),
    },

    valuation: {
      finalValue: {
        value: valuationConclusion.finalValue,
        // FIX 1 — headline "Value" rail + Valuation tab: compact form ($112.5M).
        displayValue: fmtDollarsCompact(valuationConclusion.finalValue),
      },
      anchorUsed: {
        value: valuationConclusion.anchorUsed,
        displayValue: applyStringSentinel(valuationConclusion.anchorUsed),
      },
    },

    doctrine: {
      // FIX 1 — score-plane 2dp (mechanical + weighted aggregate ~45.10).
      mechanicalScore: {
        value: doctrineEvaluation.mechanicalScore,
        displayValue: fmtScore(doctrineEvaluation.mechanicalScore),
      },
      weightedAggregate: {
        value: doctrineEvaluation.weightedAggregate,
        displayValue: fmtScore(doctrineEvaluation.weightedAggregate),
      },
      flags: doctrineFlags,
      components,
    },

    dataQuality: {
      flags: dataQualityBadges,
    },

    incomeLines,
    expenseLines,
    loan,
    assumptions,
    stress,
    findings,
    narrative: renderNarrativeSection(narrative),

    // 7.10 (mitigations doctrine v1, commit 2d). Project the persisted
    // MitigationProposalSet (fetched by the materializer alongside the
    // narrative). Empty array when no set was found (engine version mismatch
    // / pre-2c deals) — UI hides the section. RENDER_VERSION bumped 7.9 → 7.10
    // to invalidate cache rows that pre-date this projection.
    mitigations: projectMitigations(mitigationSet),

    metadata: {
      hashedAt: doctrineEvaluation.analysisAsOfDate,
      renderVersion: RENDER_VERSION,
    },
  };

  return { id: computeRenderedAnalysisId(body), ...body };
}

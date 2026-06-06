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
  applyNumericSentinel,
  applyStringSentinel,
  badgeFromFlag,
  NULL_SENTINEL,
} from './render-sentinels.js';
import { computeRenderedAnalysisId } from '../util/content-hash.js';
import { checkNoiDivergence } from './judgment/noi-divergence.js';

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

// 6.9 D16/D17 helper - bijective passthrough of one AdjustedLineItem.
// NOT a derivation: every numeric value is read directly from the producer's record;
// the adjustments ledger is mapped 1:1 from AdjustmentEntry to RenderedAdjustment.
function projectLineItem(name: string, item: AdjustedLineItem): RenderedLineItem {
  return {
    name,
    raw: { value: item.raw, displayValue: applyNumericSentinel(item.raw) },
    adjusted: { value: item.adjusted, displayValue: applyNumericSentinel(item.adjusted) },
    source: item.source,
    adjustments: item.adjustments.map((a): RenderedAdjustment => ({
      ruleId: a.ruleId,
      delta: { value: a.delta, displayValue: applyNumericSentinel(a.delta) },
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

function fmtDscr(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return n.toFixed(2) + 'x';
}

function fmtRate(n: number | null): string {
  if (n === null) return NULL_SENTINEL;
  return (n * 100).toFixed(2) + '%';
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

export function renderUnderwritingContext(
  ctx: UnderwritingContext,
  narrative: NarrativeEvaluation | null = null,
  mitigationSet: MitigationProposalSet | null = null,
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
      noi: { value: s.noi, displayValue: applyNumericSentinel(s.noi) },
      dscr: { value: s.dscr, displayValue: applyNumericSentinel(s.dscr) },
      value: { value: s.value, displayValue: applyNumericSentinel(s.value) },
      ltv: { value: s.ltv, displayValue: applyNumericSentinel(s.ltv) },
      debtYield: { value: s.debtYield, displayValue: applyNumericSentinel(s.debtYield) },
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
      rawValue: { value: c.rawValue, displayValue: applyNumericSentinel(c.rawValue) },
      score: { value: c.score, displayValue: applyNumericSentinel(c.score) },
      weight: { value: c.weight, displayValue: applyNumericSentinel(c.weight) },
      contribution: { value: c.contribution, displayValue: applyNumericSentinel(c.contribution) },
      reasonCodes: c.reasonCodes.map((code): RenderBadge => badgeFromFlag(code, 'info')),
    }),
  );

  const body = {
    rootId,

    summary: {
      ratingBand: {
        value: doctrineEvaluation.ratingBand,
        // v7.12 — server-emit the "(provisional)" suffix on display only when
        // inputs are unvalidated. RenderCell.value stays the raw RatingBand
        // (preserves the machine/human split — analytics + regression tests
        // read .value, UI reads .displayValue).
        displayValue: adjustedInputs.dataConfidence === 'unvalidated'
          ? applyStringSentinel(doctrineEvaluation.ratingBand) + ' (provisional)'
          : applyStringSentinel(doctrineEvaluation.ratingBand),
      },
      finalScore: {
        value: doctrineEvaluation.finalScore,
        displayValue: applyNumericSentinel(doctrineEvaluation.finalScore),
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
      // v7.13 — NOI divergence axis. Re-derived via the same helper the
      // judgment engine uses (single source of truth for the 0.20 threshold).
      // Null when no reference NOI is available (t12Actual absent on this
      // deal). Server-builds the caveat displayValue so the UI does not
      // need to compose prose.
      noiDivergence: (() => {
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
        };
      })(),
    },

    metrics: {
      dscr: {
        value: adjustedInputs.metrics.dscr,
        displayValue: applyNumericSentinel(adjustedInputs.metrics.dscr),
      },
      ltv: {
        value: adjustedInputs.metrics.ltvAppraisal,
        displayValue: applyNumericSentinel(adjustedInputs.metrics.ltvAppraisal),
      },
      debtYield: {
        value: adjustedInputs.metrics.debtYield,
        displayValue: applyNumericSentinel(adjustedInputs.metrics.debtYield),
      },
      noi: {
        value: adjustedInputs.metrics.noi,
        displayValue: applyNumericSentinel(adjustedInputs.metrics.noi),
      },
    },

    valuation: {
      finalValue: {
        value: valuationConclusion.finalValue,
        displayValue: applyNumericSentinel(valuationConclusion.finalValue),
      },
      anchorUsed: {
        value: valuationConclusion.anchorUsed,
        displayValue: applyStringSentinel(valuationConclusion.anchorUsed),
      },
    },

    doctrine: {
      mechanicalScore: {
        value: doctrineEvaluation.mechanicalScore,
        displayValue: applyNumericSentinel(doctrineEvaluation.mechanicalScore),
      },
      weightedAggregate: {
        value: doctrineEvaluation.weightedAggregate,
        displayValue: applyNumericSentinel(doctrineEvaluation.weightedAggregate),
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

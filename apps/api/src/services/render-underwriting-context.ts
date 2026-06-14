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
          derivedNoi:   { value: d.derivedNoi,   displayValue: applyNumericSentinel(d.derivedNoi) },
          referenceNoi: { value: d.referenceNoi, displayValue: applyNumericSentinel(d.referenceNoi) },
          shortfallPct: { value: d.shortfallPct, displayValue: applyNumericSentinel(d.shortfallPct) },
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
          evaluatedPct: { value: cov.evaluatedPct, displayValue: applyNumericSentinel(cov.evaluatedPct) },
          bandCapApplied: { value: cov.bandCapApplied, displayValue: cov.bandCapApplied ? 'Yes' : 'No' },
          insufficientCoverageGate: { value: cov.insufficientCoverageGate, displayValue: cov.insufficientCoverageGate ? 'Yes' : 'No' },
          excludedRiskDimLabels: excludedLabels,
          bannerCopy: { value: bannerCopy, displayValue: bannerCopy },
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

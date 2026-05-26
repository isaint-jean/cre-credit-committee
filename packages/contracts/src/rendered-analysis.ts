// RenderedAnalysis (Batch 6.7) - Stage 13 read-pole output.
//
// Section-keyed, content-hashed render of an UnderwritingContext. This is where
// missing-data explanation, sentinel display, and human-readable formatting live.
// Per the locked semantics model: the read-pole. Everything below is interpretation
// for presentation; nothing here mutates upstream state or recomputes producer outputs.

import type { DoctrineEvaluationId, RenderedAnalysisId } from './identity.js';
import type { ISODateTime } from './versioning.js';
import type { RatingBand } from './doctrine/components.js';
import type { ValuationAnchor } from './valuation.js';

export const RENDER_VERSION = '7.3' as const;
export type RenderVersion = typeof RENDER_VERSION;

// A cell carries the raw value (or null for missing data) plus a display string with
// the sentinel applied. Render-side consumers read displayValue; analytics / regression
// tests read value.
export interface RenderCell<T> {
  readonly value: T | null;
  readonly displayValue: string;
}

// A badge surfaces a typed flag (data-quality, valuation, doctrine) for UI display.
// Severity drives styling on the consumer side.
export type RenderBadgeSeverity = 'info' | 'warning' | 'critical';

export interface RenderBadge {
  readonly code: string;
  readonly label: string;
  readonly severity: RenderBadgeSeverity;
}

export interface RenderedAnalysisMetadata {
  readonly hashedAt: ISODateTime;       // passthrough from doctrine.analysisAsOfDate
  readonly renderVersion: RenderVersion;
}

// Per-line-item adjustment ledger entry, projected from AdjustmentEntry on the
// AdjustedInputs producer record. Bijective passthrough: ruleId + reason as strings,
// delta as a sentinel-wrapped numeric cell. NO re-derivation; the producer has already
// computed the signed delta against the raw value.
export interface RenderedAdjustment {
  readonly ruleId: string;                        // JudgmentEngineRuleId | CreditManifestoRuleId
  readonly delta: RenderCell<number>;             // signed effect on `adjusted` relative to `raw`
  readonly reason: string;                        // bounded by per-registry reason catalogue
}

// Per-line-item projection (added in render version 6.9 for D16/D17 parity).
// Bijective passthrough of one AdjustedLineItem from AdjustedInputs.income / .expenses.
// Numeric values wrapped in RenderCell so the UI prints the server's displayValue;
// adjustments[] surfaces the producer's computed delta ledger so the UI can show
// "raw + adjustments = adjusted" as data, NOT as derivation. Render must NOT recompute
// adjusted from raw + sum-of-deltas.
export interface RenderedLineItem {
  readonly name: string;                          // section key, e.g., 'grossRentalIncome'
  readonly raw: RenderCell<number>;               // pre-judgment producer value (may be null)
  readonly adjusted: RenderCell<number>;          // post-judgment value (always numeric)
  readonly source: string;                        // SourceTier passthrough ('BANK', 'LIBRARY', ...)
  readonly adjustments: readonly RenderedAdjustment[];
}

// Findings projection (added in render version 7.2 for D04 parity).
//
// Bijective passthrough of one entry from DoctrineEvaluation.reasons[] - the doctrine's
// 10g bounded-explainability projection (architecture: "NO free text"). Each producer
// finding is exactly two typed enum strings: ruleId (DoctrineRuleId) + reasonCode
// (DoctrineReasonCode). Render preserves both exactly.
//
// EXPLICIT NON-FIELDS (semantic-fidelity discipline, locked at 7.2):
//   - NO severity. The producer does not emit per-finding severity, and render must
//     not synthesize one. Severity-tagged display is a producer-spine question, not a
//     render question. If/when the doctrine adds severity to reasons in a future
//     producer version, RenderedFinding can be extended additively.
//   - NO rationale free text. Architecture forbids free text in doctrine outputs;
//     render must not invent narrative text.
//   - NO derived priority / ranking. Order is preserved exactly from producer output.
//   - NO collapsing or deduplication. Each producer finding becomes exactly one
//     rendered finding.
export interface RenderedFinding {
  readonly ruleId: string;        // DoctrineRuleId, passthrough
  readonly reasonCode: string;    // DoctrineReasonCode, passthrough
}

// Stress-scenario projection (added in render version 7.1 for D20 parity).
// Bijective passthrough of one StressScenarioOutput from StressOutputs.scenarios[].
// Numeric metrics wrapped in RenderCell so the UI prints the server's displayValue;
// breach codes promoted to warning badges; skipped codes (covenant skipped because
// input was null) promoted to info badges. Render does NOT recompute scenario
// pass/fail outcomes - the producer's `breaches[]` is the truth source.
export interface RenderedStressScenario {
  readonly name: string;                          // 'Remove_T1_T2', 'Occ_down_10', etc. (passthrough)
  readonly noi: RenderCell<number>;
  readonly dscr: RenderCell<number>;
  readonly value: RenderCell<number>;
  readonly ltv: RenderCell<number>;
  readonly debtYield: RenderCell<number>;
  readonly breaches: readonly RenderBadge[];      // StressBreach codes -> warning badges
  readonly skipped: readonly RenderBadge[];       // skipped covenants -> info badges
}

// Stress-section projection (added in render version 7.1 for D20 parity).
// Mirrors StressOutputs's `method` + `scenarios[]` shape. The method is a passthrough
// of StressMethod ('DEFAULT' | 'TENANT_REMOVAL' | 'OCC_RENT_CONCESSION'); render does
// NOT pick a different method based on display-time inputs.
export interface RenderedStressSection {
  readonly method: string;                        // StressMethod passthrough
  readonly scenarios: readonly RenderedStressScenario[];
}

// Loan-terms projection (added in render version 7.0 for D21 parity). Named-field
// structure that mirrors AdjustedInputs.loan, NOT an array - loan fields have distinct
// semantic meaning per name (loanAmount vs interestRate vs termMonths) so the contract
// preserves the named structure. Each field is a RenderedLineItem (raw / adjusted /
// source / adjustments) following the D16/D17 pattern. Bijective passthrough; render
// must NOT recompute debtServiceAnnual or maturityBalance from the other fields - the
// producer's value is the truth source.
export interface RenderedLoanSection {
  readonly loanAmount: RenderedLineItem;
  readonly interestRate: RenderedLineItem;        // annualized fraction 0..1
  readonly termMonths: RenderedLineItem;
  readonly amortizationMonths: RenderedLineItem;
  readonly ioPeriodMonths: RenderedLineItem;
  readonly maturityBalance: RenderedLineItem;     // producer-emitted; render does NOT amortize
  readonly debtServiceAnnual: RenderedLineItem;   // producer-emitted; render does NOT compute payment
}

// Assumptions projection (added in render version 7.3 for #24). Named-field
// structure mirroring AdjustedInputs.assumptions, NOT an array - assumption fields
// have distinct semantic identities (capRate vs terminalCapRate vs growth rates) so
// the contract preserves the named structure. Each field is a RenderedLineItem
// following the D16/D17/D21 pattern. Bijective passthrough. All four fields carry
// 0..1 decimal values per backend convention (matches loan.interestRate).
export interface RenderedAssumptionsSection {
  readonly capRate: RenderedLineItem;              // entry/going-in; 0..1 decimal
  readonly terminalCapRate: RenderedLineItem;      // 0..1 decimal
  readonly rentGrowthPct: RenderedLineItem;        // 0..1 decimal
  readonly expenseGrowthPct: RenderedLineItem;     // 0..1 decimal
}

// Per-component scoring projection (added in render version 6.8 for D09 parity).
// Bijective passthrough of DoctrineEvaluation.componentScores[i]: same field names
// (renamed `componentId` -> `name` for display friendliness), numeric values wrapped
// in RenderCell so the UI prints the server's displayValue, reasonCodes promoted to
// RenderBadge[] for typed badge display. NO re-derivation; all source values pass
// through unchanged.
export interface RenderedComponentScore {
  readonly name: string;                          // componentId from DoctrineComponentScore
  readonly ruleId: string;                        // DoctrineRuleId
  readonly rawValue: RenderCell<number>;          // underlying metric the rule scored (may be null)
  readonly score: RenderCell<number>;             // 0..100
  readonly weight: RenderCell<number>;            // declared weight from doctrine YAML
  readonly contribution: RenderCell<number>;      // score * weight / 100, computed by producer
  readonly reasonCodes: readonly RenderBadge[];   // typed reason codes promoted to badges
}

export interface RenderedAnalysis {
  readonly id: RenderedAnalysisId;
  readonly rootId: DoctrineEvaluationId;

  readonly summary: {
    readonly ratingBand: RenderCell<RatingBand>;
    readonly finalScore: RenderCell<number>;
  };

  readonly metrics: {
    readonly dscr: RenderCell<number>;
    readonly ltv: RenderCell<number>;
    readonly debtYield: RenderCell<number>;
    readonly noi: RenderCell<number>;
  };

  readonly valuation: {
    readonly finalValue: RenderCell<number>;
    readonly anchorUsed: RenderCell<ValuationAnchor>;
  };

  readonly doctrine: {
    readonly mechanicalScore: RenderCell<number>;
    readonly weightedAggregate: RenderCell<number>;
    readonly flags: readonly RenderBadge[];
    // 6.8 (D09): per-category breakdown projected from DoctrineEvaluation.componentScores.
    // Each entry is a RenderedComponentScore - bijective passthrough of the producer's
    // typed component score with numeric values sentinel-wrapped and reason codes promoted
    // to badges. The UI consumes this as the credit-score breakdown table.
    readonly components: readonly RenderedComponentScore[];
  };

  readonly dataQuality: {
    readonly flags: readonly RenderBadge[];
  };

  // 6.9 (D16): per-line-item income breakdown projected from AdjustedInputs.income.
  // Each entry is a RenderedLineItem - bijective passthrough of the producer's
  // typed line item with numeric values sentinel-wrapped and adjustments ledger
  // promoted to RenderedAdjustment[]. The UI consumes this as the income table.
  readonly incomeLines: readonly RenderedLineItem[];

  // 6.9 (D17): per-line-item expense breakdown projected from AdjustedInputs.expenses.
  // Same shape as incomeLines; consumed as the expense table.
  readonly expenseLines: readonly RenderedLineItem[];

  // 7.0 (D21): loan-terms projection from AdjustedInputs.loan. Named-field struct
  // (not array) - loan fields have distinct semantic identities. Each field is a
  // RenderedLineItem.
  readonly loan: RenderedLoanSection;

  // 7.3 (#24): assumptions projection from AdjustedInputs.assumptions. Named-field
  // struct mirroring the upstream contract. 4 fields × RenderedLineItem. All four
  // carry 0..1 decimal values. Backend-editable via POST /:id/revisions; the
  // frontend exposes edit affordances via the EDITABLE_PATHS whitelist in
  // uw-edit-utils.ts.
  readonly assumptions: RenderedAssumptionsSection;

  // 7.1 (D20): stress projection from StressOutputs. Producer-emitted scenarios pass
  // through unchanged; render does NOT recompute scenario outcomes or breach states.
  readonly stress: RenderedStressSection;

  // 7.2 (D04): findings projection from DoctrineEvaluation.reasons[]. Bijective passthrough
  // of producer-owned explanatory semantics. Each entry preserves ruleId + reasonCode
  // exactly; ordering is preserved exactly; render synthesizes nothing. See
  // RenderedFinding for the full discipline spec.
  readonly findings: readonly RenderedFinding[];

  readonly metadata: RenderedAnalysisMetadata;
}

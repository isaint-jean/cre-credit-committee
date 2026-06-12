/**
 * Lever calibration harness — dim-9 require_guaranty, no lever-code changes.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-lever-dim9-require-guaranty.ts
 *
 * What this does:
 *   - PART 1 — THREADED ASSESSMENT SWEEP: builds synthetic SponsorAssessments
 *     so dim 9 RESOLVES across the natural modifier points (same trick as
 *     calibration-mitigant-v2-phase2-guaranty.ts). Sweeps modifier from 0.00
 *     → +0.20 plus the disqualifying-event override. Shows tier transition
 *     points + the per-tier recourse package from DEFAULT_GUARANTY_TIER_TERMS.
 *   - PART 2 — BOUNDARY ZOOM: dim 9's symmetric weights move in 0.05
 *     increments (factor-4 in 0.10 / 0.20 increments), so the natural
 *     assessment-driven sweep can't land EXACTLY on the lever's 0.03 / 0.10
 *     / 0.18 step boundaries. Part 2 synthesizes the dim 9 contribution
 *     directly (cast-injection) at modifier = 0.029 / 0.030 / 0.031 / 0.099
 *     / 0.100 / 0.101 / 0.179 / 0.180 / 0.181 to nail the step-function
 *     transitions. Fence: still reads ONLY dealResult.dimensions
 *     .sponsorBorrowerQuality — the lever doesn't notice the synthesis.
 *   - PART 3 — DISQUALIFYING EVENT: factor-4 Severe forces the
 *     'disqualifying-event' tier-key regardless of net modifier magnitude.
 *
 * What the lever should do (POST-PARAMETERIZATION):
 *   - 3 modifier-breakpoint knobs (stay near the lever, doctrine-adjacent):
 *       GUARANTY_TRIGGER_THRESHOLD = 0.03   (fire when modifier > 0.03)
 *       GUARANTY_MODERATE_THRESHOLD = 0.10  (moderate tier begins)
 *       GUARANTY_SEVERE_THRESHOLD  = 0.18   (severe tier begins)
 *   - DEFAULT_GUARANTY_TIER_TERMS (desk-owned numeric recourse package):
 *       mild                  recourse 25% / NW 1.0× / liq 5%  / burn-off 3yr
 *       moderate              recourse 50% / NW 1.5× / liq 5%  / burn-off 5yr
 *       severe                recourse 75% / NW 2.0× / liq 10% / no burn-off
 *       disqualifying-event   recourse 100% / NW 2.0× / liq 10% / no burn-off
 *
 *   Provenance: operator-judgment, NOT employer-derived.
 *
 * Isabelle re-sets the per-tier values after seeing the table.
 */
import { fileURLToPath } from 'node:url';
import {
  evaluateDeal,
  type DealBag,
} from '../doctrine-clean/index.js';
import type {
  SponsorAssessment,
} from '../doctrine-clean/dimensions/sponsor-borrower-quality.js';
import {
  buildGuarantyProposal,
  DEFAULT_GUARANTY_TIER_TERMS,
  type GuarantyTierKey,
  type GuarantyTierTerms,
} from '../services/mitigation/produce-mitigations.js';
import type { EvaluateDealResult } from '../doctrine-clean/scoring/evaluate-deal.js';
import type { DimensionContribution } from '../doctrine-clean/types.js';

/* --------------- inputs pinned to a Sunroad-shaped DealBag ---------------- */
/* The asset / cashflow side of the DealBag does not affect dim 9 — only the
 * sponsor assessment does. We pin a clean profile so the OTHER dims (and
 * therefore the OTHER levers) don't fire, isolating require_guaranty. */

const SUNROAD_BAG: DealBag = {
  propertyName: 'Sunroad Centrum (synthetic resolution)',
  assetType: 'Office',
  subType: 'CBD',
  loanAmount: 60_000_000,           // small enough that the LTV / DSCR / DY arms stay safe
  coupon: 0.079,
  concludedValue: 126_200_362,
  uwY1Noi: 10_172_319.74,
  t12Noi: null,
  underwrittenOccupancy: null,
  largestTenantPct: null,
  largestTenantBasis: 'base-rent',
  pctIncomeExpiringWithinTerm: null,
  tenantDataStatus: 'multi-tenant-parsed',
  amortMonths: 0,
  ioYears: 5,
  termYears: 5,
  marketTier: 'Unknown',
};

/* --------------- assessment builders for the threaded sweep --------------- */
/* Dim 9 weights (recap):
 *   SYMMETRIC: Strong -0.05 / Neutral 0 / Weak +0.05 / Severe +0.08
 *   FACTOR4_PRIOR_CREDIT_EVENTS: Strong -0.03 / Neutral 0 / Weak +0.10 / Severe +0.20
 * Factor-4 Severe is asymmetric — floors the modifier at +0.20 and sets the
 * dim-9 'disqualifying-event' tier independently of net magnitude.            */

function mkAssessment(opts: {
  experience?: SponsorAssessment['experience'];
  financialStrength?: SponsorAssessment['financialStrength'];
  alignment?: SponsorAssessment['alignment'];
  priorCreditEvents?: SponsorAssessment['priorCreditEvents'];
  managementQuality?: SponsorAssessment['managementQuality'];
}): SponsorAssessment {
  return {
    experience:          opts.experience          ?? 'Neutral',
    financialStrength:   opts.financialStrength   ?? 'Neutral',
    alignment:           opts.alignment           ?? 'Neutral',
    priorCreditEvents:   opts.priorCreditEvents   ?? 'Neutral',
    managementQuality:   opts.managementQuality   ?? 'Neutral',
  };
}

interface ThreadedRow {
  label: string;
  assessment: SponsorAssessment | null;   // null → HITL row (no fire expected)
  note: string;
}

const THREADED_SWEEP: readonly ThreadedRow[] = [
  { label: 'HITL (no assessment)',         assessment: null,                                                    note: 'dim 9 → hitl-needed; lever should NOT fire (coverage-gate domain)' },
  { label: 'all Strong',                   assessment: mkAssessment({ experience: 'Strong', financialStrength: 'Strong', alignment: 'Strong', managementQuality: 'Strong' /* factor-4 Neutral */ }), note: 'modifier ≈ -0.20 (risk-reducing); lever should NOT fire' },
  { label: 'all Neutral',                  assessment: mkAssessment({}),                                        note: 'modifier = 0.00; lever should NOT fire (≤ trigger 0.03)' },
  { label: '1 sym Weak (experience)',      assessment: mkAssessment({ experience: 'Weak' }),                    note: 'modifier = +0.05 → MILD (just past trigger 0.03)' },
  { label: 'factor-4 Weak only',           assessment: mkAssessment({ priorCreditEvents: 'Weak' }),             note: 'modifier = +0.10 → MODERATE (boundary)' },
  { label: 'factor-4 Weak + 1 sym Weak',   assessment: mkAssessment({ priorCreditEvents: 'Weak', experience: 'Weak' }), note: 'modifier = +0.15 → MODERATE (mid-range)' },
  { label: 'factor-4 Weak + 3 sym Weak',   assessment: mkAssessment({ priorCreditEvents: 'Weak', experience: 'Weak', financialStrength: 'Weak', alignment: 'Weak' }), note: 'raw = +0.25 → capped at +0.20 → SEVERE' },
  { label: 'factor-4 Severe (DQ)',         assessment: mkAssessment({ priorCreditEvents: 'Severe' }),           note: 'factor-4 asymmetry → SEVERE tier forced via disqualifying-event tier-key' },
];

/* -------- synthetic dim-9 contribution injection for exact boundaries ------ */
/* The lever only reads sponsorBorrowerQuality from dealResult; we can cast a
 * minimal partial-result around a hand-built DimensionContribution to hit
 * the exact step boundaries. This is harness-only — no lever code knows. */

function mkInjectedDealResult(modifier: number, disqualifying: boolean): EvaluateDealResult {
  const sponsorDim: DimensionContribution = {
    dimensionId: 'sponsor-borrower-quality',
    riskContribution: null,
    tier: disqualifying ? 'disqualifying-event' : (modifier <= -0.10 ? 'strong-sponsor' : modifier >= +0.10 ? 'weak-sponsor' : 'neutral'),
    rationale: '[harness-synthesized] direct riskModifier injection for boundary calibration',
    provenance: ['harness — not a real dim-9 evaluation'],
    applicability: 'applicable',
    evaluated: true,
    riskModifier: modifier,
    derivedOutputs: {
      factorContributionExperience: 0,
      factorContributionFinancialStrength: 0,
      factorContributionAlignment: 0,
      factorContributionPriorCreditEvents: disqualifying ? +0.20 : modifier,
      factorContributionManagementQuality: 0,
      modifierCap: 0.20,
    },
  };
  return {
    dimensions: { sponsorBorrowerQuality: sponsorDim } as any,
  } as unknown as EvaluateDealResult;
}

/* ------------------------------- formatting ------------------------------- */

function fmtPct0(n: number): string { return (n * 100).toFixed(0) + '%'; }
function fmtPct2(n: number): string { return (n * 100).toFixed(2) + '%'; }
function fmtBurnOff(b: number | null): string { return b === null ? 'none' : b.toFixed(0) + ' yr'; }

function pad(s: string, n: number): string { return String(s).padEnd(n); }

interface RowResult {
  fired: boolean;
  proposalId: string | null;
  tier: string | null;
  modifier: number | null;
  applicability: string | null;
  tierKey: GuarantyTierKey | null;
  terms: GuarantyTierTerms | null;
  severity: string | null;
  riskReduction: string | null;
}

function inspectProposal(dealResult: EvaluateDealResult): RowResult {
  const sponsorDim = dealResult.dimensions?.sponsorBorrowerQuality;
  const modifier = (sponsorDim?.riskModifier ?? null);
  const applicability = (sponsorDim?.applicability ?? null);
  const dimTier = (sponsorDim?.tier ?? null);
  const prop = buildGuarantyProposal(dealResult, DEFAULT_GUARANTY_TIER_TERMS);
  if (prop === null) {
    return { fired: false, proposalId: null, tier: null, modifier, applicability, tierKey: null, terms: null, severity: null, riskReduction: null };
  }
  // Derive tierKey from the proposal id + dim tier.
  // proposal id is 'guaranty_sponsor_{mild|moderate|severe}'; the DQ case
  // is severe with dim tier === 'disqualifying-event'.
  const idTier = prop.id?.replace(/^guaranty_sponsor_/, '') ?? null;
  const tierKey: GuarantyTierKey =
    dimTier === 'disqualifying-event' ? 'disqualifying-event'
    : (idTier as GuarantyTierKey);
  return {
    fired: true,
    proposalId: prop.id ?? null,
    tier: idTier,
    modifier,
    applicability,
    tierKey,
    terms: DEFAULT_GUARANTY_TIER_TERMS[tierKey],
    severity: (prop as any).severity ?? null,
    riskReduction: (prop as any).riskReduction ?? null,
  };
}

function formatRow(label: string, r: RowResult): string {
  const modStr = r.modifier !== null ? r.modifier.toFixed(3) : 'null';
  const tierKeyStr = r.tierKey ?? '—';
  const recourse = r.terms ? fmtPct0(r.terms.recoursePct) : '—';
  const nw = r.terms ? r.terms.netWorthMultiple.toFixed(1) + '×' : '—';
  const liq = r.terms ? fmtPct0(r.terms.liquidityPct) : '—';
  const burn = r.terms ? fmtBurnOff(r.terms.burnOffYears) : '—';
  const sev = r.severity ?? '—';
  return [
    pad(label, 36),
    pad(modStr, 10),
    pad(r.fired ? 'YES' : 'no', 8),
    pad(tierKeyStr, 22),
    pad(recourse, 12),
    pad(nw, 10),
    pad(liq, 10),
    pad(burn, 12),
    pad(sev, 10),
  ].join('');
}

function header(): string {
  return [
    pad('row', 36),
    pad('modifier', 10),
    pad('fired?', 8),
    pad('tierKey', 22),
    pad('recoursePct', 12),
    pad('NW mult', 10),
    pad('liq %', 10),
    pad('burn-off', 12),
    pad('severity', 10),
  ].join('');
}

function rule(): string { return '─'.repeat(120); }

function main(): void {
  console.log('================================================================');
  console.log('LEVER CALIBRATION — dim-9 require_guaranty');
  console.log('  GUARANTY_TIER_TERMS (desk knobs; operator-judgment defaults)');
  console.log('================================================================');
  console.log('');
  console.log('DEFAULT_GUARANTY_TIER_TERMS:');
  for (const k of ['mild', 'moderate', 'severe', 'disqualifying-event'] as GuarantyTierKey[]) {
    const t = DEFAULT_GUARANTY_TIER_TERMS[k];
    console.log(`  ${pad(k, 22)} recoursePct ${fmtPct0(t.recoursePct)}   NW ${t.netWorthMultiple.toFixed(1)}× loan   liq ${fmtPct0(t.liquidityPct)} of loan   burn-off ${fmtBurnOff(t.burnOffYears)}`);
  }
  console.log('');
  console.log('Modifier breakpoints (doctrine-adjacent, lever-local):');
  console.log('  GUARANTY_TRIGGER_THRESHOLD   = 0.03  (fire when modifier > 0.03)');
  console.log('  GUARANTY_MODERATE_THRESHOLD  = 0.10  (moderate tier begins)');
  console.log('  GUARANTY_SEVERE_THRESHOLD    = 0.18  (severe tier begins; just below +0.20 cap)');
  console.log('');
  console.log('Boilerplate (NOT calibrated; structural-term scaffolding):');
  console.log('  - Bad-boy carve-outs (fraud / misrepresentation / bankruptcy filing)');
  console.log('  - Springing-recourse provisions on deal underperformance (severe tier)');
  console.log('  - LTV / DSCR step-down tests as burn-off preconditions');
  console.log('');

  /* ====================== PART 1 — THREADED ASSESSMENTS ===================== */
  console.log('================================================================');
  console.log('PART 1 — THREADED SponsorAssessment SWEEP');
  console.log('  Builds synthetic assessments so evaluateDeal resolves dim 9 naturally.');
  console.log('  Symmetric weights step in ±0.05; factor-4 weights step in 0.10 / 0.20.');
  console.log('================================================================');
  console.log('');
  console.log(header());
  console.log(rule());
  for (const row of THREADED_SWEEP) {
    const dealResult = evaluateDeal(SUNROAD_BAG, row.assessment);
    const r = inspectProposal(dealResult);
    console.log(formatRow(row.label, r));
    console.log(`    note: ${row.note}`);
  }
  console.log('');

  /* ======================= PART 2 — EXACT BOUNDARIES ======================== */
  console.log('================================================================');
  console.log('PART 2 — BOUNDARY ZOOM (synthetic dim-9 contribution injection)');
  console.log('  Lands EXACTLY on each step boundary by bypassing the weight grid.');
  console.log('  Lever still reads only dealResult.dimensions.sponsorBorrowerQuality.');
  console.log('');
  console.log('  Expected step transitions:');
  console.log('    modifier ≤ 0.030      no fire           (≤ TRIGGER)');
  console.log('    0.030 <  modifier < 0.100   MILD        (> TRIGGER, < MODERATE)');
  console.log('    0.100 ≤ modifier < 0.180   MODERATE    (≥ MODERATE, < SEVERE)');
  console.log('    0.180 ≤ modifier          SEVERE      (≥ SEVERE; non-DQ ⇒ tier-key severe)');
  console.log('================================================================');
  console.log('');
  console.log(header());
  console.log(rule());
  const boundaryPoints: readonly number[] = [0.000, 0.029, 0.030, 0.031, 0.099, 0.100, 0.101, 0.179, 0.180, 0.181, 0.200];
  for (const m of boundaryPoints) {
    const dealResult = mkInjectedDealResult(m, /* disqualifying */ false);
    const r = inspectProposal(dealResult);
    console.log(formatRow(`injected modifier = ${m.toFixed(3)}`, r));
  }
  console.log('');

  /* ============== PART 3 — DISQUALIFYING-EVENT OVERRIDE ===================== */
  console.log('================================================================');
  console.log('PART 3 — DISQUALIFYING-EVENT OVERRIDE');
  console.log('  Factor-4 Severe forces tier-key disqualifying-event regardless of net modifier.');
  console.log('  Two demonstrations:');
  console.log('    (a) factor-4 Severe via assessment threading (modifier = +0.20)');
  console.log('    (b) injected modifier ABOVE the cap with disqualifying=true');
  console.log('================================================================');
  console.log('');
  console.log(header());
  console.log(rule());
  // (a) Already shown in Part 1 as "factor-4 Severe (DQ)" — repeat the row for clarity.
  {
    const dealResult = evaluateDeal(SUNROAD_BAG, mkAssessment({ priorCreditEvents: 'Severe' }));
    const r = inspectProposal(dealResult);
    console.log(formatRow('(a) assessment: factor-4 Severe', r));
  }
  // (b) Injected: modifier at +0.20 with disqualifying flag (the tier on the dim
  //     contribution drives the lever's DQ branch — not the modifier value).
  {
    const dealResult = mkInjectedDealResult(0.200, /* disqualifying */ true);
    const r = inspectProposal(dealResult);
    console.log(formatRow('(b) injected modifier +0.20, DQ', r));
  }
  console.log('');

  /* ======== SAMPLE NARRATIVE — confirm interpolation works in description ====== */
  console.log('================================================================');
  console.log('SAMPLE NARRATIVE — interpolated description / structuralChanges');
  console.log('  One sample per tier-key — confirms the table values flow into the text');
  console.log('  instead of the prior hardcoded literals.');
  console.log('================================================================');
  console.log('');
  const samples: ReadonlyArray<{ label: string; dr: EvaluateDealResult }> = [
    { label: 'MILD (modifier +0.05)',                   dr: mkInjectedDealResult(0.05, false) },
    { label: 'MODERATE (modifier +0.12)',               dr: mkInjectedDealResult(0.12, false) },
    { label: 'SEVERE non-DQ (modifier +0.19)',          dr: mkInjectedDealResult(0.19, false) },
    { label: 'DISQUALIFYING-EVENT (modifier +0.20 DQ)', dr: mkInjectedDealResult(0.20, true) },
  ];
  for (const s of samples) {
    const prop = buildGuarantyProposal(s.dr, DEFAULT_GUARANTY_TIER_TERMS);
    console.log(`▎ ${s.label}`);
    if (prop === null) {
      console.log('    (no fire — unexpected)');
    } else {
      console.log(`    id          : ${prop.id}`);
      console.log(`    title       : ${prop.title}`);
      console.log(`    description : ${(prop as any).description ?? ''}`);
      console.log(`    structuralChanges:`);
      for (const sc of (prop as any).structuralChanges ?? []) console.log(`      - ${sc}`);
    }
    console.log('');
  }
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();

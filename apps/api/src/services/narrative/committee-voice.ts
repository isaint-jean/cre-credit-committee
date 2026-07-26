/**
 * committee-voice.ts — the plain-English mapping layer (memo v2, PART 1).
 *
 * THE ENABLER. Every internal identifier the engines speak — dimension ids,
 * tier enums, JE_ judgment-rule codes, doctrine reason codes, mitigation
 * lever ids, handbook principle citations — is translated here into the
 * committee-readable language of Isabelle's Credit Handbook. Nothing else in
 * the memo path may emit a raw identifier into prose a committee reads; it
 * routes through one of the functions below.
 *
 * Four surfaces (per the memo-v2 spec):
 *   1. doctrineReasonSentence()  — wires the (previously dead) doctrine reason
 *      catalogue as the source of every doctrine-finding sentence.
 *   2. judgmentRuleSentence()    — the JE_ table: ~50 judgment-engine rule ids
 *      → plain committee sentences. NO JE_ code ever emitted.
 *   3. dimensionRiskSentence()   — plain-English RISK claims in the handbook's
 *      voice (not metric restatements). Metrics belong in the numbers sections.
 *   4. principleCreditQuestion() — replaces every P-XX-N citation with the
 *      handbook's plain-English credit question. NO P-* token reaches prose.
 *      (The legal fix: the memo cites the handbook's own language, never the
 *      external rating-agency framework's numbering.)
 *
 * Plus dimensionDisplayName() + leverDisplayName() — committee labels for the
 * two id families the deterministic renderer interpolates. Neither has a raw
 * fall-through: an unmapped id resolves to a SAFE committee label, never the
 * internal string.
 *
 * Type-enforced completeness: JUDGMENT_RULE_SENTENCE is
 * Record<JudgmentEngineRuleId, string> and DIMENSION_DISPLAY_NAME is keyed to
 * the nine canonical dimensions, so a new rule / dim fails the build until a
 * sentence is authored. Runtime assertions (assert*Complete) back the type
 * system against `as`-cast escapes and are called from the narrative boot check.
 */

import { JudgmentEngineRules } from '@cre/contracts';
import type { JudgmentEngineRuleId, DoctrineReasonCode } from '@cre/contracts';
import { reasonString, assertReasonCatalogueComplete } from '../doctrine/reason-catalogue.js';

/* ============================================================================
 * SURFACE 1 — doctrine reason codes → committee sentences (wire the catalogue)
 * ========================================================================== */

/**
 * Translate a bounded DoctrineReasonCode to its committee-voice sentence.
 * Thin wrapper over the (previously zero-call-site) DOCTRINE_REASON_CATALOGUE
 * so the whole memo path has a single import surface for reason prose.
 */
export function doctrineReasonSentence(code: DoctrineReasonCode): string {
  return reasonString(code);
}

/* ============================================================================
 * SURFACE 2 — JE_ judgment-engine rule ids → committee sentences
 * ========================================================================== */

/**
 * Every judgment-engine rule the engine can fire, mapped to a plain-English
 * sentence a committee reads. The rules MODIFY the underwriting (raise
 * vacancy, cap NOI, substitute a missing input, flag a divergence); the
 * sentence states, in credit terms, WHAT the engine did and WHY it matters —
 * never the code.
 *
 * Voice: institutional credit-committee. Short. Assumption-honest — where the
 * engine substituted a value, the sentence says so plainly ("is an assumption;
 * it is not stated in the loan documents") so an assumed input can never read
 * as a sourced fact.
 *
 * Record<JudgmentEngineRuleId, string> — the type system requires an entry for
 * every rule; assertJudgmentRuleSentencesComplete() backs it at boot.
 */
export const JUDGMENT_RULE_SENTENCE: { readonly [K in JudgmentEngineRuleId]: string } = {
  // Missing-document penalties.
  JE_RENT_ROLL_MISSING:
    'No rent roll was provided, so tenant-level income could not be verified.',
  JE_TRAILING_ACTUALS_MISSING:
    'No trailing-twelve-month operating statement was provided, so the underwritten income could not be checked against a recent actual.',
  JE_IN_PLACE_MISSING:
    'No in-place operating statement was provided, so current cash flow could not be independently confirmed.',
  JE_PERIOD_LABEL_MISMATCH:
    'An operating-statement column was labelled inconsistently with the period it appears to cover, so its classification should be confirmed.',
  JE_LOAN_TERMS_MISSING:
    'No executed loan term sheet was provided, so the loan terms could not be confirmed against source documents.',
  JE_PCA_MISSING:
    'No property condition assessment was provided, so near-term capital needs could not be independently sized.',
  JE_APPRAISAL_MISSING:
    'No third-party appraisal was provided; value is taken from the underwriting rather than an independent appraisal.',

  // Distrust-tier penalties (lower-tier source used despite a higher tier).
  JE_SELLER_UW_USED_WHEN_ACTUAL_EXISTS:
    'The seller’s underwriting was relied on for income even though trailing actuals were available; the seller’s projection is less conservative.',
  JE_ASR_USED_WHEN_PRIMARY_EXISTS:
    'A pre-sale disclosure figure was relied on even though a higher-quality source was available.',

  // Conservatism normalizations (raise the value to a conservative floor).
  JE_VACANCY_RAISED_TO_LIBRARY_MEDIAN:
    'Underwritten vacancy was raised to the market median because the deal’s assumption looked optimistic.',
  JE_VACANCY_RAISED_TO_BANK:
    'Underwritten vacancy was raised to the bank’s more conservative figure.',
  JE_EXPENSE_RAISED_TO_LIBRARY_MEDIAN:
    'Operating expenses were raised to the market median because the underwriting looked light.',
  JE_EXPENSE_RAISED_TO_BANK:
    'Operating expenses were raised to the bank’s more conservative figure.',
  JE_NOI_CAPPED_TO_BANK:
    'Net operating income was held down to the bank’s more conservative figure.',
  JE_CAP_RATE_RAISED_TO_LIBRARY_MEDIAN:
    'The capitalization rate was raised to the market median, producing a more conservative value.',

  // Missing-data substitution (raw value absent; filled from a reference set).
  JE_VACANCY_SUBSTITUTED_FROM_LIBRARY:
    'Vacancy was not provided and has been assumed from comparable properties; it is not sourced from the deal file.',
  JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK:
    'Vacancy was not provided and has been assumed from a market benchmark; it is not sourced from the deal file.',
  JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY:
    'The expense ratio was not provided and has been assumed from comparable properties; it is not sourced from the deal file.',
  JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY:
    'The capitalization rate was not provided and has been assumed from comparable properties; it is not sourced from the deal file.',
  JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK:
    'The capitalization rate was not provided and has been assumed from a market benchmark; it is not sourced from the deal file.',
  JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK:
    'The interest rate is an assumption drawn from a market benchmark; it is not stated in the loan documents.',
  JE_DSCR_SUBSTITUTED_FROM_LIBRARY:
    'Debt-service coverage was not provided and has been assumed from comparable properties; it is not sourced from the deal file.',
  JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT:
    'Leasing concessions were not provided and a conservative default has been assumed.',

  // Terminal-cap-rate cascade.
  JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD:
    'The exit capitalization rate was assumed from comparable properties plus a widening spread; it is not sourced from the deal file.',
  JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD:
    'The exit capitalization rate was assumed from the current rate plus a widening spread, a weaker basis than comparable properties would provide.',

  // Explicit degraded-state signals.
  JE_EXPENSE_RATIO_NO_FLOOR_AVAILABLE:
    'No conservative expense floor was available to test the underwriting against, so the expense check could not be applied.',
  JE_TILC_APPLICABILITY_UNKNOWN:
    'Whether tenant-improvement and leasing-cost reserves apply could not be determined from the data provided.',
  JE_CONSERVATISM_GATE_NO_FLOOR_DATA:
    'The conservatism check could not run because no reference floor data was available.',

  // Incomplete-input signals.
  JE_RENT_ROLL_UNIT_INCOMPLETE:
    'The rent roll is missing rent or concession figures for some units, so tenant income may be understated.',

  // Impossible composite.
  JE_VACANCY_PLUS_CONCESSIONS_OUT_OF_RANGE:
    'The combined vacancy and concession assumptions were internally inconsistent, so effective income could not be computed from them.',

  // Manual-default emissions.
  JE_OTHER_INCOME_DEFAULTED:
    'Other income was not provided and a conservative default has been assumed.',
  JE_OTHER_INCOME_RECOVERED_FROM_TOTAL:
    'Other income was inferred from the difference between total income and base rent; the composition should be reviewed.',
  JE_NOI_BELOW_TRAILING_ACTUAL:
    'The concluded net operating income is materially below the trailing actual, which is a conservative posture worth confirming.',
  JE_NOI_DIVERGES_FROM_ASR:
    'The concluded net operating income diverges sharply from the figure disclosed in the pre-sale materials; the gap should be reconciled before relying on either.',
  JE_RENT_GROWTH_DEFAULTED:
    'A rent-growth assumption was not provided and a conservative default has been assumed.',
  JE_EXPENSE_GROWTH_DEFAULTED:
    'An expense-growth assumption was not provided and a conservative default has been assumed.',
  JE_MONTHLY_CAPEX_DEFAULTED:
    'Ongoing capital expenditure was not provided and a conservative default has been assumed.',
  JE_REPLACEMENT_RESERVES_DEFAULTED:
    'Replacement reserves were not provided and a conservative default has been assumed.',
  JE_TENANT_IMPROVEMENTS_DEFAULTED:
    'Tenant-improvement costs were not provided and a conservative default has been assumed.',
  JE_LEASING_COMMISSIONS_DEFAULTED:
    'Leasing commissions were not provided and a conservative default has been assumed.',
  JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED:
    'Upfront replacement reserves were not sized from a condition report and a conservative default has been assumed.',

  // Cap-rate stress doctrine (defined; not yet emitted at runtime).
  JE_CAP_TIER_GATEWAY:
    'The capitalization rate was adjusted for a primary-market location.',
  JE_CAP_TIER_SECONDARY:
    'The capitalization rate was adjusted for a secondary-market location.',
  JE_CAP_TIER_TERTIARY:
    'The capitalization rate was adjusted upward for a tertiary-market location, a more conservative value.',
  JE_CAP_STRESS_BUSINESS_PLAN:
    'The capitalization rate was widened to reflect execution risk in the business plan.',
  JE_CAP_STRESS_TENANCY_ROLLOVER:
    'The capitalization rate was widened to reflect lease-rollover exposure.',
  JE_CAP_STRESS_TENANCY_CONCENTRATION:
    'The capitalization rate was widened to reflect tenant-concentration exposure.',
  JE_CAP_CLAMPED_TO_RANGE:
    'The stressed capitalization rate was held within a sanity band.',
  JE_CAP_NET_ADJ_OUT_OF_BAND:
    'The combined capitalization-rate adjustments were large enough to warrant review.',
  JE_CAP_TIER_UNRESOLVED:
    'The market tier for the capitalization-rate adjustment could not be resolved from the data, so that step was skipped.',
};

/**
 * Translate a judgment-engine rule id to its committee sentence. Total over
 * the JudgmentEngineRuleId union (type-enforced); never returns a raw code.
 */
export function judgmentRuleSentence(ruleId: JudgmentEngineRuleId): string {
  return JUDGMENT_RULE_SENTENCE[ruleId];
}

/* ============================================================================
 * SURFACE 3 — dimension display names + plain-English risk sentences
 * ========================================================================== */

/** The nine canonical dimension ids. */
export type CanonicalDimensionId =
  | 'leverage-ltv'
  | 'coverage-dscr'
  | 'debt-yield'
  | 'refinance-feasibility'
  | 'income-concentration'
  | 'rollover'
  | 'cap-rate-valuation-stress'
  | 'asset-class'
  | 'sponsor-borrower-quality';

/**
 * Committee-facing label for each dimension. NO dimension id, NO number.
 * These are the credit questions the handbook asks, in short-title form.
 */
export const DIMENSION_DISPLAY_NAME: { readonly [K in CanonicalDimensionId]: string } = {
  'leverage-ltv':               'Leverage against a stressed value',
  'coverage-dscr':              'Debt-service coverage',
  'debt-yield':                 'Debt yield',
  'refinance-feasibility':      'Refinancing at maturity',
  'income-concentration':       'Tenant concentration',
  'rollover':                   'Lease rollover during the loan term',
  'cap-rate-valuation-stress':  'Durability of the value',
  'asset-class':                'Property-type resilience',
  'sponsor-borrower-quality':   'Sponsor quality',
};

/**
 * Committee label for a dimension id. Falls back to a SAFE generic label
 * ("a credit factor") for any unrecognized id — never the raw id.
 */
export function dimensionDisplayName(dimensionId: string): string {
  return (DIMENSION_DISPLAY_NAME as Record<string, string>)[dimensionId] ?? 'a credit factor';
}

/**
 * Normalize a dimension's per-dim tier enum into a shared severity bucket so
 * the risk-sentence table stays legible. Only tiers ABOVE baseline surface in
 * the memo, so the buckets are moderate / high / severe. Unknown tiers bucket
 * to 'moderate' (the least-alarming non-clean read) rather than leaking.
 */
type Severity = 'moderate' | 'high' | 'severe';
function severityOfTier(tier: string): Severity {
  const t = tier.toLowerCase();
  if (t === 'high' || t === 'distressed' || t === 'disqualifying-event' || t === 'iv' || t === 'convergent-stress') return 'severe';
  if (t === 'elevated' || t === 'thin' || t === 'weak-sponsor' || t === 'iii') return 'high';
  return 'moderate';
}

/**
 * Plain-English RISK claim for a dimension at a given tier — the handbook's
 * voice, stating the loss path, NOT a metric restatement. (The metric itself
 * belongs in the numbers sections of the memo.) The three severity levels
 * escalate the same underlying concern.
 *
 * Any dimension id not in the table resolves to a safe generic sentence built
 * from the display name; no id or tier enum ever reaches the output.
 */
const DIMENSION_RISK_SENTENCE: Readonly<Record<CanonicalDimensionId, Record<Severity, string>>> = {
  'leverage-ltv': {
    moderate: 'Leverage is somewhat high once the value is stressed, leaving a modest equity cushion.',
    high:     'Leverage is high against a stressed value; the equity cushion is thin, so a downturn could erode the lender’s protection.',
    severe:   'Leverage exceeds the stressed value by a wide margin; in a default there may be little or no equity behind the loan.',
  },
  'coverage-dscr': {
    moderate: 'Debt-service coverage is adequate but not comfortable on a stressed cash flow.',
    high:     'Debt-service coverage is thin on a stressed cash flow, leaving little room before the property struggles to cover its debt.',
    severe:   'On a stressed cash flow the property does not cover its debt service, so operations alone may not carry the loan.',
  },
  'debt-yield': {
    moderate: 'Debt yield sits near the acceptable floor for this property type.',
    high:     'Debt yield is below the floor for this property type, signalling aggressive leverage relative to income.',
    severe:   'Debt yield is well below the floor for this property type; income supports far less debt than the loan carries.',
  },
  'refinance-feasibility': {
    moderate: 'Refinancing at maturity is plausible but not assured under stressed take-out assumptions.',
    high:     'Refinancing at maturity looks difficult under stressed take-out assumptions; the loan may not be repayable without a paydown.',
    severe:   'Several exit measures point the same way: refinancing at maturity is unlikely without a paydown or fresh equity.',
  },
  'income-concentration': {
    moderate: 'Income leans on a small number of tenants, so one departure would be felt.',
    high:     'Income is concentrated in a single dominant tenant, so the loan’s cash flow effectively underwrites that one lease.',
    severe:   'The property is effectively a single-tenant credit; the loan stands or falls on that tenant’s covenant.',
  },
  'rollover': {
    moderate: 'A meaningful share of leases roll during the loan term, creating re-leasing exposure.',
    high:     'A majority of income must be re-leased during the loan term, exposing cash flow to downtime and re-tenanting cost.',
    severe:   'Nearly all income rolls during the loan term, so the loan depends heavily on successful re-leasing.',
  },
  'cap-rate-valuation-stress': {
    moderate: 'The concluded value looks somewhat rich against an independently stressed re-derivation.',
    high:     'The concluded value looks aggressive against a stressed re-derivation; a real value cushion may not exist.',
    severe:   'The concluded value looks far above a stressed re-derivation, so the stated equity may be largely on paper.',
  },
  'asset-class': {
    moderate: 'The property type carries somewhat higher long-run volatility than the most stable classes.',
    high:     'The property type is structurally pressured, with above-average default and loss history.',
    severe:   'The property type is among the least stable, with elevated default frequency and loss severity in downturns.',
  },
  'sponsor-borrower-quality': {
    moderate: 'The sponsor read is mixed and warrants closer diligence.',
    high:     'The sponsor read is weak, which raises execution and workout-cooperation risk.',
    severe:   'The sponsor carries a disqualifying credit event in its history, which materially raises the risk of this loan.',
  },
};

/**
 * A plain-English concern-level label for a dimension's tier — for the compact
 * findings table where a single word is wanted. Maps the internal tier enum to
 * Moderate / Elevated / High; never emits the raw enum (e.g. 'distressed',
 * 'iv', 'convergent-stress').
 */
export function concernLevelLabel(tier: string): string {
  switch (severityOfTier(tier)) {
    case 'severe': return 'High';
    case 'high':   return 'Elevated';
    default:       return 'Moderate';
  }
}

/**
 * The committee-voice risk sentence for a dimension finding. `derivedOutputs`
 * is accepted for signature symmetry with the old headlineFor but is
 * deliberately unused — the sentence states the risk, not the number.
 */
export function dimensionRiskSentence(dimensionId: string, tier: string): string {
  const table = (DIMENSION_RISK_SENTENCE as Record<string, Record<Severity, string>>)[dimensionId];
  if (table === undefined) {
    // Safe generic — never the id or the tier enum.
    return `${dimensionDisplayName(dimensionId)} is a concern on this deal.`;
  }
  return table[severityOfTier(tier)];
}

/* ============================================================================
 * SURFACE 4 — handbook principle citations → plain-English credit questions
 * ========================================================================== */

/**
 * Each handbook principle that can surface in the memo, mapped to the plain-
 * English credit QUESTION it asks. The memo cites the QUESTION, never the
 * "P-XX-N" identifier — so the committee reads the handbook's own language and
 * the memo never reproduces the external rating-agency framework's numbering.
 *
 * Principles not enumerated here resolve to a family-level question via the
 * id prefix (below), which is still plain English and code-free.
 */
const PRINCIPLE_CREDIT_QUESTION: Readonly<Record<string, string>> = {
  // Income & lease durability.
  'P-II-1':  'whether the underwritten income is supported by the actual operating history',
  'P-II-2':  'whether in-place rents are at, above, or below market',
  'P-II-3':  'whether the sponsor is taking cash out and, if so, whether that is adequately scrutinized',
  'P-II-4':  'whether the tenant base is durable enough to carry the loan',
  'P-II-9':  'whether lease terms and expirations leave the cash flow exposed during the loan term',
  // Structure, sponsor & diligence.
  'P-III-1':  'whether net operating income reconciles across the sources in the file',
  'P-III-2':  'whether the submarket supports the underwritten leasing and rent assumptions',
  'P-III-5':  'whether the sources and uses of funds are complete and reasonable',
  'P-III-7':  'whether sale and rent comparables support the concluded value',
  'P-III-11': 'whether the sponsor’s background and track record support the request',
  'P-III-12': 'whether the sponsor’s financial capacity backs the commitment',
  'P-III-13': 'whether portfolio exposure to this sponsor or market is within tolerance',
  'P-III-15': 'whether any uplift over trailing income is backed by signed leases and contractual steps',
  // Office-specific.
  'P-IV-OFF-1':  'whether office submarket fundamentals support the underwriting',
  'P-IV-OFF-2':  'whether the building’s physical quality and class are competitive',
  'P-IV-OFF-4':  'whether tenant utilization and occupancy patterns are durable',
  'P-IV-OFF-5':  'whether sublease space overhangs the submarket',
  'P-IV-OFF-6':  'whether the property can withstand a leasing downturn',
  'P-IV-OFF-7':  'whether office leasing comparables support the assumptions',
  'P-IV-OFF-8':  'whether office rent comparables support the assumptions',
  'P-IV-OFF-10': 'whether the office submarket’s trajectory supports the term',
};

/** Family-level fallback question keyed by principle id prefix. Plain English,
 *  never the code. */
function principleFamilyQuestion(principleId: string): string {
  if (principleId.startsWith('P-I-') || principleId.startsWith('P-1-')) return 'whether the deal file is complete enough to underwrite with confidence';
  if (principleId.startsWith('P-II-')) return 'whether the income and leases support the loan';
  if (principleId.startsWith('P-III-')) return 'whether the sponsor, structure, and diligence support the request';
  if (principleId.startsWith('P-IV-OFF-')) return 'whether the office property’s fundamentals support the underwriting';
  if (principleId.startsWith('P-IV-')) return 'whether the property-specific fundamentals support the underwriting';
  return 'an applicable credit-handbook standard';
}

/**
 * The plain-English credit question for a handbook principle. NEVER returns
 * the "P-XX-N" identifier. Enumerated principles return their specific
 * question; anything else returns a family-level question by id prefix.
 */
export function principleCreditQuestion(principleId: string): string {
  return PRINCIPLE_CREDIT_QUESTION[principleId] ?? principleFamilyQuestion(principleId);
}

/* ============================================================================
 * Mitigation lever display names (deterministic renderer id family)
 * ========================================================================== */

/**
 * Committee label for a mitigation lever id. Hardened: an unmapped lever
 * resolves to a SAFE generic label ("a structural condition"), NEVER the raw
 * lever id. This is the root escape-hatch the old `default: return lever`
 * fed both leak vectors.
 */
export function leverDisplayName(lever: string): string {
  switch (lever) {
    case 'reduce_proceeds':           return 'Reduce loan proceeds';
    case 'require_amortization':      return 'Require amortization';
    case 'require_guaranty':          return 'Sponsor guaranty / partial recourse';
    case 'in_place_cash_management':  return 'Hard cash-management lockbox';
    case 'springing_cash_management': return 'Springing cash trap (tenant concentration)';
    case 'fund_reserve':              return 'Fund a reserve (tenant improvements / leasing)';
    case 'condition_precedent':       return 'Conditions to closing';
    case 'cash_sweep_refi_reserve':   return 'Cash sweep into a refinancing reserve';
    case 'leverage_band_recourse':    return 'Leverage-band recourse';
    case 'springing_dscr_recourse':   return 'Springing recourse on a coverage test';
    default:                          return 'A structural condition';
  }
}

/* ============================================================================
 * Boot-time completeness assertions (back the type system against `as` casts)
 * ========================================================================== */

/**
 * Assert every JudgmentEngineRuleId has a committee sentence. Compile-time the
 * Record type enforces this; this runtime guard catches `as`-cast bypasses and
 * is called from the narrative boot check so drift fails fast at startup.
 */
export function assertJudgmentRuleSentencesComplete(): void {
  for (const ruleId of Object.values(JudgmentEngineRules)) {
    const s = (JUDGMENT_RULE_SENTENCE as Record<string, string>)[ruleId];
    if (typeof s !== 'string' || s.length === 0) {
      throw new Error(`JUDGMENT_RULE_SENTENCE missing or empty entry for ruleId='${ruleId}'`);
    }
  }
}

/**
 * Assert every canonical dimension has a display name + a risk sentence for
 * each severity. Guards the surface-3 tables.
 */
export function assertDimensionVoiceComplete(): void {
  const dims: readonly CanonicalDimensionId[] = [
    'leverage-ltv', 'coverage-dscr', 'debt-yield', 'refinance-feasibility',
    'income-concentration', 'rollover', 'cap-rate-valuation-stress',
    'asset-class', 'sponsor-borrower-quality',
  ];
  for (const d of dims) {
    if (!DIMENSION_DISPLAY_NAME[d]) throw new Error(`DIMENSION_DISPLAY_NAME missing entry for '${d}'`);
    const row = DIMENSION_RISK_SENTENCE[d];
    for (const sev of ['moderate', 'high', 'severe'] as const) {
      if (!row[sev]) throw new Error(`DIMENSION_RISK_SENTENCE['${d}'] missing severity '${sev}'`);
    }
  }
}

/**
 * Umbrella completeness check for the committee-voice layer. Also re-runs the
 * doctrine reason-catalogue assertion so all four surfaces are gated from one
 * call site in the narrative boot check.
 */
export function assertCommitteeVoiceComplete(): void {
  assertReasonCatalogueComplete();
  assertJudgmentRuleSentencesComplete();
  assertDimensionVoiceComplete();
}

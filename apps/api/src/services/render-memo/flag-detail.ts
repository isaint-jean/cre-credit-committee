/**
 * buildFlagDetail — the shared "how I determined this" content builder for red flags,
 * feeding BOTH the deal-room modal (React) and the memo's inline <details> (server HTML).
 * DISPLAY-ONLY / render-time: assembled from the re-run doctrine contributions + the JE
 * flags + the NOI reconciliation detail. Never minted; no re-mint.
 *
 * ★ Honesty: evidence[].source is NEVER a fabricated document+page. It is one of the honest
 *   forms — "Underwriting inputs" (dimension-derived), "<doc-kind> (page not captured)" (NOI),
 *   "Absence of <doc> …" (data-quality), "PCA report / reserve analysis" (capex), or the
 *   thin "Not captured" — because most flags carry no named-document/page provenance.
 *
 * Tiers: dimensions with a rationale + derivedOutputs → 'rich'; JE flags → 'message'
 * (sentence + rule id + honest source); sponsor / HITL-needed → 'thin' (no invented evidence).
 */
import type { DimensionContribution } from '../../doctrine-clean/types.js';
import type { FlagDetail, FlagEvidence, NoiReconciliationDetail, JudgmentEngineRuleId } from '@cre/contracts';
import { dimensionDisplayName, dimensionRiskSentence, judgmentRuleSentence } from '../narrative/committee-voice.js';

/** NOI-reconciliation flags whose modal reuses the NOI receipts. */
export const NOI_FLAG_IDS: ReadonlySet<string> = new Set([
  'JE_NOI_DIVERGES_FROM_ASR', 'JE_NOI_BELOW_TRAILING_ACTUAL', 'UW_VS_T12_NOI_RECONCILIATION',
]);

/** dim id → the DoctrineRuleId the deal-room findings table keys on (mirror of dimToRuleId). */
const DIM_TO_RULE_ID: Readonly<Record<string, string>> = {
  'rollover': 'ROLLOVER_WITHIN_TERM',
  'income-concentration': 'TENANT_CONCENTRATION',
  'refinance-feasibility': 'REFI_FEASIBILITY_STRESSED',
  'coverage-dscr': 'DSCR_LEVEL',
  'leverage-ltv': 'LTV_LEVEL',
  'debt-yield': 'DEBT_YIELD_LEVEL',
  'cap-rate-valuation-stress': 'NO_VALUE_ABOVE_PRIMARY_ANCHOR',
};

function fmtUsd(n: number): string { return `$${Math.round(n).toLocaleString('en-US')}`; }
function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).trim();
}
function fmtOutput(key: string, v: number | string): string {
  if (typeof v === 'string') return v;
  // boolean-ish flags (isIo, basisIsIo, …) — render Yes/No, not "$1".
  if (/(^is[A-Z])|Is[A-Z]|IsIo$/i.test(key) && (v === 0 || v === 1)) return v === 1 ? 'Yes' : 'No';
  if (/ltv|occupanc|vacancy/i.test(key) && Math.abs(v) <= 1.5) return `${(v * 100).toFixed(1)}%`;
  if (/rate|yield|pct/i.test(key) && Math.abs(v) <= 1) return `${(v * 100).toFixed(2)}%`;
  if (/dscr|ratio|multiple|aggressiveness/i.test(key)) return `${v.toFixed(2)}×`;
  if (/value|noi|ncf|amount|loan|reserve|expense|income|revenue|debt|service|balance/i.test(key)) return fmtUsd(v);
  return String(Math.round(v * 100) / 100);
}

/** Honest source per JE flag family — NEVER a fabricated doc+page. */
function judgmentSource(ruleId: string): string {
  if (/RENT_ROLL_MISSING/.test(ruleId)) return 'Absence of a rent roll — none was extracted (see missing docs)';
  if (/TRAILING_ACTUALS_MISSING/.test(ruleId)) return 'Absence of a trailing-12 operating statement (see missing docs)';
  if (/IN_PLACE_MISSING/.test(ruleId)) return 'Absence of an in-place rent roll (see missing docs)';
  if (/APPRAISAL_MISSING/.test(ruleId)) return 'Absence of an appraisal (see missing docs)';
  if (/LOAN_TERMS_MISSING/.test(ruleId)) return 'Absence of loan terms (see missing docs)';
  if (/PCA_MISSING/.test(ruleId)) return 'Absence of a PCA report (see missing docs)';
  if (/PCA|CAPEX|REPLACEMENT_RESERVES|IMMEDIATE_REPAIRS|TILC/.test(ruleId)) return 'PCA report / reserve analysis';
  if (/INSUFFICIENT_DATA/.test(ruleId)) return 'Absence of sufficient extracted inputs';
  return 'Underwriting inputs';
}

/** Rich dimension detail: rationale (how) + derivedOutputs (values). Thin for HITL/sponsor. */
export function dimensionFlagDetail(c: DimensionContribution): FlagDetail {
  const thin = c.applicability === 'hitl-needed' || c.dimensionId === 'sponsor-borrower-quality';
  const statement = dimensionRiskSentence(c.dimensionId, c.tier);
  if (thin) {
    return {
      flagId: c.dimensionId,
      statement,
      howDetermined: `${dimensionDisplayName(c.dimensionId)} could not be evaluated from the deal file — this is a human / HITL assessment. No structured evidence was captured.`,
      evidence: [],
      tier: 'thin',
    };
  }
  const evidence: FlagEvidence[] = [];
  for (const [k, v] of Object.entries(c.derivedOutputs ?? {})) {
    if (v === null || v === undefined) continue;
    evidence.push({ label: humanize(k), value: fmtOutput(k, v), source: 'Underwriting inputs' });
  }
  return {
    flagId: c.dimensionId,
    statement,
    howDetermined: c.rationale,
    evidence,
    tier: evidence.length > 0 ? 'rich' : 'message',
  };
}

/** Message-tier JE detail: committee sentence + the rule + the honest source. */
export function judgmentFlagDetail(ruleId: string): FlagDetail {
  const sentence = judgmentRuleSentence(ruleId as JudgmentEngineRuleId) ?? ruleId;
  return {
    flagId: ruleId,
    statement: sentence,
    howDetermined: `Flagged by the judgment engine (${ruleId}) when its rule condition was met. ${sentence}`.trim(),
    evidence: [{ label: 'Judgment-engine rule', value: ruleId, source: judgmentSource(ruleId) }],
    tier: 'message',
  };
}

/** Rich NOI detail — reuses the NOI reconciliation receipts (value · source-doc · variance). */
export function noiFlagDetail(ruleId: string, noi: NoiReconciliationDetail): FlagDetail {
  const evidence: FlagEvidence[] = noi.rows.map((r) => ({
    label: r.label, value: r.valueFormatted, source: `${r.sourceDocument} (page not captured)`,
  }));
  return {
    flagId: ruleId,
    statement: judgmentRuleSentence(ruleId as JudgmentEngineRuleId) ?? 'NOI does not reconcile with an independent source.',
    howDetermined: `The concluded NOI was compared side-by-side to the independently-disclosed figures. ${noi.variance ?? ''}`.trim(),
    evidence,
    tier: evidence.length > 0 ? 'rich' : 'message',
  };
}

/**
 * Assemble every flag's detail for a deal, keyed by every id its consumers might hold:
 * dimensionId, the mapped DoctrineRuleId (deal-room findings table), and the JE rule id.
 */
export function buildAllFlagDetails(args: {
  readonly contributions: readonly DimensionContribution[];
  readonly dataQualityFlags: readonly string[];
  readonly noiReconciliation?: NoiReconciliationDetail;
}): Record<string, FlagDetail> {
  const out: Record<string, FlagDetail> = {};
  for (const c of args.contributions) {
    const d = dimensionFlagDetail(c);
    out[c.dimensionId] = d;
    const rid = DIM_TO_RULE_ID[c.dimensionId];
    if (rid !== undefined) out[rid] = d; // deal-room findings-table lookup by ruleId
  }
  for (const f of args.dataQualityFlags) {
    out[f] = NOI_FLAG_IDS.has(f) && args.noiReconciliation ? noiFlagDetail(f, args.noiReconciliation) : judgmentFlagDetail(f);
  }
  if (args.noiReconciliation) {
    for (const r of NOI_FLAG_IDS) if (out[r] === undefined) out[r] = noiFlagDetail(r, args.noiReconciliation);
  }
  return out;
}

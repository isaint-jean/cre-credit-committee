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
  // A 0–1 tenant/income SHARE renders as a whole percent ("52%"), not "0.52". Scoped to
  // *Share keys so it drives BOTH the headline and the evidence row identically (no drift).
  if (/share/i.test(key) && Math.abs(v) <= 1) return `${Math.round(v * 100)}%`;
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
  // Bucket C — substituted defaults name the BASIS honestly (a library/benchmark table,
  // not a document). Never upgrade a substitution into a source document.
  if (/SUBSTITUTED_FROM_MARKET_BENCHMARK|MARKET_BENCHMARK/.test(ruleId)) return 'Market benchmark (no source document — substituted default)';
  if (/SUBSTITUTED_FROM_LIBRARY|_FROM_LIBRARY|_LIBRARY$/.test(ruleId)) return 'Library median (no source document — substituted default)';
  if (/INSUFFICIENT_DATA/.test(ruleId)) return 'Absence of sufficient extracted inputs';
  return 'Underwriting inputs';
}

/** The documents whose absence is known from the data-quality _MISSING flags. */
export interface DimensionDocContext {
  readonly missing: ReadonlySet<string>; // 'appraisal' | 'loan terms' | 'rent roll' | 'T-12' | 'PCA' | 'in-place'
}
const NO_DOC_CTX: DimensionDocContext = { missing: new Set() };

/** cap-rate concludedValueSource tag → the human document label (honest; no page). */
function concludedValueDocLabel(src: string | number | null | undefined): string {
  switch (src) {
    case 'extracted-appraisal': return 'Extracted appraisal (third-party)';
    case 'extracted-asr': return 'ASR implied value';
    case 'extracted-annex-a': return 'Annex A (issuer prospectus)';
    case 'operator-supplied': return 'Operator-supplied value';
    default: return 'Concluded underwriting (source document not captured)';
  }
}

/**
 * Honest source DOCUMENT for a dimension's derived-output value. Where the source doc is
 * structurally known AND present, name it; where it's absent or genuinely unknown, name
 * the INPUT — never a fabricated document, never a page number.
 */
function dimensionOutputSource(dimensionId: string, key: string, valueDocLabel: string, ctx: DimensionDocContext): string {
  // Bucket C — asset-class derives from property metadata, not a discrete document.
  if (dimensionId === 'asset-class') return 'Property metadata (no discrete document)';
  const k = key.toLowerCase();
  const present = (doc: string): boolean => !ctx.missing.has(doc);
  const orInput = 'Underwriting inputs (source document not captured)';
  // The concluded/stressed value carries the resolved cap-rate source tag verbatim.
  if (/concludedvalue|stressedvalue|appraised|valueconclusion/.test(k)) return valueDocLabel;
  if (/ltv/.test(k)) return present('appraisal') && present('loan terms') ? 'Appraisal + loan terms' : orInput;
  if (/loan|balance|proceeds|(^|[^a-z])debt(?!.?yield)/.test(k)) return present('loan terms') ? 'Loan terms' : orInput;
  // NOI-derived ratios trace to the NOI reconciliation basis (T-12 / Seller UW / concluded).
  if (/noi|ncf|dscr|debt.?yield|yield|coverage/.test(k)) return 'T-12 / Seller UW / concluded NOI';
  if (/occupanc|vacancy|rollover|tenant|concentrat|lease|wault/.test(k)) return present('rent roll') ? 'Rent roll' : orInput;
  // Cap-rate stress inputs come from the agency stress bands (a methodology, not a doc).
  if (/caprate|cap.?rate|aggressiveness|(^|[^a-z])rate([^a-z]|$)/.test(k)) return "Agency stress bands (DBRS / KBRA / Moody's)";
  return 'Underwriting inputs';
}

// Plain-language titles for dimensions whose triggering number isn't cleanly reachable at
// render (never a bare metric label). rollover's share is trapped in rationale prose (the
// producer isn't touched this pass); asset-class is an enum; sponsor is HITL.
const DIMENSION_FALLBACK_TITLE: Readonly<Record<string, string>> = {
  'rollover': 'Large share of leases roll within the loan term',
  'asset-class': 'Secondary / higher-risk asset type',
  'sponsor-borrower-quality': 'Sponsor quality unverified',
};

/**
 * The specific, human headline WITH the real triggering number — pulled from derivedOutputs
 * via the SAME fmtOutput the evidence rows use, so the headline number is byte-identical to
 * the modal evidence (zero drift, never invented). Returns null when the expected number is
 * absent/unformattable → the caller uses the plain-language fallback (never a blank / NaN).
 */
function dimensionHeadline(c: DimensionContribution): string | null {
  const o = c.derivedOutputs ?? {};
  const num = (k: string): string | null => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) ? fmtOutput(k, v) : null;
  };
  let x: string | null;
  switch (c.dimensionId) {
    case 'coverage-dscr': x = num('stressedDscr'); return x ? `Thin coverage — DSCR ${x} barely clears debt service` : null;
    case 'leverage-ltv': x = num('stressedLtv'); return x ? `High leverage — ${x} LTV against a stressed value` : null;
    case 'debt-yield': x = num('debtYield'); return x ? `Low debt yield — ${x}` : null;
    case 'refinance-feasibility': x = num('exitDscr'); return x ? `Won't refinance — exit DSCR ${x} below 1.0×` : null;
    case 'cap-rate-valuation-stress': x = num('stressedCapRateGoingIn'); return x ? `Aggressive valuation — implies a ${x} cap vs the stressed floor` : null;
    case 'income-concentration': x = num('topTenantShare'); return x ? `Concentrated income — top tenant ${x} of income` : null;
    default: return null;
  }
}

/** Rich dimension detail: rationale (how) + derivedOutputs (values). Thin for HITL/sponsor. */
export function dimensionFlagDetail(c: DimensionContribution, ctx: DimensionDocContext = NO_DOC_CTX): FlagDetail {
  const thin = c.applicability === 'hitl-needed' || c.dimensionId === 'sponsor-borrower-quality';
  // ★ Human headline WITH the real number where reachable; else the plain-language title;
  // else the qualitative risk sentence — NEVER a bare metric label.
  const statement = dimensionHeadline(c)
    ?? DIMENSION_FALLBACK_TITLE[c.dimensionId]
    ?? dimensionRiskSentence(c.dimensionId, c.tier);
  if (thin) {
    // Bucket C — sponsor / HITL: honest-thin, NEVER a fabricated document.
    return {
      flagId: c.dimensionId,
      statement,
      howDetermined: `${dimensionDisplayName(c.dimensionId)} could not be evaluated from the deal file — this is a human / HITL assessment. No structured evidence was captured.`,
      evidence: [],
      tier: 'thin',
    };
  }
  const outputs = c.derivedOutputs ?? {};
  // cap-rate carries its resolved value-source tag in derivedOutputs (display pass-through,
  // not re-read from prose). It labels the value rows; it is NOT itself a value row.
  const valueDocLabel = concludedValueDocLabel(outputs['concludedValueSource']);
  const evidence: FlagEvidence[] = [];
  for (const [k, v] of Object.entries(outputs)) {
    if (v === null || v === undefined) continue;
    if (k === 'concludedValueSource') continue; // provenance tag — folded into the source labels below
    evidence.push({ label: humanize(k), value: fmtOutput(k, v), source: dimensionOutputSource(c.dimensionId, k, valueDocLabel, ctx) });
  }
  return {
    flagId: c.dimensionId,
    statement,
    howDetermined: c.rationale,
    evidence,
    tier: evidence.length > 0 ? 'rich' : 'message',
  };
}

/** Which documents are known-absent, from the data-quality _MISSING flags. */
function missingDocsFromFlags(dataQualityFlags: readonly string[]): DimensionDocContext {
  const missing = new Set<string>();
  for (const f of dataQualityFlags) {
    if (/RENT_ROLL_MISSING/.test(f)) missing.add('rent roll');
    if (/TRAILING_ACTUALS_MISSING/.test(f)) missing.add('T-12');
    if (/IN_PLACE_MISSING/.test(f)) missing.add('in-place');
    if (/APPRAISAL_MISSING/.test(f)) missing.add('appraisal');
    if (/LOAN_TERMS_MISSING/.test(f)) missing.add('loan terms');
    if (/PCA_MISSING/.test(f)) missing.add('PCA');
  }
  return { missing };
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
  const docCtx = missingDocsFromFlags(args.dataQualityFlags);
  for (const c of args.contributions) {
    const d = dimensionFlagDetail(c, docCtx);
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

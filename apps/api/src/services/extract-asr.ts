/**
 * extractASR - AI-tier extractor for the ASR's headline UW summary numbers.
 *
 * Pulls three fields from the ASR text:
 *   - impliedValue     (dollar amount the broker pitches as the property's value)
 *   - impliedCapRate   (0..1 fraction)
 *   - underwrittenNOI  (annual dollar amount the broker pitches as stabilized NOI)
 *
 * These are distinct from PropertyMetadata (identity/address/specs, pulled by
 * extractPropertyMetadata) and from the rent-roll table within the ASR (pulled
 * by extractRentRollFromDocument). All three extractors run against the same
 * ParsedDocument under the ASR adapter's fan-out.
 *
 * IMPORTANT: TREAT EXTRACTED VALUES WITH SKEPTICISM.
 *
 * The ASR is a sales document. Brokers pitch numbers favorable to the seller's
 * narrative: implied values are typically aspirational, cap rates are usually
 * tight, and underwritten NOI may exclude conservative adjustments a buyer
 * would apply. The judgment engine treats ASR as the LOWEST source tier
 * (BANK > T12_ACTUAL > APPRAISAL > SELLER_UW > ASR per
 * docs/judgment-engine-plan.md:95), so these values are reference points, not
 * authoritative inputs. Downstream consumers must not treat ASR figures as
 * facts.
 *
 * Discipline:
 *   - Best-effort. AI extraction can miss; missing field -> null.
 *   - No fabrication. Placeholder strings ("N/A", "Not provided", "TBD") map to null.
 *   - If literally every field is null after parsing, return null (no empty record).
 *   - The pure parser (parseAsrAiResponse) is exported separately so tests
 *     run without invoking the live API.
 *   - Cap rate normalization: brokers may write 6.5 (percent) or 0.065
 *     (fraction). Values >1 are treated as percents and divided by 100. Values
 *     0..1 are treated as fractions. Edge case 1 is treated as fraction (1.0
 *     = 100%, implausible but preserved as the literal value).
 */

import type { ASRExtraction, SourcesAndUses, EnvironmentalSummary, MarketRentSummary } from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { parseAsrCashFlowsFromText } from './extract-asr-cashflows.js';

const EXTRACT_ASR_SYSTEM = `You extract ASR headline UW numbers from CRE documents and return ONLY a JSON object matching the requested schema. Missing fields must be null. Never add prose, commentary, or markdown.`;

function buildPrompt(text: string): string {
  return [
    'Extract the ASR headline underwriting summary from this CRE document. Return STRICT JSON of this shape (and nothing else):',
    '{',
    '  "impliedValue": <dollar amount or null>,',
    '  "impliedCapRate": <fraction 0-1 OR percent number, e.g. 0.065 or 6.5, or null>,',
    '  "underwrittenNOI": <annual dollar amount or null>,',
    '  "priorDebtPayoff": <dollar amount of existing loan being refinanced, or null>',
    '}',
    '',
    'Rules:',
    '- Missing field -> null. Do NOT use 0 / "" / "N/A" / "TBD" as placeholders.',
    '- impliedValue is the broker pitched property value (dollars). May appear as "Implied Value", "Pricing Value", or similar.',
    '- impliedCapRate is the broker implied cap rate. May appear as decimal (0.065) or percent (6.5). Either form is acceptable; the parser normalizes.',
    '- underwrittenNOI is the broker stabilized/pro-forma NOI (annual dollars). May appear as "Year 1 NOI", "Stabilized NOI", "Underwritten NOI", or similar.',
    '- priorDebtPayoff is the dollar amount of EXISTING debt being refinanced — the "Loan Payoff" / "Existing Loan Payoff" / "Refinance Existing Debt" / "Prior CMBS Payoff" line in the Sources & Uses table. Only populate on refinance deals where the source explicitly states the amount; null when the source is silent or the deal is an acquisition (not a refinance).',
    '- Numbers only (no strings with commas or $ signs in the JSON output). Use null when uncertain.',
    '',
    '--- DOCUMENT TEXT ---',
    text,
  ].join('\n');
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (/^(n\/?a|none|null|undefined|not\s*provided|not\s*disclosed|not\s*available|tbd)$/i.test(trimmed)) return null;
  return trimmed;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = asString(v);
    if (s === null) return null;
    const cleaned = s.replace(/[$,\s%]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asMoney(v: unknown): number | null {
  return asNumber(v);
}

function asCapRate(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  if (n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

/**
 * Deterministic Sources & Uses parser — NO LLM. Reads the ASR's "Sources &
 * Uses" table directly from the parsed PDF text. Each line is matched by its
 * label and the first dollar amount that follows (footnote superscripts after
 * the label, e.g. "Loan Payoff1", are tolerated by the `\d*`). Honest-blank:
 * a label not present → null (never 0 / fabricated); a refinance has no
 * "Purchase Price" line, so `purchasePrice` is null. Returns null when the
 * document has no S&U table at all (nothing matched).
 *
 * Exported pure so it can be exercised without a live document.
 */
export function parseSourcesAndUses(rawText: string): SourcesAndUses | null {
  if (typeof rawText !== 'string' || rawText.length === 0) return null;
  // "$65,365,379" → 65365379
  const dollars = (re: RegExp): number | null => {
    const m = re.exec(rawText);
    if (!m || m[1] === undefined) return null;
    const n = Number(m[1].replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  // "$91.6 million" → 91_600_000
  const millions = (re: RegExp): number | null => {
    const m = re.exec(rawText);
    if (!m || m[1] === undefined) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : null;
  };

  // Footnote-tolerant: ASR S&U lines carry superscripts that unpdf renders as
  // "(1)" / "1" / "" — `\s*\(?\d*\)?` absorbs all three before the dollar value.
  const su: SourcesAndUses = {
    loanAmount:           dollars(/Loan Amount\s+\$([\d,]+)/i),
    loanPayoff:           dollars(/Loan Payoff\s*\(?\d*\)?\s+\$([\d,]+)/i),
    // Final ASR labels it "Equity Return"; prelim "Return of Equity".
    returnOfEquity:       dollars(/(?:Equity Return|Return of Equity)\s*\(?\d*\)?\s+\$([\d,]+)/i),
    unfundedObligations:  dollars(/Unfunded Obligations\s*\(?\d*\)?\s+\$([\d,]+)/i),
    capitalExpenditures:  dollars(/Capital Expenditures\s+\$([\d,]+)/i),
    closingCosts:         dollars(/Closing Costs\s+\$([\d,]+)/i),
    purchasePrice:        dollars(/Purchase Price\s+\$([\d,]+)/i),
    totalCostBasis:       millions(/total cost basis of \$([\d.]+)\s*million/i),
    // Final-ASR DISTINCT use-lines (6 uses; the binding layer compresses to the
    // template's 5 cells). Kept faithful to the doc.
    gsaRentReserve:       dollars(/GSA Rent Reserve\s+\$([\d,]+)/i),
    llObligationsGapRent: dollars(/LL Obligations.{0,6}Gap Rent\s*\(?\d*\)?\s+\$([\d,]+)/i),
    closingReservesCapex: dollars(/Closing Reserves.{0,6}Capex\s+\$([\d,]+)/i),
  };

  const anyPresent = Object.values(su).some((v) => v !== null);
  return anyPresent ? su : null;
}

/**
 * Deterministic environmental-summary parser — NO LLM. Reads the ASR's
 * "Third Party Reports – Environmental" / "Environmental Summary" table
 * label-by-label. Honest-blank: a label not present → null (never fabricated).
 * A stated "$0" remediation/reserve → 0 (a real read), distinct from absent
 * (→ null). Returns null when no environmental labels matched at all.
 *
 * STORE-ONLY (captured-but-unconsumed): the result rides on ASRExtraction for
 * audit; no doctrine/scoring stage reads it yet. Exported pure for testing.
 */
export function parseEnvironmentalSummary(rawText: string): EnvironmentalSummary | null {
  if (typeof rawText !== 'string' || rawText.length === 0) return null;
  const str = (re: RegExp): string | null => {
    const m = re.exec(rawText);
    return m && m[1] !== undefined ? m[1].trim() : null;
  };
  const money = (re: RegExp): number | null => {
    const m = re.exec(rawText);
    if (!m || m[1] === undefined) return null;
    const n = Number(m[1].replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const firm = str(/Environmental Firm:\s*([A-Za-z][A-Za-z .&-]*?)(?:\s{2,}|\s+Phase\b|\n|$)/i);
  const phaseIReportDate = str(/Phase I Report Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const phaseIIRecStr = str(/Phase II Recommended[^:]*:\s*(Yes|No)\b/i);
  const phaseIIRecommended = phaseIIRecStr === null ? null : /yes/i.test(phaseIIRecStr);
  const phaseIIDateStr = str(/Phase II Report Date:\s*(N\/A|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const phaseIIReportDate = phaseIIDateStr === null || /^n\/a$/i.test(phaseIIDateStr) ? null : phaseIIDateStr;
  const remediationEstimate = money(/Environmental Remediation Estimate:\s*\$?([\d,]+)/i);
  const reserveAmount = money(/Environmental Reserve Amount:\s*\$?([\d,]+)/i);

  // findingsAcceptable: assert TRUE only when the findings matrix is present and
  // the known rows read clean ("Acceptable=Yes, O&M=No, Additional=No, Costs=No").
  // Otherwise null — we do NOT assert "not acceptable" from a parse we can't confirm.
  let findingsAcceptable: boolean | null = null;
  const matrixPresent = /Historical Review/i.test(rawText) && /Hazardous Substances/i.test(rawText);
  if (matrixPresent) {
    const cleanRow = (label: string): boolean =>
      new RegExp(label + '[^\\n]*?\\bYes\\b\\s+No\\s+No\\s+No\\b', 'i').test(rawText);
    if (cleanRow('Historical Review') && cleanRow('Hazardous Substances')) findingsAcceptable = true;
  }

  const anyPresent = [firm, phaseIReportDate, phaseIIRecommended, phaseIIReportDate, remediationEstimate, reserveAmount]
    .some((v) => v !== null);
  if (!anyPresent) return null;
  return {
    firm,
    phaseIReportDate,
    phaseIIRecommended,
    phaseIIReportDate,
    remediationEstimate,
    reserveAmount,
    findingsAcceptable,
    source: 'ASR · Third Party Reports – Environmental',
  };
}

/**
 * Deterministic market-rent parser — NO LLM. Reads the ASR's "Sub-Market
 * Overview" for the SUBMARKET-LEVEL aggregate (name, vacancy, average asking
 * rent PSF). Honest-blank: a value not stated → null. ★ This aggregate must
 * NOT be routed to the per-tenant Mark-to-Market rollover (the Build-A-bypassed
 * path needs per-tenant marketRentAnnual, which this is not). STORE-ONLY.
 * Exported pure for testing.
 */
export function parseMarketRent(rawText: string): MarketRentSummary | null {
  if (typeof rawText !== 'string' || rawText.length === 0) return null;
  // ★ Scope to the property's SUB-market table ("Sub-Market Overview – <name>"),
  // NOT the broader metro "Market Overview – <metro>" that precedes it. They
  // carry different vacancy + asking-rent figures (e.g. San Diego metro 11.3% /
  // $38.57 vs Kearny Mesa submarket 7.8% / $34.36); we want the submarket's.
  const m = /Sub-?Market Overview\s*[–—-]\s*([A-Za-z][A-Za-z ]*?)\s+Inventory\b/i.exec(rawText);
  if (m === null) return null;
  const submarketName = m[1] ? m[1].trim() : null;
  const scope = rawText.slice(m.index, m.index + 300); // the submarket table only
  const vacM = /Vacancy:\s*([\d.]+)\s*%/i.exec(scope);
  const vacancyRate = vacM && vacM[1] !== undefined && Number.isFinite(Number(vacM[1])) ? Number(vacM[1]) / 100 : null;
  const rentM = /Average Rental Rate:\s*\$?([\d.]+)/i.exec(scope);
  const averageRentPsf = rentM && rentM[1] !== undefined && Number.isFinite(Number(rentM[1])) ? Number(rentM[1]) : null;

  const anyPresent = [submarketName, vacancyRate, averageRentPsf].some((v) => v !== null);
  if (!anyPresent) return null;
  return { submarketName, vacancyRate, averageRentPsf, source: 'ASR · Sub-Market Overview' };
}

/**
 * Pure parser. Exported so tests can exercise normalization without invoking AI.
 *
 * Accepts either:
 *   - A response string (presumed to contain a JSON blob; extractJSON pulls it)
 *   - An already-parsed object (for direct test cases)
 *
 * Returns null when the JSON is unparseable OR every field ends up null after
 * normalization (no fabricated empty records).
 */
export function parseAsrAiResponse(responseText: string | unknown): ASRExtraction | null {
  let parsed: unknown;
  if (typeof responseText === 'string') {
    try {
      parsed = extractJSON(responseText);
    } catch {
      return null;
    }
  } else {
    parsed = responseText;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as { [k: string]: unknown };

  const impliedValue = asMoney(r.impliedValue);
  const impliedCapRate = asCapRate(r.impliedCapRate);
  const underwrittenNOI = asMoney(r.underwrittenNOI);
  const priorDebtPayoff = asMoney(r.priorDebtPayoff);

  if (impliedValue === null && impliedCapRate === null && underwrittenNOI === null && priorDebtPayoff === null) {
    return null;
  }

  return {
    impliedValue,
    impliedCapRate,
    underwrittenNOI,
    priorDebtPayoff,
  };
}

/**
 * Extract ASR headline UW numbers from a ParsedDocument via AI. Returns null
 * on empty/missing text, AI call failure, malformed JSON, or all-null fields
 * after parsing.
 */
export async function extractASR(document: ParsedDocument): Promise<ASRExtraction | null> {
  const text = document.sections
    .map((s) => (s.title ? '## ' + s.title + '\n' : '') + (s.content ?? ''))
    .join('\n\n')
    .slice(0, 80_000);
  if (text.length === 0) return null;

  let responseText: string;
  try {
    responseText = await callAIWithContinuation({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: EXTRACT_ASR_SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(text) }],
    });
  } catch (err) {
    console.warn('[AI:ASR] extraction call failed:', err);
    // The deterministic S&U parse does not depend on the AI call — recover it
    // below rather than losing it to an AI failure.
    responseText = '';
  }

  const llm = responseText ? parseAsrAiResponse(responseText) : null;
  // Deterministic S&U over the full parsed text (no LLM). Prefer the parsed
  // loanPayoff for priorDebtPayoff — the table line is more reliable than the
  // LLM's free-text read for this gate-critical figure.
  const sourcesAndUses = parseSourcesAndUses(document.rawText ?? '');
  // Deterministic, no-LLM captures (store-only; no doctrine consumer reads these
  // yet). Market rent is a submarket aggregate — NOT routed to the per-tenant
  // M2M rollover (Build A bypassed that path). See contract comments.
  const environmentalSummary = parseEnvironmentalSummary(document.rawText ?? '');
  const marketRent = parseMarketRent(document.rawText ?? '');
  // Deterministic "Underwritten Cash Flows" ladder (no LLM) — anchor-scoped to
  // the heading. Honest-null on non-Sunroad ASRs that lack the table.
  const underwrittenCashFlows = parseAsrCashFlowsFromText(document.rawText ?? '');

  if (llm === null && sourcesAndUses === null && environmentalSummary === null && marketRent === null && underwrittenCashFlows === null) return null;
  const base: ASRExtraction = llm ?? {
    impliedValue: null, impliedCapRate: null, underwrittenNOI: null, priorDebtPayoff: null,
  };
  return {
    ...base,
    priorDebtPayoff: sourcesAndUses?.loanPayoff ?? base.priorDebtPayoff,
    sourcesAndUses,
    environmentalSummary,
    marketRent,
    underwrittenCashFlows,
  };
}

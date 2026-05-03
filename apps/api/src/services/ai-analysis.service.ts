import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import {
  AssetType, Finding, FindingCategory, CreditScore, CriteriaEvaluation,
  DocumentSection, ParsedDocument,
  CrossCheckFinding, MitigationStrategy, ResearchResults, BPieceDecision
} from '@cre/shared';
import { CriteriaRule, CriteriaRuleSet } from '@cre/shared';
import { UnderwritingModel, LineItem, LoanDetails } from '@cre/shared';
import {
  recalculateFullModel,
  normalizeFinancialValue,
  CORE_FIELD_KIND,
  computeDeterministicScore,
} from '@cre/shared';
import { v4 as uuid } from 'uuid';
import {
  SYSTEM_PROMPT,
  buildFindingsPrompt,
  buildUWPrompt,
  buildScoringPrompt,
  buildSellerMetricExtractionPrompt,
  buildEntityExtractionPrompt,
  buildMitigationPrompt,
  buildExecutiveSummaryPrompt,
  buildBPieceDecisionPrompt,
} from './ai-prompts.service.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.anthropicApiKey });
  }
  return client;
}

/**
 * Call the AI and automatically continue if the response is truncated
 * (stop_reason === 'max_tokens'). Concatenates partial responses and
 * retries up to `maxContinuations` times.
 */
export async function callAIWithContinuation(options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Anthropic.MessageParam[];
  maxContinuations?: number;
}): Promise<string> {
  const anthropic = getClient();
  const maxRetries = options.maxContinuations ?? 2;
  let fullText = '';
  let messages = [...options.messages];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await anthropic.messages.create({
      model: options.model,
      max_tokens: options.max_tokens,
      system: options.system,
      messages,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    fullText += text;

    if (response.stop_reason !== 'max_tokens') {
      // Response completed naturally
      return fullText;
    }

    console.warn(`[AI] Response truncated (attempt ${attempt + 1}/${maxRetries + 1}, ${text.length} chars). Requesting continuation...`);

    if (attempt < maxRetries) {
      // Ask the model to continue from where it left off
      messages = [
        ...options.messages,
        { role: 'assistant' as const, content: fullText },
        { role: 'user' as const, content: 'Your response was cut off. Continue the JSON output from exactly where you stopped. Do not repeat any content — only output the remaining JSON.' },
      ];
    }
  }

  console.warn(`[AI] Response still truncated after ${maxRetries + 1} attempts (${fullText.length} total chars). Proceeding with partial data.`);
  return fullText;
}

/**
 * Sanitize a JSON string — fix trailing commas and strip control chars.
 */
function sanitizeJSON(s: string): string {
  return s.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/,\s*([}\]])/g, '$1');
}

/**
 * Attempt to parse a string as JSON, applying progressive repairs.
 */
function tryParse(s: string): any | null {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(sanitizeJSON(s)); } catch {}
  return null;
}

/**
 * Find the position just after the last complete top-level element in
 * a truncated JSON array or object. Walks backward from the end to
 * find the last '}' or ']' that closes a complete element.
 */
function findLastCompleteElement(text: string, from: number): number {
  // Walk backward to find the last `}` or `]` that sits at depth=1
  // (i.e. it closes a direct child element inside the outer container).
  let depth = 0;
  let inStr = false;
  let esc = false;
  // First, determine the outer depth by scanning forward from `from`
  let outerDepth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') { outerDepth = 1; break; }
  }

  // Now scan forward tracking depth, recording each position where
  // a child element closes (depth goes from 2 back to 1).
  let lastClose = -1;
  depth = 0;
  inStr = false;
  esc = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1) {
        // This closes a child element — record position after it
        lastClose = i + 1;
      }
    }
  }
  return lastClose;
}

/**
 * Robustly extract JSON from an AI text response.
 *
 * Handles: markdown fences, truncated responses (unbalanced braces),
 * trailing commas, control characters inside strings.
 * Returns partial data from truncated JSON rather than throwing.
 */
export function extractJSON(text: string): any {
  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Try full text first
  const direct = tryParse(cleaned);
  if (direct !== null) return direct;

  // Find the outermost JSON object/array with proper brace tracking
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = cleaned.slice(start, i + 1);
        const result = tryParse(candidate);
        if (result !== null) return result;
      }
    }
  }

  // If braces are balanced but nothing parsed, bail
  if (start === -1) {
    console.error('[AI:JSON] No JSON structure found in response');
    throw new Error('Failed to extract valid JSON from AI response');
  }

  // --- Truncated response recovery ---
  // The JSON is unbalanced (depth > 0) meaning the response was cut off.
  if (depth > 0) {
    console.warn(`[AI:JSON] Truncated response detected (unclosed depth=${depth}). Attempting recovery...`);

    const fragment = cleaned.slice(start);

    // Strategy 1: Find the last complete child element, truncate there, close containers
    const lastComplete = findLastCompleteElement(fragment, 0);
    if (lastComplete > 0) {
      // Scan the truncation point to determine what closers we need
      let closers = '';
      let d = 0;
      let s = false;
      let e = false;
      const stack: string[] = [];
      for (let i = 0; i < lastComplete; i++) {
        const ch = fragment[i];
        if (e) { e = false; continue; }
        if (ch === '\\' && s) { e = true; continue; }
        if (ch === '"') { s = !s; continue; }
        if (s) continue;
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
      }
      closers = stack.reverse().join('');

      const truncated = sanitizeJSON(fragment.slice(0, lastComplete) + closers);
      const result = tryParse(truncated);
      if (result !== null) {
        console.log('[AI:JSON] Recovery succeeded via last-complete-element truncation');
        return result;
      }
    }

    // Strategy 2: Progressively scan backward for `},` or `}]` boundaries
    // that give us the last complete object in the top-level array.
    const patterns = [/\}\s*,\s*$/m, /\}\s*$/m, /\]\s*,\s*$/m, /"\s*$/m];
    for (const pattern of patterns) {
      for (let cutLen = fragment.length - 1; cutLen > fragment.length * 0.3; cutLen--) {
        const slice = fragment.slice(0, cutLen);
        if (!pattern.test(slice)) continue;

        // Remove any trailing comma and close all open containers
        let attempt = slice.replace(/,\s*$/, '');
        // Count open containers
        let openBraces = 0, openBrackets = 0;
        let inS = false, esc2 = false;
        for (let i = 0; i < attempt.length; i++) {
          const c = attempt[i];
          if (esc2) { esc2 = false; continue; }
          if (c === '\\' && inS) { esc2 = true; continue; }
          if (c === '"') { inS = !inS; continue; }
          if (inS) continue;
          if (c === '{') openBraces++;
          else if (c === '}') openBraces--;
          else if (c === '[') openBrackets++;
          else if (c === ']') openBrackets--;
        }
        attempt += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
        const result = tryParse(sanitizeJSON(attempt));
        if (result !== null) {
          console.log(`[AI:JSON] Recovery succeeded via backward scan (cut ${fragment.length - cutLen} chars)`);
          return result;
        }
        break; // Only try first match per pattern
      }
    }

    // Strategy 3: Brute force — try closing at every `}` from the end backward
    const bracePositions: number[] = [];
    let inS3 = false, esc3 = false;
    for (let i = 0; i < fragment.length; i++) {
      const c = fragment[i];
      if (esc3) { esc3 = false; continue; }
      if (c === '\\' && inS3) { esc3 = true; continue; }
      if (c === '"') { inS3 = !inS3; continue; }
      if (inS3) continue;
      if (c === '}') bracePositions.push(i);
    }

    // Try from the last `}` backward
    for (let bi = bracePositions.length - 1; bi >= 0 && bi >= bracePositions.length - 30; bi--) {
      const pos = bracePositions[bi] + 1;
      let attempt = fragment.slice(0, pos);
      // Count open containers
      let ob = 0, ok = 0;
      let inS4 = false, esc4 = false;
      for (let i = 0; i < attempt.length; i++) {
        const c = attempt[i];
        if (esc4) { esc4 = false; continue; }
        if (c === '\\' && inS4) { esc4 = true; continue; }
        if (c === '"') { inS4 = !inS4; continue; }
        if (inS4) continue;
        if (c === '{') ob++;
        else if (c === '}') ob--;
        else if (c === '[') ok++;
        else if (c === ']') ok--;
      }
      attempt += ']'.repeat(Math.max(0, ok)) + '}'.repeat(Math.max(0, ob));
      const result = tryParse(sanitizeJSON(attempt));
      if (result !== null) {
        console.log(`[AI:JSON] Recovery succeeded via brace-position scan (position ${bi}/${bracePositions.length})`);
        return result;
      }
    }
  }

  console.error('[AI:JSON] All recovery strategies exhausted. First 500 chars:', cleaned.slice(0, 500));
  console.error('[AI:JSON] Last 500 chars:', cleaned.slice(-500));
  throw new Error('Failed to extract valid JSON from AI response');
}

export async function extractFindings(
  document: ParsedDocument,
  assetType: AssetType,
  criteria: CriteriaRuleSet,
  options?: {
    uwDocument?: ParsedDocument | null;
    crossCheckFindings?: CrossCheckFinding[];
    research?: ResearchResults | null;
  }
): Promise<{ findings: Finding[]; criteriaEvaluations: CriteriaEvaluation[] }> {
  const prompt = buildFindingsPrompt(assetType, document.sections, criteria.rules, {
    uwSections: options?.uwDocument?.sections,
    crossCheckFindings: options?.crossCheckFindings,
    research: options?.research || undefined,
  });

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxContinuations: 2,
  });

  console.log('[AI:Findings] Total response length:', text.length);
  const parsed = extractJSON(text);
  console.log('[AI:Findings] Parsed type:', Array.isArray(parsed) ? 'array' : typeof parsed, 'keys:', Array.isArray(parsed) ? `[${parsed.length} items]` : JSON.stringify(Object.keys(parsed)));

  // Flexibly find the findings array — AI uses many structures
  let rawFindings: any[] = [];
  if (Array.isArray(parsed)) {
    rawFindings = parsed;
  } else {
    // Try direct keys first
    for (const key of Object.keys(parsed)) {
      const val = parsed[key];
      if (Array.isArray(val) && val.length > 0) {
        rawFindings = val;
        console.log('[AI:Findings] Found array under key:', key, 'length:', val.length);
        break;
      }
    }
    // If not found, try nested objects (redFlags.high, redFlags.medium etc.)
    if (rawFindings.length === 0) {
      for (const key of Object.keys(parsed)) {
        const val = parsed[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const subKey of Object.keys(val)) {
            if (Array.isArray(val[subKey])) {
              rawFindings.push(...val[subKey]);
            }
          }
          if (rawFindings.length > 0) {
            console.log('[AI:Findings] Found nested arrays under key:', key, 'total:', rawFindings.length);
            break;
          }
        }
      }
    }
  }
  console.log('[AI:Findings] Found', rawFindings.length, 'findings');

  // Map to Finding[] type
  const findings: Finding[] = rawFindings.map((f: any) => ({
    id: uuid(),
    category: f.category || 'cash_flow',
    severity: f.severity || 'medium',
    title: f.title || f.name || 'Unnamed Finding',
    explanation: f.explanation || f.description || '',
    confidence: f.confidence || 'medium',
    pageReferences: (f.pageReferences || f.sources || []).map((ref: any) => ({
      page: ref.page || ref.pageNumber || 1,
      sectionId: ref.sectionId || '',
      sectionTitle: ref.sectionTitle || ref.section || '',
      excerpt: ref.excerpt || ref.quote || '',
    })),
    appliedRuleId: f.ruleId || f.appliedRuleId || undefined,
    impact: {
      metric: f.impact?.metric || undefined,
      currentValue: f.impact?.currentValue || undefined,
      adjustedValue: f.impact?.adjustedValue || undefined,
      description: f.impact?.description || f.creditImpact || '',
    },
  }));

  // Flexibly find criteria evaluations
  let rawEvals: any[] = [];
  for (const key of Object.keys(parsed)) {
    if (key.toLowerCase().includes('criteria') || key.toLowerCase().includes('rule') || key.toLowerCase().includes('eval')) {
      const val = parsed[key];
      if (Array.isArray(val)) { rawEvals = val; break; }
    }
  }

  const criteriaEvaluations: CriteriaEvaluation[] = rawEvals.map((e: any) => ({
    ruleId: e.ruleId || e.id || '',
    ruleName: e.ruleName || e.name || '',
    result: e.result || 'unknown',
    reason: e.reason || e.explanation || '',
    source: e.source || undefined,
  }));

  // Ensure all criteria rules have evaluations
  for (const rule of criteria.rules) {
    if (!criteriaEvaluations.find((e) => e.ruleId === rule.id)) {
      criteriaEvaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        result: 'unknown',
        reason: 'Not evaluated — insufficient data in document',
        source: undefined,
      });
    }
  }

  return { findings, criteriaEvaluations };
}

export async function extractUnderwriting(
  document: ParsedDocument,
  assetType: AssetType,
  extractionResult?: import('@cre/shared').ExtractionResult | null,
  sellerMetrics?: import('@cre/shared').SellerExtractedMetrics | null,
): Promise<UnderwritingModel> {
  const prompt = buildUWPrompt(assetType, document.sections);

  // Use a focused extraction system message. The default SYSTEM_PROMPT instructs
  // the model to write adversarial credit-officer prose, which conflicts with
  // strict JSON extraction and causes critical scalars (loan amount, cap rate,
  // interest rate) to come back missing or zero.
  const UW_EXTRACTION_SYSTEM = 'You extract structured underwriting data from CRE documents and return it as a single valid JSON object matching the requested schema. Never add prose, commentary, or markdown.';

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    system: UW_EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  console.log('[AI:UW] Response length:', text.length);
  let parsed: any;
  try {
    parsed = extractJSON(text);
  } catch (err) {
    console.error('[AI:UW] JSON extraction failed. Raw response head:', text.slice(0, 500));
    parsed = {};
  }
  const fullJson = JSON.stringify(parsed);
  console.log('[AI:UW] Full JSON length:', fullJson.length);
  const capMatch = fullJson.match(/"(?:cap_rate|capRate|capitalization_rate|going_in_cap_rate)"\s*:\s*([0-9.]+)/);
  const rateMatch = fullJson.match(/"(?:interest_rate|interestRate)"\s*:\s*([0-9.]+)/);
  const amortMatch = fullJson.match(/"(?:amortization|amortization_years)"\s*:\s*([0-9.]+)/);
  console.log('[AI:UW] Regex cap_rate:', capMatch?.[1], 'interest_rate:', rateMatch?.[1], 'amortization:', amortMatch?.[1]);

  // ---- NORMALIZE TO DEAL SHAPE + HARD GATE ----
  // Every scalar from every source is routed through the canonical normalizer
  // (normalizeFinancialValue). No inline Number(), no $/% stripping, no local
  // type coercion is permitted in this layer — that is the normalizer's job.
  //
  // Fall-through order: AI underwriting JSON → AI seller-metric output →
  // deterministic synonym/regex extraction. If all three are null after
  // normalization, STOP underwriting with INCOMPLETE INPUT DATA.

  const json = parsed || {};
  const ef = (extractionResult?.fields ?? {}) as any;
  const sm = (sellerMetrics ?? {}) as any;

  const norm = (raw: unknown, kind: keyof typeof CORE_FIELD_KIND) =>
    normalizeFinancialValue(raw, CORE_FIELD_KIND[kind]);

  // Note: ef.X.value is already canonical (extractCoreFields normalized it),
  // but we run it through again — normalization is idempotent on numeric input
  // and this guarantees a single contract at the boundary.
  const deal = {
    noi:          norm(json.noi,           'noi')          ?? norm(sm.noi,          'noi')          ?? norm(ef.noi?.value,          'noi')          ?? null,
    loanAmount:   norm(json.loan_amount,   'loanAmount')   ?? norm(sm.loanAmount,   'loanAmount')   ?? norm(ef.loanAmount?.value,   'loanAmount')   ?? null,
    capRate:      norm(json.cap_rate,      'capRate')      ?? norm(sm.capRate,      'capRate')      ?? norm(ef.capRate?.value,      'capRate')      ?? null,
    interestRate: norm(json.interest_rate, 'interestRate') ?? norm(sm.interestRate, 'interestRate') ?? norm(ef.interestRate?.value, 'interestRate') ?? null,
  };

  console.log('[AI:UW] Deal normalized:', JSON.stringify(deal), '| sources:', JSON.stringify({
    json: { noi: json.noi, loan_amount: json.loan_amount, cap_rate: json.cap_rate, interest_rate: json.interest_rate },
    sm:   { noi: sm.noi?.value, loanAmount: sm.loanAmount?.value, capRate: sm.capRate?.value, interestRate: sm.interestRate?.value },
    ef:   { noi: ef.noi?.value, loanAmount: ef.loanAmount?.value, capRate: ef.capRate?.value, interestRate: ef.interestRate?.value },
  }));

  // Gate treats null, 0, and non-finite as missing. The canonical normalizer
  // already returns null for 0 currency / 0 rate / 0 cap_rate, but this gate
  // is the last line of defense before the value flows into the underwriting
  // model — so we re-check explicitly.
  const missing: string[] = [];
  const isMissing = (v: number | null | undefined): boolean =>
    v === null || v === undefined || v === 0 || !Number.isFinite(v);
  if (isMissing(deal.noi))          missing.push('noi');
  if (isMissing(deal.loanAmount))   missing.push('loan_amount');
  if (isMissing(deal.capRate))      missing.push('cap_rate');
  if (isMissing(deal.interestRate)) missing.push('interest_rate');

  if (missing.length) {
    throw new Error(`INCOMPLETE INPUT DATA — missing: ${missing.join(', ')}`);
  }

  // Build the model from the AI response, then apply the normalized deal values
  // so the four critical scalars are guaranteed non-null before recalculation.
  //
  // Canonical ingestion contract (post-normalizeFinancialValue):
  //   deal.capRate      → decimal fraction (0.045)
  //   deal.interestRate → decimal fraction (0.0675)
  //
  // Legacy model contract (consumed by uw-calc.ts — out of scope to change):
  //   model.capRate     → decimal fraction  (impliedValuePrimitive: noi / capRate)
  //   model.interestRate → percent           (calculateAnnualDebtService: rate/100/12)
  //
  // Bridge interestRate decimal→percent at the boundary so calculateAnnualDebtService
  // continues to work unchanged. capRate flows through decimal (matches SSOT).
  const model = buildUWModel(parsed);
  model.loanAmount = deal.loanAmount!;
  model.loanDetails.loanAmount = deal.loanAmount!;
  model.capRate = deal.capRate!;
  const interestRatePercent = deal.interestRate! * 100;
  model.interestRate = interestRatePercent;
  model.loanDetails.interestRate = interestRatePercent;
  if ((model.income.grossPotentialRent.annualAmount || 0) === 0 && model.netOperatingIncome === 0) {
    model.income.grossPotentialRent.annualAmount = deal.noi!;
    model.income.grossPotentialRent.originalValue = deal.noi!;
  }

  return recalculateFullModel(model);
}

export async function generateCreditScore(
  assetType: AssetType,
  findings: Finding[],
  uwModel: UnderwritingModel,
  criteriaEvaluations: CriteriaEvaluation[],
  weights: Record<string, number>
): Promise<CreditScore> {
  const anthropic = getClient();

  const uwSummary: any = {
    noi: uwModel.netOperatingIncome,
    dscr: uwModel.dscr,
    ltv: uwModel.ltv,
    debtYield: uwModel.debtYield,
    capRate: uwModel.capRate,
    loanAmount: uwModel.loanAmount,
    impliedValue: uwModel.impliedValue,
  };
  if (uwModel.loanDetails) {
    uwSummary.loanStructure = {
      ioMonths: uwModel.loanDetails.ioMonths,
      termMonths: uwModel.loanDetails.termMonths,
      amortizationMonths: uwModel.loanDetails.amortizationMonths,
      rateType: uwModel.loanDetails.rateType,
    };
  }
  if (uwModel.repaymentSchedule) {
    uwSummary.repaymentSummary = {
      balloonBalance: uwModel.repaymentSchedule.summary.balloonBalance,
      balloonDate: uwModel.repaymentSchedule.summary.balloonDate,
      minMonthlyDSCR: uwModel.repaymentSchedule.summary.minDSCR,
      averageDSCR: uwModel.repaymentSchedule.summary.averageDSCR,
      totalInterest: uwModel.repaymentSchedule.summary.totalInterest,
    };
  }

  const prompt = buildScoringPrompt(
    assetType,
    JSON.stringify(findings.slice(0, 20)), // Limit to top 20 findings for token efficiency
    JSON.stringify(uwSummary),
    JSON.stringify(criteriaEvaluations),
    JSON.stringify(weights)
  );

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  console.log('[AI:Score] Response length:', text.length);

  const parsed = extractJSON(text);
  console.log('[AI:Score] Parsed keys:', Object.keys(parsed));

  // Numeric outputs (overall, categories, riskTier, recommendation) are
  // produced deterministically from findings + weights via the SSOT engine
  // in @cre/shared. The AI is restricted to narrative text. This eliminates
  // AI/recalc divergence — the consistency check is mathematically guaranteed
  // to pass because both sides use the same engine.
  const deterministic = computeDeterministicScore(findings, weights as Record<FindingCategory, number>);

  // Pull AI-authored explanations onto the deterministic categories so users
  // still see the credit-officer reasoning per category.
  const aiCategories: any[] = parsed.categories || [];
  const aiCategoryByName = new Map<string, any>(
    aiCategories.map((c: any) => [String(c.category), c]),
  );
  const categories = deterministic.categories.map(cat => {
    const aiCat = aiCategoryByName.get(cat.category);
    return {
      ...cat,
      explanation: aiCat?.explanation ?? '',
    };
  });

  return {
    overall: deterministic.overall,
    categories,
    recommendation: deterministic.recommendation,
    riskTier: deterministic.riskTier,
    // Narrative text fields remain AI-authored. They are subjective and add
    // value beyond the numeric score — but they cannot influence the number.
    narrative: parsed.narrative || parsed.creditNarrative || '',
    whyThisScore: parsed.whyThisScore || parsed.why_this_score || '',
    howToImprove: parsed.howToImprove || parsed.how_to_improve || '',
  };
}

// Recursively extract a numeric value from a nested object, trying multiple key patterns
function dig(obj: any, ...keys: string[]): number {
  if (!obj || typeof obj !== 'object') return 0;

  for (const key of keys) {
    if (obj[key] !== undefined) {
      const val = obj[key];
      if (typeof val === 'number') return val;
      if (typeof val === 'object' && val !== null) {
        return val.annual_amount || val.annualAmount || val.amount || val.value || 0;
      }
    }
  }

  // Deep search: recurse into sub-objects (handles as_is/stabilized nesting)
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const found = dig(val, ...keys);
      if (found !== 0) return found;
    }
  }

  return 0;
}

// Unwrap the AI response to find the UW model data regardless of nesting
function unwrapUWData(raw: any): any {
  // If the AI wrapped it in a key like "underwriting_model" or "model"
  for (const key of ['underwriting_model', 'underwritingModel', 'model', 'data', 'uwModel']) {
    if (raw[key] && typeof raw[key] === 'object') {
      return raw[key];
    }
  }
  return raw;
}

// Helper to build UW model from AI-extracted data
function buildUWModel(rawData: any): UnderwritingModel {
  const data = unwrapUWData(rawData);

  const makeLineItem = (label: string, amount: number, page?: number): LineItem => ({
    id: uuid(),
    label,
    annualAmount: amount || 0,
    isEditable: true,
    isOverridden: false,
    originalValue: amount || 0,
    source: page ? { page, sectionId: '' } : undefined,
  });

  // Find income section — AI may use various keys or flat structure
  const income = data.income || data.revenue || data.revenue_items || data.incomeItems || {};
  const expenses = data.expenses || data.operatingExpenses || data.operating_expenses || data.expense_items || data.expenseItems || {};
  const loan = data.loan || data.loanTerms || data.loan_terms || data.loan_summary || {};

  // Every value pulled from raw AI JSON is routed through the canonical
  // normalizer. `dig` may return strings ("$1,250,000") or numbers from
  // arbitrary AI shapes; normalizeFinancialValue gives a single canonical
  // contract regardless. No inline parseFloat / Number() / regex fallbacks.
  const C = (raw: unknown) => normalizeFinancialValue(raw, 'currency') ?? 0;
  const N = (raw: unknown) => normalizeFinancialValue(raw, 'raw_number') ?? 0;
  const CAP = (raw: unknown) => normalizeFinancialValue(raw, 'cap_rate');
  const RATE = (raw: unknown) => normalizeFinancialValue(raw, 'rate');

  const gpr = C(dig(data, 'gross_potential_rent', 'grossPotentialRent') || dig(income, 'grossPotentialRent', 'gross_potential_rent', 'gpr', 'GPR'));
  const vacancy = C(dig(data, 'vacancy_loss', 'vacancyLoss') || dig(income, 'vacancyLoss', 'vacancy_loss', 'vacancy'));
  const concessions = C(dig(data, 'concessions') || dig(income, 'concessions'));
  const otherIncome = C(dig(data, 'other_income', 'otherIncome') || dig(income, 'otherIncome', 'other_income', 'miscIncome'));

  const taxes = C(dig(data, 'real_estate_taxes', 'realEstateTaxes') || dig(expenses, 'realEstateTaxes', 'real_estate_taxes', 'taxes'));
  const insurance = C(dig(data, 'insurance') || dig(expenses, 'insurance'));
  const utilities = C(dig(data, 'utilities') || dig(expenses, 'utilities'));
  const rm = C(dig(data, 'repairs_and_maintenance', 'repairsAndMaintenance') || dig(expenses, 'repairsAndMaintenance', 'repairs_and_maintenance', 'maintenance'));
  const mgmt = C(dig(data, 'management_fee', 'management') || dig(expenses, 'management', 'managementFee', 'management_fee'));
  const ga = C(dig(data, 'general_and_admin', 'generalAndAdmin') || dig(expenses, 'generalAndAdmin', 'general_and_admin', 'general_and_administrative'));
  const payroll = C(dig(data, 'payroll') || dig(expenses, 'payroll'));
  const reserves = C(dig(data, 'replacement_reserves', 'replacementReserves') || dig(expenses, 'replacementReserves', 'replacement_reserves', 'reserves'));

  // Critical scalars: produce canonical decimal-fraction rates and dollar
  // currency. These are placeholders — the four critical scalars are
  // re-overwritten in extractUnderwriting() with the post-fall-through deal
  // values, also via the canonical normalizer.
  const capRateRaw = dig(data, 'capRate', 'cap_rate', 'capitalizationRate', 'capitalization_rate', 'going_in_cap_rate');
  const capRateDecimal = CAP(capRateRaw) ?? 0;
  const loanAmount = C(dig(loan, 'loanAmount', 'loan_amount', 'amount') || dig(data, 'loanAmount', 'loan_amount'));
  const interestRateDecimal = RATE(dig(loan, 'interestRate', 'interest_rate', 'rate') || dig(data, 'interestRate', 'interest_rate')) ?? 0;
  // Bridge to legacy uw-calc.ts contract: model.interestRate is consumed as percent.
  const interestRate = interestRateDecimal * 100;
  const amort = N(dig(loan, 'amortizationYears', 'amortization_years', 'amortization') || dig(data, 'amortization', 'amortization_years')) || 30;
  const term = N(dig(loan, 'termYears', 'term_years', 'term') || dig(data, 'term', 'term_years')) || 10;
  const sqftRaw = dig(data, 'totalSqFt', 'total_sqft', 'squareFeet', 'square_feet', 'nra', 'net_rentable_area', 'nra_sf');
  const sqft = sqftRaw ? (normalizeFinancialValue(sqftRaw, 'count') ?? undefined) : undefined;

  // Extract loan detail fields
  const ioMonths = N(dig(data, 'io_months', 'ioMonths', 'io_period_months')
    || dig(loan, 'io_months', 'ioMonths', 'io_period_months', 'interestOnlyMonths'));
  const rateType = (data.rate_type || data.rateType || loan.rate_type || loan.rateType || 'fixed') as 'fixed' | 'floating';
  const paymentFrequency = (data.payment_frequency || data.paymentFrequency || loan.payment_frequency || loan.paymentFrequency || 'monthly') as 'monthly' | 'quarterly';
  const prepaymentTerms = data.prepayment_terms || data.prepaymentTerms || loan.prepayment_terms || loan.prepaymentTerms || '';

  const loanDetails: LoanDetails = {
    loanAmount,
    interestRate,
    rateType,
    ioMonths,
    amortizationMonths: amort * 12,
    termMonths: term * 12,
    paymentFrequency,
    prepaymentTerms,
    originationDate: new Date().toISOString().slice(0, 10),
  };

  console.log('[AI:UW] Extracted: GPR=', gpr, 'Vacancy=', vacancy, 'CapRate(decimal)=', capRateDecimal, 'Loan=', loanAmount, 'IRate(decimal)=', interestRateDecimal, 'IO=', ioMonths, 'months');

  return {
    income: {
      grossPotentialRent: makeLineItem('Gross Potential Rent', gpr),
      vacancyLoss: makeLineItem('Vacancy Loss', vacancy < 0 ? vacancy : -Math.abs(vacancy)),
      concessions: makeLineItem('Concessions', concessions < 0 ? concessions : -Math.abs(concessions)),
      otherIncome: makeLineItem('Other Income', otherIncome),
      effectiveGrossIncome: makeLineItem('Effective Gross Income', 0),
      additionalItems: [],
    },
    expenses: {
      realEstateTaxes: makeLineItem('Real Estate Taxes', taxes),
      insurance: makeLineItem('Insurance', insurance),
      utilities: makeLineItem('Utilities', utilities),
      repairsAndMaintenance: makeLineItem('Repairs & Maintenance', rm),
      management: makeLineItem('Management Fee', mgmt),
      generalAndAdmin: makeLineItem('General & Admin', ga),
      payroll: makeLineItem('Payroll', payroll),
      replacementReserves: makeLineItem('Replacement Reserves', reserves),
      totalExpenses: makeLineItem('Total Expenses', 0),
      additionalItems: [],
    },
    netOperatingIncome: 0,
    capRate: capRateDecimal,
    impliedValue: 0,
    loanAmount,
    interestRate,
    amortizationYears: amort,
    termYears: term,
    annualDebtService: 0,
    dscr: 0,
    ltv: 0,
    debtYield: 0,
    totalUnits: normalizeFinancialValue(data.totalUnits || data.total_units || data.units, 'count') ?? undefined,
    totalSqFt: sqft,
    asReported: true,
    modifiedCells: [],
    loanDetails,
    repaymentSchedule: null,
  };
}

// --- Cross-Validation ---

export async function extractSellerMetrics(
  asrDocument: ParsedDocument,
  assetType: AssetType,
  uwDocument?: ParsedDocument | null,
): Promise<import('@cre/shared').SellerExtractedMetrics> {
  const prompt = buildSellerMetricExtractionPrompt(
    assetType,
    asrDocument.sections,
    uwDocument?.sections,
  );

  // Use a minimal, extraction-specific system message. The default SYSTEM_PROMPT
  // instructs the model to act as an adversarial credit officer — that directly
  // contradicts the "DO NOT underwrite, JSON only" extraction prompt and causes
  // the model to wrap output in commentary, breaking JSON parsing downstream.
  const EXTRACTION_SYSTEM = 'You are a deterministic financial-data extraction engine. Return ONLY valid JSON matching the requested schema. No prose, no commentary, no markdown.';

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  console.log('[AI:SellerMetrics] Response length:', text.length);
  let parsed: any;
  try {
    parsed = extractJSON(text);
  } catch (err) {
    console.error('[AI:SellerMetrics] JSON extraction failed. Raw response head:', text.slice(0, 500));
    // Fall back to all-missing metrics so the pipeline can still continue
    // (synonym search and derivation in extractCoreFields will fill what they can).
    parsed = {};
  }

  // Every AI-supplied scalar is routed through the canonical normalizer.
  // No inline numeric coercion is permitted in this layer.
  const toEntry = (key: keyof typeof CORE_FIELD_KIND) => {
    const raw = parsed[key];
    const normalized = normalizeFinancialValue(raw?.value, CORE_FIELD_KIND[key]);
    const explicitStatus = raw?.status === 'found' || raw?.status === 'missing' ? raw.status : null;
    const status: 'found' | 'missing' =
      explicitStatus ?? (normalized === null ? 'missing' : 'found');
    const confidenceRaw = typeof raw?.confidence === 'number' ? raw.confidence : null;
    const confidence = confidenceRaw === null
      ? (status === 'missing' ? 0 : 0.5)
      : Math.max(0, Math.min(1, confidenceRaw));
    return {
      value: normalized,
      source: raw?.source ?? (status === 'missing' ? 'not found in document' : ''),
      confidence,
      status,
    };
  };

  return {
    noi:           toEntry('noi'),
    loanAmount:    toEntry('loanAmount'),
    interestRate:  toEntry('interestRate'),
    capRate:       toEntry('capRate'),
    propertyValue: toEntry('propertyValue'),
    debtService:   toEntry('debtService'),
    dscr:          toEntry('dscr'),
  };
}

// Legacy alias
export const crossValidateDocuments = extractSellerMetrics;

// --- Entity Extraction for Research ---

export async function extractResearchEntities(
  document: ParsedDocument
): Promise<{ sponsorName: string | null; propertyName: string | null; propertyAddress: string | null; city: string | null }> {
  const prompt = buildEntityExtractionPrompt(document.sections);

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
    maxContinuations: 0,
  });
  const parsed = extractJSON(text);

  return {
    sponsorName: parsed.sponsorName || parsed.sponsor_name || null,
    propertyName: parsed.propertyName || parsed.property_name || null,
    propertyAddress: parsed.propertyAddress || parsed.property_address || null,
    city: parsed.city || null,
  };
}

// --- Mitigation Strategies ---

export async function generateMitigations(
  assetType: AssetType,
  findings: Finding[],
  uwModel: UnderwritingModel,
  crossCheckFindings?: CrossCheckFinding[]
): Promise<MitigationStrategy[]> {
  const criticalHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  if (criticalHigh.length === 0) return [];

  const prompt = buildMitigationPrompt(assetType, findings, uwModel, crossCheckFindings);

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  console.log('[AI:Mitigations] Response length:', text.length);
  const parsed = extractJSON(text);

  const rawMitigations: any[] = Array.isArray(parsed) ? parsed : (parsed.mitigations || parsed.strategies || []);
  console.log('[AI:Mitigations] Found', rawMitigations.length, 'mitigation strategies');

  return rawMitigations.map((m: any) => ({
    id: uuid(),
    findingId: m.findingId || m.finding_id || '',
    strategy: m.strategy || m.name || '',
    description: m.description || '',
    structuralChanges: m.structuralChanges || m.structural_changes || [],
    financialImpact: {
      targetMetric: m.financialImpact?.targetMetric || m.financial_impact?.target_metric || '',
      currentValue: m.financialImpact?.currentValue || m.financial_impact?.current_value || 0,
      projectedValue: m.financialImpact?.projectedValue || m.financial_impact?.projected_value || 0,
      improvement: m.financialImpact?.improvement || m.financial_impact?.improvement || '',
    },
    requiredReserve: m.requiredReserve || m.required_reserve || undefined,
    requiredEquity: m.requiredEquity || m.required_equity || undefined,
    riskReduction: m.riskReduction || m.risk_reduction || 'moderate',
  }));
}

// --- Executive Summary ---

export async function generateExecutiveSummary(
  assetType: AssetType,
  findings: Finding[],
  uwModel: UnderwritingModel,
  crossCheckCount: number,
  researchAvailable: boolean,
  stressScenarios: any[]
): Promise<string> {
  const anthropic = getClient();

  const execUwData: any = {
    noi: uwModel.netOperatingIncome,
    dscr: uwModel.dscr,
    ltv: uwModel.ltv,
    debtYield: uwModel.debtYield,
    capRate: uwModel.capRate,
    loanAmount: uwModel.loanAmount,
    impliedValue: uwModel.impliedValue,
  };
  if (uwModel.loanDetails) {
    execUwData.loanStructure = {
      ioMonths: uwModel.loanDetails.ioMonths,
      termMonths: uwModel.loanDetails.termMonths,
      amortizationMonths: uwModel.loanDetails.amortizationMonths,
      rateType: uwModel.loanDetails.rateType,
      prepaymentTerms: uwModel.loanDetails.prepaymentTerms,
    };
  }
  if (uwModel.repaymentSchedule) {
    execUwData.repaymentSummary = {
      balloonBalance: uwModel.repaymentSchedule.summary.balloonBalance,
      balloonDate: uwModel.repaymentSchedule.summary.balloonDate,
      minMonthlyDSCR: uwModel.repaymentSchedule.summary.minDSCR,
    };
  }
  const uwSummary = JSON.stringify(execUwData);

  const prompt = buildExecutiveSummaryPrompt(
    assetType,
    JSON.stringify(findings.slice(0, 15).map((f) => ({ severity: f.severity, title: f.title, category: f.category }))),
    uwSummary,
    crossCheckCount,
    researchAvailable,
    JSON.stringify(stressScenarios.map((s) => ({
      name: s.name,
      dscr: s.results?.dscr,
      ltv: s.results?.ltv,
      breaksCovenants: s.breaksCovenants,
      covenantBreaches: s.covenantBreaches,
    })))
  );

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  console.log('[AI:ExecSummary] Response length:', text.length);
  return text.trim();
}

// --- B-Piece Decision ---

export async function generateBPieceDecision(
  assetType: AssetType,
  findings: Finding[],
  uwModel: UnderwritingModel,
  mitigations: any[],
  stressScenarios: any[],
  creditScore: CreditScore,
  crossCheckFindings: any[]
): Promise<BPieceDecision> {
  const anthropic = getClient();

  const bpUwData: any = {
    noi: uwModel.netOperatingIncome,
    dscr: uwModel.dscr,
    ltv: uwModel.ltv,
    debtYield: uwModel.debtYield,
    capRate: uwModel.capRate,
    loanAmount: uwModel.loanAmount,
    impliedValue: uwModel.impliedValue,
  };
  if (uwModel.loanDetails) {
    bpUwData.loanStructure = {
      ioMonths: uwModel.loanDetails.ioMonths,
      termMonths: uwModel.loanDetails.termMonths,
      amortizationMonths: uwModel.loanDetails.amortizationMonths,
      rateType: uwModel.loanDetails.rateType,
      prepaymentTerms: uwModel.loanDetails.prepaymentTerms,
    };
  }
  if (uwModel.repaymentSchedule) {
    bpUwData.repaymentSummary = {
      balloonBalance: uwModel.repaymentSchedule.summary.balloonBalance,
      balloonDate: uwModel.repaymentSchedule.summary.balloonDate,
      minMonthlyDSCR: uwModel.repaymentSchedule.summary.minDSCR,
      averageDSCR: uwModel.repaymentSchedule.summary.averageDSCR,
    };
  }
  const uwSummary = JSON.stringify(bpUwData);

  const prompt = buildBPieceDecisionPrompt(
    assetType,
    JSON.stringify(findings.slice(0, 15).map((f) => ({ id: f.id, severity: f.severity, title: f.title, category: f.category, confidence: f.confidence }))),
    uwSummary,
    JSON.stringify(mitigations.slice(0, 10).map((m) => ({ strategy: m.strategy, riskReduction: m.riskReduction, financialImpact: m.financialImpact }))),
    JSON.stringify(stressScenarios.map((s) => ({ name: s.name, dscr: s.results?.dscr, ltv: s.results?.ltv, breaksCovenants: s.breaksCovenants }))),
    JSON.stringify({ overall: creditScore.overall, recommendation: creditScore.recommendation, riskTier: creditScore.riskTier, narrative: creditScore.narrative }),
    JSON.stringify(crossCheckFindings.slice(0, 10).map((c: any) => ({ metric: c.metric, difference: c.difference, severity: c.severity })))
  );

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 5000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  console.log('[AI:BPiece] Response length:', text.length);
  const parsed = extractJSON(text);

  return {
    recommendation: parsed.recommendation || 'further_review',
    conviction: parsed.conviction || 'moderate',
    dealBreakers: parsed.dealBreakers || parsed.deal_breakers || [],
    keyConditions: parsed.keyConditions || parsed.key_conditions || [],
    pricingGuidance: parsed.pricingGuidance || parsed.pricing_guidance || '',
    summary: parsed.summary || '',
  };
}

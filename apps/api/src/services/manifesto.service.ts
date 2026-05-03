import { v4 as uuid } from 'uuid';
import { store } from '../storage/sqlite-store.js';
import { parseDocument } from './document-parser.service.js';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { invalidateCacheForAssetType } from './consistency-engine.service.js';
import type {
  AssetType, FindingCategory, Severity,
  ManifestoExtractedRule, ManifestoAmbiguity,
  CreditManifestoDetail,
} from '@cre/shared';
import { CriteriaRule, CriteriaRuleSet, DEFAULT_SCORING_WEIGHTS } from '@cre/shared';

const ALL_ASSET_TYPES: AssetType[] = [
  'office', 'multifamily', 'retail', 'industrial',
  'hotel', 'self_storage', 'mixed_use', 'manufactured_housing',
];

// --- Public API ---

export async function processManifestoUpload(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  uploadedBy: string
): Promise<{ id: string; version: number }> {
  const rawText = await extractManifestoText(fileBuffer, fileName, mimeType);

  if (!rawText || rawText.trim().length < 50) {
    throw new Error('Manifesto document appears empty or too short to contain credit rules.');
  }

  const id = uuid();
  const { version } = store.createManifesto(id, fileName, fileBuffer, rawText, uploadedBy);

  // Async extraction — caller polls for status
  extractAndActivateManifesto(id, rawText).catch(err => {
    console.error('[Manifesto] Extraction failed:', err);
    store.failManifesto(id, err.message || 'Rule extraction failed');
  });

  return { id, version };
}

export function hasActiveManifesto(): boolean {
  return store.hasActiveManifesto();
}

// --- Internal ---

async function extractManifestoText(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const ext = fileName.toLowerCase().split('.').pop();

  if (ext === 'txt' || mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }

  const parsed = await parseDocument(buffer, fileName, mimeType);
  return parsed.rawText;
}

async function extractAndActivateManifesto(
  manifestoId: string,
  rawText: string,
): Promise<void> {
  console.log(`[Manifesto] Extracting rules from manifesto ${manifestoId}...`);

  const { rules, ambiguities, scoringWeights, assetTypesCovered } =
    await extractRulesFromManifesto(rawText);

  console.log(`[Manifesto] Extracted ${rules.length} rules, ${ambiguities.length} ambiguities`);

  // Activate the manifesto record
  store.activateManifesto(
    manifestoId,
    JSON.stringify(rules),
    JSON.stringify(ambiguities),
    JSON.stringify(assetTypesCovered),
    scoringWeights ? JSON.stringify(scoringWeights) : null,
  );

  // Distribute extracted rules into the criteria table per asset type
  distributeRulesToCriteria(rules, scoringWeights, assetTypesCovered);

  console.log(`[Manifesto] Manifesto ${manifestoId} activated. Rules distributed to criteria.`);
}

async function extractRulesFromManifesto(rawText: string): Promise<{
  rules: ManifestoExtractedRule[];
  ambiguities: ManifestoAmbiguity[];
  scoringWeights: Record<FindingCategory, number> | null;
  assetTypesCovered: string[];
}> {
  const prompt = `You are a senior credit policy analyst. You have been given a Credit Manifesto document — the official credit policy that governs ALL underwriting decisions for a CRE (Commercial Real Estate) credit committee.

Your job is to extract EVERY credit rule, threshold, guideline, and policy from this document and structure them as machine-enforceable rules. Be exhaustive — if a rule exists in this document, it MUST appear in your output. Missing a rule means deals may be approved that should be declined.

CREDIT MANIFESTO DOCUMENT:
---
${rawText.substring(0, 150000)}
---

INSTRUCTIONS:

1. RULE EXTRACTION — For EACH credit rule, guideline, threshold, or policy in the document, extract:
   - "metric_name": The metric or concept being evaluated (e.g., "DSCR", "LTV", "Lease Rollover", "Sponsor Net Worth", "Environmental Phase I")
   - "condition": Human-readable description of the rule (e.g., "DSCR must be at least 1.25x on in-place cash flow")
   - "threshold_value": The numeric threshold if applicable (e.g., 1.25, 70, 0.08). Use null for qualitative rules.
   - "comparison_operator": One of ">", ">=", "<", "<=", "==", "!=", "contains", "between", "qualitative"
   - "outcome": What happens when the rule is violated — "Fail" (deal-breaker), "Watchlist" (elevated monitoring), or "Pass" (acceptable when met)
   - "weight": Importance 1-10 where 10 is most critical. Deal-breakers should be 8-10, guidelines 4-7, preferences 1-3.
   - "category": One of "cash_flow", "leasing", "expense", "market", "sponsor", "loan_structure"
   - "severity": One of "critical" (deal-breaker if violated), "high" (material risk), "medium" (notable concern), "low" (minor flag)
   - "asset_types": Array of asset types this rule applies to. Use ["all"] if the rule is universal. Valid types: "office", "multifamily", "retail", "industrial", "hotel", "self_storage", "mixed_use", "manufactured_housing"
   - "source_text": The EXACT quote from the manifesto that this rule derives from
   - "page_reference": Page number if identifiable, otherwise null

2. AMBIGUITY DETECTION — Identify any language in the manifesto that is:
   - Vague or subjective without a clear threshold (e.g., "adequate reserves" without specifying an amount)
   - Contradictory with other rules in the document
   - Open to multiple interpretations
   - Missing critical details needed for enforcement

   For each ambiguity, provide:
   - "id": A unique identifier (e.g., "amb-1")
   - "text": The exact ambiguous text
   - "location": Where in the document (page/section)
   - "issue": What makes it ambiguous
   - "suggestion": How it could be clarified
   - "severity": "high" (could lead to materially different outcomes), "medium" (needs clarification but intent is guessable), "low" (minor wording issue)

3. SCORING WEIGHTS — If the manifesto specifies relative importance of categories (e.g., "cash flow analysis is paramount" or "loan structure is secondary to sponsor quality"), extract scoring weights as percentages that sum to 100:
   - "cash_flow": number (default 25)
   - "leasing": number (default 20)
   - "market": number (default 15)
   - "sponsor": number (default 15)
   - "loan_structure": number (default 15)
   - "expense": number (default 10)
   If the manifesto does not specify relative importance, return null for scoringWeights.

4. ASSET TYPE COVERAGE — Determine which asset types the manifesto covers. If it is a general policy document, return ["all"]. If it only covers specific types, return only those types.

CRITICAL RULES:
- Extract ALL rules, not just quantitative ones. Qualitative policies like "all loans require Phase I environmental" are rules too.
- If a rule has both a hard threshold and a soft guideline (e.g., "LTV must not exceed 75%; prefer below 65%"), extract BOTH as separate rules — one as "Fail" and one as "Watchlist".
- Err on the side of over-extraction. It is better to have a rule that gets reviewed than to miss one.
- Do NOT invent rules that are not in the document. Every rule must have a source_text quote.

Return as JSON:
{
  "rules": [...],
  "ambiguities": [...],
  "scoringWeights": { ... } or null,
  "assetTypesCovered": ["all"] or ["office", "multifamily", ...]
}`;

  const text = await callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    system: 'You are a credit policy analyst extracting machine-enforceable rules from a credit manifesto document. Be exhaustive and precise. Return valid JSON only.',
    messages: [{ role: 'user', content: prompt }],
    maxContinuations: 2,
  });

  const parsed = extractJSON(text);

  return {
    rules: parsed.rules || [],
    ambiguities: (parsed.ambiguities || []).map((a: any) => ({
      ...a,
      id: a.id || uuid(),
    })),
    scoringWeights: parsed.scoringWeights || null,
    assetTypesCovered: parsed.assetTypesCovered || ['all'],
  };
}

function distributeRulesToCriteria(
  rules: ManifestoExtractedRule[],
  scoringWeights: Record<FindingCategory, number> | null,
  assetTypesCovered: string[],
): void {
  const targetTypes: AssetType[] = assetTypesCovered.includes('all')
    ? ALL_ASSET_TYPES
    : assetTypesCovered.filter(t => ALL_ASSET_TYPES.includes(t as AssetType)) as AssetType[];

  const weights = scoringWeights || DEFAULT_SCORING_WEIGHTS;

  for (const assetType of targetTypes) {
    const applicableRules = rules.filter(
      r => (r.asset_types as string[]).includes('all') || (r.asset_types as string[]).includes(assetType)
    );

    const criteriaRules: CriteriaRule[] = applicableRules.map(r => ({
      id: uuid(),
      assetType,
      category: r.category,
      name: r.metric_name,
      description: `${r.condition} (${r.comparison_operator} ${r.threshold_value ?? 'N/A'}) → ${r.outcome}. Source: "${r.source_text.substring(0, 120)}"`,
      condition: r.condition,
      threshold: r.threshold_value !== null ? String(r.threshold_value) : undefined,
      severity: r.severity,
      weight: r.weight,
      enabled: true,
    }));

    const ruleSet: CriteriaRuleSet = {
      assetType,
      rules: criteriaRules,
      scoringWeights: { ...weights } as Record<FindingCategory, number>,
    };

    store.updateCriteria(assetType, ruleSet);
    invalidateCacheForAssetType(assetType);

    console.log(`[Manifesto] Distributed ${criteriaRules.length} rules to ${assetType}`);
  }
}

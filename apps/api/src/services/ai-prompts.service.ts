import { AssetType, DocumentSection, Finding, CrossCheckFinding, ResearchResults } from '@cre/shared';
import { CriteriaRule } from '@cre/shared';
import type { UnderwritingModel } from '@cre/shared';

export const SYSTEM_PROMPT = `You are a senior credit officer on a B-piece buyer's credit committee with 25+ years of CRE debt experience across CMBS, balance sheet lending, and mezzanine. You have personally underwritten over $20B in commercial real estate loans and have seen multiple credit cycles, including 2008-2009 and 2020.

YOUR MANDATE: Protect the B-piece. You are the last line of defense before a loan goes into a securitization. If this loan defaults, YOUR tranche takes the first loss. Early losses and high severity losses will kill a B-piece investment. Act accordingly.

CORE UNDERWRITING PHILOSOPHY:
- Downside protection takes precedence over upside capture — always.
- Loan sizing must be supported by historical performance and cost basis, NOT peak underwriting.
- Cash-out refinances materially increase risk and warrant heightened scrutiny. Always know cost basis and borrower cash position on refinancings — when did they buy it and how much has been invested.
- Stable, durable cash flow is preferred over aggressive growth assumptions.
- Lack of information or transparency is itself a credit negative. Information gaps are negative signals.
- Know what you don't know — specialized assets (data centers, cold-storage, student housing, etc.) are inherently higher risk.

ADVERSARIAL POSTURE (NON-NEGOTIABLE):
- Seller-provided ASRs are inherently biased inputs requiring independent validation. The ASR is a SALES DOCUMENT. Treat it with extreme skepticism.
- Every assumption is optimistic until independently verified. Pro forma projections are aspirational, not factual.
- Missing information is ALWAYS a red flag — borrowers omit what hurts them.
- "Stabilized" NOI is a fantasy until the lease-up is complete and seasoned for 12+ months.
- Sponsor track record on other deals is irrelevant if THIS deal's fundamentals are weak.
- Market comps cited by the borrower are cherry-picked. Look for what they didn't show you.
- If DSCR is below 1.25x on in-place cash flow, the loan is structurally weak regardless of pro forma.
- Vacancy assumptions below market average are aggressive. Expense growth below inflation is aggressive.
- Lease rollover exceeding 30% of NRA in any 24-month window is a concentration risk.

UNIVERSAL CREDIT FRAMEWORK:
- Reconcile historical NOI to underwritten NOI and explain ALL material variances.
- Normalize rents, vacancy, concessions, and operating expenses using market-supported assumptions. Rent/lease comps are critical — flag if not provided.
- Incorporate recurring capex, TI/LC, FF&E, and replacement reserves regardless of NOI presentation.
- Cash on hand for capital needs is irreplaceable — a springing structure is never as good as cash on hand up front with fixed ongoing deposits.
- Evaluate leverage using DSCR, Debt Yield, AND LTV in combination. Sales comparables are critical — always evaluate how comparable they are to the subject.
- Stress DSCR under scenarios consistent with asset-level volatility.
- Assess value using both stabilized AND stressed cap rate assumptions.
- Explicitly distinguish term risk from maturity risk.
- Clearly present sources and uses and identify whether proceeds are cash-in or cash-out.
- Include a dedicated sponsor review: litigation, bankruptcies, foreclosures, press, and portfolio correlation.

CITATION RULES (STRICT):
- Every claim MUST cite a specific page number, section, or external URL.
- If no source exists for a claim, mark it: "Unverified — treat as risk."
- NEVER fabricate sources. If you cannot find data, say so explicitly.
- Quantify everything: dollar amounts, basis points, percentages, square footage, per-unit metrics.`;

export function buildFindingsPrompt(
  assetType: AssetType,
  sections: DocumentSection[],
  rules: CriteriaRule[],
  options?: {
    uwSections?: DocumentSection[];
    crossCheckFindings?: CrossCheckFinding[];
    research?: ResearchResults;
  }
): string {
  const sectionText = sections
    .map(
      (s) =>
        `[Section: "${s.title}" | Pages ${s.pageStart}-${s.pageEnd} | ID: ${s.id}]\n${s.content}`
    )
    .join('\n---\n');

  const rulesText = rules
    .filter((r) => r.enabled)
    .map((r) => `- [${r.category}/${r.severity}] ${r.name}: ${r.condition} (ID: ${r.id})`)
    .join('\n');

  let uwContext = '';
  if (options?.uwSections?.length) {
    const uwText = options.uwSections
      .map((s) => `[UW Section: "${s.title}" | ID: ${s.id}]\n${s.content}${
        s.tables ? '\nTABLES:\n' + s.tables.map((t) => `Headers: ${t.headers.join(' | ')}\n${t.rows.map((r) => r.join(' | ')).join('\n')}`).join('\n\n') : ''
      }`)
      .join('\n---\n');
    uwContext = `\n\nUNDERWRITING MODEL DATA (from separate Excel file — treat as financial truth):\n${uwText}`;
  }

  let crossCheckContext = '';
  if (options?.crossCheckFindings?.length) {
    const ccText = options.crossCheckFindings
      .map((c) => `- ${c.metric}: Seller=${c.sellerBankValue || c.asrValue} vs BP Spiral=${c.bpSpiralValue || c.uwValue} (${c.absoluteVariance || c.difference}) [${c.severity}]`)
      .join('\n');
    crossCheckContext = `\n\nCROSS-CHECK DISCREPANCIES — SELLER/BANK vs BP SPIRAL (factor these into your analysis):\n${ccText}`;
  }

  let researchContext = '';
  if (options?.research) {
    const entries: string[] = [];
    if (options.research.sponsor.length) {
      entries.push('Sponsor Research:\n' + options.research.sponsor.map((r) => `- [${r.riskSignal}] ${r.title}: ${r.snippet} (${r.url})`).join('\n'));
    }
    if (options.research.market.length) {
      entries.push('Market Research:\n' + options.research.market.map((r) => `- [${r.riskSignal}] ${r.title}: ${r.snippet} (${r.url})`).join('\n'));
    }
    if (options.research.news.length) {
      entries.push('News:\n' + options.research.news.map((r) => `- [${r.riskSignal}] ${r.title}: ${r.snippet} (${r.url})`).join('\n'));
    }
    if (entries.length) {
      researchContext = `\n\nEXTERNAL RESEARCH FINDINGS (reference URLs as source when citing):\n${entries.join('\n\n')}`;
    }
  }

  return `Analyze the following Asset Summary Report for a ${assetType.toUpperCase()} property. You are evaluating this for a B-piece credit committee. Your job is to find every reason this loan could default.

DOCUMENT SECTIONS:
${sectionText}${uwContext}${crossCheckContext}${researchContext}

ACTIVE CREDIT CRITERIA RULES:
${rulesText}

MANDATORY RED FLAG ANALYSIS — You MUST explicitly evaluate each of these risk areas:
1. HISTORICAL NOI vs UNDERWRITTEN NOI — Reconcile historical NOI to underwritten NOI. Explain ALL material variances. Is NOI based on in-place or pro forma? Are there above-market rent assumptions? Is vacancy below market?
2. NORMALIZED CASH FLOW — Are rents, vacancy, concessions, and operating expenses normalized using market-supported assumptions? Are rent/lease comps provided? Are recurring capex, TI/LC, FF&E, and replacement reserves incorporated regardless of how NOI is presented?
3. LEASE ROLLOVER RISK — What % of NRA rolls in the next 12/24/36 months? Any single-tenant concentration >25%?
4. LEVERAGE ASSESSMENT — Evaluate DSCR, Debt Yield, AND LTV in combination. Are sales comparables provided? How comparable are they to the subject? Stress DSCR under scenarios consistent with asset-level volatility.
5. TERM RISK vs MATURITY RISK — Explicitly distinguish term risk (can the property service debt during the loan?) from maturity risk (can it be refinanced at exit?). At current cap rates, can this loan be refinanced at maturity? What exit cap would break the refi? Assess value using both stabilized AND stressed cap rate assumptions.
6. SOURCES & USES / CASH-IN vs CASH-OUT — Clearly present sources and uses. Is this a cash-in or cash-out transaction? Cash-out refinances materially increase risk. Know the cost basis and borrower cash position — when did they buy and how much has been invested?
7. CAPITAL RESERVES — Cash on hand for capital needs is irreplaceable. Is there actual cash on hand or a springing structure? Are reserves funded up front with fixed ongoing deposits? Are there unfunded capital needs that will erode NOI?
8. SPONSOR REVIEW — Dedicated assessment of litigation, bankruptcies, foreclosures, press, and portfolio correlation. Is the sponsor over-leveraged across their portfolio?
9. MARKET DECLINE & SUPPLY — Is the submarket softening? Rising vacancy? Negative absorption? New competitive supply pipeline?
10. EXPENSE UNDERSTATING — Are management fees, R&M, taxes, or insurance below market norms for this asset type? Expense growth below inflation is aggressive.
11. ENVIRONMENTAL / REGULATORY — Phase I/II issues? Zoning risk? Regulatory changes affecting the asset?
12. INFORMATION GAPS — What information is missing or unclear? Lack of transparency is itself a credit negative. Missing data should be flagged as a risk signal, not ignored.

INSTRUCTIONS:
1. Evaluate the document against each active criteria rule
2. Identify ALL credit-negative findings — be exhaustive, not selective
3. For EACH finding, you MUST provide:
   - category: one of "cash_flow", "leasing", "expense", "market", "sponsor", "loan_structure"
   - severity: "critical" (deal-breaker if unmitigated), "high" (material risk requiring conditions), "medium" (notable concern), "low" (minor flag)
   - title: direct, specific (e.g., "42% NRA rolls in 2027" not "Lease rollover risk")
   - explanation: what is wrong AND why it matters for credit
   - confidence: "high" (direct evidence in document), "medium" (inferred), "low" (suspected, limited evidence)
   - pageReferences: exact page(s), section ID, section title, and a direct quote as "excerpt"
   - impact: quantify the credit impact (metric affected, current value, adjusted value, description)
   - appliedRuleId: the criteria rule ID if applicable
4. If a criteria rule cannot be evaluated, flag as "Unknown" with severity "medium"
5. If a claim has NO source, mark confidence as "low" and note "Unverified — treat as risk" in the explanation
6. Return findings ordered by severity: critical first, then high, medium, low
7. Also return criteriaEvaluations for each rule: pass/fail/unknown with reason and source
8. For any deal metric you encounter that has NO corresponding rule in the ACTIVE CREDIT CRITERIA RULES list above, create a finding with title "[Metric Name] — Undefined in Manifesto", severity "medium", category as best fit, and explanation noting this metric was found in the deal but has no governing rule in the active credit manifesto and cannot be evaluated for pass/fail compliance. Do NOT score these — they are informational flags only.

Return as JSON:
{
  "findings": [{ id, category, severity, title, explanation, confidence, pageReferences, appliedRuleId, impact }],
  "criteriaEvaluations": [{ ruleId, ruleName, result, reason, source }]
}`;
}

export function buildUWPrompt(
  assetType: AssetType,
  sections: DocumentSection[]
): string {
  // Send ALL sections — the AI needs loan terms, valuation, and market data too
  const sectionText = sections
    .map(
      (s) =>
        `[Section: "${s.title}" | Pages ${s.pageStart}-${s.pageEnd} | ID: ${s.id}]\n${s.content}${
          s.tables
            ? '\nTABLES:\n' + s.tables.map((t) => `Headers: ${t.headers.join(' | ')}\n${t.rows.map((r) => r.join(' | ')).join('\n')}`).join('\n\n')
            : ''
        }`
    )
    .join('\n---\n');

  return `Extract a complete underwriting model from the following financial sections of a ${assetType.toUpperCase()} Asset Summary Report.

FINANCIAL SECTIONS:
${sectionText}

INSTRUCTIONS:
1. Extract every revenue line item with its annual amount
2. Extract every expense line item with its annual amount
3. Extract loan terms: cap_rate, loan_amount, interest_rate, amortization_years, term_years
4. Extract detailed loan structure: IO period, rate type (fixed/floating), payment frequency, prepayment terms
5. If any value is missing from the document, use 0 — do NOT estimate
6. All dollar amounts should be annual figures

Return as JSON with EXACTLY this structure (use these exact key names):
{
  "gross_potential_rent": number,
  "vacancy_loss": number (negative),
  "concessions": number (negative),
  "other_income": number,
  "real_estate_taxes": number,
  "insurance": number,
  "utilities": number,
  "repairs_and_maintenance": number,
  "management_fee": number,
  "general_and_admin": number,
  "payroll": number,
  "replacement_reserves": number,
  "cap_rate": number (e.g. 6.8 for 6.8%),
  "loan_amount": number,
  "interest_rate": number (e.g. 6.75 for 6.75%),
  "amortization_years": number,
  "term_years": number,
  "total_sqft": number,
  "total_units": number or null,
  "io_months": number (interest-only period in months, 0 if fully amortizing),
  "rate_type": "fixed" or "floating",
  "payment_frequency": "monthly" or "quarterly",
  "prepayment_terms": "string describing prepayment penalty or defeasance, empty string if not found"
}`;
}

export function buildScoringPrompt(
  assetType: AssetType,
  findingsJson: string,
  uwModelJson: string,
  criteriaEvaluationsJson: string,
  weightsJson: string
): string {
  return `You are the scoring officer on a B-piece credit committee for this ${assetType.toUpperCase()} loan. Your score MUST be transparent and defensible — every point deducted must be traceable to a specific finding or metric.

SCORING SCALE (be rigorous, not generous):
- 90-100: Institutional quality. Investment-grade tenancy, DSCR >1.50x, LTV <60%, strong sponsor, no material risks.
- 70-89: Acceptable with minor conditions. Solid fundamentals, manageable risks, DSCR >1.25x.
- 50-69: Elevated risk. Significant conditions required. One or more material concerns (rollover, market, sponsor).
- 30-49: High risk. Multiple material deficiencies. Likely decline without substantial structural mitigants.
- 0-29: Severe/unacceptable risk. Recommend decline. Fundamental credit deficiencies.

FINDINGS:
${findingsJson}

UNDERWRITING MODEL:
${uwModelJson}

CRITERIA EVALUATIONS:
${criteriaEvaluationsJson}

CATEGORY WEIGHTS:
${weightsJson}

INSTRUCTIONS — Return JSON with ALL of the following:

1. "categories" — For each of the 6 categories (cash_flow, leasing, market, sponsor, loan_structure, expense):
   - "category": the category name
   - "score": 0-100 (deduct points proportional to finding severity: critical=-20 to -25, high=-10 to -20, medium=-5 to -10, low=-2 to -5)
   - "weight": the weight from the weights object
   - "findings": array of finding IDs that influenced this score
   - "explanation": 2-3 sentences justifying the score
   - "deductions": for EACH deduction, state: what finding caused it, how many points deducted, and why
   - "howToImprove": specific actions that would raise this category's score (tied to mitigants: reserves, structural changes, equity injection)

2. "overall": weighted average score (0-100)

3. "recommendation": "approve" | "approve_with_conditions" | "decline" | "further_review"

4. "riskTier": "strong" | "acceptable" | "watchlist" | "high_risk"

5. "narrative": 3-5 sentence credit narrative summarizing deal strengths, weaknesses, and key risks

6. "whyThisScore": A 3-5 sentence explanation of WHY the overall score landed where it did — which categories dragged it down, which red flags were most impactful, and what single factor had the largest negative effect

7. "howToImprove": A 3-5 sentence summary of HOW the score could be improved — specific structural changes, reserves, or equity injections that would move the needle, with estimated point improvements

Return as JSON.`;
}

export function buildSellerMetricExtractionPrompt(
  assetType: AssetType,
  asrSections: DocumentSection[],
  uwSections?: DocumentSection[]
): string {
  const asrText = asrSections
    .map((s) => `[Section: "${s.title}" | Pages ${s.pageStart}-${s.pageEnd} | ID: ${s.id}]\n${s.content}`)
    .join('\n---\n');

  let uwText = '';
  if (uwSections?.length) {
    uwText = '\n\nSELLER UNDERWRITING MODEL (EXCEL DATA):\n' + uwSections
      .map((s) => `[UW Section: "${s.title}" | ID: ${s.id}]\n${s.content}${
        s.tables ? '\nTABLES:\n' + s.tables.map((t) => `Headers: ${t.headers.join(' | ')}\n${t.rows.map((r) => r.join(' | ')).join('\n')}`).join('\n\n') : ''
      }`)
      .join('\n---\n');
  }

  return `You are a financial data extraction engine for a ${assetType.toUpperCase()} property.

Your ONLY job is to extract structured data from the ASR and underwriting documents.

DO NOT underwrite.
DO NOT calculate credit decisions.
DO NOT apply manifesto rules.

Output ONLY valid JSON.

SELLER/BANK DOCUMENTS:
${asrText}${uwText}

---

Extract the following fields if present:
- NOI (annual dollar amount)
- Loan Amount (dollar amount)
- Interest Rate (percentage, e.g. 6.75 for 6.75%)
- Cap Rate (percentage, e.g. 6.8 for 6.8%)
- Property Value (dollar amount)
- Debt Service (annual dollar amount, if available)
- DSCR (ratio, e.g. 1.25 — only if explicitly stated)

---

Rules:
- If a field is not found, set:
  "value": null
  "status": "missing"
  "source": "not found in document"

- NEVER guess or infer values.

- Every extracted field must include:
  - value
  - source (exact text reference if possible, e.g., "ASR p.5", "UW Sheet1 Cell B12")
  - confidence (0–1)
  - status ("found" if extracted, "missing" if not present)

---

Return ONLY JSON with EXACTLY these keys:
{
  "noi":           { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" },
  "loanAmount":    { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" },
  "interestRate":  { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" },
  "capRate":       { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" },
  "propertyValue": { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" },
  "debtService":   { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" },
  "dscr":          { "value": number | null, "source": "string", "confidence": number, "status": "found" | "missing" }
}

No commentary. JSON only.`;
}

// Legacy alias for backward compatibility
export const buildCrossCheckPrompt = buildSellerMetricExtractionPrompt;

export function buildEntityExtractionPrompt(
  sections: DocumentSection[]
): string {
  const text = sections
    .slice(0, 3)
    .map((s) => `[${s.title}]\n${s.content.slice(0, 2000)}`)
    .join('\n---\n');

  return `Extract the following entities from this commercial real estate document. Return ONLY what is explicitly stated — do not guess.

DOCUMENT EXCERPT:
${text}

Return as JSON:
{
  "sponsorName": "string or null",
  "propertyName": "string or null",
  "propertyAddress": "string or null",
  "city": "string or null"
}`;
}

export function buildMitigationPrompt(
  assetType: AssetType,
  findings: Finding[],
  uwModel: UnderwritingModel,
  crossCheckFindings?: CrossCheckFinding[]
): string {
  const criticalHighFindings = findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .map((f) => `- [${f.id}] [${f.severity}] ${f.title}: ${f.explanation}`)
    .join('\n');

  // Per contract: null fields are SKIPPED from narrative (not rendered as 0
  // or "N/A"). Decimal-form metrics (LTV, debt yield, cap rate) are
  // multiplied by 100 for display only — stored values are unchanged.
  const uwParts: string[] = [
    `NOI: $${uwModel.netOperatingIncome.toLocaleString()}`,
    `Loan Amount: $${uwModel.loanAmount.toLocaleString()}`,
    `Cap Rate: ${(uwModel.capRate * 100).toFixed(2)}%`,
  ];
  if (uwModel.dscr !== null) uwParts.push(`DSCR: ${uwModel.dscr.toFixed(2)}x`);
  if (uwModel.ltv !== null) uwParts.push(`LTV: ${(uwModel.ltv * 100).toFixed(1)}%`);
  if (uwModel.debtYield !== null) uwParts.push(`Debt Yield: ${(uwModel.debtYield * 100).toFixed(1)}%`);
  if (uwModel.impliedValue !== null) uwParts.push(`Implied Value: $${uwModel.impliedValue.toLocaleString()}`);
  const uwSummary = uwParts.join(', ');

  let crossCheckContext = '';
  if (crossCheckFindings?.length) {
    crossCheckContext = '\n\nCROSS-CHECK DISCREPANCIES — SELLER vs BP SPIRAL:\n' + crossCheckFindings
      .map((c) => `- ${c.metric}: Seller=${c.sellerBankValue || c.asrValue} vs BP=${c.bpSpiralValue || c.uwValue} (${c.absoluteVariance || c.difference})`)
      .join('\n');
  }

  return `You are a senior credit structuring officer proposing mitigation strategies for a ${assetType.toUpperCase()} CRE loan.

CRITICAL AND HIGH SEVERITY FINDINGS:
${criticalHighFindings}

UNDERWRITING SUMMARY:
${uwSummary}${crossCheckContext}

INSTRUCTIONS:
For EACH finding above, propose 1-2 concrete mitigation strategies. Each strategy MUST include:

1. A clear strategy name (e.g., "Increase TI/LC Reserve", "Add Cash Sweep Trigger")
2. A description of what to do
3. Specific structural changes (e.g., "Require lockbox", "Cash sweep at 1.15x DSCR", "Add recourse carve-out")
4. Quantified financial impact:
   - Which metric improves (DSCR, LTV, etc.)
   - Current value of that metric
   - Projected value after mitigation
   - Improvement amount (e.g., "+0.13x DSCR")
5. Required reserve amount ($) if applicable
6. Required equity injection ($) if applicable
7. Risk reduction level: "significant", "moderate", or "marginal"

Be specific with numbers — use the underwriting data to calculate realistic impacts.

Return as a JSON array:
[{
  "findingId": "string (the finding ID this mitigates)",
  "strategy": "string",
  "description": "string",
  "structuralChanges": ["string", "string"],
  "financialImpact": {
    "targetMetric": "string",
    "currentValue": number,
    "projectedValue": number,
    "improvement": "string"
  },
  "requiredReserve": number or null,
  "requiredEquity": number or null,
  "riskReduction": "significant | moderate | marginal"
}]`;
}

export function buildExecutiveSummaryPrompt(
  assetType: AssetType,
  findingsJson: string,
  uwModelJson: string,
  crossCheckCount: number,
  researchAvailable: boolean,
  stressScenariosJson: string
): string {
  return `Write an executive summary for a B-piece credit committee reviewing a ${assetType.toUpperCase()} loan. This summary opens the credit memo and must immediately convey the key risk picture.

FINDINGS:
${findingsJson}

UNDERWRITING SUMMARY:
${uwModelJson}

CROSS-CHECK DISCREPANCIES: ${crossCheckCount} found
EXTERNAL RESEARCH: ${researchAvailable ? 'Available' : 'Not available'}

STRESS TEST RESULTS:
${stressScenariosJson}

INSTRUCTIONS:
Write a structured executive summary in plain text (NOT JSON) with these sections:

DEAL OVERVIEW: 1-2 sentences identifying the property, asset type, loan amount, and sponsor.

KEY METRICS: State NOI, DSCR, LTV, cap rate, debt yield in one line.

TOP RISKS: Bullet the 3-5 most critical issues (reference finding severity). Be direct — "NOI is overstated by $X" not "there may be some risk."

STRESS TEST ALERT: If any scenario breaks covenants, state which ones and what metrics fail.

RECOMMENDATION PREVIEW: One sentence on the likely committee outcome (approve with conditions, decline, etc.) and the single biggest condition that must be met.

Keep it under 300 words. Write like a credit officer, not a consultant. No hedging, no filler.`;
}

export function buildBPieceDecisionPrompt(
  assetType: AssetType,
  findingsJson: string,
  uwModelJson: string,
  mitigationsJson: string,
  stressScenariosJson: string,
  creditScoreJson: string,
  crossCheckJson: string
): string {
  return `You are making the FINAL B-piece buying decision for this ${assetType.toUpperCase()} loan. This is the last page of the credit memo. Your decision determines whether this loan enters the securitization.

CREDIT SCORE & RECOMMENDATION:
${creditScoreJson}

FINDINGS:
${findingsJson}

UNDERWRITING:
${uwModelJson}

MITIGATIONS AVAILABLE:
${mitigationsJson}

STRESS TEST RESULTS:
${stressScenariosJson}

CROSS-CHECK DISCREPANCIES:
${crossCheckJson}

INSTRUCTIONS — Return JSON with:

1. "recommendation": "approve" | "approve_with_conditions" | "decline" | "further_review"

2. "conviction": "strong" (clear decision, high confidence), "moderate" (decision is right but close), "weak" (borderline, could go either way)

3. "dealBreakers": array of strings — issues that would cause outright decline if unmitigated. Empty array if none.

4. "keyConditions": array of strings — specific conditions required for approval. Be precise: "$2M TI/LC reserve", "Cash sweep at 1.15x DSCR", "Personal recourse carve-out for sponsor", "Phase II environmental required before closing". Empty array for decline.

5. "pricingGuidance": one sentence on spread/pricing — should this be priced wider given the risk? Suggest basis point adjustment if applicable.

6. "summary": 3-5 sentence final verdict. Start with the decision. State the primary driver. Reference the score. End with the single most important condition or risk.

Be decisive. A credit committee does not say "maybe."`;
}

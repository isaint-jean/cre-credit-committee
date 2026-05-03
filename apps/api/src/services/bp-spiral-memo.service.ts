/**
 * BP Spiral Underwriting Memo Generator
 *
 * Produces a deterministic, institutional-grade PDF credit memo from
 * validated analysis outputs. No AI calls — purely template-driven.
 * Same inputs always produce byte-identical output.
 */

import PDFDocument from 'pdfkit';
import { Analysis, Finding, CriteriaEvaluation, CreditScore, ValidationResult } from '@cre/shared';
import type { UnderwritingModel } from '@cre/shared';
import { debtYieldPrimitive } from '@cre/shared';
import { listHistoricalUWs } from './uw-intelligence.service.js';

// --- Constants ---

const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const COLOR_BLACK = '#1a1a1a';
const COLOR_MUTED = '#666666';
const COLOR_HEADER = '#0f172a';
const COLOR_LINE = '#d1d5db';
const COLOR_PASS = '#059669';
const COLOR_FAIL = '#dc2626';
const COLOR_WATCHLIST = '#d97706';

const MARGIN = 50;
const PAGE_WIDTH = 612; // US Letter
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// --- Display formatters (view-only, never mutate model data) ---
// Per contract: values are stored as decimals; display multiplies by 100.
// null → "N/A" — never coerced to 0.
const fmtDecimalPct = (v: number | null, decimals = 2): string =>
  v === null || v === undefined ? 'N/A' : `${(v * 100).toFixed(decimals)}%`;
const fmtMultiple = (v: number | null, decimals = 2): string =>
  v === null || v === undefined ? 'N/A' : `${v.toFixed(decimals)}x`;
const fmtCurrencySafe = (v: number | null): string =>
  v === null || v === undefined ? 'N/A' : formatCurrency(v);

// --- Public API ---

export async function generateBPSpiralMemo(analysis: Analysis): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: {
        Title: `BP Spiral Underwriting — ${analysis.name}`,
        Author: 'BP Spiral Credit Committee',
        Subject: `Credit Memo for ${analysis.name}`,
        Creator: 'CRE Credit Committee Platform',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Render Sections ---
    renderCoverHeader(doc, analysis);
    renderDealOverview(doc, analysis);
    renderKeyMetrics(doc, analysis);
    renderRiskAssessment(doc, analysis);
    renderCreditDecision(doc, analysis);
    renderComparableAnalysis(doc, analysis);
    renderFinalRecommendation(doc, analysis);
    renderFooter(doc, analysis);

    doc.end();
  });
}

// --- Cover Header ---

function renderCoverHeader(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  doc.font(FONT_BOLD).fontSize(8).fillColor(COLOR_MUTED)
    .text('CONFIDENTIAL — FOR INTERNAL USE ONLY', MARGIN, MARGIN, { align: 'center', width: CONTENT_WIDTH });

  doc.moveDown(0.5);
  doc.font(FONT_BOLD).fontSize(20).fillColor(COLOR_HEADER)
    .text('BP SPIRAL UNDERWRITING', { align: 'center', width: CONTENT_WIDTH });

  doc.moveDown(0.3);
  doc.font(FONT_BOLD).fontSize(14).fillColor(COLOR_BLACK)
    .text(analysis.name.toUpperCase(), { align: 'center', width: CONTENT_WIDTH });

  doc.moveDown(0.3);
  doc.font(FONT_REGULAR).fontSize(10).fillColor(COLOR_MUTED)
    .text(`Asset Type: ${formatAssetType(analysis.assetType)}  |  Analysis ID: ${analysis.id.substring(0, 8)}`, { align: 'center', width: CONTENT_WIDTH });

  if (analysis.manifestoVersion) {
    doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_MUTED)
      .text(`Manifesto Version: ${analysis.manifestoVersion.substring(0, 12)}...  |  Model Version: ${analysis.modelLogicVersion || 'N/A'}`, { align: 'center', width: CONTENT_WIDTH });
  }

  doc.moveDown(1);
  drawLine(doc);
  doc.moveDown(1);
}

// --- Section 1: Deal Overview ---

function renderDealOverview(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  sectionHeader(doc, '1. DEAL OVERVIEW');

  const uwModel = analysis.uwModel;
  const rows: [string, string][] = [
    ['Deal Name', analysis.name],
    ['Asset Type', formatAssetType(analysis.assetType)],
    ['Loan Amount', uwModel ? formatCurrency(uwModel.loanAmount) : 'N/A'],
    ['Analysis Date', formatDate(analysis.createdAt)],
  ];

  for (const [label, value] of rows) {
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_MUTED).text(`${label}:`, { continued: true });
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_BLACK).text(`  ${value}`);
  }

  if (analysis.executiveSummary) {
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_MUTED).text('Business Plan Summary:');
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_BLACK)
      .text(analysis.executiveSummary, { width: CONTENT_WIDTH, lineGap: 2 });
  }

  doc.moveDown(1);
}

// --- Section 2: Key Metrics ---

function renderKeyMetrics(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  sectionHeader(doc, '2. KEY METRICS');

  const uwModel = analysis.uwModel;
  if (!uwModel) {
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_FAIL).text('No underwriting model available.');
    doc.moveDown(1);
    return;
  }

  const metrics: [string, string][] = [
    ['Net Operating Income (NOI)', formatCurrency(uwModel.netOperatingIncome)],
    ['DSCR', fmtMultiple(uwModel.dscr)],
    // Debt Yield, LTV, Cap Rate are stored as decimals — multiply by 100 for display only.
    ['Debt Yield', fmtDecimalPct(uwModel.debtYield)],
    ['LTV', fmtDecimalPct(uwModel.ltv, 1)],
    ['Cap Rate', fmtDecimalPct(uwModel.capRate)],
    ['Implied Value', fmtCurrencySafe(uwModel.impliedValue)],
    ['Loan Amount', formatCurrency(uwModel.loanAmount)],
    // Interest rate is still stored in percent units (loan-amort math uses /100).
    ['Interest Rate', `${uwModel.interestRate.toFixed(3)}%`],
    ['IO Period', uwModel.loanDetails?.ioMonths ? `${uwModel.loanDetails.ioMonths} months` : 'N/A'],
    ['Loan Term', uwModel.loanDetails?.termMonths ? `${uwModel.loanDetails.termMonths} months` : 'N/A'],
    ['Amortization', uwModel.loanDetails?.amortizationMonths ? `${uwModel.loanDetails.amortizationMonths} months` : 'N/A'],
    ['Annual Debt Service', fmtCurrencySafe(uwModel.annualDebtService)],
  ];

  if (uwModel.totalUnits) {
    metrics.push(['Total Units', uwModel.totalUnits.toLocaleString()]);
  }
  if (uwModel.totalSqFt) {
    metrics.push(['Total Sq Ft', uwModel.totalSqFt.toLocaleString()]);
  }

  // Render as two-column table
  const colWidth = CONTENT_WIDTH / 2;
  const startY = doc.y;
  let leftY = startY;
  let rightY = startY;

  for (let i = 0; i < metrics.length; i++) {
    const [label, value] = metrics[i];
    const isLeft = i % 2 === 0;
    const x = isLeft ? MARGIN : MARGIN + colWidth;
    const y = isLeft ? leftY : rightY;

    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_MUTED).text(label, x, y, { width: colWidth - 10 });
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_BLACK).text(value, x, y + 12, { width: colWidth - 10 });

    if (isLeft) leftY = y + 28;
    else rightY = y + 28;
  }

  doc.y = Math.max(leftY, rightY);
  doc.moveDown(1);
}

// --- Section 3: Risk Assessment ---

function renderRiskAssessment(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  checkPageBreak(doc, 200);
  sectionHeader(doc, '3. RISK ASSESSMENT');

  const riskCategories: { label: string; categories: string[] }[] = [
    { label: 'A) Cash Flow Risk', categories: ['cash_flow', 'expense'] },
    { label: 'B) Tenant Risk', categories: ['leasing'] },
    { label: 'C) Market Risk', categories: ['market'] },
    { label: 'D) Structural Risk', categories: ['loan_structure', 'sponsor'] },
  ];

  const evalMap = new Map(analysis.criteriaEvaluations.map(e => [e.ruleId, e]));

  for (const rc of riskCategories) {
    checkPageBreak(doc, 80);
    doc.font(FONT_BOLD).fontSize(10).fillColor(COLOR_HEADER).text(rc.label);
    doc.moveDown(0.3);

    const findings = analysis.findings.filter(f => rc.categories.includes(f.category));

    if (findings.length === 0) {
      doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_PASS).text('No findings identified in this category.');
      doc.moveDown(0.5);
      continue;
    }

    // Sort: critical first, then high, medium, low
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));

    for (const finding of findings) {
      checkPageBreak(doc, 60);
      const sevColor = finding.severity === 'critical' ? COLOR_FAIL :
                        finding.severity === 'high' ? COLOR_WATCHLIST : COLOR_MUTED;

      doc.font(FONT_BOLD).fontSize(9).fillColor(sevColor)
        .text(`[${finding.severity.toUpperCase()}] ${finding.title}`, { width: CONTENT_WIDTH });

      doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
        .text(finding.explanation, { width: CONTENT_WIDTH, lineGap: 1 });

      if (finding.appliedRuleId) {
        const evaluation = evalMap.get(finding.appliedRuleId);
        if (evaluation) {
          doc.font(FONT_REGULAR).fontSize(7).fillColor(COLOR_MUTED)
            .text(`Rule: ${evaluation.ruleName} — Result: ${evaluation.result.toUpperCase()}`, { width: CONTENT_WIDTH });
        }
      }

      doc.moveDown(0.3);
    }

    doc.moveDown(0.5);
  }

  doc.moveDown(0.5);
}

// --- Section 4: Credit Decision ---

function renderCreditDecision(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  checkPageBreak(doc, 250);
  sectionHeader(doc, '4. CREDIT DECISION');

  const score = analysis.creditScore;
  if (!score) {
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_FAIL).text('No credit score generated.');
    doc.moveDown(1);
    return;
  }

  // Score headline
  const recColor = score.recommendation === 'approve' ? COLOR_PASS :
                    score.recommendation === 'decline' ? COLOR_FAIL : COLOR_WATCHLIST;

  doc.font(FONT_BOLD).fontSize(14).fillColor(recColor)
    .text(`${score.overall} / 100 — ${formatRecommendation(score.recommendation)}`, { width: CONTENT_WIDTH });

  doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_MUTED)
    .text(`Risk Tier: ${score.riskTier.replace('_', ' ').toUpperCase()}`);

  doc.moveDown(0.5);

  // Category breakdown
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Score Breakdown by Category:');
  doc.moveDown(0.3);

  for (const cat of score.categories) {
    const barColor = cat.score >= 85 ? COLOR_PASS : cat.score >= 50 ? COLOR_WATCHLIST : COLOR_FAIL;
    doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
      .text(`${formatCategory(cat.category)}: ${cat.score}/100 (weight: ${cat.weight}%, contribution: ${cat.weightedScore.toFixed(1)})`, { width: CONTENT_WIDTH });
  }

  doc.moveDown(0.5);

  // Pass/Fail rule breakdown
  checkPageBreak(doc, 100);
  doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Rule Evaluation Results:');
  doc.moveDown(0.3);

  const passed = analysis.criteriaEvaluations.filter(e => e.result === 'pass');
  const failed = analysis.criteriaEvaluations.filter(e => e.result === 'fail');
  const unknown = analysis.criteriaEvaluations.filter(e => e.result === 'unknown');

  doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_PASS)
    .text(`PASS: ${passed.length} rule(s)`);
  doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_FAIL)
    .text(`FAIL: ${failed.length} rule(s)`);
  if (unknown.length > 0) {
    doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_MUTED)
      .text(`UNKNOWN: ${unknown.length} rule(s)`);
  }

  if (failed.length > 0) {
    doc.moveDown(0.3);
    doc.font(FONT_BOLD).fontSize(8).fillColor(COLOR_FAIL).text('Failed Rules:');
    for (const f of failed) {
      doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
        .text(`  - ${f.ruleName}: ${f.reason}`, { width: CONTENT_WIDTH });
    }
  }

  // Validation status
  if (analysis.validationResult) {
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(8).fillColor(COLOR_PASS)
      .text(`Validation: PASSED (${analysis.validationResult.checks.length} checks, ${analysis.validationResult.timestamp})`);
  }

  doc.moveDown(1);
}

// --- Section 5: Comparable Analysis ---

function renderComparableAnalysis(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  checkPageBreak(doc, 200);
  sectionHeader(doc, '5. COMPARABLE ANALYSIS');

  const uwModel = analysis.uwModel;
  if (!uwModel) {
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_MUTED).text('No underwriting model available for comparison.');
    doc.moveDown(1);
    return;
  }

  const allDeals = listHistoricalUWs();
  const sameTypeDeals = allDeals.filter(d => d.assetType === analysis.assetType);

  if (sameTypeDeals.length === 0) {
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_MUTED)
      .text('No comparable deals available in the underwriting library.');
    doc.moveDown(1);
    return;
  }

  // Score similarity: lower = more similar
  const scored = sameTypeDeals
    .filter((d: any) => d.inputs?.dscr != null || d.inputs?.ltv != null)
    .map((d: any) => {
      // Null-guard both sides — never coerce missing values to 0. If either
      // side is null, the metric isn't comparable; fall back to neutral penalty 5.
      // ltv: both d.inputs.ltv and uwModel.ltv are decimal fractions (no /100).
      const dscrDiff = d.inputs?.dscr != null && uwModel.dscr !== null
        ? Math.abs(d.inputs.dscr - uwModel.dscr)
        : 5;
      const ltvDiff = d.inputs?.ltv != null && uwModel.ltv !== null
        ? Math.abs(d.inputs.ltv - uwModel.ltv)
        : 5;
      // Delegate debt-yield computation to SSOT primitive — never inline the formula.
      // Both sides of the diff use the same decimal-fraction unit.
      const compYield = d.inputs?.noi != null && d.inputs?.loanAmount != null
        ? debtYieldPrimitive(d.inputs.noi, d.inputs.loanAmount)
        : null;
      const yieldDiff = compYield !== null && uwModel.debtYield !== null
        ? Math.abs(compYield - uwModel.debtYield)
        : 5;
      return { deal: d, similarity: dscrDiff + ltvDiff + yieldDiff };
    })
    .sort((a, b) => a.similarity - b.similarity);

  const approvedComps = scored.filter(s => s.deal.outcome === 'approved').slice(0, 3);
  const rejectedComps = scored.filter(s => s.deal.outcome === 'rejected').slice(0, 3);

  if (approvedComps.length > 0) {
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Most Similar Approved Deals:');
    doc.moveDown(0.3);
    for (const { deal } of approvedComps) {
      renderCompDeal(doc, deal as any);
    }
    doc.moveDown(0.3);
  }

  if (rejectedComps.length > 0) {
    checkPageBreak(doc, 80);
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Most Similar Rejected Deals:');
    doc.moveDown(0.3);
    for (const { deal } of rejectedComps) {
      renderCompDeal(doc, deal as any);
    }
    doc.moveDown(0.3);
  }

  if (approvedComps.length === 0 && rejectedComps.length === 0) {
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_MUTED)
      .text('No comparable deals with sufficient metric data available.');
  }

  doc.moveDown(1);
}

function renderCompDeal(doc: PDFKit.PDFDocument, deal: any): void {
  const inputs = deal.inputs || {};
  const location = [deal.city, deal.state].filter(Boolean).join(', ') || 'N/A';
  const dscr = inputs.dscr != null ? `${inputs.dscr.toFixed(2)}x` : 'N/A';
  const ltv = inputs.ltv != null ? `${(inputs.ltv * 100).toFixed(1)}%` : 'N/A';
  const outcomeColor = deal.outcome === 'approved' ? COLOR_PASS :
                       deal.outcome === 'rejected' ? COLOR_FAIL : COLOR_WATCHLIST;

  doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
    .text(`  ${deal.dealName || 'Unnamed'} (${deal.year || 'N/A'}) — ${location}`, { continued: true });
  doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_MUTED)
    .text(`  |  DSCR: ${dscr}  |  LTV: ${ltv}  |  `, { continued: true });
  doc.font(FONT_BOLD).fontSize(8).fillColor(outcomeColor)
    .text(deal.outcome.toUpperCase());
}

// --- Section 6: Final Recommendation ---

function renderFinalRecommendation(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  checkPageBreak(doc, 200);
  sectionHeader(doc, '6. FINAL RECOMMENDATION');

  const score = analysis.creditScore;
  const decision = analysis.bPieceDecision;

  if (!score) {
    doc.font(FONT_REGULAR).fontSize(9).fillColor(COLOR_FAIL).text('Cannot render recommendation without credit score.');
    doc.moveDown(1);
    return;
  }

  // Primary recommendation
  const recText = score.recommendation === 'approve' ? 'RECOMMEND APPROVAL' :
                   score.recommendation === 'decline' ? 'RECOMMEND REJECTION' :
                   score.recommendation === 'approve_with_conditions' ? 'RECOMMEND APPROVAL WITH CONDITIONS' :
                   'RECOMMEND FURTHER REVIEW (WATCHLIST)';
  const recColor = score.recommendation === 'approve' ? COLOR_PASS :
                   score.recommendation === 'decline' ? COLOR_FAIL : COLOR_WATCHLIST;

  doc.font(FONT_BOLD).fontSize(14).fillColor(recColor)
    .text(recText, { width: CONTENT_WIDTH, align: 'center' });

  doc.moveDown(0.5);

  // Justification from failed rules
  const failedRules = analysis.criteriaEvaluations.filter(e => e.result === 'fail');
  const criticalFindings = analysis.findings.filter(f => f.severity === 'critical');

  if (failedRules.length > 0) {
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Failed Manifesto Rules:');
    for (const rule of failedRules) {
      doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
        .text(`  - ${rule.ruleName}: ${rule.reason}`, { width: CONTENT_WIDTH });
    }
    doc.moveDown(0.3);
  }

  if (criticalFindings.length > 0) {
    doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Critical Findings:');
    for (const f of criticalFindings) {
      doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
        .text(`  - ${f.title}`, { width: CONTENT_WIDTH });
    }
    doc.moveDown(0.3);
  }

  // Deal breakers and conditions from B-piece decision
  if (decision) {
    if (decision.dealBreakers && decision.dealBreakers.length > 0) {
      doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_FAIL).text('Deal Breakers:');
      for (const db of decision.dealBreakers) {
        doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
          .text(`  - ${db}`, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.3);
    }

    if (decision.keyConditions && decision.keyConditions.length > 0) {
      doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Key Conditions for Approval:');
      for (const cond of decision.keyConditions) {
        const condText = typeof cond === 'string' ? cond : JSON.stringify(cond);
        doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
          .text(`  - ${condText}`, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.3);
    }

    if (decision.pricingGuidance) {
      doc.font(FONT_BOLD).fontSize(9).fillColor(COLOR_HEADER).text('Pricing Guidance:');
      doc.font(FONT_REGULAR).fontSize(8).fillColor(COLOR_BLACK)
        .text(decision.pricingGuidance, { width: CONTENT_WIDTH });
    }
  }

  doc.moveDown(1);
}

// --- Footer ---

function renderFooter(doc: PDFKit.PDFDocument, analysis: Analysis): void {
  drawLine(doc);
  doc.moveDown(0.5);
  doc.font(FONT_REGULAR).fontSize(7).fillColor(COLOR_MUTED)
    .text(
      `Generated by CRE Credit Committee Platform  |  Input Hash: ${analysis.inputHash?.substring(0, 16) || 'N/A'}  |  Manifesto: ${analysis.manifestoVersion?.substring(0, 12) || 'N/A'}`,
      { align: 'center', width: CONTENT_WIDTH },
    );
  doc.font(FONT_REGULAR).fontSize(7).fillColor(COLOR_MUTED)
    .text('This document is deterministic — identical inputs produce identical output.', { align: 'center', width: CONTENT_WIDTH });
}

// --- Helpers ---

function sectionHeader(doc: PDFKit.PDFDocument, title: string): void {
  doc.font(FONT_BOLD).fontSize(12).fillColor(COLOR_HEADER).text(title);
  doc.moveDown(0.3);
  drawLine(doc);
  doc.moveDown(0.5);
}

function drawLine(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc.strokeColor(COLOR_LINE).lineWidth(0.5)
    .moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
}

function checkPageBreak(doc: PDFKit.PDFDocument, neededSpace: number): void {
  if (doc.y + neededSpace > 742) { // 792 (letter height) - 50 (bottom margin)
    doc.addPage();
  }
}

function formatCurrency(value: number): string {
  if (!value && value !== 0) return 'N/A';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatAssetType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatRecommendation(rec: string): string {
  return rec.replace(/_/g, ' ').toUpperCase();
}

function formatCategory(cat: string): string {
  const labels: Record<string, string> = {
    cash_flow: 'Cash Flow Quality',
    leasing: 'Tenancy & Lease Risk',
    market: 'Market Risk',
    sponsor: 'Sponsor Risk',
    loan_structure: 'Loan Structure Risk',
    expense: 'Valuation / Leverage Risk',
  };
  return labels[cat] || cat;
}

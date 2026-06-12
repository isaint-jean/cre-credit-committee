/**
 * build-committee-memo.ts — Memo Renderer v1 (HTML, print-to-PDF).
 *
 * Pure function: given the v1.6 narrative + clean-doctrine dealResult +
 * composed mitigation package, return a self-contained HTML string the
 * lender opens in any browser and prints to PDF.
 *
 * NUMBERS DISCIPLINE (load-bearing):
 *   - Every figure in the rendered tables is sourced from the structured
 *     AuthoritativeNumbers block (projectAuthoritativeNumbers, already
 *     exported from build-narrative.ts) OR from the composed package's
 *     typed fields. NEVER parsed from the LLM prose. NEVER recomputed.
 *   - Prose slots (executive_summary, red_flag_assessment,
 *     committee_recommendation) render VERBATIM — no rewrap, no re-rank,
 *     no severity inference. Mitigation_suggestions prose is REPLACED by
 *     a structured Restructuring Package built from the composed package
 *     (the prose version exists for the web view; here we build a
 *     committee-memo-grade structured section).
 *
 * SINGLE LTV BASIS:
 *   - Only doctrine-stressed LTV (loan / dim-7 stressedValue) appears.
 *     The appraised/concluded LTV (loan / impliedValue) is NOT displayed
 *     anywhere. The "valuation basis: operator-supplied" disclosure runs
 *     on the AuthoritativeNumbers source tag, not on prose scraping.
 *
 * NO EXTERNAL DEPS:
 *   - No JS, no external CSS, no images, no web fonts. Inline CSS only.
 *     The HTML opens identically offline and prints cleanly.
 *
 * SCOPE:
 *   - This is the MEMO (summary deliverable for the committee). It is NOT
 *     the full analysis page — income/expense line-item tables stay on
 *     the working surface (RenderedAnalysisView.tsx).
 */
import type { NarrativeEvaluation } from '@cre/contracts';
import {
  projectAuthoritativeNumbers,
  extractCleanDoctrineFindings,
} from '../narrative/build-narrative.js';
import type {
  AuthoritativeNumbers,
  CleanDoctrineFinding,
} from '../narrative/prompt-templates.js';
import type { EvaluateDealResult } from '../../doctrine-clean/scoring/evaluate-deal.js';
import type { ComposedMitigationPackage } from '../mitigation/compose-mitigations.js';
import { DEFAULT_MITIGATION_DESK } from '../mitigation/produce-mitigations.js';
import type { MitigationProposal } from '@cre/contracts';

/* --------------------------- public surface ------------------------------ */

export interface BuildCommitteeMemoInput {
  readonly dealName: string;
  readonly memoDate: string;                 // ISO date, e.g. '2026-06-12'
  readonly narrative: NarrativeEvaluation;
  readonly dealResult: EvaluateDealResult;
  readonly composedMitigationPackage: ComposedMitigationPackage;
}

export function buildCommitteeMemo(input: BuildCommitteeMemoInput): string {
  const auth = projectAuthoritativeNumbers(input.dealResult, input.composedMitigationPackage);
  const findings = extractCleanDoctrineFindings(input.dealResult);
  return renderHtml(input, auth, findings);
}

/* --------------------------- formatting helpers --------------------------- */

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0)     + 'K';
  return '$' + n.toFixed(0);
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}

function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(2) + 'x';
}

/** HTML entity escape for any prose / free-form string interpolated into the
 *  document. Structured figures bypass this (they're already typed). */
function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Convert prose with embedded \n into a paragraph element with <br> for
 *  line breaks (preserves bulleted-list shape coming from the narrative
 *  slots). Calls esc() per-line. */
function proseToHtml(prose: string): string {
  const lines = prose.split('\n');
  return lines.map(esc).join('<br>');
}

/* ----------------- structured section helpers ---------------------------- */

function categorizeProposals(proposals: readonly MitigationProposal[]): {
  readonly deLevering: readonly MitigationProposal[];
  readonly orthogonal: readonly MitigationProposal[];
} {
  const DE_LEVERING = new Set<string>(['reduce_proceeds', 'require_amortization']);
  return {
    deLevering:  proposals.filter(p => DE_LEVERING.has(p.lever)),
    orthogonal:  proposals.filter(p => !DE_LEVERING.has(p.lever)),
  };
}

function leverDisplayName(lever: string): string {
  switch (lever) {
    case 'reduce_proceeds':           return 'Reduce proceeds';
    case 'require_amortization':      return 'Require amortization';
    case 'require_guaranty':          return 'Sponsor guaranty / partial recourse';
    case 'in_place_cash_management':  return 'In-place cash management (hard lockbox)';
    case 'springing_cash_management': return 'Springing cash management (concentration trap)';
    case 'fund_reserve':              return 'Fund reserve (TI/LC)';
    case 'condition_precedent':       return 'Conditions precedent';
    default:                          return lever;
  }
}

function renderHeader(input: BuildCommitteeMemoInput, auth: AuthoritativeNumbers): string {
  const ratingLabel = auth.ratingRecommendation ?? '—';
  return `
    <header class="memo-header">
      <div class="memo-header-row">
        <div class="memo-header-left">
          <div class="memo-deal-name">${esc(input.dealName)}</div>
          <div class="memo-subtitle">Credit Committee Memorandum</div>
        </div>
        <div class="memo-header-right">
          <div class="memo-date">${esc(input.memoDate)}</div>
          <div class="memo-rating-chip">Rating: <strong>${esc(ratingLabel)}</strong></div>
        </div>
      </div>
      <div class="memo-attribution">
        Asset class: ${esc(auth.assetType ?? '—')}${auth.subType ? ' / ' + esc(auth.subType) : ''}
        &nbsp;·&nbsp; Prepared by CRE Credit Committee — narrative engine v${esc(input.narrative.engineVersion)}
      </div>
    </header>`;
}

function renderExecutiveSummary(narrative: NarrativeEvaluation): string {
  return `
    <section class="memo-section">
      <h2 class="memo-section-title">Executive Summary</h2>
      <p class="memo-prose">${proseToHtml(narrative.executiveSummary)}</p>
    </section>`;
}

function renderStressedCreditProfile(auth: AuthoritativeNumbers): string {
  const rows: Array<[string, string, string]> = [
    ['Original loan amount',             '',                              fmtUsd(auth.originalLoanAmount)],
    ['Concluded value',                  '(operator-supplied basis)',      fmtUsd(auth.concludedValue)],
    ['Doctrine-stressed value (dim 7)',  'cap-rate stress + sustainable-NCF haircut', fmtUsd(auth.stressedValue)],
    ['Stressed LTV (at original loan)',  '',                              fmtPct(auth.stressedLtv)],
    ['Stressed LTV (at L′)',        '',                              fmtPct(auth.stressedLtvAtFinalLoan)],
    ['Exit DSCR (baseline)',             '',                              fmtDscr(auth.exitDscrBaseline)],
    ['Exit DSCR (at L′)',           '',                              fmtDscr(auth.exitDscrAtFinalLoan)],
    ['Exit-DSCR doctrine trigger',       '',                              fmtDscr(auth.exitDscrTrigger)],
    ['Exit-DSCR desk cure target',       '',                              fmtDscr(auth.exitDscrCureTarget)],
  ];
  const basisLabel =
    auth.concludedValueSource === 'extracted-appraisal' ? 'extracted appraisal (third-party)'
    : auth.concludedValueSource === 'extracted-asr'     ? 'extracted ASR implied value'
    : auth.concludedValueSource === 'operator-supplied' ? 'operator-supplied'
    : 'unspecified source';
  const confidenceLine = auth.valuationConfidenceNote
    ? `<p class="memo-disclosure"><strong>Valuation basis: ${esc(basisLabel)}.</strong>
       ${esc(auth.valuationConfidenceNote)}</p>`
    : `<p class="memo-disclosure"><strong>Valuation basis: ${esc(basisLabel)}.</strong></p>`;
  return `
    <section class="memo-section">
      <h2 class="memo-section-title">Stressed Credit Profile</h2>
      <table class="memo-table memo-table-credit">
        <thead><tr><th class="memo-th-label">Metric</th><th class="memo-th-note">Context</th><th class="memo-th-num">Value</th></tr></thead>
        <tbody>
          ${rows.map(([label, note, val]) => `
            <tr>
              <td class="memo-td-label">${esc(label)}</td>
              <td class="memo-td-note">${esc(note)}</td>
              <td class="memo-td-num">${esc(val)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${confidenceLine}
    </section>`;
}

function renderRestructuringPackage(auth: AuthoritativeNumbers, composed: ComposedMitigationPackage): string {
  const { deLevering, orthogonal } = categorizeProposals(composed.proposals);
  const reduce = deLevering.find(p => p.lever === 'reduce_proceeds');
  const proceedsCut    = composed.reconciliation.proceedsReduction;
  const originalLoan   = composed.reconciliation.originalLoanAmount;
  const finalLoan      = composed.reconciliation.finalLoanAmount;
  const reduceEquity   = reduce?.requiredEquity ?? proceedsCut;
  // v1.3 — structure-first hold case: no cut.
  const isStructuredHold = proceedsCut === 0;

  // Centerpiece headline. Two shapes:
  //   CUT path  — "$X.XXM proceeds reduction" (loan A → B, sponsor fills X).
  //   HOLD path — "Hold at $X.XXM" + "structured-band cures" subline.
  const headline = isStructuredHold
    ? `
    <div class="memo-callout-headline">
      <div class="memo-callout-headline-label">Recommended structure</div>
      <div class="memo-callout-headline-figure">
        HOLD at ${esc(fmtUsd(originalLoan))}
      </div>
      <div class="memo-callout-headline-detail">
        No proceeds reduction &nbsp;·&nbsp; Leverage + exit risk held within the desk's structured tolerance via structural cures (below)
      </div>
    </div>`
    : `
    <div class="memo-callout-headline">
      <div class="memo-callout-headline-label">Recommended restructure</div>
      <div class="memo-callout-headline-figure">
        ${esc(fmtUsd(proceedsCut))} proceeds reduction
      </div>
      <div class="memo-callout-headline-detail">
        Loan ${esc(fmtUsd(originalLoan))} &rarr; ${esc(fmtUsd(finalLoan))}
        &nbsp;·&nbsp; Sponsor fills ${esc(fmtUsd(reduceEquity))} equity gap at closing
      </div>
    </div>`;

  // Why this shape: band-aware.
  const ltvTrigger = DEFAULT_MITIGATION_DESK.T_LTV_TRIGGER;
  const whyShape = isStructuredHold
    ? `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">Why this shape</h3>
      <p>
        The doctrine-stressed LTV
        (loan / dim-7 stressed value ${esc(fmtUsd(auth.stressedValue))})
        is <strong>${esc(fmtPct(auth.stressedLtv))}</strong> — above the
        ${esc(fmtPct(ltvTrigger))} trigger but WITHIN the desk's structured
        leverage band. The exit DSCR is <strong>${esc(fmtDscr(auth.exitDscrBaseline))}</strong> —
        below the ${esc(fmtDscr(auth.exitDscrTrigger))} doctrine trigger but
        WITHIN the desk's structured exit floor. Both breaches are covered by
        structural protections at the desk's structured-band tier; origination
        proceeds are held at ${esc(fmtUsd(originalLoan))}.
      </p>
    </div>`
    : `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">Why this shape</h3>
      <p>
        At the original loan amount, the doctrine-stressed LTV
        (loan / dim-7 stressed value ${esc(fmtUsd(auth.stressedValue))})
        was <strong>${esc(fmtPct(auth.stressedLtv))}</strong> — above the
        ${esc(fmtPct(ltvTrigger))} stressed-LTV trigger AND above the desk's
        structured-LTV ceiling. Above the ceiling, structural protections
        alone cannot make the buyer comfortable; proceeds must be cut TO the
        ceiling. Reducing proceeds to ${esc(fmtUsd(finalLoan))} brings the
        stressed LTV to <strong>${esc(fmtPct(auth.stressedLtvAtFinalLoan))}</strong>.
        Exit DSCR at L′ is <strong>${esc(fmtDscr(auth.exitDscrAtFinalLoan))}</strong>
        — still below the ${esc(fmtDscr(auth.exitDscrTrigger))} doctrine trigger,
        but the residual exit-refi risk is held within the desk's structured
        tolerance by the cash-sweep refi reserve + springing DSCR recourse
        (sized in the conditions below).
      </p>
    </div>`;

  // Reconciliation: why amortization dropped or shrank.
  const reconNotes = composed.reconciliation.notes;
  const reconciliation = reconNotes.length === 0
    ? ''
    : `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">Composition reconciliation</h3>
      <ul class="memo-recon-list">
        ${reconNotes.map(n => `<li>${esc(n)}</li>`).join('')}
      </ul>
    </div>`;

  // Orthogonal conditions: lockbox, CPs, guaranty, etc.
  const orthogonalSection = orthogonal.length === 0
    ? ''
    : `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">Structural conditions (orthogonal levers)</h3>
      <ul class="memo-condition-list">
        ${orthogonal.map(p => renderOrthogonalProposal(p, composed)).join('')}
      </ul>
    </div>`;

  const sectionTitle = isStructuredHold ? 'Structuring Package' : 'Restructuring Package';
  return `
    <section class="memo-section memo-restructure-section">
      <h2 class="memo-section-title">${esc(sectionTitle)}</h2>
      <div class="memo-callout">
        ${headline}
        ${whyShape}
        ${reconciliation}
        ${orthogonalSection}
      </div>
    </section>`;
}

function renderOrthogonalProposal(p: MitigationProposal, composed: ComposedMitigationPackage): string {
  const name = leverDisplayName(p.lever);
  // Covenant magnitudes at L' (only present for guaranty today; renderer
  // handles future levers if/when composeMitigations adds resolutions).
  const covLines = composed.reconciliation.covenantMagnitudesAtFinalLoan
    .find(c => c.lever === p.lever && c.leverId === (p.id ?? ''));
  const covMagnitudes = covLines && covLines.resolvedMagnitudes.length > 0
    ? `<div class="memo-condition-magnitudes">
         ${covLines.resolvedMagnitudes.map(m => `<div class="memo-condition-magnitude-row">&nbsp;&nbsp;${esc(m)}</div>`).join('')}
       </div>`
    : '';
  const sizing: string[] = [];
  if (p.requiredEquity !== undefined)  sizing.push(`Required equity ${fmtUsd(p.requiredEquity)}`);
  if (p.requiredPaydown !== undefined) sizing.push(`Required paydown ${fmtUsd(p.requiredPaydown)}`);
  if (p.requiredReserve !== undefined) sizing.push(`Required reserve ${fmtUsd(p.requiredReserve)}`);
  const sizingHtml = sizing.length === 0 ? '' : `<span class="memo-condition-sizing"> &nbsp;·&nbsp; ${esc(sizing.join(' · '))}</span>`;
  return `
    <li class="memo-condition">
      <div class="memo-condition-head">
        <span class="memo-condition-name">${esc(name)}</span>
        <span class="memo-condition-id">${esc(p.id ?? '')}</span>
        ${sizingHtml}
      </div>
      <div class="memo-condition-title">${esc(p.title)}</div>
      ${covMagnitudes}
    </li>`;
}

function renderRiskAssessment(narrative: NarrativeEvaluation, findings: readonly CleanDoctrineFinding[]): string {
  // The narrative.redFlagAssessment is the v1.6 prose; we render it verbatim.
  // The structured clean-doctrine findings are also shown as a compact table for
  // committee skim — bijective passthrough of dim findings.
  const findingsTable = findings.length === 0 ? '' : `
    <table class="memo-table memo-table-findings">
      <thead><tr><th class="memo-th-label">Dimension</th><th class="memo-th-tier">Tier</th><th class="memo-th-note">Finding</th></tr></thead>
      <tbody>
        ${findings.map(f => `
          <tr>
            <td class="memo-td-label">dim-${esc(String(f.dimNumber))} ${esc(f.dimensionId)}</td>
            <td class="memo-td-tier">${esc(f.tier)}</td>
            <td class="memo-td-note">${esc(f.headline)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  return `
    <section class="memo-section">
      <h2 class="memo-section-title">Risk Assessment</h2>
      ${findingsTable}
      <p class="memo-prose memo-prose-with-table">${proseToHtml(narrative.redFlagAssessment)}</p>
    </section>`;
}

function renderCommitteeRecommendation(narrative: NarrativeEvaluation): string {
  return `
    <section class="memo-section">
      <h2 class="memo-section-title">Committee Recommendation</h2>
      <p class="memo-prose">${proseToHtml(narrative.committeeRecommendation)}</p>
    </section>`;
}

function renderFooter(input: BuildCommitteeMemoInput, auth: AuthoritativeNumbers): string {
  const basisLabel =
    auth.concludedValueSource === 'operator-supplied' ? 'operator-supplied'
    : auth.concludedValueSource ?? 'unspecified';
  return `
    <footer class="memo-footer">
      <div>Narrative engine v${esc(input.narrative.engineVersion)}
        &nbsp;·&nbsp; Valuation basis: ${esc(basisLabel)}
        &nbsp;·&nbsp; ${esc(input.memoDate)}</div>
      <div class="memo-footer-fine">
        Figures sourced from the structured AuthoritativeNumbers projection
        + composed mitigation package. Doctrine-stressed LTV is the only
        leverage basis surfaced on this memo.
      </div>
    </footer>`;
}

/* --------------------------- inline CSS ---------------------------------- */

const STYLE = `
  /* Print page setup */
  @page { size: letter; margin: 0.6in; }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fafaf9; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a1a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .memo-document {
    max-width: 7.0in;
    margin: 0 auto;
    padding: 0.4in 0.5in;
    background: #ffffff;
  }

  /* ------- header ------- */
  .memo-header { border-bottom: 2px solid #1a1a1a; padding-bottom: 14pt; margin-bottom: 18pt; page-break-after: avoid; }
  .memo-header-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 12pt; }
  .memo-header-left { display: flex; flex-direction: column; }
  .memo-deal-name {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 22pt;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }
  .memo-subtitle {
    font-size: 9.5pt;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: #5a5a5a;
    margin-top: 4pt;
  }
  .memo-header-right { text-align: right; }
  .memo-date { font-size: 10pt; color: #5a5a5a; }
  .memo-rating-chip {
    margin-top: 4pt;
    display: inline-block;
    padding: 4pt 9pt;
    background: #1a1a1a;
    color: #fafaf9;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5pt;
    letter-spacing: 0.04em;
    border-radius: 1pt;
  }
  .memo-rating-chip strong { font-weight: 600; }
  .memo-attribution {
    font-size: 9pt;
    color: #6a6a6a;
    margin-top: 10pt;
    font-style: italic;
  }

  /* ------- sections ------- */
  .memo-section { margin-bottom: 18pt; page-break-inside: avoid; }
  .memo-section-title {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5pt;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: #2a2a2a;
    margin: 0 0 8pt 0;
    padding-bottom: 4pt;
    border-bottom: 1px solid #c0bdb8;
    font-weight: 600;
  }
  .memo-prose { margin: 0 0 6pt 0; text-align: justify; hyphens: auto; }
  .memo-prose-with-table { margin-top: 10pt; }

  /* ------- tables ------- */
  .memo-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4pt;
    margin-bottom: 6pt;
    page-break-inside: avoid;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 10pt;
  }
  .memo-table thead th {
    text-align: left;
    border-bottom: 1.5px solid #1a1a1a;
    padding: 5pt 6pt;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    color: #2a2a2a;
    font-weight: 600;
  }
  .memo-table .memo-th-num    { text-align: right; }
  .memo-table tbody tr        { border-bottom: 0.5px solid #e5e2dd; }
  .memo-table tbody tr:last-child { border-bottom: 1px solid #1a1a1a; }
  .memo-table tbody td        { padding: 4.5pt 6pt; vertical-align: top; }
  .memo-td-label              { font-weight: 500; }
  .memo-td-note               { color: #6a6a6a; font-size: 9.5pt; font-style: italic; }
  .memo-td-num                { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
  .memo-td-tier               { text-transform: capitalize; color: #2a2a2a; }
  .memo-table-credit tbody tr:nth-child(4) td,
  .memo-table-credit tbody tr:nth-child(5) td,
  .memo-table-credit tbody tr:nth-child(6) td,
  .memo-table-credit tbody tr:nth-child(7) td { font-weight: 600; }

  .memo-disclosure {
    margin: 8pt 0 0 0;
    padding: 7pt 10pt;
    background: #f5f3ef;
    border-left: 2.5px solid #6a6a6a;
    font-size: 9.5pt;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-style: italic;
    color: #2a2a2a;
  }
  .memo-disclosure strong { font-style: normal; font-weight: 600; }

  /* ------- restructuring callout (centerpiece) ------- */
  .memo-restructure-section { margin-top: 22pt; margin-bottom: 22pt; page-break-inside: avoid; }
  .memo-callout {
    border: 1px solid #1a1a1a;
    background: #f5f3ef;
    padding: 14pt 16pt 12pt 16pt;
    page-break-inside: avoid;
  }
  .memo-callout-headline { text-align: center; padding: 6pt 0 12pt 0; border-bottom: 0.5px solid #c0bdb8; margin-bottom: 12pt; }
  .memo-callout-headline-label {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: 0.20em;
    color: #5a5a5a;
    margin-bottom: 4pt;
  }
  .memo-callout-headline-figure {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 26pt;
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: -0.01em;
    line-height: 1.1;
  }
  .memo-callout-headline-detail {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 10pt;
    color: #2a2a2a;
    margin-top: 6pt;
    font-variant-numeric: tabular-nums;
  }
  .memo-callout-section { margin-top: 10pt; }
  .memo-callout-subhead {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: #2a2a2a;
    margin: 0 0 6pt 0;
    font-weight: 600;
  }
  .memo-callout-section p { margin: 0; font-size: 10.5pt; line-height: 1.55; }
  .memo-recon-list, .memo-condition-list {
    margin: 0;
    padding-left: 16pt;
    font-size: 10.5pt;
  }
  .memo-recon-list li { margin-bottom: 4pt; }
  .memo-condition { margin-bottom: 9pt; padding-bottom: 5pt; border-bottom: 0.5px dotted #c0bdb8; }
  .memo-condition:last-child { border-bottom: none; }
  .memo-condition-head { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; }
  .memo-condition-name { font-weight: 600; color: #1a1a1a; }
  .memo-condition-id {
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 8.5pt;
    color: #5a5a5a;
    margin-left: 8pt;
  }
  .memo-condition-sizing { color: #2a2a2a; font-style: italic; }
  .memo-condition-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 10.5pt;
    margin-top: 3pt;
    color: #2a2a2a;
  }
  .memo-condition-magnitudes {
    margin-top: 4pt;
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5pt;
    color: #2a2a2a;
    font-variant-numeric: tabular-nums;
  }

  /* ------- footer ------- */
  .memo-footer { margin-top: 28pt; padding-top: 10pt; border-top: 1px solid #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; color: #5a5a5a; page-break-before: avoid; }
  .memo-footer-fine { margin-top: 4pt; font-style: italic; color: #6a6a6a; }

  @media print {
    body, html { background: #ffffff; }
    .memo-document { max-width: 100%; padding: 0; }
  }
`;

/* --------------------------- top-level renderer -------------------------- */

function renderHtml(
  input: BuildCommitteeMemoInput,
  auth: AuthoritativeNumbers,
  findings: readonly CleanDoctrineFinding[],
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(input.dealName)} — Credit Committee Memorandum</title>
<style>${STYLE}</style>
</head>
<body>
<article class="memo-document">
  ${renderHeader(input, auth)}
  ${renderExecutiveSummary(input.narrative)}
  ${renderStressedCreditProfile(auth)}
  ${renderRestructuringPackage(auth, input.composedMitigationPackage)}
  ${renderRiskAssessment(input.narrative, findings)}
  ${renderCommitteeRecommendation(input.narrative)}
  ${renderFooter(input, auth)}
</article>
</body>
</html>`;
}

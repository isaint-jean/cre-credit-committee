/**
 * build-committee-memo.ts — Memo Renderer v2 (HTML, print-to-PDF).
 *
 * Pure function: given the narrative + clean-doctrine dealResult + composed
 * mitigation package, return a self-contained HTML string the lender opens in
 * any browser and prints to PDF.
 *
 * MEMO v2 — Isabelle's institutional 13-section structure, NARRATIVE-FIRST:
 *   §1–10 build the investment case, the risks, the evidence, the exit, and the
 *   validation as narrative — they do NOT lead with LTV / DSCR / scores. §11
 *   (Credit Structure) is the FIRST place leverage ratios and sized mitigants
 *   appear. §12–13 return to the thesis and the verdict.
 *
 * NO INTERNAL IDENTIFIERS IN PROSE:
 *   - Every dimension, tier, rule, lever, and handbook citation is translated
 *     through the committee-voice mapping layer before it reaches the page. No
 *     dim id/number, tier enum, JE_ code, "P-XX-N", or lever/proposal id ever
 *     renders.
 *
 * NUMBERS DISCIPLINE (load-bearing):
 *   - Every figure is sourced from the structured AuthoritativeNumbers block or
 *     the composed package's typed fields. NEVER parsed from LLM prose. NEVER
 *     recomputed. Prose slots render VERBATIM.
 *
 * NO EXTERNAL DEPS: inline CSS only; opens identically offline, prints cleanly.
 */
import type { NarrativeEvaluation, JudgmentEngineRuleId } from '@cre/contracts';
import { COMMITTEE_MEMO_VERSION } from '@cre/contracts';
import {
  projectAuthoritativeNumbers,
  extractCleanDoctrineFindings,
} from '../narrative/build-narrative.js';
import type {
  AuthoritativeNumbers,
  CleanDoctrineFinding,
} from '../narrative/prompt-templates.js';
import type { EvaluateDealResult } from '../../doctrine-clean/scoring/evaluate-deal.js';
import type {
  ComposedMitigationPackage,
  FundedExitProjection,
  SponsorBurdenProfile,
} from '../mitigation/compose-mitigations.js';
import type { MitigationProposal } from '@cre/contracts';
import {
  MEMO_SECTION_ORDER,
  MEMO_SECTION_HEADINGS,
  MEMO_RESTRUCTURE_TITLES,
  MEMO_RESTRUCTURE_SUBHEADS,
  MEMO_CALLOUT_LABELS,
  MEMO_NULL_SENTINEL,
  type MemoSectionId,
} from './committee-memo-format.js';
import {
  dimensionDisplayName,
  concernLevelLabel,
  leverDisplayName,
  judgmentRuleSentence,
  scrubResidualIdentifiers,
} from '../narrative/committee-voice.js';

/* --------------------------- public surface ------------------------------ */

/**
 * Render-source descriptor — drives the memo footer's "where did these
 * numbers come from?" banner. Snapshot path = pin-faithful; recompute path =
 * HEAD doctrine, the deal's true pinned version may differ.
 */
export type MemoRenderSource =
  | {
      readonly kind: 'snapshot';
      readonly capturedAt: string;                  // ISO timestamp
      readonly snapshotProducerVersion: string;
      readonly pinnedDoctrineVersion: string;
    }
  | {
      readonly kind: 'recompute';
      readonly pinnedDoctrineVersion: string;       // what the envelope says
      readonly headDoctrineVersion: string;         // what HEAD code is at
    };

export interface BuildCommitteeMemoInput {
  readonly dealName: string;
  readonly memoDate: string;                 // ISO date, e.g. '2026-06-12'
  readonly narrative: NarrativeEvaluation;
  /**
   * In-memory clean-doctrine result. Required for the recompute path (when
   * `auth` and `findings` are NOT supplied). Optional in the snapshot-reader
   * path — callers supplying both `auth` and `findings` may omit it.
   */
  readonly dealResult?: EvaluateDealResult;
  readonly composedMitigationPackage: ComposedMitigationPackage;
  /** Optional appraisal disclosure block (Appraisal & Value Challenge, §8). */
  readonly appraisalDisclosure?: AppraisalMemoDisclosure;
  /**
   * Snapshot reader path. When supplied, REPLACES the projected auth block +
   * findings (read from the persisted snapshot instead of re-projecting).
   */
  readonly auth?: AuthoritativeNumbers;
  readonly findings?: readonly CleanDoctrineFinding[];
  /**
   * NOI-basis disclosure (Underwriting Validation, §9). When
   * `shouldRender === true`, a neutral callout shows workbook NOI (judgment) vs
   * verdict NOI (contracted) + the divergence.
   */
  readonly noiBasis?: NoiBasisDisclosureForMemo;
  /** Footer "render source" banner (snapshot vs HEAD recompute). */
  readonly renderSource?: MemoRenderSource;
  /**
   * Graceful-degradation note. Set by the memo route when the narrative served
   * is not at the current engine version (the exact-version lookup missed and
   * the route fell back to the latest available narrative). Disclosed in the
   * footer so the reader knows the prose is from a prior engine version.
   */
  readonly narrativeVersionNote?: string;
  /**
   * Data-integrity gate report (SOFT + provenance WARN findings) — the
   * "exists-but-unreliable" side of Data Quality Review (§10).
   */
  readonly dataIntegrityReport?: import('../data-integrity/gate.js').DataIntegrityReport;
  /**
   * v2 — deal-level data confidence from AdjustedInputs. Drives the
   * Underwriting Validation (§9) posture and the Final Recommendation (§13)
   * gate. 'unvalidated' means no independent cash-flow source validated the
   * income — the memo renders §9 as provisional and §13 as gated. Optional;
   * absence → treated as unstated (no provisional banner).
   */
  readonly dataConfidence?: 'validated' | 'low_confidence' | 'unvalidated';
  /**
   * v2 — AdjustedInputs.dataQualityFlags (the judgment-engine adjustment
   * ledger). Underwriting Validation (§9) translates each to a committee-voice
   * sentence so assumed / substituted inputs read as assumptions, never as
   * sourced facts. Optional.
   */
  readonly dataQualityFlags?: readonly JudgmentEngineRuleId[];
  /**
   * v2 — the assumed (non-sourced) inputs the verdict rests on (surface D:
   * getAssumedInputs). These are line items with `raw === null` filled from a
   * benchmark / default / MANUAL entry — e.g. 640's 6.5% interest rate, which
   * is an assumption because the pre-sale materials state no coupon.
   * Underwriting Validation (§9) surfaces each AS an assumption, never as a
   * sourced figure. Optional.
   */
  readonly assumedInputs?: readonly AssumedInputForMemo[];
}

/** A single assumed (non-sourced) input surfaced in Underwriting Validation. */
export interface AssumedInputForMemo {
  readonly path: string;
  readonly label: string;
  readonly assumedValue: number | null;
  readonly feedsCoverage: boolean;
  readonly note?: string;
}

export interface NoiBasisDisclosureForMemo {
  readonly shouldRender: boolean;
  readonly judgmentNoi: number | null;
  readonly contractedNoi: number | null;
  readonly divergence: number | null;
  readonly divergenceReason: string;
}

export interface AppraisalMemoDisclosure {
  readonly asIsValue: number | null;
  readonly asStabilizedValue: number | null;
  readonly stabilizationMonths: number | null;
  readonly overallCapRate: number | null;
  readonly stabilizedNOI: number | null;
  readonly currentNOI: number | null;
  readonly loanAmount: number | null;            // for headline LTV computation
  readonly annualDebtService: number | null;     // for going-in DSCR
}

export function buildCommitteeMemo(input: BuildCommitteeMemoInput): string {
  if (input.auth === undefined && input.dealResult === undefined) {
    throw new Error(
      'buildCommitteeMemo: either `auth` (snapshot path) or `dealResult` ' +
      '(recompute path) must be supplied. Both are missing.',
    );
  }
  const auth = input.auth
    ?? projectAuthoritativeNumbers(input.dealResult!, input.composedMitigationPackage);
  const findings = input.findings
    ?? extractCleanDoctrineFindings(input.dealResult!);
  const fundedProj = input.composedMitigationPackage.fundedExitProjection;
  return renderHtml(input, auth, findings, fundedProj);
}

/* --------------------------- formatting helpers --------------------------- */

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return MEMO_NULL_SENTINEL;
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0)     + 'K';
  return '$' + n.toFixed(0);
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return MEMO_NULL_SENTINEL;
  return (n * 100).toFixed(2) + '%';
}

function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return MEMO_NULL_SENTINEL;
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

/** Convert prose with embedded \n into a paragraph body with <br> for line
 *  breaks (preserves bulleted-list shape from the narrative slots). */
function proseToHtml(prose: string): string {
  const lines = prose.split('\n');
  return lines.map(esc).join('<br>');
}

/** Section wrapper — one <section> + heading, given a section id and inner html. */
function section(id: Exclude<MemoSectionId, 'header' | 'footer'>, innerHtml: string, extraClass = ''): string {
  return `
    <section class="memo-section${extraClass ? ' ' + extraClass : ''}">
      <h2 class="memo-section-title">${MEMO_SECTION_HEADINGS[id]}</h2>
      ${innerHtml}
    </section>`;
}

/** Honest-blank callout — the committee CANNOT assess something because data is
 *  missing. Never filler; states the gap plainly. */
function honestBlank(leadSentence: string, missing: readonly string[]): string {
  const list = missing.length === 0
    ? ''
    : `<ul class="memo-blank-list">${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`;
  return `
      <div class="memo-honest-blank">
        <p>${esc(leadSentence)}</p>
        ${list}
      </div>`;
}

/* ----------------- structured content builders --------------------------- */

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

/** The plain-English risk name(s) a mitigant addresses (§11 mitigant → named
 *  §3 risk). Maps addressesDimensions through committee-voice; never an id. */
function addressedRiskLabel(p: MitigationProposal): string | null {
  const dims = p.addressesDimensions ?? [];
  if (dims.length === 0) return null;
  const names = Array.from(new Set(dims.map(dimensionDisplayName)));
  return names.join(' and ');
}

/* ----------------------------- header ------------------------------------ */

function renderHeader(input: BuildCommitteeMemoInput, auth: AuthoritativeNumbers): string {
  // When the income underlying the rating is unvalidated, the memo does not
  // present a rating — it refers the deal back. The label matches §13's gate.
  const ratingLabel = input.dataConfidence === 'unvalidated'
    ? 'Insufficient data — refer back'
    : (auth.ratingRecommendation ?? MEMO_NULL_SENTINEL);
  return `
    <header class="memo-header">
      <div class="memo-header-row">
        <div class="memo-header-left">
          <div class="memo-deal-name">${esc(input.dealName)}</div>
          <div class="memo-subtitle">Credit Committee Memorandum</div>
        </div>
        <div class="memo-header-right">
          <div class="memo-date">${esc(input.memoDate)}</div>
          <div class="memo-rating-chip">Recommendation: <strong>${esc(ratingLabel)}</strong></div>
        </div>
      </div>
      <div class="memo-attribution">
        Asset class: ${esc(auth.assetType ?? MEMO_NULL_SENTINEL)}${auth.subType ? ' / ' + esc(auth.subType) : ''}
        &nbsp;·&nbsp; Prepared by CRE Credit Committee — narrative engine v${esc(input.narrative.engineVersion)} · memo format v${esc(COMMITTEE_MEMO_VERSION)}
      </div>
    </header>`;
}

/* ----------------------------- §1 Investment Overview -------------------- */

function renderInvestmentOverview(input: BuildCommitteeMemoInput, auth: AuthoritativeNumbers): string {
  const identity = `
      <p class="memo-identity">
        ${esc(input.dealName)} — ${esc(auth.assetType ?? 'asset class not stated')}${auth.subType ? ' / ' + esc(auth.subType) : ''}.
        Requested loan ${esc(fmtUsd(auth.originalLoanAmount))}.
      </p>`;
  return section('investment_overview', `${identity}
      <p class="memo-prose">${proseToHtml(input.narrative.executiveSummary)}</p>`);
}

/* ----------------------------- §2 Investment Merits --------------------- */

const CANONICAL_DIMS: readonly string[] = [
  'leverage-ltv', 'coverage-dscr', 'debt-yield', 'refinance-feasibility',
  'income-concentration', 'rollover', 'cap-rate-valuation-stress',
  'asset-class', 'sponsor-borrower-quality',
];

function renderInvestmentMerits(auth: AuthoritativeNumbers, findings: readonly CleanDoctrineFinding[]): string {
  const flagged = new Set(findings.map(f => f.dimensionId));
  // Merits = the credit factors that did NOT raise a concern. Derived purely
  // from the findings set (no overclaiming): a factor absent from the risk list
  // is a factor of no concern. Sponsor quality is excluded — it is universally
  // unassessed, not a merit (see Sponsor Assessment).
  const clean = CANONICAL_DIMS
    .filter(d => d !== 'sponsor-borrower-quality' && !flagged.has(d))
    .map(dimensionDisplayName);
  const rating = auth.ratingRecommendation;
  const lead = rating === 'Approve' || rating === 'ApproveWithConditions'
    ? 'On the clean-doctrine read, the deal is supportable subject to the structure below; the merits are the factors that did not raise a credit concern.'
    : 'The clean-doctrine read is cautious on this deal. The following factors did not, on their own, raise a credit concern.';
  const cleanList = clean.length === 0
    ? `<p>No credit factor came through clean; the case rests on the structural protections in Credit Structure below.</p>`
    : `<p>No concern was raised on: ${esc(clean.join('; '))}.</p>`;
  return section('investment_merits', `
      <p class="memo-prose">${esc(lead)}</p>
      ${cleanList}`);
}

/* ----------------------------- §3 Key Credit Risks ---------------------- */

function renderKeyCreditRisks(narrative: NarrativeEvaluation, findings: readonly CleanDoctrineFinding[]): string {
  const findingsTable = findings.length === 0 ? '' : `
    <table class="memo-table memo-table-findings">
      <thead><tr><th class="memo-th-label">Credit factor</th><th class="memo-th-tier">Concern level</th><th class="memo-th-note">Loss path</th></tr></thead>
      <tbody>
        ${findings.map(f => `
          <tr>
            <td class="memo-td-label">${esc(dimensionDisplayName(f.dimensionId))}</td>
            <td class="memo-td-tier">${esc(concernLevelLabel(f.tier))}</td>
            <td class="memo-td-note">${esc(f.headline)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  return section('key_credit_risks', `${findingsTable}
      <p class="memo-prose memo-prose-with-table">${proseToHtml(narrative.redFlagAssessment)}</p>`);
}

/* ----------------------------- §4 Sponsor Assessment -------------------- */

function renderSponsorAssessment(_input: BuildCommitteeMemoInput): string {
  // Honest-blank: sponsor quality is not surfaced by CMBS-style filings in a
  // structured form, so the committee cannot evaluate it. State the gap plainly
  // rather than filling it. (PART-4 honesty wiring may extend the missing list
  // from the deal's own flags.)
  const blank = honestBlank(
    'The committee cannot reasonably evaluate sponsor quality because the deal file does not include the information a sponsor assessment requires:',
    [
      'sponsor financial statements (net worth and liquidity)',
      'a schedule of real estate owned and prior-deal track record',
      'any guaranty, recourse, or completion commitment and the sponsor’s capacity to stand behind it',
      'disclosure of any prior credit events (workouts, discounted payoffs, defaults)',
    ],
  );
  return section('sponsor_assessment', blank);
}

/* ----------------------------- §5 Tenant Analysis ----------------------- */

function renderTenantAnalysis(findings: readonly CleanDoctrineFinding[]): string {
  const tenantFactors = findings.filter(f => f.dimensionId === 'income-concentration' || f.dimensionId === 'rollover');
  if (tenantFactors.length === 0) {
    return section('tenant_analysis', `
      <p class="memo-prose">No tenant-concentration or lease-rollover concern was raised on the tenancy that could be read from the deal file. Where a full rent roll was not extracted, tenant-level income should be confirmed before close (see Data Quality Review).</p>`);
  }
  const bullets = tenantFactors
    .map(f => `<li><strong>${esc(dimensionDisplayName(f.dimensionId))}.</strong> ${esc(f.headline)}</li>`)
    .join('');
  return section('tenant_analysis', `
      <ul class="memo-analysis-list">${bullets}</ul>`);
}

/* ----------------------------- §6 Market & Competitive Position --------- */

function renderMarketPosition(): string {
  // Structural honest-blank: submarket / comparable data is not in the deal
  // file today for any deal on this pipeline.
  const blank = honestBlank(
    'The committee cannot assess the submarket and competitive position because the deal file does not include the market evidence that assessment requires:',
    [
      'sale comparables supporting the concluded value',
      'leasing and rent comparables supporting the underwritten rents',
      'submarket vacancy, absorption, and supply data',
    ],
  );
  return section('market_position', blank);
}

/* ----------------------------- §7 Exit & Refinance Analysis ------------- */

function renderExitRefinance(auth: AuthoritativeNumbers): string {
  // NARRATIVE-FIRST: state the exit CONCLUSION in words. The quantified exit
  // measures live in Credit Structure (§11).
  const exit = auth.exitDscrBaseline;
  const trigger = auth.exitDscrTrigger;
  let body: string;
  if (exit === null || exit === undefined || !Number.isFinite(exit)) {
    body = 'The exit and refinancing picture could not be established from the data provided; the loan’s ability to repay at maturity is an open question pending the missing inputs noted in Data Quality Review.';
  } else if (trigger !== null && trigger !== undefined && exit < trigger) {
    body = 'Under stressed take-out assumptions, the loan is not expected to refinance at maturity on its own cash flow without a paydown or fresh equity. The structural cures that bring the exit within tolerance — and the quantified exit measures behind this conclusion — appear in Credit Structure below.';
  } else {
    body = 'Under stressed take-out assumptions, the loan is expected to be refinanceable at maturity on its own cash flow. The quantified exit measures appear in Credit Structure below.';
  }
  return section('exit_refinance', `<p class="memo-prose">${esc(body)}</p>`);
}

/* ----------------------------- §8 Appraisal & Value Challenge ----------- */

function renderAppraisalValueChallenge(auth: AuthoritativeNumbers, appraisal: AppraisalMemoDisclosure | undefined): string {
  const basisLabel =
    auth.concludedValueSource === 'extracted-appraisal' ? 'a third-party appraisal'
    : auth.concludedValueSource === 'extracted-asr'     ? 'the issuer’s pre-sale disclosure'
    : auth.concludedValueSource === 'operator-supplied' ? 'a value supplied by the operator, not an independent appraisal'
    : 'a source that was not specified';
  const challenge =
    `The concluded value rests on ${basisLabel}. Against that, the engine re-derives value independently by stressing the capitalization rate and haircutting cash flow to a sustainable level; that stressed value is shown in Credit Structure below. Where the stressed value falls materially short of the concluded value, the equity cushion implied by the concluded value may be overstated, and leverage should be read against the stressed value rather than the appraisal.`;
  const confidence = auth.valuationConfidenceNote
    ? `<p class="memo-disclosure"><strong>Valuation basis note.</strong> ${esc(auth.valuationConfidenceNote)}</p>`
    : '';
  const appraisalTable = appraisal ? renderAppraisalDisclosure(appraisal) : '';
  return section('appraisal_value_challenge', `
      <p class="memo-prose">${esc(challenge)}</p>
      ${confidence}
      ${appraisalTable}`);
}

function renderAppraisalDisclosure(d: AppraisalMemoDisclosure): string {
  const goingInDy =
    d.currentNOI !== null && d.loanAmount !== null && d.loanAmount > 0
      ? d.currentNOI / d.loanAmount
      : null;
  const stabDy =
    d.stabilizedNOI !== null && d.loanAmount !== null && d.loanAmount > 0
      ? d.stabilizedNOI / d.loanAmount
      : null;
  const leaseUpNote =
    d.stabilizationMonths !== null
      ? `${d.stabilizationMonths}-month lease-up`
      : 'lease-up tenor n/a';
  const rows: Array<[string, string, string]> = [
    ['Appraisal As-Is value',           'third-party appraisal',                  fmtUsd(d.asIsValue)],
    ['Appraisal As-Stabilized value',   leaseUpNote,                              fmtUsd(d.asStabilizedValue)],
    ['Appraiser overall cap rate',      'concluded overall cap rate',             fmtPct(d.overallCapRate)],
    ['Going-in NOI',                    'appraisal operating-history actuals',    fmtUsd(d.currentNOI)],
    ['Stabilized NOI',                  'appraisal pro-forma',                    fmtUsd(d.stabilizedNOI)],
    ['Going-in debt yield',             'going-in NOI / loan',                    fmtPct(goingInDy)],
    ['Stabilized debt yield',           'stabilized NOI / loan',                  fmtPct(stabDy)],
  ];
  return `
    <h3 class="memo-section-subhead">Appraisal disclosure</h3>
    <table class="memo-table memo-table-appraisal">
      <thead><tr><th class="memo-th-label">Metric</th><th class="memo-th-note">Basis</th><th class="memo-th-num">Value</th></tr></thead>
      <tbody>
        ${rows.map(([label, note, val]) => `
          <tr>
            <td class="memo-td-label">${esc(label)}</td>
            <td class="memo-td-note">${esc(note)}</td>
            <td class="memo-td-num">${esc(val)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="memo-disclosure">
      Going-in coverage may read low or negative where the property was in
      lease-up at the appraisal date; the going-in figures are the appraisal’s
      earliest actuals column and the stabilized figures are its pro-forma.
      Leverage is read against the As-Is value, which is more conservative than
      As-Stabilized.
    </p>`;
}

/* ----------------------------- §9 Underwriting Validation --------------- */

// Judgment-engine flags that represent an ASSUMPTION or SUBSTITUTION the reader
// must see surfaced as an assumption (never as a sourced fact). Ordered for a
// stable, readable list.
const ASSUMPTION_FLAG_ORDER: readonly JudgmentEngineRuleId[] = [
  'JE_INTEREST_RATE_SUBSTITUTED_FROM_BENCHMARK',
  'JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY',
  'JE_CAP_RATE_SUBSTITUTED_FROM_MARKET_BENCHMARK',
  'JE_VACANCY_SUBSTITUTED_FROM_LIBRARY',
  'JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK',
  'JE_EXPENSE_RATIO_SUBSTITUTED_FROM_LIBRARY',
  'JE_DSCR_SUBSTITUTED_FROM_LIBRARY',
  'JE_CONCESSIONS_SUBSTITUTED_FROM_DEFAULT',
  'JE_TERMINAL_CAP_RATE_FROM_LIBRARY_PLUS_SPREAD',
  'JE_TERMINAL_CAP_RATE_FROM_SPOT_PLUS_SPREAD',
  'JE_OTHER_INCOME_DEFAULTED',
  'JE_RENT_GROWTH_DEFAULTED',
  'JE_EXPENSE_GROWTH_DEFAULTED',
  'JE_MONTHLY_CAPEX_DEFAULTED',
  'JE_REPLACEMENT_RESERVES_DEFAULTED',
  'JE_TENANT_IMPROVEMENTS_DEFAULTED',
  'JE_LEASING_COMMISSIONS_DEFAULTED',
  'JE_UPFRONT_REPLACEMENT_RESERVES_DEFAULTED',
  'JE_NOI_DIVERGES_FROM_ASR',
  'JE_NOI_BELOW_TRAILING_ACTUAL',
];

function renderUnderwritingValidation(input: BuildCommitteeMemoInput): string {
  const dc = input.dataConfidence;
  const flags = input.dataQualityFlags ?? [];
  // Confidence posture — plain words, no enum.
  let posture: string;
  if (dc === 'unvalidated') {
    posture = 'The underwriting could not be validated against an independent cash-flow source. The concluded net operating income rests on conservative fallbacks rather than a trailing actual; the income figures in this memo should be treated as PROVISIONAL until an independent operating statement is obtained.';
  } else if (dc === 'low_confidence') {
    posture = 'The underwriting was validated only against a seller projection or an in-place estimate, not a trailing actual. Confidence in the income is limited; a trailing operating statement would firm it up.';
  } else if (dc === 'validated') {
    posture = 'The underwriting was validated against a trailing actual operating statement.';
  } else {
    posture = 'The basis on which the underwriting was validated was not stated.';
  }
  // Assumptions surfaced AS assumptions — two sources combined:
  //   (a) assumed LINE ITEMS (surface D: raw===null filled from benchmark /
  //       default / MANUAL, e.g. the 6.5% interest rate); and
  //   (b) judgment-engine substitution FLAGS.
  const assumed = input.assumedInputs ?? [];
  const flagPresent = ASSUMPTION_FLAG_ORDER.filter(f => flags.includes(f));
  const items: string[] = [
    ...assumed.map(a => {
      const feeds = a.feedsCoverage ? ' This figure feeds the coverage and debt yield ratios, so those ratios rest on an assumption.' : '';
      const note = a.note ? ` ${esc(scrubResidualIdentifiers(a.note))}` : '';
      return `<li><strong>${esc(assumedLabel(a))}</strong> — assumed at ${esc(fmtAssumed(a))}; an assumption, not a figure sourced from the loan documents.${feeds}${note}</li>`;
    }),
    ...flagPresent.map(f => `<li>${esc(judgmentRuleSentence(f))}</li>`),
  ];
  const assumptionsBlock = items.length === 0
    ? ''
    : `
      <h3 class="memo-section-subhead">Assumed and substituted inputs</h3>
      <p>The following inputs were not sourced from the deal file and are assumptions the underwriting rests on:</p>
      <ul class="memo-analysis-list">${items.join('')}</ul>`;
  return section('underwriting_validation', `
      <p class="memo-prose">${esc(posture)}</p>
      ${renderNoiBasisCallout(input.noiBasis)}
      ${assumptionsBlock}`);
}

/** A committee-readable label for an assumed input. When the service could not
 *  supply a friendly label (it falls back to the raw dotted AdjustedInputs
 *  path), humanize the last path segment so no dotted identifier reaches the
 *  page. */
function assumedLabel(a: AssumedInputForMemo): string {
  if (!a.label.includes('.')) return a.label;
  const seg = a.label.split('.').pop()!.replace(/(Pct|Months|Annual|Amount|Usd)$/g, '');
  const words = seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
  return words.length === 0 ? 'An assumed input' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Format an assumed input's value by its path — a rate as a percent, a dollar
 *  figure as USD, anything else as a bare number. */
function fmtAssumed(a: AssumedInputForMemo): string {
  if (a.assumedValue === null) return MEMO_NULL_SENTINEL;
  if (/[Rr]ate|[Cc]oupon|[Yy]ield/.test(a.path)) return fmtPct(a.assumedValue);
  if (/[Ss]ervice|[Ii]ncome|[Bb]alance|[Aa]mount|[Rr]eserve/.test(a.path)) return fmtUsd(a.assumedValue);
  return String(a.assumedValue);
}

/**
 * NOI-basis disclosure callout. Renders only when the resolver decided
 * `shouldRender === true` (lease-up deal with a real divergence between
 * workbook and verdict NOI).
 */
function renderNoiBasisCallout(noiBasis: NoiBasisDisclosureForMemo | undefined): string {
  if (noiBasis === undefined || !noiBasis.shouldRender) return '';
  const fmt = (n: number | null): string => n !== null ? `$${Math.round(n).toLocaleString()}` : MEMO_NULL_SENTINEL;
  const sign = (noiBasis.divergence ?? 0) >= 0 ? '+' : '';
  return `
    <p class="memo-disclosure memo-noi-basis"><strong>NOI basis:</strong>
      workbook (judgment) ${esc(fmt(noiBasis.judgmentNoi))};
      verdict (contracted) ${esc(fmt(noiBasis.contractedNoi))};
      &Delta; ${esc(noiBasis.divergence !== null ? sign + fmt(noiBasis.divergence) : MEMO_NULL_SENTINEL)}.
      ${esc(noiBasis.divergenceReason)}
    </p>`;
}

/* ----------------------------- §10 Data Quality Review ------------------ */

function renderDataQualityReview(input: BuildCommitteeMemoInput): string {
  const intro =
    `<p class="memo-prose">This section separates two distinct diligence problems: (A) data that is MISSING and prevented a part of the analysis, and (B) data that WAS used but is unreliable — caller-supplied or out of the normal range — and should be verified before relying on the verdict.</p>`;

  // (A) MISSING → prevents analysis. Sourced from the Open Items narrative slot.
  const openProse = input.narrative.openItemsAndDataRequired;
  const missingBlock = (openProse === undefined || openProse === null || openProse === '')
    ? `<p><em>No evaluable principle was blocked for missing data.</em></p>`
    : `<div class="memo-prose">${proseToHtml(openProse)}</div>`;

  // (B) EXISTS but unreliable. Sourced from the data-integrity gate report.
  const unreliableBlock = renderDataIntegrityBlock(input.dataIntegrityReport);

  return section('data_quality_review', `
      ${intro}
      <h3 class="memo-section-subhead">A. Missing data — prevented part of the analysis</h3>
      ${missingBlock}
      <h3 class="memo-section-subhead">B. Data used but unreliable — verify before relying on the verdict</h3>
      ${unreliableBlock}`);
}

function renderDataIntegrityBlock(
  report: import('../data-integrity/gate.js').DataIntegrityReport | undefined,
): string {
  if (report === undefined) return `<p><em>No unreliable-data findings were flagged.</em></p>`;
  const provenanceWarns = report.findings.filter((f) => f.layer === 'provenance' && f.severity === 'WARN');
  const plausibilitySoft = report.findings.filter((f) => f.layer === 'plausibility' && f.severity === 'SOFT');
  const xcheckWarns = report.findings.filter((f) => f.layer === 'cross_consistency' && f.severity === 'WARN');
  if (provenanceWarns.length === 0 && plausibilitySoft.length === 0 && xcheckWarns.length === 0) {
    return `<p><em>No unreliable-data findings were flagged.</em></p>`;
  }
  const parts: string[] = [];
  if (plausibilitySoft.length > 0) {
    parts.push(
      `<h4 class="memo-dq-subhead">Out-of-range numbers</h4><ul>` +
      plausibilitySoft.map((f) => `<li><strong>${esc(scrubResidualIdentifiers(f.title))}</strong> — ${esc(scrubResidualIdentifiers(f.message))}</li>`).join('') +
      `</ul>`,
    );
  }
  if (xcheckWarns.length > 0) {
    parts.push(
      `<h4 class="memo-dq-subhead">Cross-consistency observations</h4><ul>` +
      xcheckWarns.map((f) => `<li><strong>${esc(scrubResidualIdentifiers(f.title))}</strong> — ${esc(scrubResidualIdentifiers(f.message))}</li>`).join('') +
      `</ul>`,
    );
  }
  if (provenanceWarns.length > 0) {
    parts.push(
      `<h4 class="memo-dq-subhead">Caller-supplied verdict-critical inputs</h4>` +
      `<p>These fields are caller-supplied rather than document-extracted. They were used in the underwriting but should be verified against the underlying documents before relying on the verdict:</p><ul>` +
      provenanceWarns.map((f) => `<li><strong>${esc(scrubResidualIdentifiers(f.title))}</strong></li>`).join('') +
      `</ul>`,
    );
  }
  return `<div class="memo-prose">${parts.join('\n')}</div>`;
}

/* ----------------------------- §11 Credit Structure --------------------- */

function renderCreditStructure(
  input: BuildCommitteeMemoInput,
  auth: AuthoritativeNumbers,
  funded: FundedExitProjection,
): string {
  const profile = renderStressedProfileInner(auth, funded);
  const restructure = renderRestructuringInner(auth, input.composedMitigationPackage, funded);
  const burden = renderSponsorBurdenInner(
    input.composedMitigationPackage.sponsorBurdenProfile,
    input.composedMitigationPackage.finalLoanAmount,
  );
  return section('credit_structure', `
      <p class="memo-prose">This is the first section in which leverage ratios and sized conditions appear. Every figure is engine-derived; leverage is read against the stressed value, not the appraisal.</p>
      <h3 class="memo-section-subhead">Stressed credit profile</h3>
      ${profile}
      ${restructure}
      <h3 class="memo-section-subhead">Sponsor burden of the structure</h3>
      ${burden}`, 'memo-restructure-section');
}

function renderStressedProfileInner(auth: AuthoritativeNumbers, funded: FundedExitProjection): string {
  const rows: Array<[string, string, string]> = [
    ['Original loan amount',             '',                              fmtUsd(auth.originalLoanAmount)],
    ['Concluded value',                  'as underwritten',               fmtUsd(auth.concludedValue)],
    ['Stressed value',                   'cap-rate stress + sustainable-cash-flow haircut', fmtUsd(auth.stressedValue)],
    ['Stressed LTV (at original loan)',  '',                              fmtPct(auth.stressedLtv)],
    ['Stressed LTV (at reduced loan)',   '',                              fmtPct(auth.stressedLtvAtFinalLoan)],
    ['Exit DSCR (raw, baseline)',        '',                              fmtDscr(auth.exitDscrBaseline)],
    ['Exit DSCR (raw, at reduced loan)', '',                              fmtDscr(auth.exitDscrAtFinalLoan)],
    ['Exit DSCR (funded, at reduced loan)', funded.reserveTarget !== null ? `after $${(funded.reserveTarget / 1_000_000).toFixed(2)}M hard-trap reserve accrual` : '', fmtDscr(funded.fundedExitAtFinalLoan)],
    ['Exit-DSCR refinance threshold',    '',                              fmtDscr(auth.exitDscrTrigger)],
    ['Exit-DSCR desk cure target',       '',                              fmtDscr(auth.exitDscrCureTarget)],
  ];
  return `
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
      </table>`;
}

function renderRestructuringInner(auth: AuthoritativeNumbers, composed: ComposedMitigationPackage, funded: FundedExitProjection): string {
  const { deLevering, orthogonal } = categorizeProposals(composed.proposals);
  const reduce = deLevering.find(p => p.lever === 'reduce_proceeds');
  const proceedsCut    = composed.reconciliation.proceedsReduction;
  const originalLoan   = composed.reconciliation.originalLoanAmount;
  const finalLoan      = composed.reconciliation.finalLoanAmount;
  const reduceEquity   = reduce?.requiredEquity ?? proceedsCut;
  const isStructuredHold = proceedsCut === 0;

  const headline = isStructuredHold
    ? `
    <div class="memo-callout-headline">
      <div class="memo-callout-headline-label">${MEMO_CALLOUT_LABELS.hold}</div>
      <div class="memo-callout-headline-figure">HOLD at ${esc(fmtUsd(originalLoan))}</div>
      <div class="memo-callout-headline-detail">
        No proceeds reduction &nbsp;·&nbsp; Leverage + exit risk held within the desk's structured tolerance via structural cures (below)
      </div>
    </div>`
    : `
    <div class="memo-callout-headline">
      <div class="memo-callout-headline-label">${MEMO_CALLOUT_LABELS.cut}</div>
      <div class="memo-callout-headline-figure">${esc(fmtUsd(proceedsCut))} proceeds reduction</div>
      <div class="memo-callout-headline-detail">
        Loan ${esc(fmtUsd(originalLoan))} &rarr; ${esc(fmtUsd(finalLoan))}
        &nbsp;·&nbsp; Sponsor fills ${esc(fmtUsd(reduceEquity))} equity gap at closing
      </div>
    </div>`;

  const ltvTrigger = auth.ltvTrigger;
  const whyShape = isStructuredHold
    ? `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">${MEMO_RESTRUCTURE_SUBHEADS.whyShape}</h3>
      <p>
        The stressed LTV (loan against the stressed value of ${esc(fmtUsd(auth.stressedValue))})
        is <strong>${esc(fmtPct(auth.stressedLtv))}</strong> — above the ${esc(fmtPct(ltvTrigger))}
        trigger but WITHIN the desk's structured leverage band. The exit DSCR is
        <strong>${esc(fmtDscr(auth.exitDscrBaseline))}</strong> — below the ${esc(fmtDscr(auth.exitDscrTrigger))}
        refinance threshold but WITHIN the desk's structured exit floor. Both are covered by
        structural protections; origination proceeds are held at ${esc(fmtUsd(originalLoan))}.
      </p>
    </div>`
    : `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">${MEMO_RESTRUCTURE_SUBHEADS.whyShape}</h3>
      <p>
        At the original loan amount, the stressed LTV (loan against the stressed value of
        ${esc(fmtUsd(auth.stressedValue))}) was <strong>${esc(fmtPct(auth.stressedLtv))}</strong> —
        above the ${esc(fmtPct(ltvTrigger))} trigger AND above the desk's structured-LTV ceiling.
        Above the ceiling, structural protections alone cannot make the buyer comfortable; proceeds
        must be cut to the ceiling. Reducing proceeds to ${esc(fmtUsd(finalLoan))} brings the stressed
        LTV to <strong>${esc(fmtPct(auth.stressedLtvAtFinalLoan))}</strong>. Exit DSCR at the reduced
        loan is <strong>${esc(fmtDscr(auth.exitDscrAtFinalLoan))}</strong> on the raw basis — still below
        the ${esc(fmtDscr(auth.exitDscrTrigger))} refinance threshold. ${funded.fundedExitAtFinalLoan !== null && funded.reserveTarget !== null ? `
        After the hard cash trap accrues ${esc(fmtUsd(funded.reserveTarget))} into the refinance reserve
        over the term, the funded exit DSCR is <strong>${esc(fmtDscr(funded.fundedExitAtFinalLoan))}</strong>,
        holding the residual exit risk within tolerance.` : `
        The residual exit risk is held within tolerance by the reserve and recourse conditions below.`}
      </p>
    </div>`;

  const reconNotes = composed.reconciliation.notes;
  const reconciliation = reconNotes.length === 0 ? '' : `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">${MEMO_RESTRUCTURE_SUBHEADS.compositionReconciliation}</h3>
      <ul class="memo-recon-list">${reconNotes.map(n => `<li>${esc(scrubResidualIdentifiers(n))}</li>`).join('')}</ul>
    </div>`;

  const orthogonalSection = orthogonal.length === 0 ? '' : `
    <div class="memo-callout-section">
      <h3 class="memo-callout-subhead">${MEMO_RESTRUCTURE_SUBHEADS.orthogonalConditions}</h3>
      <ul class="memo-condition-list">
        ${orthogonal.map(p => renderOrthogonalProposal(p, composed)).join('')}
      </ul>
    </div>`;

  const sectionTitle = isStructuredHold ? MEMO_RESTRUCTURE_TITLES.hold : MEMO_RESTRUCTURE_TITLES.cut;
  return `
      <h3 class="memo-section-subhead">${esc(sectionTitle)}</h3>
      <div class="memo-callout">
        ${headline}
        ${whyShape}
        ${reconciliation}
        ${orthogonalSection}
      </div>`;
}

function fundingTagFor(lever: string): string {
  switch (lever) {
    case 'cash_sweep_refi_reserve':
    case 'in_place_cash_management':
    case 'springing_cash_management':
    case 'fund_reserve':
      return 'deal-funded reserve';
    case 'leverage_band_recourse':
    case 'require_guaranty':
    case 'springing_dscr_recourse':
      return 'sponsor recourse';
    case 'condition_precedent':
      return 'closing condition';
    case 'require_amortization':
      return 'origination term';
    default:
      return '';
  }
}

function renderOrthogonalProposal(p: MitigationProposal, composed: ComposedMitigationPackage): string {
  const name = leverDisplayName(p.lever);
  const covLines = composed.reconciliation.covenantMagnitudesAtFinalLoan
    .find(c => c.lever === p.lever && c.leverId === (p.id ?? ''));
  const covMagnitudes = covLines && covLines.resolvedMagnitudes.length > 0
    ? `<div class="memo-condition-magnitudes">
         ${covLines.resolvedMagnitudes.map(m => `<div class="memo-condition-magnitude-row">&nbsp;&nbsp;${esc(scrubResidualIdentifiers(m))}</div>`).join('')}
       </div>`
    : '';
  const sizing: string[] = [];
  if (p.requiredEquity !== undefined)  sizing.push(`Required equity ${fmtUsd(p.requiredEquity)}`);
  if (p.requiredPaydown !== undefined) sizing.push(`Required paydown ${fmtUsd(p.requiredPaydown)}`);
  if (p.requiredReserve !== undefined) sizing.push(`Required reserve ${fmtUsd(p.requiredReserve)}`);
  const sizingHtml = sizing.length === 0 ? '' : `<span class="memo-condition-sizing"> &nbsp;·&nbsp; ${esc(sizing.join(' · '))}</span>`;
  const fundingTag = fundingTagFor(p.lever);
  const fundingChip = fundingTag === '' ? '' : ` <span class="memo-condition-funding">${esc(fundingTag)}</span>`;
  // §11 mitigant → named §3 risk: state which risk this condition addresses, in
  // plain English (never a dimension id).
  const addressed = addressedRiskLabel(p);
  const addressedHtml = addressed === null ? '' : `<div class="memo-condition-addresses">Addresses: ${esc(addressed)}.</div>`;
  const keyTermsHtml = p.structuralChanges.length === 0 ? '' : `
      <ul class="memo-condition-terms">
        ${p.structuralChanges.map(s => `<li>${esc(scrubResidualIdentifiers(s))}</li>`).join('')}
      </ul>`;
  return `
    <li class="memo-condition">
      <div class="memo-condition-head">
        <span class="memo-condition-name">${esc(name)}</span>${fundingChip}
        ${sizingHtml}
      </div>
      <div class="memo-condition-title">${esc(scrubResidualIdentifiers(p.title))}</div>
      ${addressedHtml}
      ${keyTermsHtml}
      ${covMagnitudes}
    </li>`;
}

function renderSponsorBurdenInner(profile: SponsorBurdenProfile, finalLoanAmount: number): string {
  const recourseRows = profile.recourseBreakdown.length === 0
    ? `<tr><td class="memo-td-label" colspan="3"><em>(no recourse-flavored levers in package)</em></td></tr>`
    : profile.recourseBreakdown.map(r => `
        <tr>
          <td class="memo-td-label">${esc(leverDisplayName(r.lever))}</td>
          <td class="memo-td-note">${esc(scrubResidualIdentifiers(r.note))}</td>
          <td class="memo-td-num">${esc(fmtUsd(r.capUsd))}</td>
        </tr>`).join('');

  const flagBanner = profile.flagsBurden && profile.flagCopy !== null
    ? `<div class="memo-burden-flag">
         <div class="memo-burden-flag-label">Burden flag</div>
         <p>${esc(profile.flagCopy)}</p>
       </div>`
    : `<p class="memo-burden-clear">Cash-at-risk is below the desk's ${(profile.flagThreshold * 100).toFixed(0)}% acceptability line for a non-recourse execution.</p>`;

  const lockupStr = profile.distributionLockupYears !== null
    ? profile.distributionLockupYears.toFixed(1) + ' yr'
    : '— (no cash trap)';

  return `
      <table class="memo-table memo-table-burden">
        <thead><tr><th class="memo-th-label">Commitment</th><th class="memo-th-note">Source</th><th class="memo-th-num">Amount</th></tr></thead>
        <tbody>
          <tr>
            <td class="memo-td-label">Equity ask</td>
            <td class="memo-td-note">proceeds cut filled by sponsor at closing</td>
            <td class="memo-td-num">${esc(fmtUsd(profile.equityAsk))}</td>
          </tr>
          ${recourseRows}
          <tr class="memo-table-subtotal">
            <td class="memo-td-label">Net recourse cap</td>
            <td class="memo-td-note">sum of recourse-flavored levers above (contingent cash-at-risk)</td>
            <td class="memo-td-num">${esc(fmtUsd(profile.netRecourseCap))}</td>
          </tr>
          <tr class="memo-table-divider"><td colspan="3" class="memo-td-divider"></td></tr>
          <tr>
            <td class="memo-td-label">Net-worth requirement</td>
            <td class="memo-td-note">balance-sheet capacity covenant (capacity to demonstrate, not at-risk capital)</td>
            <td class="memo-td-num">${esc(fmtUsd(profile.netWorthRequirement))}</td>
          </tr>
          <tr>
            <td class="memo-td-label">Liquidity requirement</td>
            <td class="memo-td-note">balance-sheet capacity covenant</td>
            <td class="memo-td-num">${esc(fmtUsd(profile.liquidityRequirement))}</td>
          </tr>
          <tr>
            <td class="memo-td-label">Distribution lockup</td>
            <td class="memo-td-note">years the cash trap holds before the refinance reserve funds</td>
            <td class="memo-td-num">${esc(lockupStr)}</td>
          </tr>
        </tbody>
      </table>
      <div class="memo-burden-aggregate">
        <div class="memo-burden-aggregate-row">
          <span class="memo-burden-aggregate-label">Cash-at-risk (equity + net recourse)</span>
          <span class="memo-burden-aggregate-value">${esc(fmtUsd(profile.cashAtRiskUsd))} &nbsp; · &nbsp; ${esc((profile.cashAtRiskPctOfFinalLoan * 100).toFixed(1))}% of the reduced loan (${esc(fmtUsd(finalLoanAmount))})</span>
        </div>
        <div class="memo-burden-aggregate-note">Threshold: ${esc((profile.flagThreshold * 100).toFixed(0))}% of the reduced loan</div>
      </div>
      ${flagBanner}`;
}

/* ----------------------------- §12 Investment Committee View ------------ */

function renderCommitteeView(narrative: NarrativeEvaluation): string {
  return section('committee_view', `<p class="memo-prose">${proseToHtml(narrative.committeeRecommendation)}</p>`);
}

/* ----------------------------- §13 Final Recommendation ----------------- */

function renderFinalRecommendation(input: BuildCommitteeMemoInput, auth: AuthoritativeNumbers): string {
  const rating = auth.ratingRecommendation ?? 'No recommendation stated';
  const gated = input.dataConfidence === 'unvalidated';
  const displayRating = gated ? 'Insufficient data — refer back to committee' : rating;
  const thesis = gated
    ? 'The investment thesis cannot yet survive the numbers: the income underlying every ratio is unvalidated, so the committee is not in a position to issue a final credit recommendation. Obtain an independent operating statement and re-underwrite before this deal returns to committee.'
    : (rating === 'Approve' || rating === 'ApproveWithConditions')
      ? 'The thesis set out in the Investment Overview survives the numbers in Credit Structure, provided the sized conditions above are implemented. The residual risk is held within the desk’s tolerance by the structure.'
      : 'The thesis does not survive the numbers: the risks in Key Credit Risks are not adequately offset by the available structure. The committee recommendation stands.';
  return section('final_recommendation', `
      <div class="memo-final-rec">
        <div class="memo-final-rec-label">Recommendation</div>
        <div class="memo-final-rec-value">${esc(displayRating)}</div>
      </div>
      <p class="memo-prose">${esc(thesis)}</p>`);
}

/* ----------------------------- footer ------------------------------------ */

function renderFooter(input: BuildCommitteeMemoInput, auth: AuthoritativeNumbers): string {
  const basisLabel =
    auth.concludedValueSource === 'operator-supplied' ? 'operator-supplied'
    : auth.concludedValueSource ?? 'unspecified';
  return `
    <footer class="memo-footer">
      <div>Narrative engine v${esc(input.narrative.engineVersion)}
        &nbsp;·&nbsp; Memo format v${esc(COMMITTEE_MEMO_VERSION)}
        &nbsp;·&nbsp; Valuation basis: ${esc(basisLabel)}
        &nbsp;·&nbsp; ${esc(input.memoDate)}</div>
      ${renderRenderSourceBanner(input.renderSource)}
      ${input.narrativeVersionNote ? `<div class="memo-render-source memo-render-source-recompute">${esc(input.narrativeVersionNote)}</div>` : ''}
      <div class="memo-footer-fine">
        Figures sourced from the structured AuthoritativeNumbers projection + composed
        mitigation package. Leverage is read against the stressed value. No internal
        identifiers, rule codes, or handbook citations appear in this memo.
      </div>
    </footer>`;
}

function renderRenderSourceBanner(src: MemoRenderSource | undefined): string {
  if (src === undefined) return '';
  if (src.kind === 'snapshot') {
    return `
      <div class="memo-render-source memo-render-source-snapshot">
        Render source: snapshot (captured ${esc(src.capturedAt)}, snapshot producer v${esc(src.snapshotProducerVersion)}, doctrine v${esc(src.pinnedDoctrineVersion)})
      </div>`;
  }
  const pinDrift = src.pinnedDoctrineVersion !== src.headDoctrineVersion;
  return `
    <div class="memo-render-source memo-render-source-recompute">
      Render source: HEAD recompute — pinned at doctrine v${esc(src.pinnedDoctrineVersion)}, rendered using HEAD doctrine v${esc(src.headDoctrineVersion)}${pinDrift ? ' — NOT pin-faithful' : ''}
    </div>`;
}

/* --------------------------- inline CSS ---------------------------------- */

const STYLE = `
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fafaf9; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 11pt; line-height: 1.5; color: #1a1a1a;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .memo-document { max-width: 7.0in; margin: 0 auto; padding: 0.4in 0.5in; background: #ffffff; }

  .memo-header { border-bottom: 2px solid #1a1a1a; padding-bottom: 14pt; margin-bottom: 18pt; page-break-after: avoid; }
  .memo-header-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 12pt; }
  .memo-header-left { display: flex; flex-direction: column; }
  .memo-deal-name { font-family: Georgia, 'Times New Roman', serif; font-size: 22pt; font-weight: 700; line-height: 1.15; letter-spacing: -0.01em; }
  .memo-subtitle { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.16em; color: #5a5a5a; margin-top: 4pt; }
  .memo-header-right { text-align: right; }
  .memo-date { font-size: 10pt; color: #5a5a5a; }
  .memo-rating-chip { margin-top: 4pt; display: inline-block; padding: 4pt 9pt; background: #1a1a1a; color: #fafaf9; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; letter-spacing: 0.04em; border-radius: 1pt; }
  .memo-rating-chip strong { font-weight: 600; }
  .memo-attribution { font-size: 9pt; color: #6a6a6a; margin-top: 10pt; font-style: italic; }

  .memo-section { margin-bottom: 18pt; page-break-inside: avoid; }
  .memo-section-title { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.18em; color: #2a2a2a; margin: 0 0 8pt 0; padding-bottom: 4pt; border-bottom: 1px solid #c0bdb8; font-weight: 600; }
  .memo-section-subhead { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.12em; color: #2a2a2a; margin: 12pt 0 6pt 0; font-weight: 600; }
  .memo-prose { margin: 0 0 6pt 0; text-align: justify; hyphens: auto; }
  .memo-prose-with-table { margin-top: 10pt; }
  .memo-identity { margin: 0 0 8pt 0; font-style: italic; color: #4a4a4a; }
  .memo-analysis-list { margin: 4pt 0; padding-left: 16pt; }
  .memo-analysis-list li { margin-bottom: 4pt; }

  .memo-honest-blank { padding: 10pt 12pt; background: #f5f3ef; border-left: 3px solid #8a6500; }
  .memo-honest-blank p { margin: 0; font-style: italic; color: #2a2a2a; }
  .memo-blank-list { margin: 6pt 0 0 0; padding-left: 18pt; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; font-style: normal; }
  .memo-blank-list li { margin-bottom: 2pt; }

  .memo-table { width: 100%; border-collapse: collapse; margin-top: 4pt; margin-bottom: 6pt; page-break-inside: avoid; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; }
  .memo-table thead th { text-align: left; border-bottom: 1.5px solid #1a1a1a; padding: 5pt 6pt; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.10em; color: #2a2a2a; font-weight: 600; }
  .memo-table .memo-th-num { text-align: right; }
  .memo-table tbody tr { border-bottom: 0.5px solid #e5e2dd; }
  .memo-table tbody tr:last-child { border-bottom: 1px solid #1a1a1a; }
  .memo-table tbody td { padding: 4.5pt 6pt; vertical-align: top; }
  .memo-td-label { font-weight: 500; }
  .memo-td-note { color: #6a6a6a; font-size: 9.5pt; font-style: italic; }
  .memo-td-num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
  .memo-td-tier { text-transform: capitalize; color: #2a2a2a; }

  .memo-disclosure { margin: 8pt 0 0 0; padding: 7pt 10pt; background: #f5f3ef; border-left: 2.5px solid #6a6a6a; font-size: 9.5pt; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-style: italic; color: #2a2a2a; }
  .memo-disclosure strong { font-style: normal; font-weight: 600; }
  .memo-dq-subhead { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; margin: 8pt 0 2pt 0; }

  .memo-restructure-section { margin-top: 22pt; margin-bottom: 22pt; page-break-inside: avoid; }
  .memo-callout { border: 1px solid #1a1a1a; background: #f5f3ef; padding: 14pt 16pt 12pt 16pt; page-break-inside: avoid; }
  .memo-callout-headline { text-align: center; padding: 6pt 0 12pt 0; border-bottom: 0.5px solid #c0bdb8; margin-bottom: 12pt; }
  .memo-callout-headline-label { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.20em; color: #5a5a5a; margin-bottom: 4pt; }
  .memo-callout-headline-figure { font-family: Georgia, 'Times New Roman', serif; font-size: 26pt; font-weight: 700; color: #1a1a1a; letter-spacing: -0.01em; line-height: 1.1; }
  .memo-callout-headline-detail { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #2a2a2a; margin-top: 6pt; font-variant-numeric: tabular-nums; }
  .memo-callout-section { margin-top: 10pt; }
  .memo-callout-subhead { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.16em; color: #2a2a2a; margin: 0 0 6pt 0; font-weight: 600; }
  .memo-callout-section p { margin: 0; font-size: 10.5pt; line-height: 1.55; }
  .memo-recon-list, .memo-condition-list { margin: 0; padding-left: 16pt; font-size: 10.5pt; }
  .memo-recon-list li { margin-bottom: 4pt; }
  .memo-condition { margin-bottom: 9pt; padding-bottom: 5pt; border-bottom: 0.5px dotted #c0bdb8; }
  .memo-condition:last-child { border-bottom: none; }
  .memo-condition-head { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; }
  .memo-condition-name { font-weight: 600; color: #1a1a1a; }
  .memo-condition-funding { display: inline-block; margin-left: 7pt; padding: 1pt 6pt; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.10em; background: #e8e5df; color: #2a2a2a; border-radius: 1pt; font-weight: 600; }
  .memo-condition-sizing { color: #2a2a2a; font-style: italic; }
  .memo-condition-title { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; margin-top: 3pt; color: #2a2a2a; }
  .memo-condition-addresses { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; color: #5a5a5a; margin-top: 2pt; font-style: italic; }
  .memo-condition-terms { margin: 5pt 0 0 0; padding-left: 16pt; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; color: #2a2a2a; }
  .memo-condition-terms li { margin-bottom: 2pt; line-height: 1.4; }
  .memo-condition-magnitudes { margin-top: 4pt; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; color: #2a2a2a; font-variant-numeric: tabular-nums; }

  .memo-table-subtotal td { font-weight: 600; border-top: 0.5px solid #1a1a1a; }
  .memo-table-divider td { padding: 0 !important; border: none !important; }
  .memo-td-divider { height: 6pt; }
  .memo-burden-aggregate { margin-top: 12pt; padding: 10pt 12pt; background: #f5f3ef; border-left: 3px solid #1a1a1a; }
  .memo-burden-aggregate-row { display: flex; justify-content: space-between; align-items: baseline; font-family: Georgia, 'Times New Roman', serif; }
  .memo-burden-aggregate-label { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.14em; color: #2a2a2a; font-weight: 600; }
  .memo-burden-aggregate-value { font-family: Georgia, 'Times New Roman', serif; font-size: 14pt; font-weight: 700; color: #1a1a1a; font-variant-numeric: tabular-nums; }
  .memo-burden-aggregate-note { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; color: #5a5a5a; margin-top: 4pt; font-style: italic; }
  .memo-burden-flag { margin-top: 10pt; padding: 10pt 12pt; background: #fef9f0; border-left: 3px solid #b8860b; }
  .memo-burden-flag-label { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.14em; color: #8a6500; font-weight: 600; margin-bottom: 4pt; }
  .memo-burden-flag p { margin: 0; font-size: 10.5pt; color: #1a1a1a; line-height: 1.55; }
  .memo-burden-clear { margin: 8pt 0 0 0; padding: 6pt 10pt; background: #f5f7f2; border-left: 2px solid #4a5d3a; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9.5pt; color: #2a2a2a; font-style: italic; }

  .memo-final-rec { display: flex; align-items: baseline; gap: 12pt; padding: 10pt 12pt; background: #1a1a1a; color: #fafaf9; margin-bottom: 8pt; }
  .memo-final-rec-label { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.16em; }
  .memo-final-rec-value { font-family: Georgia, 'Times New Roman', serif; font-size: 16pt; font-weight: 700; }

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
  funded: FundedExitProjection,
): string {
  // Section order is sourced from MEMO_SECTION_ORDER (the hashed constant); each
  // section is dispatched through SECTION_RENDERERS so the constant DRIVES render
  // order — the two cannot desync.
  const SECTION_RENDERERS: Readonly<Record<MemoSectionId, () => string>> = {
    header:                    () => renderHeader(input, auth),
    investment_overview:       () => renderInvestmentOverview(input, auth),
    investment_merits:         () => renderInvestmentMerits(auth, findings),
    key_credit_risks:          () => renderKeyCreditRisks(input.narrative, findings),
    sponsor_assessment:        () => renderSponsorAssessment(input),
    tenant_analysis:           () => renderTenantAnalysis(findings),
    market_position:           () => renderMarketPosition(),
    exit_refinance:            () => renderExitRefinance(auth),
    appraisal_value_challenge: () => renderAppraisalValueChallenge(auth, input.appraisalDisclosure),
    underwriting_validation:   () => renderUnderwritingValidation(input),
    data_quality_review:       () => renderDataQualityReview(input),
    credit_structure:          () => renderCreditStructure(input, auth, funded),
    committee_view:            () => renderCommitteeView(input.narrative),
    final_recommendation:      () => renderFinalRecommendation(input, auth),
    footer:                    () => renderFooter(input, auth),
  };
  const sections = MEMO_SECTION_ORDER.map(id => SECTION_RENDERERS[id]()).join('\n  ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(input.dealName)} — Credit Committee Memorandum</title>
<style>${STYLE}</style>
</head>
<body>
<article class="memo-document">
  ${sections}
</article>
</body>
</html>`;
}

/**
 * Frozen prompt-text constants for the narrative engine.
 *
 * Phase 1 (NARRATIVE_ENGINE_VERSION '1.0') shipped the executive_summary
 * survivor. Phase 2 (NARRATIVE_ENGINE_VERSION '1.1') added the
 * red_flag_assessment slot. Phase 3 (NARRATIVE_ENGINE_VERSION '1.2')
 * added the mitigation_suggestions slot. Phase 4 (NARRATIVE_ENGINE_VERSION
 * '1.3') closes the slot set with committee_recommendation.
 *
 * The narrative-engine boot check hashes these strings + the version
 * constant; any edit to a constant without a coordinated
 * NARRATIVE_ENGINE_VERSION bump + manifest append fails fast on api
 * startup.
 *
 * The TEMPLATE strings contain `{{flags}}` placeholders that the producer
 * substitutes at runtime. The substitution is intentionally textual (not
 * f-string interpolation in the source) so the hashed constants stay stable
 * across runs — the template SHAPE is what we lock, not the per-deal flag
 * payload.
 */

export const NARRATIVE_SYSTEM_PROMPT = `You are a senior commercial real estate credit analyst writing for an institutional credit committee. Your prose is concise, factual, and avoids hedging language. You cite specific metric values when the input provides them, and you refer to every risk by the plain-English credit question it raises. You NEVER print internal identifiers of any kind: no dimension names or numbers, no rule codes, no "P-" handbook citations, no tier or lever identifiers. If a fact is presented as an assumption, you present it as an assumption, never as a sourced figure. You never invent data: if a metric is missing from the input, you omit it rather than estimating.`;

export const EXECUTIVE_SUMMARY_PROMPT_TEMPLATE = `Compose a single executive-summary paragraph (4-6 sentences) for the credit committee. The summary frames the deal's headline risks based on the handbook flags below.

Requirements:
- Lead with the most material risk. The flags are pre-sorted by severity (critical → high → medium → advisory).
- Refer to each risk by the plain-English credit question it raises. Do NOT print any identifier, code, or "P-" citation.
- Quote the metric value verbatim when one is provided.
- Do NOT introduce risks not present in the flag list.
- Do NOT recommend specific mitigations — that is a separate section.
- If the flag list is empty, write a one-sentence summary noting the absence of fired flags.

Handbook flags ({{flag_count}} total):
{{flags}}

Output the paragraph and nothing else (no headers, no bullet lists, no follow-up commentary).`;

/**
 * Render a flag list into the text format the executive-summary template
 * expects. One line per flag: `- [severity] principleId — message (metric: value)`.
 * Pure string assembly, no LLM call. Stable formatting → stable hash for
 * a given input flag set.
 */
import type { FormattedFlag } from './format-flags.js';
import type { MitigationProposal } from '@cre/contracts';
import {
  dimensionDisplayName,
  principleCreditQuestion,
  leverDisplayName,
} from './committee-voice.js';

export function renderFlagList(flags: readonly FormattedFlag[]): string {
  if (flags.length === 0) return '(no flags fired for this injection point)';
  // Committee-voice: name the risk by the plain-English credit question, never
  // the principle id. The bare metric value is dropped from the prompt too —
  // quantitative figures are the numbers sections' job, not the prose slots'.
  return flags
    .map((f) => `- (${f.severity}) On ${principleCreditQuestion(f.principleId)}: ${f.message}`)
    .join('\n');
}

/**
 * Substitute `{{flags}}` and `{{flag_count}}` placeholders in the executive-
 * summary template. Keeping substitution outside the hashed template
 * constant means the boot-check hash is stable across deals.
 */
export function buildExecutiveSummaryPrompt(flags: readonly FormattedFlag[]): string {
  return EXECUTIVE_SUMMARY_PROMPT_TEMPLATE
    .replace('{{flag_count}}', flags.length.toString())
    .replace('{{flags}}', renderFlagList(flags));
}

/**
 * Frozen prompt template for the red_flag_assessment injection-point slot
 * (Phase 2, NARRATIVE_ENGINE_VERSION '1.1'). Different intent than
 * executive_summary: where exec-summary frames "what is this deal" with the
 * top risks, red-flag-assessment enumerates EVERY material risk in a
 * structured, committee-facing way. Bulleted output rather than paragraph
 * prose; each flag gets its own line; deeper, less compressed than the
 * exec-summary.
 *
 * Sibling slots (Phase 3+) share NARRATIVE_SYSTEM_PROMPT but get their own
 * template constants here. Each template + the system prompt is part of the
 * boot-check hash snapshot.
 */
export const RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE = `Compose a red-flag assessment for the credit committee. Enumerate every flagged risk as a separate item; do not aggregate or summarize.

Requirements:
- Output a bulleted list, one bullet per flag, in the order provided (severity-sorted: critical → high → medium → advisory).
- Each bullet names the risk by the plain-English credit question it raises, followed by a one-to-two-sentence assessment.
  Format: \`- <plain-English credit question> — <assessment>\`. Do NOT print any identifier, code, or "P-" citation.
- Quote the metric value verbatim when one is provided. Cite it explicitly (e.g., "metric value 8500000" or "Class B").
- State the underlying risk concretely — what could go wrong, not just what fired.
- Do NOT recommend mitigations — that is a separate section.
- Do NOT aggregate flags into themes or roll them up; one flag, one bullet.
- If the flag list is empty, output the single line: \`No red flags fired for this deal.\`

Handbook flags ({{flag_count}} total, severity-sorted):
{{flags}}

Output the bulleted list and nothing else (no preamble, no headers, no follow-up commentary).`;

/**
 * Substitute `{{flags}}` and `{{flag_count}}` placeholders in the
 * red-flag-assessment template. Same substitution pattern as
 * `buildExecutiveSummaryPrompt`; substitution outside the hashed template
 * constant keeps the boot-check hash stable across deals.
 */
export function buildRedFlagAssessmentPrompt(flags: readonly FormattedFlag[]): string {
  return RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE
    .replace('{{flag_count}}', flags.length.toString())
    .replace('{{flags}}', renderFlagList(flags));
}

/**
 * Frozen prompt template for the mitigation_suggestions injection-point
 * slot (Phase 3, NARRATIVE_ENGINE_VERSION '1.2'). v1.5 (2026-06-08)
 * retires this template — the slot is now rendered DETERMINISTICALLY
 * from MitigationProposalSet (no LLM call). See
 * `MITIGATION_SUGGESTIONS_HEADER_V1_5` + `MITIGATION_SUGGESTIONS_EMPTY_V1_5`
 * for the new constants the hash snapshot tracks.
 *
 * The template is kept in source (and in the hashed snapshot) so the
 * boot-check still verifies it hasn't drifted from its v1.4 wording —
 * stable replay of older NarrativeEvaluation records under a re-run of
 * the v1.4 producer remains possible.
 */
export const MITIGATION_SUGGESTIONS_PROMPT_TEMPLATE = `Compose a mitigation-suggestions list for the credit committee. For each fired flag, recommend a concrete structural mitigation the lender could require.

Requirements:
- Output a bulleted list, one bullet per flag, in the order provided (severity-sorted: critical → high → medium → advisory).
- Each bullet names the condition in plain English, followed by a one-to-two-sentence recommended action.
  Format: \`- <plain-English condition name> — <recommended action>\`. Do NOT print any identifier, code, or "P-" citation.
- The action must be CONCRETE and STRUCTURAL. Examples by category:
  * Escrow / reserve (e.g., "Require $X upfront reserve for capex," "Escrow Y months of debt service")
  * Covenant (e.g., "Add minimum DSCR covenant at 1.20x," "Cash sweep on excess cash flow above debt yield Z%")
  * Structure (e.g., "Lower max LTV to 65%," "Require recourse carve-out for cash-out portion")
  * Due diligence (e.g., "Obtain updated PCA before close," "Require Phase II environmental")
- Reference the metric value when proposing thresholds (e.g., "given cash-out amount of 8500000, require...").
- Do NOT enumerate risks themselves — assume the reader has the red-flag-assessment section. Stay focused on actions.
- Do NOT recommend rejection or "decline the deal" — mitigations are structural conditions for proceeding.
- If the flag list is empty, output the single line: \`No mitigations recommended for this deal.\`

Handbook flags ({{flag_count}} total, severity-sorted):
{{flags}}

Output the bulleted list and nothing else (no preamble, no headers, no follow-up commentary).`;

/**
 * Substitute `{{flags}}` and `{{flag_count}}` placeholders in the
 * mitigation-suggestions template. v1.5 retires LLM invocation of this
 * slot in favor of deterministic rendering; helper kept for replay
 * compatibility with v1.4 records.
 */
export function buildMitigationSuggestionsPrompt(flags: readonly FormattedFlag[]): string {
  return MITIGATION_SUGGESTIONS_PROMPT_TEMPLATE
    .replace('{{flag_count}}', flags.length.toString())
    .replace('{{flags}}', renderFlagList(flags));
}

/* --------- v1.5 — deterministic mitigation-suggestions renderer ----------- */

/**
 * Header line printed at the top of the mitigation_suggestions slot when at
 * least one MitigationProposal exists. Frozen text, hashed by the boot check.
 */
export const MITIGATION_SUGGESTIONS_HEADER_V1_5 =
  'Deterministic structural mitigants sized by the mitigation engine. Figures and target metrics are computed; the slot is not LLM-authored.';

/**
 * Single-line output when the MitigationProposalSet is empty (no breach OR
 * inputs insufficient to size a lever). Frozen text, hashed by the boot
 * check. The committee-recommendation template forbids the LLM from
 * inventing sized structuring when this slot reads empty.
 */
export const MITIGATION_SUGGESTIONS_EMPTY_V1_5 =
  'No structural mitigants triggered for this deal — the engine produced an empty MitigationProposalSet (no breached coverage targets, or inputs insufficient to size a lever). Qualitative conditions may still be appropriate; see the committee recommendation.';

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0)     + 'K';
  return '$' + n.toFixed(0);
}
function fmtRate(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}
function fmtDscr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(2) + 'x';
}

/**
 * Render the deterministic mitigation_suggestions slot for v1.5. Pure
 * function over the MitigationProposalSet — every number lifted verbatim
 * from `MitigationProposal` fields the mitigation engine produced; no
 * formula, no derivation, no LLM. Output is a stable string the boot-
 * check hash snapshot does NOT cover (per-deal data, not engine state).
 */
export function renderMitigationsListV1_5(proposals: readonly MitigationProposal[]): string {
  if (proposals.length === 0) return MITIGATION_SUGGESTIONS_EMPTY_V1_5;
  const blocks: string[] = [MITIGATION_SUGGESTIONS_HEADER_V1_5, ''];
  for (const p of proposals) {
    const sizing: string[] = [];
    if (p.requiredEquity !== undefined) sizing.push(`requiredEquity ${fmtUsd(p.requiredEquity)}`);
    if (p.requiredReserve !== undefined) sizing.push(`requiredReserve ${fmtUsd(p.requiredReserve)}`);
    if (p.targetMetric) sizing.push(`binding metric: ${p.targetMetric}`);
    const lines: string[] = [];
    lines.push(`- [${p.id}] severity=${p.severity}, riskReduction=${p.riskReduction} · ${p.title}`);
    if (sizing.length > 0) lines.push(`  ${sizing.join(' · ')}`);
    lines.push(`  ${p.description}`);
    for (const s of p.structuralChanges) lines.push(`  • ${s}`);
    if (p.recalcBefore && p.recalcAfter) {
      lines.push(
        `  Before: LTV ${fmtRate(p.recalcBefore.ltv)}, DSCR ${fmtDscr(p.recalcBefore.dscr)}, DY ${fmtRate(p.recalcBefore.debtYield)}`,
      );
      lines.push(
        `  After:  LTV ${fmtRate(p.recalcAfter.ltv)}, DSCR ${fmtDscr(p.recalcAfter.dscr)}, DY ${fmtRate(p.recalcAfter.debtYield)}`,
      );
    }
    if (p.coverageStatement) lines.push(`  ${p.coverageStatement}.`);
    if (p.principleIds.length > 0) lines.push(`  Cited principles: ${p.principleIds.join(', ')}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

/**
 * Frozen prompt template for the committee_recommendation injection-
 * point slot (Phase 4, NARRATIVE_ENGINE_VERSION '1.3'). Intent
 * differs from the prior three slots: where executive_summary frames
 * the deal, red_flag_assessment enumerates risks, and
 * mitigation_suggestions proposes structural actions,
 * committee_recommendation synthesizes the deal-level RECOMMENDATION
 * (approve / conditional approve with conditions inline / reject)
 * the committee acts on. Structural form is a 1-2 paragraph
 * synthesis — closer to executive_summary's prose than the bulleted
 * lists of the middle two slots. This is the slot the committee
 * reads last.
 *
 * The "committee recommendation" phrase appears in the directive
 * below; the integration test's makeStub uses this phrase as the
 * dispatch marker (most-specific marker first in the if-chain).
 */
export const COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE = `Compose a committee recommendation for this deal. Synthesize the flagged risks into a deal-level conclusion the credit committee can act on.

Requirements:
- Output a 1-2 paragraph synthesis (NOT a bulleted list — that's the other slots' job).
- Lead with the headline recommendation: "Recommend approval," "Recommend conditional approval subject to [X, Y, Z]," or "Recommend declination."
- If recommending CONDITIONAL APPROVAL: cite the deterministic structural mitigants from the section below VERBATIM by their sized figures (loan amount, sponsor equity, reserve dollars, target metric values). You MUST NOT invent additional sized covenants, reserves, sweeps, or structural conditions beyond what the engine produced. Qualitative conditions ("subject to confirmation of executed leases," "subject to receipt of PCA") are acceptable and need not be sized.
- If the deterministic mitigants section is EMPTY, you MUST NOT propose any sized structural condition (no dollar reserves, no covenant thresholds, no LTV/DSCR/DY targets). Recommend approval, conditional approval on qualitative grounds only, or declination — your call based on the handbook flags.
- If recommending DECLINATION: state the primary disqualifying risk concisely with the principle id.
- If recommending APPROVAL (rare given fired flags): note that the residual risks are acceptable at standard terms.
- Cite metric values verbatim when relevant (e.g., "DSCR of 1.42x," "cash-out amount of 8500000").
- Do NOT re-enumerate every flag — assume the reader has the red-flag-assessment and mitigation-suggestions sections. Stay at the synthesis level.
- If the flag list is empty, output: \`No flagged risks identified; recommend approval per standard terms.\`

Handbook flags ({{flag_count}} total, severity-sorted):
{{flags}}

Deterministic structural mitigants (engine-sized — DO NOT MODIFY OR INVENT NEW SIZED CONDITIONS):
{{mitigations}}

Output the recommendation paragraph(s) and nothing else (no headers, no bullet lists, no follow-up commentary).`;

/**
 * Substitute `{{flags}}`, `{{flag_count}}`, and `{{mitigations}}`
 * placeholders in the committee-recommendation template. v1.5
 * (2026-06-08) adds the `{{mitigations}}` placeholder — the LLM is
 * given the deterministic mitigant text + an explicit constraint
 * against inventing new sized structuring. `mitigationsText` is the
 * output of `renderMitigationsListV1_5` (same string the
 * mitigation_suggestions slot emits) — single source of truth for
 * every sized figure the narrative refers to.
 */
export function buildCommitteeRecommendationPrompt(
  flags: readonly FormattedFlag[],
  mitigationsText: string,
): string {
  return COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE
    .replace('{{flag_count}}', flags.length.toString())
    .replace('{{flags}}', renderFlagList(flags))
    .replace('{{mitigations}}', mitigationsText);
}

/* ==========================================================================
 * v1.6 — composed-package wiring + handbook demotion (Phase 3 committee narrative)
 * --------------------------------------------------------------------------
 *
 * What changed at v1.6:
 *   - mitigation_suggestions renders the COMPOSED package (composeMitigations
 *     output) — the final lever list AFTER de-levering resolution — plus the
 *     reconciliation notes ("standalone amortization $10.03M → $0, superseded
 *     by the $14.06M proceeds cut"). v1.5 rendered raw produceMitigations
 *     output; v1.6 renders the composed package. The renderer fence remains:
 *     every dollar in the output is byte-identical to a field on a composed
 *     proposal (or a clean-doctrine derivedOutput) the engine produced.
 *
 *   - All four slot prompts now embed an "AUTHORITATIVE NUMBERS" block —
 *     a deterministic structured-fact projection from the clean-doctrine
 *     dealResult + composed package. The LLM is instructed to use the
 *     numbers verbatim and NEVER to recompute or restate them.
 *
 *   - red_flag_assessment PRIMARY source is clean-doctrine dim findings
 *     (dim 1 / 2 / 3 / 4 / 7 etc.). Handbook flags are demoted to a
 *     clearly-labeled SUPPORTING OBSERVATIONS sub-section, QUALITATIVE
 *     ONLY — handbook metric strings (LTV / value / leverage figures) are
 *     STRIPPED before injection. One set of leverage/value numbers in the
 *     memo: the clean doctrine's.
 *
 *   - executive_summary leads with the clean-doctrine rating + headline
 *     restructuring ask + a valuation-basis line (from dim-7's
 *     concludedValueSource). When the value is operator-supplied, the memo
 *     states "valuation basis: operator-supplied."
 *
 *   - committee_recommendation grounds in the clean-doctrine rating +
 *     composed conditions ("approvable IF implemented"). It receives the
 *     same authoritative-numbers block and the composed mitigants text.
 *
 * The v1.5 templates above are preserved in source UNCHANGED so historical
 * NarrativeEvaluation records continue to replay determinically under the
 * v1.5 producer path. The v1.6 producer uses the *_V1_6 constants below.
 * ========================================================================== */

/**
 * Authoritative-numbers block — frozen header text that introduces the
 * structured-fact projection inside each v1.6 slot prompt. The fact body
 * is per-deal and substituted at runtime; the HEADER + the INSTRUCTION
 * are frozen and hashed.
 */
export const AUTHORITATIVE_NUMBERS_HEADER_V1_6 =
  'AUTHORITATIVE NUMBERS (engine-derived; use verbatim — DO NOT recompute, restate, or modify any figure):';

export const AUTHORITATIVE_NUMBERS_INSTRUCTION_V1_6 =
  'Every figure in the AUTHORITATIVE NUMBERS block above is the single source of truth. If a number is not in the block, do not introduce one. Cite numbers verbatim with their units. The clean doctrine has produced these figures; no other quantitative source supersedes it.';

/**
 * Handbook-demotion preamble for the red_flag_assessment v1.6 slot.
 * Frozen text introducing the supporting-observations sub-section so the
 * memo clearly labels the handbook as SUPPORTING, qualitative.
 */
export const HANDBOOK_SUPPORTING_PREAMBLE_V1_6 =
  'Supporting observations (handbook — QUALITATIVE ONLY; no quantitative figures from this source; the clean doctrine\'s numbers above are authoritative):';

export const HANDBOOK_SUPPORTING_EMPTY_V1_6 =
  'No supporting handbook observations for this slot.';

/**
 * Composed-mitigations slot constants for v1.6 (replaces v1.5 raw-proposal
 * rendering). Header + empty-case line are frozen.
 */
export const MITIGATION_SUGGESTIONS_HEADER_V1_6 =
  'Composed structural mitigants (engine-sized AFTER composition — single-pass de-levering resolution applied; reconciliation below). Figures are deterministic; the slot is not LLM-authored.';

export const MITIGATION_SUGGESTIONS_EMPTY_V1_6 =
  'No structural mitigants triggered for this deal — the composition engine produced an empty package (no breached coverage targets, or inputs insufficient to size a lever). Qualitative conditions may still be appropriate; see the committee recommendation.';

export const MITIGATION_SUGGESTIONS_RECONCILIATION_HEADER_V1_6 =
  'Composition reconciliation (why levers dropped or shrank — verbatim engine output):';

/** ----- v1.6 slot templates (replace v1.5 at the producer call sites) ----- */

export const EXECUTIVE_SUMMARY_PROMPT_TEMPLATE_V1_6 = `Compose a single executive-summary paragraph (4-6 sentences) for the credit committee. Lead with the clean-doctrine rating + headline restructuring ask, and state the valuation basis explicitly.

Requirements:
- Lead with the rating recommendation and the headline restructuring ask (proceeds reduction to L', if any) from the AUTHORITATIVE NUMBERS block below — use the figures verbatim.
- State the valuation basis line VERBATIM from the block (e.g., "valuation basis: operator-supplied"). When the basis is operator-supplied, the memo MUST disclose it.
- Do NOT introduce quantitative figures not in the AUTHORITATIVE NUMBERS block.
- Do NOT recommend specific structural conditions — those are the mitigation-suggestions slot's job.
- If supporting handbook observations exist, you may reference one or two qualitative themes (e.g., "stress-scenario coverage concern," "missing trailing actuals") but do NOT quote handbook quantitative figures. The clean doctrine's numbers above are authoritative.

{{auth_numbers_block}}

{{auth_numbers_instruction}}

Supporting handbook observations (qualitative-only, no figures):
{{handbook_qualitative}}

Output the paragraph and nothing else (no headers, no bullet lists, no follow-up commentary).`;

export const RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE_V1_6 = `Compose a red-flag assessment for the credit committee. The PRIMARY source is the clean-doctrine dimension findings below. Handbook observations appear as a clearly-labeled SUPPORTING sub-section, qualitative-only.

Requirements:
- Output a bulleted list, primary section first, then a clearly-labeled "Supporting observations" sub-section.
- For each primary risk finding: one bullet, in the order provided. Format: \`- <plain-English factor name> — <assessment>\`. Do NOT print any dimension name, number, or tier label; the finding text already names the factor in plain English. Quote any figure from the AUTHORITATIVE NUMBERS block VERBATIM; do not introduce new figures.
- For the supporting handbook observations: one bullet each, QUALITATIVE ONLY. Do NOT cite handbook metric values, LTV figures, value figures, or leverage figures. Those quantitative claims belong to the AUTHORITATIVE NUMBERS block above. Format: \`- <plain-English credit question> — <qualitative assessment>\`. Do NOT print any "P-" identifier or code.
- Do NOT recommend mitigations — that's a separate section.
- Do NOT aggregate or roll up.
- If clean-doctrine findings are empty AND supporting observations are empty, output: \`No red flags identified for this deal.\`

{{auth_numbers_block}}

Primary risk findings (clean-doctrine dimensions; PRIMARY source):
{{clean_doctrine_findings}}

${HANDBOOK_SUPPORTING_PREAMBLE_V1_6}
{{handbook_qualitative}}

{{auth_numbers_instruction}}

Output the bulleted list and nothing else (no preamble, no headers, no follow-up commentary).`;

export const COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE_V1_6 = `Compose a committee recommendation for this deal. Ground in the clean-doctrine rating and the composed structural conditions; phrase as "approvable IF implemented."

Requirements:
- Output EXACTLY ONE paragraph. Do NOT add a summary, rationale, or restatement paragraph after the conditions — the conditions ARE the recommendation. The red-flag-assessment + mitigation-suggestions sections supply the supporting context already.
- Lead with the headline recommendation aligned with the clean-doctrine rating in the AUTHORITATIVE NUMBERS block: "Recommend approval," "Recommend conditional approval subject to [the composed conditions, cited verbatim]," or "Recommend declination."
- Cite the composed conditions VERBATIM from the deterministic mitigants section below. You MUST NOT invent additional sized covenants, reserves, sweeps, or structural conditions beyond what the composition engine produced. Qualitative conditions ("subject to executed-lease confirmation," "subject to receipt of PCA") are acceptable and need not be sized.
- If the composed mitigants section is EMPTY, you MUST NOT propose any sized structural condition.
- State the valuation basis if it is operator-supplied (verbatim from the AUTHORITATIVE NUMBERS block).
- Reference the rating recommendation from the AUTHORITATIVE NUMBERS block verbatim.
- Do NOT re-enumerate every flag — the red-flag-assessment slot covers that.
- Do NOT make qualitative claims about data confidence, refinancing viability, or deal "fundamentals" outside the conditions — those are interpretive characterizations the engine has not authorized.

{{auth_numbers_block}}

Composed structural mitigants (engine-sized AFTER composition — DO NOT MODIFY OR INVENT NEW SIZED CONDITIONS):
{{mitigations}}

{{auth_numbers_instruction}}

Output the recommendation paragraph(s) and nothing else (no headers, no bullet lists, no follow-up commentary).`;

/* ----- v1.6 deterministic projections (pure functions) ------------------- */

/**
 * Structured authoritative-fact projection. The PRODUCER assembles this
 * record from the clean-doctrine dealResult + the composed package; the
 * fields below are the only quantitative source any v1.6 slot prompt
 * sees. Every field is either a number / short string / explicit null —
 * the rendering helper produces a stable formatted block.
 *
 * Pure data; no LLM call. Lives here (alongside the templates) so the
 * boot check covers the rendering format if needed.
 */
export interface AuthoritativeNumbers {
  readonly ratingRecommendation: string | null;     // clean-doctrine rating output
  readonly ratingBand: string | null;
  readonly assetType: string | null;
  readonly subType: string | null;

  /* Capital structure */
  readonly originalLoanAmount: number | null;       // baseline loan
  readonly finalLoanAmount: number | null;          // composed L'
  readonly proceedsReduction: number | null;        // baseline − final

  /* Spine (dim 7) */
  readonly stressedValue: number | null;
  readonly stressedLtv: number | null;
  readonly stressedLtvAtFinalLoan: number | null;
  readonly ltvTrigger: number | null;                // 0.70 desk knob (v1.8 — pre-projected so renderer reads, doesn't read DEFAULT_MITIGATION_DESK)
  readonly concludedValue: number | null;
  readonly concludedValueSource:
    | 'extracted-appraisal'
    | 'extracted-asr'
    | 'operator-supplied'
    | 'unspecified-source'
    | null;
  readonly valuationConfidenceNote: string | null;  // present only when operator-supplied

  /* Coverage (dim 4) */
  readonly exitDscrBaseline: number | null;
  readonly exitDscrAtFinalLoan: number | null;
  readonly exitDscrTrigger: number | null;          // 1.20 by doctrine
  readonly exitDscrCureTarget: number | null;       // desk knob

  /* Amortization composition */
  readonly standaloneAmortPaydown: number | null;   // pre-composition
  readonly composedAmortPaydown: number | null;     // post-composition (null = dropped)
}

function fmtUsdV16(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0)     + 'K';
  return '$' + n.toFixed(0);
}
function fmtPctV16(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}
function fmtDscrV16(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(2) + 'x';
}

/**
 * Render the AUTHORITATIVE NUMBERS block. Deterministic, stable formatting.
 * The HEADER line is the frozen AUTHORITATIVE_NUMBERS_HEADER_V1_6 constant;
 * the body is one labeled line per field. Numbers are formatted but exact
 * (no rounding beyond the standard 2-decimal display).
 */
export function renderAuthoritativeNumbersBlock(a: AuthoritativeNumbers): string {
  const lines: string[] = [AUTHORITATIVE_NUMBERS_HEADER_V1_6];
  lines.push(`  rating recommendation     : ${a.ratingRecommendation ?? '—'}`);
  if (a.ratingBand !== null && a.ratingBand !== undefined) lines.push(`  rating band               : ${a.ratingBand}`);
  lines.push(`  asset class               : ${a.assetType ?? '—'}${a.subType ? ` / ${a.subType}` : ''}`);
  lines.push('');
  lines.push(`  original loan amount      : ${fmtUsdV16(a.originalLoanAmount)}`);
  lines.push(`  final loan amount (L')    : ${fmtUsdV16(a.finalLoanAmount)}`);
  lines.push(`  proceeds reduction        : ${fmtUsdV16(a.proceedsReduction)}`);
  lines.push('');
  lines.push(`  concluded value           : ${fmtUsdV16(a.concludedValue)}`);
  lines.push(`  valuation basis           : ${a.concludedValueSource ?? '—'}`);
  if (a.valuationConfidenceNote !== null && a.valuationConfidenceNote !== undefined) {
    lines.push(`  valuation confidence note : ${a.valuationConfidenceNote}`);
  }
  lines.push(`  dim-7 stressed value      : ${fmtUsdV16(a.stressedValue)}`);
  lines.push(`  dim-7 stressed LTV        : ${fmtPctV16(a.stressedLtv)} (at original loan)`);
  if (a.stressedLtvAtFinalLoan !== null && a.stressedLtvAtFinalLoan !== undefined) {
    lines.push(`  dim-7 stressed LTV at L'  : ${fmtPctV16(a.stressedLtvAtFinalLoan)}`);
  }
  lines.push('');
  lines.push(`  dim-4 exit DSCR (baseline): ${fmtDscrV16(a.exitDscrBaseline)}`);
  if (a.exitDscrAtFinalLoan !== null && a.exitDscrAtFinalLoan !== undefined) {
    lines.push(`  dim-4 exit DSCR at L'     : ${fmtDscrV16(a.exitDscrAtFinalLoan)}`);
  }
  lines.push(`  exit-DSCR trigger         : ${fmtDscrV16(a.exitDscrTrigger)} (doctrine)`);
  if (a.exitDscrCureTarget !== null && a.exitDscrCureTarget !== undefined) {
    lines.push(`  exit-DSCR cure target     : ${fmtDscrV16(a.exitDscrCureTarget)} (desk knob)`);
  }
  lines.push('');
  if (a.standaloneAmortPaydown !== null && a.standaloneAmortPaydown !== undefined) {
    lines.push(`  standalone amort paydown  : ${fmtUsdV16(a.standaloneAmortPaydown)} (pre-composition)`);
  }
  if (a.composedAmortPaydown !== null && a.composedAmortPaydown !== undefined) {
    lines.push(`  composed  amort paydown   : ${fmtUsdV16(a.composedAmortPaydown)} (post-composition)`);
  } else if (a.standaloneAmortPaydown !== null && a.standaloneAmortPaydown !== undefined) {
    lines.push(`  composed  amort paydown   : DROPPED (superseded by proceeds reduction)`);
  }
  return lines.join('\n');
}

/**
 * Clean-doctrine dimension findings — pure formatting from the
 * EvaluateDealResult's per-dim contributions. The producer extracts the
 * applicable + risk-elevated dim findings (tier above 'baseline') and the
 * renderer emits one labeled line per finding. PRIMARY source for the
 * red-flag-assessment slot.
 *
 * Each finding is { dimNumber, tier, headline }. dimNumber maps to the
 * 9-dim doctrine; tier is the dim's tier string; headline is a short
 * sentence the producer composes (deterministic, no LLM).
 */
export interface CleanDoctrineFinding {
  readonly dimNumber: number;          // 1..9 per the canonical doctrine numbering
  readonly dimensionId: string;        // e.g., 'cap-rate-valuation-stress'
  readonly tier: string;               // e.g., 'moderate' / 'high'
  readonly headline: string;           // deterministic one-liner
}

export function renderCleanDoctrineFindings(
  findings: readonly CleanDoctrineFinding[],
): string {
  if (findings.length === 0) return '(no risk-elevated findings)';
  // Committee-voice: the factor is named in plain English (dimensionDisplayName)
  // and the finding is a plain-English risk sentence (f.headline is now produced
  // by committee-voice's dimensionRiskSentence). No dim id, number, or tier enum.
  return findings
    .map((f) => `- ${dimensionDisplayName(f.dimensionId)} — ${f.headline}`)
    .join('\n');
}

/**
 * Qualitative-only projection of handbook flags for v1.6. Strips the
 * `(metric: ...)` clause so handbook quantitative claims do not appear
 * anywhere in the memo prose. One bullet per flag; severity + principleId
 * + message only.
 */
export function renderHandbookSupportingObservations(
  flags: readonly FormattedFlag[],
): string {
  if (flags.length === 0) return HANDBOOK_SUPPORTING_EMPTY_V1_6;
  // Committee-voice: name the handbook observation by the plain-English credit
  // question, never the principle id.
  return flags
    .map((f) => `- (${f.severity}) On ${principleCreditQuestion(f.principleId)}: ${f.message}`)
    .join('\n');
}

/**
 * Composed-mitigations renderer for v1.6. Replaces v1.5 by sourcing from
 * the composition output: composed proposals (post-resolution) + the
 * reconciliation notes (so the lender sees WHY a lever dropped or shrank,
 * not just the final list).
 *
 * Fence: every dollar is byte-identical to a field on a composed
 * MitigationProposal OR a string from ComposeReconciliation.notes. No
 * formula, no derivation, no LLM.
 */
export interface ComposedMitigationView {
  readonly proposals: readonly MitigationProposal[];
  readonly reconciliationNotes: readonly string[];
  readonly covenantMagnitudesAtFinalLoan: readonly {
    readonly lever: string;
    readonly leverId: string;
    readonly resolvedMagnitudes: readonly string[];
  }[];
}

export function renderComposedMitigationsList(view: ComposedMitigationView): string {
  if (view.proposals.length === 0 && view.reconciliationNotes.length === 0) {
    return MITIGATION_SUGGESTIONS_EMPTY_V1_6;
  }
  const blocks: string[] = [MITIGATION_SUGGESTIONS_HEADER_V1_6, ''];
  for (const p of view.proposals) {
    // Committee-voice: name the condition in plain English (leverDisplayName),
    // never the proposal id. Drop the internal severity / riskReduction / target-
    // metric tokens; the sized dollar figures and structural terms carry the
    // substance a committee needs.
    const sizing: string[] = [];
    if (p.requiredEquity !== undefined)  sizing.push(`sponsor equity ${fmtUsdV16(p.requiredEquity)}`);
    if (p.requiredPaydown !== undefined) sizing.push(`principal paydown ${fmtUsdV16(p.requiredPaydown)}`);
    if (p.requiredReserve !== undefined) sizing.push(`funded reserve ${fmtUsdV16(p.requiredReserve)}`);
    const lines: string[] = [];
    lines.push(`- ${leverDisplayName(p.lever)}: ${p.title}`);
    if (sizing.length > 0) lines.push(`  ${sizing.join(' · ')}`);
    lines.push(`  ${p.description}`);
    for (const s of p.structuralChanges) lines.push(`  • ${s}`);
    blocks.push(lines.join('\n'));
  }
  if (view.reconciliationNotes.length > 0) {
    blocks.push('');
    blocks.push(MITIGATION_SUGGESTIONS_RECONCILIATION_HEADER_V1_6);
    for (const n of view.reconciliationNotes) blocks.push(`  • ${n}`);
  }
  if (view.covenantMagnitudesAtFinalLoan.length > 0) {
    blocks.push('');
    blocks.push("Covenant magnitudes resolved against the reduced loan:");
    for (const c of view.covenantMagnitudesAtFinalLoan) {
      blocks.push(`  ${leverDisplayName(c.lever)}:`);
      for (const m of c.resolvedMagnitudes) blocks.push(`    ${m}`);
    }
  }
  return blocks.join('\n');
}

/* ----- v1.6 prompt builders ---------------------------------------------- */

function authBlock(a: AuthoritativeNumbers): string { return renderAuthoritativeNumbersBlock(a); }

export function buildExecutiveSummaryPromptV1_6(
  auth: AuthoritativeNumbers,
  qualitativeHandbook: readonly FormattedFlag[],
): string {
  return EXECUTIVE_SUMMARY_PROMPT_TEMPLATE_V1_6
    .replace('{{auth_numbers_block}}', authBlock(auth))
    .replace('{{auth_numbers_instruction}}', AUTHORITATIVE_NUMBERS_INSTRUCTION_V1_6)
    .replace('{{handbook_qualitative}}', renderHandbookSupportingObservations(qualitativeHandbook));
}

export function buildRedFlagAssessmentPromptV1_6(
  auth: AuthoritativeNumbers,
  cleanFindings: readonly CleanDoctrineFinding[],
  qualitativeHandbook: readonly FormattedFlag[],
): string {
  return RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE_V1_6
    .replace('{{auth_numbers_block}}', authBlock(auth))
    .replace('{{clean_doctrine_findings}}', renderCleanDoctrineFindings(cleanFindings))
    .replace('{{handbook_qualitative}}', renderHandbookSupportingObservations(qualitativeHandbook))
    .replace('{{auth_numbers_instruction}}', AUTHORITATIVE_NUMBERS_INSTRUCTION_V1_6);
}

export function buildCommitteeRecommendationPromptV1_6(
  auth: AuthoritativeNumbers,
  composedMitigantsText: string,
): string {
  return COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE_V1_6
    .replace('{{auth_numbers_block}}', authBlock(auth))
    .replace('{{mitigations}}', composedMitigantsText)
    .replace('{{auth_numbers_instruction}}', AUTHORITATIVE_NUMBERS_INSTRUCTION_V1_6);
}

// ──────────────────────────────────────────────────────────────────────────────
// v1.8 — Open Items / Data Required (deterministic, no LLM).
// ──────────────────────────────────────────────────────────────────────────────
//
// The 5th narrative slot. Surfaces handbookEvaluation.skippedPrinciples filtered
// to reason ∈ {needs_manual_input, missing_field}, grouped by diligence theme.
// All constants below enter the narrative-engine hash snapshot — edits force a
// version bump + manifest append (same discipline as v1.5 / v1.6 constants).

export const OPEN_ITEMS_HEADER_V1_8 =
  '## Open Items / Data Required for Final Underwriting';

export const OPEN_ITEMS_INTRO_V1_8 =
  'The handbook principles below could not be evaluated against the data ' +
  'available in this deal file. Each is grouped by the diligence workstream ' +
  'that owns the request, with the specific input the principle needs in ' +
  'order to conclude. Items marked with the engine label are deterministic ' +
  'data-field gaps; items with a prose ask are LLM-evaluated principles ' +
  'whose detail text already names the required input.';

// Empty-case sentinel — frozen + hashed; emitted when zero data-gated skips.
export const OPEN_ITEMS_EMPTY_V1_8 =
  'No open items: every evaluable principle in the handbook was either ' +
  'fired with a flag or assessed cleanly with available data. Any further ' +
  'diligence is at committee discretion.';

// Theme labels, ordered by how the committee should read them (sponsor side
// first; income/lease; then market; then property ops). Order is frozen +
// hashed — reordering requires a version bump.
export const OPEN_ITEMS_THEME_HEADERS_V1_8: ReadonlyArray<readonly [
  'sponsor_borrower' | 'income_leases' | 'market_comps' | 'property_ops' | 'other',
  string,
]> = [
  ['sponsor_borrower', '### Sponsor & borrower diligence'],
  ['income_leases',    '### Income & lease completeness'],
  ['market_comps',     '### Submarket & comparable data'],
  ['property_ops',     '### Property condition & operations'],
  ['other',            '### Other principles requiring analyst review'],
];

// Per-principle theme assignment. Default 'other' covers any handbook
// principle not enumerated here (forward-compatibility for new principles).
// Edits require a version bump.
export const OPEN_ITEMS_PRINCIPLE_THEME_V1_8: Readonly<Record<string,
  'sponsor_borrower' | 'income_leases' | 'market_comps' | 'property_ops' | 'other'
>> = {
  // Sponsor & borrower diligence — refinance-side scrutiny, sources/uses
  // proceeds flow, sponsor background.
  'P-II-3':     'sponsor_borrower',
  'P-III-5':    'sponsor_borrower',
  'P-III-11':   'sponsor_borrower',
  'P-III-12':   'sponsor_borrower',
  // Income & lease completeness — NOI reconciliation, signed-lease execution,
  // termination options, tenant-cash-flow durability.
  'P-II-1':     'income_leases',
  'P-II-2':     'income_leases',
  'P-II-4':     'income_leases',
  'P-II-9':     'income_leases',
  'P-III-1':    'income_leases',
  'P-III-15':   'income_leases',
  // Submarket & comparable data — submarket leasing, sales/rent comps,
  // portfolio exposure benchmarking.
  'P-III-2':    'market_comps',
  'P-III-7':    'market_comps',
  'P-III-13':   'market_comps',
  'P-IV-OFF-1': 'market_comps',
  'P-IV-OFF-7': 'market_comps',
  'P-IV-OFF-8': 'market_comps',
  'P-IV-OFF-10': 'market_comps',
  // Property condition & operations — physical asset attributes, utilization
  // patterns, sublease overhang, stress sensitivity.
  'P-IV-OFF-2': 'property_ops',
  'P-IV-OFF-4': 'property_ops',
  'P-IV-OFF-5': 'property_ops',
  'P-IV-OFF-6': 'property_ops',
};

// Enrichment for the bare missing_field paths the deterministic handbook
// emits (e.g. "metric field 'cash_out_amount'"). Maps each field token to a
// human-readable required-input description. Principles without an entry
// fall back to the bare detail string.
export const OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8: Readonly<Record<string, string>> = {
  'cash_out_amount':             'Sponsor cash-out amount at refinancing (Sources & Uses statement)',
  'building_class':              'Building class designation (Class A / B / C — from appraisal or PCA)',
  'stressed_dscr_top_3_removed': 'Stressed DSCR with top-3 tenants removed (stress engine output gap)',
};

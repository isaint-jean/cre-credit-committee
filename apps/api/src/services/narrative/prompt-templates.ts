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

export const NARRATIVE_SYSTEM_PROMPT = `You are a senior commercial real estate credit analyst writing for an institutional credit committee. Your prose is concise, factual, and avoids hedging language. You cite specific metric values and principle ids when the input provides them. You never invent data: if a metric is missing from the input, you omit it rather than estimating.`;

export const EXECUTIVE_SUMMARY_PROMPT_TEMPLATE = `Compose a single executive-summary paragraph (4-6 sentences) for the credit committee. The summary frames the deal's headline risks based on the handbook flags below.

Requirements:
- Lead with the most material risk. The flags are pre-sorted by severity (critical → high → medium → advisory).
- Cite the principle id in parentheses when introducing each flag (e.g., "cash-out refinance scrutiny (P-II-3)").
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

export function renderFlagList(flags: readonly FormattedFlag[]): string {
  if (flags.length === 0) return '(no flags fired for this injection point)';
  return flags
    .map((f) => `- [${f.severity}] ${f.principleId} — ${f.message} (metric: ${f.metric})`)
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
- Each bullet starts with the principle id in square brackets, followed by a one-to-two-sentence assessment.
  Format: \`- [P-XX-N] <assessment>\`
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
- Each bullet starts with the principle id in square brackets, followed by a one-to-two-sentence recommended action.
  Format: \`- [P-XX-N] <recommended action>\`
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

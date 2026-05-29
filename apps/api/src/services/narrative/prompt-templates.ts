/**
 * Frozen prompt-text constants for the narrative engine.
 *
 * Phase 1 (NARRATIVE_ENGINE_VERSION '1.0') shipped the executive_summary
 * survivor. Phase 2 (NARRATIVE_ENGINE_VERSION '1.1') added the
 * red_flag_assessment slot. Phase 3 (NARRATIVE_ENGINE_VERSION '1.2')
 * adds the mitigation_suggestions slot. The final committee_recommendation
 * slot lands in Phase 4 via the same MINOR-bump cadence.
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
 * slot (Phase 3, NARRATIVE_ENGINE_VERSION '1.2'). Intent differs from
 * the prior two slots: where executive_summary frames the deal and
 * red_flag_assessment enumerates risks, mitigation_suggestions pairs
 * each fired flag with a CONCRETE RECOMMENDED ACTION (escrow,
 * reserve, covenant, structure adjustment, additional due diligence,
 * etc.). The committee should be able to read this slot and
 * understand what structural changes would address each flagged risk.
 *
 * Bulleted output, one bullet per flag — same structural family as
 * red_flag_assessment but the bullet content is prescriptive (action)
 * rather than descriptive (risk).
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
 * mitigation-suggestions template. Same substitution pattern as the
 * prior two slot helpers; substitution outside the hashed template
 * constant keeps the boot-check hash stable across deals.
 */
export function buildMitigationSuggestionsPrompt(flags: readonly FormattedFlag[]): string {
  return MITIGATION_SUGGESTIONS_PROMPT_TEMPLATE
    .replace('{{flag_count}}', flags.length.toString())
    .replace('{{flags}}', renderFlagList(flags));
}

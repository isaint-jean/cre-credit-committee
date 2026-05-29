/**
 * Frozen prompt-text constants for the narrative engine (Piece A Phase 1
 * batch 1). The narrative-engine boot check hashes these strings + the
 * version constant; any edit to a constant without a coordinated
 * NARRATIVE_ENGINE_VERSION bump + manifest append fails fast on api startup.
 *
 * Phase 1 ships the executive_summary survivor only. Additional injection-
 * point templates (red_flag_assessment, mitigation_suggestions,
 * committee_recommendation) land here in later Phase 1 sub-batches and join
 * the hash snapshot via narrative-engine-boot-check.ts.
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

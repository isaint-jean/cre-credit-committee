/**
 * Boot-time invariant assertion for the narrative-engine frozen state.
 *
 * One check, fail-fast:
 *   - HASH_DRIFT — recomputing the canonical hash of the frozen narrative-
 *     engine state (system prompt + executive-summary prompt template) matches
 *     the manifest entry for `NARRATIVE_ENGINE_VERSION`.
 *
 * Mirrors `judgment-engine-boot-check.ts`. Throws
 * `NarrativeEngineBootCheckError` on any failure; caller (api/index.ts)
 * propagates so the process exits non-zero before the HTTP listener.
 *
 * The "frozen state" for the narrative engine is the prompt-text constants
 * that shape LLM output. Format-flags filter logic is structural (no static
 * data table) and is covered by its own scripts-based test rather than the
 * hash drift check.
 */

import {
  NARRATIVE_ENGINE_MANIFEST,
  NARRATIVE_ENGINE_VERSION,
} from '@cre/contracts';
import {
  NARRATIVE_SYSTEM_PROMPT,
  EXECUTIVE_SUMMARY_PROMPT_TEMPLATE,
  RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE,
  MITIGATION_SUGGESTIONS_PROMPT_TEMPLATE,
  COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE,
  MITIGATION_SUGGESTIONS_HEADER_V1_5,
  MITIGATION_SUGGESTIONS_EMPTY_V1_5,
  // v1.6 — composed-package wiring + handbook demotion. New template + header
  // constants enter the hash snapshot so any edit forces a version bump.
  EXECUTIVE_SUMMARY_PROMPT_TEMPLATE_V1_6,
  RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE_V1_6,
  COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE_V1_6,
  AUTHORITATIVE_NUMBERS_HEADER_V1_6,
  AUTHORITATIVE_NUMBERS_INSTRUCTION_V1_6,
  HANDBOOK_SUPPORTING_PREAMBLE_V1_6,
  HANDBOOK_SUPPORTING_EMPTY_V1_6,
  MITIGATION_SUGGESTIONS_HEADER_V1_6,
  MITIGATION_SUGGESTIONS_EMPTY_V1_6,
  MITIGATION_SUGGESTIONS_RECONCILIATION_HEADER_V1_6,
  // v1.8 — Open Items / Data Required deterministic slot. The header text,
  // intro, empty-case sentinel, theme labels (ordered), per-principle theme
  // assignment, and missing_field enrichment table all enter the hash snapshot
  // so any edit forces a version bump + manifest append.
  OPEN_ITEMS_HEADER_V1_8,
  OPEN_ITEMS_INTRO_V1_8,
  OPEN_ITEMS_EMPTY_V1_8,
  OPEN_ITEMS_THEME_HEADERS_V1_8,
  OPEN_ITEMS_PRINCIPLE_THEME_V1_8,
  OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8,
} from '../services/narrative/prompt-templates.js';
import { assertCommitteeVoiceComplete } from '../services/narrative/committee-voice.js';
import { computeContentHash } from './content-hash.js';

export class NarrativeEngineBootCheckError extends Error {
  override readonly name = 'NarrativeEngineBootCheckError';
  constructor(
    public readonly code:
      | 'NARRATIVE_ENGINE_MANIFEST_MISSING_VERSION'
      | 'NARRATIVE_ENGINE_HASH_DRIFT',
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

function buildNarrativeEngineHashSnapshot() {
  return {
    systemPrompt: NARRATIVE_SYSTEM_PROMPT,
    executiveSummaryPromptTemplate: EXECUTIVE_SUMMARY_PROMPT_TEMPLATE,
    redFlagAssessmentPromptTemplate: RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE,
    mitigationSuggestionsPromptTemplate: MITIGATION_SUGGESTIONS_PROMPT_TEMPLATE,
    committeeRecommendationPromptTemplate: COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE,
    // v1.5 — deterministic mitigation_suggestions slot. Header + empty-case
    // text are frozen alongside the LLM templates so an edit forces a version
    // bump + manifest append (same discipline as the templates above).
    mitigationSuggestionsHeaderV15: MITIGATION_SUGGESTIONS_HEADER_V1_5,
    mitigationSuggestionsEmptyV15: MITIGATION_SUGGESTIONS_EMPTY_V1_5,
    // v1.6 — composed-package wiring + handbook demotion. New slot templates,
    // authoritative-numbers header / instruction, handbook-demotion preamble,
    // composed-mitigations header / empty-case / reconciliation header.
    executiveSummaryPromptTemplateV16: EXECUTIVE_SUMMARY_PROMPT_TEMPLATE_V1_6,
    redFlagAssessmentPromptTemplateV16: RED_FLAG_ASSESSMENT_PROMPT_TEMPLATE_V1_6,
    committeeRecommendationPromptTemplateV16: COMMITTEE_RECOMMENDATION_PROMPT_TEMPLATE_V1_6,
    authoritativeNumbersHeaderV16: AUTHORITATIVE_NUMBERS_HEADER_V1_6,
    authoritativeNumbersInstructionV16: AUTHORITATIVE_NUMBERS_INSTRUCTION_V1_6,
    handbookSupportingPreambleV16: HANDBOOK_SUPPORTING_PREAMBLE_V1_6,
    handbookSupportingEmptyV16: HANDBOOK_SUPPORTING_EMPTY_V1_6,
    mitigationSuggestionsHeaderV16: MITIGATION_SUGGESTIONS_HEADER_V1_6,
    mitigationSuggestionsEmptyV16: MITIGATION_SUGGESTIONS_EMPTY_V1_6,
    mitigationSuggestionsReconciliationHeaderV16: MITIGATION_SUGGESTIONS_RECONCILIATION_HEADER_V1_6,
    // v1.8 — Open Items / Data Required deterministic slot. All v1.8 constants
    // enter the hash; the theme-headers list is canonicalized as a tuple-array
    // so insertion order is hash-significant (reordering = bump).
    openItemsHeaderV18: OPEN_ITEMS_HEADER_V1_8,
    openItemsIntroV18: OPEN_ITEMS_INTRO_V1_8,
    openItemsEmptyV18: OPEN_ITEMS_EMPTY_V1_8,
    openItemsThemeHeadersV18: OPEN_ITEMS_THEME_HEADERS_V1_8,
    openItemsPrincipleThemeV18: OPEN_ITEMS_PRINCIPLE_THEME_V1_8,
    openItemsMissingFieldLabelsV18: OPEN_ITEMS_MISSING_FIELD_LABELS_V1_8,
  };
}

export function computeCurrentNarrativeEngineHash(): string {
  return computeContentHash(buildNarrativeEngineHashSnapshot());
}

export function performNarrativeEngineBootCheck(): void {
  // Committee-voice mapping layer (memo v2): assert every judgment-engine
  // rule, doctrine reason code, and dimension has a committee-voice sentence.
  // Backs the type system against `as`-cast escapes so a missing translation
  // fails fast at startup rather than leaking a raw identifier into a memo.
  assertCommitteeVoiceComplete();

  const expectedHash = NARRATIVE_ENGINE_MANIFEST[NARRATIVE_ENGINE_VERSION];
  if (!expectedHash || expectedHash === '__NARRATIVE_ENGINE_V1_HASH__') {
    throw new NarrativeEngineBootCheckError(
      'NARRATIVE_ENGINE_MANIFEST_MISSING_VERSION',
      `no manifest entry for NARRATIVE_ENGINE_VERSION='${NARRATIVE_ENGINE_VERSION}'. Run \`npm run narrative-engine:print-hash\` and append the result to NARRATIVE_ENGINE_MANIFEST.`,
    );
  }
  const currentHash = computeCurrentNarrativeEngineHash();
  if (currentHash !== expectedHash) {
    throw new NarrativeEngineBootCheckError(
      'NARRATIVE_ENGINE_HASH_DRIFT',
      `narrative-engine state for version '${NARRATIVE_ENGINE_VERSION}' hashes to ${currentHash}, ` +
        `manifest expects ${expectedHash}. Either revert the change OR bump NARRATIVE_ENGINE_VERSION ` +
        `and append a new manifest entry.`,
    );
  }
}

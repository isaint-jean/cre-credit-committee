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
} from '../services/narrative/prompt-templates.js';
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
  };
}

export function computeCurrentNarrativeEngineHash(): string {
  return computeContentHash(buildNarrativeEngineHashSnapshot());
}

export function performNarrativeEngineBootCheck(): void {
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

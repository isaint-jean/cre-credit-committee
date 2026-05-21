/**
 * extractASR - AI-tier extractor for the ASR's headline UW summary numbers.
 *
 * Pulls three fields from the ASR text:
 *   - impliedValue     (dollar amount the broker pitches as the property's value)
 *   - impliedCapRate   (0..1 fraction)
 *   - underwrittenNOI  (annual dollar amount the broker pitches as stabilized NOI)
 *
 * These are distinct from PropertyMetadata (identity/address/specs, pulled by
 * extractPropertyMetadata) and from the rent-roll table within the ASR (pulled
 * by extractRentRollFromDocument). All three extractors run against the same
 * ParsedDocument under the ASR adapter's fan-out.
 *
 * IMPORTANT: TREAT EXTRACTED VALUES WITH SKEPTICISM.
 *
 * The ASR is a sales document. Brokers pitch numbers favorable to the seller's
 * narrative: implied values are typically aspirational, cap rates are usually
 * tight, and underwritten NOI may exclude conservative adjustments a buyer
 * would apply. The judgment engine treats ASR as the LOWEST source tier
 * (BANK > T12_ACTUAL > APPRAISAL > SELLER_UW > ASR per
 * docs/judgment-engine-plan.md:95), so these values are reference points, not
 * authoritative inputs. Downstream consumers must not treat ASR figures as
 * facts.
 *
 * Discipline:
 *   - Best-effort. AI extraction can miss; missing field -> null.
 *   - No fabrication. Placeholder strings ("N/A", "Not provided", "TBD") map to null.
 *   - If literally every field is null after parsing, return null (no empty record).
 *   - The pure parser (parseAsrAiResponse) is exported separately so tests
 *     run without invoking the live API.
 *   - Cap rate normalization: brokers may write 6.5 (percent) or 0.065
 *     (fraction). Values >1 are treated as percents and divided by 100. Values
 *     0..1 are treated as fractions. Edge case 1 is treated as fraction (1.0
 *     = 100%, implausible but preserved as the literal value).
 */

import type { ASRExtraction } from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';

const EXTRACT_ASR_SYSTEM = `You extract ASR headline UW numbers from CRE documents and return ONLY a JSON object matching the requested schema. Missing fields must be null. Never add prose, commentary, or markdown.`;

function buildPrompt(text: string): string {
  return [
    'Extract the ASR headline underwriting summary from this CRE document. Return STRICT JSON of this shape (and nothing else):',
    '{',
    '  "impliedValue": <dollar amount or null>,',
    '  "impliedCapRate": <fraction 0-1 OR percent number, e.g. 0.065 or 6.5, or null>,',
    '  "underwrittenNOI": <annual dollar amount or null>',
    '}',
    '',
    'Rules:',
    '- Missing field -> null. Do NOT use 0 / "" / "N/A" / "TBD" as placeholders.',
    '- impliedValue is the broker pitched property value (dollars). May appear as "Implied Value", "Pricing Value", or similar.',
    '- impliedCapRate is the broker implied cap rate. May appear as decimal (0.065) or percent (6.5). Either form is acceptable; the parser normalizes.',
    '- underwrittenNOI is the broker stabilized/pro-forma NOI (annual dollars). May appear as "Year 1 NOI", "Stabilized NOI", "Underwritten NOI", or similar.',
    '- Numbers only (no strings with commas or $ signs in the JSON output). Use null when uncertain.',
    '',
    '--- DOCUMENT TEXT ---',
    text,
  ].join('\n');
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (/^(n\/?a|none|null|undefined|not\s*provided|not\s*disclosed|not\s*available|tbd)$/i.test(trimmed)) return null;
  return trimmed;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = asString(v);
    if (s === null) return null;
    const cleaned = s.replace(/[$,\s%]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asMoney(v: unknown): number | null {
  return asNumber(v);
}

function asCapRate(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  if (n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

/**
 * Pure parser. Exported so tests can exercise normalization without invoking AI.
 *
 * Accepts either:
 *   - A response string (presumed to contain a JSON blob; extractJSON pulls it)
 *   - An already-parsed object (for direct test cases)
 *
 * Returns null when the JSON is unparseable OR every field ends up null after
 * normalization (no fabricated empty records).
 */
export function parseAsrAiResponse(responseText: string | unknown): ASRExtraction | null {
  let parsed: unknown;
  if (typeof responseText === 'string') {
    try {
      parsed = extractJSON(responseText);
    } catch {
      return null;
    }
  } else {
    parsed = responseText;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as { [k: string]: unknown };

  const impliedValue = asMoney(r.impliedValue);
  const impliedCapRate = asCapRate(r.impliedCapRate);
  const underwrittenNOI = asMoney(r.underwrittenNOI);

  if (impliedValue === null && impliedCapRate === null && underwrittenNOI === null) {
    return null;
  }

  return {
    impliedValue,
    impliedCapRate,
    underwrittenNOI,
  };
}

/**
 * Extract ASR headline UW numbers from a ParsedDocument via AI. Returns null
 * on empty/missing text, AI call failure, malformed JSON, or all-null fields
 * after parsing.
 */
export async function extractASR(document: ParsedDocument): Promise<ASRExtraction | null> {
  const text = document.sections
    .map((s) => (s.title ? '## ' + s.title + '\n' : '') + (s.content ?? ''))
    .join('\n\n')
    .slice(0, 80_000);
  if (text.length === 0) return null;

  let responseText: string;
  try {
    responseText = await callAIWithContinuation({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: EXTRACT_ASR_SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(text) }],
    });
  } catch (err) {
    console.warn('[AI:ASR] extraction call failed:', err);
    return null;
  }

  return parseAsrAiResponse(responseText);
}

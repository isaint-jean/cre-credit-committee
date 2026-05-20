/**
 * extractPropertyMetadata — AI-tier extractor for property identity + physical specs.
 *
 * Pulls fields from the ASR text needed to populate the BP Spiral
 * Property & Loan Summary header block + Property Detail tabs:
 *   - propertyName, propertySubtype
 *   - address, city, state (2-letter), zip, county, msa, submarket
 *   - yearBuilt, yearRenovated
 *   - buildingClass
 *   - totalSquareFeet / totalUnits / totalRooms / totalPads (asset-type-specific)
 *   - occupancyPhysical, occupancyEconomic
 *   - ownershipInterest, numberOfBuildings
 *
 * Discipline:
 *   - Best-effort. AI extraction can miss; missing → null.
 *   - No fabrication. Placeholder strings ("N/A", "Not provided") map to null.
 *   - The pure parser (`parsePropertyMetadataAiResponse`) is exported separately
 *     so tests run without invoking the live API.
 */

import type { PropertyMetadata, PropertyMetadataSource } from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computePropertyMetadataId } from '../util/content-hash.js';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';

const PROPERTY_METADATA_SYSTEM = `You extract structured property metadata from CRE documents and return ONLY a JSON object matching the requested schema. Missing fields must be null. Never add prose, commentary, or markdown.`;

function buildPrompt(text: string): string {
  return [
    'Extract property identity and physical specs from this CRE document. Return STRICT JSON of this shape (and nothing else):',
    '{',
    '  "propertyName": "<string or null>",',
    '  "propertySubtype": "<e.g. Suburban Office, Anchored Retail, or null>",',
    '  "address": "<street address or null>",',
    '  "city": "<city or null>",',
    '  "state": "<2-letter state code or null>",',
    '  "zip": "<5-digit zip or null>",',
    '  "county": "<county name or null>",',
    '  "msa": "<MSA name or null>",',
    '  "submarket": "<submarket name or null>",',
    '  "yearBuilt": <integer year or null>,',
    '  "yearRenovated": <integer year or null>,',
    '  "buildingClass": "<A/B/C/A-/B+ or null>",',
    '  "totalSquareFeet": <number or null>,',
    '  "totalUnits": <number or null>,',
    '  "totalRooms": <number or null>,',
    '  "totalPads": <number or null>,',
    '  "occupancyPhysical": <fraction 0-1 or null>,',
    '  "occupancyEconomic": <fraction 0-1 or null>,',
    '  "ownershipInterest": "<Fee Simple / Leasehold / etc or null>",',
    '  "numberOfBuildings": <integer or null>',
    '}',
    '',
    'Rules:',
    '- Missing field -> null. Do NOT use 0 / "" / "N/A" as placeholders.',
    '- Occupancy as fraction (0.92 for 92%), NOT percent.',
    '- State as 2-letter postal code (e.g. CA, NY, TX).',
    '- Only one of totalSquareFeet/totalUnits/totalRooms/totalPads typically applies per asset type. Use whichever is stated; null the others.',
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
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s%]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asInteger(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function asState(v: unknown): string | null {
  const s = asString(v);
  if (s === null) return null;
  // Accept 2-letter codes directly; reject longer strings (caller can map
  // 'California' -> 'CA' in a future pass if needed).
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
}

function asOccupancy(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  // Heuristic: a value > 1 is almost certainly a percent (e.g. 92), so divide
  // by 100. Values 0..1 are already fractions.
  if (n > 1 && n <= 100) return n / 100;
  if (n >= 0 && n <= 1) return n;
  return null;
}

/**
 * Pure parser. Exported so tests can exercise normalization without invoking AI.
 */
export function parsePropertyMetadataAiResponse(
  responseText: string | unknown,
  source: PropertyMetadataSource,
): PropertyMetadata | null {
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

  const body = {
    source,
    propertyName:       asString(r.propertyName),
    propertySubtype:    asString(r.propertySubtype),
    address:            asString(r.address),
    city:               asString(r.city),
    state:              asState(r.state),
    zip:                asString(r.zip),
    county:             asString(r.county),
    msa:                asString(r.msa),
    submarket:          asString(r.submarket),
    yearBuilt:          asInteger(r.yearBuilt),
    yearRenovated:      asInteger(r.yearRenovated),
    buildingClass:      asString(r.buildingClass),
    totalSquareFeet:    asNumber(r.totalSquareFeet),
    totalUnits:         asInteger(r.totalUnits),
    totalRooms:         asInteger(r.totalRooms),
    totalPads:          asInteger(r.totalPads),
    occupancyPhysical:  asOccupancy(r.occupancyPhysical),
    occupancyEconomic:  asOccupancy(r.occupancyEconomic),
    ownershipInterest:  asString(r.ownershipInterest),
    numberOfBuildings:  asInteger(r.numberOfBuildings),
  };

  // If literally every field is null, return null — no fabricated record.
  const hasAny = Object.entries(body).some(([k, v]) => k !== 'source' && v !== null);
  if (!hasAny) return null;

  return { id: computePropertyMetadataId(body), ...body };
}

export async function extractPropertyMetadata(
  document: ParsedDocument,
  source: PropertyMetadataSource = 'asr_extraction',
): Promise<PropertyMetadata | null> {
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
      system: PROPERTY_METADATA_SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(text) }],
    });
  } catch (err) {
    console.warn('[AI:PropertyMetadata] extraction call failed:', err);
    return null;
  }

  return parsePropertyMetadataAiResponse(responseText, source);
}

/**
 * extractRentRollFromDocument — best-effort AI fallback for rent-roll extraction.
 *
 * When no dedicated rent-roll xlsx is uploaded, the pipeline falls back to extracting
 * a rent roll from the text of the ASR (or seller UW) document. This module owns that
 * extraction. It is the SECOND-tier source per the locked precedence policy:
 *
 *   1. rent_roll_file  (deterministic xlsx parser; preferred when available)
 *   2. asr_table       (THIS module — AI extraction over ASR text)
 *   3. seller_uw       (THIS module — AI extraction over Seller UW text)
 *
 * Discipline:
 *   - Best-effort. AI extraction is unreliable on tabular data; failures return null
 *     rather than throw. The caller logs a 'missing-support: rent-roll' issue when
 *     null is returned.
 *   - No fabrication. The AI is instructed to return rows ONLY for tenants explicitly
 *     listed in the source. Missing values stay null. The post-processor enforces this
 *     by null-ing fields that came back as zero, empty string, or generic placeholders.
 *   - Lease-type / status normalization is identical to the xlsx parser (single set of
 *     rules in this module to keep the two paths consistent).
 *
 * The module exports two functions:
 *   - extractRentRollFromDocument: full pipeline (prompt -> AI -> parse -> RentRoll)
 *   - parseRentRollAiResponse:    pure parser used for unit testing without an API
 */

import {
  type LeaseType,
  type RentRoll,
  type RentRollLine,
  type RentRollSource,
  type TenantStatus,
} from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { computeRentRollId } from '../util/content-hash.js';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';

const RENT_ROLL_SYSTEM = `You extract structured rent-roll data from CRE documents and return ONLY a JSON object matching the requested schema. Do not invent tenants. Do not infer values. Missing fields must be null. Never add prose, commentary, or markdown.`;

function buildPrompt(text: string, propertyHint: string | null): string {
  return [
    'Extract the rent roll from this CRE document.',
    propertyHint ? `Property: ${propertyHint}` : '',
    '',
    'Rent rolls come in TWO shapes. Tag each line with `kind` accordingly:',
    '  - `kind: "tenant"` — office, retail, industrial (one commercial lease per row).',
    '    Has tenant name, square feet, lease end date as expiration, lease type',
    '    (NNN / MG / FSG / GROSS / IG), recoveries, TI/LC.',
    '  - `kind: "unit"`   — multifamily, MHC, student housing (one residential unit per row).',
    '    Has unit ID, bedrooms / bathrooms / unit type, MONTHLY rent, concessions.',
    '    Lease term is typically 12 months OR month-to-month. Do NOT emit leaseType.',
    '',
    'A single document is normally homogeneous (all tenant lines OR all unit lines). Tag each',
    'line according to its OWN evidence; do not mix unit fields onto a tenant line or vice versa.',
    '',
    'Return STRICT JSON (and nothing else):',
    '{',
    '  "asOfDate": "<ISO 8601 date or null>",',
    '  "propertyName": "<string or null>",',
    '  "lines": [',
    '    // tenant variant',
    '    {',
    '      "kind": "tenant",',
    '      "tenantName": "<string or null>",',
    '      "suite": "<string or null>",',
    '      "squareFeet": <number or null>,',
    '      "status": "OCCUPIED" | "VACANT" | "PRELEASED" | "HOLDOVER" | "UNKNOWN",',
    '      "leaseStart": "<ISO date or null>",',
    '      "leaseEnd": "<ISO date or null>",',
    '      "inPlaceRentAnnual": <annual $ or null>,',
    '      "marketRentAnnual": <annual $ or null>,',
    '      "leaseType": "NNN" | "MG" | "FSG" | "GROSS" | "IG" | "OTHER" | "UNKNOWN",',
    '      "recoveriesAnnual": <annual $ or null>,',
    '      "otherIncomeAnnual": <annual $ or null>,',
    '      "newTiPsf": <$/SF or null>,',
    '      "renewTiPsf": <$/SF or null>,',
    '      "newLcPct": <fraction 0-1 or null>,',
    '      "renewLcPct": <fraction 0-1 or null>,',
    '      "downtimeMonths": <number or null>,',
    '      "notes": "<string or null>"',
    '    },',
    '    // unit variant',
    '    {',
    '      "kind": "unit",',
    '      "unitId": "<required string — unit number or identifier>",',
    '      "status": "OCCUPIED" | "VACANT" | "PRELEASED" | "HOLDOVER" | "UNKNOWN",',
    '      "squareFeet": <number or null>,',
    '      "bedrooms": <number or null>,',
    '      "bathrooms": <number or null>,',
    '      "unitType": "<e.g. 1BR/1BA, Studio, Townhome — or null>",',
    '      "leaseStart": "<ISO date or null>",',
    '      "leaseEndOrMTM": "<ISO date or null — null means month-to-month, NOT missing>",',
    '      "inPlaceRentMonthly": <monthly $ or null>,',
    '      "marketRentMonthly": <monthly $ or null>,',
    '      "concessionsMonthly": <monthly $ or null>,',
    '      "securityDeposit": <$ or null>,',
    '      "notes": "<string or null>"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Only emit lines that appear EXPLICITLY in the source. Do not invent.',
    '- Missing field on a row -> null. Do NOT use 0 as a placeholder.',
    '- VACANT units are NORMAL: status="VACANT", inPlaceRentMonthly=null (NOT 0).',
    '  marketRentMonthly may still be present (the asking rent).',
    '- For unit lines: `leaseEndOrMTM` null SEMANTICALLY MEANS month-to-month.',
    '  Do NOT synthesize a fake end date for MTM leases. Do NOT treat null as a parse failure.',
    '- For tenant lines: annual rent is annualized contract rent ($), not monthly.',
    '- For unit lines: rent fields are monthly $.',
    '- No `leaseType` on unit lines — the office NNN/MG/FSG vocabulary has no residential analog.',
    '- If the document has no rent roll, return {"asOfDate": null, "propertyName": null, "lines": []}.',
    '',
    '--- DOCUMENT TEXT ---',
    text,
  ].filter(Boolean).join('\n');
}

const LEASE_TYPE_VALUES: ReadonlySet<LeaseType> = new Set(['NNN', 'MG', 'FSG', 'GROSS', 'IG', 'OTHER', 'UNKNOWN']);
const STATUS_VALUES: ReadonlySet<TenantStatus> = new Set(['OCCUPIED', 'VACANT', 'PRELEASED', 'HOLDOVER', 'UNKNOWN']);

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  // Treat common AI-placeholder strings as null.
  if (/^(n\/?a|none|null|undefined|not\s*provided|not\s*disclosed)$/i.test(trimmed)) return null;
  return trimmed;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asLeaseType(v: unknown): LeaseType {
  if (typeof v !== 'string') return 'UNKNOWN';
  const upper = v.trim().toUpperCase();
  return LEASE_TYPE_VALUES.has(upper as LeaseType) ? (upper as LeaseType) : 'UNKNOWN';
}

function asStatus(v: unknown): TenantStatus {
  if (typeof v !== 'string') return 'UNKNOWN';
  const upper = v.trim().toUpperCase();
  return STATUS_VALUES.has(upper as TenantStatus) ? (upper as TenantStatus) : 'UNKNOWN';
}

function normalizeLine(raw: unknown): RentRollLine | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { [k: string]: unknown };
  // Determine line kind from the AI's `kind` field; fall back to
  // structural sniffing for older responses that didn't tag (the
  // discriminant only landed at narrative engine v1.7 / this PR — older
  // cache entries may not carry it). Tenant fallback preserves prior
  // behavior; unit-shape rows without `kind` are rare in practice
  // because the model wouldn't have known to emit unit-specific fields.
  const kindRaw = typeof r.kind === 'string' ? r.kind.toLowerCase() : null;
  const looksLikeUnit =
    kindRaw === 'unit' ||
    (kindRaw === null && (
      r.unitId !== undefined ||
      r.bedrooms !== undefined ||
      r.leaseEndOrMTM !== undefined ||
      r.inPlaceRentMonthly !== undefined ||
      r.concessionsMonthly !== undefined
    ));

  if (looksLikeUnit) {
    // Unit shape — multifamily / MHC / student housing.
    const unitId = asString(r.unitId) ?? asString(r.suite);
    const sf = asNumber(r.squareFeet);
    // Drop rows with no identifying info — AI hallucination signal.
    if (unitId === null && sf === null) return null;
    return {
      kind: 'unit',
      unitId: unitId ?? 'unit-unknown',
      status:             asStatus(r.status),
      squareFeet:         sf,
      bedrooms:           asNumber(r.bedrooms),
      bathrooms:          asNumber(r.bathrooms),
      unitType:           asString(r.unitType),
      leaseStart:         asString(r.leaseStart),
      // leaseEndOrMTM null is SEMANTIC (month-to-month), not missing — preserve.
      leaseEndOrMTM:      asString(r.leaseEndOrMTM ?? r.leaseEnd),
      inPlaceRentMonthly: asNumber(r.inPlaceRentMonthly),
      marketRentMonthly:  asNumber(r.marketRentMonthly),
      concessionsMonthly: asNumber(r.concessionsMonthly),
      securityDeposit:    asNumber(r.securityDeposit),
      notes:              asString(r.notes),
    };
  }

  // Tenant shape (default). Behavior preserved from pre-discriminant
  // version PLUS the kind:'tenant' stamp.
  const tenantName = asString(r.tenantName);
  const sf = asNumber(r.squareFeet);
  // Drop rows that have no identifying info at all — they're likely AI hallucination
  // ('row 7 of an empty section' style). A real tenant has at least a name OR an SF.
  if (tenantName === null && sf === null) return null;
  return {
    kind: 'tenant',
    tenantName,
    suite:             asString(r.suite),
    squareFeet:        sf,
    status:            asStatus(r.status),
    leaseStart:        asString(r.leaseStart),
    leaseEnd:          asString(r.leaseEnd),
    inPlaceRentAnnual: asNumber(r.inPlaceRentAnnual),
    marketRentAnnual:  asNumber(r.marketRentAnnual),
    leaseType:         asLeaseType(r.leaseType),
    recoveriesAnnual:  asNumber(r.recoveriesAnnual),
    otherIncomeAnnual: asNumber(r.otherIncomeAnnual),
    newTiPsf:          asNumber(r.newTiPsf),
    renewTiPsf:        asNumber(r.renewTiPsf),
    newLcPct:          asNumber(r.newLcPct),
    renewLcPct:        asNumber(r.renewLcPct),
    downtimeMonths:    asNumber(r.downtimeMonths),
    notes:             asString(r.notes),
  };
}

/**
 * Pure parser: text response (or pre-parsed JSON object) -> RentRoll | null.
 * Exported so tests can exercise the response normalization without invoking AI.
 */
export function parseRentRollAiResponse(
  responseText: string | unknown,
  source: RentRollSource,
): RentRoll | null {
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
  const root = parsed as { [k: string]: unknown };
  const linesRaw = root.lines;
  if (!Array.isArray(linesRaw)) return null;

  const lines: RentRollLine[] = [];
  for (const raw of linesRaw) {
    const line = normalizeLine(raw);
    if (line !== null) lines.push(line);
  }
  // Empty rent roll returned -> null (caller logs missing-support). We do NOT
  // emit a RentRoll with zero lines; that's indistinguishable from "not present".
  if (lines.length === 0) return null;

  const body = {
    asOfDate: asString(root.asOfDate),
    propertyName: asString(root.propertyName),
    source,
    lines,
  };
  return { id: computeRentRollId(body), ...body };
}

/**
 * Extract a rent roll from a parsed document via AI. Returns null on:
 *   - empty/missing AI response
 *   - malformed JSON
 *   - empty lines array (AI determined no rent roll present)
 *
 * Caller is responsible for logging missing-support when null is returned.
 */
export async function extractRentRollFromDocument(
  document: ParsedDocument,
  source: RentRollSource,
  options: { propertyHint?: string | null } = {},
): Promise<RentRoll | null> {
  // Concatenate sections to a single text blob. The model's context window is
  // the rate-limit; we cap at ~80k chars to keep token usage bounded.
  const text = document.sections
    .map((s) => (s.title ? '## ' + s.title + '\n' : '') + (s.content ?? ''))
    .join('\n\n')
    .slice(0, 80_000);
  if (text.length === 0) return null;

  let responseText: string;
  try {
    responseText = await callAIWithContinuation({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: RENT_ROLL_SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(text, options.propertyHint ?? null) }],
    });
  } catch (err) {
    console.warn('[AI:RentRoll] extraction call failed:', err);
    return null;
  }

  return parseRentRollAiResponse(responseText, source);
}

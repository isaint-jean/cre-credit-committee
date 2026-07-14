/**
 * extractRentRollFromDocumentLlm — LLM-PRIMARY FALLBACK for a rent roll the
 * best-effort document extractor UNDER-READS, plus a COMPLETENESS GUARD that
 * proves the roll was read whole (by arithmetic) before any concentration /
 * rollover consumer is allowed to trust it.
 *
 * WHY THIS EXISTS. The existing document-path rent-roll extractor
 * (`extract-rent-roll-from-document.ts`) prompts the LLM for a generic
 * tenant/unit grid. On a DENSE, non-standard roll — 640 Fifth Ave's Vornado
 * `ANNULREP` "ANNUALIZED TENANT RENT ROLL", where a single tenant spans a
 * multi-line block (base-rent line + R/E-tax-escalation + CAM/recovery lines +
 * a scheduled rent-step ladder) terminated by a `TENANT TOTAL:` line — it
 * UNDER-READS (the recon reported "~10 tenants" of ~19). An under-read roll
 * dropped `ROLLOVER_WITHIN_TERM` from applicability and priced tenant
 * concentration on a partial book — silently mis-pricing the deal (Victoria's
 * Secret alone is ~$38.6M ≈ 52% of the ~$74.6M roll).
 *
 * This module de-anchors that failure with the SAME proven shape the loan-terms
 * (`extract-asr-loan-terms-llm.ts`) and cash-flow (`extract-cash-flow-from-
 * xlsx-llm.ts`) fallbacks already ship:
 *   - full-doc read, `callAIWithContinuation` on Sonnet, STRICT-JSON-nulls
 *     discipline, tolerant `extractJSON` parse.
 *   - GOVERNANCE armor: `creditsAvailable()` credit-gate (no key ⇒ skip the
 *     call, $0), temperature 0 (greedy / replay-stable), an INJECTABLE LLM seam
 *     so proofs pass a deterministic stub, CACHING (docHash+version), a
 *     CITE-OR-DISCARD guard against the doc text, and a fail-safe (error /
 *     malformed → null → today's honest floor).
 *
 * ★★ THE COMPLETENESS GUARD (the load-bearing new piece). A rent roll fails not
 * by a wrong number but by DROPPED ROWS — and a partial roll is INDISTINGUISHABLE
 * from a complete one unless you check the arithmetic. So, exactly as the income
 * side proves NOI by the ASR-NOI cross-check (`checkAsrNoiDivergence`), this
 * module proves COMPLETENESS by RECONCILIATION:
 *
 *   (a) TOTAL-RENT RECONCILIATION. Σ extracted per-tenant annual rents must
 *       reconcile (within tolerance) to the roll's OWN stated total line (the
 *       Vornado `BLDG. TOTAL` / `TENANT TOTAL` grand-total, ~$74.6M) OR to a
 *       caller-supplied operating-statement rental income. Σ short of the
 *       stated total ⇒ rows were dropped ⇒ FLAG incomplete.
 *   (b) TENANT-COUNT SANITY. If the roll states "N tenants / N leases" and the
 *       LLM returns materially fewer ⇒ FLAG incomplete.
 *   (c) A partial / UNRECONCILED roll → `reconciled === false`. The consumer
 *       side (rollover applicability, income-concentration) reads this flag and
 *       keeps those dimensions EXCLUDED — never scores concentration on an
 *       incomplete roll. Only a RECONCILED roll (reconciled === true) is trusted
 *       to populate them.
 *
 * ★ CITE-OR-DISCARD. Every tenant's base rent must cite a verbatim row/cell that
 * literally appears in the doc text (whitespace-normalized). A tenant whose rent
 * is not grounded in the doc is DROPPED (never an invented lease). null-not-
 * fabricate: an unread field (lease date, SF) stays null.
 *
 * FAIL-SAFE. No credits / LLM error / malformed output ⇒ rentRoll null +
 * reconciled false ⇒ the caller stays on today's behavior (the deterministic
 * read, and concentration/rollover excluded). NEVER crashes, NEVER fabricates.
 */

import {
  type ISODateTime,
  type RentRoll,
  type RentRollLine,
  type RentRollSource,
  type TenantStatus,
} from '@cre/contracts';
import { computeRentRollId } from '../util/content-hash.js';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { env } from '../config/env.js';

/** Bump when the prompt / schema / normalization / guard tolerances change — it
 *  participates in the cache key so a bump cleanly re-extracts (no stale reads). */
export const RENT_ROLL_LLM_VERSION = '1.0.0';

/** Cap the LLM's view of the doc (matches the 80K ceiling the sibling fallbacks
 *  use). A dense 7-page roll fits comfortably. */
const MAX_LLM_TEXT_CHARS = 80_000;

/** Model — Sonnet for the highest-stakes read (a dropped anchor tenant mis-prices
 *  the whole deal; accuracy > pennies). Overridable for tests / future bumps. */
export const RENT_ROLL_LLM_MODEL: string =
  process.env['RENT_ROLL_LLM_MODEL'] ?? CLAUDE_MODEL;

/**
 * RECONCILIATION TOLERANCE. Σ extracted rents must land within ±5% of the
 * stated total to count as reconciled. The 5% band absorbs benign gaps: a roll's
 * stated grand-total may fold in a handful of $0 non-tenant / antenna / riser
 * lines that carry no `TENANT TOTAL`, or recovery lines counted differently in
 * the header total vs the per-tenant blocks. Beyond 5% the gap is structural
 * (a dropped anchor tenant is tens of percent) → incomplete.
 */
export const RECONCILE_TOLERANCE = 0.05 as const;

/**
 * TENANT-COUNT SANITY FLOOR. When the roll states a tenant/lease count, the LLM
 * must return at least (statedCount × this) tenants. 0.85 means "no more than
 * ~15% of the stated rows may be missing on count" — a coarser backstop than the
 * dollar reconciliation (which is the primary completeness proof), catching the
 * case where the stated total is itself absent/unparsed.
 */
export const TENANT_COUNT_FLOOR = 0.85 as const;

/* --------------------------- injectable LLM seam --------------------------- */

/** Mirrors `callAIWithContinuation`'s option shape; a proof passes a stub. */
export type RentRollLlmCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

/* ----------------------------- injectable cache ---------------------------- */

/** Extract-once-per-doc-version cache. Keyed by (docHash + extractorVersion). */
export interface RentRollLlmCache {
  get(docHash: string, extractorVersion: string): RentRollLlmResult | null;
  put(docHash: string, extractorVersion: string, result: RentRollLlmResult): void;
}

/** A trivial in-memory cache for proofs / single-process use. */
export class InMemoryRentRollLlmCache implements RentRollLlmCache {
  private readonly store = new Map<string, RentRollLlmResult>();
  get(docHash: string, v: string): RentRollLlmResult | null {
    return this.store.get(`${docHash}::${v}`) ?? null;
  }
  put(docHash: string, v: string, result: RentRollLlmResult): void {
    this.store.set(`${docHash}::${v}`, result);
  }
}

/* -------------------------------- result shape ----------------------------- */

/** Per-tenant provenance: cited quote for the rent + whether it verified present. */
export interface RentRollTenantTrace {
  readonly tenantName: string | null;
  readonly baseRentAnnual: number | null;
  readonly sourceQuote: string | null;
  readonly cited: boolean;
}

/**
 * The completeness verdict — the rent-roll analog of the NOI cross-check. This
 * is the load-bearing output: a consumer reads `reconciled` and only populates
 * concentration/rollover when it is true.
 */
export interface RentRollCompleteness {
  /** Σ extracted per-tenant annual base rents (cited tenants only). */
  readonly extractedTotalAnnualRent: number;
  /** The roll's OWN stated grand-total rent (Vornado BLDG.TOTAL / grand total),
   *  when the LLM cited one and it verified present; else null. */
  readonly statedTotalAnnualRent: number | null;
  /** An external rental-income figure (operating statement) the caller passed to
   *  reconcile against when the roll states no total; else null. */
  readonly operatingStatementRentalIncome: number | null;
  /** The figure Σ was actually reconciled against (statedTotal ?? opStmt), or null. */
  readonly reconciledAgainst: number | null;
  /** |Σ − reconciledAgainst| / reconciledAgainst, or null when no anchor exists. */
  readonly relativeGap: number | null;
  /** The roll's stated tenant/lease count, when present; else null. */
  readonly statedTenantCount: number | null;
  /** How many cited tenants the LLM returned. */
  readonly extractedTenantCount: number;
  /**
   * ★ TRUE only when the roll is proven WHOLE:
   *   - a reconciliation anchor exists (stated total OR op-stmt income), AND
   *   - relativeGap ≤ RECONCILE_TOLERANCE, AND
   *   - (if a tenant count is stated) extracted ≥ stated × TENANT_COUNT_FLOOR.
   * FALSE otherwise — no anchor (can't prove completeness), Σ short (rows
   * dropped), or too few tenants. A false verdict keeps rollover / concentration
   * EXCLUDED downstream. Absence of proof is NOT completeness.
   */
  readonly reconciled: boolean;
}

export interface RentRollLlmResult {
  /** The extracted rent roll (all cited tenants), or null when the LLM produced
   *  nothing citeable / credits were out / the call failed. */
  readonly rentRoll: RentRoll | null;
  /** The completeness verdict. On a null rentRoll this is the empty/unreconciled
   *  shape (reconciled=false) so a consumer can uniformly gate on it. */
  readonly completeness: RentRollCompleteness;
  /** Per-tenant citation traces (observability / audit). */
  readonly traces: readonly RentRollTenantTrace[];
  /** Warnings surfaced into the memo's Data Quality channel. */
  readonly warnings: readonly string[];
  /** True when this result came from the cache (no LLM call this invocation). */
  readonly fromCache: boolean;
  /** True when a live LLM call was made this invocation (false on cache hit,
   *  no-credits skip, or fail-safe). Lets the harness assert $0 on cache hit. */
  readonly llmCalled: boolean;
}

const EMPTY_COMPLETENESS: RentRollCompleteness = {
  extractedTotalAnnualRent: 0,
  statedTotalAnnualRent: null,
  operatingStatementRentalIncome: null,
  reconciledAgainst: null,
  relativeGap: null,
  statedTenantCount: null,
  extractedTenantCount: 0,
  reconciled: false,
};

const EMPTY: Omit<RentRollLlmResult, 'fromCache' | 'llmCalled'> = {
  rentRoll: null,
  completeness: EMPTY_COMPLETENESS,
  traces: [],
  warnings: [],
};

/* -------------------------------- credit gate ------------------------------ */

/** True only when an API key is present. When false the LLM call is skipped
 *  ENTIRELY (no request, no cost). Injectable-overridable via the deps. */
export function rentRollCreditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/* --------------------------------- prompt ---------------------------------- */

const SYSTEM_PROMPT = [
  'You are a commercial-real-estate credit analyst extracting a COMPLETE RENT',
  'ROLL from a document. The roll may be any format — a clean grid, a broker',
  'roll, or a DENSE proprietary mainframe report such as a Vornado',
  '"ANNULREP / ANNUALIZED TENANT RENT ROLL" where a SINGLE tenant spans a',
  'MULTI-LINE BLOCK: a base-rent line, then R/E-tax-escalation / CAM / recovery',
  'lines, then a scheduled rent-step ladder, terminated by a "TENANT TOTAL:" or',
  '"AREA TOTAL:" line. You read the WHOLE document and understand it.',
  '',
  '★ COMPLETENESS IS THE POINT. Return EVERY tenant on the roll — do NOT stop',
  'early, do NOT summarize, do NOT skip small tenants or vacant suites, do NOT',
  'skip the LARGEST tenant (anchor / retail flagship). A dropped tenant silently',
  'mis-prices the deal. Work top-to-bottom through the WHOLE document, page by',
  'page, and emit one row for EACH tenant you pass.',
  '',
  '★ VORNADO ANNULREP SPECIFICS (this exact format):',
  '- Each tenant is a numbered block ("0104A Victoria\'s Secret", "0113A Dyson",',
  '  ...). The block ends with a "TENANT TOTAL:" line: `TENANT TOTAL: <SF> <ANNUAL$>`.',
  '  Use that ANNUAL$ as the tenant\'s baseRentAnnual and quote the TENANT TOTAL line.',
  '- A tenant may ALSO print an "AREA TOTAL:" line (a per-suite subtotal). When a',
  '  block has BOTH, use the "TENANT TOTAL:" line (the tenant roll-up) and IGNORE',
  '  the "AREA TOTAL:" — do NOT emit two rows for one tenant (that double-counts).',
  '- The FIRST big block is "0104A Victoria\'s Secret" with TENANT TOTAL',
  '  "63,779 38,639,370.58" — this is the ~$38.6M anchor; it MUST be returned.',
  '- The grand total is the "B L D G . T O T A L" section near the end: the line',
  '  "314,500 74,585,643.50 237.16" is the building-wide annual total. Return that',
  '  74,585,643.50 as statedTotalAnnualRent with that line as its sourceQuote.',
  '',
  'Return ONLY a single JSON object of the exact shape below. No prose, no',
  'markdown, no code fences.',
  '',
  'CRITICAL RULES:',
  '- Every tenant\'s baseRentAnnual MUST carry a "sourceQuote": a SHORT verbatim',
  '  string copied EXACTLY from the document that states that tenant\'s rent (the',
  '  "TENANT TOTAL:" line, or the base-rent line). If you cannot find a verbatim',
  '  quote, set the tenant\'s baseRentAnnual AND sourceQuote to null (still emit',
  '  the tenant row so the count is honest). NEVER invent a number.',
  '- Missing / uncertain field on a tenant -> null (never 0 as a placeholder,',
  '  EXCEPT a genuinely vacant suite whose stated rent is 0.00 -> 0).',
  '- baseRentAnnual is the ANNUAL all-in rent (annualize monthly figures ×12).',
  '- leaseStart / leaseEnd: ISO dates (YYYY-MM-DD) when stated; null otherwise.',
  '  "MO-TO-MO" / month-to-month -> leaseEnd null. Do NOT invent a date.',
  '',
  '★ STATED TOTALS (for the completeness cross-check — copy them verbatim):',
  '- statedTotalAnnualRent: the roll\'s OWN grand-total annual rent line, if the',
  '  document prints one (e.g. Vornado "BLDG. TOTAL" / "OCCUPIED" grand total, or',
  '  a "Total" row summing all tenants). Return the number AND its sourceQuote.',
  '  Null if the roll prints no grand total.',
  '- statedTenantCount: the number of tenants/leases the roll states in a header',
  '  or summary ("N tenants", "N leases"), if any. Null if not stated.',
].join('\n');

function buildUserPrompt(text: string, propertyHint: string | null): string {
  return [
    'Extract the COMPLETE rent roll from this document. Return STRICT JSON of',
    'EXACTLY this shape:',
    '{',
    '  "propertyName":           { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "asOfDate":               { "value": <string|null>, "sourceQuote": <string|null> },',
    '  "statedTotalAnnualRent":  { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "statedTenantCount":      { "value": <number|null>, "sourceQuote": <string|null> },',
    '  "tenants": [',
    '    {',
    '      "tenantName":     <string|null>,',
    '      "suite":          <string|null>,',
    '      "squareFeet":     <number|null>,',
    '      "baseRentAnnual": <number|null>,',
    '      "sourceQuote":    <string|null>,',
    '      "leaseStart":     <string|null>,',
    '      "leaseEnd":       <string|null>,',
    '      "status":         "OCCUPIED"|"VACANT"|"PRELEASED"|"HOLDOVER"|"UNKNOWN"',
    '    }',
    '    // ... one entry PER TENANT — every tenant on the roll, none skipped',
    '  ]',
    '}',
    propertyHint ? `\nProperty (hint only): ${propertyHint}` : '',
    '',
    '--- DOCUMENT TEXT ---',
    text,
  ].filter(Boolean).join('\n');
}

/* ------------------------------- normalizers ------------------------------- */

const STATUS_VALUES: ReadonlySet<TenantStatus> = new Set([
  'OCCUPIED', 'VACANT', 'PRELEASED', 'HOLDOVER', 'UNKNOWN',
]);

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return null;
    if (/^(n\/?a|nap|none|null|undefined|tbd|not\s*provided)$/i.test(s)) return null;
    const cleaned = s.replace(/[$,\s]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return null;
  if (/^(n\/?a|none|null|undefined|not\s*provided)$/i.test(t)) return null;
  return t;
}

function toIsoDate(v: unknown): string | null {
  const s = toString(v);
  if (s === null) return null;
  if (/mo-?to-?mo|month.?to.?month|mtm/i.test(s)) return null;
  // Accept YYYY-MM-DD directly.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const y = m[1]!, mo = m[2]!.padStart(2, '0'), d = m[3]!.padStart(2, '0');
    return `${y}-${mo}-${d}T00:00:00.000Z`;
  }
  // Accept MM/DD/YY or MM/DD/YYYY (Vornado prints MM/DD/YY).
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    let y = Number(m[3]);
    if (m[3]!.length === 2) y += y < 70 ? 2000 : 1900;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  }
  return null;
}

function toStatus(v: unknown): TenantStatus {
  if (typeof v !== 'string') return 'UNKNOWN';
  const u = v.trim().toUpperCase();
  return STATUS_VALUES.has(u as TenantStatus) ? (u as TenantStatus) : 'UNKNOWN';
}

/* ----------------------------- cite-or-discard ----------------------------- */

/** Normalize whitespace for the presence check (PDF extraction collapses /
 *  re-flows whitespace; a quote should match modulo whitespace). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * ★ CITE-OR-DISCARD (dollar-in-quote variant). A rent is trusted only when its
 * cited quote (a) literally appears in the doc AND (b) contains the numeric value
 * (modulo thousands separators / cents). This pins each tenant's rent to the
 * actual row that states it — a present-but-unrelated quote, or a fabricated
 * number, is discarded → null.
 */
function citeRent(
  rawValue: unknown,
  rawQuote: unknown,
  normalizedDoc: string,
): { value: number | null; quote: string | null; cited: boolean } {
  const value = toNumber(rawValue);
  const quote = typeof rawQuote === 'string' ? rawQuote.trim() : '';
  if (value === null) return { value: null, quote: quote.length > 0 ? quote : null, cited: false };
  if (quote.length === 0) return { value: null, quote: null, cited: false };
  // (a) the quote must literally appear in the doc (whitespace-normalized).
  const quoteInDoc = normalizedDoc.includes(normalizeWs(quote));
  // (b) the number must appear IN the cited quote — pins the value to the row
  //     that states it (a present-but-unrelated quote is discarded). Compare on
  //     digit streams so thousands-separators and cents don't defeat the match:
  //     the value's INTEGER-PART digits must be a substring of the quote's digit
  //     stream. e.g. value 38639370.58 → "38639370" ⊂ "3863937058" (from the
  //     quote "TENANT TOTAL: 63,779 38,639,370.58"). A fabricated number whose
  //     digits are absent from its own cited quote is discarded.
  const quoteDigits = quote.replace(/[^0-9]/g, '');
  const intDigits = String(Math.trunc(Math.abs(value)));
  const numberInQuote = value === 0 || quoteDigits.includes(intDigits);
  const cited = quoteInDoc && numberInQuote;
  if (!cited) return { value: null, quote: quote.length > 0 ? quote : null, cited: false };
  return { value, quote, cited: true };
}

/** Cite a stated-total figure: quote present in doc AND the number in the quote. */
function citeTotal(
  rawValue: unknown,
  rawQuote: unknown,
  normalizedDoc: string,
): number | null {
  const r = citeRent(rawValue, rawQuote, normalizedDoc);
  return r.cited ? r.value : null;
}

/* --------------------------------- parser ---------------------------------- */

function fieldOf(o: Record<string, unknown>, key: string): { value: unknown; sourceQuote: unknown } {
  const f = o[key];
  if (f !== null && typeof f === 'object') {
    const r = f as Record<string, unknown>;
    return { value: r['value'], sourceQuote: r['sourceQuote'] };
  }
  return { value: f, sourceQuote: null };
}

/**
 * Pure parser over the raw LLM text + the doc text. Exported so proofs exercise
 * the full safeguard chain (parse + cite-or-discard + completeness guard)
 * deterministically off a recorded/fixture string with no live call.
 *
 * `operatingStatementRentalIncome` — optional external anchor: when the roll
 * prints no grand total, the caller may pass the operating statement's rental
 * income to reconcile against (the recon's "reconcile to OS rental income" path).
 */
export function parseRentRollLlmResponse(
  responseText: string,
  docText: string,
  source: RentRollSource,
  operatingStatementRentalIncome: number | null = null,
): Omit<RentRollLlmResult, 'fromCache' | 'llmCalled'> {
  let parsed: unknown;
  try {
    parsed = extractJSON(responseText);
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY;
  const o = parsed as Record<string, unknown>;

  const normalizedDoc = normalizeWs(docText);

  const traces: RentRollTenantTrace[] = [];
  const warnings: string[] = [];

  const tenantsRaw = Array.isArray(o['tenants']) ? (o['tenants'] as unknown[]) : [];

  const lines: RentRollLine[] = [];
  let extractedTotalAnnualRent = 0;
  let citedTenantCount = 0;
  // ★ DOUBLE-COUNT GUARD. Vornado prints an "AREA TOTAL:" per-suite subtotal
  // alongside a "TENANT TOTAL:" roll-up for the SAME tenant; if the LLM emits
  // both as separate rows, the tenant's rent is counted twice. Dedup on the
  // (rounded rent, SF) pair — an exact repeat of a same-tenant subtotal is the
  // AREA/TENANT overlap, not a second real tenant. Distinct tenants with an
  // identical rent to the dollar AND identical SF are vanishingly unlikely.
  const seenRentSf = new Set<string>();

  for (const raw of tenantsRaw) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const tenantName = toString(r['tenantName']);
    const sf = toNumber(r['squareFeet']);
    const cite = citeRent(r['baseRentAnnual'], r['sourceQuote'], normalizedDoc);

    // Drop rows with no identity at all — an AI hallucination signal.
    if (tenantName === null && sf === null && cite.value === null) continue;

    // Double-count guard: a repeated (rent, SF) with positive rent → skip.
    if (cite.value !== null && cite.value > 0) {
      const key = `${Math.round(cite.value)}|${sf ?? '?'}`;
      if (seenRentSf.has(key)) {
        warnings.push(
          `Rent-roll LLM: dropped a duplicate row (rent $${Math.round(cite.value).toLocaleString()}, `
          + `SF ${sf ?? '?'}) — likely an AREA TOTAL / TENANT TOTAL overlap for the same tenant.`,
        );
        continue;
      }
      seenRentSf.add(key);
    }

    traces.push({
      tenantName,
      baseRentAnnual: cite.value,
      sourceQuote: cite.quote,
      cited: cite.cited,
    });

    if (cite.value !== null) {
      extractedTotalAnnualRent += cite.value;
      if (cite.value > 0) citedTenantCount++;
    }

    lines.push({
      kind: 'tenant',
      tenantName,
      suite: toString(r['suite']),
      squareFeet: sf,
      status: toStatus(r['status']),
      leaseStart: toIsoDate(r['leaseStart']) as ISODateTime | null,
      leaseEnd: toIsoDate(r['leaseEnd']) as ISODateTime | null,
      inPlaceRentAnnual: cite.value,
      marketRentAnnual: null,
      leaseType: 'UNKNOWN',
      recoveriesAnnual: null,
      otherIncomeAnnual: null,
      newTiPsf: null,
      renewTiPsf: null,
      newLcPct: null,
      renewLcPct: null,
      downtimeMonths: null,
      notes: null,
    });
  }

  // No usable tenant with a cited rent → null (caller stays on today's floor).
  if (lines.length === 0) {
    return { ...EMPTY, traces, warnings };
  }

  // ---- Stated totals (cited) ----
  const statedTotalField = fieldOf(o, 'statedTotalAnnualRent');
  const statedTotal = citeTotal(statedTotalField.value, statedTotalField.sourceQuote, normalizedDoc);
  const statedCountField = fieldOf(o, 'statedTenantCount');
  const statedTenantCount = toNumber(statedCountField.value);

  // ---- THE COMPLETENESS GUARD ----
  const completeness = evaluateCompleteness({
    extractedTotalAnnualRent,
    statedTotalAnnualRent: statedTotal,
    operatingStatementRentalIncome,
    statedTenantCount,
    extractedTenantCount: citedTenantCount,
    warnings,
  });

  const propertyName = toString(fieldOf(o, 'propertyName').value);
  const asOfDate = toIsoDate(fieldOf(o, 'asOfDate').value);

  const body = { asOfDate, propertyName, source, lines };
  const rentRoll: RentRoll = { id: computeRentRollId(body), ...body };

  return { rentRoll, completeness, traces, warnings };
}

/**
 * ★★ THE COMPLETENESS GUARD — pure. Reconciles Σ extracted rents to the roll's
 * stated total (preferred) or an operating-statement rental income, and checks
 * the tenant count. Exported so the guard logic is directly unit-testable off a
 * hand-built input (the truncation proof drives it with a deliberately short Σ).
 */
export function evaluateCompleteness(args: {
  readonly extractedTotalAnnualRent: number;
  readonly statedTotalAnnualRent: number | null;
  readonly operatingStatementRentalIncome: number | null;
  readonly statedTenantCount: number | null;
  readonly extractedTenantCount: number;
  /** Warnings sink (mutated). */
  readonly warnings: string[];
}): RentRollCompleteness {
  const {
    extractedTotalAnnualRent, statedTotalAnnualRent,
    operatingStatementRentalIncome, statedTenantCount, extractedTenantCount, warnings,
  } = args;

  // Prefer the roll's own stated grand total; fall back to the operating
  // statement's rental income when the roll prints none.
  const reconciledAgainst =
    statedTotalAnnualRent !== null && statedTotalAnnualRent > 0
      ? statedTotalAnnualRent
      : (operatingStatementRentalIncome !== null && operatingStatementRentalIncome > 0
          ? operatingStatementRentalIncome
          : null);

  const relativeGap =
    reconciledAgainst !== null
      ? Math.abs(extractedTotalAnnualRent - reconciledAgainst) / reconciledAgainst
      : null;

  // (a) DOLLAR RECONCILIATION — the primary completeness proof.
  const dollarReconciled = relativeGap !== null && relativeGap <= RECONCILE_TOLERANCE;

  // (b) TENANT-COUNT SANITY — a coarser backstop.
  let countOk = true;
  if (statedTenantCount !== null && statedTenantCount > 0) {
    countOk = extractedTenantCount >= Math.floor(statedTenantCount * TENANT_COUNT_FLOOR);
  }

  const reconciled = dollarReconciled && countOk;

  if (reconciledAgainst === null) {
    warnings.push(
      'Rent-roll completeness: NO reconciliation anchor (roll prints no stated total and no '
      + 'operating-statement rental income supplied) — cannot PROVE the roll is complete. '
      + 'Concentration / rollover stay EXCLUDED (absence of proof is not completeness).',
    );
  } else if (!dollarReconciled) {
    warnings.push(
      `Rent-roll completeness: Σ extracted rent $${Math.round(extractedTotalAnnualRent).toLocaleString()} `
      + `does NOT reconcile to the stated total $${Math.round(reconciledAgainst).toLocaleString()} `
      + `(gap ${((relativeGap ?? 0) * 100).toFixed(1)}% > ${(RECONCILE_TOLERANCE * 100).toFixed(0)}% tolerance) `
      + `— rows appear DROPPED. Roll is INCOMPLETE; concentration / rollover EXCLUDED.`,
    );
  }
  if (!countOk && statedTenantCount !== null) {
    warnings.push(
      `Rent-roll completeness: extracted ${extractedTenantCount} paying tenants vs stated `
      + `${statedTenantCount} (below ${(TENANT_COUNT_FLOOR * 100).toFixed(0)}% floor) — tenants appear missing. `
      + `Roll is INCOMPLETE; concentration / rollover EXCLUDED.`,
    );
  }

  return {
    extractedTotalAnnualRent,
    statedTotalAnnualRent,
    operatingStatementRentalIncome,
    reconciledAgainst,
    relativeGap,
    statedTenantCount,
    extractedTenantCount,
    reconciled,
  };
}

/* --------------------------------- runner ---------------------------------- */

export interface ExtractRentRollLlmDeps {
  /** Injectable LLM seam. Defaults to the real Anthropic call. */
  readonly llmCall?: RentRollLlmCall;
  /** Injectable credit gate. Defaults to the env-key check. */
  readonly creditsAvailable?: () => boolean;
  /** Injectable cache. Omit to run without caching. */
  readonly cache?: RentRollLlmCache;
  /** Extractor version participating in the cache key. Defaults to the module
   *  version; override in tests to prove version-busting. */
  readonly extractorVersion?: string;
  /** Optional property hint threaded into the prompt. */
  readonly propertyHint?: string | null;
  /** Optional operating-statement rental income to reconcile against when the
   *  roll prints no grand total. */
  readonly operatingStatementRentalIncome?: number | null;
}

/**
 * LLM-PRIMARY rent-roll extraction over the FULL document text, with the
 * completeness guard applied.
 *
 * @param docText   the full rent-roll rawText (all pages).
 * @param docHash   content hash of the doc bytes (cache key half).
 * @param source    provenance stamp for the RentRoll ('asr_table' etc.).
 * @param deps      injectable LLM seam / credit gate / cache / version / hints.
 *
 * Order of operations (identical spine to the sibling fallbacks):
 *   1. CACHE hit → return it ($0, deterministic).
 *   2. CREDIT GATE — no credits → EMPTY (all null, reconciled=false) WITHOUT
 *      calling. Consumer stays on today's behavior.
 *   3. LLM CALL (temp 0) → parse → cite-or-discard → completeness guard.
 *   4. FAIL-SAFE — any throw ⇒ EMPTY. Never crashes, never fabricates.
 *   5. STORE the fresh result in the cache.
 */
export async function extractRentRollFromDocumentLlm(
  docText: string,
  docHash: string,
  source: RentRollSource,
  deps: ExtractRentRollLlmDeps = {},
): Promise<RentRollLlmResult> {
  const version = deps.extractorVersion ?? RENT_ROLL_LLM_VERSION;
  const llmCall = deps.llmCall ?? callAIWithContinuation;
  const hasCredits = deps.creditsAvailable ?? rentRollCreditsAvailable;
  const cache = deps.cache;
  const osRent = deps.operatingStatementRentalIncome ?? null;

  const empty = (): RentRollLlmResult => ({ ...EMPTY, fromCache: false, llmCalled: false });

  if (typeof docText !== 'string' || docText.trim().length === 0) return empty();

  // (1) CACHE — extract-once-per-doc-version.
  if (cache) {
    const hit = cache.get(docHash, version);
    if (hit) return { ...hit, fromCache: true, llmCalled: false };
  }

  // (2) CREDIT GATE — no key/credits ⇒ skip the call entirely.
  if (!hasCredits()) return empty();

  // (3) LLM CALL — temp 0, structured, generous output budget (a dense roll can
  //     have many tenants × several fields). Fail-safe on any throw.
  let raw: string;
  try {
    raw = await llmCall({
      model: RENT_ROLL_LLM_MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(docText.slice(0, MAX_LLM_TEXT_CHARS), deps.propertyHint ?? null) }],
      temperature: 0,
    });
  } catch (err) {
    // FAIL-SAFE — LLM error / timeout / network → EMPTY → consumer stays on floor.
    // eslint-disable-next-line no-console
    console.warn('[AI:RentRoll-LLM] extraction call failed:', err);
    return empty();
  }

  const parsed = parseRentRollLlmResponse(raw, docText, source, osRent);
  const result: RentRollLlmResult = { ...parsed, fromCache: false, llmCalled: true };

  // (5) STORE — freeze the answer so the next underwrite is $0 + deterministic.
  if (cache) cache.put(docHash, version, result);

  return result;
}

/**
 * extractCashFlowFromXlsxLlm — LLM-primary FALLBACK for the operating-statement
 * (cash-flow) workbook, mirroring the proven loan-terms LLM fallback
 * (`extract-asr-loan-terms-llm.ts`, P1/A `56c3988`/`5d9c250`) on the INCOME side.
 *
 * WHY THIS EXISTS. The deterministic `extractCashFlowFromXlsx`
 * (`extract-cash-flow-from-xlsx.ts`) is tuned to Morgan-Stanley / Goldman
 * CMBS CF layouts: a period-header row that reads `In-Place | T-12 | GS U/W`
 * and clean text line labels (`Net Operating Income`, `Real Estate Taxes`). It
 * hard-fails to NULL on a different issuer's format. The 640 Fifth Ave operating
 * statements are a Yardi/MRI GL "Cash Flow Report EBITDA" export whose period
 * header reads `YEAR TO DATE / 12/31/2023` and whose detail lines are raw GL
 * account numbers (`501000-0001-…`, `545200-0001-…`) with only truncated Yardi
 * totals as text (`TOTAL Gross Pote…`, `TOTAL Real Estat…`) and NO
 * `Net Operating Income` row at all. `findPeriodHeaderRow` matches none of its
 * PERIOD_PATTERNS and `findLabelColumn` finds < 3 recognizable labels → the
 * deterministic parser returns null across all three slots (`t12Actual`,
 * `inPlace`, `sellerUwOperatingStatement`) → the spine NOI collapses onto a
 * rent-roll-only stub ($8.3M / 2% DY on 640 — a 6.8× understatement).
 *
 * This module de-anchors that failure: when the deterministic path returns null
 * (Yardi/MRI/novel workbook), we convert the PARSED xlsx cells → a text/CSV grid
 * and have the LLM read it into a structured operating statement (EGI/revenue,
 * OpEx, NOI + per-line cited cell-ref). Robust to GL-export layouts, not just the
 * MS/Goldman column shape.
 *
 * COMPOSITION, not greenfield. This is the exact union of the two proven patterns
 * the loan-terms fallback already ships:
 *   - full-input read, `callAIWithContinuation` on CLAUDE_MODEL, STRICT-JSON-nulls
 *     discipline, tolerant `extractJSON` parse, all-null → null.
 *   - the GOVERNANCE armor: `creditsAvailable()` credit-gate (no key ⇒ skip the
 *     call, $0), temperature 0 (greedy / replay-stable), an INJECTABLE LLM seam so
 *     proofs pass a deterministic stub, CACHING (docHash+version), and a
 *     discard-what-you-can't-verify guard — here CITE-OR-DISCARD against the grid.
 *
 * ★ DETERMINISM SAFEGUARDS (this feeds the ENGINE's NOI; an LLM can be confidently
 * wrong):
 *   (a) temperature 0 + STRICT JSON schema + "null when unsure".
 *   (b) CITE-OR-DISCARD — every extracted dollar carries a `sourceCell` (an A1-style
 *       cell reference like "F18" or the verbatim row label) and the caller verifies
 *       the cited value literally appears in the grid at (or as) that reference. An
 *       un-verifiable value is DISCARDED → null. No fabricated income reaches the
 *       engine.
 *   (c) null-not-fabricate — every field independently returns null when absent; a
 *       genuinely unreadable statement → null → the engine refuses (today's honest
 *       floor). NEVER invent an NOI.
 *   (d) ARITHMETIC CONSISTENCY (income-side analog of whole-vs-piece) — when EGI,
 *       OpEx, and NOI are ALL cited we verify EGI − OpEx ≈ NOI (1% tolerance). A
 *       gross mismatch is a data-quality warning (the numbers don't reconcile);
 *       the cited NOI still governs (it's the value the workbook states) but the
 *       divergence is surfaced.
 *   (e) CACHING — keyed by (docHash + extractorVersion). Extract ONCE per
 *       doc-version; a re-underwrite reads the STORED result ($0, byte-stable).
 *       Injectable seam (SQLite in prod, in-memory map in proofs).
 *
 * FAIL-SAFE. No credits / LLM error / malformed output ⇒ all-null ⇒ the engine
 * refuses (today's honest floor). NEVER crashes, NEVER fabricates.
 */

import ExcelJS from 'exceljs';
import type { OperatingStatementExtraction } from '@cre/contracts';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { CLAUDE_MODEL } from '../config/llm-model.js';
import { env } from '../config/env.js';

/** Bump when the prompt / schema / normalization / grid rendering changes — it
 *  participates in the cache key so a bump cleanly re-extracts (no stale reads). */
export const CF_LLM_VERSION = '1.0.0';

/** Cap the LLM's view of the grid (matches the loan-terms 80K ceiling). Operating
 *  statements are small; the whole grid fits comfortably. */
const MAX_LLM_TEXT_CHARS = 80_000;

/** Model — Sonnet for the highest-stakes numbers (accuracy > pennies). */
export const CF_LLM_MODEL: string = process.env['CF_LLM_MODEL'] ?? CLAUDE_MODEL;

/* --------------------------- injectable LLM seam --------------------------- */

/** Mirrors `callAIWithContinuation`'s option shape; a proof passes a stub. */
export type CfLlmCall = (options: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}) => Promise<string>;

/* ----------------------------- injectable cache ---------------------------- */

/** Extract-once-per-doc-version cache. Keyed by (docHash + extractorVersion). */
export interface CfLlmCache {
  get(docHash: string, extractorVersion: string): CfLlmResult | null;
  put(docHash: string, extractorVersion: string, result: CfLlmResult): void;
}

/** A trivial in-memory cache for proofs / single-process use. */
export class InMemoryCfLlmCache implements CfLlmCache {
  private readonly store = new Map<string, CfLlmResult>();
  get(docHash: string, v: string): CfLlmResult | null {
    return this.store.get(`${docHash}::${v}`) ?? null;
  }
  put(docHash: string, v: string, result: CfLlmResult): void {
    this.store.set(`${docHash}::${v}`, result);
  }
}

/* -------------------------------- result shape ----------------------------- */

/** Per-field provenance: the raw value + the cited cell/label + whether that
 *  citation was verified present in the grid (the cite-or-discard outcome). */
export interface CfFieldTrace {
  readonly field: string;
  readonly sourceCell: string | null;
  readonly cited: boolean;
}

export interface CfLlmResult {
  /** The extracted operating statement, or null when the LLM produced nothing
   *  citeable / credits were out / the call failed. */
  readonly statement: OperatingStatementExtraction | null;
  /** Which period the LLM judged this workbook to represent (t12 / in_place /
   *  seller_uw). Drives which ExtractionResult slot the adapter fills. null when
   *  the statement is null. */
  readonly periodKind: 't12Actual' | 'inPlace' | 'sellerUwOperatingStatement' | null;
  /** Per-field citation traces (observability / audit). */
  readonly traces: readonly CfFieldTrace[];
  /** Warnings surfaced into the memo's Data Quality channel. */
  readonly warnings: readonly string[];
  /** True when this result came from the cache (no LLM call this invocation). */
  readonly fromCache: boolean;
  /** True when a live LLM call was made this invocation. */
  readonly llmCalled: boolean;
}

const EMPTY: Omit<CfLlmResult, 'fromCache' | 'llmCalled'> = {
  statement: null,
  periodKind: null,
  traces: [],
  warnings: [],
};

/* -------------------------------- credit gate ------------------------------ */

/** True only when an API key is present. When false the LLM call is skipped
 *  ENTIRELY (no request, no cost). Injectable-overridable via the deps. */
export function cfCreditsAvailable(): boolean {
  return env.anthropicApiKey.trim().length > 0;
}

/* ----------------------------- grid rendering ------------------------------ */

/** One cell of the rendered grid: A1-style ref + string value. */
interface GridCell {
  readonly ref: string;
  readonly value: string;
}

/** The parsed grid we hand the LLM: the chosen sheet's non-empty cells rendered
 *  as `REF: value` lines, plus a flat lookup set of normalized "REF|value" and
 *  bare values for the cite-or-discard verification. */
interface RenderedGrid {
  readonly sheetName: string;
  readonly text: string;
  /** normalized set of every cell's value (for bare-value citation checks). */
  readonly valueSet: ReadonlySet<string>;
  /** map from normalized A1 ref → normalized cell value (for ref citation checks). */
  readonly refToValue: ReadonlyMap<string, string>;
}

function colLetter(col: number): string {
  let s = '';
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Read a cell's display string, unwrapping ExcelJS rich-text / formula-result
 *  shapes (identical semantics to the deterministic extractor's `cellString`). */
function cellDisplay(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('').trim() || null;
  }
  if (typeof v === 'object' && 'text' in v) {
    const t = (v as { text: unknown }).text;
    return typeof t === 'string' ? t.trim() || null : null;
  }
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'string') return r.trim() || null;
    if (typeof r === 'number' && Number.isFinite(r)) return String(r);
  }
  return null;
}

/** Normalize a value for citation comparison: numbers compared modulo
 *  thousands-separators / currency / parentheses-negatives; text lower-cased +
 *  whitespace-collapsed. */
function normalizeCiteValue(s: string): string {
  const t = s.trim();
  // numeric normalization
  const numCleaned = t.replace(/[$,\s]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
  const n = Number(numCleaned);
  if (numCleaned !== '' && Number.isFinite(n)) return String(n);
  return t.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Render a workbook into the grid we hand the LLM. Pick the sheet with the most
 * non-empty cells (the operating statement; Yardi exports put everything on one
 * data sheet). Emit up to `maxRows` rows of `REF: value` lines and build the
 * verification lookups. Bounded so a giant workbook can't blow the token budget.
 */
function renderWorkbook(wb: ExcelJS.Workbook, maxRows = 260): RenderedGrid | null {
  let best: ExcelJS.Worksheet | null = null;
  let bestCount = -1;
  wb.eachSheet((ws) => {
    let count = 0;
    const scan = Math.min(ws.rowCount, maxRows);
    for (let r = 1; r <= scan; r++) {
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
        if (cellDisplay(cell) !== null) count++;
      });
    }
    if (count > bestCount) { bestCount = count; best = ws; }
  });
  if (best === null || bestCount <= 0) return null;
  const ws = best as ExcelJS.Worksheet;

  const lines: string[] = [];
  const valueSet = new Set<string>();
  const refToValue = new Map<string, string>();
  const scan = Math.min(ws.rowCount, maxRows);
  for (let r = 1; r <= scan; r++) {
    const parts: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const disp = cellDisplay(cell);
      if (disp === null) return;
      const ref = `${colLetter(col)}${r}`;
      parts.push(`${ref}: ${disp}`);
      const norm = normalizeCiteValue(disp);
      valueSet.add(norm);
      refToValue.set(ref.toLowerCase(), norm);
    });
    if (parts.length > 0) lines.push(parts.join('  |  '));
  }
  const text = `SHEET: ${ws.name}\n${lines.join('\n')}`.slice(0, MAX_LLM_TEXT_CHARS);
  return { sheetName: ws.name, text, valueSet, refToValue };
}

/* --------------------------------- prompt ---------------------------------- */

const SYSTEM_PROMPT = [
  'You are a commercial-real-estate credit analyst extracting an OPERATING',
  'STATEMENT (cash-flow / income statement) from a spreadsheet grid. The grid may',
  'be any issuer/software format — a CMBS seller cash flow, a Yardi/MRI GL "Cash',
  'Flow Report EBITDA" export (line labels are raw GL account numbers like',
  '"501000-0001", section totals labeled "TOTAL Gross Potential Rent"), an',
  'Argus export, etc. You read the WHOLE grid and understand it.',
  '',
  'Return ONLY a single JSON object of the exact shape below. No prose, no',
  'markdown, no code fences.',
  '',
  'CRITICAL RULES:',
  '- Every dollar value MUST be accompanied by a "sourceCell": the A1-style cell',
  '  reference (e.g. "F18") of the cell that holds that exact number in the grid.',
  '  If you cannot point to a cell that literally holds the value, set BOTH the',
  '  value AND its sourceCell to null. NEVER invent, infer, or compute a value',
  '  that is not literally present as a cell in the grid.',
  '- Prefer the SECTION TOTAL rows (e.g. "TOTAL Gross Potential Rent",',
  '  "Effective Gross Income", "Total Operating Expenses", "Net Operating',
  '  Income") over individual GL detail lines. Cite the total cell.',
  '- Missing / uncertain field -> null (never 0, "", "N/A", "TBD"). A section',
  '  that is genuinely absent from the grid is null.',
  '- Do NOT sum GL detail lines yourself to synthesize a total the grid does not',
  '  show. If only detail lines exist and no total, leave the total null.',
  '',
  'FIELDS (all dollars annual, as stated in the grid):',
  '- effectiveGrossIncome: EGI / effective gross revenue / total revenue after',
  '  vacancy. If the grid shows only "Total Scheduled Base Rent" + recoveries and',
  '  no EGI line, cite whatever single line best represents total income; else null.',
  '- grossPotentialRent: gross potential / scheduled base rent (before vacancy).',
  '- totalOperatingExpenses: total operating expenses (the expense TOTAL row).',
  '- netOperatingIncome: NOI (the "Net Operating Income" / "NOI" row). If there is',
  '  NO explicit NOI row, leave null — do NOT compute EGI - OpEx yourself.',
  '- taxes / insurance / utilities / managementFees / repairsMaintenance: the',
  '  named expense-total rows if present; else null.',
  '- vacancyLoss: the vacancy / credit loss line (a negative or positive dollar).',
  '- period: which period this statement represents. One of exactly:',
  '    "t12"        — a trailing-twelve / TTM / "YEAR TO DATE" trailing actual,',
  '    "in_place"   — an in-place / current snapshot,',
  '    "seller_uw"  — the seller/issuer UNDERWRITTEN column.',
  '  Judge from the period header text in the grid (e.g. "YEAR TO DATE",',
  '  "12/31/2023" trailing actuals -> "t12"). If unsure, use "t12".',
].join('\n');

function buildUserPrompt(gridText: string): string {
  return [
    'Extract the operating statement from this spreadsheet grid. Return STRICT',
    'JSON of EXACTLY this shape:',
    '{',
    '  "period":                  { "value": "t12"|"in_place"|"seller_uw"|null, "sourceCell": <string|null> },',
    '  "effectiveGrossIncome":    { "value": <number|null>, "sourceCell": <string|null> },',
    '  "grossPotentialRent":      { "value": <number|null>, "sourceCell": <string|null> },',
    '  "totalOperatingExpenses":  { "value": <number|null>, "sourceCell": <string|null> },',
    '  "netOperatingIncome":      { "value": <number|null>, "sourceCell": <string|null> },',
    '  "taxes":                   { "value": <number|null>, "sourceCell": <string|null> },',
    '  "insurance":               { "value": <number|null>, "sourceCell": <string|null> },',
    '  "utilities":               { "value": <number|null>, "sourceCell": <string|null> },',
    '  "managementFees":          { "value": <number|null>, "sourceCell": <string|null> },',
    '  "repairsMaintenance":      { "value": <number|null>, "sourceCell": <string|null> },',
    '  "vacancyLoss":             { "value": <number|null>, "sourceCell": <string|null> }',
    '}',
    '',
    '--- SPREADSHEET GRID (A1-style cell refs) ---',
    gridText,
  ].join('\n');
}

/* ------------------------------- normalizers ------------------------------- */

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

/* ----------------------------- cite-or-discard ----------------------------- */

/**
 * ★ CITE-OR-DISCARD (grid version). Returns the value ONLY when its cited
 * `sourceCell` verifiably holds that value in the grid. Two acceptance paths:
 *   (1) the ref maps to a cell whose value equals the extracted value, OR
 *   (2) the extracted value literally appears as SOME cell's value in the grid
 *       (tolerates the LLM naming an adjacent/label ref while the number is
 *       real and present). Path (2) still requires the number to be a real grid
 *       value — a fabricated number that appears nowhere is discarded.
 * A value present nowhere in the grid → null (fabrication guard).
 */
function citeOrDiscard(
  field: string,
  rawValue: unknown,
  rawCell: unknown,
  grid: RenderedGrid,
  traces: CfFieldTrace[],
): number | null {
  const value = toNumber(rawValue);
  const cell = typeof rawCell === 'string' ? rawCell.trim() : '';
  if (value === null) {
    traces.push({ field, sourceCell: cell.length > 0 ? cell : null, cited: false });
    return null;
  }
  const normVal = normalizeCiteValue(String(value));
  const refHit = cell.length > 0 && grid.refToValue.get(cell.toLowerCase()) === normVal;
  const valueHit = grid.valueSet.has(normVal);
  const cited = refHit || valueHit;
  traces.push({ field, sourceCell: cell.length > 0 ? cell : null, cited });
  if (!cited) return null; // value not present in grid → fabricated → discard.
  return value;
}

/* --------------------------------- parser ---------------------------------- */

function fieldOf(o: Record<string, unknown>, key: string): { value: unknown; sourceCell: unknown } {
  const f = o[key];
  if (f !== null && typeof f === 'object') {
    const r = f as Record<string, unknown>;
    return { value: r['value'], sourceCell: r['sourceCell'] };
  }
  return { value: f, sourceCell: null };
}

function toPeriodKind(v: unknown): CfLlmResult['periodKind'] {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 't12' || s === 'ttm' || s === 't-12') return 't12Actual';
  if (s === 'in_place' || s === 'inplace' || s === 'in-place') return 'inPlace';
  if (s === 'seller_uw' || s === 'uw' || s === 'seller' || s === 'issuer_uw') return 'sellerUwOperatingStatement';
  return null;
}

/**
 * Pure parser over the raw LLM text + the rendered grid. Exported so proofs
 * exercise the full safeguard chain (parse + cite-or-discard + arithmetic
 * consistency) deterministically off a recorded/fixture string with no live call.
 */
export function parseCfLlmResponse(
  responseText: string,
  grid: RenderedGrid,
): Omit<CfLlmResult, 'fromCache' | 'llmCalled'> {
  let parsed: unknown;
  try {
    parsed = extractJSON(responseText);
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY;
  const o = parsed as Record<string, unknown>;

  const traces: CfFieldTrace[] = [];
  const warnings: string[] = [];

  const egi = citeOrDiscard('effectiveGrossIncome', fieldOf(o, 'effectiveGrossIncome').value, fieldOf(o, 'effectiveGrossIncome').sourceCell, grid, traces);
  const gpr = citeOrDiscard('grossPotentialRent', fieldOf(o, 'grossPotentialRent').value, fieldOf(o, 'grossPotentialRent').sourceCell, grid, traces);
  const opex = citeOrDiscard('totalOperatingExpenses', fieldOf(o, 'totalOperatingExpenses').value, fieldOf(o, 'totalOperatingExpenses').sourceCell, grid, traces);
  const noi = citeOrDiscard('netOperatingIncome', fieldOf(o, 'netOperatingIncome').value, fieldOf(o, 'netOperatingIncome').sourceCell, grid, traces);
  const taxes = citeOrDiscard('taxes', fieldOf(o, 'taxes').value, fieldOf(o, 'taxes').sourceCell, grid, traces);
  const insurance = citeOrDiscard('insurance', fieldOf(o, 'insurance').value, fieldOf(o, 'insurance').sourceCell, grid, traces);
  const utilities = citeOrDiscard('utilities', fieldOf(o, 'utilities').value, fieldOf(o, 'utilities').sourceCell, grid, traces);
  const mgmt = citeOrDiscard('managementFees', fieldOf(o, 'managementFees').value, fieldOf(o, 'managementFees').sourceCell, grid, traces);
  const rm = citeOrDiscard('repairsMaintenance', fieldOf(o, 'repairsMaintenance').value, fieldOf(o, 'repairsMaintenance').sourceCell, grid, traces);
  const vacancy = citeOrDiscard('vacancyLoss', fieldOf(o, 'vacancyLoss').value, fieldOf(o, 'vacancyLoss').sourceCell, grid, traces);

  const periodKind = toPeriodKind(fieldOf(o, 'period').value) ?? 't12Actual';

  // ★ ARITHMETIC CONSISTENCY (income-side analog of whole-vs-piece). When EGI,
  //   OpEx, and NOI are all cited, verify EGI − OpEx ≈ NOI (1% tolerance). A
  //   gross mismatch surfaces as a data-quality warning; the cited NOI still
  //   governs (it's the value the workbook literally states).
  if (egi !== null && opex !== null && noi !== null) {
    const implied = egi - opex;
    const denom = Math.max(Math.abs(noi), 1);
    if (Math.abs(implied - noi) / denom > 0.01) {
      warnings.push(
        `CF-LLM: cited NOI ($${Math.round(noi).toLocaleString()}) does not reconcile with `
        + `cited EGI − OpEx ($${Math.round(egi).toLocaleString()} − $${Math.round(opex).toLocaleString()} = `
        + `$${Math.round(implied).toLocaleString()}) — verify the workbook; using the cited NOI.`,
      );
    }
  }

  // null-not-fabricate: a statement with NO usable income figure at all → null.
  const allNull = egi === null && gpr === null && opex === null && noi === null
    && taxes === null && insurance === null && utilities === null && mgmt === null
    && rm === null && vacancy === null;
  if (allNull) return { ...EMPTY, traces, warnings };

  const statement: OperatingStatementExtraction = {
    period: `CF-LLM ${periodKind} (grid: ${grid.sheetName})`,
    income: {
      grossPotentialRent: gpr,
      effectiveRent: null,
      otherIncome: null,
      totalIncome: egi,
      uwAdjustments: null,
    },
    expenses: {
      taxes,
      insurance,
      utilities,
      repairsMaintenance: rm,
      managementFees: mgmt,
      generalAndAdmin: null,
      janitorial: null,
      reimbursements: null,
      totalOperatingExpenses: opex,
    },
    noi,
    vacancyLoss: vacancy,
    belowNoiAdjustments: {
      replacementReserves: null,
      tenantImprovements: null,
      leasingCommissions: null,
    },
  };

  return { statement, periodKind, traces, warnings };
}

/* --------------------------------- runner ---------------------------------- */

export interface ExtractCashFlowLlmDeps {
  /** Injectable LLM seam. Defaults to the real Anthropic call. */
  readonly llmCall?: CfLlmCall;
  /** Injectable credit gate. Defaults to the env-key check. */
  readonly creditsAvailable?: () => boolean;
  /** Injectable cache. Omit to run without caching. */
  readonly cache?: CfLlmCache;
  /** Extractor version participating in the cache key. Defaults to CF_LLM_VERSION. */
  readonly extractorVersion?: string;
}

/**
 * LLM-primary operating-statement extraction over a workbook the deterministic
 * parser could not read.
 *
 * @param buffer   the xlsx bytes.
 * @param docHash  content hash of the bytes (cache key half).
 * @param deps     injectable LLM seam / credit gate / cache / version.
 *
 * Order of operations (identical spine to the loan-terms fallback):
 *   1. CACHE hit → return it ($0, deterministic).
 *   2. RENDER the grid; if the workbook is unreadable/empty → EMPTY.
 *   3. CREDIT GATE — no credits → EMPTY (no call, $0). Engine refuses.
 *   4. LLM CALL (temp 0) → parse → cite-or-discard → arithmetic check.
 *   5. FAIL-SAFE — any throw ⇒ EMPTY. Never crashes, never fabricates.
 *   6. STORE the fresh result in the cache.
 */
export async function extractCashFlowFromXlsxLlm(
  buffer: Buffer,
  docHash: string,
  deps: ExtractCashFlowLlmDeps = {},
): Promise<CfLlmResult> {
  const version = deps.extractorVersion ?? CF_LLM_VERSION;
  const llmCall = deps.llmCall ?? callAIWithContinuation;
  const hasCredits = deps.creditsAvailable ?? cfCreditsAvailable;
  const cache = deps.cache;

  const empty = (): CfLlmResult => ({ ...EMPTY, fromCache: false, llmCalled: false });

  // (1) CACHE — extract-once-per-doc-version.
  if (cache) {
    const hit = cache.get(docHash, version);
    if (hit) return { ...hit, fromCache: true, llmCalled: false };
  }

  // (2) RENDER — parse the workbook grid. A corrupt buffer / empty grid → EMPTY.
  let grid: RenderedGrid | null;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    grid = renderWorkbook(wb);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AI:CF] workbook render failed:', err);
    return empty();
  }
  if (grid === null || grid.text.trim().length === 0) return empty();

  // (3) CREDIT GATE — no key/credits ⇒ skip the call entirely.
  if (!hasCredits()) return empty();

  // (4) LLM CALL — temp 0, structured. Fail-safe on any throw.
  let raw: string;
  try {
    raw = await llmCall({
      model: CF_LLM_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(grid.text) }],
      temperature: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AI:CF] extraction call failed:', err);
    return empty();
  }

  const parsed = parseCfLlmResponse(raw, grid);
  const result: CfLlmResult = { ...parsed, fromCache: false, llmCalled: true };

  // (6) STORE — freeze the answer so the next underwrite is $0 + deterministic.
  if (cache) cache.put(docHash, version, result);

  return result;
}

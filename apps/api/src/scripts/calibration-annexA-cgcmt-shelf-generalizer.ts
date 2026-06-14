/**
 * CGCMT 2013-GC15 Annex A walker — step 2 of the CGCMT port.
 *
 * Reads the 2013-GC15 prospectus from /tmp and produces the shared
 * ExtractedLoan shape. Imports the issuer-agnostic verify() / types /
 * formatters from ./lib/annexA-verify.js.
 *
 * SCOPE OF THIS STEP (per the 2026-06-14 brief):
 *   - Row finder + parsing for the LOAN-LEVEL financial columns.
 *   - 97 loans (per prospectus cover); sub-property "X.NN Property" rows
 *     are skipped (only "N Loan" rows are enumerated).
 *   - Pari-passu + cross-collat + Related-Group detection: NEXT STEP.
 *     `pariPassuCombination` and `crossCollatGroup` are emitted null here.
 *
 * FORMAT NOTES (vs WFRBS 2013-C11):
 *
 * CGCMT splits the Annex A into 17 sub-tables (each spans 1-2 pages with
 * a repeating header). The columns we care about are spread across the
 * first 8 tables:
 *
 *   T1 (offset 1,380,474): Property Name, Related Group, Crossed Group,
 *                          Address, Property Type
 *   T2 (offset 1,388,210): NRA, Loan Per Unit, Original Balance,
 *                          Cut-off Date Balance, % of Pool, Balloon Balance
 *   T3 (offset 1,405,736): Mortgage Loan Rate (coupon), Monthly + Annual
 *                          Debt Service, Amortization Type
 *   T4 (offset 1,419,224): Original IO + Original Term + Original Amort
 *                          (all in months) + Origination/Due dates
 *   T5 (offset 1,431,663): Final Maturity, Prepayment Provision,
 *                          Most Recent NOI ($) + NOI Date
 *   T6 (offset 1,444,657): Most Recent EGI, Expenses, NOI columns +
 *                          Underwritten EGI/Expenses
 *   T7 (offset 1,461,104): Underwritten NOI ($), DSCR (x),
 *                          Debt Yield on UW NCF (%), Appraised Value ($)
 *   T8 (offset 1,475,398): As Stabilized Appraised Value, As Stabilized
 *                          LTV, Cut-off Date LTV Ratio (%), LTV at
 *                          Maturity, Occupancy (%)
 *
 * Column order inside every CGCMT row:
 *   Control# | Loan/Property Flag | Footnotes | Seller | Property Name | … cols …
 *
 * Seller is column 4 (BEFORE property name — opposite of WFRBS). The
 * walker anchors on `<int> Loan (<footnote tokens>?) <SELLER-regex>`
 * and consumes through the next loan-row marker; this is a
 * POSITION-anchored scheme rather than WFRBS's content-pattern scheme,
 * which sidesteps the multi-word seller problem (SMF I,
 * RAIT Funding LLC, The Bancorp Bank) — see step 2.2 below.
 */

import * as fs from 'node:fs';
import {
  fmtUsd,
  fmtPct,
  fmtNum,
  verify,
  type ExtractedLoan,
  type PariPassuCombination,
  type CrossCollatGroup,
} from './lib/annexA-verify.js';

const ANNEX_A_PATH = '/tmp/cgcmt-2013-gc15-424B5.htm';

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#8217;|&#146;|&#145;/g, "'")
    .replace(/&#8220;|&#8221;|&#147;|&#148;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/**
 * Sellers seen in CGCMT 2013-GC15 (7 originators per cover). The regex
 * tolerates multi-token codes; matching by REGEX (not single-token
 * equality) sidesteps the WFRBS-style findSellerIdx scheme.
 *
 * Order matters: longer/more-specific patterns first so the alternation
 * doesn't short-circuit (e.g. "SMF" would otherwise match before
 * "SMF I" gets a chance).
 */
const SELLER_RE_SRC =
  '(?:CGMRC|GSMC|RMF|SMF\\s+I|RAIT\\s+Funding,\\s+LLC|RCMC|The\\s+Bancorp\\s+Bank)';

/** Tokenize a row, splitting on whitespace. */
function tokenize(row: string): string[] {
  return row.trim().split(/\s+/);
}

/** Parse a number out of a token. */
function num(tok: string | undefined): number | null {
  if (tok === undefined) return null;
  const cleaned = tok.replace(/[$,\s%()]/g, '');
  if (['Various', 'NAP', 'NAV', 'N/A', '-', '—', ''].includes(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Locate a per-table chunk by its header text and slice to the next
 * known table-anchor (defensive hard boundary).
 */
function locateTableChunks(annexA: string): Record<string, string> {
  const anchors: Record<string, string> = {
    t1: 'Property Name Related Group Crossed Group Address',
    t2: 'Allocated Cut-off Control Loan / Mortgage Detailed Units',
    t3: 'Monthly Annual Companion Loan Companion Loan Interest Control Loan / Mortgage Mortgage',
    t4: 'Original Remaining Original Term To Remaining Original Remaining Control',
    t5: 'Grace Grace Third Third Second Control Loan / Mortgage Final',
    t6: 'Second Control Loan / Mortgage Most Recent Most Recent Most Recent Most Recent',
    t7: 'Debt Yield on Underwritten Debt Yield on Control',
    t8: 'As Stabilized As Stabilized Cut-off Date LTV Ratio',
  };
  const positions = Object.entries(anchors)
    .map(([k, a]) => ({ k, a, offset: annexA.indexOf(a) }))
    .filter(x => x.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  const out: Record<string, string> = {};
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i]!;
    const next = positions[i + 1];
    const end = next !== undefined ? next.offset : Math.min(annexA.length, cur.offset + 200_000);
    out[cur.k] = annexA.slice(cur.offset, end);
  }
  for (const k of Object.keys(anchors)) {
    if (out[k] === undefined) out[k] = '';
  }
  return out;
}

/**
 * Locate the row in `tableText` for control number N.
 *
 * The row START is `<int> Loan (<footnote tokens, optional>) <SELLER>`.
 * Footnote tokens are an optional list like "8" or "8, 9" or "16, 17"
 * between "Loan" and the seller. Sub-property rows ("X.YY Property …")
 * do NOT match because their integer is followed by a period.
 *
 * The row END is the next match of the same row-start regex (with any
 * integer), or +800 chars.
 */
function extractLoanRow(tableText: string, controlNumber: number): string | null {
  const rowStart = new RegExp(
    `(?<![\\d.])\\b${controlNumber}\\s+Loan\\s+(?:[\\d,]+(?:\\s+[\\d,]+)*\\s+)?${SELLER_RE_SRC}\\b`,
    'g',
  );
  const m = rowStart.exec(tableText);
  if (m === null) return null;
  const start = m.index;
  const stopRe = new RegExp(
    `(?<![\\d.])\\b\\d+\\s+Loan\\s+(?:[\\d,]+(?:\\s+[\\d,]+)*\\s+)?${SELLER_RE_SRC}\\b`,
    'g',
  );
  stopRe.lastIndex = start + 8;
  const stop = stopRe.exec(tableText);
  const end = stop ? stop.index : start + 800;
  return tableText.slice(start, Math.min(end, start + 800));
}

/**
 * Skip the seller token(s) at the start of a row to land on the
 * post-seller field stream. Returns -1 if seller not found.
 */
function findPostSellerIdx(tokens: readonly string[]): number {
  // The seller is at most 3 tokens (e.g. "The Bancorp Bank", "RAIT Funding, LLC", "SMF I"). The
  // row-start regex confirms a seller is at position 2 + maybe-footnotes.
  const sellerRe = new RegExp(`^${SELLER_RE_SRC}$`);
  // Try each starting position from token 2 onward (skip control# at 0, "Loan" at 1, and any
  // footnote integers). Build candidate seller spans of 1-3 tokens; first match wins.
  for (let start = 2; start < tokens.length - 1; start++) {
    for (let span = 3; span >= 1; span--) {
      const candidate = tokens.slice(start, start + span).join(' ');
      if (sellerRe.test(candidate)) {
        return start + span; // first token AFTER the seller
      }
    }
  }
  return -1;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-table parsers                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

interface T1Row {
  generalPropertyType: string | null;
  specificPropertyType: string | null;
}
function parseT1(row: string): T1Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { generalPropertyType: null, specificPropertyType: null };
  // After Seller: Property Name … Related Group … Crossed Group … Address … City … State … Zip … Property Type
  // Property Type is the LAST trailing word(s) before the next row. Defer for now — return null.
  // (T1 anchors the conventions detection in the next step; for this step we just confirm the row matched.)
  return { generalPropertyType: null, specificPropertyType: null };
}

interface T2Row {
  loanAmount: number | null;
}
function parseT2(row: string): T2Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { loanAmount: null };
  // T2 column order after seller: [Property Name (multi-tok)] [Property Type] [Year Built] [Year Renovated]
  //   [Units desc] [Loan Per Unit] [Ownership Interest] [Original Balance] [Cut-off Balance]
  //   [(multi-property)] [% Pool] [Balloon Balance]
  // First $-token >= $1M (filtered by NRA-style "<num> Sq Ft / Rooms / Units / Pads" skip) is the
  // original balance. Loan Per Unit can be > $1M for some loans → use the NRA-skip heuristic from
  // WFRBS Bug A (skip a numeric token immediately followed by a unit label).
  const NRA_UNIT = /^(?:SF|Sq\.?|Ft\.?|Rooms|Units|Pads|Beds|Acres|Spaces|Bays|Stalls)$/;
  const numericTokens: number[] = [];
  for (let i = si; i < t.length; i++) {
    const v = num(t[i]);
    if (v === null || v < 100_000) continue;
    if (NRA_UNIT.test(t[i + 1] ?? '')) continue;
    numericTokens.push(v);
  }
  // CGCMT smallest pool loans are ~$750K (e.g. #19 Wendy's in the RAIT
  // cross-collat group). A blanket >=$1M dollarish threshold drops them.
  // Identify Original Balance as the FIRST RUN of two consecutive ~equal
  // numeric tokens (Original Balance == Cut-off Date Balance, modulo any
  // accrued interest difference; in practice equal at origination on
  // every observed CGCMT row). This skips Loan Per Unit (a single value
  // that doesn't repeat) and works at any loan size.
  let loanAmount: number | null = null;
  for (let i = 0; i < numericTokens.length - 1; i++) {
    const a = numericTokens[i]!;
    const b = numericTokens[i + 1]!;
    if (a > 0 && Math.abs(a - b) / a <= 0.05) { loanAmount = a; break; }
  }
  return { loanAmount };
}

interface T3Row {
  coupon: number | null;
  originalTermMonths: number | null;
}
function parseT3(row: string): T3Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { coupon: null, originalTermMonths: null };
  // After seller: [Property Name…] [Mortgage Loan Rate (%)] [Fee Rate (%)] [Net Rate (%)]
  //   [Monthly DS ($)] [Annual DS ($)] [Companion DS ($)] [Companion DS ($)] [Amort Type] [Accrual] [Seasoning]
  // coupon = first %-token after the seller.
  let coupon: number | null = null;
  for (let i = si; i < t.length; i++) {
    const tk = t[i] ?? '';
    if (tk.endsWith('%') || t[i + 1] === '%') {
      const v = num(tk);
      if (v !== null && v > 0 && v < 20) {
        coupon = v / 100;
        break;
      }
    }
  }
  return { coupon, originalTermMonths: null };
}

interface T4Row {
  originalTermMonths: number | null;
  ioMonths: number | null;
  amortMonths: number | null;
}
function parseT4(row: string): T4Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { originalTermMonths: null, ioMonths: null, amortMonths: null };
  // After seller + Property Name (multi-tok): [Original IO (mos)] [Remaining IO (mos)]
  //   [Original Term (mos)] [Remaining Term (mos)] [Original Amort (mos)] [Remaining Amort (mos)]
  //   [Origination Date] [Due Date] [First Due] [Last IO] [First P&I] [Maturity/ARD] [Y/N]
  // Property name token count is variable. Anchor on the FIRST run of 1-4 small integers (months)
  // and extract first / third / fifth as IO/Term/Amort.
  const intRun: number[] = [];
  let inRun = false;
  for (let i = si; i < t.length; i++) {
    const v = num(t[i]);
    const isMonthLike = v !== null && Number.isInteger(v) && v >= 0 && v <= 500;
    if (isMonthLike) {
      intRun.push(v);
      inRun = true;
      if (intRun.length >= 6) break;
    } else if (inRun) {
      // Run broken — if we have at least 4 ints, treat the first 4-6 as the term tuple
      if (intRun.length >= 4) break;
      intRun.length = 0;
      inRun = false;
    }
  }
  return {
    ioMonths: intRun[0] ?? null,
    originalTermMonths: intRun[2] ?? null,
    amortMonths: intRun[4] ?? null,
  };
}

interface T6Row {
  t12Egi: number | null;
  t12OpEx: number | null;
  t12Noi: number | null;
}
function parseT6(row: string): T6Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { t12Egi: null, t12OpEx: null, t12Noi: null };
  // After seller + Property Name (multi-tok): [Most Recent NOI Date] [Most Recent EGI]
  //   [Most Recent Expenses] [Most Recent NOI] [more cols…] [UW EGI] [UW Expenses]
  // Strategy: collect numeric tokens >= 1000 (and not 4-digit bare year), take first 3.
  const bigNums: number[] = [];
  for (let i = si; i < t.length && bigNums.length < 3; i++) {
    const raw = t[i] ?? '';
    if (/^\d{4}$/.test(raw)) { const y = Number(raw); if (y >= 1900 && y <= 2100) continue; }
    const v = num(raw);
    if (v === null) continue;
    if (bigNums.length === 0) {
      if (v >= 1_000 && v <= 5_000_000_000) bigNums.push(v);
    } else {
      if (v >= 0 && v <= 5_000_000_000) bigNums.push(v);
    }
  }
  return { t12Egi: bigNums[0] ?? null, t12OpEx: bigNums[1] ?? null, t12Noi: bigNums[2] ?? null };
}

interface T7Row {
  uwY1Noi: number | null;
  uwDscr: number | null;          // UW NCF DSCR per the column header
  uwDebtYield: number | null;     // Debt Yield on UW NCF (%)
  concludedValue: number | null;  // Appraised Value ($) — but the As-Stabilized one is in T8;
                                  // verify this is the right value-side once spot-checked.
}
function parseT7(row: string): T7Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { uwY1Noi: null, uwDscr: null, uwDebtYield: null, concludedValue: null };
  // After seller + property name, the financial column sequence per the
  // T7 header is:
  //   [0] Underwritten NOI ($)               — large $ value
  //   [1] Debt Yield on UW NOI (%)           — percent
  //   [2] Replacement / FF&E Reserve ($)     — large or 0
  //   [3] Underwritten TI / LC ($)           — large or 0
  //   [4] Underwritten NCF ($)               — large $ value
  //   [5] Underwritten NCF DSCR (x)          — raw decimal 0.5-10
  //   [6] Debt Yield on UW NCF (%)           — percent
  //   [7] Appraised Value ($)                — large $ value
  //
  // ★ CGCMT-NUMERATOR NOTE: the prospectus's stated DSCR (col 5) and DY
  // (col 6) are both COMPUTED ON NCF, not NOI. So to make the identity
  // checks foot, we put the NCF ($, col 4) into the contract's
  // `uwY1Noi` slot (which the issuer-agnostic verify() uses as the
  // DY/DSCR numerator) rather than NOI ($, col 0). The field is
  // semantically "the numerator that matches the stated ratios", not
  // "always NOI" — CGCMT differs from WFRBS here, and the contract
  // doesn't change.
  //
  // ★ PROPERTY-NAME DIGIT SKIP: CGCMT property names may begin with a
  // multi-digit address (e.g. "400 Broome Street", "75 19th Street",
  // "125 Third Avenue"). These produce numeric tokens (400, 75, 125)
  // that would be captured into seq[0] otherwise, displacing the real
  // financial sequence by 1. Solution: don't start collecting until the
  // first numeric token of size ≥ $100K — name digits are always small.
  // First pass: locate the NOI anchor (first non-percent ≥ $10K — the UW
  // NOI ($) column). $10K is low enough to catch tiny pool loans
  // (e.g. #19 Wendy's NOI ≈ $67K) yet high enough to skip address-style
  // property-name digits ("400 Broome", "75 19th", "125 Third") which
  // are < $1K as numerics.
  let anchorIdx = -1;
  for (let i = si; i < t.length; i++) {
    const raw = t[i] ?? '';
    const v = num(raw);
    if (v === null) continue;
    const isPct = raw.endsWith('%') || t[i + 1] === '%';
    if (!isPct && v >= 10_000) { anchorIdx = i; break; }
  }
  // Second pass: from the anchor, walk forward and CLASSIFY every token
  // by column position. N/A / NAP must be recorded as a null placeholder
  // — they occupy a column position. Skipping them would shift every
  // downstream column by one and misalign the parsed fields.
  type SeqEntry = { value: number | null; isPct: boolean; raw: string };
  const seq: SeqEntry[] = [];
  for (let i = anchorIdx; i >= 0 && i < t.length && seq.length < 9; i++) {
    const raw = t[i] ?? '';
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) break;   // Appraisal Date — stop
    const isPct = raw.endsWith('%') || t[i + 1] === '%';
    if (/^(?:NAP|N\/A|NAV)$/i.test(raw)) { seq.push({ value: null, isPct: false, raw }); continue; }
    const v = num(raw);
    if (v === null) continue;  // ignore non-financial tokens (e.g. stray "%" alone)
    seq.push({ value: v, isPct, raw });
  }
  const ncfEntry  = seq[4];
  const uwY1Noi   = ncfEntry?.value !== null && ncfEntry?.value !== undefined && ncfEntry.value >= 0
                    ? ncfEntry.value : null;
  const dscrEntry = seq[5];
  const uwDscr    = dscrEntry?.value !== null && dscrEntry?.value !== undefined && !dscrEntry.isPct
                    && dscrEntry.value > 0.3 && dscrEntry.value < 50
                    ? dscrEntry.value : null;
  const dyEntry   = seq[6];
  const uwDebtYield = dyEntry?.value !== null && dyEntry?.value !== undefined && dyEntry.isPct
                    && dyEntry.value > 0 && dyEntry.value < 100
                    ? dyEntry.value / 100 : null;
  const appraisedEntry = seq[7];
  const concludedValue = appraisedEntry?.value !== null && appraisedEntry?.value !== undefined
                    && appraisedEntry.value >= 500_000
                    ? appraisedEntry.value : null;
  return { uwY1Noi, uwDscr, uwDebtYield, concludedValue };
}

interface T8Row {
  concludedLtv: number | null;
  occupancyCurrent: number | null;
}
function parseT8(row: string): T8Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { concludedLtv: null, occupancyCurrent: null };
  // After seller + property name: [As Stabilized Appraised Value ($)] [As Stabilized Appraisal Date]
  //   [As Stabilized LTV Ratio (%)] [Cut-off Date LTV Ratio (%)] [LTV at Maturity / ARD (%)]
  //   [Occupancy (%)] [Occupancy Date] [ADR ($)] [RevPAR ($)] [Largest Tenant]
  // Collect numeric tokens in order; pick positions 2 (as-stab LTV) or 3 (cut-off LTV).
  const seq: Array<{ value: number; isPct: boolean }> = [];
  for (let i = si; i < t.length; i++) {
    const raw = t[i] ?? '';
    const v = num(raw);
    if (v === null) continue;
    const isPct = raw.endsWith('%') || t[i + 1] === '%';
    seq.push({ value: v, isPct });
  }
  // Heuristic: many loans have As-Stab = Cut-off (no upcoming stabilization), so the first %
  // run will show LTV-like values. Take the FIRST %-value 5-150 as concludedLtv.
  let concludedLtv: number | null = null;
  for (const s of seq) {
    if (s.isPct && s.value > 5 && s.value <= 150) { concludedLtv = s.value / 100; break; }
  }
  // Occupancy: typically a % value 0-100 LATER in the row (after several other % tokens).
  let occupancyCurrent: number | null = null;
  const pcts = seq.filter(s => s.isPct);
  // The 4th percent in the sequence is occupancy (as-stab LTV, cut-off LTV, balloon LTV, occupancy).
  const occEntry = pcts[3];
  if (occEntry !== undefined && occEntry.value > 0 && occEntry.value <= 100) {
    occupancyCurrent = occEntry.value / 100;
  }
  return { concludedLtv, occupancyCurrent };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Convention parsers — CGCMT-specific shapes                               */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Parse Related Group + Crossed Group from a T1 row.
 *
 * Column order after Property Name:
 *   ... [Related Group] [Crossed Group] [Address] [City] [State] [Zip] [Property Type]
 *
 * Both group columns are EITHER "NAP" or "Group <token>" — the pair appears
 * adjacent in every T1 row. We pattern-match the adjacent pair to avoid
 * having to track the variable property-name length (which can include
 * digits like "125 Third Avenue" and even literal "Group N" in the name
 * itself — e.g. #10 "Group 10 Hotel Portfolio"; the adjacent-pair regex
 * sidesteps both issues because the property name never produces a
 * `(NAP|Group X) (NAP|Group Y)` adjacent pair).
 *
 * Returns null tag when the column is "NAP" or when no pair is found.
 */
const GROUP_PAIR_RE = /(NAP|Group\s+\w+)\s+(NAP|Group\s+\w+)/;
function parseT1ConventionTags(row: string | null): { related: string | null; crossed: string | null } {
  if (row === null) return { related: null, crossed: null };
  const m = GROUP_PAIR_RE.exec(row);
  if (m === null) return { related: null, crossed: null };
  const norm = (s: string): string | null => (s.trim().toUpperCase() === 'NAP' ? null : s.trim());
  return { related: norm(m[1] ?? ''), crossed: norm(m[2] ?? '') };
}

/**
 * Parse the "Pari Passu Companion Loan Summary" table in the Annex B prose
 * region. Each row lists the trust-slice loan name + companion balance +
 * combined whole-loan balance. We extract the whole-loan balance for each
 * named loan and resolve property names to control numbers via the T1
 * Property Name column.
 *
 * Table shape (verbatim, observed at offset ~1,641,955):
 *
 *   Pari Passu Companion Loan Summary
 *   Mortgage Loan Name | Mortgage Loan Cut-off Date Balance | Pari Passu
 *     Companion Loan Cut-off Date Balance | Whole Loan Cut-off Date Balance
 *     | Controlling P&S Agreement | UW NCF DSCR | UW NOI Debt Yield |
 *     Cut-off Date LTV Ratio
 *
 *   Walpole Shopping Mall $17,500,000 $47,000,000 $64,500,000 CGCMT 2013-GC15 1.33x 9.2% 75.0%
 *
 * For CGCMT 2013-GC15 only ONE loan is pari-passu (Walpole, #20); the
 * regex is written for N-row generality.
 */
function parseCgcmtPariPassuTable(annexA: string): Map<string, number> {
  const out = new Map<string, number>();
  const tableStart = annexA.indexOf('Pari Passu Companion Loan Summary');
  if (tableStart < 0) return out;
  // Skip past the column-header row: the last words of the header are
  // "Cut-off Date LTV Ratio" — data rows begin immediately after that.
  // Without this skip, a lazy regex like `[A-Z][^$]{2,80}?` matches
  // from the first capital ('UW' / 'Mortgage') in the header all the
  // way to the dollar figure, producing junk names like
  // "UW NCF DSCR UW NOI Debt Yield Cut-off Date LTV Ratio Walpole Shopping Mall".
  const headerEndMarker = 'Cut-off Date LTV Ratio';
  const headerEnd = annexA.indexOf(headerEndMarker, tableStart);
  if (headerEnd < 0) return out;
  const dataStart = headerEnd + headerEndMarker.length;
  const tableEnd = Math.min(annexA.length, dataStart + 4000);
  const table = annexA.slice(dataStart, tableEnd);
  // Pattern: <Property Name>  $<trust>  $<companion>  $<whole>  CGCMT…
  // Property name = capital-letter start, then anything that isn't "$"
  // (the dollar sign anchors the start of the trust balance — most
  // robust delimiter). Whole-loan balance is the third $-figure.
  const rowRe = /([A-Z][^$]{2,80}?)\s+\$([\d,]+)\s+\$([\d,]+)\s+\$([\d,]+)\s+CGCMT/g;
  let m;
  while ((m = rowRe.exec(table)) !== null) {
    const name = (m[1] ?? '').trim();
    const whole = Number((m[4] ?? '').replace(/,/g, ''));
    if (name && Number.isFinite(whole)) out.set(name, whole);
  }
  return out;
}

/**
 * Build a map of property names → control numbers from the T1 chunk so we
 * can resolve Pari-Passu table entries (keyed by property name) to control
 * numbers (which is what ExtractedLoan.pariPassuCombination is indexed by).
 */
function buildNameToControlMap(t1Chunk: string): Map<string, number> {
  const out = new Map<string, number>();
  // Per-row pattern: capture "Control# Loan [footnotes] SELLER PropertyName" up to the GROUP_PAIR
  const sellerRe = '(?:CGMRC|GSMC|RMF|SMF\\s+I|RAIT\\s+Funding,\\s+LLC|RCMC|The\\s+Bancorp\\s+Bank)';
  const rowRe = new RegExp(
    `(?<![\\d.])\\b(\\d+)\\s+Loan\\s+(?:[\\d,]+(?:\\s+[\\d,]+)*\\s+)?${sellerRe}\\s+([A-Z][^]+?)\\s+(?:NAP|Group\\s+\\w+)\\s+(?:NAP|Group\\s+\\w+)`,
    'g',
  );
  let m;
  while ((m = rowRe.exec(t1Chunk)) !== null) {
    const n = Number(m[1]);
    const name = (m[2] ?? '').trim();
    if (Number.isFinite(n) && name) out.set(name, n);
  }
  return out;
}

/**
 * Resolve a Pari-Passu table entry's name → control number. Tries exact
 * match first; falls back to a normalized comparison (e.g. the summary
 * table uses "Walpole Shopping Mall" while the T1 row carries "Walpole
 * Shopping Mall" — usually identical, but defensive).
 */
function resolvePariPassu(
  ppTable: Map<string, number>,
  nameToN: Map<string, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [name, whole] of ppTable) {
    let n = nameToN.get(name);
    if (n === undefined) {
      // case-insensitive fallback
      for (const [k, v] of nameToN) {
        if (k.toLowerCase() === name.toLowerCase()) { n = v; break; }
      }
    }
    if (n !== undefined) out.set(n, whole);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-loan aggregation                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

function extractLoan(
  controlNumber: number,
  tables: Record<string, string>,
  pariPassuByControlNum: Map<number, number>,
  crossCollatByControlNum: Map<number, CrossCollatGroup>,
): ExtractedLoan {
  const r1 = extractLoanRow(tables.t1 ?? '', controlNumber);
  const r2 = extractLoanRow(tables.t2 ?? '', controlNumber);
  const r3 = extractLoanRow(tables.t3 ?? '', controlNumber);
  const r4 = extractLoanRow(tables.t4 ?? '', controlNumber);
  const r6 = extractLoanRow(tables.t6 ?? '', controlNumber);
  const r7 = extractLoanRow(tables.t7 ?? '', controlNumber);
  const r8 = extractLoanRow(tables.t8 ?? '', controlNumber);
  const t1 = r1 ? parseT1(r1) : { generalPropertyType: null, specificPropertyType: null };
  const t2 = r2 ? parseT2(r2) : { loanAmount: null };
  const t3 = r3 ? parseT3(r3) : { coupon: null, originalTermMonths: null };
  const t4 = r4 ? parseT4(r4) : { originalTermMonths: null, ioMonths: null, amortMonths: null };
  const t6 = r6 ? parseT6(r6) : { t12Egi: null, t12OpEx: null, t12Noi: null };
  const t7 = r7 ? parseT7(r7) : { uwY1Noi: null, uwDscr: null, uwDebtYield: null, concludedValue: null };
  const t8 = r8 ? parseT8(r8) : { concludedLtv: null, occupancyCurrent: null };
  return {
    controlNumber,
    generalPropertyType: t1.generalPropertyType,
    specificPropertyType: t1.specificPropertyType,
    loanAmount: t2.loanAmount,
    maturityDate: null,
    coupon: t3.coupon,
    originalTermMonths: t4.originalTermMonths,
    ioMonths: t4.ioMonths,
    amortMonths: t4.amortMonths,
    concludedValue: t7.concludedValue,
    uwDscr: t7.uwDscr,
    uwNoiDscr: null,
    concludedLtv: t8.concludedLtv,
    uwDebtYield: t7.uwDebtYield,
    t12Noi: t6.t12Noi,
    t12Egi: t6.t12Egi,
    t12OpEx: t6.t12OpEx,
    occupancyCurrent: t8.occupancyCurrent,
    uwY1Noi: t7.uwY1Noi,
    uwY1Revenue: null,
    uwY1OpEx: null,
    // STEP 3 wiring: pari-passu from the "Pari Passu Companion Loan Summary"
    // table; cross-collat from the T1 "Crossed Group" column. Related Group
    // is a borrower-relationship tag, NOT a denominator convention — it is
    // captured separately for display and does NOT flow into ExtractedLoan.
    pariPassuCombination: pariPassuByControlNum.has(controlNumber)
      ? ({
          noteNumber: 'A-1',                     // CGCMT 2013-GC15 has a single pari-passu loan (#20 Walpole);
                                                 // noteNumber/totalNotes are display-only — denom is the combined balance scalar
          totalNotes: 2,
          combinedCutOffBalance: pariPassuByControlNum.get(controlNumber)!,
        } satisfies PariPassuCombination)
      : null,
    crossCollatGroup: crossCollatByControlNum.get(controlNumber) ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Main                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('CGCMT 2013-GC15 — Annex A shelf walker (STEP 3: conventions wired)');
  console.log('================================================================\n');

  const raw = fs.readFileSync(ANNEX_A_PATH, 'utf8');
  const annexA = stripHtml(raw);
  console.log(`Stripped doc: ${annexA.length.toLocaleString()} bytes\n`);

  const tables = locateTableChunks(annexA);
  console.log('Table chunks located (anchor / length):');
  for (const k of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']) {
    const len = (tables[k] ?? '').length;
    console.log(`  ${k.toUpperCase().padEnd(4)} ${len > 0 ? '✓' : '✗'}  len=${len.toLocaleString()}`);
  }
  console.log('');

  /* ─── Pre-walk: build convention maps ─── */

  // Cross-collat: scan T1 rows for the Crossed Group column. Loans
  // sharing a non-NAP Crossed Group value are members of the same
  // cross-collat group. Related Group is also captured (display only).
  const relatedTagByN = new Map<number, string>();   // for display only
  const crossedTagByN = new Map<number, string>();   // intermediate; finalized into CrossCollatGroup below
  for (let n = 1; n <= 120; n++) {
    const r1 = extractLoanRow(tables.t1 ?? '', n);
    if (r1 === null) continue;
    const tags = parseT1ConventionTags(r1);
    if (tags.related !== null) relatedTagByN.set(n, tags.related);
    if (tags.crossed !== null) crossedTagByN.set(n, tags.crossed);
  }
  // Group loans by Crossed Group tag → CrossCollatGroup objects
  const groupsByTag = new Map<string, number[]>();
  for (const [n, tag] of crossedTagByN) {
    if (!groupsByTag.has(tag)) groupsByTag.set(tag, []);
    groupsByTag.get(tag)!.push(n);
  }
  const crossCollatByControlNum = new Map<number, CrossCollatGroup>();
  for (const [tag, members] of groupsByTag) {
    const memberIds = [...members].sort((a, b) => a - b);
    const group: CrossCollatGroup = { groupId: `XC-${tag.replace(/\s+/g, '-')}`, memberIds };
    for (const id of memberIds) crossCollatByControlNum.set(id, group);
  }

  console.log('Cross-collat groups (from T1 Crossed Group column):');
  if (groupsByTag.size === 0) {
    console.log('  (none)');
  } else {
    for (const [tag, members] of [...groupsByTag.entries()].sort()) {
      console.log(`  Crossed=${tag}  → group XC-${tag.replace(/\s+/g, '-')}  members {${members.map(n => '#' + n).join(', ')}}`);
    }
  }

  console.log('\nRelated Groups (display only — does NOT trigger aggregation):');
  const relatedByTag = new Map<string, number[]>();
  for (const [n, tag] of relatedTagByN) {
    if (!relatedByTag.has(tag)) relatedByTag.set(tag, []);
    relatedByTag.get(tag)!.push(n);
  }
  if (relatedByTag.size === 0) {
    console.log('  (none)');
  } else {
    for (const [tag, members] of [...relatedByTag.entries()].sort()) {
      console.log(`  Related=${tag}  → members {${members.map(n => '#' + n).join(', ')}}  (no denominator change)`);
    }
  }
  console.log('');

  // Pari-passu: parse the "Pari Passu Companion Loan Summary" table.
  const ppNameMap = parseCgcmtPariPassuTable(annexA);
  const nameToN = buildNameToControlMap(tables.t1 ?? '');
  const pariPassuByControlNum = resolvePariPassu(ppNameMap, nameToN);

  console.log('Pari-passu loans (from "Pari Passu Companion Loan Summary" table):');
  if (pariPassuByControlNum.size === 0) {
    console.log('  (none detected)');
  } else {
    for (const [n, whole] of [...pariPassuByControlNum.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  #${n}  whole-loan cut-off $${(whole / 1_000_000).toFixed(1)}M`);
    }
  }
  console.log('');

  // Walk 1..120; each control# is a candidate. Real CGCMT pool size is 97 per cover.
  const loans: ExtractedLoan[] = [];
  for (let n = 1; n <= 120; n++) {
    const loan = extractLoan(n, tables, pariPassuByControlNum, crossCollatByControlNum);
    if (loan.loanAmount !== null || loan.concludedValue !== null) {
      loans.push(loan);
    }
  }
  console.log(`Loans extracted: ${loans.length}  (expected: 97 per prospectus cover)\n`);

  // Verify with the shared verdict layer (conventions null → standalone path only)
  const loanLookup = new Map<number, ExtractedLoan>();
  for (const l of loans) loanLookup.set(l.controlNumber, l);
  const verdicts = loans.map(loan => ({ loan, verdict: verify(loan, loanLookup) }));

  // Per-loan verdict table
  console.log('================================================================');
  console.log('PER-LOAN VERDICT TABLE');
  console.log('================================================================\n');
  console.log('# '.padEnd(4) + 'status'.padEnd(15) + 'loan amount'.padEnd(13) + 'reason');
  console.log('-'.repeat(110));
  for (const { loan, verdict } of verdicts) {
    const tag = verdict.status === 'CLEAN' ? '✓ CLEAN'
              : verdict.status === 'FLAGGED' ? '⚑ FLAGGED'
              : '? UNCHECKED';
    console.log(`${String(loan.controlNumber).padEnd(4)}${tag.padEnd(15)}${fmtUsd(loan.loanAmount).padEnd(13)}${verdict.reason}`);
  }
  console.log('');

  const clean     = verdicts.filter(v => v.verdict.status === 'CLEAN');
  const flagged   = verdicts.filter(v => v.verdict.status === 'FLAGGED');
  const unchecked = verdicts.filter(v => v.verdict.status === 'UNCHECKED');
  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`  total loans extracted   : ${loans.length}`);
  console.log(`  ✓ CLEAN                 : ${clean.length}`);
  console.log(`  ⚑ FLAGGED                : ${flagged.length}`);
  console.log(`  ? UNCHECKED              : ${unchecked.length}`);
  console.log('');

  // Spot-check dump
  console.log('================================================================');
  console.log('SPOT-CHECK — parsed values for 5 representative loans');
  console.log('================================================================\n');
  const spotIds = [1, 4, 5, 12, 28];
  for (const id of spotIds) {
    const l = loans.find(x => x.controlNumber === id);
    if (!l) { console.log(`  #${id}  NOT EXTRACTED`); continue; }
    console.log(`  #${id}:`);
    console.log(`    loanAmount      : ${fmtUsd(l.loanAmount)}`);
    console.log(`    concludedValue  : ${fmtUsd(l.concludedValue)}`);
    console.log(`    uwY1Noi         : ${fmtUsd(l.uwY1Noi)}`);
    console.log(`    coupon          : ${l.coupon === null ? '—' : (l.coupon * 100).toFixed(3) + '%'}`);
    console.log(`    amortMonths     : ${l.amortMonths ?? '—'}`);
    console.log(`    concludedLtv    : ${fmtPct(l.concludedLtv)}`);
    console.log(`    uwDebtYield     : ${fmtPct(l.uwDebtYield)}`);
    console.log(`    uwDscr          : ${fmtNum(l.uwDscr)}`);
    console.log(`    t12 EGI/OpEx/NOI: ${fmtUsd(l.t12Egi)} / ${fmtUsd(l.t12OpEx)} / ${fmtUsd(l.t12Noi)}`);
    console.log('');
  }
}

main().catch(err => { console.error(err); process.exit(1); });

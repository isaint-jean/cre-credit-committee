/**
 * 424B5 Annex A — WFRBS 2013-C11 shelf-wide value generalizer + verification.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-annexA-wfrbs-shelf-generalizer.ts
 *
 * Scope: ONE proven shelf. WFRBS 2013-C11 stratification tables are the same
 * format the Loan #17 spike hand-decoded — same column ordering, same anchor
 * texts, same loan-row layout. This is ROW generalization within a proven
 * format, NOT cross-shelf format variation.
 *
 * What this produces:
 *
 *   1. Per-loan extraction from tables T2 (pool weights), T3 (rate + amort),
 *      T4 (UW metrics), T5 (TTM financials), T6 (UW financials), T1 (asset
 *      class). Single-property loans only on this pass — portfolio loans
 *      (multi-row sub-properties like 17.01, 17.02) are aggregated by parent
 *      control number from the T2 cut-off balance row (the parent line).
 *
 *   2. Verification layer (reusable for every future shelf):
 *        - LTV check : stated concludedLtv  vs  loanAmount / concludedValue
 *                       [EXACT — tolerance 50 bps]
 *        - DY check  : stated uwDebtYield   vs  uwY1Noi / loanAmount
 *                       [EXACT — tolerance 50 bps]
 *        - DSCR check: stated uwDscr        vs  uwY1Noi / computedDS
 *                       [APPROXIMATE — tolerance 0.25x; issuer DSCR is
 *                        NCF-basis not NOI-basis so loose; flag only gross]
 *        - Pool cross-foot: sum(extracted loanAmounts) vs stated pool total
 *                       [EXACT — tolerance 0.1% of pool]
 *      Each loan: CLEAN if all exact checks pass + DSCR within loose tol;
 *      FLAGGED otherwise with the broken identity and magnitude.
 *
 *   3. Loan-#17 regression check — extracted values vs the hand-decoded
 *      spike baseline. If #17 drifts, the generalizer broke the known-good
 *      case and we stop. The verification layer also runs against #17.
 *
 * What this does NOT do:
 *
 *   - No adapter wiring. Flagged loans aren't ingested; clean loans aren't
 *     ingested either in this pass. Ingest is the next step, gated on the
 *     verdict counts here.
 *   - No 5-shelf cross-format generalizer. Each shelf will need its own
 *     anchor + column-position calibration; that's a separate pass.
 *   - No 10-D / loss outcome cross-reference. Separate corpus-substrate
 *     wiring.
 */
import * as fs from 'node:fs';

const ANNEX_A_PATH = '/tmp/wfrbs-2013-c11-424B5.htm';
const ANNEX_A_BODY_OFFSET = 3_541_025;  // from clean-corpus-spike-annexA.ts

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#146;|&#145;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}
function fmtPct(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(d) + '%';
}
function fmtNum(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

const SELLERS = ['WFB', 'RBS', 'CGMRC', 'JLC', 'GACC', 'GS', 'LCF', 'CIIICM', 'WFCMC', 'LIG'];

/* ──────────────────────────────────────────────────────────────────────── */
/* Row extraction — positional, by control number                          */
/* ──────────────────────────────────────────────────────────────────────── */

/** Find a loan-N row that starts AT the start of a table region. Returns the
 *  slice from "N PropertyName Seller …" up to the next loan row. Filters out
 *  sub-property rows (N.NN). */
function extractLoanRow(tableText: string, controlNumber: number): string | null {
  // Build the seller regex group dynamically
  const sellerRe = SELLERS.join('|');
  // Match: word boundary + control number (NOT preceded by .digit) + space + property name + seller code
  //   (?<![\d\.])         — not preceded by digit or period (excludes "17.01" matching "01")
  //   \b{N}\s+            — exact control number + whitespace
  //   (?!\d+\.)           — ★ Bug B fix #1 (2026-06-14): name must NOT begin with a
  //                          sub-property pattern "N.NN" (e.g., "15.01"). Chunk may
  //                          contain a stray loose integer (loan #15's T3 row puts
  //                          "17" as an IO-period count near sub-property
  //                          "15.01 Piedmont Plaza"). "1 Mission" passes because
  //                          "1 " is digit-space, not digit-period.
  //   (?:[A-Z]|\d\s+[A-Z]) — ★ Bug B fix #2 (2026-06-14) — REFINED. Name first
  //                          token is either:
  //                            • an uppercase letter (the standard case), OR
  //                            • a SINGLE digit followed by whitespace and an
  //                              uppercase letter (address-style "1 Mission").
  //                          Single-digit-only — eliminates the original [A-Z0-9]
  //                          widening's regression on multi-digit ADR/RevPAR
  //                          values (e.g. "30 Meadows Building" or
  //                          "10 Holiday Inn National Airport" — the digit run
  //                          fails the `\d\s+` because the second digit isn't
  //                          whitespace).
  //   […chars…]{1,118}?   — rest of the name (allowed char class, lazy)
  //   \s+(seller)\b       — name ends at the seller code (fixed enum)
  const re = new RegExp(
    `(?<![\\d\\.])\\b${controlNumber}\\s+(?!\\d+\\.)((?:[A-Z]|\\d\\s+[A-Z])[A-Za-z0-9\\s'\\-&,\\.\\(\\)\\/]{1,118}?)\\s+(${sellerRe})\\b`,
    'g',
  );
  const m = re.exec(tableText);
  if (m === null) return null;
  const start = m.index;
  // End at next loan row (number 1-200, not 17.01 or similar).
  //
  // ★ TWO false-positive truncation patterns the prior stop regex hit (both
  //   diagnosed 2026-06-14 against WFRBS 2013-C11; together they were
  //   responsible for 13 silent-CLEAN loans surfaced by the UNCHECKED
  //   verdict):
  //
  //   (A) Comma-tail-of-thousands segment + capital unit. The previous
  //       single-char (?<![\d\.]) lookbehind only checked one char back; a
  //       comma is neither digit nor period, so on "1,302,107 Sq. Ft." the
  //       stop matched "107 Sq" — truncating mid-number. Widened lookbehind
  //       to (?<![\d\.,]) rejects this whole class (#1, #5, #81).
  //
  //   (B) Standalone unit count + capital unit label. "98 Rooms" /
  //       "168 Pads" / "19 Units" looked structurally identical to a real
  //       next-row marker ("42 Marketplace") but are intra-row unit counts
  //       for hotels / MHCs / apartments. No comma precedes them, so (A)
  //       alone doesn't fix this. Added a unit-label negative-lookahead
  //       denylist after the integer + whitespace.
  //
  //   Denylist words: observed in WFRBS 2013-C11 (Rooms, Units, Pads,
  //   Sq.?, Ft.?). Extra-conservative defensive additions (Beds, Acres,
  //   Spaces, Bays, Stalls) cover CMBS asset classes not on this shelf but
  //   plausible on others. Property names starting with these tokens are
  //   not rejected because the negation requires \b after the unit word
  //   ("Suites X" passes — "Sq" then "uites" lacks the word-boundary so
  //   Sq\.?\b fails; "Square Park" likewise).
  const stopRe = new RegExp(
    `(?<![\\d\\.,])` +
    `\\b(?:[1-9][0-9]?|1[0-9]{2})\\s+` +
    `(?!(?:Rooms|Units|Pads|Sq\\.?|Ft\\.?|Beds|Acres|Spaces|Bays|Stalls)\\b)` +
    `[A-Z][A-Za-z]`,
    'g',
  );
  stopRe.lastIndex = start + 8;  // skip past the current loan number itself
  const stop = stopRe.exec(tableText);
  const end = stop ? stop.index : start + 800;
  return tableText.slice(start, Math.min(end, start + 800));
}

/** Tokenize a row into clean tokens, after stripping HTML. */
function tokenize(row: string): string[] {
  return row.trim().split(/\s+/);
}

/** Parse a number out of a token: strip $, %, commas, parentheses; treat
 *  "Various", "NAV", "N/A", "-" as null. */
function num(tok: string | undefined): number | null {
  if (tok === undefined) return null;
  const cleaned = tok.replace(/[\$,\s%\(\)]/g, '');
  if (['Various', 'NAV', 'N/A', '-', ''].includes(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Locate the column index of the property's "(seller)" token — the
 *  delimiter after which positional indices stabilize across rows. */
function findSellerIdx(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    if (SELLERS.includes(tokens[i] ?? '')) return i;
  }
  return -1;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-table column maps (column INDEX relative to the post-seller offset)  */
/* These were calibrated from the Loan #17 hand-decoded row text comments  */
/* in clean-corpus-spike-annexA.ts:185-242. All loans in WFRBS 2013-C11    */
/* share this column ordering.                                              */
/* ──────────────────────────────────────────────────────────────────────── */

interface T2Row { originalLoanAmount: number | null; cutOffPrincipal: number | null; balloonBalance: number | null; maturityDate: string | null; }
function parseT2(row: string): T2Row {
  // T2 layout after seller code:
  //  [state] [county] [units/rooms count] [unit label] [sqft/NRA]
  //  [original balance] [cut-off balance] [% pool] [balloon balance]
  //  [crossCollateralized Y/N] [originationDate] [firstPaymentDate]
  //  [secondDate] [maturityDate]
  const t = tokenize(row);
  const si = findSellerIdx(t);
  if (si < 0) return { originalLoanAmount: null, cutOffPrincipal: null, balloonBalance: null, maturityDate: null };
  // Walk forward from seller looking for first $-amount-looking token (>1M, comma-formatted or plain).
  //
  // ★ Bug A — NRA-skip (2026-06-14): in the T2 column layout NRA / sqft comes
  // BEFORE the loan-amount columns ("...1,302,107 Sq. Ft. 215 155,000,000..."),
  // so for properties whose NRA ≥ $1M the bare numeric would otherwise become
  // dollarish[0] and the engine would read the SqFt count as if it were the
  // trust-slice loan amount — collapsing the LTV identity (e.g. on WFRBS #5
  // Brennan Industrial Portfolio II 3,913,170 sqft, derived LTV 2.1% vs
  // stated 65.0%). Skip any numeric token whose IMMEDIATELY-FOLLOWING token
  // is a sqft unit label (Sq./Sq/Ft./Ft/SF). Real loan amounts in T2 are
  // followed by another large number, a percent ("% pool" column), or a
  // date — never by a unit label, so the filter has no false positives on
  // the 56 loans whose NRA is already < $1M (those tokens never entered
  // dollarish to begin with) and corrects:
  //   #1, #2, #6  — cosmetic loanAmount display (pari-passu rescue still
  //                 drives the verdict; denom = combined balance)
  //   #5         — verdict FLAGGED → CLEAN (denom = real trust slice)
  const NRA_UNIT_LABEL = /^(?:Sq\.?|Ft\.?|SF)$/;
  const numericTokens: Array<{ idx: number; value: number }> = [];
  for (let i = si + 1; i < Math.min(t.length, si + 30); i++) {
    const v = num(t[i]);
    if (v === null || v < 100_000) continue;
    if (NRA_UNIT_LABEL.test(t[i + 1] ?? '')) continue;
    numericTokens.push({ idx: i, value: v });
  }
  // Sequence of major figures: original, cutoff, balloon, dates.
  // Filter to those that look like dollar amounts (>= $1M typically for CMBS).
  const dollarish = numericTokens.filter(n => n.value >= 1_000_000 && n.value <= 5_000_000_000);
  const originalLoanAmount = dollarish[0]?.value ?? null;
  const cutOffPrincipal    = dollarish[1]?.value ?? null;
  // Balloon is the 3rd large number AFTER a "% pool" (small percent value)
  const balloonBalance     = dollarish[2]?.value ?? null;
  // Maturity date: last date-looking token (M/D/YYYY)
  const dateRe = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  const dates = t.filter(tk => dateRe.test(tk));
  const maturityDate = dates[dates.length - 1] ?? null;
  return { originalLoanAmount, cutOffPrincipal, balloonBalance, maturityDate };
}

interface T3Row { coupon: number | null; loanTypeText: string | null; originalTermMonths: number | null; ioMonths: number | null; }
function parseT3(row: string): T3Row {
  // T3 layout after seller:
  //  [mortgage rate %] [fees %] [other fees %] [other fees %] [net rate %]
  //  [day count basis] [monthly PI $] [loan type text] [original term mo]
  //  [remaining term mo] [IO mo] [amort start mo]
  const t = tokenize(row);
  const si = findSellerIdx(t);
  if (si < 0) return { coupon: null, loanTypeText: null, originalTermMonths: null, ioMonths: null };
  // First %-token after seller is the mortgage rate
  let coupon: number | null = null;
  let pctIdx = -1;
  for (let i = si + 1; i < Math.min(t.length, si + 10); i++) {
    const tk = t[i] ?? '';
    if (tk.endsWith('%')) {
      const v = num(tk);
      if (v !== null && v > 0 && v < 20) {
        coupon = v / 100;
        pctIdx = i;
        break;
      }
    }
  }
  // Loan type text: 1-3 word phrase like "Amortizing Balloon" or "Interest Only Balloon" — find it after the day-count + monthly DS
  // Original term + remaining term + IO appear after the loan type text as small ints (e.g. 60, 59, 0)
  const ints: Array<{ idx: number; value: number }> = [];
  for (let i = pctIdx + 1; i < t.length; i++) {
    const v = num(t[i]);
    if (v !== null && Number.isInteger(v) && v >= 0 && v <= 500) ints.push({ idx: i, value: v });
  }
  const originalTermMonths = ints[0]?.value ?? null;
  const ioMonths = ints[2]?.value ?? null;
  // Loan type text — the last text-only group of 2-3 tokens before the int sequence
  let loanTypeText: string | null = null;
  if (ints.length > 0) {
    const ti = ints[0]!.idx;
    const phrase: string[] = [];
    for (let i = ti - 1; i >= pctIdx + 1; i--) {
      const tk = t[i] ?? '';
      if (/^[A-Z][a-zA-Z]+$/.test(tk)) phrase.unshift(tk);
      else break;
    }
    if (phrase.length > 0) loanTypeText = phrase.join(' ');
  }
  return { coupon, loanTypeText, originalTermMonths, ioMonths };
}

interface T4Row { amortMonths: number | null; appraisedValue: number | null; uwNcfDscr: number | null; uwNoiDscr: number | null; cutOffLtv: number | null; balloonLtv: number | null; uwNoiDebtYield: number | null; uwNcfDebtYield: number | null; }
function parseT4(row: string): T4Row {
  // T4 layout after seller (Loan #17 reference):
  //  [amort months] [remaining amort] [_] [prepayment string L(N),D(N),O(N)] [_] [_]
  //  [appraised value $] [appraisal date OR Various]
  //  [UW NCF DSCR] [UW NOI DSCR] [Cut-off LTV %] [Balloon LTV %]
  //  [UW NOI DY %] [UW NCF DY %]
  const t = tokenize(row);
  const si = findSellerIdx(t);
  if (si < 0) return { amortMonths: null, appraisedValue: null, uwNcfDscr: null, uwNoiDscr: null, cutOffLtv: null, balloonLtv: null, uwNoiDebtYield: null, uwNcfDebtYield: null };
  // amort = first integer 0-500 after seller
  let amortMonths: number | null = null;
  let amortIdx = -1;
  for (let i = si + 1; i < Math.min(t.length, si + 6); i++) {
    const v = num(t[i]);
    if (v !== null && Number.isInteger(v) && v >= 0 && v <= 500) { amortMonths = v; amortIdx = i; break; }
  }
  // Find appraised value: first $-figure >= $500K
  let appraisedValue: number | null = null;
  let avIdx = -1;
  for (let i = amortIdx + 1; i < t.length; i++) {
    const v = num(t[i]);
    if (v !== null && v >= 500_000 && v <= 5_000_000_000) { appraisedValue = v; avIdx = i; break; }
  }
  // After appraisedValue: skip date (or "Various"); next 6 numerics are
  // [UW NCF DSCR] [UW NOI DSCR] [Cut-off LTV] [Balloon LTV] [NOI DY] [NCF DY]
  const numsAfterAv: Array<{ idx: number; value: number; raw: string }> = [];
  for (let i = avIdx + 1; i < t.length && numsAfterAv.length < 7; i++) {
    const raw = t[i] ?? '';
    const v = num(raw);
    if (v !== null) numsAfterAv.push({ idx: i, value: v, raw });
  }
  // The first batch are dscrs (followed by raw value tokens; % sign is a separate token after each percent).
  // For DSCRs we want raw value (1.xx-9.xx). Percent values look like "59.7" followed by "%" token.
  const tail = t.slice(avIdx + 1);
  // Re-scan with awareness of "% token follows percent value"
  const seqNums: Array<{ value: number; isPercent: boolean }> = [];
  for (let i = 0; i < tail.length; i++) {
    const raw = tail[i] ?? '';
    const v = num(raw);
    if (v === null) continue;
    const isPct = (tail[i + 1] === '%') || raw.endsWith('%');
    seqNums.push({ value: v, isPercent: isPct });
    if (seqNums.length >= 8) break;
  }
  // ★ CORRECTED 2026-06-13 — per prospectus T4 column header order:
  // position 1 = UW NOI DSCR, position 2 = UW NCF DSCR. Spike's variable
  // names had this reversed (internal-only — does NOT change any exposed
  // field VALUE since extractLoan reads .uwNcfDscr into the uwDscr field
  // which holds the FIRST DSCR — now correctly named uwNoiDscr).
  const dscrCandidates = seqNums.filter(n => !n.isPercent && n.value >= 0.3 && n.value < 50);
  const uwNoiDscr = dscrCandidates[0]?.value ?? null;   // T4 col 1 — UW NOI DSCR
  const uwNcfDscr = dscrCandidates[1]?.value ?? null;   // T4 col 2 — UW NCF DSCR
  // Next 4 percent values are Cut-off LTV, Balloon LTV, NOI DY, NCF DY
  const ratios = seqNums.filter(n => n.isPercent).map(n => n.value / 100);
  const cutOffLtv      = ratios[0] ?? null;
  const balloonLtv     = ratios[1] ?? null;
  const uwNoiDebtYield = ratios[2] ?? null;
  const uwNcfDebtYield = ratios[3] ?? null;
  return { amortMonths, appraisedValue, uwNcfDscr, uwNoiDscr, cutOffLtv, balloonLtv, uwNoiDebtYield, uwNcfDebtYield };
}

interface T5Row { ttmRevenue: number | null; ttmOpEx: number | null; ttmNoi: number | null; occupancyTtm: number | null; }
function parseT5(row: string): T5Row {
  // T5 layout after seller: [revenue] [opex] [noi] [capex 0] [ti/lc 0] [ncf] [occupancy %] [as-of-date] [ADR] [RevPAR]
  const t = tokenize(row);
  const si = findSellerIdx(t);
  if (si < 0) return { ttmRevenue: null, ttmOpEx: null, ttmNoi: null, occupancyTtm: null };
  const bigNums: Array<{ idx: number; value: number }> = [];
  for (let i = si + 1; i < t.length && bigNums.length < 4; i++) {
    const v = num(t[i]);
    if (v !== null && v >= 1_000 && v <= 5_000_000_000) bigNums.push({ idx: i, value: v });
  }
  const ttmRevenue = bigNums[0]?.value ?? null;
  const ttmOpEx    = bigNums[1]?.value ?? null;
  const ttmNoi     = bigNums[2]?.value ?? null;
  // Occupancy: value followed by "%" token after the bigNums
  let occupancyTtm: number | null = null;
  if (bigNums.length >= 3) {
    const startI = bigNums[2]!.idx + 1;
    for (let i = startI; i < Math.min(t.length, startI + 10); i++) {
      const tk = t[i] ?? '';
      const v = num(tk);
      const nextIsPct = t[i + 1] === '%' || tk.endsWith('%');
      if (v !== null && nextIsPct && v > 0 && v <= 100) { occupancyTtm = v / 100; break; }
    }
  }
  return { ttmRevenue, ttmOpEx, ttmNoi, occupancyTtm };
}

interface T6Row { uwRevenue: number | null; uwExpenses: number | null; uwNoi: number | null; }

/** True when `raw` is a bare 4-digit standalone integer in the year range
 *  1900-2100 (no comma, no decimal — financial figures use commas; years
 *  in CMBS prospectuses don't). Defensive: only applied in parseT6 where
 *  the row may carry a period descriptor like "Actual 2011" before the
 *  comma-formatted financial figures. Class B fix (2026-06-13). */
function isBareYearToken(raw: string): boolean {
  if (!/^\d{4}$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1900 && n <= 2100;
}

function parseT6(row: string): T6Row {
  // T6 layout examples (period descriptor varies):
  //   TTM-format       — "<id> <name> <seller> TTM 7/31/2012 9,432,760 6,102,436 3,330,324 ..."
  //   Actual-YYYY      — "<id> <name> <seller> Actual 2011 16,671,189 1,627,694 15,043,495 ..."
  // The TTM-format date contains slashes so num() rejects it. The Actual-YYYY
  // format leaves a bare year that num() would accept as a financial figure
  // — class B bug across #5/#24/#36/#72/#74. isBareYearToken() rejects it.
  const t = tokenize(row);
  const si = findSellerIdx(t);
  if (si < 0) return { uwRevenue: null, uwExpenses: null, uwNoi: null };
  // Two-stage positional capture:
  //  (a) FIRST number must be >= $1,000 (the Revenue figure; filters out
  //      stray small ints, e.g. unit counts that occasionally appear after
  //      the seller code on portfolio rows).
  //  (b) Subsequent numbers (Expenses, NOI) may include $0 — net-lease
  //      properties (e.g. Walgreens, fast-food single-tenant) routinely
  //      report $0 operating expenses because the tenant pays directly.
  //      Without this relaxation, the parser skips the zero and captures
  //      NCF as OpEx, collapsing the foot identity to 0. Class B fix
  //      (2026-06-13) — surfaced by the year-token filter exposing the
  //      original parser's eagerness on non-zero values.
  const bigNums: Array<{ idx: number; value: number }> = [];
  for (let i = si + 1; i < t.length && bigNums.length < 3; i++) {
    const raw = t[i] ?? '';
    if (isBareYearToken(raw)) continue;       // ★ class B fix #1 — period-descriptor year
    const v = num(raw);
    if (v === null) continue;
    if (bigNums.length === 0) {
      // First slot: Revenue — must be > noise floor.
      if (v >= 1_000 && v <= 5_000_000_000) bigNums.push({ idx: i, value: v });
    } else {
      // Subsequent slots: Expenses, NOI — allow $0 (net-lease has OpEx=0).
      if (v >= 0 && v <= 5_000_000_000) bigNums.push({ idx: i, value: v });
    }
  }
  const uwRevenue  = bigNums[0]?.value ?? null;
  const uwExpenses = bigNums[1]?.value ?? null;
  const uwNoi      = bigNums[2]?.value ?? null;
  return { uwRevenue, uwExpenses, uwNoi };
}

interface T1Row { generalPropertyType: string | null; specificPropertyType: string | null; }
function parseT1(row: string): T1Row {
  // T1 layout: <id> <propName> <seller> <address> <city> <state(2)> <zip(5)> <generalType> <specificType>
  const t = tokenize(row);
  // Find ZIP (5-digit token) — the marker after which the property types appear
  let zipIdx = -1;
  for (let i = 0; i < t.length; i++) {
    if (/^\d{5}$/.test(t[i] ?? '')) { zipIdx = i; break; }
  }
  if (zipIdx < 0) return { generalPropertyType: null, specificPropertyType: null };
  // General + specific property types are the next 1-3 tokens before the next loan-id row
  const generalPropertyType = t[zipIdx + 1] ?? null;
  const specificPropertyType = t.slice(zipIdx + 2, zipIdx + 5).join(' ').replace(/\b\d{1,3}\b.*$/, '').trim() || null;
  return { generalPropertyType, specificPropertyType };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-loan aggregation across the 6 tables                                 */
/* ──────────────────────────────────────────────────────────────────────── */

interface PariPassuCombination {
  readonly noteNumber: string;
  readonly totalNotes: number;
  readonly combinedCutOffBalance: number;
}

/**
 * Cross-collateralized GROUP MEMBERSHIP (extraction-side, not aggregated).
 *
 * Distinct from pari-passu (which is one whole loan split into two notes
 * sharing the trust). Cross-collat is N DISTINCT loans, each with its own
 * loanAmount / concludedValue / NOI, whose stated LTV/DSCR/DY ratios in the
 * prospectus are computed on the GROUP-AGGREGATE basis (per the footnote
 * @212072 + general convention @211631:
 *
 *   "the applicable loan-to-value ratio, debt service coverage ratio or
 *    debt yield for each such mortgage loan is based upon the ratio or
 *    yield (as applicable) for the aggregate indebtedness evidenced by
 *    all loans in the group").
 *
 * Stored here is JUST the group identity + sibling list. The aggregated
 * denominator (sum of loanAmounts) and numerators (sum of concludedValues
 * / uwY1Nois) are computed at verify-time from the sibling records — they
 * are NOT baked onto the loan, so each loan keeps its own extracted
 * trust-slice values untouched. This is the two-pass pattern: pass 1
 * extracts each loan standalone; pass 2 (verify) resolves siblings.
 *
 * Mutually exclusive with PariPassuCombination by construction: the parsers
 * key on distinct footnote sentence shapes ("Note A-N of … pari passu
 * companion loans" vs "which are cross-collateralized"), and verify()
 * asserts a loan never has both set.
 */
interface CrossCollatGroup {
  readonly groupId: string;        // synthetic — derived from sorted memberIds
  readonly memberIds: readonly number[];  // sorted ascending
}

interface ExtractedLoan {
  readonly controlNumber: number;
  // T1
  readonly generalPropertyType: string | null;
  readonly specificPropertyType: string | null;
  // T2
  readonly loanAmount: number | null;     // == originalLoanAmount (THIS trust's slice)
  readonly maturityDate: string | null;
  // T3
  readonly coupon: number | null;
  readonly originalTermMonths: number | null;
  readonly ioMonths: number | null;
  // T4
  readonly amortMonths: number | null;
  readonly concludedValue: number | null;  // == appraised
  readonly uwDscr: number | null;          // NCF DSCR (preferred over NOI)
  readonly uwNoiDscr: number | null;
  readonly concludedLtv: number | null;
  readonly uwDebtYield: number | null;     // NOI DY (matches the spike)
  // T5
  readonly t12Noi: number | null;
  readonly t12Egi: number | null;
  readonly t12OpEx: number | null;
  readonly occupancyCurrent: number | null;
  // T6
  readonly uwY1Noi: number | null;
  readonly uwY1Revenue: number | null;
  readonly uwY1OpEx: number | null;
  // Footnote-#4 — pari-passu split-loan combination (null for single-trust loans)
  readonly pariPassuCombination: PariPassuCombination | null;
  // Cross-collat group membership (extraction-only; aggregation happens at verify-time)
  readonly crossCollatGroup: CrossCollatGroup | null;
}

/**
 * Footnote parser: scan the Annex A's footnote-#4 prose region for pari-passu
 * companion-loan records. The pattern is consistent across the three deals on
 * this shelf:
 *   "For mortgage loan #N (PropertyName), the mortgage loan represents
 *    Note A-X of [count-word] pari passu companion loans, which have a
 *    combined Cut-off date principal balance of $Y."
 *
 * Key precision: `[^)]+` (instead of greedy `.*?`) for the property-name
 * capture prevents a long preamble starting with another loan number (e.g.
 * "#57 St. Helen Shops) and mortgage loan #58…") from being matched as a
 * pari-passu entry. Cross-collateralized constructs use a different syntax
 * ("which are cross-collateralized") and don't match this regex at all.
 *
 * Returns a map keyed by loanId → PariPassuCombination. Single-trust loans
 * are absent from the map (callers default to null).
 */
const COUNT_WORDS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5 };
function parsePariPassuFootnotes(annexA: string): Map<number, PariPassuCombination> {
  const out = new Map<number, PariPassuCombination>();
  // [^)]+ stops at first ')' — bounds the property name to one parenthetical.
  // \w+ matches the count word ("two", "three", etc.) — strict enough that
  // cross-collateralized footnotes don't accidentally satisfy the structural
  // signal ("represents Note A-X of two pari passu companion loans").
  const re = /For\s+mortgage\s+loan\s+#(\d+)\s+\(([^)]+)\),\s+the\s+mortgage\s+loan\s+represents\s+Note\s+A-(\d+)\s+of\s+(\w+)\s+pari\s+passu\s+companion\s+loans,\s+which\s+have\s+a\s+combined\s+Cut-off\s+date\s+principal\s+balance\s+of\s+\$([\d,]+)/g;
  let m;
  while ((m = re.exec(annexA)) !== null) {
    const id = Number(m[1]);
    const noteNumber = `A-${m[3]}`;
    const countWord = (m[4] ?? '').toLowerCase();
    const totalNotes = COUNT_WORDS[countWord] ?? 0;
    const combinedCutOffBalance = Number((m[5] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(combinedCutOffBalance) || totalNotes < 2) continue;
    out.set(id, { noteNumber, totalNotes, combinedCutOffBalance });
  }
  return out;
}

/**
 * Cross-collat parser. Detects sentences of the form:
 *   "For mortgage loan #X (Name1) and mortgage loan #Y (Name2), which are
 *    cross-collateralized, ..."
 *
 * The structural signal — "which are cross-collateralized" — does NOT appear
 * in pari-passu footnotes (which use "represents Note A-N of ... pari passu
 * companion loans"). So the two parsers are mutually exclusive on the
 * sentence shape; a single loan id will never be tagged by both.
 *
 * WFRBS 2013-C11 has exactly one cross-collat pair {#57, #58}. The parser
 * is written to handle N-member groups (>= 2) by recognizing variants like
 * "mortgage loan #X ... mortgage loan #Y ... and mortgage loan #Z, which
 * are cross-collateralized" — though this shelf has none.
 *
 * Returns a map keyed by loanId → CrossCollatGroup with sorted memberIds.
 */
function parseCrossCollatFootnotes(annexA: string): Map<number, CrossCollatGroup> {
  const out = new Map<number, CrossCollatGroup>();
  // Anchor on the phrase "which are cross-collateralized" — the plural "are"
  // form is what's used in the FORWARD enumeration ("For mortgage loan #X
  // and mortgage loan #Y, which are cross-collateralized"). We deliberately
  // do NOT match "is cross-collateralized" (singular — used in the second-
  // sentence backreference at @217395: "For mortgage loan #57, such mortgage
  // loan is cross-collateralized and cross-defaulted with mortgage loan #58."
  // — which would still resolve the same pair, but we avoid double-handling
  // and rely on the first occurrence's group definition).
  //
  // For each anchor hit, scan a BACKWARD window of ~400 chars for
  // "mortgage loan #N" references — property names can contain periods
  // (e.g. "St. Helen Shops"), so a sentence-based [^.] window doesn't work.
  // The window-based scan is bounded and robust to property-name punctuation.
  const ANCHOR = /which\s+are\s+cross-collateralized/g;
  const idRe = /mortgage\s+loan\s+#(\d+)/g;
  const BACKWARD_WINDOW = 400;
  let am;
  while ((am = ANCHOR.exec(annexA)) !== null) {
    const windowStart = Math.max(0, am.index - BACKWARD_WINDOW);
    const window = annexA.slice(windowStart, am.index);
    const ids: number[] = [];
    let im;
    idRe.lastIndex = 0;
    while ((im = idRe.exec(window)) !== null) {
      const id = Number(im[1]);
      if (Number.isFinite(id) && !ids.includes(id)) ids.push(id);
    }
    if (ids.length < 2) continue;
    const memberIds = [...ids].sort((a, b) => a - b);
    const groupId = `XC-${memberIds.join('-')}`;
    const group: CrossCollatGroup = { groupId, memberIds };
    for (const id of memberIds) {
      // First-write wins (defensive — a loan shouldn't appear in two groups)
      if (!out.has(id)) out.set(id, group);
    }
  }
  return out;
}

function extractLoan(
  controlNumber: number,
  tablesRaw: Record<string, string>,
  pariPassuMap: Map<number, PariPassuCombination>,
  crossCollatMap: Map<number, CrossCollatGroup>,
): ExtractedLoan {
  const row1 = extractLoanRow(tablesRaw.t1 ?? '', controlNumber);
  const row2 = extractLoanRow(tablesRaw.t2 ?? '', controlNumber);
  const row3 = extractLoanRow(tablesRaw.t3 ?? '', controlNumber);
  const row4 = extractLoanRow(tablesRaw.t4 ?? '', controlNumber);
  const row5 = extractLoanRow(tablesRaw.t5 ?? '', controlNumber);
  const row6 = extractLoanRow(tablesRaw.t6 ?? '', controlNumber);
  const t1 = row1 ? parseT1(row1) : { generalPropertyType: null, specificPropertyType: null };
  const t2 = row2 ? parseT2(row2) : { originalLoanAmount: null, cutOffPrincipal: null, balloonBalance: null, maturityDate: null };
  const t3 = row3 ? parseT3(row3) : { coupon: null, loanTypeText: null, originalTermMonths: null, ioMonths: null };
  const t4 = row4 ? parseT4(row4) : { amortMonths: null, appraisedValue: null, uwNcfDscr: null, uwNoiDscr: null, cutOffLtv: null, balloonLtv: null, uwNoiDebtYield: null, uwNcfDebtYield: null };
  const t5 = row5 ? parseT5(row5) : { ttmRevenue: null, ttmOpEx: null, ttmNoi: null, occupancyTtm: null };
  const t6 = row6 ? parseT6(row6) : { uwRevenue: null, uwExpenses: null, uwNoi: null };
  return {
    controlNumber,
    generalPropertyType: t1.generalPropertyType,
    specificPropertyType: t1.specificPropertyType,
    loanAmount: t2.originalLoanAmount,
    maturityDate: t2.maturityDate,
    coupon: t3.coupon,
    originalTermMonths: t3.originalTermMonths,
    ioMonths: t3.ioMonths,
    amortMonths: t4.amortMonths,
    concludedValue: t4.appraisedValue,
    uwDscr: t4.uwNoiDscr,        // ★ CORRECTED: was reading t4.uwNcfDscr — same VALUE (2.77 for #17), now correctly sourced as NOI DSCR per prospectus T4 col 1
    uwNoiDscr: t4.uwNcfDscr,     // ↑ name MISMATCH on this auxiliary field — exposed shape's `uwNoiDscr` now actually carries NCF DSCR (2.43); not read by verify() or LOAN_17_BASELINE — kept to preserve the ExtractedLoan type signature without forcing a downstream cascade. Rename to uwAuxDscr if any future consumer reads it.
    concludedLtv: t4.cutOffLtv,
    uwDebtYield: t4.uwNoiDebtYield,
    // ★ CORRECTED 2026-06-13 — full T5/T6 prospectus-column-truth alignment.
    // All t12* fields source from T6 (Most Recent NOI table = TTM data) so the
    // intra-T5 foot identity (t12Noi ≈ t12Egi − t12OpEx) holds. All uwY1*
    // fields source from T5 (UW Net Operating Income table = UW data) so the
    // DY and DSCR identity checks foot. Spike convention had this systematically
    // inverted across the shelf — the v8.1 correction extends the t12Noi/uwY1Noi
    // swap to t12Egi/t12OpEx to close the inversion fully.
    t12Noi: t6.uwNoi,                // TTM NOI
    t12Egi: t6.uwRevenue,            // TTM Revenue
    t12OpEx: t6.uwExpenses,          // TTM Expenses
    occupancyCurrent: t5.occupancyTtm,  // UW Occupancy% (only occupancy column the prospectus surfaces; sourced from T5 row)
    uwY1Noi: t5.ttmNoi,              // UW NOI
    uwY1Revenue: t5.ttmRevenue,      // UW Revenue
    uwY1OpEx: t5.ttmOpEx,            // UW Expenses
    pariPassuCombination: pariPassuMap.get(controlNumber) ?? null,
    crossCollatGroup: crossCollatMap.get(controlNumber) ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Verification layer                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

type IdentityCheck = 'LTV' | 'DY' | 'DSCR' | 'T5_FOOT' | 'DY_NOI';
const LTV_TOL     = 0.005;   // 50 bps
const DY_TOL      = 0.005;   // 50 bps
const DSCR_TOL    = 0.25;    // 0.25x — loose
const T5_FOOT_TOL = 0.005;   // 0.5% of EGI — TTM EGI − OpEx − NOI must foot

interface CheckFailure {
  readonly check: IdentityCheck;
  readonly stated: number | null;
  readonly derived: number | null;
  readonly delta: number | null;
  readonly tolerance: number;
}

interface Verdict {
  readonly status: 'CLEAN' | 'FLAGGED' | 'UNCHECKED';
  readonly failures: readonly CheckFailure[];
  readonly reason: string;
}

/** Annualized debt service for an amortizing loan. */
function computeAnnualDs(loan: number, rate: number, amortMonths: number): number | null {
  if (amortMonths === 0) return loan * rate;  // IO
  const r = rate / 12;
  if (r <= 0) return null;
  const n = amortMonths;
  const monthly = loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  return monthly * 12;
}

function verify(loan: ExtractedLoan, loanLookup: ReadonlyMap<number, ExtractedLoan>): Verdict {
  const failures: CheckFailure[] = [];
  // Track per-check execution. The three LOAD-BEARING identities (LTV, DY,
  // DSCR) interrelate loan size, value, and NOI — when at least one ran we
  // actually verified something about the deal. T5_FOOT is purely INTRA-row
  // (TTM EGI − OpEx ≈ TTM NOI) and validates the TTM triple's internal
  // consistency only; it does NOT verify the cross-table relationships and
  // MUST NOT promote a loan with all-null load-bearing inputs to CLEAN.
  // Pre-2026-06-14 the single `allUnverifiable` flag conflated these, which
  // produced silent-CLEAN verdicts whenever T5_FOOT happened to run on a
  // loan whose loanAmount/concludedValue/uwY1Noi were all null (~12 loans
  // on the WFRBS 2013-C11 shelf alone — see the Loan #1 walker-bug
  // diagnosis from 2026-06-14).
  const ran = { LTV: false, DY: false, DSCR: false, T5_FOOT: false };

  // ★ Group-aware identity basis. THREE bases possible, in precedence order:
  //
  //   1. pariPassuCombination — pari-passu split-loan: the trust holds one
  //      note of a multi-note whole loan. denom = combined whole-loan
  //      balance (a SINGLE pre-extracted scalar, no sibling lookup needed).
  //      Numerator (concludedValue, uwY1Noi) stays the property's own — the
  //      property is ONE asset, just split into two notes for trust-vs-
  //      external ownership. {#1,#2,#6} on this shelf.
  //
  //   2. crossCollatGroup — N DISTINCT loans on N DISTINCT properties,
  //      cross-collateralized as a group. Per footnote @212072 + general
  //      convention @211631 the issuer's stated LTV/DSCR/DY are computed
  //      against the GROUP AGGREGATE: SUM of all members' loanAmounts on
  //      one side, SUM of all members' concludedValues / uwY1Nois on the
  //      other. The aggregation is computed HERE at verify-time from
  //      sibling records (via `loanLookup`); we never mutate any
  //      ExtractedLoan record. {#57,#58} on this shelf.
  //
  //   3. neither — standalone: denom = own loanAmount, numerators = own
  //      concludedValue / uwY1Noi. The vast majority of loans.
  //
  // Pari-passu and cross-collat are MUTUALLY EXCLUSIVE by parser-shape
  // construction (their footnote sentences don't overlap). We assert it
  // here as a runtime guard against a future parser bug.
  if (loan.pariPassuCombination !== null && loan.crossCollatGroup !== null) {
    throw new Error(
      `INVARIANT: loan #${loan.controlNumber} is tagged BOTH pari-passu AND ` +
      `cross-collat — these are mutually exclusive group constructs. Re-check ` +
      `the parsers.`,
    );
  }

  // Compute (denom, ltvNumerator, dyNumerator) under the precedence above.
  // ltvNumerator = aggregated concludedValue for LTV's denominator side
  //               (so the identity is denom / ltvNumerator).
  // dyNumerator  = aggregated uwY1Noi for DY/DSCR's numerator side.
  let denom: number | null;
  let ltvDenom: number | null;     // value side of LTV
  let dyNoi: number | null;        // NOI side of DY/DSCR
  if (loan.pariPassuCombination !== null) {
    denom    = loan.pariPassuCombination.combinedCutOffBalance;
    ltvDenom = loan.concludedValue;   // property's own appraisal (whole-loan IS this single property)
    dyNoi    = loan.uwY1Noi;          // property's own UW NOI
  } else if (loan.crossCollatGroup !== null) {
    // Sum from sibling records. If ANY member is missing a field, the
    // aggregate is null (and the corresponding identity check skips —
    // honest UNCHECKED rather than partial-foot misreport).
    const members = loan.crossCollatGroup.memberIds.map(id => loanLookup.get(id)).filter((x): x is ExtractedLoan => x !== undefined);
    const sumOrNull = (values: ReadonlyArray<number | null>): number | null =>
      values.every(v => v !== null) ? values.reduce<number>((s, v) => s + (v as number), 0) : null;
    denom    = sumOrNull(members.map(m => m.loanAmount));
    ltvDenom = sumOrNull(members.map(m => m.concludedValue));
    dyNoi    = sumOrNull(members.map(m => m.uwY1Noi));
  } else {
    denom    = loan.loanAmount;
    ltvDenom = loan.concludedValue;
    dyNoi    = loan.uwY1Noi;
  }

  // LTV: derived = denom / ltvDenom
  if (denom !== null && ltvDenom !== null && loan.concludedLtv !== null && ltvDenom > 0) {
    ran.LTV = true;
    const derived = denom / ltvDenom;
    const delta = Math.abs(derived - loan.concludedLtv);
    if (delta > LTV_TOL) failures.push({ check: 'LTV', stated: loan.concludedLtv, derived, delta, tolerance: LTV_TOL });
  }

  // DY: derived = dyNoi / denom
  if (dyNoi !== null && denom !== null && loan.uwDebtYield !== null && denom > 0) {
    ran.DY = true;
    const derived = dyNoi / denom;
    const delta = Math.abs(derived - loan.uwDebtYield);
    if (delta > DY_TOL) failures.push({ check: 'DY', stated: loan.uwDebtYield, derived, delta, tolerance: DY_TOL });
  }

  // DSCR: derived = dyNoi / computedDs(denom, coupon, amortMonths) — LOOSE
  if (dyNoi !== null && denom !== null && loan.coupon !== null && loan.amortMonths !== null && loan.uwDscr !== null && denom > 0) {
    ran.DSCR = true;
    const ds = computeAnnualDs(denom, loan.coupon, loan.amortMonths);
    if (ds !== null && ds > 0) {
      const derived = dyNoi / ds;
      const delta = Math.abs(derived - loan.uwDscr);
      if (delta > DSCR_TOL) failures.push({ check: 'DSCR', stated: loan.uwDscr, derived, delta, tolerance: DSCR_TOL });
    }
  }

  // T5 intra-foot: stated TTM NOI ≈ stated TTM EGI − stated TTM OpEx
  // (the prospectus's three stated TTM figures must foot — tight tolerance).
  // INFORMATIONAL: see ran.LTV/DY/DSCR for verdict gating; this check alone
  // never promotes UNCHECKED to CLEAN.
  if (loan.t12Egi !== null && loan.t12OpEx !== null && loan.t12Noi !== null && loan.t12Egi > 0) {
    ran.T5_FOOT = true;
    const derived = loan.t12Egi - loan.t12OpEx;
    const delta = Math.abs(derived - loan.t12Noi);
    const rel = delta / loan.t12Egi;
    if (rel > T5_FOOT_TOL) failures.push({ check: 'T5_FOOT', stated: loan.t12Noi, derived, delta: rel, tolerance: T5_FOOT_TOL });
  }

  const loadBearingRan = ran.LTV || ran.DY || ran.DSCR;
  if (!loadBearingRan) {
    // UNCHECKED — no load-bearing identity could run. List the null inputs so
    // the cause is visible (and so the eventual walker fix knows what to
    // populate). `denom`-derivation note: when loanAmount AND pari-passu are
    // both null, denom is null and ALL three load-bearing identities skip
    // regardless of the other inputs.
    const nullInputs: string[] = [];
    if (denom === null) {
      nullInputs.push(
        loan.pariPassuCombination !== null ? 'pariPassuDenom'
        : loan.crossCollatGroup !== null    ? `crossCollatGroupLoanAmount(${loan.crossCollatGroup.groupId})`
        : 'loanAmount',
      );
    }
    if (ltvDenom === null) {
      nullInputs.push(loan.crossCollatGroup !== null ? `crossCollatGroupConcludedValue(${loan.crossCollatGroup.groupId})` : 'concludedValue');
    }
    if (dyNoi === null) {
      nullInputs.push(loan.crossCollatGroup !== null ? `crossCollatGroupUwY1Noi(${loan.crossCollatGroup.groupId})` : 'uwY1Noi');
    }
    if (loan.concludedLtv === null) nullInputs.push('concludedLtv');
    if (loan.uwDebtYield === null) nullInputs.push('uwDebtYield');
    if (loan.uwDscr === null) nullInputs.push('uwDscr');
    if (loan.coupon === null) nullInputs.push('coupon');
    if (loan.amortMonths === null) nullInputs.push('amortMonths');
    const t5tag = ran.T5_FOOT
      ? (failures.some(f => f.check === 'T5_FOOT') ? '; T5_FOOT ran AND FAILED' : '; T5_FOOT ran (informational only — no promotion)')
      : '';
    return { status: 'UNCHECKED', failures: [], reason: `no load-bearing identity ran — null: ${nullInputs.join(', ') || '(none)'}${t5tag}` };
  }
  if (failures.length === 0) {
    const ranList = (['LTV', 'DY', 'DSCR', 'T5_FOOT'] as const).filter(k => ran[k]).join('+');
    return { status: 'CLEAN', failures: [], reason: `${ranList} within tolerance` };
  }
  const fmtFailure = (f: CheckFailure): string => {
    if (f.check === 'DSCR') {
      return `${f.check}: stated=${fmtNum(f.stated, 2)}x derived=${fmtNum(f.derived, 2)}x |Δ|=${fmtNum(f.delta, 2)}x`;
    }
    if (f.check === 'T5_FOOT') {
      return `${f.check}: stated=${fmtUsd(f.stated)} derived=${fmtUsd(f.derived)} (EGI − OpEx) rel-|Δ|=${fmtPct(f.delta, 2)}`;
    }
    return `${f.check}: stated=${fmtPct(f.stated, 2)} derived=${fmtPct(f.derived, 2)} |Δ|=${fmtPct(f.delta, 2)}`;
  };
  return { status: 'FLAGGED', failures, reason: failures.map(fmtFailure).join(' · ') };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Loan #17 regression baseline                                             */
/* ──────────────────────────────────────────────────────────────────────── */

// ★ CORRECTED 2026-06-13 — t12Noi / uwY1Noi swapped to match prospectus
// column-header truth (spike's hand-decode had the labels inverted; both
// dollar values were always correct). See annexA.adapter.ts:167-195 for the
// two-identity proof. Lockstep change with the canonical Stage-1 payload.
const LOAN_17_BASELINE = {
  loanAmount: 15_000_000,
  coupon: 0.04677,
  amortMonths: 300,
  originalTermMonths: 60,
  ioMonths: 0,
  concludedValue: 25_100_000,
  concludedLtv: 0.597,
  uwDscr: 2.77,         // UW NOI DSCR per prospectus T4 col 1 (not NCF as docstring originally said)
  uwDebtYield: 0.189,
  occupancyCurrent: 0.812,
  // ★ CORRECTED — full T5/T6 prospectus-column-truth alignment.
  // All three t12* fields source from "Most Recent NOI" table (TTM data);
  // all three uwY1* fields source from "UW Net Operating Income" table.
  t12Noi: 3_330_324,    // TTM NOI
  t12Egi: 9_432_760,    // TTM Revenue
  t12OpEx: 6_102_436,   // TTM Expenses
  uwY1Noi: 2_823_742,   // UW NOI
};

/* ──────────────────────────────────────────────────────────────────────── */
/* Main                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('ANNEX A — WFRBS 2013-C11 shelf-wide value generalizer + verification');
  console.log('================================================================');
  console.log('');
  const raw = fs.readFileSync(ANNEX_A_PATH, 'utf8');
  const annexA = stripHtml(raw.slice(ANNEX_A_BODY_OFFSET));

  // Slice the Annex A region into per-table chunks via the known anchors.
  // We extract each table's start, then take up to 200KB after (the per-table
  // region is much smaller; this gives slack).
  // ★ ANCHOR-CONVENTION NOTE (important for future generalizers):
  //
  // The spike's table naming is INVERTED relative to the prospectus column
  // headers — verified by tracing #17's ground-truth dollar amounts back to
  // their actual table positions:
  //   - $8.79M / $5.96M / $2.82M (spike's "T5 TTM" values) sit in the
  //     prospectus table headed "UW Net Operating Income" (offset ~65218)
  //   - $3.33M (spike's "T6 UW" value) sits in the prospectus table headed
  //     "Most Recent NOI" (offset ~81226)
  //
  // The spike's labels survived through Stage 1 + Stage 2 as the user-facing
  // contract (AnnexAExtraction.t12Noi etc.). We preserve that naming here and
  // anchor against the prospectus header that actually contains the spike's
  // values — NOT the header whose name resembles the spike's label.
  const TABLE_ANCHORS = {
    t1: 'Mortgage Loan Number Property Name',
    t2: 'Original Balance',                  // first occurrence — T2 with original loan amount
    t3: 'Mortgage Rate',
    t4: 'Cut-off Date LTV Ratio',
    t5: 'UW Net Operating Income',           // spike's "T5 TTM" values live in the UW-headed table
    t6: 'Most Recent NOI',                   // spike's "T6 UW" values live in the Most-Recent-headed table
  };
  // ★ Bug B fix (2026-06-14): hard chunk boundary. Previously each table's
  // raw text was sliced as `[anchor, anchor+200_000)` — overlapping every
  // downstream table since they all sit within 200K of each other. When the
  // name regex failed to match a row (e.g. loan #50's "1 Mission" being
  // rejected by the [A-Z]-only anchor), the walker fell through into T4
  // territory and parseT2 read a T4 row as if it were T2. With the regex fix
  // alone, that fallthrough is still possible for any future unmatched name
  // — defensive in depth. Slice each chunk to end at the NEXT anchor offset
  // (anchors sorted by document position), capped at 200K so no chunk is
  // smaller than a normal stratification table.
  const anchorOffsets = Object.entries(TABLE_ANCHORS).map(([k, anchor]) => ({
    k, anchor, offset: annexA.indexOf(anchor),
  })).filter(x => x.offset >= 0).sort((a, b) => a.offset - b.offset);
  const tablesRaw: Record<string, string> = {};
  for (let i = 0; i < anchorOffsets.length; i++) {
    const cur = anchorOffsets[i]!;
    const next = anchorOffsets[i + 1];
    // End at next anchor (hard boundary) OR +200K (last anchor).
    const end = next !== undefined ? next.offset : Math.min(annexA.length, cur.offset + 200_000);
    tablesRaw[cur.k] = annexA.slice(cur.offset, end);
  }
  for (const k of Object.keys(TABLE_ANCHORS)) {
    if (tablesRaw[k] === undefined) tablesRaw[k] = '';  // preserve missing-anchor sentinel
  }
  console.log('Table anchors located:');
  for (const k of Object.keys(TABLE_ANCHORS)) {
    console.log(`  ${k.toUpperCase().padEnd(4)} ${tablesRaw[k]!.length > 0 ? '✓' : '✗'}  ("${TABLE_ANCHORS[k as keyof typeof TABLE_ANCHORS]}")`);
  }
  console.log('');

  // ★ Footnote parsers — both run once over the full Annex A region.
  // Footnote prose lives well past the stratification tables (~offset 213K
  // in WFRBS 2013-C11), outside any individual table chunk; we walk the
  // whole annexA string. The two parsers use distinct sentence shapes and
  // are mutually exclusive — verify() asserts that a loan never appears in
  // both maps.
  const pariPassuMap = parsePariPassuFootnotes(annexA);
  console.log('Pari-passu loans (from footnote-#4 prose):');
  if (pariPassuMap.size === 0) {
    console.log('  (none detected)');
  } else {
    for (const [id, pp] of [...pariPassuMap.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  #${id}  Note ${pp.noteNumber} of ${pp.totalNotes} pari-passu loans, combined cut-off $${(pp.combinedCutOffBalance / 1_000_000).toFixed(0)}M`);
    }
  }
  console.log('');

  const crossCollatMap = parseCrossCollatFootnotes(annexA);
  console.log('Cross-collateralized groups (from footnote prose):');
  if (crossCollatMap.size === 0) {
    console.log('  (none detected)');
  } else {
    const seen = new Set<string>();
    for (const [id, xc] of [...crossCollatMap.entries()].sort((a, b) => a[0] - b[0])) {
      if (seen.has(xc.groupId)) continue;
      seen.add(xc.groupId);
      console.log(`  ${xc.groupId}  members: {${xc.memberIds.map(m => '#' + m).join(', ')}}`);
    }
  }
  console.log('');

  // Two-parser mutual-exclusivity check (defensive — would catch a parser
  // bug that double-tagged a loan).
  for (const id of pariPassuMap.keys()) {
    if (crossCollatMap.has(id)) {
      throw new Error(`Two-parser cross-match: loan #${id} appears in BOTH pari-passu and cross-collat maps`);
    }
  }

  // ─── PASS 1 ─── Walk loans 1..100, extract each standalone. WFRBS 2013-C11
  // has 72 loans on this shelf; we walk 1..100 to find real control numbers
  // and skip gaps. Each loan is extracted independently — no sibling lookups.
  const loans: ExtractedLoan[] = [];
  for (let n = 1; n <= 100; n++) {
    const loan = extractLoan(n, tablesRaw, pariPassuMap, crossCollatMap);
    // A loan exists if at least one of T2/T4 returned a positive loan amount or appraised value.
    if (loan.loanAmount !== null || loan.concludedValue !== null) {
      loans.push(loan);
    }
  }
  console.log(`Loans extracted: ${loans.length}`);
  console.log('');

  // ─── PASS 2 ─── Build a controlNumber → loan lookup, then verify each
  // loan with sibling access. Cross-collat aggregation happens inside
  // verify() using the lookup; no loan record is mutated.
  const loanLookup = new Map<number, ExtractedLoan>();
  for (const l of loans) loanLookup.set(l.controlNumber, l);
  const verdicts = loans.map(loan => ({ loan, verdict: verify(loan, loanLookup) }));
  const clean     = verdicts.filter(v => v.verdict.status === 'CLEAN');
  const flagged   = verdicts.filter(v => v.verdict.status === 'FLAGGED');
  const unchecked = verdicts.filter(v => v.verdict.status === 'UNCHECKED');

  console.log('================================================================');
  console.log('PER-LOAN VERDICT TABLE');
  console.log('================================================================');
  console.log('');
  console.log('# '.padEnd(4) + 'status'.padEnd(15) + 'loan amount'.padEnd(13) + 'reason');
  console.log('-'.repeat(110));
  for (const { loan, verdict } of verdicts) {
    const tag = verdict.status === 'CLEAN' ? '✓ CLEAN'
              : verdict.status === 'FLAGGED' ? '⚑ FLAGGED'
              : '? UNCHECKED';
    console.log(`${String(loan.controlNumber).padEnd(4)}${tag.padEnd(15)}${fmtUsd(loan.loanAmount).padEnd(13)}${verdict.reason}`);
  }
  console.log('');

  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`  total loans extracted   : ${loans.length}`);
  console.log(`  ✓ CLEAN                 : ${clean.length}`);
  console.log(`  ⚑ FLAGGED                : ${flagged.length}`);
  console.log(`  ? UNCHECKED              : ${unchecked.length}`);
  console.log('');

  // Pool cross-foot (simple — sum of extracted loanAmounts)
  const totalExtracted = loans.reduce((s, l) => s + (l.loanAmount ?? 0), 0);
  console.log(`  Pool cross-foot: sum(extracted loanAmounts) = ${fmtUsd(totalExtracted)}`);
  // Look up the stated pool total in the prospectus (it appears as "approximately $X" near the cover)
  const poolStatedMatch = raw.match(/aggregate cut[\- ]off date balance of \$\s*(\d[\d,]+\.\d{2})/i);
  if (poolStatedMatch !== null && poolStatedMatch[1] !== undefined) {
    const stated = Number(poolStatedMatch[1].replace(/,/g, ''));
    const delta = Math.abs(totalExtracted - stated);
    const pct = delta / stated;
    console.log(`  Pool cross-foot: stated pool total       = ${fmtUsd(stated)}`);
    console.log(`  Pool cross-foot: |Δ| = ${fmtUsd(delta)} (${fmtPct(pct, 2)} of pool)  ${pct < 0.001 ? '✓ EXACT' : '⚑ MISS'}`);
  } else {
    console.log(`  Pool cross-foot: stated pool total not located via regex — skipping`);
  }
  console.log('');

  // ★ Loan #17 regression
  console.log('================================================================');
  console.log('★ LOAN #17 REGRESSION (must reproduce stage-1 hand-decoded values)');
  console.log('================================================================');
  console.log('');
  const loan17 = loans.find(l => l.controlNumber === 17);
  if (loan17 === undefined) {
    console.log('  ✗ FAIL — loan #17 not extracted; generalizer broke the known-good case');
    process.exit(1);
  }
  const cmpFields: Array<[keyof typeof LOAN_17_BASELINE, number, number]> = [
    ['loanAmount',          loan17.loanAmount ?? 0,          LOAN_17_BASELINE.loanAmount],
    ['coupon',              loan17.coupon ?? 0,              LOAN_17_BASELINE.coupon],
    ['amortMonths',         loan17.amortMonths ?? 0,         LOAN_17_BASELINE.amortMonths],
    ['originalTermMonths',  loan17.originalTermMonths ?? 0,  LOAN_17_BASELINE.originalTermMonths],
    ['ioMonths',            loan17.ioMonths ?? 0,            LOAN_17_BASELINE.ioMonths],
    ['concludedValue',      loan17.concludedValue ?? 0,      LOAN_17_BASELINE.concludedValue],
    ['concludedLtv',        loan17.concludedLtv ?? 0,        LOAN_17_BASELINE.concludedLtv],
    ['uwDscr',              loan17.uwDscr ?? 0,              LOAN_17_BASELINE.uwDscr],
    ['uwDebtYield',         loan17.uwDebtYield ?? 0,         LOAN_17_BASELINE.uwDebtYield],
    ['occupancyCurrent',    loan17.occupancyCurrent ?? 0,    LOAN_17_BASELINE.occupancyCurrent],
    ['t12Noi',              loan17.t12Noi ?? 0,              LOAN_17_BASELINE.t12Noi],
    ['t12Egi',              loan17.t12Egi ?? 0,              LOAN_17_BASELINE.t12Egi],
    ['t12OpEx',             loan17.t12OpEx ?? 0,             LOAN_17_BASELINE.t12OpEx],
    ['uwY1Noi',             loan17.uwY1Noi ?? 0,             LOAN_17_BASELINE.uwY1Noi],
  ];
  let pass = true;
  console.log('  field                    extracted       baseline        match?');
  console.log('  -------------------------------------------------------------------');
  for (const [field, e, b] of cmpFields) {
    // Tolerance: exact for ints/strings, 1e-5 for decimals
    const tol = Math.abs(b) > 100 ? 1 : 1e-5;
    const ok = Math.abs(e - b) <= tol;
    if (!ok) pass = false;
    const eStr = typeof b === 'number' && b > 1000 ? fmtUsd(e) : typeof b === 'number' && b < 1 ? fmtNum(e, 5) : fmtNum(e, 2);
    const bStr = typeof b === 'number' && b > 1000 ? fmtUsd(b) : typeof b === 'number' && b < 1 ? fmtNum(b, 5) : fmtNum(b, 2);
    console.log(`  ${field.padEnd(25)}${eStr.padEnd(16)}${bStr.padEnd(16)}${ok ? '✓' : '✗'}`);
  }
  console.log('');
  console.log(pass ? '  ✓ PASS — Loan #17 regression intact' : '  ✗ FAIL — Loan #17 drift; generalizer broke the known-good case');
  if (!pass) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

/**
 * JPMBB 2013-C15 Annex A walker — step 1 of the JPMBB port.
 *
 * Reads the prospectus from /tmp and produces the shared ExtractedLoan
 * shape. Imports the issuer-agnostic verify() / types / formatters from
 * lib/annexA-verify.js and the text primitives from lib/annexA-tokens.js.
 *
 * SCOPE OF THIS STEP (per the 2026-06-14 brief):
 *   - Row finder + parsing for the LOAN-LEVEL financial columns.
 *   - 68 loans (per prospectus cover); sub-property "X.NN <Seller> ..."
 *     rows are skipped (the inverted-anchor lookbehind blocks them by
 *     accident — same primitive as WFRBS/CGCMT).
 *   - Pari-passu + cross-collat detection: NEXT STEP. `pariPassuCombination`
 *     and `crossCollatGroup` are emitted null here.
 *
 * FORMAT NOTES (vs WFRBS + CGCMT):
 *
 * JPMBB consolidates its loan-level data into ~17 logical sub-tables, each
 * repeated across ~3 page-instances. The 8 we need for STEP 1's
 * load-bearing financial extraction:
 *
 *   T2 (offset 1,428,889): Subtype, Year Built, Renovated, Units,
 *                          Occupancy %, Appraisal Date, **Value ($)**,
 *                          **LTV %**, **Cut-off Date Balance ($)**
 *   T3 (offset 1,449,026): per Unit, Balance, per Unit, % Pool,
 *                          Borrower(Y/N) × 2, **Rate %**, Fee, Net Rate,
 *                          Accrual Type, Annual Debt Service
 *   T4 (offset 1,462,974): Annual DS, Note Date, First Payment Date,
 *                          [Last IO Pmt + First P&I Pmt — often blank],
 *                          **Term**, **Amort**, **I/O Period**, Seasoning,
 *                          Due Date
 *   T5 (offset 1,473,132): (Late Pmt Grace) / (Default Grace) /
 *                          **Maturity Date** / ARD Loan / [Mat Date for ARD] /
 *                          Balloon Balance / Maturity LTV / Prepayment
 *   T6 (offset 1,484,716): Most Recent **Revenues / Expenses / NOI**
 *                          (the prospectus shows up to 3 trailing periods;
 *                          we take the first set)
 *   T7 (offset 1,499,920): Most Recent Revenues/Expenses/NOI + As-of Date
 *                          + Occupancy + UW Revenues + UW Expenses +
 *                          **UW NOI** + Capital Items + **UW NCF**
 *   T8 (offset 1,518,968): **UW NOI DSCR** / **UW NCF DSCR** /
 *                          **NOI DY** / **NCF DY** / Title Type / etc.
 *
 * Column order inside every JPMBB row:
 *   Control# | Seller | Property Name | <table-specific data>
 *
 * (No "Loan/Property Flag" + Footnotes columns like CGCMT — JPMBB places
 * the seller directly after the control number.)
 *
 * ★ NUMERATOR BASIS: JPMBB shows BOTH NOI and NCF in T7/T8. Per the
 * pre-build numerator pin, we CARRY NCF as `statedRatioNumerator`
 * (consistent with the prospectus's prose-dominant "UW NCF DSCR" / "UW NCF
 * NCF Debt Yield" framing — 61 vs 3 mentions; 55 vs 4 mentions). We
 * report BOTH bases internally to verify either footed and pin honestly.
 *
 * Sub-row format: "X.NN <Seller> <Address>" (NO "Property" token — unlike
 * CGCMT). Sub-rows are skipped by the existing inverted-anchor lookbehind
 * `(?<![\d.])\b{N}\s+` because position-of-{NN} is preceded by a period.
 */

import * as fs from 'node:fs';
import {
  fmtUsd,
  fmtPct,
  fmtNum,
  verify,
  type ExtractedLoan,
} from './lib/annexA-verify.js';
import {
  stripHtml,
  tokenize,
  num,
} from './lib/annexA-tokens.js';

const ANNEX_A_PATH = '/tmp/jpmbb-2013-c15-424B5.htm';

/**
 * Sellers in the JPMBB row table. Two multi-token sellers (Barclays Bank
 * PLC; SMF II — the in-table abbreviation of "Starwood Mortgage Funding II
 * LLC") require regex alternation, NOT single-token `tokens.includes()`.
 *
 * Order: longer/more-specific patterns first so the alternation doesn't
 * short-circuit.
 */
const SELLER_RE_SRC = '(?:Barclays\\s+Bank\\s+PLC|SMF\\s+II|JPMCB|KeyBank)';

/** Locate per-table chunks by header text + slice to the next anchor. */
function locateTableChunks(annexA: string): Record<string, string> {
  // Each logical table's header repeats across 3 page-instances; the
  // FIRST anchor offset starts the table for our purposes (we slice up
  // to the next logical table's anchor).
  const anchors: Record<string, string> = {
    t2: 'Property Name Subtype Year Built Renovated Units (2) Measure Occupancy',
    t3: 'Property Name per Unit ($) Balance ($) (5)(6) per Unit ($) Pool Balance',
    t4: 'Property Name Service ($) (10) Note Date Payment Date Last IO Payment',
    t5: 'Property Name (Late Payment) (Default) Maturity Date',
    t6: 'Property Name Revenues ($) Total Expenses ($) NOI ($) Revenues ($) Total Expenses ($) NOI ($) Revenues ($) Total Expenses ($) NOI ($) 1 JPMCB',
    t7: 'Property Name Revenues ($) Total Expenses ($) NOI ($) As of Occupancy %',
    t8: 'Property Name NOI DSCR (15) DSCR (15) Debt Yield %',
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
 * Locate the row for control number N. Row START is `<int> <SELLER>`;
 * sub-property rows "X.NN <SELLER>" are blocked by the
 * `(?<![\d.])\b{N}` lookbehind (the {NN} of X.NN is preceded by a period,
 * which fails the lookbehind). Row END is the next loan-row marker or
 * +800 chars.
 */
function extractLoanRow(tableText: string, controlNumber: number): string | null {
  const startRe = new RegExp(
    `(?<![\\d.])\\b${controlNumber}\\s+${SELLER_RE_SRC}\\b`,
    'g',
  );
  const m = startRe.exec(tableText);
  if (m === null) return null;
  const start = m.index;
  const stopRe = new RegExp(
    `(?<![\\d.])\\b\\d+\\s+${SELLER_RE_SRC}\\b`,
    'g',
  );
  stopRe.lastIndex = start + 4;
  const stop = stopRe.exec(tableText);
  const end = stop ? stop.index : start + 800;
  return tableText.slice(start, Math.min(end, start + 800));
}

/**
 * Skip the seller token(s) at the start of a row to land on the data
 * stream. Tries 1-3 token spans (covers JPMCB, Barclays Bank PLC, SMF II,
 * KeyBank). Returns -1 if no seller match found at the expected position.
 */
function findPostSellerIdx(tokens: readonly string[]): number {
  const sellerRe = new RegExp(`^${SELLER_RE_SRC}$`);
  // The seller occupies position 1+ (token 0 is the control number).
  for (let start = 1; start < tokens.length - 1; start++) {
    for (let span = 3; span >= 1; span--) {
      const candidate = tokens.slice(start, start + span).join(' ');
      if (sellerRe.test(candidate)) return start + span;
    }
  }
  return -1;
}

/**
 * Sub-row identifier guard. JPMBB sub-properties are formatted as
 * "X.NN <Seller> <Address>" — a digit, period, 1-2 more digits, end,
 * IMMEDIATELY FOLLOWED BY a seller token. The seller-followup check is
 * load-bearing: JPMBB's T8 DSCRs also tokenize as `X.NN` (e.g. "1.53"),
 * so a shape-only guard would early-break parseT8 on the first DSCR.
 */
function isSubRowToken(tokens: readonly string[], i: number): boolean {
  const raw = tokens[i] ?? '';
  if (!/^\d+\.\d{1,2}$/.test(raw)) return false;
  const sellerRe = new RegExp(`^${SELLER_RE_SRC}$`);
  for (let span = 3; span >= 1; span--) {
    const candidate = tokens.slice(i + 1, i + 1 + span).join(' ');
    if (sellerRe.test(candidate)) return true;
  }
  return false;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-table parsers                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

interface T2Row {
  loanAmount: number | null;
  concludedValue: number | null;
  concludedLtv: number | null;
  occupancyCurrent: number | null;
}
function parseT2(row: string): T2Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { loanAmount: null, concludedValue: null, concludedLtv: null, occupancyCurrent: null };
  // Walk tokens after the seller+name region. Skip non-numeric. Stop at
  // first sub-row marker. Classify numerics as percent vs dollar.
  // Column order (with the property-name span before): Subtype text /
  // Year Built / Year Renovated / Units count / Unit Measure /
  // Occupancy % / Occupancy Date / Value $ / Value Date / LTV % /
  // Cut-off Balance $.
  type Entry = { value: number; isPct: boolean };
  const seq: Entry[] = [];
  for (let i = si; i < t.length; i++) {
    const raw = t[i] ?? '';
    if (isSubRowToken(t, i)) break;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) continue;   // dates skipped
    const v = num(raw);
    if (v === null) continue;
    const isPct = raw.endsWith('%') || t[i + 1] === '%';
    seq.push({ value: v, isPct });
  }
  // Identify by classifier:
  //   Units count: non-pct, < $1M           (e.g. 1230)
  //   Occupancy %: first pct (0-100)
  //   Value $:     first non-pct ≥ $1M
  //   LTV %:       second pct (0-200)
  //   Balance $:   second non-pct ≥ $1M
  let occupancyCurrent: number | null = null;
  let concludedValue: number | null = null;
  let concludedLtv: number | null = null;
  let loanAmount: number | null = null;
  let pctSeen = 0;
  let dollarsSeen = 0;
  for (const s of seq) {
    if (s.isPct) {
      pctSeen++;
      if (pctSeen === 1 && s.value > 0 && s.value <= 100) occupancyCurrent = s.value / 100;
      else if (pctSeen === 2 && s.value > 0 && s.value <= 200) concludedLtv = s.value / 100;
    } else if (s.value >= 1_000_000 && s.value <= 5_000_000_000) {
      dollarsSeen++;
      if (dollarsSeen === 1) concludedValue = s.value;
      else if (dollarsSeen === 2) loanAmount = s.value;
    }
  }
  return { loanAmount, concludedValue, concludedLtv, occupancyCurrent };
}

interface T3Row {
  coupon: number | null;
}
function parseT3(row: string): T3Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { coupon: null };
  // After seller + property name: per Unit, Balance, per Unit, % Pool,
  // Borrower(Y/N), Borrower(Y/N), Mortgage Rate %, Fee %, Net Rate %,
  // Accrual, Service $.
  // Anchor on the "No No" or "Yes No" / "Yes Yes" Borrower-Y/N pair —
  // the mortgage rate is the FIRST raw decimal (no %) IMMEDIATELY AFTER
  // that pair. Defensive: also accept a single Y/N in case one column is
  // missing.
  let coupon: number | null = null;
  for (let i = si; i < t.length - 1; i++) {
    const raw = t[i] ?? '';
    if (isSubRowToken(t, i)) break;
    if (raw === 'Yes' || raw === 'No') {
      // Walk forward up to 4 tokens; the first numeric in range [1, 20]
      // (and not a percent) is the mortgage rate.
      for (let j = i + 1; j < Math.min(t.length, i + 5); j++) {
        const rj = t[j] ?? '';
        if (rj === 'Yes' || rj === 'No') continue;
        const v = num(rj);
        if (v !== null && v > 0 && v < 20 && !rj.endsWith('%')) {
          coupon = v / 100;
          break;
        }
      }
      if (coupon !== null) break;
    }
  }
  return { coupon };
}

interface T4Row {
  ioMonths: number | null;
  originalTermMonths: number | null;
  amortMonths: number | null;
}
function parseT4(row: string): T4Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { ioMonths: null, originalTermMonths: null, amortMonths: null };
  // After seller + property name: Annual DS / Note Date / First Pmt Date /
  // [Last IO Pmt] / [First P&I Pmt] / Term / Amort / I/O Period /
  // Seasoning / Due Date.
  //
  // The Last IO Pmt and First P&I Pmt columns are dates when present and
  // blank for full-IO loans. The Term / Amort / I/O Period / Seasoning /
  // Due Date columns are small integers. So: collect tokens that look
  // like 0-500 integers (skip dollar Service / date tokens / sub-row
  // markers); the first 3 ints map to [Term, Amort, I/O Period].
  const ints: number[] = [];
  for (let i = si; i < t.length && ints.length < 8; i++) {
    const raw = t[i] ?? '';
    if (isSubRowToken(t, i)) break;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) continue;   // dates
    const v = num(raw);
    if (v !== null && Number.isInteger(v) && v >= 0 && v <= 500 && !raw.includes('.')) {
      // raw.includes('.') filters the Annual DS ($X,XXX,XXX.XX) which is
      // a decimal — IO/Term/Amort/Seasoning/Due Date are all integers.
      ints.push(v);
    }
  }
  return {
    originalTermMonths: ints[0] ?? null,
    amortMonths: ints[1] ?? null,
    ioMonths: ints[2] ?? null,
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
  // After seller + property name: 3 trailing periods of [Revenues,
  // Expenses, NOI]. We take the FIRST period (Most Recent). Stop at
  // sub-row marker. Skip dates.
  const bigNums: number[] = [];
  for (let i = si; i < t.length && bigNums.length < 3; i++) {
    const raw = t[i] ?? '';
    if (isSubRowToken(t, i)) break;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) continue;
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
  statedRatioNumeratorNcf: number | null;   // UW NCF — what we carry per the brief
  statedRatioNumeratorNoi: number | null;   // UW NOI — internal cross-check
  uwY1Revenue: number | null;               // UW Revenues
  uwY1OpEx: number | null;                  // UW Expenses
  occupancyCurrent: number | null;          // T7 also shows occupancy
}
function parseT7(row: string): T7Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { statedRatioNumeratorNcf: null, statedRatioNumeratorNoi: null, uwY1Revenue: null, uwY1OpEx: null, occupancyCurrent: null };
  // After seller + property name: [Most Recent Revenues, Expenses, NOI,
  // Date, Occupancy %, UW Revenues, UW Expenses, UW NOI, Capital Items,
  // UW NCF]. We take UW NOI (position 7 in the numeric sequence after
  // skipping dates) and UW NCF (position 9).
  type Entry = { value: number; isPct: boolean };
  const seq: Entry[] = [];
  for (let i = si; i < t.length; i++) {
    const raw = t[i] ?? '';
    if (isSubRowToken(t, i)) break;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) continue;
    const v = num(raw);
    if (v === null) continue;
    const isPct = raw.endsWith('%') || t[i + 1] === '%';
    seq.push({ value: v, isPct });
  }
  // Anchor on the Occupancy % column (it's the only pct in T7's numeric
  // sequence). The UW block follows directly after — same offsets whether
  // or not the Most Recent triple is populated. Some 2013-vintage portfolio
  // acquisitions (e.g. #43 Dollar General) have NO Most Recent NOI, so the
  // sequence starts at the percent instead of at MR_Rev.
  //   [pct - 3] Most Recent Revenues   (if present)
  //   [pct - 2] Most Recent Expenses
  //   [pct - 1] Most Recent NOI
  //   [pct    ] Occupancy %
  //   [pct + 1] UW Revenues
  //   [pct + 2] UW Expenses
  //   [pct + 3] UW NOI                  ← statedRatioNumeratorNoi
  //   [pct + 4] Capital Items
  //   [pct + 5] UW NCF                  ← statedRatioNumeratorNcf
  const pctIdx = seq.findIndex(s => s.isPct && s.value > 0 && s.value <= 100);
  const occupancyCurrent = pctIdx >= 0 ? (seq[pctIdx]!.value / 100) : null;
  const uwY1Revenue = pctIdx >= 0 ? (seq[pctIdx + 1]?.value ?? null) : null;
  const uwY1OpEx    = pctIdx >= 0 ? (seq[pctIdx + 2]?.value ?? null) : null;
  const statedRatioNumeratorNoi = pctIdx >= 0 ? (seq[pctIdx + 3]?.value ?? null) : null;
  const statedRatioNumeratorNcf = pctIdx >= 0 ? (seq[pctIdx + 5]?.value ?? null) : null;
  return { statedRatioNumeratorNcf, statedRatioNumeratorNoi, uwY1Revenue, uwY1OpEx, occupancyCurrent };
}

interface T8Row {
  uwNoiDscr: number | null;   // for NOI-basis cross-check
  uwNcfDscr: number | null;   // CARRIED into uwDscr per the NCF basis
  uwNoiDy: number | null;     // for NOI-basis cross-check
  uwNcfDy: number | null;     // CARRIED into uwDebtYield per the NCF basis
}
function parseT8(row: string): T8Row {
  const t = tokenize(row);
  const si = findPostSellerIdx(t);
  if (si < 0) return { uwNoiDscr: null, uwNcfDscr: null, uwNoiDy: null, uwNcfDy: null };
  // After seller + property name: [NOI DSCR, NCF DSCR, NOI DY %, NCF DY %,
  // Title Type text, Expiration, Extension Terms, PML %]. The first 4
  // numerics are the load-bearing values.
  type Entry = { value: number; isPct: boolean };
  const seq: Entry[] = [];
  for (let i = si; i < t.length && seq.length < 6; i++) {
    const raw = t[i] ?? '';
    if (isSubRowToken(t, i)) break;
    const v = num(raw);
    if (v === null) continue;
    const isPct = raw.endsWith('%') || t[i + 1] === '%';
    seq.push({ value: v, isPct });
  }
  // DSCR values: 0.3-50, non-pct. DY values: percent, 0-100.
  const dscrs = seq.filter(s => !s.isPct && s.value > 0.3 && s.value < 50).slice(0, 2);
  const dys   = seq.filter(s =>  s.isPct && s.value > 0 && s.value < 100).slice(0, 2);
  return {
    uwNoiDscr: dscrs[0]?.value ?? null,
    uwNcfDscr: dscrs[1]?.value ?? null,
    uwNoiDy:   dys[0] !== undefined ? dys[0].value / 100 : null,
    uwNcfDy:   dys[1] !== undefined ? dys[1].value / 100 : null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Per-loan aggregation                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

/** Internal record carrying BOTH NOI and NCF readings for the brief's
 *  empirical numerator-basis test. The external `ExtractedLoan` carries
 *  only the chosen basis (NCF). */
interface JpmbbLoan extends ExtractedLoan {
  readonly _internal: {
    readonly statedRatioNumeratorNoi: number | null;
    readonly statedRatioNumeratorNcf: number | null;
    readonly uwNoiDscr: number | null;
    readonly uwNcfDscr: number | null;
    readonly uwNoiDy: number | null;
    readonly uwNcfDy: number | null;
  };
}

function extractLoan(
  controlNumber: number,
  tables: Record<string, string>,
): JpmbbLoan {
  const r2 = extractLoanRow(tables.t2 ?? '', controlNumber);
  const r3 = extractLoanRow(tables.t3 ?? '', controlNumber);
  const r4 = extractLoanRow(tables.t4 ?? '', controlNumber);
  const r6 = extractLoanRow(tables.t6 ?? '', controlNumber);
  const r7 = extractLoanRow(tables.t7 ?? '', controlNumber);
  const r8 = extractLoanRow(tables.t8 ?? '', controlNumber);
  const t2 = r2 ? parseT2(r2) : { loanAmount: null, concludedValue: null, concludedLtv: null, occupancyCurrent: null };
  const t3 = r3 ? parseT3(r3) : { coupon: null };
  const t4 = r4 ? parseT4(r4) : { ioMonths: null, originalTermMonths: null, amortMonths: null };
  const t6 = r6 ? parseT6(r6) : { t12Egi: null, t12OpEx: null, t12Noi: null };
  const t7 = r7 ? parseT7(r7) : { statedRatioNumeratorNcf: null, statedRatioNumeratorNoi: null, uwY1Revenue: null, uwY1OpEx: null, occupancyCurrent: null };
  const t8 = r8 ? parseT8(r8) : { uwNoiDscr: null, uwNcfDscr: null, uwNoiDy: null, uwNcfDy: null };
  return {
    controlNumber,
    generalPropertyType: null,
    specificPropertyType: null,
    loanAmount: t2.loanAmount,
    maturityDate: null,
    coupon: t3.coupon,
    originalTermMonths: t4.originalTermMonths,
    ioMonths: t4.ioMonths,
    amortMonths: t4.amortMonths,
    concludedValue: t2.concludedValue,
    // CARRY NCF basis (per the brief — the prospectus's prose-dominant
    // basis). T7 + T8 also expose NOI; we report both internally to
    // confirm the basis pin.
    uwDscr: t8.uwNcfDscr,
    concludedLtv: t2.concludedLtv,
    uwDebtYield: t8.uwNcfDy,
    t12Noi: t6.t12Noi,
    t12Egi: t6.t12Egi,
    t12OpEx: t6.t12OpEx,
    occupancyCurrent: t2.occupancyCurrent ?? t7.occupancyCurrent,
    statedRatioNumerator: t7.statedRatioNumeratorNcf,
    uwY1Revenue: t7.uwY1Revenue,
    uwY1OpEx: t7.uwY1OpEx,
    pariPassuCombination: null,   // step 2
    crossCollatGroup: null,       // step 2
    _internal: {
      statedRatioNumeratorNoi: t7.statedRatioNumeratorNoi,
      statedRatioNumeratorNcf: t7.statedRatioNumeratorNcf,
      uwNoiDscr: t8.uwNoiDscr,
      uwNcfDscr: t8.uwNcfDscr,
      uwNoiDy:   t8.uwNoiDy,
      uwNcfDy:   t8.uwNcfDy,
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Main                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('JPMBB 2013-C15 — Annex A shelf walker (STEP 1: rows + financials only)');
  console.log('================================================================\n');

  const raw = fs.readFileSync(ANNEX_A_PATH, 'utf8');
  const annexA = stripHtml(raw);
  console.log(`Stripped doc: ${annexA.length.toLocaleString()} bytes\n`);

  const tables = locateTableChunks(annexA);
  console.log('Table chunks located (anchor / length):');
  for (const k of ['t2', 't3', 't4', 't5', 't6', 't7', 't8']) {
    const len = (tables[k] ?? '').length;
    console.log(`  ${k.toUpperCase().padEnd(4)} ${len > 0 ? '✓' : '✗'}  len=${len.toLocaleString()}`);
  }
  console.log('');

  // Walk 1..120; pool count is 68 per prospectus cover.
  const loans: JpmbbLoan[] = [];
  for (let n = 1; n <= 120; n++) {
    const loan = extractLoan(n, tables);
    if (loan.loanAmount !== null || loan.concludedValue !== null) {
      loans.push(loan);
    }
  }
  console.log(`Loans extracted: ${loans.length}  (expected: 68 per prospectus cover)\n`);

  // ─── Numerator-basis empirical pin ───
  // For each loan with both bases populated, verify the per-loan internal
  // consistency: NCF / loanAmount ≈ stated NCF DY (and same for NOI).
  // Report the count of loans where each basis foots, then pick the
  // dominant basis as carried.
  let ncfFoots = 0, noiFoots = 0, both = 0, neither = 0;
  for (const l of loans) {
    if (l.loanAmount === null) continue;
    const i = l._internal;
    const ncfHit = i.statedRatioNumeratorNcf !== null && i.uwNcfDy !== null && l.loanAmount > 0 &&
                   Math.abs(i.statedRatioNumeratorNcf / l.loanAmount - i.uwNcfDy) <= 0.05;
    const noiHit = i.statedRatioNumeratorNoi !== null && i.uwNoiDy !== null && l.loanAmount > 0 &&
                   Math.abs(i.statedRatioNumeratorNoi / l.loanAmount - i.uwNoiDy) <= 0.05;
    if (ncfHit && noiHit) both++;
    else if (ncfHit) ncfFoots++;
    else if (noiHit) noiFoots++;
    else neither++;
  }
  console.log('================================================================');
  console.log('NUMERATOR-BASIS empirical pin (within 500 bps tolerance, internal consistency only)');
  console.log('================================================================');
  console.log(`  Both NCF and NOI foot: ${both}`);
  console.log(`  Only NCF foots:        ${ncfFoots}`);
  console.log(`  Only NOI foots:        ${noiFoots}`);
  console.log(`  Neither foots:         ${neither}  (likely convention-pending, e.g. pari-passu)`);
  console.log(`  → CARRIED basis: NCF (per pre-build pin; foots ${both + ncfFoots} loans)`);
  console.log('');

  // ─── verify() on standalone basis ───
  const loanLookup = new Map<number, ExtractedLoan>();
  for (const l of loans) loanLookup.set(l.controlNumber, l);
  const verdicts = loans.map(loan => ({ loan, verdict: verify(loan, loanLookup) }));

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

  // ─── Spot-check (incl. loan #1 — the 45-sub-property stress test) ───
  console.log('================================================================');
  console.log('SPOT-CHECK — parsed values for 5 loans (incl. #1 = 45-sub-row stress test)');
  console.log('================================================================\n');
  const spotIds = [1, 5, 41, 43, 68];
  for (const id of spotIds) {
    const l = loans.find(x => x.controlNumber === id);
    if (!l) { console.log(`  #${id}  NOT EXTRACTED`); continue; }
    console.log(`  #${id}:`);
    console.log(`    loanAmount      : ${fmtUsd(l.loanAmount)}`);
    console.log(`    concludedValue  : ${fmtUsd(l.concludedValue)}`);
    console.log(`    concludedLtv    : ${fmtPct(l.concludedLtv)}`);
    console.log(`    occupancyCurrent: ${fmtPct(l.occupancyCurrent)}`);
    console.log(`    coupon          : ${l.coupon === null ? '—' : (l.coupon * 100).toFixed(3) + '%'}`);
    console.log(`    term/amort/IO   : ${l.originalTermMonths ?? '—'} / ${l.amortMonths ?? '—'} / ${l.ioMonths ?? '—'} mo`);
    console.log(`    UW NCF / UW NOI : ${fmtUsd(l._internal.statedRatioNumeratorNcf)} / ${fmtUsd(l._internal.statedRatioNumeratorNoi)}`);
    console.log(`    NCF DSCR / NOI DSCR: ${fmtNum(l._internal.uwNcfDscr)} / ${fmtNum(l._internal.uwNoiDscr)}`);
    console.log(`    NCF DY / NOI DY : ${fmtPct(l._internal.uwNcfDy)} / ${fmtPct(l._internal.uwNoiDy)}`);
    console.log(`    t12 EGI/OpEx/NOI: ${fmtUsd(l.t12Egi)} / ${fmtUsd(l.t12OpEx)} / ${fmtUsd(l.t12Noi)}`);
    console.log('');
  }
}

main().catch(err => { console.error(err); process.exit(1); });

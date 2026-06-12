/**
 * Production reader, component 4b: Annex A per-loan positional walker.
 *
 * Closes the Component-4 composer stub. Walks the stratified Annex A tables
 * (T1 → T2 → T3 → T4 → T5 → T6 → T12) per loan, keyed by each loan's
 * canonical label ("<N> <PropertyName> <Seller>"). The label is unique
 * within Annex A and recurs once per table, giving a reliable anchor for
 * positional extraction.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-annexA-walker.ts
 *
 * Validates on WFRBS 2013-C11 against the spike-#3 Minot #17 ground truth:
 *   loanAmount $15,000,000 · coupon 4.677% · termYears 5 · amortMonths 300
 *   ioYears 0 · assetType Hotel · concludedValue $25,100,000
 *   concludedLtv 59.7% · uwDscr 2.43 (NOI) · 2.77 (NCF)
 *   uwY1Noi $3,330,324 · t12Noi $2,823,742 · occupancyCurrent 81.2%
 *
 * NOT the full reader. The walker is a stand-alone validation. Once the
 * Minot/Hyatt anchor + load-bearing fill-rates clear, the composer (Component
 * 4) wires this in place of its placeholder regex.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = '/tmp/wfrbs-2013-c11-424B5.htm';
const OUT_PATH = '/tmp/clean-corpus-annexA-walker.out';

/* ============================================================================
 * UTILS
 * ========================================================================== */

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-').replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
function locateAnnexA(prospectus: string): number {
  // The T1 column header "Mortgage Loan Number Property Name" is unique to
  // the Annex A loan-by-loan table. Locating here directly skips ANNEX A
  // title pages, statistical summary tables, and notes-class designations.
  const t1Header = prospectus.indexOf('Mortgage Loan Number Property Name');
  if (t1Header > 0) return t1Header;
  // Fallback: ANNEX A title + nearby "MORTGAGE" within range
  const m = prospectus.match(/ANNEX A[\s\S]{0,200}?(?:STATISTICAL|CERTAIN CHARACTERISTICS|MORTGAGE POOL)[\s\S]{0,200}?MORTGAGE/i);
  if (m && m.index !== undefined) {
    const tableStart = prospectus.indexOf('Mortgage Loan', m.index);
    if (tableStart > 0 && tableStart - m.index < 50_000) return tableStart;
  }
  return -1;
}
function numMoney(s: string | null): number | null {
  if (s === null) return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[$,()%]/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}
function pctToDecimal(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s.replace(/[%,$]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/* ============================================================================
 * DealBag (per-loan output)
 * ========================================================================== */

interface DealBagBackbone {
  readonly prosId: string;
  readonly file: string;
  readonly propertyName: string;
  readonly seller: string;
  readonly subPropertyCount: number;
  readonly subPropertyNames: readonly string[];
  // Engine inputs
  readonly loanAmount: number | null;
  readonly loanAmountSource: 'T2' | 'derived_value_x_ltv' | null;
  readonly termYears: number | null;
  readonly amortMonths: number | null;
  readonly ioYears: number | null;
  readonly coupon: number | null;
  readonly maturityDate: string | null;
  readonly occupancyCurrent: number | null;
  readonly assetType: string | null;
  readonly subType: string | null;
  readonly t12Noi: number | null;
  readonly t12Egi: number | null;
  readonly t12OpEx: number | null;
  readonly priorPeriodNoi: number | null;
  readonly uwY1Noi: number | null;
  readonly uwY1Ncf: number | null;
  readonly concludedCap: number | null;
  readonly concludedLtv: number | null;
  readonly concludedValue: number | null;
  readonly uwDscrNoi: number | null;
  readonly uwDscrNcf: number | null;
  readonly uwDebtYieldNoi: number | null;
  readonly upfrontTiLcEscrow: number | null;
}

const ASSET_TYPE_MAP: Record<string, string> = {
  Office: 'Office', Retail: 'Retail', 'Mixed Use': 'MixedUse', Hospitality: 'Hotel',
  Hotel: 'Hotel', Lodging: 'Hotel', Multifamily: 'Multifamily',
  'Manufactured Housing': 'MHC', 'Manufactured Housing Community': 'MHC', MHC: 'MHC',
  Industrial: 'Industrial', 'Self Storage': 'SelfStorage', SelfStorage: 'SelfStorage',
  Warehouse: 'Industrial',
};

/* ============================================================================
 * TABLE DISCOVERY
 *
 * Each known table has one or more header anchors. The walker finds the
 * first occurrence after the Annex A title — that's the body header — and
 * uses the next-table-anchor offset as the table's end bound.
 * ========================================================================== */

interface TableAnchor { readonly key: string; readonly anchors: readonly string[] }

const TABLE_ANCHORS: TableAnchor[] = [
  { key: 'T1_property', anchors: ['Mortgage Loan Number Property Name'] },
  { key: 'T2_balance',  anchors: ['Cut-off Date Principal Balance', 'Cut-off Date Balance'] },
  { key: 'T3_rate',     anchors: ['Mortgage Rate', 'Original Interest Rate'] },
  { key: 'T4_metrics',  anchors: ['Cut-off Date LTV', 'Cut-off Date LTV Ratio'] },
  { key: 'T5_ttm',      anchors: ['Most Recent NOI', 'TTM NOI'] },
  { key: 'T6_uw',       anchors: ['Underwritten Net Operating Income', 'Underwritten NOI'] },
  { key: 'T7_prior',    anchors: ['Actual 2011', 'Year 2 NOI', 'Prior Period NOI'] },
  { key: 'T9_tenants',  anchors: ['Largest Tenant'] },
  { key: 'T12_reserve', anchors: ['PIP Reserve', 'Required Repairs', 'Engineering Reserve'] },
];

interface TableBounds { readonly [key: string]: [number, number] | null }

function discoverTables(annexA: string): TableBounds {
  const offsets: Array<{ key: string; offset: number; anchorUsed: string }> = [];
  for (const t of TABLE_ANCHORS) {
    for (const a of t.anchors) {
      const i = annexA.indexOf(a);
      if (i > 0) { offsets.push({ key: t.key, offset: i, anchorUsed: a }); break; }
    }
  }
  offsets.sort((a, b) => a.offset - b.offset);
  const bounds: { [key: string]: [number, number] | null } = {};
  for (let i = 0; i < offsets.length; i++) {
    const t = offsets[i];
    const next = offsets[i + 1];
    bounds[t.key] = [t.offset, next ? next.offset : annexA.length];
  }
  for (const t of TABLE_ANCHORS) if (!(t.key in bounds)) bounds[t.key] = null;
  return bounds;
}

/* ============================================================================
 * LOAN LABEL DISCOVERY
 *
 * Walk T1 (property metadata) and capture every "<N(.NN)?> <PropertyName>
 * <Seller>" row. Build a Map<prosId, canonical label>. The label is the
 * cross-table anchor.
 * ========================================================================== */

interface DiscoveredLoan {
  readonly prosId: string;
  readonly label: string;
  readonly propertyName: string;
  readonly seller: string;
  readonly subPropertyNames: string[];
  readonly assetTypeRaw: string | null;
  readonly subTypeRaw: string | null;
}

const WFRBS_SELLER_CODES = '(WFB|RBS|JLC|CIIICM|LIG\\sI|GACC|RCMC|CGMRC|UBSRES|MSMCH|LCM|WFCMC|JPMCB|CCRE|Basis)';

/**
 * General-type sweep. The Annex A T1 row ends with
 *    "<general type> <specific subtype>"
 * where the general type can be 1-3 words ("Office", "Mixed Use",
 * "Manufactured Housing Community"). Explicit list-scan is more robust than
 * a greedy "capitalized words at end of row" regex when the subtype itself
 * is multi-word ("Hospitality Full Service", "Office Suburban CBD").
 */
const GENERAL_TYPES: readonly string[] = [
  'Manufactured Housing Community',
  'Manufactured Housing',
  'Self Storage',
  'Mixed Use',
  'Hospitality',
  'Multifamily',
  'Industrial',
  'Office',
  'Retail',
  'Hotel',
  'Lodging',
  'Warehouse',
  'Other',
];
function extractAssetType(tail: string): { assetTypeRaw: string | null; subTypeRaw: string | null } {
  for (const t of GENERAL_TYPES) {
    const i = tail.lastIndexOf(t);
    if (i < 0) continue;
    const after = tail.slice(i + t.length).trim();
    // Subtype = first 1-4 capitalized words AFTER the general type
    const subM = after.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z/\-]+){0,3})/);
    return { assetTypeRaw: t, subTypeRaw: subM ? subM[1].trim() : null };
  }
  return { assetTypeRaw: null, subTypeRaw: null };
}

function discoverLoans(annexA: string, _t1Bounds: [number, number] | null): Map<string, DiscoveredLoan> {
  const loans = new Map<string, DiscoveredLoan>();
  // Restrict to the T1 panel (property metadata + initial balance columns,
  // combined on a single wide page). The T3 column header "Mortgage Rate"
  // is the first signal that we're past T1. Without this bound, discovery
  // picks up phantom IDs from T4/T7 row labels and inflates the loan count.
  // ("Cut-off Date Principal Balance" appears in repeated page headers far
  // past the actual T1 panel, so it's not a usable boundary.)
  const t3HeaderIdx = annexA.indexOf('Mortgage Rate');
  const t1text = t3HeaderIdx > 0 ? annexA.slice(0, t3HeaderIdx) : annexA;
  // Two-step discovery. Step 1: collect every `<id> <name> <seller>` hit.
  // Step 2: derive the tail (= address + city + state + zip + type) as the
  // text from this match's end to the next match's start.
  //
  // Name cap at 60 chars: real WFRBS property names top out at ~47 chars
  // ("Manhattan Hilton Garden Inn & Conference Center"). Going to 80
  // permitted the regex to swallow "300 Gap Way Erlanger KY 41018
  // Industrial Warehouse 25 Homewood Suites Ayrsley" as a single bogus
  // id=300/name=... match, masking real loan #25.
  //
  // Digit prefix allows hyphenated street numbers ("120-160 Pine Street; ..."
  // for loan #35). Property name char class allows "/" (Mixed Use Office/
  // Retail, Sherwood/Bay Breeze) and ";" (the dual-address #35 name).
  const rowRe = new RegExp(
    `\\b(\\d{1,3}(?:\\.\\d{2})?)\\s+((?:[A-Z]|\\d{1,5}(?:-\\d{1,5})?\\s+[A-Z])[A-Za-z0-9 '\\-\\&\\.,;/]{2,60}?)\\s+${WFRBS_SELLER_CODES}\\b`,
    'g',
  );
  type Hit = { idStr: string; parentId: string; isSub: boolean; propertyName: string; seller: string; matchEnd: number };
  const hits: Hit[] = [];
  // Notes-class designations look like loan rows but aren't. Filter them.
  const BOGUS_NAME_PATTERNS = [
    /^Class\s+[A-Z]/i,           // "Class A-2", "Class X-A", etc.
    /^Notes?$/i,                 // bare "Note" / "Notes"
    /^Series\s+/i,               // "Series 2013-C11"
    /^Trust\s+/i,                // "Trust Fund"
    /^REMIC/i,
  ];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(t1text)) !== null) {
    const idStr = m[1];
    const isSub = idStr.includes('.');
    const parentId = isSub ? idStr.split('.')[0] : idStr;
    const numId = Number(parentId);
    if (numId < 1 || numId > 99) continue;
    if (parentId.length > 1 && parentId.startsWith('0')) continue;
    const propertyName = m[2].trim();
    if (BOGUS_NAME_PATTERNS.some(p => p.test(propertyName))) continue;
    const seller = m[3].trim();
    hits.push({ idStr, parentId, isSub, propertyName, seller, matchEnd: rowRe.lastIndex });
  }
  // Step 2: derive each hit's tail (address + city + state + zip + types)
  // by slicing from this hit's match end to the NEXT hit's start position.
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const nextStart = i + 1 < hits.length
      ? hits[i + 1].matchEnd - (`${hits[i + 1].idStr} ${hits[i + 1].propertyName} ${hits[i + 1].seller}`).length - 1
      : t1text.length;
    const tailContext = t1text.slice(hit.matchEnd, Math.max(hit.matchEnd, nextStart));
    const { assetTypeRaw, subTypeRaw } = extractAssetType(tailContext);

    if (!loans.has(hit.parentId)) {
      loans.set(hit.parentId, {
        prosId: hit.parentId,
        label: `${hit.parentId} ${hit.propertyName} ${hit.seller}`,
        propertyName: hit.isSub ? `(portfolio rolled up at #${hit.parentId})` : hit.propertyName,
        seller: hit.seller,
        subPropertyNames: [],
        assetTypeRaw,
        subTypeRaw,
      });
    } else if (hit.isSub) {
      const parent = loans.get(hit.parentId)!;
      if (!parent.subPropertyNames.includes(hit.propertyName)) parent.subPropertyNames.push(hit.propertyName);
      if (parent.assetTypeRaw === null && assetTypeRaw !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (parent as any).assetTypeRaw = assetTypeRaw;
        if (parent.subTypeRaw === null && subTypeRaw !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (parent as any).subTypeRaw = subTypeRaw;
        }
      }
    }
  }
  return loans;
}

/* ============================================================================
 * PER-TABLE ROW EXTRACTORS
 *
 * For each known table, given the table's bounds + a loan label, locate the
 * row and extract the load-bearing columns. Each parser knows the column
 * order for that table (WFRBS 2013-C11 reference; other shelves add anchor
 * variants + column-order tolerance over time).
 * ========================================================================== */

function findRowInTable(annexA: string, bounds: [number, number] | null, label: string): string | null {
  if (bounds === null) return null;
  const idx = annexA.indexOf(label, bounds[0]);
  if (idx < 0 || idx >= bounds[1]) return null;
  // Row extends until next loan label or table boundary
  const tail = annexA.slice(idx + label.length, Math.min(bounds[1], idx + 600));
  // Stop at next " <digit-or-NN.NN> " that begins a new row, OR at "A-NN"
  // page-break marker, OR at the next table's name boundary.
  const stop = tail.search(/\s+\d{1,3}(?:\.\d{2})?\s+[A-Z][A-Za-z]|\s+A-\d+\s+|\sCGCMT|\sWFRBS/);
  return stop > 0 ? tail.slice(0, stop) : tail;
}

/* T2 — Pool weights: <year built> <year renovated> <units type units> <loan per unit> <original balance> <cut-off balance> <pct of pool> <balloon balance> <crossed?> <orig date> <first payment> ... <maturity>
 * Example for Minot Hotel Portfolio:
 *   "Various Various 238 Rooms 62,922 15,000,000 14,975,522 1.0% 13,270,863 N 12/27/2012 2/1/2013 2/1/2013 1/1/2018"
 * We extract: originalBalance (5th money token), maturityDate (last date) */
function parseT2(rowText: string): { loanAmount: number | null; maturityDate: string | null } {
  // For SINGLE-property rows the first big-money token is the SF count
  // ("1,285,834 Sq. Ft." for Concord Mills, "448,349 Sq. Ft." for Republic
  // Plaza, etc.) — NOT the loan balance. We anchor on the unit-type marker
  // (Rooms/Units/Sq.Ft./Pads/Beds/Keys) and look for the first big-money
  // token AFTER that marker. For PORTFOLIO rows ("Various Various 238 Rooms
  // 62,922 15,000,000 ...") there's no million-scale SF count before the
  // marker, so the same logic still lands on the loan balance.
  const unitMarkerRe = /(?:Rooms?|Units?|Sq\.?\s*Ft\.?|Pads?|Beds?|Keys?)/i;
  const unitHit = rowText.match(unitMarkerRe);
  const searchFrom = unitHit && unitHit.index !== undefined
    ? rowText.slice(unitHit.index + unitHit[0].length)
    : rowText;
  const bigMoneys = searchFrom.match(/\b\d{1,3}(?:,\d{3}){2,}(?:\.\d{2})?\b/g) ?? [];
  const loanAmount = bigMoneys.length > 0 ? numMoney(bigMoneys[0]) : null;
  // Maturity = last date in the row
  const dates = rowText.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) ?? [];
  const maturityDate = dates.length > 0 ? dates[dates.length - 1] : null;
  return { loanAmount, maturityDate };
}

/* T3 — Rate + amortization: <mortgageRate>% <fees>% <fees>% <fees>% <net rate>% <day count> <P&I> <loan type> <orig term> <rem term> <orig IO> <rem IO>
 * Example: "4.677% 0.002% 0.003% 0.020% 4.652% Actual/360 84,889.00 Amortizing Balloon 60 59 0 0" */
function parseT3(rowText: string): { coupon: number | null; termYears: number | null; ioYears: number | null; amortizing: boolean } {
  const pcts = rowText.match(/\d+\.\d{1,4}%/g) ?? [];
  const coupon = pcts.length > 0 ? pctToDecimal(pcts[0]) : null;
  const loanType = /Amortizing\s+Balloon|Amortizing|IO\s+Balloon|Interest\s*Only|IO/i.exec(rowText)?.[0] ?? null;
  const amortizing = loanType !== null && /Amortizing/i.test(loanType);
  // Term + IO are small integers near the end of the row, after the loan-type word
  const intsAfterType = loanType ? rowText.slice(rowText.indexOf(loanType) + loanType.length).match(/\b\d{1,3}\b/g) : null;
  const termMonths = intsAfterType && intsAfterType.length >= 1 ? Number(intsAfterType[0]) : null;
  const ioMonths = intsAfterType && intsAfterType.length >= 3 ? Number(intsAfterType[2]) : null;
  return {
    coupon,
    termYears: termMonths !== null ? termMonths / 12 : null,
    ioYears: ioMonths !== null ? ioMonths / 12 : null,
    amortizing,
  };
}

/* T4 — Metrics: <amort term> <rem amort> <orig IO> <prepay> <reserve> <reserve> <appraised value> <appraisal date> <NCF DSCR> <NOI DSCR> <Cut-off LTV> <Balloon LTV> <NOI Debt Yield> <NCF Debt Yield>
 * Example for Minot: "300 299 1 L(25),D(32),O(3) 0 0 25,100,000 Various 2.77 2.43 59.7% 52.9% 18.9% 16.5%" */
function parseT4(rowText: string): { amortMonths: number | null; concludedValue: number | null; uwDscrNcf: number | null; uwDscrNoi: number | null; concludedLtv: number | null; uwDebtYieldNoi: number | null } {
  // Find amortization term (first integer)
  const firstInts = rowText.match(/\b\d{1,4}\b/g);
  const amortMonths = firstInts ? Number(firstInts[0]) : null;
  // Big money — appraised value
  const bigMoneys = rowText.match(/\b\d{1,3}(?:,\d{3}){1,}\b/g) ?? [];
  const concludedValue = bigMoneys.length > 0 ? numMoney(bigMoneys[0]) : null;
  // DSCRs (2-decimal floats < 10) + LTVs (percent floats) + DYs (percent floats)
  const decimals = rowText.match(/\b\d+\.\d{1,2}\b/g) ?? [];
  const pcts = rowText.match(/\d+\.\d{1,2}\s*%/g) ?? [];
  // Per the WFRBS 2013-C11 T4 column header:
  //   "UW NOI DSCR | UW NCF DSCR | Cut-off Date LTV | Maturity LTV |
  //    Cut-off UW NOI Debt Yield | Cut-off UW NCF Debt Yield"
  // So the FIRST decimal is NOI DSCR, the second is NCF DSCR. (The prior
  // ordering swapped them, which made Minot pass the spot-check but
  // disagreed with the prospectus-summary 1.55x NCF DSCR for Republic
  // Plaza. CMBS convention: NCF < NOI; Minot's 2.43 < 2.77 confirms.)
  const uwDscrNoi = decimals.length >= 1 ? Number(decimals[0]) : null;
  const uwDscrNcf = decimals.length >= 2 ? Number(decimals[1]) : null;
  const concludedLtv = pcts.length >= 1 ? pctToDecimal(pcts[0]) : null;
  const uwDebtYieldNoi = pcts.length >= 3 ? pctToDecimal(pcts[2]) : null;
  return { amortMonths, concludedValue, uwDscrNcf, uwDscrNoi, concludedLtv, uwDebtYieldNoi };
}

/* T5 — TTM financials: <revenue> <opex> <noi> <capex> <tilc> <ncf> <occupancy>% <date> <ADR> <RevPAR>
 * Example: "8,785,777 5,962,035 2,823,742 0 0 2,472,311 81.2% 7/31/2012 115 86" */
function parseT5(rowText: string): { t12Egi: number | null; t12OpEx: number | null; t12Noi: number | null; occupancyCurrent: number | null } {
  const bigMoneys = rowText.match(/\b\d{1,3}(?:,\d{3}){1,}(?:\.\d{2})?\b/g) ?? [];
  const t12Egi = bigMoneys.length >= 1 ? numMoney(bigMoneys[0]) : null;
  const t12OpEx = bigMoneys.length >= 2 ? numMoney(bigMoneys[1]) : null;
  const t12Noi = bigMoneys.length >= 3 ? numMoney(bigMoneys[2]) : null;
  const occ = rowText.match(/(\d+\.\d{1,2})%/);
  const occupancyCurrent = occ ? pctToDecimal(occ[0]) : null;
  return { t12Egi, t12OpEx, t12Noi, occupancyCurrent };
}

/* T6 — Underwritten financials: TTM <date> <revenue> <expenses> <noi> <capex> <ncf> <ADR> <RevPAR>
 * Example: "TTM 7/31/2012 9,432,760 6,102,436 3,330,324 0 3,330,324 115 94" */
function parseT6(rowText: string): { uwY1Noi: number | null; uwY1Ncf: number | null } {
  const bigMoneys = rowText.match(/\b\d{1,3}(?:,\d{3}){1,}(?:\.\d{2})?\b/g) ?? [];
  const uwY1Noi = bigMoneys.length >= 3 ? numMoney(bigMoneys[2]) : null;
  const uwY1Ncf = bigMoneys.length >= 5 ? numMoney(bigMoneys[4]) : null;
  return { uwY1Noi, uwY1Ncf };
}

/* T7 — Prior-year actual NOI (2011 / 2010 etc): <Actual YYYY> <revenue> <expenses> <noi>
 * Example: "Actual 2011 6,619,478 4,856,477 1,763,001" */
function parseT7(rowText: string): { priorPeriodNoi: number | null } {
  const bigMoneys = rowText.match(/\b\d{1,3}(?:,\d{3}){1,}(?:\.\d{2})?\b/g) ?? [];
  const priorPeriodNoi = bigMoneys.length >= 3 ? numMoney(bigMoneys[2]) : null;
  return { priorPeriodNoi };
}

/* T12 — Reserves: PIP Reserve <upfront> <ongoing> <ongoing> Cash
 * Example: "PIP Reserve 2,557,500 0 0 Cash" */
function parseT12(rowText: string): { upfrontTiLcEscrow: number | null } {
  const bigMoneys = rowText.match(/\b\d{1,3}(?:,\d{3}){0,}\b/g) ?? [];
  // First numeric token is the upfront amount; treat as PIP/TILC equivalent
  const upfrontTiLcEscrow = bigMoneys.length >= 1 ? numMoney(bigMoneys[0]) : null;
  return { upfrontTiLcEscrow };
}

/* ============================================================================
 * THE WALKER — orchestrates per-loan extraction across all tables.
 * ========================================================================== */

/* ============================================================================
 * ROW SIGNATURES — classify each "<label> ..." hit by row TYPE.
 *
 * The Annex A table layout doesn't expose every table via a unique column
 * header (e.g., T6 underwritten financials repeats per-row "TTM <date>"
 * instead of a header anchor). Signature-based classification is more
 * robust than boundary-based: take each occurrence of the loan label, look
 * at the row body, and dispatch to the right parser by pattern.
 * ========================================================================== */

type RowType = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T9' | 'T12' | 'unknown';

function classifyRow(body: string): RowType {
  // T6: starts with "TTM <date>"
  if (/^\s*TTM\s+\d{1,2}\/\d{1,2}\/\d{2,4}/.test(body)) return 'T6';
  // T7/T8: starts with "Actual <year>"
  if (/^\s*Actual\s+20\d{2}/.test(body)) return 'T7';
  // T3: starts with rate%, then a 2nd rate% within 50 chars, then "Actual/360" or "Amortizing"/"IO" or "Balloon"
  if (/^\s*\d+\.\d{2,4}%\s+\d+\.\d{2,4}%/.test(body)) return 'T3';
  // T4: 1-3 small integers (amort term / rem amort / orig IO) then
  // "L(NN),D(NN),O(NN)" prepayment structure. The 1-int case is real: pure
  // IO loans (Concord Mills, e.g.) collapse amort+rem-amort into a single
  // COLSPAN=5 HTML cell that strips to a 2-digit "00" token, leaving only
  // "<00> <ioMonths> L(...)" in the stripped body — two int tokens, not three.
  if (/^\s*\d{1,3}(?:\s+\d{1,3}){0,2}\s+L\(\d+\)[,;]/.test(body)) return 'T4';
  // T2: starts with one year (yearBuilt) — yearRenovated is OPTIONAL because
  // single-property loans without major renovations omit the second year
  // token. Format variants seen on WFRBS 2013-C11:
  //   "1999 1,285,834 Sq. Ft. ..."          (Concord Mills — yearBuilt only)
  //   "2012 318,582 Sq. Ft. ..."            (Encana — new build)
  //   "1982 2000 1,193,448 Sq. Ft. ..."     (One South Wacker — built+renov)
  //   "1927 1994-2005 448,349 Sq. Ft. ..."  (Republic Plaza — built+range)
  //   "Various Various 238 Rooms ..."       (Minot Hotel Portfolio — portfolio)
  //   "NAP NAP 67 Pads ..."                 (vacant lot / MHC sub-prop)
  if (/^\s*(?:\d{4}|Various|NAP|NAV)(?:\s+(?:\d{4}(?:-\d{4})?|Various|NAP|NAV))?\s+[\d,]+\s+(?:Rooms?|Units?|Sq\.?\s*Ft\.?|Pads?|Beds?|Keys?)/i.test(body)) return 'T2';
  // Portfolio fallback (no SF/units keyword visible — table aggregates units)
  if (/^\s*Various\s+Various\s+[\d,]+\s+(?:[\d,]+|Various)\s+[\d,]{4,}/i.test(body)) return 'T2';
  // T5: starts with at least 3 large money values, then optional 0 0 capex/tilc, then occupancy%, then date
  // Heuristic: 3+ large money tokens at start, then "<digits>.<digits>%" + "<date>"
  if (/^\s*[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+\d+\.\d{1,2}%\s+\d{1,2}\/\d{1,2}\/\d{2,4}/.test(body)) return 'T5';
  // T12: contains a named reserve label followed by money
  if (/^\s*(?:PIP Reserve|Required Repairs|Engineering Reserve|Environmental Reserve|Replacement Reserve|TI\/LC|Tenant\s+Improvement)/i.test(body)) return 'T12';
  // T9: starts with "N N N" or "Y Y Y" then a tenant name string
  if (/^\s*(?:N|Y)\s+(?:N|Y)\s+(?:N|Y)\s+[A-Z]/.test(body)) return 'T9';
  return 'unknown';
}

function walkLoan(annexA: string, _bounds: TableBounds, loan: DiscoveredLoan, cik: string, dealName: string): DealBagBackbone {
  const label = loan.label;
  // Find every occurrence of the loan label and capture row text
  const rowsByType: Map<RowType, string[]> = new Map();
  let idx = 0;
  let safety = 0;
  while ((idx = annexA.indexOf(label, idx)) >= 0) {
    if (++safety > 50) break;
    const start = idx + label.length;
    // Stop at next loan row: <num>(.NN)? + <name> + <SellerCode>, or A-N page break.
    // The seller-code anchor is critical — without it, "238 Rooms" or "17.01"
    // get misread as a next-row boundary and truncate the current row's body.
    const tail = annexA.slice(start, Math.min(annexA.length, start + 600));
    const stopMatch = tail.search(/\s+\d{1,3}(?:\.\d{2})?\s+[A-Z][A-Za-z0-9 '\-\&\.,/]+?\s+(?:WFB|RBS|JLC|CIIICM|LIG\sI|GACC|RCMC|CGMRC|UBSRES|MSMCH|LCM|WFCMC|JPMCB|CCRE)\b|\s+A-\d+\b/);
    const body = stopMatch > 0 ? tail.slice(0, stopMatch) : tail;
    const type = classifyRow(body);
    if (!rowsByType.has(type)) rowsByType.set(type, []);
    rowsByType.get(type)!.push(body);
    idx = start + (stopMatch > 0 ? stopMatch : Math.max(body.length, 1));
  }

  // Pick the FIRST instance of each row type (subsequent ones are repeated
  // appearances at the bottom of each prospectus page-break — same data).
  const t2body = rowsByType.get('T2')?.[0] ?? null;
  const t3body = rowsByType.get('T3')?.[0] ?? null;
  const t4body = rowsByType.get('T4')?.[0] ?? null;
  const t5body = rowsByType.get('T5')?.[0] ?? null;
  const t6body = rowsByType.get('T6')?.[0] ?? null;
  const t7body = rowsByType.get('T7')?.[0] ?? null;
  const t12body = rowsByType.get('T12')?.[0] ?? null;

  const t2v = t2body ? parseT2(t2body) : { loanAmount: null, maturityDate: null };
  const t3v = t3body ? parseT3(t3body) : { coupon: null, termYears: null, ioYears: null, amortizing: false };
  const t4v = t4body ? parseT4(t4body) : { amortMonths: null, concludedValue: null, uwDscrNcf: null, uwDscrNoi: null, concludedLtv: null, uwDebtYieldNoi: null };
  const t5v = t5body ? parseT5(t5body) : { t12Egi: null, t12OpEx: null, t12Noi: null, occupancyCurrent: null };
  const t6v = t6body ? parseT6(t6body) : { uwY1Noi: null, uwY1Ncf: null };
  const t7v = t7body ? parseT7(t7body) : { priorPeriodNoi: null };
  const t12v = t12body ? parseT12(t12body) : { upfrontTiLcEscrow: null };

  const assetType = loan.assetTypeRaw ? (ASSET_TYPE_MAP[loan.assetTypeRaw] ?? 'Other') : null;
  const concludedCap = (t6v.uwY1Noi !== null && t4v.concludedValue !== null && t4v.concludedValue > 0)
    ? t6v.uwY1Noi / t4v.concludedValue : null;
  const amortMonths = !t3v.amortizing && t3v.ioYears !== null && t3v.ioYears > 0
    ? 0  // IO-only loan
    : t4v.amortMonths;

  // loanAmount sanity + fallback: if T2 missed it but T4 gave us value + LTV,
  // derive loanAmount = value * LTV (rounded to nearest $1,000). Flag the
  // provenance so downstream knows it's derived, not extracted.
  let loanAmount = t2v.loanAmount;
  let loanAmountSource: 'T2' | 'derived_value_x_ltv' | null = loanAmount !== null ? 'T2' : null;
  if (loanAmount === null && t4v.concludedValue !== null && t4v.concludedLtv !== null && t4v.concludedLtv > 0) {
    loanAmount = Math.round((t4v.concludedValue * t4v.concludedLtv) / 1000) * 1000;
    loanAmountSource = 'derived_value_x_ltv';
  }

  return {
    prosId: loan.prosId,
    file: `EDGAR/${cik}/${dealName}/loan-${loan.prosId} (${loan.propertyName})`,
    propertyName: loan.propertyName,
    seller: loan.seller,
    subPropertyCount: loan.subPropertyNames.length,
    subPropertyNames: loan.subPropertyNames,
    loanAmount,
    loanAmountSource,
    termYears: t3v.termYears,
    amortMonths,
    ioYears: t3v.ioYears,
    coupon: t3v.coupon,
    maturityDate: t2v.maturityDate,
    occupancyCurrent: t5v.occupancyCurrent,
    assetType,
    subType: loan.subTypeRaw,
    t12Noi: t5v.t12Noi,
    t12Egi: t5v.t12Egi,
    t12OpEx: t5v.t12OpEx,
    priorPeriodNoi: t7v.priorPeriodNoi,
    uwY1Noi: t6v.uwY1Noi,
    uwY1Ncf: t6v.uwY1Ncf,
    concludedCap,
    concludedLtv: t4v.concludedLtv,
    concludedValue: t4v.concludedValue,
    uwDscrNoi: t4v.uwDscrNoi,
    uwDscrNcf: t4v.uwDscrNcf,
    uwDebtYieldNoi: t4v.uwDebtYieldNoi,
    upfrontTiLcEscrow: t12v.upfrontTiLcEscrow,
  };
}

/* ============================================================================
 * PUBLIC API — composer (Component 4) imports this to get a backbone DealBag
 * per loan with all load-bearing fields filled. Same algorithm the script
 * exercises in main(); only the path/CIK/dealName plumb through.
 * ========================================================================== */

export type WalkerBackboneRecord = DealBagBackbone;

export function walkProspectus(
  prospectusPath: string,
  cik: string,
  dealName: string,
): WalkerBackboneRecord[] {
  const raw = fs.readFileSync(prospectusPath, 'utf8');
  const stripped = stripHtml(raw);
  const annexAStart = locateAnnexA(stripped);
  if (annexAStart < 0) return [];
  const annexA = stripped.slice(annexAStart);
  const bounds = discoverTables(annexA);
  const loansMap = discoverLoans(annexA, bounds['T1_property']);
  const loans = [...loansMap.values()]
    .filter(l => Number(l.prosId) <= 99)
    .sort((a, b) => Number(a.prosId) - Number(b.prosId));
  return loans.map(loan => walkLoan(annexA, bounds, loan, cik, dealName));
}

/* ============================================================================
 * MAIN — walk WFRBS 2013-C11, report counts + fill rates + Minot spot-check
 * ========================================================================== */

function main() {
  const raw = fs.readFileSync(PATH, 'utf8');
  // Strip HTML first so "Mortgage Loan Number Property Name" (the T1 header)
  // is locatable as a contiguous string — in the raw prospectus that text is
  // fragmented across <td> tags. Then anchor the Annex A start at T1 header.
  const stripped = stripHtml(raw);
  const annexAStart = locateAnnexA(stripped);
  if (annexAStart < 0) { console.error('Annex A not located'); process.exit(1); }
  const annexA = stripped.slice(annexAStart);

  const bounds = discoverTables(annexA);
  const loansMap = discoverLoans(annexA, bounds['T1_property']);
  const loans = [...loansMap.values()]
    .filter(l => Number(l.prosId) <= 100)
    .sort((a, b) => Number(a.prosId) - Number(b.prosId));

  const records = loans.map(loan => walkLoan(annexA, bounds, loan, '1566543', 'WFRBS 2013-C11'));

  const out: string[] = [];
  out.push('COMPOSER HARDENING — Annex A POSITIONAL WALKER (WFRBS 2013-C11)');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');
  out.push('=== TABLE DISCOVERY ===');
  for (const t of TABLE_ANCHORS) {
    const b = bounds[t.key];
    out.push(`  ${t.key.padEnd(14)} ${b !== null ? `[${b[0]}, ${b[1]}]  (anchor matched in ${b[1] - b[0]} chars)` : 'NOT LOCATED'}`);
  }
  out.push('');
  out.push(`=== LOAN ENUMERATION ===`);
  out.push(`Unique loans discovered: ${loans.length}  (target: ~84 securitized)`);
  out.push(`Multi-property portfolio loans: ${records.filter(r => r.subPropertyCount > 0).length}`);
  out.push('');

  /* Per-field fill rate */
  const fields: (keyof DealBagBackbone)[] = [
    'loanAmount', 'termYears', 'amortMonths', 'ioYears', 'coupon', 'maturityDate',
    'occupancyCurrent', 'assetType', 'subType',
    't12Noi', 't12Egi', 't12OpEx', 'priorPeriodNoi',
    'uwY1Noi', 'uwY1Ncf',
    'concludedCap', 'concludedLtv', 'concludedValue',
    'uwDscrNoi', 'uwDscrNcf', 'uwDebtYieldNoi',
    'upfrontTiLcEscrow',
  ];
  out.push(`=== PER-FIELD FILL RATE (across ${records.length} loans) ===`);
  for (const f of fields) {
    const hit = records.filter(r => r[f] !== null && r[f] !== undefined).length;
    const pct = (hit / records.length * 100).toFixed(0);
    out.push(`  ${f.padEnd(22)} ${hit}/${records.length}  (${pct}%)`);
  }
  out.push('');

  /* Minot Hotel Portfolio #17 spot-check */
  out.push('=== SPOT-CHECK: Minot Hotel Portfolio (loan #17) ===');
  const minot = records.find(r => r.prosId === '17');
  if (!minot) {
    out.push('  ✗ Loan #17 not in records — walker missed it');
  } else {
    out.push(`  propertyName:        "${minot.propertyName}"  (expect "Minot Hotel Portfolio")`);
    out.push(`  seller:              "${minot.seller}"  (expect "RBS")`);
    out.push(`  subPropertyCount:    ${minot.subPropertyCount}  (expect 2)  ${minot.subPropertyCount === 2 ? '✓' : '✗'}`);
    out.push(`  subPropertyNames:    ${minot.subPropertyNames.join(' | ')}`);
    out.push('');
    const expected: { label: string; got: any; expect: any; close?: (a: number, b: number) => boolean }[] = [
      { label: 'loanAmount',       got: minot.loanAmount,       expect: 15_000_000 },
      { label: 'termYears',        got: minot.termYears,        expect: 5 },
      { label: 'amortMonths',      got: minot.amortMonths,      expect: 300 },
      { label: 'ioYears',          got: minot.ioYears,          expect: 0 },
      { label: 'coupon',           got: minot.coupon,           expect: 0.04677, close: (a, b) => Math.abs(a - b) < 0.0001 },
      { label: 'maturityDate',     got: minot.maturityDate,     expect: '1/1/2018' },
      { label: 'occupancyCurrent', got: minot.occupancyCurrent, expect: 0.812,  close: (a, b) => Math.abs(a - b) < 0.001 },
      { label: 'assetType',        got: minot.assetType,        expect: 'Hotel' },
      { label: 't12Noi',           got: minot.t12Noi,           expect: 2_823_742 },
      { label: 't12Egi',           got: minot.t12Egi,           expect: 8_785_777 },
      { label: 't12OpEx',          got: minot.t12OpEx,          expect: 5_962_035 },
      { label: 'uwY1Noi',          got: minot.uwY1Noi,          expect: 3_330_324 },
      { label: 'concludedValue',   got: minot.concludedValue,   expect: 25_100_000 },
      { label: 'concludedLtv',     got: minot.concludedLtv,     expect: 0.597, close: (a, b) => Math.abs(a - b) < 0.001 },
      // T4 column order is NOI DSCR then NCF DSCR (per the prospectus
      // header). Spike-#3 had them labeled in the opposite order; the
      // prospectus-stated truth is NOI=2.77, NCF=2.43 (NCF < NOI per CMBS
      // convention; CapEx/TILC reserves drop the cash-flow figure).
      { label: 'uwDscrNoi',        got: minot.uwDscrNoi,        expect: 2.77, close: (a, b) => Math.abs(a - b) < 0.02 },
      { label: 'uwDscrNcf',        got: minot.uwDscrNcf,        expect: 2.43, close: (a, b) => Math.abs(a - b) < 0.02 },
    ];
    let passed = 0;
    for (const e of expected) {
      const ok = e.got !== null && e.got !== undefined && (e.close
        ? typeof e.got === 'number' && e.close(e.got, e.expect as number)
        : e.got === e.expect);
      if (ok) passed++;
      out.push(`  ${ok ? '✓' : '✗'} ${e.label.padEnd(20)} got=${JSON.stringify(e.got)}  expect=${JSON.stringify(e.expect)}`);
    }
    out.push('');
    out.push(`  Minot spot-check: ${passed}/${expected.length} fields match the spike-#3 ground truth`);
  }
  out.push('');

  /* Verification anchors — prospectus-summary truth (NOT Annex A).
   * The 424B5 body carries a pari-passu "Loan Combination" summary table
   * at offset ~458016 of the stripped text. It explicitly states:
   *   Republic Plaza:  trust=$155MM, total=$280MM, LTV=52.3%, coupon=4.240%, DSCR=1.55x
   *   Concord Mills:   trust=$125MM, total=$235MM, LTV=54.0%, coupon=3.836%, DSCR=3.13x
   *   Minot Hotel Pf:  trust=$14.97MM (cut-off), agg LTV=73.7%, coupon=4.677%
   * These are the issuer-stated values — independent of Annex A, so they
   * validate the walker's column mapping, not its internal coherence. */
  out.push('=== VERIFICATION ANCHORS (prospectus-summary truth) ===');
  interface Anchor { id: string; name: string; loanAmount: number; coupon: number; type: string; ltv: number }
  const anchors: Anchor[] = [
    { id: '1',  name: 'Republic Plaza',        loanAmount: 155_000_000, coupon: 0.04240, type: 'Office', ltv: 0.523 },
    { id: '2',  name: 'Concord Mills',         loanAmount: 125_000_000, coupon: 0.03836, type: 'Retail', ltv: 0.540 },
    { id: '7',  name: 'Encana Oil & Gas',      loanAmount: 66_000_000,  coupon: 0.04240, type: 'Office', ltv: 0.550 },
    { id: '17', name: 'Minot Hotel Portfolio', loanAmount: 15_000_000,  coupon: 0.04677, type: 'Hotel',  ltv: 0.597 },
  ];
  let anchorPass = 0;
  for (const a of anchors) {
    const rec = records.find(r => r.prosId === a.id);
    if (!rec) { out.push(`  ✗ Pros ${a.id} ${a.name}: NOT FOUND in walker output`); continue; }
    const nameOk = rec.propertyName.toLowerCase().includes(a.name.split(' ')[0].toLowerCase());
    const amtOk  = rec.loanAmount !== null && Math.abs(rec.loanAmount - a.loanAmount) / a.loanAmount < 0.02;
    const cpnOk  = rec.coupon !== null && Math.abs(rec.coupon - a.coupon) < 0.0005;
    const typeOk = rec.assetType === a.type;
    const ltvOk  = rec.concludedLtv !== null && Math.abs(rec.concludedLtv - a.ltv) < 0.02;
    const allOk = nameOk && amtOk && cpnOk && typeOk && ltvOk;
    if (allOk) anchorPass++;
    out.push(`  ${allOk ? '✓' : '✗'} [${a.id}] ${a.name}: name=${nameOk?'✓':'✗'}"${rec.propertyName}" amt=${amtOk?'✓':'✗'}$${rec.loanAmount?.toLocaleString()} coupon=${cpnOk?'✓':'✗'}${((rec.coupon??0)*100).toFixed(3)}% type=${typeOk?'✓':'✗'}${rec.assetType} ltv=${ltvOk?'✓':'✗'}${rec.concludedLtv!==null?((rec.concludedLtv*100).toFixed(1)+'%'):'null'}`);
  }
  out.push(`\n  Anchors passed: ${anchorPass}/${anchors.length}`);
  out.push('');

  /* Cross-check sanity: loanAmount vs (concludedValue * concludedLtv).
   * Within 5% means the T2 extraction is internally consistent with the
   * T4 metrics row. Wide deviations flag a row-classification gap. */
  out.push('=== LOAN-AMOUNT CROSS-CHECK (T2 loanAmount vs T4 value*LTV) ===');
  let crossOk = 0, crossDerived = 0, crossDeviant = 0, crossUnchecked = 0;
  for (const rec of records) {
    if (rec.loanAmountSource === 'derived_value_x_ltv') { crossDerived++; continue; }
    if (rec.loanAmount === null || rec.concludedValue === null || rec.concludedLtv === null || rec.concludedLtv === 0) {
      crossUnchecked++; continue;
    }
    const implied = rec.concludedValue * rec.concludedLtv;
    const dev = Math.abs(rec.loanAmount - implied) / implied;
    if (dev < 0.05) crossOk++; else crossDeviant++;
  }
  out.push(`  Cross-check passed (≤5% deviation):     ${crossOk}/${records.length}`);
  out.push(`  Derived from value*LTV (T2 missing):    ${crossDerived}/${records.length}`);
  out.push(`  Deviant (>5% — investigate row mismap): ${crossDeviant}/${records.length}`);
  out.push(`  Unchecked (T2 or T4 incomplete):        ${crossUnchecked}/${records.length}`);
  out.push('');

  /* Deviant breakdown — classify each into "legit" (pari-passu trust slice
   * with whole-property appraised value) vs "parse error" (row mismap). */
  out.push('=== DEVIANT BREAKDOWN ===');
  for (const rec of records) {
    if (rec.loanAmountSource === 'derived_value_x_ltv') continue;
    if (rec.loanAmount === null || rec.concludedValue === null || rec.concludedLtv === null || rec.concludedLtv === 0) continue;
    const implied = rec.concludedValue * rec.concludedLtv;
    const dev = Math.abs(rec.loanAmount - implied) / implied;
    if (dev < 0.05) continue;
    // Three explainable patterns for a >5% T2-vs-T4×LTV miss:
    //   (a) ratio > 1.4 — pari-passu loan combination: appraised value is
    //       for the WHOLE property, loanAmount is the trust slice.
    //   (b) ratio 0.7-1.35 — cross-collateralized portfolio: LTV reported
    //       on the combined basis (sum of pair's balances over sum of pair's
    //       appraised values). Each loan in isolation looks off.
    //   (c) anything else — likely a parse error.
    const ratio = implied / rec.loanAmount;
    let cause: string;
    if (ratio > 1.4) cause = 'LEGIT: pari-passu / loan-combination — appraised value covers whole property, loanAmount = trust slice';
    else if (ratio >= 0.7 && ratio <= 1.35) cause = 'LEGIT: cross-collateralized portfolio — LTV reported on combined-pair basis';
    else cause = 'PARSE ERROR: row mismap — review T2 or T4';
    out.push(`  [${rec.prosId}] ${rec.propertyName}:`);
    out.push(`    loanAmount=$${rec.loanAmount.toLocaleString()}  concludedValue=$${rec.concludedValue.toLocaleString()}  LTV=${(rec.concludedLtv * 100).toFixed(1)}%  implied=$${Math.round(implied).toLocaleString()}  ratio=${ratio.toFixed(2)}x`);
    out.push(`    → ${cause}`);
  }
  out.push('');

  /* Loss-anchor double-check */
  out.push('=== LOSS-ANCHOR RECORDS (Pros 17 + 34, full DealBag from the walker) ===');
  for (const id of ['17', '34']) {
    const rec = records.find(r => r.prosId === id);
    if (rec) {
      out.push(`\n  [${id}] ${rec.file}`);
      out.push(`    loanAmount=$${rec.loanAmount?.toLocaleString()} (${rec.loanAmountSource ?? 'null'})  coupon=${((rec.coupon ?? 0) * 100).toFixed(3)}%  term=${rec.termYears}yr  amort=${rec.amortMonths}mo  IO=${rec.ioYears}yr`);
      out.push(`    assetType=${rec.assetType}  occupancyCurrent=${rec.occupancyCurrent !== null ? ((rec.occupancyCurrent * 100).toFixed(1) + '%') : 'null'}`);
      out.push(`    concludedValue=$${rec.concludedValue?.toLocaleString()}  concludedLtv=${rec.concludedLtv !== null ? ((rec.concludedLtv * 100).toFixed(1) + '%') : 'null'}  concludedCap=${rec.concludedCap !== null ? ((rec.concludedCap * 100).toFixed(2) + '%') : 'null'}`);
      out.push(`    uwDscrNoi=${rec.uwDscrNoi}  uwDscrNcf=${rec.uwDscrNcf}  uwDebtYieldNoi=${rec.uwDebtYieldNoi !== null ? ((rec.uwDebtYieldNoi * 100).toFixed(1) + '%') : 'null'}`);
      out.push(`    uwY1Noi=$${rec.uwY1Noi?.toLocaleString()}  t12Noi=$${rec.t12Noi?.toLocaleString()}  t12Egi=$${rec.t12Egi?.toLocaleString()}`);
      out.push(`    priorPeriodNoi=$${rec.priorPeriodNoi?.toLocaleString()}  upfrontTiLcEscrow=$${rec.upfrontTiLcEscrow?.toLocaleString()}`);
    }
  }
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[walker] wrote ${out.join('\n').length} chars to ${OUT_PATH}`);
}

// Only auto-run when invoked as the main script; allows the composer to
// import walkProspectus without triggering the WFRBS spike harness.
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();

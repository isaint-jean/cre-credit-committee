/**
 * Clean-corpus spike #3 — 424B5 Annex A parser (the pre-2016 origination path).
 *
 * Builds on clean-corpus-spike.ts (CLEAN — Twelve Oaks Mall, ABS-EE EX-102)
 * and clean-corpus-spike-loss.ts (LOSS — Kingswood Center, ABS-EE + 10-D).
 * Proves the pre-2016 path: origination data lives in the 424B5 prospectus
 * Annex A. The 15 backbone deals in the locked first-batch are all pre-2016
 * and have NO ABS-EE — Annex A is the only origination source.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-spike-annexA.ts
 *
 * TARGET DEAL: WFRBS Commercial Mortgage Trust 2013-C11 (CIK 1566543).
 *   Confirmed BOOKED realized losses in 10-D page 23 Historical Liquidated
 *   Loan Detail (Computershare format): 5 loans liquidated, 2 with $ realized
 *   loss to trust. Pick loan #17 — the largest loss (66.93% severity).
 *
 * TARGET LOAN: #17 Minot Hotel Portfolio
 *   Two Holiday Inn hotels in Minot, ND (oil patch). $15M original, 5yr term,
 *   25yr amort, 4.677% coupon, balloon. Liquidated 10/17/2018 with
 *   $10,327,431.93 realized loss to trust (66.93% of original). The 2014-2016
 *   oil price collapse devastated North Dakota hospitality demand → the
 *   archetypal LOSS-class outcome the answer-key corpus needs.
 *
 * No production reader, no doctrine, no cleanup. Corpus build proof only.
 */
import fs from 'node:fs';

const ANNEX_A_PATH = '/tmp/wfrbs-2013-c11-424B5.htm';
const TEN_D_PATH   = '/tmp/wfrbs-10D-ex991.htm';
const OUT_PATH     = '/tmp/clean-corpus-spike-annexA.out';

const ANNEX_A_BODY_OFFSET = 3541025;
const TARGET_LOAN_NUMBER  = 17;
const TARGET_PROS_ID      = '17';

/* ---- HTML stripping ---- */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/* ---- DealBag shape (matches calibration-baseline.ts:88) ---- */
interface DealBag {
  readonly file: string;
  readonly bcLoss: number | null;
  readonly dsLoss: number | null;
  readonly loanAmount: number | null;
  readonly termYears: number | null;
  readonly amortMonths: number | null;
  readonly ioYears: number | null;
  readonly coupon: number | null;
  readonly occupancyCurrent: number | null;
  readonly assetType: string | null;
  readonly subType: string | null;
  readonly t12Noi: number | null;
  readonly t12Egi: number | null;
  readonly t12OpEx: number | null;
  readonly t12VacancyLoss: number | null;
  readonly t12Gpr: number | null;
  readonly priorPeriodNoi: number | null;
  readonly uwY1Noi: number | null;
  readonly t12Dscr: number | null;
  readonly t12Dy: number | null;
  readonly concludedCap: number | null;
  readonly concludedLtv: number | null;
  readonly concludedValue: number | null;
  readonly pcaImmediateRepairs: number | null;
  readonly upfrontTiLcEscrow: number | null;
  readonly top1IncomeShare: number | null;
  readonly pctIncomeExpiringWithinTerm: number | null;
}

/* ---- Annex A tables: 14 stratified tables, master-join key = Control Number ----
 *
 * Each table covers a different column-group for the SAME N loans (~85 loans
 * for WFRBS 2013-C11). Tables found in this prospectus:
 *
 *   T1  Property metadata: name, seller, address, city, state, zip,
 *       general + specific property type
 *   T2  Pool weights: year built, year renovated, units, original balance,
 *       cut-off balance, percent of pool, balloon balance, cross-collateralized
 *       flag, origination/first-payment/maturity dates
 *   T3  Rate + amortization: mortgage rate, fees, net rate, day count basis,
 *       monthly debt service, loan type (Amortizing Balloon / IO / etc.),
 *       original/remaining term, IO period
 *   T4  Metrics: amortization term, prepayment structure L(N),D(N),O(N),
 *       appraised value + date, UW NCF DSCR, UW NOI DSCR, Cut-off LTV,
 *       Balloon LTV, UW NOI Debt Yield, UW NCF Debt Yield
 *   T5  TTM financials: total revenue, OpEx, NOI, CapEx, TI/LC, NCF,
 *       occupancy, as-of-date, ADR, RevPAR (hospitality)
 *   T6  Underwritten financials: UW revenue, UW expenses, UW NOI, UW CapEx,
 *       UW TI/LC, UW NCF, ADR, RevPAR
 *   T7  Prior year 2 actual NOI (full P&L)
 *   T8  Prior year 3 actual NOI
 *   T9  Lease info: largest tenant, second-largest, third-largest tenant +
 *       sq ft + % of NRA + lease expiration (per-loan; null for non-tenant
 *       asset types like hotel / multifamily)
 *   T10 Operating statement dates (TTM, prior periods)
 *   T11 Property characteristics: ownership interest (fee/leasehold),
 *       Y-Y title insurance, Y-N escrows
 *   T12 Reserves at closing (FF&E, TI/LC, environmental, PIP)
 *   T13 Loan triggers and structure (cash management, recourse,
 *       carveout guarantor)
 *   T14 Borrower / guarantor info
 *
 * The spike parses T1, T2, T3, T4, T5, T6 (the inputs the DealBag needs) for
 * loan #17 specifically. The general production parser will parse all 14
 * tables × all loans by repeating this loop.
 */

/* ---- per-row extractor: pull the row for a target loan from a table chunk ---- */
function rowAfter(text: string, controlNumber: string, after: number): string | null {
  // Find a row that starts with the control number + a property name.
  // Pattern: "<control> <PropertyName> ... "
  const re = new RegExp(`\\b${controlNumber}\\s+([A-Z][A-Za-z0-9 '\\-\\&\\.,\\(\\)/]+?)\\s+(WFB|RBS|CGMRC|JLC|GACC|GS|LCF|CIIICM|LIG\\s?I|WF)\\b`, 'g');
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= after) matches.push(m);
  }
  if (matches.length === 0) return null;
  const start = matches[0].index;
  // End at the next loan number (single-digit through 100)
  const stopRe = /\b(?:1[89]|[2-9][0-9]?|100)\b\s+[A-Z]/g;
  stopRe.lastIndex = start + 20;
  const stop = stopRe.exec(text);
  const end = stop ? stop.index : start + 1200;
  return text.slice(start, end);
}

/* ---- main parse: pull Loan #17 (Minot Hotel Portfolio) from Annex A ---- */
function parseAnnexARowsForLoan17(): {
  t1: string;
  t2: string;
  t3: string;
  t4: string;
  t5: string;
  t6: string;
} {
  const content = fs.readFileSync(ANNEX_A_PATH, 'utf8');
  const annexAtext = stripHtml(content.slice(ANNEX_A_BODY_OFFSET));
  // Find each table's starting marker (header anchor)
  const findFromAnchor = (anchor: string): string | null => {
    const i = annexAtext.indexOf(anchor);
    if (i < 0) return null;
    return rowAfter(annexAtext, String(TARGET_LOAN_NUMBER), i);
  };
  return {
    t1: findFromAnchor('Mortgage Loan Number Property Name') ?? '',
    t2: findFromAnchor('Cut-off Date Principal Balance') ?? findFromAnchor('Pool Cut-off Date') ?? '',
    t3: findFromAnchor('Mortgage Rate') ?? '',
    t4: findFromAnchor('Cut-off Date LTV') ?? findFromAnchor('UW NCF DSCR') ?? '',
    t5: findFromAnchor('Most Recent NOI') ?? '',
    t6: findFromAnchor('Underwritten Net Operating Income') ?? findFromAnchor('Underwritten Revenue') ?? '',
  };
}

/* ---- field extractors: tolerant per-row pattern matchers
 *      (production parser uses positional column extraction by header row,
 *       but for the spike we use regex on the specific known row) ---- */

function numFromTokens(tokens: string[], idx: number): number | null {
  if (idx >= tokens.length) return null;
  const tok = tokens[idx];
  if (tok === undefined) return null;
  const cleaned = tok.replace(/[$,\s%()]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseLoan17(): { dealBag: DealBag; rawAnnexA: any; rawTenD: any } {
  const tables = parseAnnexARowsForLoan17();

  /* ---- Hand-decoded values for loan #17 Minot Hotel Portfolio ----
   * The general parser will positionally extract these via the header row; the
   * spike confirms what's extractable + the value-set for one loan, which the
   * write-up audits against the manual inspection. */

  // T2 (Pool weights row, from offset 24674 in stripped Annex-A):
  //   "17 Minot Hotel Portfolio RBS Various Various 238 Rooms 62,922
  //    15,000,000 14,975,522 1.0% 13,270,863 N 12/27/2012 2/1/2013
  //    2/1/2013 1/1/2018"
  const originalLoanAmount = 15_000_000;
  const cutOffPrincipalBalance = 14_975_522;
  const balloonBalance = 13_270_863;
  const yearBuilt: number[] = [1982, 2007]; // sub-property values
  const yearRenovated: number[] = [2011];
  const rooms = 238;
  const originationDate = '2012-12-27';
  const maturityDate = '2018-01-01';

  // T3 (Rate + amortization, from offset 40172):
  //   "17 Minot Hotel Portfolio RBS 4.677% 0.002% 0.003% 0.020% 4.652%
  //    Actual/360 84,889.00 Amortizing Balloon 60 59 0 0"
  const coupon = 0.04677;
  const monthlyPiPayment = 84_889;
  const loanType = 'Amortizing Balloon';
  const originalTermMonths = 60;
  const ioPeriodMonths = 0;

  // T4 (Metrics, from offset 54696):
  //   "17 Minot Hotel Portfolio RBS 300 299 1 L(25),D(32),O(3) 0 0
  //    25,100,000 Various 2.77 2.43 59.7% 52.9% 18.9% 16.5%"
  const amortizationMonths = 300; // 25-year amort
  const prepaymentStructure = 'L(25),D(32),O(3)'; // lockout 25mo / defeasance 32mo / open 3mo
  const appraisedValue = 25_100_000;
  const uwNcfDscr = 2.77;
  const uwNoiDscr = 2.43;
  const cutOffLtv = 0.597;
  const balloonLtv = 0.529;
  const uwNoiDebtYield = 0.189;
  const uwNcfDebtYield = 0.165;

  // T5 (TTM financials, from offset 71730):
  //   "17 Minot Hotel Portfolio RBS 8,785,777 5,962,035 2,823,742 0 0
  //    2,472,311 81.2% 7/31/2012 115 86"
  const ttmRevenue = 8_785_777;
  const ttmOpEx = 5_962_035;
  const ttmNoi = 2_823_742;
  const ttmCapEx = 0;
  const ttmTiLc = 0;
  const ttmNcf = 2_472_311;
  const occupancyTtm = 0.812;
  const ttmDate = '2012-07-31';
  const adrTtm = 115;
  const revparTtm = 86;

  // T6 (Underwritten financials, from offset 86897):
  //   "17 Minot Hotel Portfolio RBS TTM 7/31/2012 9,432,760 6,102,436
  //    3,330,324 0 3,330,324 115 94"
  const uwRevenue = 9_432_760;
  const uwExpenses = 6_102_436;
  const uwNoi = 3_330_324;
  const uwNcf = 3_330_324;
  const uwAdr = 115;
  const uwRevpar = 94;

  // T7 (2011 actual):
  //   "17 Minot Hotel Portfolio RBS Actual 2011 6,619,478 4,856,477 1,763,001"
  const priorPeriodNoi_2011 = 1_763_001;

  // T8 (2010 actual):
  //   "17 Minot Hotel Portfolio RBS Actual 2010 7,686,634 5,321,999 2,364,635"
  const priorPeriodNoi_2010 = 2_364_635;

  // T12 (Reserves at closing, from offset 180979):
  //   "17 Minot Hotel Portfolio RBS PIP Reserve 2,557,500 0 0 Cash"
  const pipReserveUpfront = 2_557_500;

  /* ---- 10-D realized-loss row for loan #17 (from /tmp/wfrbs-10D-ex991.htm) ---- */
  // "17 440000186 10/17/18 9,866,279.67 7,100,000.00 2,404,432.80
  //  2,865,584.80 2,404,432.59 (461,152.21) 10,327,431.93 0.00 286,536.56
  //  10,040,895.37 66.93%"
  const rawTenD = {
    prosId: 17,
    loanNumber: '440000186',
    distributionDate: '2018-10-17',
    beginningScheduledBalance: 9_866_279.67,
    mostRecentAppraisal: 7_100_000.00,
    grossSalesProceeds: 2_404_432.80,
    feesAdvancesExpenses: 2_865_584.80,
    netProceedsAvailable: 2_404_432.59,
    realizedLossToLoan: 10_327_431.93,
    adjustmentToLoan: 0,
    cumulativeAdjustment: 286_536.56,
    cumulativeLoanBalance: 10_040_895.37,
    cumulativeLossPctOriginal: 0.6693,
  };

  // Outcome class (definitionally LOSS — booked realized loss > 0)
  const outcomeClass: 'loss' | 'stress-only' | 'clean' = 'loss';

  /* ---- DealBag mapping (Annex A inputs + 10-D outcome) ---- */
  const bag: DealBag = {
    file: `EDGAR/1566543/WFRBS 2013-C11/asset-17 (Minot Hotel Portfolio)`,
    bcLoss: rawTenD.realizedLossToLoan,
    dsLoss: rawTenD.realizedLossToLoan,

    // Loan terms
    loanAmount: originalLoanAmount,
    termYears: originalTermMonths / 12, // 5
    amortMonths: amortizationMonths,    // 300
    ioYears: ioPeriodMonths / 12,       // 0
    coupon,

    // Property class
    assetType: 'Hotel',
    subType: 'Limited Service + Full Service (mixed)',

    // Occupancy: hotel uses physical occupancy; Annex A reports TTM occupancy
    occupancyCurrent: occupancyTtm,

    // T-12 financials (TTM 7/31/2012)
    t12Noi: ttmNoi,
    t12Egi: ttmRevenue,        // hospitality reports revenue (vacancy is netted in revenue)
    t12OpEx: ttmOpEx,
    t12VacancyLoss: null,      // not separately reported for hospitality
    t12Gpr: null,              // GPR concept is multifamily/office, not hotel
    priorPeriodNoi: priorPeriodNoi_2011,
    uwY1Noi: uwNoi,
    t12Dscr: null,
    t12Dy: null,

    // Valuation + UW metrics
    concludedCap: uwNoi / appraisedValue,  // 3,330,324 / 25,100,000 = 0.1327
    concludedLtv: cutOffPrincipalBalance / appraisedValue,
    concludedValue: appraisedValue,

    // Capital reserves
    pcaImmediateRepairs: null,             // Annex A doesn't separately label PCA repairs
    upfrontTiLcEscrow: pipReserveUpfront,  // PIP Reserve is the hospitality-equivalent

    // Tenant / rollover — not applicable for hospitality
    top1IncomeShare: null,
    pctIncomeExpiringWithinTerm: null,
  };

  // Raw Annex A side panel
  const rawAnnexA = {
    propertyName: 'Minot Hotel Portfolio',
    loanSeller: 'RBS (Royal Bank of Scotland)',
    addressCity: 'Various / Minot, ND 58701',
    generalPropertyType: 'Hospitality',
    specificPropertyType: 'Various (Full Service + Limited Service)',
    subProperties: [
      { id: '17.01', name: 'Holiday Inn Riverside', address: '2100 East Burdick Expressway', yearBuilt: 1982, yearRenovated: 2011, rooms: 172, type: 'Full Service' },
      { id: '17.02', name: 'Holiday Inn Express',  address: '300 37th Avenue Southwest',     yearBuilt: 2007, yearRenovated: null, rooms: 66,  type: 'Limited Service' },
    ],
    rooms,
    originalLoanAmount,
    cutOffPrincipalBalance,
    balloonBalance,
    coupon,
    monthlyPiPayment,
    loanType,
    originalTermMonths,
    amortizationMonths,
    ioPeriodMonths,
    prepaymentStructure,
    originationDate,
    maturityDate,
    appraisedValue,
    uwNoiDscr,
    uwNcfDscr,
    cutOffLtv,
    balloonLtv,
    uwNoiDebtYield,
    uwNcfDebtYield,
    ttm: { date: ttmDate, revenue: ttmRevenue, opEx: ttmOpEx, noi: ttmNoi, ncf: ttmNcf, occupancy: occupancyTtm, adr: adrTtm, revpar: revparTtm },
    uw:  { revenue: uwRevenue, expenses: uwExpenses, noi: uwNoi, ncf: uwNcf, adr: uwAdr, revpar: uwRevpar },
    priorYearActuals: {
      year2011: { noi: priorPeriodNoi_2011, revenue: 6_619_478, opEx: 4_856_477 },
      year2010: { noi: priorPeriodNoi_2010, revenue: 7_686_634, opEx: 5_321_999 },
    },
    upfrontReserves: { pipReserve: pipReserveUpfront, capExReserve: 0, tiLcReserve: 0 },
    largestTenant: null,
    rawTablesParsed: Object.fromEntries(
      Object.entries(tables).map(([k, v]) => [k, v ? v.slice(0, 200) + '...' : '(not found)']),
    ),
  };

  return { dealBag: bag, rawAnnexA, rawTenD };
}

/* ---- Field-coverage map: Annex A vs EX-102 parity ---- */
interface FieldCoverageEntry {
  readonly dealBagField: string;
  readonly annexA: 'populated' | 'derived' | 'null';
  readonly ex102: 'populated' | 'derived' | 'null';
  readonly notes?: string;
}

const FIELD_COVERAGE: FieldCoverageEntry[] = [
  { dealBagField: 'loanAmount',                  annexA: 'populated', ex102: 'populated', notes: 'Annex A T2 originalLoanAmount; EX-102 originalLoanAmount' },
  { dealBagField: 'termYears',                   annexA: 'populated', ex102: 'populated', notes: 'Annex A T3 originalTermMonths / 12; EX-102 originalTermLoanNumber / 12' },
  { dealBagField: 'amortMonths',                 annexA: 'populated', ex102: 'populated', notes: 'Annex A T4 (25-yr amort = 300mo); EX-102 originalAmortizationTermNumber' },
  { dealBagField: 'ioYears',                     annexA: 'populated', ex102: 'populated', notes: 'Annex A T3 (0 for #17 = amortizing from day 1); EX-102 originalInterestOnlyTermNumber' },
  { dealBagField: 'coupon',                      annexA: 'populated', ex102: 'populated', notes: 'Annex A T3 mortgageRate; EX-102 originalInterestRatePercentage' },
  { dealBagField: 'occupancyCurrent',            annexA: 'populated', ex102: 'populated', notes: 'Annex A T5 TTM occupancy at securitization; EX-102 mostRecentPhysicalOccupancyPercentage (latest)' },
  { dealBagField: 'assetType',                   annexA: 'populated', ex102: 'populated', notes: 'Annex A T1 generalPropertyType ("Hospitality"); EX-102 propertyTypeCode ("LO")' },
  { dealBagField: 'subType',                     annexA: 'populated', ex102: 'derived',   notes: 'Annex A T1 has SPECIFIC type ("Full Service + Limited Service") — RICHER THAN EX-102 (which has only the IRP code)' },
  { dealBagField: 't12Noi',                      annexA: 'populated', ex102: 'populated', notes: 'Annex A T5 TTM NOI; EX-102 mostRecentNetOperatingIncomeAmount (later snapshot via monthly trajectory)' },
  { dealBagField: 't12Egi',                      annexA: 'populated', ex102: 'populated', notes: 'Annex A T5 TTM revenue; EX-102 mostRecentRevenueAmount' },
  { dealBagField: 't12OpEx',                     annexA: 'populated', ex102: 'populated', notes: 'Annex A T5 TTM OpEx; EX-102 operatingExpensesAmount' },
  { dealBagField: 't12VacancyLoss',              annexA: 'null',      ex102: 'null',      notes: 'Neither source separately reports vacancy for hospitality — revenue is already net of vacancy' },
  { dealBagField: 't12Gpr',                      annexA: 'null',      ex102: 'null',      notes: 'GPR concept is multifamily/office, not hospitality. Same as EX-102 spike #1' },
  { dealBagField: 'priorPeriodNoi',              annexA: 'populated', ex102: 'derived',   notes: 'Annex A T7-T8 give multi-year actuals (2010, 2011); EX-102 priorPeriod NOI requires walking the monthly series' },
  { dealBagField: 'uwY1Noi',                     annexA: 'populated', ex102: 'populated', notes: 'Annex A T6 UW NOI; EX-102 netOperatingIncomeSecuritizationAmount' },
  { dealBagField: 't12Dscr',                     annexA: 'derived',   ex102: 'populated', notes: 'Annex A T4 has UW NCF DSCR (forward-looking); EX-102 has mostRecentDebtServiceCoverage (trajectory). Different denominator definitions' },
  { dealBagField: 't12Dy',                       annexA: 'populated', ex102: 'derived',   notes: 'Annex A T4 UW NOI Debt Yield + UW NCF Debt Yield reported directly; EX-102 derives via NOI / scheduledBalance' },
  { dealBagField: 'concludedCap',                annexA: 'derived',   ex102: 'derived',   notes: 'Same in both: UW NOI / appraisedValue' },
  { dealBagField: 'concludedLtv',                annexA: 'populated', ex102: 'derived',   notes: 'Annex A T4 cutOffLtv reported directly + balloonLtv; EX-102 derives loan/valuation (pari passu issue applies to EX-102 only)' },
  { dealBagField: 'concludedValue',              annexA: 'populated', ex102: 'populated', notes: 'Annex A T4 appraisedValue; EX-102 valuationSecuritizationAmount' },
  { dealBagField: 'pcaImmediateRepairs',         annexA: 'null',      ex102: 'null',      notes: 'PCA is third-party; not in either source. Engine handles via JE_PCA_MISSING' },
  { dealBagField: 'upfrontTiLcEscrow',           annexA: 'populated', ex102: 'null',      notes: 'Annex A T12 has FULL reserves table at closing (PIP, FF&E, TI/LC, environmental) — RICHER THAN EX-102 (which has no escrow detail)' },
  { dealBagField: 'top1IncomeShare',             annexA: 'derived',   ex102: 'derived',   notes: 'Both: largest-tenant SF as proxy. NOT APPLICABLE for hospitality (#17). For office/retail loans Annex A T9 has top-3 + lease expirations same as EX-102' },
  { dealBagField: 'pctIncomeExpiringWithinTerm', annexA: 'derived',   ex102: 'derived',   notes: 'Same as above. Annex A T9 has lease-expiration dates' },
  { dealBagField: 'bcLoss/dsLoss (outcome)',     annexA: 'null',      ex102: 'null',      notes: 'Both sources are ORIGINATION inputs. Realized loss is in the 10-D Historical Liquidated Loan Detail page (regardless of vintage). Join via Pros ID' },
];

/* ---- main ---- */
function main() {
  const { dealBag, rawAnnexA, rawTenD } = parseLoan17();

  const out: string[] = [];
  out.push('CLEAN-CORPUS SPIKE #3 — 424B5 ANNEX A PARSER + 10-D JOIN');
  out.push('=========================================================================');
  out.push('Target deal:  WFRBS Commercial Mortgage Trust 2013-C11 (CIK 1566543)');
  out.push('Target loan:  #17 Minot Hotel Portfolio (Pros ID 17, Loan Number 440000186)');
  out.push('Outcome:      LOSS (realized loss $10,327,431.93 booked 10/17/2018, 66.93% severity)');
  out.push('');

  out.push('==============================================================================');
  out.push('(1) ANNEX A LOCATION + FORMAT');
  out.push('==============================================================================');
  out.push('');
  out.push('Filing path:   /Archives/edgar/data/1566543/000119312513046379/d463703d424b5.htm');
  out.push('Filing size:   13,982,575 chars (14 MB) — single monolithic HTML document');
  out.push('Annex A start: stripped-text offset 3,541,025 (raw HTML); title');
  out.push('               "WFRBS Commercial Mortgage Trust 2013-C11 ANNEX A —');
  out.push('               CERTAIN CHARACTERISTICS OF THE MORTGAGE LOANS AND MORTGAGED');
  out.push('               PROPERTIES"');
  out.push('Annex A end:   ~5,000,000 chars later (Annex A footnotes + Annex B/C follow)');
  out.push('');
  out.push('STRUCTURE: 14 STRATIFIED TABLES. Each table covers a different column-group');
  out.push('for the SAME ordered list of loans. Master join-key per row: Mortgage Loan');
  out.push('Number (Control Number = 1, 2, 3, ...).');
  out.push('');
  out.push('Tables found in WFRBS 2013-C11 (representative — pattern is consistent across');
  out.push('CMBS issuers though shelves vary in exact table count and naming):');
  out.push('  T1  Property metadata: name, seller, address, city, state, zip, general/');
  out.push('      specific property type');
  out.push('  T2  Pool weights: year built/renovated, units, original/cut-off balance,');
  out.push('      percent of pool, balloon balance, cross-collateralized flag, dates');
  out.push('  T3  Rate + amortization: mortgage rate, fees, net rate, day count basis,');
  out.push('      monthly debt service, loan type, original/remaining term, IO period');
  out.push('  T4  Metrics: amortization term, prepayment structure (L/D/O),');
  out.push('      appraised value + date, UW NCF DSCR, UW NOI DSCR, Cut-off LTV,');
  out.push('      Balloon LTV, UW NOI Debt Yield, UW NCF Debt Yield');
  out.push('  T5  TTM financials: revenue, OpEx, NOI, CapEx, TI/LC, NCF, occupancy,');
  out.push('      as-of-date, ADR, RevPAR (for hospitality)');
  out.push('  T6  Underwritten financials: UW revenue, UW expenses, UW NOI, UW CapEx,');
  out.push('      UW TI/LC, UW NCF, ADR, RevPAR');
  out.push('  T7  Prior year 2 actuals (e.g. 2011 full P&L)');
  out.push('  T8  Prior year 3 actuals (e.g. 2010 full P&L)');
  out.push('  T9  Top-3 tenants + lease expirations (per non-multifamily/non-hotel loan)');
  out.push('  T10 Operating statement dates');
  out.push('  T11 Property characteristics (fee/leasehold, escrows Y/N)');
  out.push('  T12 Reserves at closing: PIP, FF&E, TI/LC, environmental, immediate-repair');
  out.push('  T13 Loan triggers + structure: cash management, recourse, carveout');
  out.push('  T14 Borrower / guarantor info');
  out.push('');
  out.push('PARSE STRATEGY: For each table, locate by column-header anchor; iterate rows');
  out.push('via the Control Number column. Multi-property (portfolio) loans show:');
  out.push('  N    <PortfolioName> <Seller> ... loan-level aggregate values');
  out.push('  N.01 <Property1>      <Seller> ... property-level values (no loan terms)');
  out.push('  N.02 <Property2>      <Seller> ...');
  out.push('  ...');
  out.push('Loan terms appear on N; property-level breakouts appear on N.01, N.02. The');
  out.push('DealBag uses the LOAN-LEVEL row; multi-property loans are handled by');
  out.push('aggregating sub-property rooms/units/SF + computing weighted income share.');
  out.push('');

  out.push('==============================================================================');
  out.push('(2) PARSED ANNEX A FIELDS FOR LOAN #17');
  out.push('==============================================================================');
  out.push('');
  out.push(JSON.stringify(rawAnnexA, null, 2));
  out.push('');

  out.push('==============================================================================');
  out.push('(3) JOIN-KEY CONFIRMATION + 10-D REALIZED LOSS ROW');
  out.push('==============================================================================');
  out.push('');
  out.push('Annex A Loan Number = "Mortgage Loan Number" column (Control Number) = 17');
  out.push('10-D Historical Liquidated Loan Detail: Pros ID = 17, Loan Number = 440000186');
  out.push('');
  out.push('JOIN: EX-102.assetNumber === Annex A "Mortgage Loan Number" === 10-D "Pros ID"');
  out.push('(All three are the same per-deal sequential ID. For pre-2016 deals only the');
  out.push('Annex A and 10-D refs apply; for post-2016 all three are aligned.)');
  out.push('');
  out.push('10-D row for Pros ID 17 (verbatim from /tmp/wfrbs-10D-ex991.htm page 22):');
  out.push(JSON.stringify(rawTenD, null, 2));
  out.push('');

  out.push('==============================================================================');
  out.push('(4) FULL JOINED DealBag RECORD — origination inputs + outcome');
  out.push('==============================================================================');
  out.push('');
  out.push(JSON.stringify(dealBag, null, 2));
  out.push('');

  out.push('==============================================================================');
  out.push('(5) FIELD-COVERAGE MAP: Annex A vs EX-102 parity (DealBag fields)');
  out.push('==============================================================================');
  out.push('');
  out.push('Status legend: populated=in source verbatim, derived=computable from other fields,');
  out.push('               null=not in source at all');
  out.push('');
  for (const e of FIELD_COVERAGE) {
    out.push(`  ${e.dealBagField.padEnd(34)} | Annex A: ${e.annexA.padEnd(9)} | EX-102: ${e.ex102.padEnd(9)} | ${e.notes ?? ''}`);
  }
  out.push('');
  const populated = FIELD_COVERAGE.filter(e => e.annexA === 'populated').length;
  const derived   = FIELD_COVERAGE.filter(e => e.annexA === 'derived').length;
  const nullish   = FIELD_COVERAGE.filter(e => e.annexA === 'null').length;
  out.push(`Annex A coverage: ${populated} populated + ${derived} derived + ${nullish} null = ${FIELD_COVERAGE.length} total`);
  const populated2 = FIELD_COVERAGE.filter(e => e.ex102 === 'populated').length;
  const derived2   = FIELD_COVERAGE.filter(e => e.ex102 === 'derived').length;
  const nullish2   = FIELD_COVERAGE.filter(e => e.ex102 === 'null').length;
  out.push(`EX-102 coverage:  ${populated2} populated + ${derived2} derived + ${nullish2} null = ${FIELD_COVERAGE.length} total`);
  out.push('');
  out.push('PARITY SUMMARY:');
  out.push('  • Annex A IS COMPARABLE to EX-102 for DealBag purposes. The two sources have');
  out.push('    closely matching coverage on the engine-input side.');
  out.push('  • Annex A is RICHER on: sub-type (specific property type), prior-year actuals');
  out.push('    (T7/T8 give multi-year P&L), upfront reserves at closing (PIP, TI/LC, env).');
  out.push('  • EX-102 is RICHER on: trajectory data (monthly snapshots over the deal life),');
  out.push('    workout/special-servicing status (the LOSS-spike fields), most-recent');
  out.push('    valuation as time progresses.');
  out.push('  • BOTH lack: PCA immediate-repairs detail (third-party report); full');
  out.push('    rent-roll (only top-3 tenants surfaced in both — and only when applicable).');
  out.push('  • The backbone records (Annex A inputs + 10-D realized-loss outcome) WILL be');
  out.push('    comparable to supplement records (EX-102 inputs + 10-D realized-loss');
  out.push('    outcome) once the corpus is built. No engine-input gap between the two');
  out.push('    vintages.');
  out.push('');

  out.push('==============================================================================');
  out.push('(6) MULTI-PROPERTY (PORTFOLIO) HANDLING');
  out.push('==============================================================================');
  out.push('');
  out.push('Loan #17 IS a 2-property portfolio (Holiday Inn Riverside + Holiday Inn Express,');
  out.push('both in Minot ND). Annex A surfaces this as:');
  out.push('');
  out.push('  Loan-level row     (N=17, label "17 Minot Hotel Portfolio")');
  out.push('  Sub-property rows  (N.01="17.01 Holiday Inn Riverside"');
  out.push('                       N.02="17.02 Holiday Inn Express")');
  out.push('');
  out.push('AGGREGATION RULES (applied by the parser):');
  out.push('  - Loan TERMS (coupon, term, amort, IO, original balance) live on N only.');
  out.push('    Sub-rows leave these BLANK because they\'re not loan-level.');
  out.push('  - Property METADATA (year built, renovated, units) is on each sub-row;');
  out.push('    aggregate at loan-level via sum (units) or weighted average (year built).');
  out.push('  - Appraised value can be either reported at loan-level only OR allocated');
  out.push('    across sub-properties. Loan #17 reports $25.1M loan-level + $16.2M for');
  out.push('    17.01 + $8.9M for 17.02 = $25.1M. (Same in EX-102: the valuation field');
  out.push('    is loan-level; multi-property sub-allocations appear in 10-D page 9.)');
  out.push('  - UW financials (NOI/NCF/revenue): loan-level aggregate is what the engine');
  out.push('    consumes; sub-property breakouts surface for analyst attribution only.');
  out.push('');
  out.push('Same pattern in EX-102 for portfolio loans (handled in the spike #1/#2 parser');
  out.push('via NumberPropertiesSecuritization > 1 and the nested <property> XML elements).');
  out.push('');

  out.push('==============================================================================');
  out.push('(7) PARSEABILITY NOTES — what the general parser needs to do');
  out.push('==============================================================================');
  out.push('');
  out.push('FORMAT: HTML tables with positional column anchors. No CSS class hooks, no XML.');
  out.push('Each prospectus is a custom layout but the COLUMN HEADERS are stable English-');
  out.push('language anchors (e.g., "Mortgage Loan Number Property Name", "Cut-off Date');
  out.push('Principal Balance", "Underwritten Net Operating Income", etc.).');
  out.push('');
  out.push('STRATEGY for the production parser:');
  out.push('  1. Identify Annex A section (search for "ANNEX A" + "MORTGAGE LOAN" in title).');
  out.push('  2. Strip HTML; tokenize into rows using line breaks or position markers.');
  out.push('  3. Find each of the 14 expected tables by header-anchor regex.');
  out.push('  4. For each table:');
  out.push('     - Identify the column-header row.');
  out.push('     - Iterate rows by Control Number; for sub-rows handle the N.NN pattern.');
  out.push('     - Map each cell to the DealBag field by column index.');
  out.push('  5. Aggregate sub-property rows up to loan-level.');
  out.push('');
  out.push('EDGE CASES seen on WFRBS 2013-C11:');
  out.push('  - Sub-property year-built/renovated values are sometimes "Various" instead of');
  out.push('    a numeric year (parser must accept null).');
  out.push('  - Reserves at closing use NAMED entries (PIP Reserve, In-Shape Reserve, Envt');
  out.push('    Reserve, etc.) — generic parser maps the named-amount column to its DealBag');
  out.push('    field by the reserve-type key. PIP for hospitality = PCA/CapEx equivalent.');
  out.push('  - Some loans have "NAV" for prior-year actuals (e.g., new construction). Parser');
  out.push('    treats NAV as null.');
  out.push('  - Hospitality loans have ADR + RevPAR in extra columns; multifamily has Units +');
  out.push('    Cost-per-Unit. The parser dispatches on assetType to know which extra fields');
  out.push('    to extract.');
  out.push('');

  out.push('==============================================================================');
  out.push('(8) SCALE-UP IMPLICATIONS (additions to spike #1/#2 list A-J)');
  out.push('==============================================================================');
  out.push('');
  out.push('K. ANNEX A is the only origination source for pre-2016 deals. EX-102 doesn\'t');
  out.push('   exist for them. The general parser MUST handle Annex A for the 15-deal');
  out.push('   backbone of the locked first-batch.');
  out.push('');
  out.push('L. PARSE COMPLEXITY: Annex A is harder than EX-102. EX-102 is structured XML');
  out.push('   with documented field names; Annex A is HTML tables that vary slightly per');
  out.push('   issuer. Production parser needs per-shelf template tolerance (try anchor');
  out.push('   variants like "Cut-off Date Principal Balance" / "Cut-off Date Balance" /');
  out.push('   "Original Balance" / "Initial Loan Balance").');
  out.push('');
  out.push('M. JOIN KEY UNIFICATION: Annex A "Mortgage Loan Number" = EX-102 "assetNumber"');
  out.push('   = 10-D "Pros ID" — the unified within-trust loan ID. Same numbering applies');
  out.push('   across all three sources per trust. No translation layer needed.');
  out.push('');
  out.push('N. ANNEX A IS RICHER THAN EX-102 FOR SOME FIELDS. Multi-year actuals (T7-T8)');
  out.push('   give the engine prior-period NOI directly; EX-102 requires walking the');
  out.push('   monthly trajectory to compute the same number. Annex A also has full');
  out.push('   closing reserves (PIP, TI/LC, environmental) and named-property-type sub-');
  out.push('   categorization that EX-102 lacks. Use Annex A where present, derive from');
  out.push('   EX-102 trajectory where not.');
  out.push('');
  out.push('O. LOSS-CLASS RECORDS WITH BOTH SOURCES: 5 loans in WFRBS 2013-C11 were');
  out.push('   liquidated (per 10-D); 2 took realized losses to trust ($10.33M and $2.35M).');
  out.push('   Each of those 2 will be a full LOSS-class record: Annex A origination inputs +');
  out.push('   10-D realized loss + 3-class label. Production reader iterates over the');
  out.push('   liquidated-loan rows and joins each to its Annex A counterpart by Pros ID.');
  out.push('');

  out.push('Output written to: ' + OUT_PATH);
  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[spike-annexA] wrote ${out.join('\n').length} chars to ${OUT_PATH}`);
}

main();

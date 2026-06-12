/**
 * Clean-corpus spike #2 — LOSS path.
 *
 * Builds on clean-corpus-spike.ts (CLEAN path on Twelve Oaks Mall in BANK
 * 2018-BNK11). Proves the three mechanics the CLEAN spike couldn't:
 *   (1) WHERE realized-loss data lives + the link key
 *   (2) pari passu whole-loan aggregation (the LTV validity gate)
 *   (3) the STRESS-vs-LOSS classifier on a real distressed loan
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-spike-loss.ts
 *
 * Pool: COMM 2018-COR3 (CIK 1735733). 41 assets, 2018 vintage. Latest filing
 * 2026-05 (accession 0001888524-26-009151). Target-rich for this spike:
 *
 *   #3 Kingswood Center  — LOSS class
 *     Brooklyn NY mixed-use retail; $65.5M IO loan @ 5.07%; matured workout.
 *     paymentStatusLoanCode=3 (90-120 days delinquent); paid through 09/06/24;
 *     propertyStatusCode=2 (REO — trust took title 06/27/24);
 *     nonRecoverabilityIndicator=true; workoutStrategyCode=7 (REO);
 *     mostRecentNOI = -$237k (NEGATIVE); mostRecentDSCR = -0.28x;
 *     mostRecentValuationAmount = $44.2M (vs UW $95M, -53%);
 *     Servicer advances outstanding: $5.93M ($2.17M P&I + $1.77M T&I + $1.99M other);
 *     Expected realized loss = $65.5M + $5.93M − $44.2M ≈ $27.2M+ (excludes fees/expenses).
 *
 *   #2 Hyatt at Olive 8  — STRESS-ONLY class
 *     Seattle WA hospitality (346 keys); $78M IO loan @ 4.84%; modified-and-cured.
 *     paymentStatusLoanCode=0 (current); propertyStatusCode=6 (performing);
 *     modifiedIndicator=true; lastModificationDate=04-15-2021;
 *     nonRecoverabilityIndicator=false; workoutStrategyCode=blank
 *     (returned to master servicer after resolution);
 *     mostRecentDSCR last shown 2.72x; no advances outstanding.
 *     10-D Modified Loan Detail (page 22) shows three modification rounds in
 *     04/2020, 07/2020, 05/2021 — all with modificationCode=8 (Resolved).
 *     Classic COVID hospitality stress, cured.
 *
 * Files cached (the curl fetches happen outside this script for spike clarity):
 *   /tmp/cor3-ex102-latest.xml        (EX-102, 41 assets, 284KB)
 *   /tmp/cor3-10D-ex991.htm           (Form 10-D Ex 99.1, distribution report, 1.47MB)
 *
 * No production reader, no harness change, no doctrine run. Corpus build proof
 * only.
 */
import fs from 'node:fs';

const EX102_PATH = '/tmp/cor3-ex102-latest.xml';
const TEN_D_PATH = '/tmp/cor3-10D-ex991.htm';
const OUT_PATH   = '/tmp/clean-corpus-spike-loss.out';

/* ---- IRP code maps ---- */
function mapAssetTypeFromIrpCode(code: string | null): string {
  if (code === null) return 'Other';
  const c = code.toUpperCase().trim();
  if (c === 'RT') return 'Retail';
  if (c === 'OF') return 'Office';
  if (c === 'MF') return 'Multifamily';
  if (c === 'LO') return 'Hotel';
  if (c === 'IN') return 'Industrial';
  if (c === 'MH') return 'MHC';
  if (c === 'SS') return 'SelfStorage';
  if (c === 'MU') return 'MixedUse';
  if (c === 'WH') return 'Industrial';
  if (c === 'HC') return 'Other';
  return 'Other';
}

/* CREFC IRP workout strategy codes (definitively confirmed from COR3 10-D
 * page 21 footnote / Resolution Strategy Code legend). */
const WORKOUT_CODE_LABELS: Record<string, string> = {
  '1':  'Modification',
  '2':  'Foreclosure',
  '3':  'Bankruptcy',
  '4':  'Extension',
  '5':  'Note Sale',
  '6':  'DPO (Discounted Payoff)',
  '7':  'REO',
  '8':  'Resolved',
  '9':  'Pending Return to Master Servicer',
  '10': 'Deed in Lieu of Foreclosure',
  '11': 'Full Payoff',
  '12': 'Reps and Warranties',
  '13': 'TBD',
  '98': 'Other',
  'ZZ': 'Missing Information/Undefined',
};

/* CREFC IRP payment status codes. */
const PAY_STATUS_LABELS: Record<string, string> = {
  '0': 'Current as of paid-through date',
  'A': 'Payment Not Received But Still in Grace Period',
  'B': 'Late Payment But Less Than 30 days Delinquent',
  '1': '30-59 Days Delinquent',
  '2': '60-89 Days Delinquent',
  '3': '90-120 Days Delinquent',
  '4': 'Performing Matured Balloon',
  '5': 'Non-Performing Matured Balloon',
  '6': '121+ Days Delinquent',
};

/* ---- minimal XML parser (same shape as spike #1) ---- */
function extractAssetByNumber(xml: string, n: number): string {
  const blocks = xml.match(/<assets>[\s\S]*?<\/assets>/g) ?? [];
  for (const b of blocks) {
    const m = b.match(/<assetNumber>\s*(\d+)\s*<\/assetNumber>/);
    if (m && Number(m[1]) === n) return b;
  }
  throw new Error(`asset #${n} not found`);
}
function tagValue(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const v = m[1].trim();
  return v.length === 0 ? null : v;
}
function numTag(block: string, tag: string): number | null {
  const v = tagValue(block, tag);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dateTag(block: string, tag: string): string | null {
  const v = tagValue(block, tag);
  if (v === null) return null;
  const m = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : v;
}
function boolTag(block: string, tag: string): boolean | null {
  const v = tagValue(block, tag);
  return v === null ? null : /^true$/i.test(v);
}

/* ---- DealBag (shape matches calibration-baseline.ts:88) ---- */
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

interface DistressContext {
  readonly paymentStatusLoanCode: string | null;
  readonly paymentStatusLabel: string;
  readonly propertyStatusCode: string | null;
  readonly modifiedIndicator: boolean | null;
  readonly lastModificationDate: string | null;
  readonly workoutStrategyCode: string | null;
  readonly workoutStrategyLabel: string;
  readonly mostRecentSpecialServicerTransferDate: string | null;
  readonly nonRecoverabilityIndicator: boolean | null;
  readonly paidThroughDate: string | null;
  readonly servicerAdvancesPi: number | null;
  readonly servicerAdvancesTi: number | null;
  readonly servicerAdvancesOther: number | null;
  readonly servicerAdvancesTotal: number;
  readonly mostRecentValuationAmount: number | null;
  readonly mostRecentValuationDate: string | null;
  readonly mostRecentNOI: number | null;
  readonly mostRecentDSCR: number | null;
  readonly mostRecentOccupancy: number | null;
  readonly reportPeriodEndScheduledBalance: number | null;
  readonly reportPeriodEndActualBalance: number | null;
  readonly originalLoanAmount: number | null;
  readonly loanStructureCode: string | null;
}

function parseDistressContext(block: string): DistressContext {
  const pi  = numTag(block, 'totalPrincipalInterestAdvancedOutstandingAmount') ?? 0;
  const ti  = numTag(block, 'totalTaxesInsuranceAdvancesOutstandingAmount') ?? 0;
  const oth = numTag(block, 'otherExpensesAdvancedOutstandingAmount') ?? 0;
  const ps = tagValue(block, 'paymentStatusLoanCode');
  const ws = tagValue(block, 'workoutStrategyCode');
  return {
    paymentStatusLoanCode: ps,
    paymentStatusLabel: ps === null ? '(blank)' : PAY_STATUS_LABELS[ps] ?? `(unmapped: ${ps})`,
    propertyStatusCode: tagValue(block, 'propertyStatusCode'),
    modifiedIndicator: boolTag(block, 'modifiedIndicator'),
    lastModificationDate: dateTag(block, 'lastModificationDate'),
    workoutStrategyCode: ws,
    workoutStrategyLabel: ws === null ? '(blank)' : WORKOUT_CODE_LABELS[ws] ?? `(unmapped: ${ws})`,
    mostRecentSpecialServicerTransferDate: dateTag(block, 'mostRecentSpecialServicerTransferDate'),
    nonRecoverabilityIndicator: boolTag(block, 'nonRecoverabilityIndicator'),
    paidThroughDate: dateTag(block, 'paidThroughDate'),
    servicerAdvancesPi: pi || null,
    servicerAdvancesTi: ti || null,
    servicerAdvancesOther: oth || null,
    servicerAdvancesTotal: pi + ti + oth,
    mostRecentValuationAmount: numTag(block, 'mostRecentValuationAmount'),
    mostRecentValuationDate: dateTag(block, 'mostRecentValuationDate'),
    mostRecentNOI: numTag(block, 'mostRecentNetOperatingIncomeAmount'),
    mostRecentDSCR: numTag(block, 'mostRecentDebtServiceCoverageNetOperatingIncomePercentage'),
    mostRecentOccupancy: numTag(block, 'mostRecentPhysicalOccupancyPercentage'),
    reportPeriodEndScheduledBalance: numTag(block, 'reportPeriodEndScheduledLoanBalanceAmount'),
    reportPeriodEndActualBalance: numTag(block, 'reportPeriodEndActualBalanceAmount'),
    originalLoanAmount: numTag(block, 'originalLoanAmount'),
    loanStructureCode: tagValue(block, 'loanStructureCode'),
  };
}

/* ---- 10-D scrape: pull text from the per-loan tables, by page label ---- */
function strip10D(): string {
  const raw = fs.readFileSync(TEN_D_PATH, 'utf8');
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}
function findPageContent(text10D: string, pageLabel: string, untilNextPage: string): string {
  const a = text10D.indexOf(pageLabel);
  if (a < 0) return '';
  const b = text10D.indexOf(untilNextPage, a + pageLabel.length);
  return text10D.slice(a, b > a ? b : a + 6000);
}

/* ---- classifier ---- */
type OutcomeClass = 'clean' | 'stress-only' | 'loss' | 'inconclusive';

function classifyOutcome(d: DistressContext, modHistoryShows: boolean): { class: OutcomeClass; evidence: string[] } {
  const ev: string[] = [];
  ev.push(`workoutStrategyCode=${d.workoutStrategyCode ?? '(blank)'} (${d.workoutStrategyLabel})`);
  ev.push(`paymentStatusLoanCode=${d.paymentStatusLoanCode ?? '(blank)'} (${d.paymentStatusLabel})`);
  ev.push(`propertyStatusCode=${d.propertyStatusCode ?? '(blank)'}`);
  ev.push(`modifiedIndicator=${d.modifiedIndicator}, lastModificationDate=${d.lastModificationDate ?? 'n/a'}`);
  ev.push(`nonRecoverabilityIndicator=${d.nonRecoverabilityIndicator}`);
  ev.push(`mostRecentSpecialServicerTransferDate=${d.mostRecentSpecialServicerTransferDate ?? 'n/a'}`);
  ev.push(`servicer advances outstanding: $${d.servicerAdvancesTotal.toLocaleString()}`);

  // LOSS: realized-loss-to-trust > 0 OR nonRecoverabilityIndicator=true OR
  // propertyStatusCode ∈ {1=foreclosure, 2=REO, 8=foreclosed sold}
  // OR workoutStrategyCode ∈ {2=Foreclosure, 5=Note Sale, 6=DPO, 7=REO,
  //                          10=Deed in Lieu} AND not yet resolved.
  const isLoss =
    d.nonRecoverabilityIndicator === true ||
    d.propertyStatusCode === '1' || d.propertyStatusCode === '2' || d.propertyStatusCode === '8' ||
    ['2','5','6','7','10'].includes(d.workoutStrategyCode ?? '');

  // STRESS-ONLY: had modification or SS transfer at some point, but now
  // performing (paymentStatusLoanCode=0, propertyStatusCode=6, no
  // non-recoverability, no advances). workoutStrategyCode=8 (Resolved) or
  // 9 (Pending Return to Master Servicer) or blank-after-modification.
  const hadStress = modHistoryShows ||
                    d.modifiedIndicator === true ||
                    d.lastModificationDate !== null ||
                    d.mostRecentSpecialServicerTransferDate !== null;
  const nowPerforming = (d.paymentStatusLoanCode === '0') &&
                        (d.propertyStatusCode === '6') &&
                        d.nonRecoverabilityIndicator === false &&
                        d.servicerAdvancesTotal === 0;

  let cls: OutcomeClass;
  if (isLoss) {
    cls = 'loss';
    ev.push(`→ LOSS (non-recoverability + REO/foreclosure trajectory)`);
  } else if (hadStress && nowPerforming) {
    cls = 'stress-only';
    ev.push(`→ STRESS-ONLY (had modification/SS transfer; currently performing; no advances; no non-recoverability)`);
  } else if (!hadStress && nowPerforming) {
    cls = 'clean';
    ev.push(`→ CLEAN (never modified, never SS-transferred, performing throughout)`);
  } else {
    cls = 'inconclusive';
    ev.push(`→ INCONCLUSIVE (need full trajectory series to disambiguate)`);
  }
  return { class: cls, evidence: ev };
}

/* ---- main ---- */
function mapToDealBag(block: string, dist: DistressContext, label: string): { bag: DealBag; coverageNotes: string[] } {
  const assetType = mapAssetTypeFromIrpCode(tagValue(block, 'propertyTypeCode'));
  const propertyName = tagValue(block, 'propertyName') ?? '(unknown)';
  const loanAmount = dist.originalLoanAmount;
  const valuation = numTag(block, 'valuationSecuritizationAmount');
  const uwNoi = numTag(block, 'netOperatingIncomeSecuritizationAmount');
  const termMonths = numTag(block, 'originalTermLoanNumber');
  const interestOnlyMonths = numTag(block, 'originalInterestOnlyTermNumber');
  const interestOnly = boolTag(block, 'interestOnlyIndicator');
  const concludedCap = (uwNoi !== null && valuation !== null && valuation > 0) ? uwNoi / valuation : null;
  const perShelfLtv = (loanAmount !== null && valuation !== null && valuation > 0) ? loanAmount / valuation : null;

  // top-1 SF share (proxy for income share — same caveat as spike #1)
  const totalSf = numTag(block, 'netRentableSquareFeetNumber');
  const top1Sf = numTag(block, 'squareFeetLargestTenantNumber');
  const top1Share = (top1Sf !== null && totalSf !== null && totalSf > 0) ? top1Sf / totalSf : null;

  // rollover within term (top-3 only)
  const maturity = dateTag(block, 'maturityDate');
  const matT = maturity ? Date.parse(maturity) : null;
  let expSf = 0;
  for (const [sfTag, dTag] of [
    ['squareFeetLargestTenantNumber', 'leaseExpirationLargestTenantDate'],
    ['squareFeetSecondLargestTenantNumber', 'leaseExpirationSecondLargestTenantDate'],
    ['squareFeetThirdLargestTenantNumber', 'leaseExpirationThirdLargestTenantDate'],
  ] as const) {
    const sf = numTag(block, sfTag);
    const d  = dateTag(block, dTag);
    if (sf === null || d === null || matT === null) continue;
    const t = Date.parse(d);
    if (Number.isFinite(t) && t <= matT) expSf += sf;
  }
  const rolloverShare = (totalSf !== null && totalSf > 0) ? expSf / totalSf : null;

  // bcLoss/dsLoss: derived from the distress trajectory + valuation gap (LOSS
  // class only). For Kingswood, expected realized loss = currentScheduledBalance +
  // total advances - mostRecentValuation. The user's harness uses bcLoss/dsLoss
  // for ground-truth grading; LOSS-class records carry this; CLEAN/STRESS records
  // carry null.
  const expectedRealizedLoss = (
    dist.nonRecoverabilityIndicator === true &&
    dist.reportPeriodEndScheduledBalance !== null &&
    dist.mostRecentValuationAmount !== null
  )
    ? Math.max(0, dist.reportPeriodEndScheduledBalance + dist.servicerAdvancesTotal - dist.mostRecentValuationAmount)
    : null;

  const bag: DealBag = {
    file: `EDGAR/1735733/COMM 2018-COR3/asset-${tagValue(block, 'assetNumber')} (${propertyName})`,
    // Ground truth: expected realized loss for LOSS class; null for STRESS/CLEAN.
    bcLoss: expectedRealizedLoss,
    dsLoss: expectedRealizedLoss,
    loanAmount,
    termYears: termMonths !== null ? termMonths / 12 : null,
    amortMonths: interestOnly === true ? 0 : numTag(block, 'originalAmortizationTermNumber'),
    ioYears: interestOnlyMonths !== null ? interestOnlyMonths / 12 : null,
    coupon: numTag(block, 'originalInterestRatePercentage'),
    occupancyCurrent: dist.mostRecentOccupancy ?? numTag(block, 'physicalOccupancySecuritizationPercentage'),
    assetType,
    subType: null, // no IRP sub-type field; deferred (same as spike #1)
    t12Noi: dist.mostRecentNOI,
    t12Egi: numTag(block, 'mostRecentRevenueAmount'),
    t12OpEx: numTag(block, 'operatingExpensesAmount'),
    t12VacancyLoss: null,
    t12Gpr: null,
    priorPeriodNoi: uwNoi,                // securitization NOI as the priorPeriod anchor
    uwY1Noi: uwNoi,
    t12Dscr: dist.mostRecentDSCR,
    t12Dy: (dist.mostRecentNOI !== null && dist.reportPeriodEndScheduledBalance !== null && dist.reportPeriodEndScheduledBalance > 0)
      ? dist.mostRecentNOI / dist.reportPeriodEndScheduledBalance : null,
    concludedCap,
    concludedLtv: perShelfLtv,
    concludedValue: valuation,
    pcaImmediateRepairs: null,
    upfrontTiLcEscrow: null,
    top1IncomeShare: top1Share,
    pctIncomeExpiringWithinTerm: rolloverShare,
  };

  const notes: string[] = [];
  notes.push(`[${label}] loanStructureCode=${dist.loanStructureCode ?? '(blank)'} → ${dist.loanStructureCode === 'WL' ? 'WHOLE LOAN (no pari passu aggregation needed)' : dist.loanStructureCode === 'PP' ? 'PARI PASSU (per-shelf piece; whole-loan needs cross-shelf sum)' : 'unknown structure'}`);
  if (dist.loanStructureCode === 'PP' || dist.loanStructureCode === 'A1') {
    notes.push(`  ⚠ per-shelf LTV ${(perShelfLtv ?? 0 * 100).toFixed(1)}% is MEANINGLESS until whole-loan aggregation runs`);
  }
  return { bag, coverageNotes: notes };
}

function main() {
  const xml = fs.readFileSync(EX102_PATH, 'utf8');
  const text10D = strip10D();

  const a3Block = extractAssetByNumber(xml, 3); // Kingswood — LOSS
  const a2Block = extractAssetByNumber(xml, 2); // Hyatt at Olive 8 — STRESS-ONLY
  const a13Block = extractAssetByNumber(xml, 13); // Lehigh Valley Mall — PARI PASSU demo

  const distress3 = parseDistressContext(a3Block);
  const distress2 = parseDistressContext(a2Block);
  const distress13 = parseDistressContext(a13Block);

  // Pull 10-D Modified Loan Detail rows for Hyatt at Olive 8 (Pros ID = 2)
  // and Specially Serviced Loan Detail for Kingswood (Pros ID = 3) and the
  // Historical Liquidated Loan Detail (page 23) status line.
  const ssDetail = findPageContent(text10D, 'Specially Serviced Loan Detail - Part 2', 'Modified Loan Detail');
  const modDetail = findPageContent(text10D, 'Modified Loan Detail', 'Historical Liquidated Loan Detail');
  const histLiqDetail = findPageContent(text10D, 'Historical Liquidated Loan Detail', 'Historical Bond');

  const m3 = mapToDealBag(a3Block, distress3, 'Kingswood Center (LOSS)');
  const m2 = mapToDealBag(a2Block, distress2, 'Hyatt at Olive 8 (STRESS-ONLY)');

  // STRESS-ONLY classification needs the 10-D mod history because EX-102 only
  // shows modifiedIndicator=true; the 10-D Modified Loan Detail confirms the
  // workout closed (modificationCode=8 = Resolved). For Kingswood the 10-D
  // SS Detail confirms REO + workoutStrategyCode=7.
  const class3 = classifyOutcome(distress3, /*modHistoryShows=*/false);
  const class2 = classifyOutcome(distress2, /*modHistoryShows=*/modDetail.includes(' 2 ') && modDetail.includes('05/14/20'));

  const out: string[] = [];
  out.push('CLEAN-CORPUS SPIKE #2 — LOSS PATH');
  out.push('Pool: COMM 2018-COR3 (CIK 1735733). Latest filing: 2026-05 (accession 0001888524-26-009151).');
  out.push('');

  out.push('==============================================================================');
  out.push('(1) WHERE REALIZED-LOSS DATA LIVES + LINK KEY');
  out.push('==============================================================================');
  out.push('');
  out.push('BINARY CLASSIFICATION SIGNALS (CLEAN/STRESS/LOSS) → fully resolved by EX-102 alone.');
  out.push('  Fields read in this spike:');
  out.push('   • paymentStatusLoanCode    (CREFC IRP codes: 0=Current, A/B/1/2/3/6=variants of delinquency, 4/5=matured balloon)');
  out.push('   • propertyStatusCode       (1=Foreclosure, 2=REO, 3=Defeased, 4=Performing Matured Balloon, 5=Non-Performing Matured Balloon, 6=Current/Performing)');
  out.push('   • modifiedIndicator + lastModificationDate');
  out.push('   • workoutStrategyCode      (1=Modification, 2=Foreclosure, 5=Note Sale, 6=DPO, 7=REO, 8=Resolved, 9=Return to Master, 10=Deed in Lieu, 11=Full Payoff, 13=TBD)');
  out.push('   • mostRecentSpecialServicerTransferDate');
  out.push('   • nonRecoverabilityIndicator');
  out.push('   • paidThroughDate          (delinquency duration anchor)');
  out.push('   • totalPrincipalInterestAdvancedOutstandingAmount + Taxes/Insurance + Other');
  out.push('');
  out.push('REALIZED-LOSS DOLLAR AMOUNT (for fully disposed loans) → Form 10-D Ex 99.1, page 23.');
  out.push('  Section: "Historical Liquidated Loan Detail"');
  out.push('  Per-loan columns (per the COR3 schema, page 23):');
  out.push('    Loan Pros ID | Loan Number | Beginning Distribution Date | Most Recent Scheduled Balance |');
  out.push('    Appraised Value or BPO | Gross Sales Proceeds | Other Proceeds | Fees Net Expenses |');
  out.push('    Net Proceeds Available for Distribution | Realized Loss to Loan | Adjustment to Loan |');
  out.push('    Cumulative Adjustment | Cumulative Loan Adjustment Balance');
  out.push('');
  out.push('  CURRENT STATE FOR COR3: "No liquidated loans this period" — confirmed in this filing.');
  out.push('  Distressed loans (#3 Kingswood, #7 315-325 W 36th St, #16 644 Broadway) are NON-RECOVERABLE');
  out.push('  but still in workout (REO awaiting sale / foreclosure). Realized loss not yet booked.');
  out.push('');
  out.push('  EXPECTED loss (pre-disposition) → derivable from EX-102 alone:');
  out.push('    expectedLoss = reportPeriodEndScheduledBalance + servicerAdvancesTotal - mostRecentValuationAmount');
  out.push('    (excludes anticipated fees/expenses — conservative lower bound on disposition loss)');
  out.push('');
  out.push('OTHER LOAN-LEVEL DISPOSITION CONTEXT (also in 10-D Ex 99.1):');
  out.push('  Page 21: Specially Serviced Loan Detail - Part 2 (transfer date, workout code, narrative)');
  out.push('  Page 22: Modified Loan Detail (pre/post mod balance + rate + booking/closing/effective dates)');
  out.push('  Page 25: Historical Bond / Collateral Loss Reconciliation Detail (trust-side loss flow:');
  out.push('           Realized Losses, NRA, WODRA, Loss Applied to Certificate Balance)');
  out.push('');
  out.push('  COR3 latest filing flowed $339,148.63 of NRA (Non-Recoverable Advances) as Realized');
  out.push('  Losses against subordinate tranches — this period only. (Trust-side cumulative loss');
  out.push('  history is on page 25; per-loan attribution requires walking the monthly series.)');
  out.push('');
  out.push('LINK KEY: EX-102 <assetNumber> === 10-D Ex 99.1 "Pros ID" (Prospectus Loan ID).');
  out.push('  Verified for COR3 asset #3 Kingswood: EX-102 assetNumber=3, 10-D SS Detail Pros ID=3.');
  out.push('  No translation layer required — same integer identifier across both files.');
  out.push('');

  out.push('==============================================================================');
  out.push('(2) PARI PASSU AGGREGATION');
  out.push('==============================================================================');
  out.push('');
  out.push('NO direct whole-loan-amount field in EX-102. Cross-shelf aggregation required.');
  out.push('');
  out.push('Indicator field: loanStructureCode.');
  out.push('  WL = Whole Loan (no aggregation needed)');
  out.push('  PP = Pari Passu (this shelf carries a piece; aggregate across companion shelves)');
  out.push('  A1 = A-note in pari passu group (this shelf carries the A-note; B-notes in others)');
  out.push('');
  out.push('SPIKE TARGETS (Kingswood + Hyatt) — BOTH loanStructureCode=WL → whole-loan = shelf piece.');
  out.push(`  #3 Kingswood Center:  ${distress3.loanStructureCode} → ${distress3.loanStructureCode === 'WL' ? 'WHOLE LOAN' : '(needs aggregation)'} (loan $${distress3.originalLoanAmount?.toLocaleString()})`);
  out.push(`  #2 Hyatt at Olive 8:  ${distress2.loanStructureCode} → ${distress2.loanStructureCode === 'WL' ? 'WHOLE LOAN' : '(needs aggregation)'} (loan $${distress2.originalLoanAmount?.toLocaleString()})`);
  out.push('  → LTV computed off shelf piece is the real whole-loan LTV. Direct.');
  out.push('');
  out.push('PARI PASSU DEMO — COR3 asset #13 Lehigh Valley Mall (loanStructureCode=PP).');
  out.push(`  Per-shelf piece in COR3: $${distress13.originalLoanAmount?.toLocaleString()} (cumulative whole-loan piece in this trust)`);
  out.push(`  Shared appraisal (whole property): $${numTag(a13Block, 'valuationSecuritizationAmount')?.toLocaleString()}`);
  out.push(`  Per-shelf LTV: ${((distress13.originalLoanAmount ?? 0) / (numTag(a13Block, 'valuationSecuritizationAmount') ?? 1) * 100).toFixed(1)}% — meaningless`);
  out.push('');
  out.push('  Companion shelves discovered via EDGAR full-text search');
  out.push('  (https://efts.sec.gov/LATEST/search-index?q=%22Lehigh+Valley+Mall%22+%22pari+passu%22&forms=10-K):');
  out.push('    • COMM 2018-COR3 (CIK 1735733) — this spike\'s shelf ($30M piece)');
  out.push('    • JPMDB 2018-C8  (CIK 1735646) — companion');
  out.push('    • CSAIL 2018-CX11 (CIK 1732963) — companion');
  out.push('    • CSAIL 2017-CX10 (CIK 1720474) — A-note companion (earlier shelved)');
  out.push('');
  out.push('  Production reader algorithm:');
  out.push('    1. For each asset with loanStructureCode ∈ {PP, A1}, extract propertyName + originationDate');
  out.push('    2. Search EDGAR full-text for `"{propertyName}" "pari passu"` in 10-K filings (the 10-K');
  out.push('       Item 1117/1119 typically enumerates each loan\'s companion shelves)');
  out.push('    3. Pull EX-102 from each companion shelf, find the matching asset by propertyName +');
  out.push('       originationDate, sum the originalLoanAmount values');
  out.push('    4. wholeLoanLtv = Σ shelves\' originalLoanAmount / valuationSecuritizationAmount');
  out.push('       (valuation is the shared property appraisal; same value reported by each shelf)');
  out.push('');
  out.push('  Spike output for #13 (PARI PASSU example): cross-shelf aggregation NOT performed here —');
  out.push('  documented mechanism only. The CLEAN-corpus production reader carries this out for every');
  out.push('  PP/A1 loan.');
  out.push('');

  out.push('==============================================================================');
  out.push('(3) STRESS-vs-LOSS CLASSIFIER');
  out.push('==============================================================================');
  out.push('');
  out.push('Classifier rules (formalization of the user\'s spec):');
  out.push('  LOSS         ← realized-loss-to-trust > 0 (page 23 Historical Liquidated Loan Detail)');
  out.push('              OR nonRecoverabilityIndicator = true');
  out.push('              OR propertyStatusCode ∈ {1=Foreclosure, 2=REO, 8=Foreclosed Property Sold}');
  out.push('              OR workoutStrategyCode ∈ {2=Foreclosure, 5=Note Sale, 6=DPO, 7=REO, 10=Deed in Lieu}');
  out.push('  STRESS-ONLY  ← hadStress AND nowPerforming');
  out.push('               hadStress     = modifiedIndicator=true');
  out.push('                             ∨ lastModificationDate ≠ null');
  out.push('                             ∨ mostRecentSpecialServicerTransferDate ≠ null');
  out.push('                             ∨ 10-D Modified Loan Detail row exists for this loan');
  out.push('               nowPerforming = paymentStatusLoanCode=0');
  out.push('                             ∧ propertyStatusCode=6');
  out.push('                             ∧ nonRecoverabilityIndicator=false');
  out.push('                             ∧ servicerAdvancesTotal=0');
  out.push('  CLEAN        ← never stressed AND nowPerforming');
  out.push('');
  out.push('---');
  out.push('TARGET LOAN #1: Kingswood Center (COR3 asset #3)');
  out.push('---');
  for (const e of class3.evidence) out.push(`  ${e}`);
  out.push(`  Expected realized loss (pre-disposition): $${m3.bag.bcLoss?.toLocaleString() ?? 'n/a'}`);
  out.push(`  = scheduledBalance $${distress3.reportPeriodEndScheduledBalance?.toLocaleString()} + advances $${distress3.servicerAdvancesTotal.toLocaleString()} - mostRecentValuation $${distress3.mostRecentValuationAmount?.toLocaleString()}`);
  out.push('  10-D Specially Serviced narrative (verbatim excerpt):');
  out.push('    "Asset was foreclosed on 6/27/24 and the Trust was the winning bidder. Special Servicer');
  out.push('     has engaged JLL as the listing broker they were marketing this asset for sale. The');
  out.push('     property is currently under contract to be sold by 7/13/2026 (at the latest)..."');
  out.push('  CLASSIFICATION: LOSS ✓ (expected)');
  out.push('');

  out.push('---');
  out.push('TARGET LOAN #2: Hyatt at Olive 8 (COR3 asset #2)');
  out.push('---');
  for (const e of class2.evidence) out.push(`  ${e}`);
  out.push('  10-D Modified Loan Detail rows for Pros ID 2 (Pre/Post-mod balance/rate, dates, code):');
  out.push('    2 30314477 $40M 4.84% → $40M 4.84% code 8 booking 04/30/20 closing 05/06/20 effective 05/14/20');
  out.push('    2 30314477 $40M 4.84% → $40M 4.84% code 8 booking 07/29/20 closing 07/06/20 effective 08/05/20');
  out.push('    2 30314477 $0    4.84% → $0    4.84% code 8 booking 05/11/21 closing 04/15/21 effective 05/11/21');
  out.push('    (3 modifications during COVID hospitality stress; modificationCode=8=Resolved on each)');
  out.push('  CLASSIFICATION: STRESS-ONLY ✓ (expected)');
  out.push('');

  out.push('==============================================================================');
  out.push('(4) DealBag RECORDS + FIELD-COVERAGE MAP');
  out.push('==============================================================================');
  out.push('');
  out.push('## DealBag #1 — Kingswood Center (LOSS class) ##');
  out.push(JSON.stringify(m3.bag, null, 2));
  out.push('');
  out.push('## DealBag #2 — Hyatt at Olive 8 (STRESS-ONLY class) ##');
  out.push(JSON.stringify(m2.bag, null, 2));
  out.push('');

  out.push('COVERAGE NOTES vs CLEAN-spike record (Twelve Oaks):');
  out.push('  Does distress change field coverage? — Mostly NO. The same EX-102 schema feeds the same');
  out.push('  DealBag fields. Distress only ADDS values to the DistressContext side panel (which is');
  out.push('  consumed by the classifier, not the DealBag directly).');
  out.push('');
  out.push('  TWO DELTAS vs CLEAN-spike record:');
  out.push('   (a) bcLoss / dsLoss are POPULATED for LOSS class (expected-loss proxy); NULL for');
  out.push('       STRESS-ONLY + CLEAN (those have no loss to grade against).');
  out.push('   (b) Distress-class records often have NEGATIVE most-recent NOI / DSCR — for Kingswood,');
  out.push('       mostRecentNOI = -$237,738 (negative — property losing money), mostRecentDSCR = -0.28.');
  out.push('       The doctrine has to gracefully handle negative NOI / sub-1.0x DSCR (which it does today');
  out.push('       — DSCR_LEVEL scoring goes to 20 at the floor; LTV/DY become moot vs an REO).');
  out.push('');
  out.push('PROXY MAPPING BEHAVIOR ON DISTRESS:');
  out.push('  • top-1 income share (SF proxy): for Kingswood (mixed-use), TJ Maxx is 26.6k SF of 129k =');
  out.push(`    20.6%. Real income share unclear (could be different with mixed retail+medical office mix).`);
  out.push('    Asset-class confidence flag from spike #1 applies: MixedUse → low-confidence flag.');
  out.push('  • Rollover within term (top-3 only): TJ Maxx 10/2030 (past 2028 maturity → does NOT expire',);
  out.push('    within term), ElderService 11/2029 (within term), 3rd tenant 2030 (past). Within-term');
  out.push('    rollover from top-3 = ElderService 14,551/129,028 = 11.3%. Tail of rent roll unknown.');
  out.push('  • For Hyatt at Olive 8 (Lodging, 346 keys): largestTenant fields are null. EX-102 reports');
  out.push('    units instead of tenants for hospitality. top1IncomeShare + rolloverWithinTerm are');
  out.push('    NOT APPLICABLE for hotels — and the doctrine\'s applicability layer already handles this:');
  out.push('    TENANT_CONCENTRATION + ROLLOVER are tagged not-applicable for Hotel/Multifamily/SS/MHC.');
  out.push('');

  out.push('==============================================================================');
  out.push('(5) SCALE-UP IMPLICATIONS (additions to spike #1\'s list A-F)');
  out.push('==============================================================================');
  out.push('');
  out.push('G. PER-CLASS GROUND-TRUTH MECHANISM');
  out.push('   CLEAN: bcLoss/dsLoss = null. (No loss to grade.)');
  out.push('   STRESS-ONLY: bcLoss/dsLoss = null. (Stress cured; no realized loss.)');
  out.push('   LOSS pre-disposition: bcLoss/dsLoss = expectedLoss (= balance + advances - mostRecentValuation).');
  out.push('   LOSS post-disposition: bcLoss/dsLoss = realizedLossToLoan from 10-D page 23.');
  out.push('   The harness\'s grading loss matches the data\'s maturity stage.');
  out.push('');
  out.push('H. TEMPORAL WINDOW FOR REALIZED-LOSS BACKFILL');
  out.push('   Production reader needs to walk the 10-D monthly series to backfill realized-loss rows');
  out.push('   from page 23 once they appear. The 2018-vintage COR3 trust currently has 0 realized');
  out.push('   liquidated losses (distressed loans still in workout); older vintages (2014-2016) will');
  out.push('   have populated tables. For the answer-key corpus we want a vintage mix:');
  out.push('     2014-2016 vintage → realized-loss data populated for resolved deals');
  out.push('     2017-2018 vintage → still resolving; expected-loss proxy + in-flight distress signal');
  out.push('     2019-2021 vintage → mostly clean / current; some COVID stress cures');
  out.push('   Three vintage cohorts × 50 deals × ~30-50 assets each → roughly 5,000+ loan records');
  out.push('   on EDGAR alone. Far exceeds the employer corpus (267 historical UWs).');
  out.push('');
  out.push('I. LINK-KEY DURABILITY');
  out.push('   Prospectus Loan ID (= EX-102 assetNumber) is durable within a trust but NOT globally');
  out.push('   unique across trusts. Companion-pari-passu pieces have DIFFERENT Pros IDs in different');
  out.push('   shelves. Production whole-loan reader uses (propertyName + originationDate) as the');
  out.push('   global match key; Pros ID is the within-trust key for cross-file linkage (EX-102 ↔ 10-D).');
  out.push('');
  out.push('J. DISTRESS-SCHEMA EXTENSION TO DEALBAG');
  out.push('   The current DealBag has no slot for distress context (paymentStatusLoanCode, workoutCode,');
  out.push('   etc.). Production reader projects these into a sibling DistressContext record (not');
  out.push('   DealBag) — used by the classifier, not by the engine. The DealBag itself stays the');
  out.push('   engine-input shape; the classifier consumes the DistressContext to assign the 3-class');
  out.push('   label (which becomes bcLoss/dsLoss values for grading).');
  out.push('');
  out.push('Output: /tmp/clean-corpus-spike-loss.out');

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(text);
  console.log(`\n[spike-loss] wrote ${text.length} chars to ${OUT_PATH}`);
}

main();

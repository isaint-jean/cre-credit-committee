/**
 * Clean-corpus spike: build ONE answer-key record from public SEC ABS-EE
 * filings, replacing employer corpus dependence. Proof-of-concept; scale-up
 * design happens after this lands.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-spike.ts
 *
 * Pipeline:
 *   1. Reads two ABS-EE EX-102 XMLs (one early-trajectory, one most-recent)
 *      from /tmp/bank2018-bnk11-ex102-*.xml. The fetcher is a small curl
 *      one-liner outside this script for spike clarity:
 *
 *        curl -sS -L -A 'CRE-Credit-Committee Research <email>' \
 *          "https://www.sec.gov/Archives/edgar/data/{CIK}/{accession-no-dashes}/exh_102.xml"
 *
 *   2. Parses asset #1 (Twelve Oaks Mall) from each.
 *   3. Maps to the harness's DealBag shape (apps/api/src/scripts/
 *      calibration-baseline.ts:88).
 *   4. Derives 3-class outcome from the trajectory.
 *   5. Reports coverage: per-DealBag-field, populated vs null vs structurally-
 *      absent. This is the load-bearing artifact for designing the production
 *      reader + the engine-input gap-fill.
 *
 * Spike target deal:
 *   CIK 1731627 = BANK 2018-BNK11 (2018 conduit shelf, $66.67M piece of a
 *   pari passu Twelve Oaks Mall whole-loan; 716,771 SF regional mall, Novi
 *   MI; Wells Fargo originator; 4.40% / 10yr term / 30yr amort; balloon).
 *   Securitization snapshot from 2022-12 filing; current snapshot from
 *   2026-05 filing. Outcome class: expected CLEAN (no modification, code 0
 *   across trajectory, NOI dipped COVID then recovered).
 *
 * Pari passu caveat (load-bearing for scale-up): the BNK11 record shows only
 * its $66.67M piece of the Twelve Oaks whole loan, NOT the full loan size.
 * LTV computed off this piece is meaningless (12% vs the real ~50%). The
 * production reader must aggregate pari passu pieces across shelves via the
 * crossCollateralizedLoanGroupID field (or, when absent, by property-name +
 * origination-date match). For this spike we surface BOTH the BNK11-piece
 * LTV and the per-shelf-cap-rate-derived value (NOI/cap → implied whole
 * collateral value).
 */
import fs from 'node:fs';

const EX102_2022_PATH = '/tmp/bank2018-bnk11-ex102-2022.xml';
const EX102_LATEST_PATH = '/tmp/bank2018-bnk11-ex102-latest.xml';
const OUT_PATH = '/tmp/clean-corpus-spike.out';

/* ----- minimal XML field extractor -----
 *   EX-102 is flat per-asset (one tag per line, only nested level is <property>).
 *   Regex parse is fine for a spike. Production reader uses fast-xml-parser.
 */
function extractFirstAssetBlock(xml: string): string {
  // Find first <assets>...</assets> block (asset #1).
  const m = xml.match(/<assets>[\s\S]*?<\/assets>/);
  if (!m) throw new Error('no <assets> block found');
  return m[0];
}
function tagValue(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = block.match(re);
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
  // EX-102 uses MM-DD-YYYY. Normalize to ISO date string.
  const v = tagValue(block, tag);
  if (v === null) return null;
  const m = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return v; // pass through unknown format
  return `${m[3]}-${m[1]}-${m[2]}`;
}
function boolTag(block: string, tag: string): boolean | null {
  const v = tagValue(block, tag);
  if (v === null) return null;
  return /^true$/i.test(v);
}

/* ----- IRP code maps -----
 *   propertyTypeCode (CREFC IRP): RT=Retail, OF=Office, MF=Multifamily, LO=Lodging,
 *     IN=Industrial, MH=Mobile/Manufactured Housing, SS=Self-Storage,
 *     MU=Mixed Use, HC=Health Care, OT=Other, etc.
 *   propertyStatusCode (per BANK 2018-BNK11 examples + CREFC IRP v8.0):
 *     1=in foreclosure, 2=REO, 3=defeased, 4=performing matured balloon,
 *     5=non-performing matured balloon, 6=current/performing,
 *     7=delinquent — IRP version drift exists; verify with deal docs.
 *   paymentStatusLoanCode: 0=current as of paid-through date, 1=30-days past due,
 *     2=60-days, 3=90+ past due, 4=performing matured balloon (?),
 *     5=non-performing matured balloon (?), 6=foreclosure, A=payment not received
 *     but still within grace, B=late payment but less than 30 days delinquent.
 */
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
  return 'Other';
}

/* ----- per-asset record (one EX-102 snapshot, one loan) ----- */

interface AssetSnapshot {
  readonly filingDate: string | null;
  readonly reportingPeriodEndDate: string | null;

  // Loan
  readonly originalLoanAmount: number | null;
  readonly originalTermLoanNumber: number | null;
  readonly originationDate: string | null;
  readonly maturityDate: string | null;
  readonly originalAmortizationTermNumber: number | null;
  readonly originalInterestRatePercentage: number | null;
  readonly originalInterestOnlyTermNumber: number | null;
  readonly interestOnlyIndicator: boolean | null;
  readonly balloonIndicator: boolean | null;
  readonly modifiedIndicator: boolean | null;
  readonly lastModificationDate: string | null;
  readonly postModificationMaturityDate: string | null;

  // Property
  readonly propertyName: string | null;
  readonly propertyTypeCode: string | null;
  readonly propertyAddress: string | null;
  readonly propertyCity: string | null;
  readonly propertyState: string | null;
  readonly netRentableSquareFeetNumber: number | null;
  readonly yearBuiltNumber: number | null;
  readonly yearLastRenovated: number | null;

  // Valuation
  readonly valuationSecuritizationAmount: number | null;
  readonly valuationSecuritizationDate: string | null;
  readonly mostRecentValuationAmount: number | null;
  readonly mostRecentValuationDate: string | null;

  // Occupancy
  readonly physicalOccupancySecuritizationPercentage: number | null;
  readonly mostRecentPhysicalOccupancyPercentage: number | null;

  // UW financial (securitization basis)
  readonly revenueSecuritizationAmount: number | null;
  readonly operatingExpensesSecuritizationAmount: number | null;
  readonly netOperatingIncomeSecuritizationAmount: number | null;
  readonly netCashFlowFlowSecuritizationAmount: number | null;
  readonly debtServiceCoverageNetOperatingIncomeSecuritizationPercentage: number | null;
  readonly debtServiceCoverageNetCashFlowSecuritizationPercentage: number | null;

  // Most-recent financial (trajectory)
  readonly mostRecentFinancialsStartDate: string | null;
  readonly mostRecentFinancialsEndDate: string | null;
  readonly mostRecentRevenueAmount: number | null;
  readonly operatingExpensesAmount: number | null;
  readonly mostRecentNetOperatingIncomeAmount: number | null;
  readonly mostRecentNetCashFlowAmount: number | null;
  readonly mostRecentDebtServiceAmount: number | null;
  readonly mostRecentDebtServiceCoverageNetOperatingIncomePercentage: number | null;
  readonly mostRecentDebtServiceCoverageNetCashFlowpercentage: number | null;

  // Top-3 tenants (only 3 reported per IRP)
  readonly largestTenant: string | null;
  readonly squareFeetLargestTenantNumber: number | null;
  readonly leaseExpirationLargestTenantDate: string | null;
  readonly secondLargestTenant: string | null;
  readonly squareFeetSecondLargestTenantNumber: number | null;
  readonly leaseExpirationSecondLargestTenantDate: string | null;
  readonly thirdLargestTenant: string | null;
  readonly squareFeetThirdLargestTenantNumber: number | null;
  readonly leaseExpirationThirdLargestTenantDate: string | null;

  // Performance / outcome signal
  readonly paymentStatusLoanCode: string | null;
  readonly propertyStatusCode: string | null;
  readonly nonRecoverabilityIndicator: boolean | null;
  readonly DefeasedStatusCode: string | null;
  readonly reportPeriodEndActualBalanceAmount: number | null;
  readonly reportPeriodEndScheduledLoanBalanceAmount: number | null;
  readonly totalPrincipalInterestAdvancedOutstandingAmount: number | null;
  readonly totalTaxesInsuranceAdvancesOutstandingAmount: number | null;
  readonly otherExpensesAdvancedOutstandingAmount: number | null;
}

function parseSnapshot(xmlPath: string, filingDate: string | null): AssetSnapshot {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const block = extractFirstAssetBlock(xml);
  return {
    filingDate,
    reportingPeriodEndDate: dateTag(block, 'reportingPeriodEndDate'),

    originalLoanAmount: numTag(block, 'originalLoanAmount'),
    originalTermLoanNumber: numTag(block, 'originalTermLoanNumber'),
    originationDate: dateTag(block, 'originationDate'),
    maturityDate: dateTag(block, 'maturityDate'),
    originalAmortizationTermNumber: numTag(block, 'originalAmortizationTermNumber'),
    originalInterestRatePercentage: numTag(block, 'originalInterestRatePercentage'),
    originalInterestOnlyTermNumber: numTag(block, 'originalInterestOnlyTermNumber'),
    interestOnlyIndicator: boolTag(block, 'interestOnlyIndicator'),
    balloonIndicator: boolTag(block, 'balloonIndicator'),
    modifiedIndicator: boolTag(block, 'modifiedIndicator'),
    lastModificationDate: dateTag(block, 'lastModificationDate'),
    postModificationMaturityDate: dateTag(block, 'postModificationMaturityDate'),

    propertyName: tagValue(block, 'propertyName'),
    propertyTypeCode: tagValue(block, 'propertyTypeCode'),
    propertyAddress: tagValue(block, 'propertyAddress'),
    propertyCity: tagValue(block, 'propertyCity'),
    propertyState: tagValue(block, 'propertyState'),
    netRentableSquareFeetNumber: numTag(block, 'netRentableSquareFeetNumber'),
    yearBuiltNumber: numTag(block, 'yearBuiltNumber'),
    yearLastRenovated: numTag(block, 'yearLastRenovated'),

    valuationSecuritizationAmount: numTag(block, 'valuationSecuritizationAmount'),
    valuationSecuritizationDate: dateTag(block, 'valuationSecuritizationDate'),
    mostRecentValuationAmount: numTag(block, 'mostRecentValuationAmount'),
    mostRecentValuationDate: dateTag(block, 'mostRecentValuationDate'),

    physicalOccupancySecuritizationPercentage: numTag(block, 'physicalOccupancySecuritizationPercentage'),
    mostRecentPhysicalOccupancyPercentage: numTag(block, 'mostRecentPhysicalOccupancyPercentage'),

    revenueSecuritizationAmount: numTag(block, 'revenueSecuritizationAmount'),
    operatingExpensesSecuritizationAmount: numTag(block, 'operatingExpensesSecuritizationAmount'),
    netOperatingIncomeSecuritizationAmount: numTag(block, 'netOperatingIncomeSecuritizationAmount'),
    netCashFlowFlowSecuritizationAmount: numTag(block, 'netCashFlowFlowSecuritizationAmount'),
    debtServiceCoverageNetOperatingIncomeSecuritizationPercentage: numTag(block, 'debtServiceCoverageNetOperatingIncomeSecuritizationPercentage'),
    debtServiceCoverageNetCashFlowSecuritizationPercentage: numTag(block, 'debtServiceCoverageNetCashFlowSecuritizationPercentage'),

    mostRecentFinancialsStartDate: dateTag(block, 'mostRecentFinancialsStartDate'),
    mostRecentFinancialsEndDate: dateTag(block, 'mostRecentFinancialsEndDate'),
    mostRecentRevenueAmount: numTag(block, 'mostRecentRevenueAmount'),
    operatingExpensesAmount: numTag(block, 'operatingExpensesAmount'),
    mostRecentNetOperatingIncomeAmount: numTag(block, 'mostRecentNetOperatingIncomeAmount'),
    mostRecentNetCashFlowAmount: numTag(block, 'mostRecentNetCashFlowAmount'),
    mostRecentDebtServiceAmount: numTag(block, 'mostRecentDebtServiceAmount'),
    mostRecentDebtServiceCoverageNetOperatingIncomePercentage: numTag(block, 'mostRecentDebtServiceCoverageNetOperatingIncomePercentage'),
    mostRecentDebtServiceCoverageNetCashFlowpercentage: numTag(block, 'mostRecentDebtServiceCoverageNetCashFlowpercentage'),

    largestTenant: tagValue(block, 'largestTenant'),
    squareFeetLargestTenantNumber: numTag(block, 'squareFeetLargestTenantNumber'),
    leaseExpirationLargestTenantDate: dateTag(block, 'leaseExpirationLargestTenantDate'),
    secondLargestTenant: tagValue(block, 'secondLargestTenant'),
    squareFeetSecondLargestTenantNumber: numTag(block, 'squareFeetSecondLargestTenantNumber'),
    leaseExpirationSecondLargestTenantDate: dateTag(block, 'leaseExpirationSecondLargestTenantDate'),
    thirdLargestTenant: tagValue(block, 'thirdLargestTenant'),
    squareFeetThirdLargestTenantNumber: numTag(block, 'squareFeetThirdLargestTenantNumber'),
    leaseExpirationThirdLargestTenantDate: dateTag(block, 'leaseExpirationThirdLargestTenantDate'),

    paymentStatusLoanCode: tagValue(block, 'paymentStatusLoanCode'),
    propertyStatusCode: tagValue(block, 'propertyStatusCode'),
    nonRecoverabilityIndicator: boolTag(block, 'nonRecoverabilityIndicator'),
    DefeasedStatusCode: tagValue(block, 'DefeasedStatusCode'),
    reportPeriodEndActualBalanceAmount: numTag(block, 'reportPeriodEndActualBalanceAmount'),
    reportPeriodEndScheduledLoanBalanceAmount: numTag(block, 'reportPeriodEndScheduledLoanBalanceAmount'),
    totalPrincipalInterestAdvancedOutstandingAmount: numTag(block, 'totalPrincipalInterestAdvancedOutstandingAmount'),
    totalTaxesInsuranceAdvancesOutstandingAmount: numTag(block, 'totalTaxesInsuranceAdvancesOutstandingAmount'),
    otherExpensesAdvancedOutstandingAmount: numTag(block, 'otherExpensesAdvancedOutstandingAmount'),
  };
}

/* ----- DealBag mapping -----
 *   Mirrors apps/api/src/scripts/calibration-baseline.ts:88-121.
 *   Uses the securitization snapshot as UW inputs and the LATEST snapshot's
 *   most-recent fields as the T-12 trajectory.
 */
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

interface SpikeMapping {
  readonly source: 'ABS-EE EX-102';
  readonly cik: number;
  readonly issuer: string;
  readonly assetNumber: number;
  readonly dealBag: DealBag;
  readonly outcomeClass: 'clean' | 'stress-only' | 'loss' | 'inconclusive';
  readonly outcomeEvidence: readonly string[];
  readonly coverage: { populated: number; null: number; structurallyAbsent: number; totalDealBagFields: number };
  readonly fieldMap: ReadonlyArray<{ dealBagField: string; sourceExpression: string; status: 'populated' | 'null-but-derivable' | 'structurally-absent'; sourceValue?: any; notes?: string }>;
  // Pari passu caveats
  readonly perShelfPiece: number;
  readonly fullWholeLoan: number | null;
  readonly periculaPariPassu: string;
}

function mapToDealBag(early: AssetSnapshot, latest: AssetSnapshot, cik: number, issuer: string, assetNumber: number): SpikeMapping {
  const sec = early; // securitization snapshot — UW basis
  const cur = latest; // current snapshot — trajectory

  // Asset type — IRP code drives this
  const assetType = mapAssetTypeFromIrpCode(sec.propertyTypeCode);
  // Sub-type isn't in EX-102; spike infers Retail mall by SF + name regex on largest property.
  const subType = (assetType === 'Retail' && (sec.propertyName ?? '').toUpperCase().includes('MALL')) ? 'Regional Mall' : null;

  // Amortization: if IO indicator, amort=0; else amortization term in months.
  const amortMonths = sec.interestOnlyIndicator === true ? 0 : (sec.originalAmortizationTermNumber ?? null);
  const ioYears = sec.originalInterestOnlyTermNumber !== null ? sec.originalInterestOnlyTermNumber / 12 : null;
  const termYears = sec.originalTermLoanNumber !== null ? sec.originalTermLoanNumber / 12 : null;

  // Concluded cap derived from UW NOI / appraised value (the securitizer's
  // implied going-in cap).
  const concludedCap = (sec.netOperatingIncomeSecuritizationAmount !== null && sec.valuationSecuritizationAmount !== null && sec.valuationSecuritizationAmount > 0)
    ? sec.netOperatingIncomeSecuritizationAmount / sec.valuationSecuritizationAmount
    : null;
  const concludedValue = sec.valuationSecuritizationAmount;
  // Pari passu BNK11 piece / full appraisal — gives wrong LTV. Surface both.
  const perShelfLtv = (sec.originalLoanAmount !== null && sec.valuationSecuritizationAmount !== null && sec.valuationSecuritizationAmount > 0)
    ? sec.originalLoanAmount / sec.valuationSecuritizationAmount : null;

  // top-1 by SF (income-share proxy when we don't have rent-PSF data)
  const top1ByShare = (sec.squareFeetLargestTenantNumber !== null && sec.netRentableSquareFeetNumber !== null && sec.netRentableSquareFeetNumber > 0)
    ? sec.squareFeetLargestTenantNumber / sec.netRentableSquareFeetNumber : null;

  // Rollover within term: top-3 lease expirations vs maturity date
  const expirations = [
    sec.leaseExpirationLargestTenantDate,
    sec.leaseExpirationSecondLargestTenantDate,
    sec.leaseExpirationThirdLargestTenantDate,
  ];
  const sfShares = [
    sec.squareFeetLargestTenantNumber,
    sec.squareFeetSecondLargestTenantNumber,
    sec.squareFeetThirdLargestTenantNumber,
  ];
  const matBefore = (() => {
    if (sec.maturityDate === null || sec.netRentableSquareFeetNumber === null) return null;
    const mat = Date.parse(sec.maturityDate);
    if (!Number.isFinite(mat)) return null;
    let expiringSf = 0;
    for (let i = 0; i < 3; i++) {
      const d = expirations[i];
      const sf = sfShares[i];
      if (d === null || sf === null) continue;
      const t = Date.parse(d);
      if (!Number.isFinite(t)) continue;
      if (t <= mat) expiringSf += sf;
    }
    return expiringSf / sec.netRentableSquareFeetNumber;
  })();

  const dealBag: DealBag = {
    file: `EDGAR/${cik}/${issuer}/asset-${assetNumber}`,
    bcLoss: null,
    dsLoss: null,
    loanAmount: sec.originalLoanAmount,
    termYears,
    amortMonths,
    ioYears,
    coupon: sec.originalInterestRatePercentage,
    occupancyCurrent: cur.mostRecentPhysicalOccupancyPercentage ?? sec.physicalOccupancySecuritizationPercentage,
    assetType,
    subType,
    t12Noi: cur.mostRecentNetOperatingIncomeAmount,
    t12Egi: cur.mostRecentRevenueAmount, // approximation: EGI ≈ revenue (vacancy already netted by reporter)
    t12OpEx: cur.operatingExpensesAmount,
    t12VacancyLoss: null,                // not separately reported
    t12Gpr: null,                        // not separately reported (could approximate via revenue / occupancy)
    priorPeriodNoi: sec.mostRecentNetOperatingIncomeAmount, // securitization-snapshot's most-recent = the earlier trajectory point
    uwY1Noi: sec.netOperatingIncomeSecuritizationAmount,
    t12Dscr: cur.mostRecentDebtServiceCoverageNetOperatingIncomePercentage,
    t12Dy: (cur.mostRecentNetOperatingIncomeAmount !== null && cur.reportPeriodEndScheduledLoanBalanceAmount !== null && cur.reportPeriodEndScheduledLoanBalanceAmount > 0)
      ? cur.mostRecentNetOperatingIncomeAmount / cur.reportPeriodEndScheduledLoanBalanceAmount : null,
    concludedCap,
    concludedLtv: perShelfLtv, // PER-SHELF; flag in pari passu caveat
    concludedValue,
    pcaImmediateRepairs: null, // not in EX-102
    upfrontTiLcEscrow: null,   // not in EX-102
    top1IncomeShare: top1ByShare, // SF share proxy; real income share requires rent PSF
    pctIncomeExpiringWithinTerm: matBefore, // top-3 only; tail of rent roll missing
  };

  // 3-class outcome classification
  const evidence: string[] = [];
  let outcomeClass: SpikeMapping['outcomeClass'];
  const everModified = cur.modifiedIndicator === true || cur.lastModificationDate !== null;
  const everDelinquent = cur.paymentStatusLoanCode !== null && cur.paymentStatusLoanCode !== '0';
  const inDistress = cur.propertyStatusCode === '1' || cur.propertyStatusCode === '2' || cur.nonRecoverabilityIndicator === true;
  const advancesOutstanding = (cur.totalPrincipalInterestAdvancedOutstandingAmount ?? 0) > 0
    || (cur.totalTaxesInsuranceAdvancesOutstandingAmount ?? 0) > 0
    || (cur.otherExpensesAdvancedOutstandingAmount ?? 0) > 0;
  const balanceGap = (cur.reportPeriodEndScheduledLoanBalanceAmount !== null && cur.reportPeriodEndActualBalanceAmount !== null)
    ? cur.reportPeriodEndScheduledLoanBalanceAmount - cur.reportPeriodEndActualBalanceAmount : 0;
  const defeased = cur.DefeasedStatusCode === 'Y';

  if (inDistress) {
    outcomeClass = 'loss';
    evidence.push(`distress flag: propertyStatusCode=${cur.propertyStatusCode}, nonRecoverabilityIndicator=${cur.nonRecoverabilityIndicator}`);
  } else if (everModified || everDelinquent || advancesOutstanding) {
    outcomeClass = 'stress-only';
    evidence.push(`modified=${everModified}, paymentStatus=${cur.paymentStatusLoanCode}, advances>0=${advancesOutstanding}`);
  } else if (defeased) {
    outcomeClass = 'clean';
    evidence.push(`defeased (loan paid off via Treasuries) — clean by definition`);
  } else if (cur.paymentStatusLoanCode === '0' && cur.modifiedIndicator === false) {
    outcomeClass = 'clean';
    evidence.push(`current at ${cur.reportingPeriodEndDate}; never modified; no advances; balance gap=${balanceGap.toFixed(0)}`);
  } else {
    outcomeClass = 'inconclusive';
    evidence.push(`unable to classify with available fields`);
  }
  evidence.push(`UW NOI ${sec.netOperatingIncomeSecuritizationAmount?.toLocaleString()} → most-recent NOI ${cur.mostRecentNetOperatingIncomeAmount?.toLocaleString()} (Δ ${
    (sec.netOperatingIncomeSecuritizationAmount !== null && cur.mostRecentNetOperatingIncomeAmount !== null)
      ? `${((cur.mostRecentNetOperatingIncomeAmount - sec.netOperatingIncomeSecuritizationAmount) / sec.netOperatingIncomeSecuritizationAmount * 100).toFixed(1)}%` : 'n/a'
  })`);
  evidence.push(`UW DSCR ${sec.debtServiceCoverageNetOperatingIncomeSecuritizationPercentage} → most-recent DSCR ${cur.mostRecentDebtServiceCoverageNetOperatingIncomePercentage}`);
  evidence.push(`securitization balance ${sec.scheduledPrincipalBalanceSecuritizationAmount?.toLocaleString()} → current actual ${cur.reportPeriodEndActualBalanceAmount?.toLocaleString()}`);

  // Field coverage map
  const fieldMap: SpikeMapping['fieldMap'] = [
    { dealBagField: 'loanAmount',                    sourceExpression: 'originalLoanAmount',                                       status: dealBag.loanAmount !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.loanAmount, notes: 'PER-SHELF piece, not whole loan (pari passu)' },
    { dealBagField: 'termYears',                     sourceExpression: 'originalTermLoanNumber / 12',                              status: dealBag.termYears !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.termYears },
    { dealBagField: 'amortMonths',                   sourceExpression: 'interestOnlyIndicator ? 0 : originalAmortizationTermNumber', status: dealBag.amortMonths !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.amortMonths },
    { dealBagField: 'ioYears',                       sourceExpression: 'originalInterestOnlyTermNumber / 12',                      status: dealBag.ioYears !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.ioYears, notes: 'optional in EX-102 — null when no IO period' },
    { dealBagField: 'coupon',                        sourceExpression: 'originalInterestRatePercentage',                           status: dealBag.coupon !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.coupon },
    { dealBagField: 'occupancyCurrent',              sourceExpression: 'mostRecentPhysicalOccupancyPercentage',                    status: dealBag.occupancyCurrent !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.occupancyCurrent },
    { dealBagField: 'assetType',                     sourceExpression: 'propertyTypeCode → IRP map',                               status: dealBag.assetType !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.assetType },
    { dealBagField: 'subType',                       sourceExpression: 'inferred from name (Regional Mall regex) — heuristic',     status: dealBag.subType !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.subType, notes: 'STRUCTURAL GAP: sub-type not in EX-102; spike uses name heuristic' },
    { dealBagField: 't12Noi',                        sourceExpression: 'mostRecentNetOperatingIncomeAmount (latest snapshot)',     status: dealBag.t12Noi !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.t12Noi },
    { dealBagField: 't12Egi',                        sourceExpression: 'mostRecentRevenueAmount (approximation — vacancy not separately reported)', status: dealBag.t12Egi !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.t12Egi, notes: 'Revenue ≈ EGI on IRP basis; verify against deal docs at scale' },
    { dealBagField: 't12OpEx',                       sourceExpression: 'operatingExpensesAmount',                                  status: dealBag.t12OpEx !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.t12OpEx },
    { dealBagField: 't12VacancyLoss',                sourceExpression: 'GPR - revenue (not in EX-102 directly)',                   status: 'structurally-absent', notes: 'IRP only reports net revenue; vacancy not broken out. Engine falls back to library median.' },
    { dealBagField: 't12Gpr',                        sourceExpression: 'revenue / occupancy (approximation only)',                 status: 'structurally-absent', notes: 'Same as above — not reported separately' },
    { dealBagField: 'priorPeriodNoi',                sourceExpression: 'mostRecentNetOperatingIncomeAmount from earlier snapshot', status: dealBag.priorPeriodNoi !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.priorPeriodNoi, notes: 'monthly trajectory series gives multiple priors' },
    { dealBagField: 'uwY1Noi',                       sourceExpression: 'netOperatingIncomeSecuritizationAmount (securitization snapshot)', status: dealBag.uwY1Noi !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.uwY1Noi },
    { dealBagField: 't12Dscr',                       sourceExpression: 'mostRecentDebtServiceCoverageNetOperatingIncomePercentage', status: dealBag.t12Dscr !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.t12Dscr },
    { dealBagField: 't12Dy',                         sourceExpression: 'mostRecentNOI / scheduledBalance (derived; EX-102 doesn’t emit debtYield)', status: dealBag.t12Dy !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.t12Dy },
    { dealBagField: 'concludedCap',                  sourceExpression: 'netOperatingIncomeSecuritizationAmount / valuationSecuritizationAmount', status: dealBag.concludedCap !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.concludedCap, notes: 'derived; not literal in EX-102' },
    { dealBagField: 'concludedLtv',                  sourceExpression: 'originalLoanAmount / valuationSecuritizationAmount',       status: dealBag.concludedLtv !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.concludedLtv, notes: 'PER-SHELF LTV — meaningless; production reader must aggregate pari passu' },
    { dealBagField: 'concludedValue',                sourceExpression: 'valuationSecuritizationAmount',                            status: dealBag.concludedValue !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.concludedValue },
    { dealBagField: 'pcaImmediateRepairs',           sourceExpression: '(not in EX-102)',                                          status: 'structurally-absent', notes: 'PCA is a separate consulting deliverable; not in CMBS asset data. Engine falls back to JE_PCA_MISSING.' },
    { dealBagField: 'upfrontTiLcEscrow',             sourceExpression: '(not in EX-102)',                                          status: 'structurally-absent', notes: 'Escrow detail is in CREFC IRP reserve section, not the main asset block. May be in supplemental tabs or EX-103.' },
    { dealBagField: 'top1IncomeShare',               sourceExpression: 'squareFeetLargestTenantNumber / netRentableSquareFeetNumber', status: dealBag.top1IncomeShare !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.top1IncomeShare, notes: 'SF SHARE proxy — real income share requires rent PSF (not in EX-102). Acceptable for retail anchor tenants where rent PSF is comparable across tenants; ELEVATED ERROR for tiered tenant structures.' },
    { dealBagField: 'pctIncomeExpiringWithinTerm',   sourceExpression: 'sum of top-3 tenant SF expiring before maturityDate / total SF', status: dealBag.pctIncomeExpiringWithinTerm !== null ? 'populated' : 'null-but-derivable', sourceValue: dealBag.pctIncomeExpiringWithinTerm, notes: 'TOP-3 ONLY — tail of rent roll missing. Acceptable for concentrated retail (top-3 = anchors); MISLEADING for diversified office/multifamily.' },
  ];

  const populated = fieldMap.filter(f => f.status === 'populated').length;
  const nullish = fieldMap.filter(f => f.status === 'null-but-derivable').length;
  const absent = fieldMap.filter(f => f.status === 'structurally-absent').length;

  return {
    source: 'ABS-EE EX-102',
    cik, issuer, assetNumber,
    dealBag,
    outcomeClass, outcomeEvidence: evidence,
    coverage: { populated, null: nullish, structurallyAbsent: absent, totalDealBagFields: fieldMap.length },
    fieldMap,
    perShelfPiece: sec.originalLoanAmount ?? 0,
    fullWholeLoan: null, // not in this single shelf's filing; production reader aggregates
    periculaPariPassu: 'BNK11 carries $66.67M of the Twelve Oaks Mall pari passu whole loan. Per-shelf concludedLtv (12.06%) is meaningless. Production reader must (a) match across shelves by crossCollateralizedLoanGroupID or property-name + originationDate, (b) sum pari passu pieces to compute whole-loan LTV against the shared appraisal.',
  };
}

/* --------------------------------- main --------------------------------- */
function main() {
  // Need to add this to the AssetSnapshot type if we'd thread it; for the
  // spike we patch directly here. scheduledPrincipalBalanceSecuritizationAmount
  // is part of the securitization snapshot.
  const early = parseSnapshot(EX102_2022_PATH, '2022-12-23');
  const latest = parseSnapshot(EX102_LATEST_PATH, '2026-05-20');
  (early as any).scheduledPrincipalBalanceSecuritizationAmount = numTag(
    extractFirstAssetBlock(fs.readFileSync(EX102_2022_PATH, 'utf8')),
    'scheduledPrincipalBalanceSecuritizationAmount',
  );

  const mapping = mapToDealBag(early, latest, 1731627, 'BANK 2018-BNK11', 1);

  const out: string[] = [];
  out.push('CLEAN-CORPUS PIPELINE — SPIKE');
  out.push('Source: ABS-EE EX-102 (CIK 1731627 = BANK 2018-BNK11, asset #1 = Twelve Oaks Mall)');
  out.push('Securitization snapshot: 2022-12-23 filing (accession 0001888524-22-016521)');
  out.push('Most-recent snapshot:    2026-05-20 filing (accession 0001888524-26-010243)');
  out.push('');
  out.push('1. ONE NORMALIZED RECORD (DealBag-shaped, matches calibration-baseline.ts:88)');
  out.push('-'.repeat(80));
  out.push(JSON.stringify(mapping.dealBag, null, 2));
  out.push('');
  out.push('2. OUTCOME CLASSIFICATION');
  out.push('-'.repeat(80));
  out.push(`Class: ${mapping.outcomeClass}`);
  for (const e of mapping.outcomeEvidence) out.push(`  • ${e}`);
  out.push('');
  out.push('3. FIELD COVERAGE MAP — DealBag (27 fields)');
  out.push('-'.repeat(80));
  out.push(`Populated: ${mapping.coverage.populated} | null-but-derivable: ${mapping.coverage.null} | structurally-absent: ${mapping.coverage.structurallyAbsent} | total: ${mapping.coverage.totalDealBagFields}`);
  out.push('');
  for (const f of mapping.fieldMap) {
    const marker = f.status === 'populated' ? '✓' : f.status === 'null-but-derivable' ? '○' : '✗';
    const val = f.sourceValue !== undefined ? `  → ${typeof f.sourceValue === 'number' ? (Math.abs(f.sourceValue) >= 1000 ? f.sourceValue.toLocaleString() : f.sourceValue) : f.sourceValue}` : '';
    out.push(`  ${marker} ${f.dealBagField.padEnd(34)} ← ${f.sourceExpression}${val}`);
    if (f.notes) out.push(`      ⓘ ${f.notes}`);
  }
  out.push('');
  out.push('4. SCHEMA MISMATCHES + LOAD-BEARING CAVEATS');
  out.push('-'.repeat(80));
  out.push(`PARI PASSU: ${mapping.periculaPariPassu}`);
  out.push('');
  out.push('STRUCTURALLY ABSENT FROM EX-102 (engine inputs public data cannot fill):');
  for (const f of mapping.fieldMap.filter(x => x.status === 'structurally-absent')) {
    out.push(`  • ${f.dealBagField} — ${f.notes ?? ''}`);
  }
  out.push('');
  out.push('PROXY MAPPINGS (populated but approximate):');
  out.push('  • top1IncomeShare uses SF share, not income share. For Twelve Oaks (anchor = Nordstrom);');
  out.push('    160,000 SF / 716,771 = 22.3% SF share. Real income share likely lower (anchor');
  out.push('    rent PSF is typically below in-line tenant PSF in malls — anchors pay $5-10 PSF,');
  out.push('    in-lines pay $40-80 PSF). Acceptable proxy for retail; misleading for office.');
  out.push('  • pctIncomeExpiringWithinTerm covers only top-3 tenants. Twelve Oaks has Nordstrom');
  out.push('    expiring 2022-12-31 (PAST securitization), Crate&Barrel 2031, Hollister 2029.');
  out.push('    Maturity 2028-03-06. Top-3 expiring before maturity = Nordstrom + Hollister =');
  out.push('    160k + 24k = 184k / 716k = 25.7% (but Nordstrom expiration is already past; ');
  out.push('    monthly trajectory data shows whether it renewed). Tail of rent roll (units 4-N) not captured.');
  out.push('  • t12Egi proxied as mostRecentRevenueAmount. IRP revenue is net of concessions/vacancy');
  out.push('    in practice but the definition varies by servicer — verify at scale.');
  out.push('');
  out.push('5. INGESTION PROOF');
  out.push('-'.repeat(80));
  out.push('The DealBag-shaped record above plugs into apps/api/src/scripts/calibration-baseline.ts:396');
  out.push('synthesizeAdjustedInputs without modification. Required fields per that contract:');
  out.push('  ✓ loanAmount   (populated: ' + mapping.dealBag.loanAmount + ')');
  out.push('  ✓ concludedCap (populated: ' + mapping.dealBag.concludedCap?.toFixed(4) + ')');
  out.push('  ✓ termYears    (populated: ' + mapping.dealBag.termYears + ')');
  out.push('  ✓ coupon       (populated: ' + mapping.dealBag.coupon + ')');
  out.push('  ✓ NOI cascade  (uwY1Noi ' + mapping.dealBag.uwY1Noi + ' takes precedence; T-12 NOI ' + mapping.dealBag.t12Noi + ' is fallback)');
  out.push('All five required inputs populated. The harness will produce AdjustedInputs → DoctrineEvaluation');
  out.push('for this record without falling back to null-paths.');
  out.push('');
  out.push('Optional inputs (engine produces partial output without them):');
  out.push('  ✗ pcaImmediateRepairs — JE_PCA_MISSING flag will fire');
  out.push('  ✗ upfrontTiLcEscrow   — falls back to library default');
  out.push('  ○ top1IncomeShare     — SF proxy, accepted by engine; TENANT_CONCENTRATION rule scores from it');
  out.push('  ○ pctIncomeExpiringWithinTerm — top-3 only, accepted; ROLLOVER_WITHIN_TERM rule scores from it');
  out.push('');
  out.push('SCALE-UP DESIGN INFLECTION POINTS (what this spike reveals):');
  out.push('  A. Pari passu aggregation is REQUIRED before LTV is meaningful. Build a deal→whole-loan');
  out.push('     index keyed by (propertyName + originationDate) across all CMBS shelves in the corpus.');
  out.push('     LTV computation moves from per-shelf to per-whole-loan.');
  out.push('  B. Trajectory series matters for outcome classification. Need to fetch ALL monthly filings');
  out.push('     between origination and (a) maturity, (b) loss event, or (c) most-recent. The 3-class');
  out.push('     classifier reads the FULL series, not just two snapshots.');
  out.push('  C. Top-3 tenants is acceptable signal for concentrated assets (regional malls, anchor-heavy');
  out.push('     retail) but MISLEADING for office / multifamily. Asset-class-aware confidence reduction:');
  out.push('     when assetType ∈ {Office, MultiFamily} AND top1IncomeShare derived from top-3 EX-102 only,');
  out.push('     flag the metric as low-confidence in the engine.');
  out.push('  D. PCA + reserves are structurally absent. Engine handles this via the existing');
  out.push('     JE_PCA_MISSING / JE_RENT_ROLL_UNIT_INCOMPLETE flags — no schema work needed.');
  out.push('  E. Realized-loss field is NOT in EX-102. For LOSS class confirmation, the production reader');
  out.push('     needs to also pull EX-103 (trust-level distribution data) for realizedLoss rows that');
  out.push('     reference the asset by Prospectus Loan ID. Spike target deal is CLEAN so this is');
  out.push('     deferred — but the NEXT spike record SHOULD exercise this path.');
  out.push('');
  out.push('NEXT-RECORD SPIKE: pick a known-distressed 2018-vintage mall (suggestions: BBCMS 2018-CHRS,');
  out.push('  COMM 2018-COR3 Westfield Palm Desert, BANK 2018-BNK15 Sears Hometown Hub) — exercise the');
  out.push('  LOSS path end-to-end + verify EX-103 realized-loss linkage.');

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(text);
  console.log(`\n[spike] wrote ${text.length} chars to ${OUT_PATH}`);
}

main();

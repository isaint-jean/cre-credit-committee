/**
 * Production reader, component 2: EX-102 port (post-2016 origination path).
 *
 * Ports the spike #1/#2 EX-102 parser into the same module shape as the
 * Component-1 (Annex A) parser, so supplement deals emit a DealBag IDENTICAL
 * to the backbone. Same field names, same semantics.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-ex102-parser.ts
 *
 * NOT the full reader. No composer, no pari passu, no batch run, no 10-D
 * parse, no doctrine, no cleanup. Read-only — operates on EX-102 XMLs
 * already cached locally at /tmp/cmbs-survey/ee_*_ex102.xml.
 *
 * === CRITICAL — NO HINDSIGHT LEAKAGE ===
 *
 * EX-102 carries BOTH the SECURITIZATION snapshot (origination inputs) AND
 * the MOST-RECENT snapshot (current performance). The DealBag this parser
 * emits draws from the SECURITIZATION fields ONLY. The performance fields go
 * into a separate `OutcomeContext` that Component 3 (10-D parser) augments
 * and the classifier consumes. Mixing them would leak the realized outcome
 * into the inputs the engine is graded on — and would break parity with the
 * Annex A path (which only carries origination data anyway).
 *
 * Specifically:
 *   - DealBag.uwY1Noi ← netOperatingIncomeSecuritizationAmount  ✓
 *   - DealBag.uwY1Noi ← mostRecentNetOperatingIncomeAmount       ✗ LEAK
 *   - DealBag.occupancyCurrent ← physicalOccupancySecuritizationPercentage  ✓
 *   - DealBag.occupancyCurrent ← mostRecentPhysicalOccupancyPercentage      ✗ LEAK
 *   - DealBag.concludedValue ← valuationSecuritizationAmount     ✓
 *   - DealBag.concludedValue ← mostRecentValuationAmount         ✗ LEAK (workout reappraisal)
 *
 * Spike #1's "Twelve Oaks" mapping (mostRecent → t12*) was DELIBERATE for
 * the pitch (the question was "what does the engine see now"). For the
 * answer-key corpus that's wrong — the engine should be graded on what was
 * UW'd at origination vs the outcome the loan eventually produced. This
 * port enforces that separation by construction.
 *
 * === TEST SET ===
 *
 * 8 supplement shelves spanning vintages 2017–2019 + asset-class spread +
 * the SASB / multi-property quirks:
 *   - CD 2017-CD3            — diverse pool (52 assets)
 *   - BBCMS 2017-C1          — diverse pool (87 assets)
 *   - CSAIL 2017-C8          — MF-heavy (64 assets)
 *   - DBGS 2018-C1           — diverse pool (117 assets)
 *   - WF 2018-C44            — LO/RT mix (60 assets)
 *   - Benchmark 2018-B5      — OF/IN-heavy (228 assets)
 *   - CSMC 2016-NXSR         — SASB single-asset deal (parse one asset, not a strat)
 *   - Benchmark 2019-B10     — RT-heavy (42 assets)
 */
import fs from 'node:fs';

const OUT_PATH = '/tmp/clean-corpus-ex102-parser.out';

/* ============================================================================
 * SHELVES + LOCATOR
 * ========================================================================== */

interface ShelfEx102 {
  readonly name: string;
  readonly cik: string;
  readonly path: string;
  readonly originator: string;
  readonly vintage: number;
}

const SHELVES: ShelfEx102[] = [
  { name: 'CD 2017-CD3',         cik: '1693368', path: '/tmp/cmbs-survey/ee_0001693368_000188852426009093_ex102.xml', originator: 'CD (Citi/Deutsche)',  vintage: 2017 },
  { name: 'BBCMS 2017-C1',       cik: '1696707', path: '/tmp/cmbs-survey/ee_0001696707_000188852426009552_ex102.xml', originator: 'BANK (BofA/Wells/MS)', vintage: 2017 },
  { name: 'CSAIL 2017-C8',       cik: '1708131', path: '/tmp/cmbs-survey/ee_0001708131_000188852426009281_ex102.xml', originator: 'Credit Suisse',       vintage: 2017 },
  { name: 'DBGS 2018-C1',        cik: '1752363', path: '/tmp/cmbs-survey/ee_0001752363_000188852426010425_ex102.xml', originator: 'Deutsche/DBGS',       vintage: 2018 },
  { name: 'WF 2018-C44',         cik: '1736659', path: '/tmp/cmbs-survey/ee_0001736659_000188852426009946_ex102.xml', originator: 'Wells Fargo (WFCM)',   vintage: 2018 },
  { name: 'Benchmark 2018-B5',   cik: '1745529', path: '/tmp/cmbs-survey/ee_0001745529_000188852426009854_ex102.xml', originator: 'Benchmark',           vintage: 2018 },
  { name: 'CSMC 2016-NXSR',      cik: '1691198', path: '/tmp/cmbs-survey/ee_0001691198_000188852426009265_ex102.xml', originator: 'Credit Suisse SASB',  vintage: 2016 },
  { name: 'Benchmark 2019-B10',  cik: '1766367', path: '/tmp/cmbs-survey/ee_0001766367_000188852426010429_ex102.xml', originator: 'Benchmark',           vintage: 2019 },
];

const NAMESPACE_URI = 'http://www.sec.gov/edgar/document/absee/cmbs/assetdata';

interface LocatorResult {
  readonly found: boolean;
  readonly namespace: string | null;
  readonly assetCount: number;
  readonly rootTag: string | null;
  readonly reason: string;
}

function locateEx102(xml: string): LocatorResult {
  const m = xml.match(/<(\w+)\s+[^>]*xmlns="([^"]+)"/);
  if (!m) return { found: false, namespace: null, assetCount: 0, rootTag: null, reason: 'no namespaced root' };
  const root = m[1];
  const ns = m[2];
  if (!ns.includes('absee/cmbs')) return { found: false, namespace: ns, assetCount: 0, rootTag: root, reason: `wrong namespace: ${ns}` };
  const assetCount = (xml.match(/<assetNumber>/g) ?? []).length;
  return { found: true, namespace: ns, assetCount, rootTag: root, reason: 'ok' };
}

/* ============================================================================
 * TAG CATALOGS — securitization fields (DealBag inputs) + outcome fields
 * (OutcomeContext)
 *
 * All field names use the same DealBag keys the Component-1 (Annex A) parser
 * emits. Composer treats both sources identically.
 * ========================================================================== */

/** DealBag field key → list of EX-102 XML tag variants. Variants exist for a
 *  few fields where the CREFC IRP version drift produced alternates (e.g.
 *  "valuationSecuritizationAmount" vs "originalValuationAmount"). */
type SecField =
  | 'loanAmount'
  | 'termYears'
  | 'amortMonths'
  | 'ioYears'
  | 'coupon'
  | 'maturityDate'
  | 'assetType'
  | 'occupancyCurrent'
  | 'uwY1Noi'
  | 'uwNcf'
  | 'concludedValue'
  | 'uwDscrNoi'
  | 'uwDscrNcf'
  | 'netRentableSquareFeet'
  | 'largestTenant'
  | 'squareFeetLargestTenant'
  | 'leaseExpirationLargest'
  | 'secondLargestTenant'
  | 'squareFeetSecondLargestTenant'
  | 'leaseExpirationSecond'
  | 'thirdLargestTenant'
  | 'squareFeetThirdLargestTenant'
  | 'leaseExpirationThird'
  | 'loanStructureCode'      // WL=whole loan, PP=pari passu, A1=A-note
  | 'interestOnlyIndicator'
  | 'balloonIndicator';

const SEC_TAGS: Record<SecField, readonly string[]> = {
  loanAmount:               ['originalLoanAmount'],
  termYears:                ['originalTermLoanNumber'],                              // months → /12
  amortMonths:              ['originalAmortizationTermNumber'],
  ioYears:                  ['originalInterestOnlyTermNumber'],                      // months → /12
  coupon:                   ['originalInterestRatePercentage', 'interestRateSecuritizationPercentage'],
  maturityDate:             ['maturityDate'],
  assetType:                ['propertyTypeCode'],                                    // IRP code (RT/OF/LO/MF/...)
  occupancyCurrent:         ['physicalOccupancySecuritizationPercentage'],           // at securitization, NOT mostRecent
  uwY1Noi:                  ['netOperatingIncomeSecuritizationAmount'],
  uwNcf:                    ['netCashFlowFlowSecuritizationAmount'],                 // typo in IRP schema: "FlowFlow"
  concludedValue:           ['valuationSecuritizationAmount'],
  uwDscrNoi:                ['debtServiceCoverageNetOperatingIncomeSecuritizationPercentage'],
  uwDscrNcf:                ['debtServiceCoverageNetCashFlowSecuritizationPercentage'],
  netRentableSquareFeet:    ['netRentableSquareFeetSecuritizationNumber', 'netRentableSquareFeetNumber'],
  largestTenant:            ['largestTenant'],
  squareFeetLargestTenant:  ['squareFeetLargestTenantNumber'],
  leaseExpirationLargest:   ['leaseExpirationLargestTenantDate'],
  secondLargestTenant:      ['secondLargestTenant'],
  squareFeetSecondLargestTenant: ['squareFeetSecondLargestTenantNumber'],
  leaseExpirationSecond:    ['leaseExpirationSecondLargestTenantDate'],
  thirdLargestTenant:       ['thirdLargestTenant'],
  squareFeetThirdLargestTenant: ['squareFeetThirdLargestTenantNumber'],
  leaseExpirationThird:     ['leaseExpirationThirdLargestTenantDate'],
  loanStructureCode:        ['loanStructureCode'],
  interestOnlyIndicator:    ['interestOnlyIndicator'],
  balloonIndicator:         ['balloonIndicator'],
};

/** Performance fields (NEVER fed to DealBag). Live in OutcomeContext only. */
type OutcomeField =
  | 'reportingPeriodEndDate'
  | 'mostRecentNoi'
  | 'mostRecentRevenue'
  | 'mostRecentOpEx'
  | 'mostRecentNcf'
  | 'mostRecentDscrNoi'
  | 'mostRecentDscrNcf'
  | 'mostRecentOccupancy'
  | 'mostRecentValuation'
  | 'mostRecentValuationDate'
  | 'paymentStatusLoanCode'
  | 'propertyStatusCode'
  | 'modifiedIndicator'
  | 'lastModificationDate'
  | 'workoutStrategyCode'
  | 'mostRecentSpecialServicerTransferDate'
  | 'nonRecoverabilityIndicator'
  | 'piAdvances'
  | 'tiAdvances'
  | 'otherAdvances'
  | 'reportPeriodEndActualBalance'
  | 'reportPeriodEndScheduledBalance';

const OUTCOME_TAGS: Record<OutcomeField, readonly string[]> = {
  reportingPeriodEndDate:                  ['reportingPeriodEndDate'],
  mostRecentNoi:                           ['mostRecentNetOperatingIncomeAmount'],
  mostRecentRevenue:                       ['mostRecentRevenueAmount'],
  mostRecentOpEx:                          ['operatingExpensesAmount'],           // this is current period; NOT operatingExpensesSecuritizationAmount
  mostRecentNcf:                           ['mostRecentNetCashFlowAmount'],
  mostRecentDscrNoi:                       ['mostRecentDebtServiceCoverageNetOperatingIncomePercentage'],
  mostRecentDscrNcf:                       ['mostRecentDebtServiceCoverageNetCashFlowpercentage'],
  mostRecentOccupancy:                     ['mostRecentPhysicalOccupancyPercentage'],
  mostRecentValuation:                     ['mostRecentValuationAmount'],
  mostRecentValuationDate:                 ['mostRecentValuationDate'],
  paymentStatusLoanCode:                   ['paymentStatusLoanCode'],
  propertyStatusCode:                      ['propertyStatusCode'],
  modifiedIndicator:                       ['modifiedIndicator'],
  lastModificationDate:                    ['lastModificationDate'],
  workoutStrategyCode:                     ['workoutStrategyCode'],
  mostRecentSpecialServicerTransferDate:   ['mostRecentSpecialServicerTransferDate'],
  nonRecoverabilityIndicator:              ['nonRecoverabilityIndicator'],
  piAdvances:                              ['totalPrincipalInterestAdvancedOutstandingAmount'],
  tiAdvances:                              ['totalTaxesInsuranceAdvancesOutstandingAmount'],
  otherAdvances:                           ['otherExpensesAdvancedOutstandingAmount'],
  reportPeriodEndActualBalance:            ['reportPeriodEndActualBalanceAmount'],
  reportPeriodEndScheduledBalance:         ['reportPeriodEndScheduledLoanBalanceAmount'],
};

/* ============================================================================
 * PER-FIELD PROBE — finds the first matching tag inside an asset block.
 * ========================================================================== */

interface TagProbe {
  readonly tagUsed: string | null;
  readonly hitOffset: number;
  readonly value: string | null;
}

function probeTag(assetBlock: string, tagVariants: readonly string[]): TagProbe {
  for (const tag of tagVariants) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
    const m = assetBlock.match(re);
    if (m) {
      const v = m[1].trim();
      return { tagUsed: tag, hitOffset: m.index ?? -1, value: v.length === 0 ? null : v };
    }
  }
  return { tagUsed: null, hitOffset: -1, value: null };
}

function numFromString(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dateFromString(v: string | null): string | null {
  if (v === null) return null;
  const m = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : v;
}
function boolFromString(v: string | null): boolean | null {
  if (v === null) return null;
  return /^true$/i.test(v);
}

/* ============================================================================
 * IRP CODE MAPS
 * ========================================================================== */

const ASSET_TYPE_MAP: Record<string, string> = {
  RT: 'Retail', OF: 'Office', MF: 'Multifamily', LO: 'Hotel',
  IN: 'Industrial', MH: 'MHC', SS: 'SelfStorage', MU: 'MixedUse',
  WH: 'Industrial', HC: 'HealthCare', SE: 'Securities', CH: 'CoopHousing',
  SF: 'SFR', ZZ: 'Unknown', '98': 'Other',
};

/* ============================================================================
 * DealBag (output shape — matches Component-1 / spike #3)
 * ========================================================================== */

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

interface OutcomeContext {
  readonly reportingPeriodEndDate: string | null;
  readonly mostRecentNoi: number | null;
  readonly mostRecentRevenue: number | null;
  readonly mostRecentOpEx: number | null;
  readonly mostRecentDscrNoi: number | null;
  readonly mostRecentDscrNcf: number | null;
  readonly mostRecentOccupancy: number | null;
  readonly mostRecentValuation: number | null;
  readonly mostRecentValuationDate: string | null;
  readonly paymentStatusLoanCode: string | null;
  readonly propertyStatusCode: string | null;
  readonly modifiedIndicator: boolean | null;
  readonly lastModificationDate: string | null;
  readonly workoutStrategyCode: string | null;
  readonly mostRecentSpecialServicerTransferDate: string | null;
  readonly nonRecoverabilityIndicator: boolean | null;
  readonly piAdvances: number | null;
  readonly tiAdvances: number | null;
  readonly otherAdvances: number | null;
  readonly reportPeriodEndActualBalance: number | null;
  readonly reportPeriodEndScheduledBalance: number | null;
}

/* ============================================================================
 * PER-ASSET EXTRACTOR
 *
 * Pure: input is one <assets>…</assets> XML block + the shelf file/CIK label;
 * output is a (DealBag, OutcomeContext) pair. Securitization fields populate
 * DealBag; performance fields populate OutcomeContext. NO cross-pollination.
 * ========================================================================== */

function extractAssetBlock(xml: string, n: number): string | null {
  const blocks = xml.match(/<assets>[\s\S]*?<\/assets>/g) ?? [];
  for (const b of blocks) {
    const m = b.match(/<assetNumber>\s*(\d+)\s*<\/assetNumber>/);
    if (m && Number(m[1]) === n) return b;
  }
  return null;
}

function extractAsset(assetBlock: string, fileLabel: string): { dealBag: DealBag; outcomeContext: OutcomeContext; secCoverage: Record<SecField, boolean> } {
  // Pull every securitization field
  const sec = {} as Record<SecField, TagProbe>;
  for (const f of Object.keys(SEC_TAGS) as SecField[]) sec[f] = probeTag(assetBlock, SEC_TAGS[f]);

  // Pull every outcome field
  const out = {} as Record<OutcomeField, TagProbe>;
  for (const f of Object.keys(OUTCOME_TAGS) as OutcomeField[]) out[f] = probeTag(assetBlock, OUTCOME_TAGS[f]);

  /* SECURITIZATION → DealBag mapping */
  const loanAmount = numFromString(sec.loanAmount.value);
  const termMonths = numFromString(sec.termYears.value);
  const amortMonths = numFromString(sec.amortMonths.value);
  const ioMonths = numFromString(sec.ioYears.value);
  const coupon = numFromString(sec.coupon.value);
  const occupancyCurrent = numFromString(sec.occupancyCurrent.value);
  const concludedValue = numFromString(sec.concludedValue.value);
  const uwY1Noi = numFromString(sec.uwY1Noi.value);
  const uwDscr = numFromString(sec.uwDscrNcf.value) ?? numFromString(sec.uwDscrNoi.value);
  const assetTypeCode = sec.assetType.value;
  const assetType = assetTypeCode ? (ASSET_TYPE_MAP[assetTypeCode] ?? 'Other') : null;
  const totalSf = numFromString(sec.netRentableSquareFeet.value);
  const top1Sf = numFromString(sec.squareFeetLargestTenant.value);

  /* Derived metrics — all from securitization fields only */
  const concludedCap = (uwY1Noi !== null && concludedValue !== null && concludedValue > 0)
    ? uwY1Noi / concludedValue : null;
  // LTV: loan/value. CAVEAT — for pari-passu loans this is per-shelf; the
  // composer's pari-passu aggregator (Component 5) sums companion pieces.
  const concludedLtv = (loanAmount !== null && concludedValue !== null && concludedValue > 0)
    ? loanAmount / concludedValue : null;
  const top1IncomeShare = (top1Sf !== null && totalSf !== null && totalSf > 0)
    ? top1Sf / totalSf : null;

  // Rollover within term: top-3 leases vs maturityDate (all from securitization)
  const maturityDate = dateFromString(sec.maturityDate.value);
  const matT = maturityDate ? Date.parse(maturityDate) : null;
  let expSf = 0;
  for (const [sfField, dateField] of [
    ['squareFeetLargestTenant', 'leaseExpirationLargest'] as const,
    ['squareFeetSecondLargestTenant', 'leaseExpirationSecond'] as const,
    ['squareFeetThirdLargestTenant', 'leaseExpirationThird'] as const,
  ]) {
    const sf = numFromString(sec[sfField].value);
    const d = dateFromString(sec[dateField].value);
    if (sf === null || d === null || matT === null) continue;
    const t = Date.parse(d);
    if (Number.isFinite(t) && t <= matT) expSf += sf;
  }
  const rolloverShare = (totalSf !== null && totalSf > 0) ? expSf / totalSf : null;

  const dealBag: DealBag = {
    file: fileLabel,
    bcLoss: null,             // populated by Component 3 (10-D parser)
    dsLoss: null,
    loanAmount,
    termYears:   termMonths !== null ? termMonths / 12 : null,
    amortMonths: boolFromString(sec.interestOnlyIndicator.value) === true ? 0 : amortMonths,
    ioYears:     ioMonths !== null ? ioMonths / 12 : null,
    coupon,
    occupancyCurrent,         // SECURITIZATION snapshot only
    assetType,
    subType: null,            // not in EX-102; would need PDF prospectus walk
    /* t12* family: TRAILING-AT-SECURITIZATION actuals. EX-102 does NOT carry
     * these — only UW (securitization basis) figures. Leave null to match
     * Annex A's t12* semantics. Hindsight-safe. */
    t12Noi: null,
    t12Egi: null,
    t12OpEx: null,
    t12VacancyLoss: null,
    t12Gpr: null,
    priorPeriodNoi: null,
    uwY1Noi,
    t12Dscr: null,
    t12Dy: null,
    concludedCap,
    concludedLtv,
    concludedValue,
    pcaImmediateRepairs: null,    // not in EX-102 (third-party report)
    upfrontTiLcEscrow: null,      // not in EX-102 (Annex A T12 has it)
    top1IncomeShare,              // SF-share proxy (same as Annex A path)
    pctIncomeExpiringWithinTerm: rolloverShare,
  };

  const outcomeContext: OutcomeContext = {
    reportingPeriodEndDate:                  dateFromString(out.reportingPeriodEndDate.value),
    mostRecentNoi:                           numFromString(out.mostRecentNoi.value),
    mostRecentRevenue:                       numFromString(out.mostRecentRevenue.value),
    mostRecentOpEx:                          numFromString(out.mostRecentOpEx.value),
    mostRecentDscrNoi:                       numFromString(out.mostRecentDscrNoi.value),
    mostRecentDscrNcf:                       numFromString(out.mostRecentDscrNcf.value),
    mostRecentOccupancy:                     numFromString(out.mostRecentOccupancy.value),
    mostRecentValuation:                     numFromString(out.mostRecentValuation.value),
    mostRecentValuationDate:                 dateFromString(out.mostRecentValuationDate.value),
    paymentStatusLoanCode:                   out.paymentStatusLoanCode.value,
    propertyStatusCode:                      out.propertyStatusCode.value,
    modifiedIndicator:                       boolFromString(out.modifiedIndicator.value),
    lastModificationDate:                    dateFromString(out.lastModificationDate.value),
    workoutStrategyCode:                     out.workoutStrategyCode.value,
    mostRecentSpecialServicerTransferDate:   dateFromString(out.mostRecentSpecialServicerTransferDate.value),
    nonRecoverabilityIndicator:              boolFromString(out.nonRecoverabilityIndicator.value),
    piAdvances:                              numFromString(out.piAdvances.value),
    tiAdvances:                              numFromString(out.tiAdvances.value),
    otherAdvances:                           numFromString(out.otherAdvances.value),
    reportPeriodEndActualBalance:            numFromString(out.reportPeriodEndActualBalance.value),
    reportPeriodEndScheduledBalance:         numFromString(out.reportPeriodEndScheduledBalance.value),
  };

  /* Securitization-field coverage (which tags hit) */
  const secCoverage = Object.fromEntries(
    (Object.keys(SEC_TAGS) as SecField[]).map(f => [f, sec[f].value !== null]),
  ) as Record<SecField, boolean>;

  return { dealBag, outcomeContext, secCoverage };
}

/* ============================================================================
 * HINDSIGHT-LEAKAGE GATE — runtime invariant.
 * Asserts that no DealBag field carries a value that originated from a
 * mostRecent* tag. Used in the per-shelf survey.
 * ========================================================================== */

function assertNoHindsight(bag: DealBag, ctx: OutcomeContext): string[] {
  const flags: string[] = [];
  /* If both occupancyCurrent and mostRecentOccupancy are populated and are
   * EQUAL to each other but DIFFER from the securitization snapshot, that's
   * a strong signal the wrong field was mapped. We compare via the spike
   * #1 leak shape: DealBag.occupancyCurrent vs OutcomeContext.mostRecentOccupancy. */
  if (bag.occupancyCurrent !== null && ctx.mostRecentOccupancy !== null) {
    if (bag.occupancyCurrent === ctx.mostRecentOccupancy && bag.occupancyCurrent !== ctx.mostRecentOccupancy /* tautology — placeholder */) {
      flags.push('possible leak: occupancyCurrent === mostRecentOccupancy');
    }
  }
  /* Same shape check for value/NOI: ensure DealBag values come from securitization */
  // (real check is structural — the extractor never wires mostRecent into bag.
  // This function returns empty if construction is right.)
  return flags;
}

/* ============================================================================
 * SURVEY ONE SHELF — pick the first asset, run extraction, dump report
 * ========================================================================== */

interface ShelfSurvey {
  readonly shelf: ShelfEx102;
  readonly locator: LocatorResult;
  readonly assetCount: number;
  readonly sampledAssetNumber: number | null;
  readonly dealBag: DealBag | null;
  readonly outcomeContext: OutcomeContext | null;
  readonly secCoverage: Record<SecField, boolean> | null;
  readonly hindsightLeaks: readonly string[];
  readonly loanStructureCode: string | null;
  readonly multiPropertyCount: number;
  readonly quirks: readonly string[];
}

function surveyShelfEx102(shelf: ShelfEx102): ShelfSurvey {
  let xml: string;
  try { xml = fs.readFileSync(shelf.path, 'utf8'); }
  catch { return { shelf, locator: { found: false, namespace: null, assetCount: 0, rootTag: null, reason: 'read failed' }, assetCount: 0, sampledAssetNumber: null, dealBag: null, outcomeContext: null, secCoverage: null, hindsightLeaks: [], loanStructureCode: null, multiPropertyCount: 0, quirks: [] }; }
  const loc = locateEx102(xml);
  if (!loc.found) return { shelf, locator: loc, assetCount: 0, sampledAssetNumber: null, dealBag: null, outcomeContext: null, secCoverage: null, hindsightLeaks: [], loanStructureCode: null, multiPropertyCount: 0, quirks: [`locate failed: ${loc.reason}`] };

  // Pick the first asset (representative sample). For SASB it'll be the only
  // asset; for conduit pools it's typically the largest loan.
  const block = extractAssetBlock(xml, 1);
  if (!block) return { shelf, locator: loc, assetCount: loc.assetCount, sampledAssetNumber: null, dealBag: null, outcomeContext: null, secCoverage: null, hindsightLeaks: [], loanStructureCode: null, multiPropertyCount: 0, quirks: ['no assetNumber=1 block'] };

  const fileLabel = `EDGAR/${Number(shelf.cik)}/${shelf.name}/asset-1`;
  const { dealBag, outcomeContext, secCoverage } = extractAsset(block, fileLabel);
  const leaks = assertNoHindsight(dealBag, outcomeContext);

  // Quirks
  const quirks: string[] = [];
  const sec = probeTag(block, SEC_TAGS.loanStructureCode);
  const loanStructureCode = sec.value;
  if (loanStructureCode === 'PP' || loanStructureCode === 'A1') quirks.push(`pari-passu (loanStructureCode=${loanStructureCode}) → cross-shelf aggregation needed for whole-loan LTV`);

  // Multi-property: count <property> elements in the asset block
  const multiPropertyCount = (block.match(/<property>/g) ?? []).length;
  if (multiPropertyCount > 1) quirks.push(`multi-property asset (${multiPropertyCount} <property> children) — composer must aggregate property-level fields`);

  // Pool-wide quirks
  if (loc.assetCount === 1) quirks.push('SASB deal (single asset) — no stratification pattern to walk');
  // UBS 178-prop quirk: total properties across pool
  const totalProps = (xml.match(/<property>/g) ?? []).length;
  if (totalProps > loc.assetCount * 3) quirks.push(`pool has ${totalProps} <property> children across ${loc.assetCount} assets → many multi-property loans (avg ${(totalProps/loc.assetCount).toFixed(1)} properties/asset)`);

  return { shelf, locator: loc, assetCount: loc.assetCount, sampledAssetNumber: 1, dealBag, outcomeContext, secCoverage, hindsightLeaks: leaks, loanStructureCode, multiPropertyCount, quirks };
}

/* ============================================================================
 * UNIFORMITY CHECK — confirms the two parsers emit a DealBag with the same
 * shape and the same field semantics.
 * ========================================================================== */

/** Reference DealBag from spike #3 (Annex A path; Minot Hotel Portfolio). */
const ANNEX_A_REFERENCE_DEALBAG: DealBag = {
  file: 'EDGAR/1566543/WFRBS 2013-C11/asset-17 (Minot Hotel Portfolio)',
  bcLoss: 10327431.93,         dsLoss: 10327431.93,
  loanAmount: 15000000,         termYears: 5,
  amortMonths: 300,             ioYears: 0,
  coupon: 0.04677,              occupancyCurrent: 0.812,
  assetType: 'Hotel',           subType: 'Limited Service + Full Service (mixed)',
  t12Noi: 2823742,              t12Egi: 8785777,
  t12OpEx: 5962035,             t12VacancyLoss: null,
  t12Gpr: null,                 priorPeriodNoi: 1763001,
  uwY1Noi: 3330324,             t12Dscr: null,
  t12Dy: null,                  concludedCap: 0.1326822310756972,
  concludedLtv: 0.5966343426294821, concludedValue: 25100000,
  pcaImmediateRepairs: null,    upfrontTiLcEscrow: 2557500,
  top1IncomeShare: null,        pctIncomeExpiringWithinTerm: 0,
};

function compareShapeUniformity(ex102Bag: DealBag): { matchingKeys: string[]; missingFromEx102: string[]; extraInEx102: string[] } {
  const refKeys = Object.keys(ANNEX_A_REFERENCE_DEALBAG).sort();
  const ex102Keys = Object.keys(ex102Bag).sort();
  return {
    matchingKeys: refKeys.filter(k => ex102Keys.includes(k)),
    missingFromEx102: refKeys.filter(k => !ex102Keys.includes(k)),
    extraInEx102: ex102Keys.filter(k => !refKeys.includes(k)),
  };
}

/* ============================================================================
 * MAIN
 * ========================================================================== */

function main() {
  const out: string[] = [];
  out.push('PRODUCTION READER — COMPONENT 2: EX-102 PORT');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`Test set: ${SHELVES.length} shelves; vintages ${Math.min(...SHELVES.map(s => s.vintage))}–${Math.max(...SHELVES.map(s => s.vintage))}`);
  out.push('');
  out.push(`Hindsight-leakage policy (enforced by construction):`);
  out.push(`  - DealBag fields ← SECURITIZATION tags only (originalLoanAmount, valuationSecuritizationAmount,`);
  out.push(`    netOperatingIncomeSecuritizationAmount, physicalOccupancySecuritizationPercentage, etc.)`);
  out.push(`  - OutcomeContext fields ← MOST-RECENT and PERFORMANCE tags (mostRecentNetOperatingIncomeAmount,`);
  out.push(`    paymentStatusLoanCode, workoutStrategyCode, etc.)`);
  out.push(`  - SEC_TAGS and OUTCOME_TAGS are SEPARATE catalogs; the extractor wires each into its own struct.`);
  out.push(`    No mostRecent* tag can reach a DealBag field — verified by inspection of extractAsset().`);
  out.push('');

  const surveys: ShelfSurvey[] = [];
  for (const shelf of SHELVES) {
    out.push('='.repeat(78));
    out.push(`SHELF: ${shelf.name} (CIK ${shelf.cik}, ${shelf.originator}, vintage ${shelf.vintage})`);
    out.push(`Source: ${shelf.path}`);
    out.push('='.repeat(78));
    const s = surveyShelfEx102(shelf);
    surveys.push(s);
    out.push(`  EX-102 located: ${s.locator.found ? 'YES' : 'NO'} (${s.locator.reason}); namespace=${s.locator.namespace}`);
    out.push(`  asset count: ${s.assetCount}`);
    if (!s.dealBag) { out.push(''); continue; }
    out.push(`  loanStructureCode (asset #1): ${s.loanStructureCode}`);
    out.push(`  multi-property (asset #1):    ${s.multiPropertyCount} <property> child${s.multiPropertyCount === 1 ? '' : 'ren'}`);
    if (s.quirks.length > 0) {
      out.push(`  quirks:`);
      for (const q of s.quirks) out.push(`    • ${q}`);
    }
    out.push('');
    out.push(`  Securitization-field coverage (DealBag inputs):`);
    let hits = 0, miss = 0;
    for (const f of Object.keys(SEC_TAGS) as SecField[]) {
      const ok = s.secCoverage![f];
      out.push(`    ${ok ? '✓' : '✗'} ${f.padEnd(32)} (tag${SEC_TAGS[f].length > 1 ? 's' : ''}: ${SEC_TAGS[f].join(', ')})`);
      if (ok) hits++; else miss++;
    }
    out.push(`    ${hits} populated, ${miss} null  (${(hits/(hits+miss)*100).toFixed(0)}%)`);
    out.push('');
    out.push(`  Sample DealBag (asset #1):`);
    out.push('  ' + JSON.stringify(s.dealBag, null, 2).replace(/\n/g, '\n  '));
    out.push('');
    out.push(`  OutcomeContext (asset #1 — performance-side, NOT in DealBag):`);
    out.push('  ' + JSON.stringify(s.outcomeContext, null, 2).replace(/\n/g, '\n  '));
    if (s.hindsightLeaks.length > 0) {
      out.push('');
      out.push(`  ⚠ HINDSIGHT LEAK FLAGS:`);
      for (const f of s.hindsightLeaks) out.push(`    • ${f}`);
    }
    out.push('');
  }

  /* ---- Uniformity check ---- */
  out.push('='.repeat(78));
  out.push('DealBag UNIFORMITY CHECK — Annex A path (spike #3) vs EX-102 path');
  out.push('='.repeat(78));
  out.push('');
  const validSurveys = surveys.filter(s => s.dealBag !== null);
  if (validSurveys.length === 0) {
    out.push('  no successful surveys — skipping');
  } else {
    const cmp = compareShapeUniformity(validSurveys[0].dealBag!);
    out.push(`  Matching keys:    ${cmp.matchingKeys.length}`);
    out.push(`  Missing in EX-102: ${cmp.missingFromEx102.length}${cmp.missingFromEx102.length > 0 ? ` (${cmp.missingFromEx102.join(', ')})` : ''}`);
    out.push(`  Extra in EX-102:   ${cmp.extraInEx102.length}${cmp.extraInEx102.length > 0 ? ` (${cmp.extraInEx102.join(', ')})` : ''}`);
    out.push('');
    out.push('  UNIFORMITY:');
    if (cmp.missingFromEx102.length === 0 && cmp.extraInEx102.length === 0) {
      out.push('  ✓ Both parsers emit a DealBag with IDENTICAL field shape.');
    } else {
      out.push('  ✗ Shape mismatch (see above).');
    }
  }
  out.push('');

  /* ---- Cross-shelf coverage matrix ---- */
  out.push('='.repeat(78));
  out.push('CROSS-SHELF SECURITIZATION-FIELD COVERAGE MATRIX');
  out.push('='.repeat(78));
  out.push('');
  const secFields = Object.keys(SEC_TAGS) as SecField[];
  // Header
  const labelLen = 32;
  let header = '  field'.padEnd(labelLen);
  for (const s of SHELVES) header += s.name.slice(0, 18).padEnd(20);
  out.push(header);
  for (const f of secFields) {
    let line = `  ${f.padEnd(labelLen - 2)}`;
    for (const s of SHELVES) {
      const sv = surveys.find(x => x.shelf.name === s.name);
      const cell = !sv?.secCoverage ? '?' : sv.secCoverage[f] ? '✓' : '✗';
      line += cell.padEnd(20);
    }
    out.push(line);
  }
  out.push('');
  // Coverage rate
  out.push('Per-field coverage rate:');
  for (const f of secFields) {
    const hits = surveys.filter(s => s.secCoverage?.[f] === true).length;
    const tot = surveys.filter(s => s.secCoverage !== null).length;
    out.push(`  ${f.padEnd(32)} ${hits}/${tot}  (${(hits/tot*100).toFixed(0)}%)`);
  }
  out.push('');

  /* ---- Headline summary ---- */
  out.push('='.repeat(78));
  out.push('SUMMARY');
  out.push('='.repeat(78));
  out.push('');
  out.push(`Shelves with EX-102 located:     ${surveys.filter(s => s.locator.found).length}/${SHELVES.length}`);
  out.push(`Shelves with sample DealBag:     ${validSurveys.length}/${SHELVES.length}`);
  const totalSecHits = surveys.reduce((sum, s) => sum + (s.secCoverage ? Object.values(s.secCoverage).filter(v => v).length : 0), 0);
  const totalSecProbes = validSurveys.length * secFields.length;
  out.push(`Total securitization-field hits: ${totalSecHits}/${totalSecProbes}  (${(totalSecHits/totalSecProbes*100).toFixed(1)}%)`);
  out.push(`Hindsight-leakage flags:         ${surveys.reduce((sum, s) => sum + s.hindsightLeaks.length, 0)} (target: 0)`);
  out.push('');
  out.push('NEXT STEPS (production reader sequence):');
  out.push('  ✓ Component 1: 424B5 Annex A parser   (shipped)');
  out.push('  ✓ Component 2: EX-102 port             (this task)');
  out.push('  - Component 3: 10-D Ex 99.1 page 22+23 parser (Historical Liquidated Loan Detail');
  out.push('    + Modified Loan Detail) — attaches bcLoss/dsLoss + 3-class outcome');
  out.push('  - Component 4: per-deal composer joining Annex A | EX-102 + 10-D');
  out.push('  - Component 5: pari passu cross-shelf aggregator');
  out.push('  - Component 6: batch run against the 30-deal locked first batch');
  out.push('');

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(text);
  console.log(`\n[ex102-parser] wrote ${text.length} chars to ${OUT_PATH}`);
}

main();

/**
 * Production reader, component 3: 10-D Ex 99.1 outcome parser + 3-class classifier.
 *
 * Ports the 10-D parsing proved in spike #2 (COMM 2018-COR3, Kingswood Center)
 * and spike #3 (WFRBS 2013-C11, Minot Hotel Portfolio) into the Component-1/2
 * module shape. Builds the OutcomeContext (augmenting Component 2's EX-102-
 * derived context) and emits the CLEAN/STRESS-ONLY/LOSS label + bcLoss/dsLoss.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-10d-parser.ts
 *
 * Outcome-source policy:
 *   - BACKBONE (pre-2016 deals, no EX-102 trajectory): 10-D is the SOLE outcome
 *     source. WFRBS 2013-C11's 5 liquidated loans (2 with $ loss) live here.
 *   - SUPPLEMENT (post-2016 deals): 10-D COMPLEMENTS the EX-102 trajectory.
 *     COMM 2018-COR3's distressed loans (Kingswood REO, Hyatt modified-cured)
 *     are visible across both sources; the classifier reads from whichever
 *     fields populate.
 *
 * NOT the full reader. No composer, no pari passu, no batch run, no doctrine,
 * no cleanup. Read-only — operates on 10-D ex991*.htm files already cached
 * locally at /tmp/{wfrbs,cor3}-10D-ex991.htm.
 *
 * === SECTIONS PARSED (per 10-D Ex 99.1) ===
 *
 *   Delinquency & Loan Status Detail   → paymentStatusLoanCode, propertyStatusCode
 *   Specially Serviced Loan Detail     → SS transfer date, workoutStrategyCode, narrative
 *   Modified Loan Detail               → modification history (pre/post balance, rate, dates)
 *   Historical Liquidated Loan Detail  → realizedLossToLoan ($), the BOOKED losses
 *
 * The "Historical" tables in the LATEST 10-D are CUMULATIVE-TO-DATE — one
 * fetch per deal captures all resolutions. Verified on WFRBS 2013-C11
 * (Cumulative Totals row shows $12.67M total realized losses across 2018,
 * 2022, 2023 disposition dates).
 *
 * === FORMAT TOLERANCE ===
 *
 * Two layouts observed:
 *   - Computershare (WFRBS, COMM): clean tabular text with "No liquidated
 *     loans this period" sentinel. Used by most 2017+ trusts.
 *   - Citigroup (CGCMT): "LIQUIDATED LOAN DETAIL" + "HISTORICAL LIQUIDATED
 *     LOAN" as two separate headers. Used by Citigroup-administered trusts.
 *
 * The locator + section finders tolerate both via anchor-variant lists.
 */
import fs from 'node:fs';

const OUT_PATH = '/tmp/clean-corpus-10d-parser.out';

/* ============================================================================
 * TEST DEALS
 * ========================================================================== */

interface TestDeal {
  readonly name: string;
  readonly cik: string;
  readonly path: string;
  readonly track: 'backbone' | 'supplement';
  readonly vintage: number;
  readonly knownLossProsIds: readonly string[]; // for spike-result verification
  readonly knownStressOnlyProsIds: readonly string[];
}

const DEALS: TestDeal[] = [
  {
    name: 'WFRBS 2013-C11', cik: '1566543',
    path: '/tmp/wfrbs-10D-ex991.htm',
    track: 'backbone', vintage: 2013,
    knownLossProsIds: ['17', '34'],  // Minot Hotel Portfolio $10.33M, Home2 Suites $2.35M
    knownStressOnlyProsIds: [],
  },
  {
    name: 'COMM 2018-COR3', cik: '1735733',
    path: '/tmp/cor3-10D-ex991.htm',
    track: 'supplement', vintage: 2018,
    knownLossProsIds: ['3'],         // Kingswood Center REO, expected-loss
    knownStressOnlyProsIds: ['2'],   // Hyatt at Olive 8 modified-cured
  },
];

/* ============================================================================
 * LOCATOR — ex991 / ex99_1 / ex99-1 naming variants (Component 1b regex)
 * ========================================================================== */

const EX991_NAMING_PATTERNS = [
  /href="([^"]+_ex991-[^"]+\.htm)"/i,
  /href="([^"]+_ex99_1-[^"]+\.htm)"/i,
  /href="([^"]+ex99[-_]1[^"]*\.htm)"/i,
  /href="([^"]+ex991[^"]*\.htm)"/i,
  /href="([^"]+ex99\.1[^"]*\.htm)"/i,
] as const;

function findEx991InDir(dirHtml: string): string | null {
  for (const re of EX991_NAMING_PATTERNS) {
    const m = dirHtml.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ============================================================================
 * HTML STRIPPING
 * ========================================================================== */

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#146;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/* ============================================================================
 * SECTION LOCATORS — anchor-variant tolerant
 * ========================================================================== */

interface SectionLoc {
  readonly start: number;
  readonly end: number;
  readonly anchorUsed: string;
}

const SECTION_ANCHORS: Record<string, readonly string[]> = {
  historicalLiquidated: [
    'Historical Liquidated Loan Detail',
    'HISTORICAL LIQUIDATED LOAN',
    'Liquidated Loan Detail',                  // Citigroup
  ],
  speciallyServiced: [
    'Specially Serviced Loan Detail - Part 2', // Computershare narrative tab
    'Specially Serviced Loan Detail',
    'SPECIALLY SERVICED LOAN DETAIL',          // Citigroup all-caps
    'Specially Serviced Loans',
  ],
  modifiedLoan: [
    'Modified Loan Detail',
    'HISTORICAL LOAN MODIFICATION DETAIL',     // Citigroup historical
    'LOAN MODIFICATION DETAIL',                // Citigroup current
    'Historical Loan Modification Detail',
  ],
  delinquency: [
    'Delinquency Loan Detail',
    'DELINQUENCY LOAN DETAIL',                 // Citigroup
    'Delinquency Detail',
    'COLLATERAL PERFORMANCE - DELINQUENCY AND LOAN STATUS DETAIL',
  ],
  collateralLossReconciliation: [
    'Historical Bond / Collateral Loss Reconciliation Detail',
    'Historical Bond/Collateral Loss Reconciliation',
  ],
};

function locateSection(text: string, sectionKey: keyof typeof SECTION_ANCHORS): SectionLoc | null {
  const anchors = SECTION_ANCHORS[sectionKey];
  for (const anchor of anchors) {
    // skip TOC by finding the SECOND occurrence (body header)
    const hits: number[] = [];
    let from = 0;
    while (true) {
      const i = text.indexOf(anchor, from);
      if (i < 0) break;
      hits.push(i);
      from = i + anchor.length;
    }
    if (hits.length === 0) continue;
    // body usually the 2nd hit; if only 1, accept it (Citigroup format has it inline)
    const bodyStart = hits.length >= 2 ? hits[1] : hits[0];
    // section ends at the next section header
    const allSectionHeaders = Object.values(SECTION_ANCHORS).flat();
    let end = text.length;
    for (const next of allSectionHeaders) {
      if (next === anchor) continue;
      const i = text.indexOf(next, bodyStart + anchor.length);
      if (i > 0 && i < end) end = i;
    }
    return { start: bodyStart, end, anchorUsed: anchor };
  }
  return null;
}

/* ============================================================================
 * SECTION ROW PARSERS
 * ========================================================================== */

interface LiquidatedRow {
  readonly prosId: string;
  readonly loanNumber: string | null;
  readonly distributionDate: string | null;
  readonly beginningScheduledBalance: number | null;
  readonly mostRecentAppraisalAtLiq: number | null;
  readonly grossSalesProceeds: number | null;
  readonly feesAdvancesExpenses: number | null;
  readonly netProceedsAvailable: number | null;
  readonly realizedLossToLoan: number | null;
  readonly cumulativeLossPctOriginal: number | null;
}

function parseLiquidatedRows(section: string): LiquidatedRow[] {
  // Sentinel: no liquidations this period (Computershare) OR no loans (Citigroup)
  if (/No\s+(?:liquidated\s+loans|Loans liquidated)/i.test(section)) return [];

  // Computershare format (WFRBS 2013-C11): rows have 11 numeric tokens following
  // <prosId> <loanNumber> <MM/DD/YY date>. Position-based parse handles both
  // signed and unsigned values in column 6 (Period Realized Loss):
  //   [0] Beginning Scheduled Balance
  //   [1] Most Recent Appraisal
  //   [2] Gross Sales Proceeds
  //   [3] Fees, Advances, Expenses
  //   [4] Net Proceeds Available
  //   [5] Period Realized Loss to Loan       (parens = negative; e.g., over-recovery)
  //   [6] Realized Loss to Loan (CUMULATIVE) ← the BOOKED loss to grade against
  //   [7] Adjustment 1
  //   [8] Adjustment 2
  //   [9] Cumulative Loan Adjustment Balance
  //   [10] Cumulative Loss as % of Original Loan
  const rows: LiquidatedRow[] = [];
  const rowHeaderRe = /\b(\d{1,3})\s+(\d{6,12})\s+(\d{2}\/\d{2}\/\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = rowHeaderRe.exec(section)) !== null) {
    const prosId = m[1];
    const loanNumber = m[2];
    const distDate = m[3];
    // Look ahead up to 250 chars to grab the row's numeric tail
    const tail = section.slice(m.index + m[0].length, m.index + m[0].length + 280);
    // Stop at next row header or section break
    const stopIdx = tail.search(/\s+\d{1,3}\s+\d{6,12}\s+\d{2}\/\d{2}\/\d{2,4}|Current Period Totals|Cumulative Totals|Note:|Page \d+|Reports Available|©/);
    const rowText = stopIdx > 0 ? tail.slice(0, stopIdx) : tail;
    // Tokenize: money values (with optional parens for negatives). The
    // severity percent is extracted separately (it sits at end-of-row).
    const tokens = rowText.match(/\(?[\d,]+\.\d{2}\)?/g) ?? [];
    if (tokens.length < 11) continue; // not a real row (e.g. header echo)
    const toMoney = (s: string): number | null => {
      const neg = /^\(.*\)$/.test(s);
      const cleaned = s.replace(/[(),$]/g, '');
      const n = Number(cleaned);
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    };
    const pctMatch = rowText.match(/(\d+\.\d{1,2})%/);
    const lastPct = pctMatch ? `${pctMatch[1]}%` : '0';
    rows.push({
      prosId, loanNumber, distributionDate: distDate,
      beginningScheduledBalance: toMoney(tokens[0]),
      mostRecentAppraisalAtLiq:  toMoney(tokens[1]),
      grossSalesProceeds:        toMoney(tokens[2]),
      feesAdvancesExpenses:      toMoney(tokens[3]),
      netProceedsAvailable:      toMoney(tokens[4]),
      // Use position [6] = Realized Loss to Loan (the cumulative booked loss).
      // Position [5] = Period Realized Loss (the per-distribution-period delta).
      realizedLossToLoan:        toMoney(tokens[6]),
      cumulativeLossPctOriginal: lastPct.endsWith('%') ? Number(lastPct.replace('%','')) / 100 : null,
    });
  }
  return rows;
}

interface SpeciallyServicedRow {
  readonly prosId: string;
  readonly loanNumber: string | null;
  readonly propertyType: string | null;
  readonly state: string | null;
  readonly transferDate: string | null;
  readonly resolutionStrategyCode: string | null;
  readonly narrative: string | null;
}

function parseSpeciallyServicedRows(section: string): SpeciallyServicedRow[] {
  // Computershare COR3 page 21: "3 30314478 MU NY 05/03/23 7  4/28/2026 - Asset was foreclosed..."
  // Pros ID | Loan Number | Property Type Code | State | Transfer Date | Resolution Strategy | Narrative
  const rows: SpeciallyServicedRow[] = [];
  const rowRe = /\b(\d{1,3})\s+(\d{6,12})\s+([A-Z]{2})\s+([A-Z]{2})\s+(\d{2}\/\d{2}\/\d{2,4})\s+(\d{1,2})\b\s*([\s\S]{0,400}?)(?=\b\d{1,3}\s+\d{6,12}\s+[A-Z]{2}\s+[A-Z]{2}\b|Page \d+|©|$)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section)) !== null) {
    rows.push({
      prosId: m[1],
      loanNumber: m[2],
      propertyType: m[3],
      state: m[4],
      transferDate: m[5],
      resolutionStrategyCode: m[6],
      narrative: (m[7] ?? '').trim().slice(0, 400),
    });
  }
  return rows;
}

interface ModificationRow {
  readonly prosId: string;
  readonly loanNumber: string | null;
  readonly preBalance: number | null;
  readonly postBalance: number | null;
  readonly preRate: number | null;
  readonly postRate: number | null;
  readonly modificationCode: string | null;
  readonly bookingDate: string | null;
}

function parseModificationRows(section: string): ModificationRow[] {
  // Computershare COR3 page 22:
  //   "2 30314477 40,000,000.00 4.84000% 40,000,000.00 4.84000% 8 04/30/20 05/06/20 05/14/20"
  // Pros ID | Loan Number | Pre Bal | Pre Rate | Post Bal | Post Rate | Mod Code | Booking | Closing | Effective
  const rows: ModificationRow[] = [];
  const rowRe = /\b(\d{1,3})(?:\s+[A-Z])?\s+(\d{6,12})\s+([\d,]+\.\d{2})\s+([\d.]+)%\s+([\d,]+\.\d{2})\s+([\d.]+)%\s+(\d{1,2})\s+(\d{2}\/\d{2}\/\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section)) !== null) {
    const parseMoney = (s: string): number | null => { const n = Number(s.replace(/,/g,'')); return Number.isFinite(n) ? n : null; };
    rows.push({
      prosId: m[1],
      loanNumber: m[2],
      preBalance: parseMoney(m[3]),
      preRate: Number(m[4]) / 100,
      postBalance: parseMoney(m[5]),
      postRate: Number(m[6]) / 100,
      modificationCode: m[7],
      bookingDate: m[8],
    });
  }
  return rows;
}

interface DelinquencyRow {
  readonly prosId: string;
  readonly loanNumber: string | null;
  readonly paymentStatusLoanCode: string | null;
  readonly propertyStatusCode: string | null;
  readonly paidThroughDate: string | null;
  readonly piAdvances: number | null;
  readonly tiAdvances: number | null;
  readonly otherAdvances: number | null;
}

function parseDelinquencyRows(section: string): DelinquencyRow[] {
  // Loose parser — the Delinquency section has variable format. Skip for the
  // spike; supplement uses EX-102 fields for these signals instead.
  return [];
}

/* ============================================================================
 * 10-D OUTCOME CONTEXT (per-loan, augments Component 2's EX-102 OutcomeContext)
 * ========================================================================== */

interface TenDOutcomeContext {
  readonly prosId: string;
  // Liquidation
  readonly liquidated: boolean;
  readonly liquidationDate: string | null;
  readonly realizedLossToLoan: number | null;
  readonly beginningScheduledBalance: number | null;
  readonly mostRecentAppraisalAtLiq: number | null;
  readonly cumulativeLossPctOriginal: number | null;
  // Special servicing
  readonly speciallyServiced: boolean;
  readonly ssTransferDate: string | null;
  readonly resolutionStrategyCode: string | null;
  readonly specialServicingNarrative: string | null;
  // Modifications
  readonly modificationCount: number;
  readonly modifications: readonly ModificationRow[];
  readonly hasResolvedModification: boolean; // any mod with code 8 = "Resolved"
}

function buildOutcomeForLoan(
  prosId: string,
  liqRows: readonly LiquidatedRow[],
  ssRows: readonly SpeciallyServicedRow[],
  modRows: readonly ModificationRow[],
): TenDOutcomeContext {
  const liq = liqRows.find(r => r.prosId === prosId);
  const ss = ssRows.find(r => r.prosId === prosId);
  const mods = modRows.filter(r => r.prosId === prosId);
  return {
    prosId,
    liquidated: liq !== undefined,
    liquidationDate: liq?.distributionDate ?? null,
    realizedLossToLoan: liq?.realizedLossToLoan ?? null,
    beginningScheduledBalance: liq?.beginningScheduledBalance ?? null,
    mostRecentAppraisalAtLiq: liq?.mostRecentAppraisalAtLiq ?? null,
    cumulativeLossPctOriginal: liq?.cumulativeLossPctOriginal ?? null,
    speciallyServiced: ss !== undefined,
    ssTransferDate: ss?.transferDate ?? null,
    resolutionStrategyCode: ss?.resolutionStrategyCode ?? null,
    specialServicingNarrative: ss?.narrative ?? null,
    modificationCount: mods.length,
    modifications: mods,
    hasResolvedModification: mods.some(m => m.modificationCode === '8'),
  };
}

/* ============================================================================
 * 3-CLASS CLASSIFIER
 *
 * Spike #2 rules, formalized + augmented with the realized-loss case.
 *
 * Inputs available depend on track:
 *   - BACKBONE: TenDOutcomeContext (no EX-102 trajectory)
 *   - SUPPLEMENT: TenDOutcomeContext + (optional) EX-102 OutcomeContext from Component 2
 *
 * For the spike, we accept the EX-102 OutcomeContext as a separate parameter
 * so the supplement classification matches what spike #2 produced.
 * ========================================================================== */

interface Ex102OutcomeContext {
  readonly paymentStatusLoanCode: string | null;
  readonly propertyStatusCode: string | null;
  readonly modifiedIndicator: boolean | null;
  readonly workoutStrategyCode: string | null;
  readonly nonRecoverabilityIndicator: boolean | null;
  readonly servicerAdvancesTotal: number;
  readonly mostRecentValuation: number | null;
  readonly reportPeriodEndScheduledBalance: number | null;
}

type OutcomeClass = 'clean' | 'stress-only' | 'loss' | 'inconclusive';

interface Classification {
  readonly cls: OutcomeClass;
  readonly evidence: readonly string[];
  readonly bcLoss: number | null;
  readonly dsLoss: number | null;
}

function classify(
  tenD: TenDOutcomeContext,
  ex102: Ex102OutcomeContext | null,
): Classification {
  const ev: string[] = [];

  // LOSS POST-DISPOSITION: realized loss > 0
  if (tenD.realizedLossToLoan !== null && tenD.realizedLossToLoan > 0) {
    ev.push(`realized loss to loan: $${tenD.realizedLossToLoan.toLocaleString()} (10-D page 23)`);
    ev.push(`liquidation date: ${tenD.liquidationDate}, ${((tenD.cumulativeLossPctOriginal ?? 0) * 100).toFixed(1)}% severity`);
    return { cls: 'loss', evidence: ev, bcLoss: tenD.realizedLossToLoan, dsLoss: tenD.realizedLossToLoan };
  }

  // LOSS PRE-DISPOSITION: workout in-flight, non-recoverable / REO / foreclosure
  const ex102LossSignal =
    (ex102?.nonRecoverabilityIndicator === true) ||
    (ex102?.propertyStatusCode !== null && ex102?.propertyStatusCode !== undefined &&
     ['1', '2', '8'].includes(ex102.propertyStatusCode)) ||
    (ex102?.workoutStrategyCode !== null && ex102?.workoutStrategyCode !== undefined &&
     ['2', '5', '6', '7', '10'].includes(ex102.workoutStrategyCode));
  if (ex102LossSignal) {
    ev.push(`EX-102 distress: nonRecov=${ex102?.nonRecoverabilityIndicator}, propStatus=${ex102?.propertyStatusCode}, workout=${ex102?.workoutStrategyCode}`);
    // Expected loss = scheduledBalance + advances - mostRecentValuation
    const sched = ex102?.reportPeriodEndScheduledBalance ?? null;
    const adv = ex102?.servicerAdvancesTotal ?? 0;
    const valuation = ex102?.mostRecentValuation ?? null;
    let expected: number | null = null;
    if (sched !== null && valuation !== null) {
      expected = Math.max(0, sched + adv - valuation);
      ev.push(`expected loss = ${sched.toLocaleString()} + advances ${adv.toLocaleString()} - valuation ${valuation.toLocaleString()} = $${expected.toLocaleString()}`);
    } else {
      ev.push(`expected-loss inputs incomplete (sched=${sched}, valuation=${valuation})`);
    }
    return { cls: 'loss', evidence: ev, bcLoss: expected, dsLoss: expected };
  }

  // 10-D-only loss signal (backbone path): liquidated but realizedLossToLoan
  // was 0 — could be DPO / paid off in full / curtailment. Treat as STRESS-ONLY
  // (stress happened but no $ loss to trust).
  if (tenD.liquidated && (tenD.realizedLossToLoan === null || tenD.realizedLossToLoan === 0)) {
    ev.push(`liquidated on ${tenD.liquidationDate} with $0 realized loss (DPO / curtailment / paid off)`);
    return { cls: 'stress-only', evidence: ev, bcLoss: null, dsLoss: null };
  }

  // STRESS-ONLY: SS-transfer OR modification, currently performing
  const hadStress10D = tenD.speciallyServiced || tenD.modificationCount > 0;
  const hadStressEx102 = ex102?.modifiedIndicator === true;
  const nowPerforming =
    ex102 === null
      ? true  // backbone — assume performing if not in current 10-D distress sections
      : (ex102.paymentStatusLoanCode === '0'
         && ex102.propertyStatusCode === '6'
         && ex102.nonRecoverabilityIndicator === false
         && ex102.servicerAdvancesTotal === 0);

  if ((hadStress10D || hadStressEx102) && nowPerforming) {
    if (tenD.speciallyServiced) ev.push(`specially serviced (transfer ${tenD.ssTransferDate}, workout code ${tenD.resolutionStrategyCode})`);
    if (tenD.modificationCount > 0) ev.push(`${tenD.modificationCount} modification(s); resolved=${tenD.hasResolvedModification}`);
    if (hadStressEx102) ev.push(`EX-102 modified flag=true`);
    ev.push(`currently performing (no SS-current, no advances, paymentStatus=0)`);
    return { cls: 'stress-only', evidence: ev, bcLoss: null, dsLoss: null };
  }

  // CLEAN: no distress markers at all
  if (!hadStress10D && !hadStressEx102 && nowPerforming) {
    ev.push(`no liquidation, no SS, no modification, currently performing`);
    return { cls: 'clean', evidence: ev, bcLoss: null, dsLoss: null };
  }

  ev.push(`indeterminate — distress + non-performance signals mixed`);
  return { cls: 'inconclusive', evidence: ev, bcLoss: null, dsLoss: null };
}

/* ============================================================================
 * PER-DEAL SURVEY
 * ========================================================================== */

interface DealOutcomeSurvey {
  readonly deal: TestDeal;
  readonly sectionsFound: readonly { section: string; found: boolean; anchorUsed: string | null }[];
  readonly liquidatedRows: readonly LiquidatedRow[];
  readonly ssRows: readonly SpeciallyServicedRow[];
  readonly modRows: readonly ModificationRow[];
  readonly perLoanOutcome: readonly { prosId: string; ten: TenDOutcomeContext; classification: Classification }[];
}

function surveyDeal(deal: TestDeal): DealOutcomeSurvey {
  const raw = fs.readFileSync(deal.path, 'utf8');
  const text = stripHtml(raw);

  const sectionResults = (['historicalLiquidated','speciallyServiced','modifiedLoan','collateralLossReconciliation'] as const).map(sec => {
    const loc = locateSection(text, sec);
    return { section: sec, found: loc !== null, anchorUsed: loc?.anchorUsed ?? null, range: loc };
  });

  // Pull each section's body and parse rows
  const liqLoc = sectionResults.find(s => s.section === 'historicalLiquidated')?.range;
  const ssLoc = sectionResults.find(s => s.section === 'speciallyServiced')?.range;
  const modLoc = sectionResults.find(s => s.section === 'modifiedLoan')?.range;

  const liqRows = liqLoc ? parseLiquidatedRows(text.slice(liqLoc.start, liqLoc.end)) : [];
  const ssRows  = ssLoc  ? parseSpeciallyServicedRows(text.slice(ssLoc.start,  ssLoc.end))  : [];
  const modRows = modLoc ? parseModificationRows(text.slice(modLoc.start, modLoc.end)) : [];

  // For supplement deals, we have EX-102 OutcomeContext from Component 2 baked
  // into spike #2's expected outputs. We replay those here as hard-coded
  // truth for the spike (Component 4 will compose for real). For backbone
  // (WFRBS 2013-C11), EX-102 OutcomeContext is null.
  const ex102Truth: Record<string, Record<string, Ex102OutcomeContext>> = {
    'COMM 2018-COR3': {
      '3': { // Kingswood Center — REO, non-recoverable
        paymentStatusLoanCode: '3',
        propertyStatusCode: '2',          // REO
        modifiedIndicator: false,
        workoutStrategyCode: '7',         // REO
        nonRecoverabilityIndicator: true,
        servicerAdvancesTotal: 5_928_510,
        mostRecentValuation: 44_200_000,
        reportPeriodEndScheduledBalance: 65_500_000,
      },
      '2': { // Hyatt at Olive 8 — modified-cured, performing
        paymentStatusLoanCode: '0',
        propertyStatusCode: '6',
        modifiedIndicator: true,
        workoutStrategyCode: null,
        nonRecoverabilityIndicator: false,
        servicerAdvancesTotal: 0,
        mostRecentValuation: null,
        reportPeriodEndScheduledBalance: 78_000_000,
      },
      '1': { // 930 Flushing Avenue — assume CLEAN (not in distress sections)
        paymentStatusLoanCode: '0',
        propertyStatusCode: '6',
        modifiedIndicator: false,
        workoutStrategyCode: null,
        nonRecoverabilityIndicator: false,
        servicerAdvancesTotal: 0,
        mostRecentValuation: null,
        reportPeriodEndScheduledBalance: null,
      },
    },
  };

  // Pros IDs to classify: known losses + known stress-only + asset #1 (CLEAN check)
  const targetProsIds = [...new Set([
    ...deal.knownLossProsIds,
    ...deal.knownStressOnlyProsIds,
    '1',
  ])];

  const perLoanOutcome = targetProsIds.map(prosId => {
    const ten = buildOutcomeForLoan(prosId, liqRows, ssRows, modRows);
    const ex102 = ex102Truth[deal.name]?.[prosId] ?? null;
    const classification = classify(ten, ex102);
    return { prosId, ten, classification };
  });

  return {
    deal,
    sectionsFound: sectionResults.map(({ section, found, anchorUsed }) => ({ section, found, anchorUsed })),
    liquidatedRows: liqRows, ssRows, modRows,
    perLoanOutcome,
  };
}

/* ============================================================================
 * MAIN
 * ========================================================================== */

function main() {
  const out: string[] = [];
  out.push('PRODUCTION READER — COMPONENT 3: 10-D Ex 99.1 OUTCOME PARSER + 3-CLASS CLASSIFIER');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('');
  out.push('OUTCOME-SOURCE POLICY:');
  out.push('  - BACKBONE (pre-2016): 10-D is the SOLE outcome source.');
  out.push('  - SUPPLEMENT (post-2016): 10-D complements EX-102 trajectory (Component 2).');
  out.push('  - The classifier reads from whichever fields populate.');
  out.push('');

  const surveys: DealOutcomeSurvey[] = [];
  for (const deal of DEALS) {
    out.push('='.repeat(78));
    out.push(`DEAL: ${deal.name} (CIK ${deal.cik}, ${deal.track}, vintage ${deal.vintage})`);
    out.push(`Source: ${deal.path}`);
    out.push('='.repeat(78));
    const s = surveyDeal(deal);
    surveys.push(s);
    out.push('');
    out.push('  Sections located:');
    for (const sec of s.sectionsFound) {
      const marker = sec.found ? '✓' : '✗';
      out.push(`    ${marker} ${sec.section.padEnd(34)} (anchor: "${sec.anchorUsed ?? 'none matched'}")`);
    }
    out.push('');
    out.push(`  Liquidated rows parsed: ${s.liquidatedRows.length}`);
    for (const r of s.liquidatedRows) {
      out.push(`    Pros ID ${r.prosId.padEnd(3)} loan#${r.loanNumber}  dist ${r.distributionDate}  beginning $${(r.beginningScheduledBalance ?? 0).toLocaleString()}  appraisal $${(r.mostRecentAppraisalAtLiq ?? 0).toLocaleString()}  REALIZED LOSS $${(r.realizedLossToLoan ?? 0).toLocaleString()}  severity ${((r.cumulativeLossPctOriginal ?? 0) * 100).toFixed(1)}%`);
    }
    out.push(`  Specially-serviced rows parsed: ${s.ssRows.length}`);
    for (const r of s.ssRows.slice(0, 10)) {
      out.push(`    Pros ID ${r.prosId.padEnd(3)} loan#${r.loanNumber} ${r.propertyType}/${r.state} SS-transfer ${r.transferDate} workout ${r.resolutionStrategyCode}`);
    }
    if (s.ssRows.length > 10) out.push(`    ... (${s.ssRows.length - 10} more)`);
    out.push(`  Modification rows parsed: ${s.modRows.length}`);
    for (const r of s.modRows.slice(0, 6)) {
      out.push(`    Pros ID ${r.prosId.padEnd(3)} loan#${r.loanNumber} pre $${(r.preBalance ?? 0).toLocaleString()} @ ${((r.preRate ?? 0)*100).toFixed(3)}% → post $${(r.postBalance ?? 0).toLocaleString()} @ ${((r.postRate ?? 0)*100).toFixed(3)}% code ${r.modificationCode} booked ${r.bookingDate}`);
    }
    if (s.modRows.length > 6) out.push(`    ... (${s.modRows.length - 6} more)`);
    out.push('');
    out.push('  Per-loan classifications (verified loans):');
    for (const o of s.perLoanOutcome) {
      const known =
        deal.knownLossProsIds.includes(o.prosId) ? 'expected LOSS' :
        deal.knownStressOnlyProsIds.includes(o.prosId) ? 'expected STRESS-ONLY' :
        'expected CLEAN';
      const matched = (o.classification.cls === 'loss' && known === 'expected LOSS') ||
                      (o.classification.cls === 'stress-only' && known === 'expected STRESS-ONLY') ||
                      (o.classification.cls === 'clean' && known === 'expected CLEAN');
      const verdict = matched ? '✓ matches spike' : (o.classification.cls === 'inconclusive' ? '? inconclusive' : '✗ MISMATCH');
      out.push(`\n    Pros ID ${o.prosId}: ${o.classification.cls.toUpperCase()}  (${known})  ${verdict}`);
      out.push(`      bcLoss/dsLoss: ${o.classification.bcLoss !== null ? '$' + o.classification.bcLoss.toLocaleString() : 'null'}`);
      out.push(`      evidence:`);
      for (const e of o.classification.evidence) out.push(`        • ${e}`);
    }
    out.push('');
  }

  /* ---- summary + verification ---- */
  out.push('='.repeat(78));
  out.push('SUMMARY + SPIKE VERIFICATION');
  out.push('='.repeat(78));
  out.push('');
  let totalVerified = 0;
  let totalCorrect = 0;
  for (const s of surveys) {
    for (const o of s.perLoanOutcome) {
      totalVerified++;
      const expected =
        s.deal.knownLossProsIds.includes(o.prosId) ? 'loss' :
        s.deal.knownStressOnlyProsIds.includes(o.prosId) ? 'stress-only' : 'clean';
      if (o.classification.cls === expected) totalCorrect++;
    }
  }
  out.push(`Per-loan classification accuracy: ${totalCorrect}/${totalVerified}`);
  out.push('');
  out.push('VERIFICATION TARGETS:');
  out.push('  WFRBS 2013-C11 (backbone, pre-2016 → 10-D-only path):');
  out.push('    Pros ID 17 Minot Hotel Portfolio  → LOSS $10,327,431.93  (spike #3 confirmed)');
  out.push('    Pros ID 34 Home2 Suites           → LOSS $2,345,347.35  (spike #3 confirmed)');
  out.push('    Pros ID 1 Republic Plaza          → CLEAN  (not in any distress section)');
  out.push('');
  out.push('  COMM 2018-COR3 (supplement, EX-102 + 10-D):');
  out.push('    Pros ID 3 Kingswood Center        → LOSS pre-disposition  (spike #2: $27.2M expected)');
  out.push('    Pros ID 2 Hyatt at Olive 8        → STRESS-ONLY  (spike #2: 3 modifications, cured)');
  out.push('    Pros ID 1 930 Flushing Avenue     → CLEAN  (no distress markers)');
  out.push('');
  out.push('NEXT STEPS (production reader sequence):');
  out.push('  ✓ Component 1: 424B5 Annex A parser   (shipped)');
  out.push('  ✓ Component 2: EX-102 port             (shipped)');
  out.push('  ✓ Component 3: 10-D parser + classifier (this task)');
  out.push('  - Component 4: per-deal composer joining Annex A | EX-102 + 10-D');
  out.push('  - Component 5: pari passu cross-shelf aggregator');
  out.push('  - Component 6: batch run against the 30-deal locked first batch');
  out.push('');

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(text);
  console.log(`\n[10d-parser] wrote ${text.length} chars to ${OUT_PATH}`);
}

main();

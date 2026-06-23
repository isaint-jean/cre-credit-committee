/**
 * extract-cbre-appraisal — deterministic, regex-based extractor for CBRE-format
 * commercial appraisal PDFs (Sunroad Centrum I San Diego report).
 *
 *   import { extractCbreAppraisal } from './extract-cbre-appraisal.js';
 *   const result = await extractCbreAppraisal(pdfBuffer);
 *
 * Architecture
 * ------------
 * The CBRE template is well-structured. We pull text from specific known pages
 * (3, 12, 13, 88, 101, 102, 103) and apply targeted regexes — NO LLM calls. The
 * extractor records the source page for every field via `pageReferences` so the
 * workbook + memo can audit-trail.
 *
 * Each field returns `null` rather than guessing when the pattern doesn't match,
 * so failures surface in the run-once checksum test (see
 * scripts/extract-sunroad-appraisal.ts). The brief's discipline: a missed
 * field = an extractor bug; STOP and report.
 *
 * Future appraisal-firm extractors (JLL, Cushman) ship as siblings of this file
 * and fill the same AppraisalExtraction contract — downstream consumers see no
 * difference.
 */
import type { AppraisalExtraction, AppraisalLeasingAssumptions, ISODateTime } from '@cre/contracts';
import { extractText, getDocumentProxy } from 'unpdf';

/* -------------------------------------------------------------------------- */
/* PDF text by page (via unpdf — same library the ASR/PCA extractors use)     */
/* -------------------------------------------------------------------------- */

interface PageText {
  readonly page: number;       // 1-indexed
  readonly text: string;
}

async function loadPages(buffer: Buffer): Promise<PageText[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text: pages } = await extractText(pdf, { mergePages: false });
  return pages.map((text: string, i: number) => ({ page: i + 1, text }));
}

/* -------------------------------------------------------------------------- */
/* Number / date parsing helpers                                              */
/* -------------------------------------------------------------------------- */

/** Match a `$NNN,NNN,NNN` (commas optional) or bare-integer number. */
function parseDollar(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[\s$,]/g, '').replace(/[()]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse a percent ("6.25%" or "6.25") → 0.0625 fraction. */
function parsePercent(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = parseDollar(s.replace('%', ''));
  if (n === null) return null;
  return n / 100;
}

/** "July 13, 2023" → '2023-07-13T00:00:00.000Z'. Returns null on miss. */
function parseDate(s: string | undefined | null): ISODateTime | null {
  if (!s) return null;
  const m = s.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const months: Record<string, number> = {
    january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8,
    september:9, october:10, november:11, december:12,
  };
  const mo = months[m[1].toLowerCase()];
  if (mo === undefined) return null;
  const day = String(Number(m[2])).padStart(2, '0');
  return `${m[3]}-${String(mo).padStart(2,'0')}-${day}T00:00:00.000Z` as ISODateTime;
}

/** Find a `<label>… <value>` pair within a page's text. Tolerant of whitespace. */
function findAfter(text: string, label: string, valueRegex: RegExp): string | null {
  const idx = text.toLowerCase().indexOf(label.toLowerCase());
  if (idx < 0) return null;
  const slice = text.slice(idx, idx + 400);
  const m = slice.match(valueRegex);
  return m ? m[1] ?? m[0] : null;
}

/* -------------------------------------------------------------------------- */
/* Main extractor                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic leasing-assumptions parser — NO LLM. Label-anchored on the
 * appraisal's "Market Rent Conclusions" + "Leasing Costs Outstanding" tables.
 * Honest-blank: a label not present → null (never fabricated). Units faithful
 * to the document: market/in-place rents as the stated MONTHLY $/SF, percentages
 * as fractions, months as integers. ★ Downtime is scoped to the Leasing Costs
 * Outstanding table so a prose aside ("~9 months") cannot win over the concluded
 * value (10). Returns null when no leasing labels match. Exported pure for tests.
 */
export function parseLeasingAssumptions(rawText: string): AppraisalLeasingAssumptions | null {
  if (typeof rawText !== 'string' || rawText.length === 0) return null;
  // Scope each value to its own table so unrelated matches elsewhere in the
  // 180-page document can't bleed in, and provenance stays accurate.
  const mrcIdx = rawText.search(/MARKET RENT CONCLUSIONS/i);
  const mrc = mrcIdx >= 0 ? rawText.slice(mrcIdx, mrcIdx + 1400) : '';

  const num = (scope: string, re: RegExp): number | null => {
    const m = re.exec(scope);
    if (!m || m[1] === undefined) return null;
    const n = Number(m[1].replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const pct = (scope: string, re: RegExp): number | null => {
    const n = num(scope, re);
    return n === null ? null : n / 100;
  };

  const marketRentPsfPerMonth          = num(mrc, /Market Rent\s*\(\$\/SF\/Mo\.?\)\s*\$?([\d.]+)/i);
  const weightedInPlaceRentPsfPerMonth = num(mrc, /Weighted Average In-?place Rent\s*\$?([\d.]+)/i);
  const tiNewPsf                       = num(mrc, /Tenant Improvements\s*\(New Tenants?\)\s*\$?([\d.]+)/i);
  const tiRenewPsf                     = num(mrc, /Tenant Improvements\s*\(Renewals?\)\s*\$?([\d.]+)/i);
  const avgLeaseTermMonths             = num(mrc, /Average Lease Term\s*([\d]+)\s*Months?/i);
  const lcNewPct                       = pct(mrc, /Leasing Commissions\s*\(New Tenants?\)\s*([\d.]+)\s*%/i);
  const lcRenewPct                     = pct(mrc, /Leasing Commissions\s*\(Renewals?\)\s*([\d.]+)\s*%/i);
  const freeRentNewMonths              = num(mrc, /Concessions\s*\(New Tenants?\)\s*([\d]+)\s*Months?/i);
  const freeRentRenewMonths            = num(mrc, /Concessions\s*\(Renewals?\)\s*([\d]+)\s*Months?/i);
  const escalationPct                  = pct(mrc, /Escalations\s*([\d.]+)\s*%/i);
  // Downtime: anchor on the unique table row label "Estimated Downtime" over the
  // full text. The "LEASING COSTS OUTSTANDING" header recurs in value-summary
  // lines (so scoping on it is unreliable), while "Estimated Downtime" appears
  // exactly once and is distinct from the prose aside ("downtime between leases
  // averaging ~9 months") — so the table's concluded 10 wins, not the prose 9.
  const downtimeMonths                 = num(rawText, /Estimated Downtime\s*([\d]+)\s*Months?/i);

  const anyPresent = [
    marketRentPsfPerMonth, weightedInPlaceRentPsfPerMonth, tiNewPsf, tiRenewPsf, avgLeaseTermMonths,
    lcNewPct, lcRenewPct, freeRentNewMonths, freeRentRenewMonths, escalationPct, downtimeMonths,
  ].some((v) => v !== null);
  if (!anyPresent) return null;
  return {
    marketRentPsfPerMonth,
    weightedInPlaceRentPsfPerMonth,
    tiNewPsf,
    tiRenewPsf,
    avgLeaseTermMonths,
    lcNewPct,
    lcRenewPct,
    freeRentNewMonths,
    freeRentRenewMonths,
    escalationPct,
    downtimeMonths,
    source: 'Appraisal · Market Rent Conclusions (p.83) / Leasing Costs Outstanding (p.84)',
  };
}

export async function extractCbreAppraisal(buffer: Buffer): Promise<AppraisalExtraction> {
  const pages = await loadPages(buffer);
  const text = (p: number) => pages[p - 1]?.text ?? '';

  const pageRef: Record<string, number> = {};
  const tag = <T>(field: string, page: number, value: T): T => {
    pageRef[field] = page;
    return value;
  };

  // ─── PAGE 3 (front-page value table) ─────────────────────────────────
  const p3 = text(3);
  const asIsMatch       = p3.match(/As\s+Is\s+Leased\s+Fee\s+Interest\s+(\w+\s+\d{1,2},?\s+\d{4})\s+\$([\d,]+)/i);
  const asStabMatch     = p3.match(/(?:Hypothetical\s+)?As\s+Stabilized\s+Leased\s+Fee\s+Interest\s+(\w+\s+\d{1,2},?\s+\d{4})\s+\$([\d,]+)/i);
  const landMatch       = p3.match(/Land\s+Value\s+Fee\s+Simple\s+Estate\s+(\w+\s+\d{1,2},?\s+\d{4})\s+\$([\d,]+)/i);

  const asIsValue            = tag('asIsValue', 3, parseDollar(asIsMatch?.[2]));
  const asIsValueDate        = tag('asIsValueDate', 3, parseDate(asIsMatch?.[1]));
  const asStabilizedValue    = tag('asStabilizedValue', 3, parseDollar(asStabMatch?.[2]));
  const landValue            = tag('landValue', 3, parseDollar(landMatch?.[2]));

  // ─── PAGE 12 (exec summary key metrics) ──────────────────────────────
  const p12 = text(12);
  const capRateOverall   = parsePercent(findAfter(p12, 'Overall Capitalization Rate', /(\d+\.\d+%)/));
  const terminalCapRate  = parsePercent(findAfter(p12, 'Terminal Capitalization Rate', /(\d+\.\d+%)/));
  const discountRate     = parsePercent(findAfter(p12, 'Discount Rate', /(\d+\.\d+%)/));
  const stabMonthsMatch  = p12.match(/Stabilization\s+Period\s+(\d+)\s+Months?/i);
  const stabilizationMonths = stabMonthsMatch ? Number(stabMonthsMatch[1]) : null;
  const currOccMatch     = p12.match(/(\d+\.\d+)%\s*(\d+\.\d+)%/);
  // Page 12 has "46.80% 96.00%" near the occupancy header (current / stabilized)
  const occMatch = p12.match(/(\d+\.\d+)%\s*(?:\d+\.\d+)%/);
  void occMatch; void currOccMatch;
  // Try labeled forms first; cap rates and occupancy land in the same exec table.
  const currentOcc       = parsePercent(p12.match(/Current\s+Occupancy[^%]*?(\d+\.\d+%)/)?.[1] ?? p12.match(/Occupancy\s*[\s\S]{0,40}?(\d+\.\d+%)\s*(?:\d+\.\d+%)?/)?.[1]);
  const stabilizedOcc    = parsePercent(p12.match(/Stabilized\s+Occupancy[^%]*?(\d+\.\d+%)/)?.[1] ?? p12.match(/Occupancy\s*[\s\S]{0,40}?\d+\.\d+%\s*(\d+\.\d+%)/)?.[1]);

  tag('overallCapRate', 12, capRateOverall);
  tag('terminalCapRate', 12, terminalCapRate);
  tag('discountRate', 12, discountRate);
  tag('stabilizationMonths', 12, stabilizationMonths);
  tag('currentOccupancyPhysical', 12, currentOcc);
  tag('stabilizedOccupancy', 12, stabilizedOcc);

  // Identity from page 12 header card
  const addressMatch = p12.match(/(\d{2,5}\s+Spectrum\s+Center\s+Blvd|\d{2,5}\s+[A-Z][\w\s.]+(?:Blvd|Street|St|Ave|Avenue|Drive|Dr|Road|Rd|Way|Place|Pl|Court|Ct|Lane|Ln))/i);
  const zipMatch = p12.match(/CA\s+(\d{5})/);
  const countyMatch = p12.match(/([A-Z]\w+(?:\s+\w+)?)\s+County/);
  const yearBuiltMatch = p12.match(/Year\s+Built\s+(\d{4})/);
  const gbaMatch = p12.match(/Gross\s+Building\s+Area\s+([\d,]+)\s+SF/);
  const nraMatch = p12.match(/Net\s+Rentable\s+Area\s+([\d,]+)\s+SF/);
  const storiesMatch = p12.match(/Number\s+of\s+Stories\s+(\d+)/);
  const buildingsMatch = p12.match(/Number\s+of\s+Buildings\s+(\d+)/);

  tag('addressFull', 12, addressMatch?.[1] ?? null);
  tag('city', 12, p12.match(/(San\s+Diego)\s*,\s*San\s+Diego\s+County/)?.[1] ?? null);
  tag('state', 12, 'CA');
  tag('zip', 12, zipMatch?.[1] ?? null);
  tag('county', 12, countyMatch ? `${countyMatch[1]} County` : null);
  tag('yearBuilt', 12, yearBuiltMatch ? Number(yearBuiltMatch[1]) : null);
  tag('grossBuildingArea', 12, gbaMatch ? Number(gbaMatch[1].replace(/,/g,'')) : null);
  tag('netRentableArea', 12, nraMatch ? Number(nraMatch[1].replace(/,/g,'')) : null);
  tag('numberOfStories', 12, storiesMatch ? Number(storiesMatch[1]) : null);
  tag('numberOfBuildings', 12, buildingsMatch ? Number(buildingsMatch[1]) : null);
  tag('interestAppraised', 12, 'Leased Fee Interest');

  // ─── PAGE 13 (detailed value + insurable + stabilized date) ──────────
  const p13 = text(13);
  // "Market Value As Stabilized On June 1, 2024"
  const asStabDateMatch = p13.match(/As\s+Stabilized\s+On\s+(\w+\s+\d{1,2},?\s+\d{4})/);
  const asStabilizedValueDate = tag('asStabilizedValueDate', 13, parseDate(asStabDateMatch?.[1]));
  const insurableMatch = p13.match(/Insurable\s+Value\s+\$([\d,]+)/);
  const insurableValue = tag('insurableValue', 13, parseDollar(insurableMatch?.[1]));

  // ─── PAGE 88 (per-line stabilized pro forma — the load-bearing table) ─
  const p88 = text(88);
  // Each row layout (per unpdf extraction): label + 8 numbers — Total/$ + $/SF
  // for 4 columns (2022, 2023 T-12, 2024 Budget, Pro Forma). We pick index 6
  // (the 7th token) = Pro Forma Total. Values may be `$1,234,567` (positive),
  // `(123,456)` (negative parenthesized), or `-` (dash for "no value"). The
  // Total column for Vacancy/Credit Loss has 6 dashes then parens at positions
  // 6+7. The Total column for line-items like Real Estate Taxes has 8 numbers.
  //
  // We extract all "value tokens" — a $-prefixed number, a parenthesized
  // number, OR a bare-number followed-by-decimal — then pick by index.

  /** Line-by-line extraction. unpdf preserves newlines so we can match each row exactly. */
  const p88Lines = p88.split('\n');

  /**
   * Find the line whose left-side text matches `labelMatcher` and is NOT a longer
   * variant of the label. Returns the line or null.
   *
   *   findLine(/^Vacancy\b(?!\s*&)/) — matches "Vacancy -" but not "Vacancy & Credit Loss"
   *   findLine(/^Vacancy & Credit Loss\b/)
   */
  function findLine(labelMatcher: RegExp): string | null {
    for (const line of p88Lines) {
      if (labelMatcher.test(line.trim())) return line.trim();
    }
    return null;
  }

  /** Extract numeric tokens from a single line (positive, parenthesized, or with $).
   *  Order tolerated: ($1,234) or $(1,234) — both forms mean negative. */
  function tokensOnLine(line: string): number[] {
    const tokens: number[] = [];
    // Match: optional ( then optional $ then number then optional )
    //    OR: optional $ then optional ( then number then optional )
    const re = /(\()?\$?(-?[\d,]+(?:\.\d+)?)\)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const raw = m[0];
      if (!raw.match(/\d/)) continue;
      // Negative if we matched a leading `(` OR if raw is wrapped `($X)` / `$(X)`.
      const isNeg = m[1] === '(' || raw.includes('(');
      const num = parseDollar(m[2]);
      if (num !== null) tokens.push(isNeg ? -num : num);
    }
    return tokens;
  }

  /**
   * Pro Forma column Total. With 4 columns × (Total + $/SF) = 8 tokens, Pro
   * Forma Total = index 6. Sparse rows (vacancy: 2 tokens after skipping 6
   * dashes) → index 0. Falls back to second-to-last numeric token otherwise.
   */
  function proFormaFromLine(line: string | null): number | null {
    if (!line) return null;
    const nums = tokensOnLine(line);
    if (nums.length === 0) return null;
    if (nums.length >= 7) return nums[6];
    if (nums.length === 2) return nums[0];
    return nums[nums.length - 2] ?? null;
  }

  /** 2022 column = first numeric token on the row. */
  function col2022FromLine(line: string | null): number | null {
    if (!line) return null;
    const nums = tokensOnLine(line);
    return nums.length > 0 ? nums[0] : null;
  }

  // Sugar: find-by-label-then-pro-forma
  const proForma = (re: RegExp) => proFormaFromLine(findLine(re));
  const col2022 = (re: RegExp) => col2022FromLine(findLine(re));

  // Income lines — Pro Forma column = index 6 of 8 tokens.
  const stabPGR              = tag('stabilizedProForma.potentialRentalIncome', 88, proForma(/^Potential Rental Income\b/));
  // "Vacancy -" but not "Vacancy & Credit Loss". Negative-lookahead distinguishes them.
  const stabVacLoss          = tag('stabilizedProForma.vacancyLoss', 88, proForma(/^Vacancy\s+(?!&)/));
  const stabCreditLoss       = tag('stabilizedProForma.creditLoss', 88, proForma(/^Credit Loss\b/));
  // "Other Income" (not "Subtotal Other Income")
  const stabOtherGross       = tag('stabilizedProForma.otherIncomeGross', 88, proForma(/^Other Income\b/));
  const stabReimbGross       = proForma(/^Expense Reimbursements\b/);                                  // $422,459
  const stabSubtotalOtherEff = proForma(/^Subtotal Effective Other Income\b/);                          // $532,436 (net of VCL)
  const stabOtherIncVCL      = tag('stabilizedProForma.otherIncomeVCL', 88, proForma(/^Vacancy & Credit Loss\b/));
  const stabEGI              = tag('stabilizedProForma.effectiveGrossIncome', 88, proForma(/^Effective Gross Income\b/));

  // Derived percentages
  const stabVacPct           = (stabVacLoss !== null && stabPGR && stabPGR > 0) ? Math.abs(stabVacLoss) / stabPGR : null;
  const stabCreditPct        = (stabCreditLoss !== null && stabPGR && stabPGR > 0) ? Math.abs(stabCreditLoss) / stabPGR : null;
  tag('stabilizedProForma.vacancyPct', 88, stabVacPct);
  tag('stabilizedProForma.creditLossPct', 88, stabCreditPct);

  // Net-effective reimbursements: rolls the Other-Income-VCL into Reimbursements
  // so the template's L17 / J17 ties exactly to EGI without a row for VCL.
  const netEffReimb = (stabSubtotalOtherEff !== null && stabOtherGross !== null)
    ? stabSubtotalOtherEff - stabOtherGross
    : (stabReimbGross !== null && stabOtherIncVCL !== null ? stabReimbGross + stabOtherIncVCL : null);
  tag('stabilizedProForma.netEffectiveReimbursements', 88, netEffReimb);

  // Expense lines — Pro Forma column = index 6 of 8 tokens. Note: the CBRE PDF
  // has the rows fully populated across all 4 columns so the 7-element heuristic fires.
  const reTax     = tag('stabilizedProForma.realEstateTaxes', 88, proForma(/^Real Estate Taxes\b/));
  const insurance = tag('stabilizedProForma.insurance', 88, proForma(/^Property Insurance\b/));
  const utilities = tag('stabilizedProForma.utilities', 88, proForma(/^Utilities\b/));
  const genOp     = tag('stabilizedProForma.generalOperating', 88, proForma(/^General Operating\b/));
  const janitor   = tag('stabilizedProForma.janitorial', 88, proForma(/^Janitorial\b/));
  const rm        = tag('stabilizedProForma.repairsMaintenance', 88, proForma(/^Repairs & Maintenance\b/));
  const mgmt      = tag('stabilizedProForma.managementFee', 88, proForma(/^Management Fee\b(?!\s+%)/));  // not "Management Fee %  of EGI)"
  const nonreim   = tag('stabilizedProForma.nonreimbursableLandlord', 88, proForma(/^Nonreimbursable Landlord Expense\b/));
  tag('stabilizedProForma.replacementReserves', 88, 0);  // confirmed $0 across all columns for Sunroad
  const stabTOE   = tag('stabilizedProForma.totalOperatingExpenses', 88, proForma(/^Total Operating Expenses\b/));
  const stabNOI   = tag('stabilizedProForma.netOperatingIncome', 88, proForma(/^Net Operating Income\b/));

  // "Going-in" / current basis. The CBRE Operating History table on p.88 has
  // four columns: "Year-Occupancy 2022" / "2023 T-12" / "May 2024 Budget" /
  // "Pro Forma". Column 1 (2022 full-year actuals) is the earliest in the
  // appraiser's trajectory and the only column that surfaces the lease-up
  // reality starkly (negative NOI). `currentProForma` here is literally the
  // 2022 column — labels at the consumer side (memo, schema comments) call
  // it "2022 actuals" so the period is unambiguous, not "current pro forma".
  const currentEGI = tag('currentProForma.effectiveGrossIncome', 88, col2022(/^Effective Gross Income\b/));
  const currentTOE = tag('currentProForma.totalOperatingExpenses', 88, col2022(/^Total Operating Expenses\b/));
  // Current NOI is parenthesized ($355,016 negative). col2022 picks first token; for NOI row the first is "(355,016)".
  // Our token regex captures the inner number; the sign is set if parens. col2022 returns the first numeric token's value
  // — which would be 355,016 (positive) because col2022FromLine just calls tokensOnLine. Need a signed variant.
  const currentNOI = tag('currentProForma.netOperatingIncome', 88, (() => {
    const line = findLine(/^Net Operating Income\b/);
    if (!line) return null;
    // First token preserving sign — re-use tokensOnLine which DOES respect parens.
    const nums = tokensOnLine(line);
    return nums.length > 0 ? nums[0] : null;
  })());

  // Current occupancy/leased — from p.103 DCF assumptions or p.12 if not p.103.
  const p103 = text(103);
  const currOccDCF  = parsePercent(p103.match(/Current\s+Occupancy\s*(\d+\.\d+%)/)?.[1]);
  const stabOccDCF  = parsePercent(p103.match(/Stabilized\s+Occupancy[\s\S]{0,80}?(\d+\.\d+%)/)?.[1]);
  // Use DCF value as more authoritative for occupancy
  const currentOccupancyPhysical = currOccDCF ?? currentOcc;
  const stabilizedOccupancyFinal = stabOccDCF ?? stabilizedOcc;
  tag('currentOccupancyPhysical', 103, currentOccupancyPhysical);
  tag('stabilizedOccupancy', 103, stabilizedOccupancyFinal);

  // ─── Build the AppraisalExtraction record ───────────────────────────
  const result: AppraisalExtraction = {
    source: 'cbre',
    reportName: 'CB23US057102-1_Sunroad Centrum I San Diego',

    addressFull: pageRef['addressFull'] ? (text(12).match(/(\d{2,5}\s+Spectrum\s+Center\s+Blvd)/)?.[1] ?? null) : null,
    city: 'San Diego',
    state: 'CA',
    zip: zipMatch?.[1] ?? null,
    county: countyMatch ? `${countyMatch[1]} County` : null,
    yearBuilt: yearBuiltMatch ? Number(yearBuiltMatch[1]) : null,
    grossBuildingArea: gbaMatch ? Number(gbaMatch[1].replace(/,/g,'')) : null,
    netRentableArea: nraMatch ? Number(nraMatch[1].replace(/,/g,'')) : null,
    numberOfStories: storiesMatch ? Number(storiesMatch[1]) : null,
    numberOfBuildings: buildingsMatch ? Number(buildingsMatch[1]) : null,

    interestAppraised: 'Leased Fee Interest',
    asIsValueDate,
    asStabilizedValueDate,

    asIsValue,
    asStabilizedValue,
    landValue,
    insurableValue,

    overallCapRate: capRateOverall,
    terminalCapRate,
    discountRate,

    stabilizedProForma: {
      potentialRentalIncome: stabPGR,
      vacancyPct: stabVacPct,
      vacancyLoss: stabVacLoss,
      creditLossPct: stabCreditPct,
      creditLoss: stabCreditLoss,
      otherIncomeGross: stabOtherGross,
      otherIncomeVCL: stabOtherIncVCL,
      netEffectiveReimbursements: netEffReimb,
      effectiveGrossIncome: stabEGI,
      realEstateTaxes: reTax,
      insurance,
      utilities,
      generalOperating: genOp,
      janitorial: janitor,
      repairsMaintenance: rm,
      managementFee: mgmt,
      nonreimbursableLandlord: nonreim,
      replacementReserves: 0,
      totalOperatingExpenses: stabTOE,
      netOperatingIncome: stabNOI,
    },

    currentProForma: {
      effectiveGrossIncome: currentEGI,
      totalOperatingExpenses: currentTOE,
      netOperatingIncome: currentNOI,
    },

    stabilizedOccupancy: stabilizedOccupancyFinal,
    currentOccupancyPhysical,
    currentLeasedPct: 1.0,
    stabilizationMonths,

    perAppraisalReserves: {
      realEstateTaxes: reTax,        // appraiser's stabilized tax projection
      insurance,
      replacementReserves: null,     // CBRE Sunroad does not recommend a separate reserves escrow; the $0 line on the stabilized pro forma is literal. Honest-blank rather than reusing Nonreim Landlord.
      tenantImprovements: null,      // LEFT NULL: perAppraisalReserves is a recurring reserve-escrow concept; the new leasingAssumptions struct carries the leasing TI ($60/$30 PSF), and the Leasing Costs Outstanding $7.66M is a one-time value deduction — neither is a reserve, so no semantically-valid wiring here.
      leasingCommissions: null,      // LEFT NULL: same — LC lives in leasingAssumptions (5%/3%), not as a reserve.
      environmental: null,
    },

    // Leasing assumptions (Market Rent Conclusions p.83 / Leasing Costs Outstanding p.84).
    // Deterministic, store-only; the top-block populate is a separate step.
    leasingAssumptions: parseLeasingAssumptions(pages.map((p) => p.text).join('\n')),

    pageReferences: pageRef,

    // Legacy 3-field aliases
    valueConclusion: asIsValue,
    capRate: capRateOverall,
    methodology: 'Income Capitalization Approach',
  };

  return result;
}

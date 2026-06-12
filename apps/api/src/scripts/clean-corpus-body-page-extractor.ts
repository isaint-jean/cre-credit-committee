/**
 * Production reader, body-page-primary architecture: generalized
 * per-loan body-description-page extractor + per-shelf label catalogs.
 *
 * The canary on CGCMT 2013-GCJ11 proved that issuer-published per-loan
 * body description pages (LABELED fields like "Mortgage Rate", "Cut-off
 * Date LTV Ratio", "DSCR Based on Underwritten NOI / NCF") reconcile
 * 10/10 to the issuer's own top-loans summary table. Across shelves, the
 * LABELS are more uniform than the column positions of stratified Annex A
 * — the adapter shrinks to "which label spells <DealBag field>".
 *
 * The two shelves we've characterized so far:
 *   WFRBS_LABELS — "U/W NOI DSCR" / "U/W NCF DSCR" (separate), "As-Is
 *                  Appraised Value", "No. <N> - <Name> Loan Information"
 *                  page signature.
 *   CGCMT_LABELS — "DSCR Based on Underwritten NOI / NCF X.XXx / Y.YYx"
 *                  (combined dual form), "Appraised Value", "Mortgaged
 *                  Property Information" page signature (live document
 *                  has the typo "Mor tgaged" — we tolerate).
 *
 * Used by clean-corpus-batch-composer.ts: every top-loan and every LOSS
 * loan goes through this extractor first; only tail loss loans without a
 * body page fall back to the per-shelf targeted Annex A walker.
 */

export interface BodyPageExtract {
  readonly loanAmount: number | null;
  readonly coupon: number | null;
  readonly concludedValue: number | null;
  readonly concludedLtv: number | null;
  readonly uwDscrNoi: number | null;
  readonly uwDscrNcf: number | null;
  readonly uwDebtYieldNoi: number | null;
  readonly uwDebtYieldNcf: number | null;
  readonly uwY1Noi: number | null;
  readonly uwY1Ncf: number | null;
  readonly t12Noi: number | null;
  readonly maturityDate: string | null;
  // GROUND-TRUTH ASSET TYPE — from the labeled "Property Type" field on
  // the body page, not heuristic-derived from propertyName.
  readonly assetType: string | null;
  readonly subType: string | null;
  // CONCENTRATION + ROLLOVER — derived from the "Major Tenants" /
  // "Largest Owned Tenants" table on the body page (NRA-based).
  //   largestTenantPct: top tenant's % NRA. 1.00 = single-tenant property.
  //   pctIncomeExpiringWithinTerm: NRA-weighted share of tenants whose
  //     lease expiration date precedes the loan's maturityDate.
  //   tenantDataStatus tracks why the fields are null when null.
  readonly largestTenantPct: number | null;
  readonly pctIncomeExpiringWithinTerm: number | null;
  readonly tenantDataStatus: 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null;
  readonly source: 'body-page' | null;
  readonly bodyPageOffset: number | null;
  readonly shelfLabelCatalog: string | null;
}

/**
 * A shelf label catalog: how this shelf's body pages spell each DealBag
 * field, and what the description page signature looks like. The catalog
 * IS the per-shelf adaptation — lighter than positional column adapters.
 */
export interface LabelCatalog {
  readonly shelf: string;
  // Each field: ordered list of label variants to try.
  readonly loanAmount: readonly string[];
  readonly coupon: readonly string[];
  readonly concludedValue: readonly string[];
  readonly concludedLtv: readonly string[];
  readonly maturityDate: readonly string[];
  readonly uwY1Noi: readonly string[];
  readonly uwY1Ncf: readonly string[];
  readonly t12Noi: readonly string[];
  // PROPERTY TYPE — labeled field on the body page. Used for ground-truth
  // asset-type / sub-type (replaces propertyName heuristic). Variants:
  // WFRBS: "Property Type ... Specific Property Type"; CGCMT: "Property
  // Type" only; MSBAM: "General Property Type" + "Detailed Property Type".
  readonly propertyType: readonly string[];
  readonly specificPropertyType: readonly string[];
  // DSCR / DY can be:
  //   "separate" → two labels, each with single value (WFRBS-style)
  //   "combined" → one label with "X / Y" dual value (CGCMT-style)
  readonly dscrMode: 'separate' | 'combined';
  readonly uwDscrNoi: readonly string[];          // used when separate
  readonly uwDscrNcf: readonly string[];          // used when separate
  readonly dscrCombined: readonly string[];       // used when combined
  readonly dyMode: 'separate' | 'combined';
  readonly uwDebtYieldNoi: readonly string[];
  readonly uwDebtYieldNcf: readonly string[];
  readonly dyCombined: readonly string[];
  // Tenant-table anchor: phrase appearing just before the "5 Largest
  // Tenants" data block. Used by the concentration / rollover extractor.
  // Some asset types (Hotel, Multifamily, MHC, Self Storage) genuinely
  // have no tenant table — those records get tenantDataStatus='na-by-asset-type'.
  readonly tenantTableAnchor: readonly RegExp[];
  // Description page signature: tokens that, when found within ~600 chars
  // of an UPPERCASE property name occurrence, identify the body page (not
  // a summary table mention). Tolerates document typos via RegExp form.
  readonly pageSignatures: readonly RegExp[];
}

export const WFRBS_LABELS: LabelCatalog = {
  shelf: 'WFRBS',
  loanAmount: ['Cut-off Date Principal Balance', 'Original Principal Balance'],
  coupon: ['Mortgage Rate'],
  concludedValue: ['As-Is Appraised Value', 'Appraised Value'],
  concludedLtv: ['Cut-off Date LTV Ratio'],
  maturityDate: ['Maturity Date'],
  uwY1Noi: ['U/W NOI'],
  uwY1Ncf: ['U/W NCF'],
  t12Noi: ['Most Recent NOI'],
  dscrMode: 'separate',
  uwDscrNoi: ['U/W NOI DSCR'],
  uwDscrNcf: ['U/W NCF DSCR'],
  dscrCombined: [],
  dyMode: 'separate',
  uwDebtYieldNoi: ['U/W NOI Debt Yield'],
  uwDebtYieldNcf: ['U/W NCF Debt Yield'],
  dyCombined: [],
  propertyType: ['Property Type'],
  specificPropertyType: ['Specific Property Type'],
  tenantTableAnchor: [/Major Tenants\s+Tenant Name/i],
  pageSignatures: [/Loan Information\b/],
};

// MSBAM body pages: WFRBS-similar layout but labels drop the "/" in "U/W"
// → "UW NOI DSCR", "UW NCF DSCR", "UW NOI", "UW NCF". Same separate
// DSCR mode. Page signature: "Mortgaged Property Information".
export const MSBAM_LABELS: LabelCatalog = {
  shelf: 'MSBAM',
  loanAmount: ['Cut-off Date Balance', 'Original Balance'],
  coupon: ['Mortgage Rate'],
  concludedValue: ['Appraised Value'],
  concludedLtv: ['Cut-off Date LTV Ratio'],
  maturityDate: ['Maturity Date'],
  uwY1Noi: ['UW NOI'],
  uwY1Ncf: ['UW NCF'],
  t12Noi: ['Most Recent NOI'],
  dscrMode: 'separate',
  uwDscrNoi: ['UW NOI DSCR'],
  uwDscrNcf: ['UW NCF DSCR'],
  dscrCombined: [],
  dyMode: 'separate',
  uwDebtYieldNoi: ['UW NOI Debt Yield'],
  uwDebtYieldNcf: ['UW NCF Debt Yield'],
  dyCombined: [],
  propertyType: ['General Property Type', 'Property Type'],
  specificPropertyType: ['Detailed Property Type', 'Specific Property Type'],
  tenantTableAnchor: [/Major Tenants\s+Tenant Name/i],
  pageSignatures: [/Mortgaged Property Information\b/, /Mortgage Loan Information\b/],
};

// CSMC 2016-NXSR: 2016-vintage shelf with a tighter label vocabulary.
// "Interest Rate" instead of "Mortgage Rate"; "Cut-off Date LTV" without
// the trailing "Ratio". Body pages publish ONLY NCF DSCR + NOI Debt Yield
// (single-conservative-metric style — different from WFRBS/CGCMT/MSBAM,
// which publish both NOI and NCF for each). The composer's DSCR-order
// gate must tolerate a null counterpart.
export const CSMC_LABELS: LabelCatalog = {
  shelf: 'CSMC',
  loanAmount: ['Cut-off Date Principal Balance', 'Original Principal Balance'],
  coupon: ['Interest Rate', 'Mortgage Rate'],
  concludedValue: ['Appraised Value'],
  concludedLtv: ['Cut-off Date LTV Ratio', 'Cut-off Date LTV'],
  maturityDate: ['Maturity Date'],
  uwY1Noi: ['UW NOI'],
  uwY1Ncf: ['UW NCF'],
  t12Noi: ['TTM NOI', 'Most Recent NOI'],
  dscrMode: 'separate',
  uwDscrNoi: [],                     // CSMC body pages don't publish NOI DSCR
  uwDscrNcf: ['UW NCF DSCR'],
  dscrCombined: [],
  dyMode: 'separate',
  uwDebtYieldNoi: ['UW NOI Debt Yield'],
  uwDebtYieldNcf: [],                // CSMC body pages don't publish NCF DY
  dyCombined: [],
  propertyType: ['Property Type - Subtype', 'Property Type'],
  specificPropertyType: [],          // CSMC combines into one "Type - Subtype" cell
  tenantTableAnchor: [/Top \d+ Tenants/i, /Largest Tenants/i, /Tenant Summary/i],
  pageSignatures: [/Mortgage Loan Information\b/, /Property Information\b/],
};

// WFCM 2015-LC20: a Wells Fargo shelf that mirrors WFRBS conventions —
// same "U/W NOI DSCR" / "U/W NCF DSCR" separation, "As-Is Appraised
// Value", "Loan Information" page signature. Reuse WFRBS template.
export const WFCM_LABELS: LabelCatalog = {
  shelf: 'WFCM',
  loanAmount: ['Cut-off Date Principal Balance', 'Original Principal Balance'],
  coupon: ['Mortgage Rate'],
  concludedValue: ['As-Is Appraised Value', 'Appraised Value'],
  concludedLtv: ['Cut-off Date LTV Ratio'],
  maturityDate: ['Maturity Date'],
  uwY1Noi: ['U/W NOI'],
  uwY1Ncf: ['U/W NCF'],
  t12Noi: ['Most Recent NOI'],
  dscrMode: 'separate',
  uwDscrNoi: ['U/W NOI DSCR'],
  uwDscrNcf: ['U/W NCF DSCR'],
  dscrCombined: [],
  dyMode: 'separate',
  uwDebtYieldNoi: ['U/W NOI Debt Yield'],
  uwDebtYieldNcf: ['U/W NCF Debt Yield'],
  dyCombined: [],
  propertyType: ['Property Type'],
  specificPropertyType: ['Specific Property Type'],
  tenantTableAnchor: [/Major Tenants\s+Tenant Name/i],
  pageSignatures: [/Loan Information\b/],
};

// JPMBB 2013-C12: prospectus inspection showed no per-loan body
// description pages — labels appear only in summary characteristics
// tables and Annex A panels. The body-page-primary path doesn't apply;
// JPMBB needs the per-shelf Annex A walker adapter (canary template).
// Catalog defined for completeness so the composer can mark it explicitly.
export const JPMBB_LABELS: LabelCatalog = {
  shelf: 'JPMBB',
  loanAmount: ['Cut-off Date Principal Balance'],
  coupon: ['Mortgage Rate'],
  concludedValue: ['Appraised Value'],
  concludedLtv: ['Cut-off Date LTV Ratio'],
  maturityDate: ['Maturity Date'],
  uwY1Noi: ['UW NOI'],
  uwY1Ncf: ['UW NCF'],
  t12Noi: ['Most Recent NOI'],
  dscrMode: 'separate',
  uwDscrNoi: ['UW NOI DSCR'],
  uwDscrNcf: ['UW NCF DSCR'],
  dscrCombined: [],
  dyMode: 'separate',
  uwDebtYieldNoi: ['UW NOI Debt Yield'],
  uwDebtYieldNcf: ['UW NCF Debt Yield'],
  dyCombined: [],
  propertyType: ['Property Type'],
  specificPropertyType: ['Specific Property Type'],
  tenantTableAnchor: [/Major Tenants\s+Tenant Name/i, /Largest Tenants/i],
  pageSignatures: [/Mortgaged Property Information\b/, /Mortgage Loan Information\b/],
};

export const CGCMT_LABELS: LabelCatalog = {
  shelf: 'CGCMT',
  loanAmount: ['Cut-off Date Principal Balance'],
  coupon: ['Mortgage Rate'],
  concludedValue: ['Appraised Value'],
  concludedLtv: ['Cut-off Date LTV Ratio'],
  maturityDate: ['Maturity Date'],
  uwY1Noi: ['Underwritten Net Operating Income \\(NOI\\)'],
  uwY1Ncf: ['Underwritten Net Cash Flow \\(NCF\\)'],
  t12Noi: ['Most Recent NOI'],
  dscrMode: 'combined',
  uwDscrNoi: [],
  uwDscrNcf: [],
  dscrCombined: ['DSCR Based on Underwritten NOI / NCF'],
  dyMode: 'combined',
  uwDebtYieldNoi: [],
  uwDebtYieldNcf: [],
  dyCombined: ['Debt Yield Based on Underwritten NOI / NCF'],
  propertyType: ['Property Type'],
  specificPropertyType: [],          // CGCMT uses a single "Property Type" cell
  tenantTableAnchor: [/Ten Largest Owned Tenants/i, /Largest Owned Tenants/i, /Major Tenants/i],
  // CGCMT typo tolerance: the Ascentia MHC Portfolio page literally has
  // "Mor tgaged Property Information" (space inside "Mortgaged").
  pageSignatures: [/Mor\s*tgaged Property Information\b/],
};

/* ============================================================================
 * BODY PAGE LOCATOR — find the description page for a given property
 *
 * Both shelves use the same pattern: the property name appears in ALL
 * CAPS 2-3 times consecutively (page-break repetition), close to a
 * shelf-specific page-information signature phrase. The locator scans
 * uppercase occurrences and picks the first one whose 600-char window
 * matches any of the shelf's page signatures.
 * ========================================================================== */

export function findBodyPageOffset(
  stripped: string,
  propertyName: string,
  catalog: LabelCatalog,
): number {
  const upper = propertyName.toUpperCase();
  let cursor = 0;
  for (let i = 0; i < 40; i++) {
    const at = stripped.indexOf(upper, cursor);
    if (at < 0) break;
    const window = stripped.slice(at, at + 600);
    for (const sig of catalog.pageSignatures) {
      if (sig.test(window)) return at;
    }
    cursor = at + upper.length;
  }
  return -1;
}

/* ============================================================================
 * GENERIC FIELD GRABBERS — one regex builder, per-shelf catalog drives it.
 *
 * Allow optional "(<footnote>)" runs between label and value. Pari-passu
 * and mezz loans on CGCMT use these heavily; WFRBS also uses them
 * ("Cut-off Date Principal Balance (1) : $155,000,000").
 * ========================================================================== */

const FOOTNOTE_GAP = '(?:\\s*\\([\\d,)( ]+\\))*\\s*:?\\s*';

function escapeRegex(s: string): string {
  // Allow pre-escaped regex syntax (e.g., \\( for literal parens in labels);
  // detect by presence of backslashes already in the label.
  return /\\/.test(s) ? s : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tryLabels(slice: string, labels: readonly string[], suffixRe: string): RegExpMatchArray | null {
  for (const label of labels) {
    const re = new RegExp(escapeRegex(label) + FOOTNOTE_GAP + suffixRe);
    const m = slice.match(re);
    if (m) return m;
  }
  return null;
}

function grabMoney(slice: string, labels: readonly string[]): number | null {
  const m = tryLabels(slice, labels, '\\$\\s*([\\d,]+)');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function grabPct(slice: string, labels: readonly string[]): number | null {
  const m = tryLabels(slice, labels, '([\\d.]+)\\s*%');
  return m ? Number(m[1]) / 100 : null;
}
function grabDscrX(slice: string, labels: readonly string[]): number | null {
  const m = tryLabels(slice, labels, '([\\d.]+)\\s*x');
  return m ? Number(m[1]) : null;
}
function grabDualX(slice: string, labels: readonly string[]): [number | null, number | null] {
  const m = tryLabels(slice, labels, '([\\d.]+)\\s*x\\s*/\\s*([\\d.]+)\\s*x');
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}
function grabDualPct(slice: string, labels: readonly string[]): [number | null, number | null] {
  const m = tryLabels(slice, labels, '([\\d.]+)\\s*%\\s*/\\s*([\\d.]+)\\s*%');
  return m ? [Number(m[1]) / 100, Number(m[2]) / 100] : [null, null];
}
function grabDate(slice: string, labels: readonly string[]): string | null {
  // Date format: "Month DD, YYYY" or "MM/DD/YYYY". Try both.
  const m1 = tryLabels(slice, labels, '([A-Z][a-z]+\\s+\\d{1,2},\\s*\\d{4})');
  if (m1) return m1[1];
  const m2 = tryLabels(slice, labels, '(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})');
  return m2 ? m2[1] : null;
}
function grabText(slice: string, labels: readonly string[]): string | null {
  // Property Type values: 1-3 word phrases ("Office", "Mixed Use", "Manufactured
  // Housing Community"). Stop at the next label or numeric/$ token.
  const m = tryLabels(slice, labels, '([A-Z][A-Za-z][A-Za-z0-9 /\\-]{1,40}?)\\s+(?:[A-Z]{2,}|[A-Z][a-z]+\\s+[A-Z][a-z]|Original|Cut-off|Specific|Detailed|Loan|Mortgage|Property|Size|Year|Net|Number|Sponsor|Cut)');
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, ' ');
}

/* Asset-type normalization — body pages publish slightly different labels per
 * shelf ("Office CBD", "Mixed Use Retail/Office", "Manufactured Housing
 * Community"). Bucket into 9 canonical asset types so downstream loss-rate
 * analysis is consistent. */
function normalizeAssetType(raw: string | null): string | null {
  if (raw === null) return null;
  const s = raw.toLowerCase();
  if (/hospitality|hotel|lodging|inn\b|resort/.test(s)) return 'Hotel';
  if (/multifamily|garden|residential|apartment/.test(s)) return 'Multifamily';
  if (/manufactured housing|\bmhc\b|mobile home/.test(s)) return 'MHC';
  if (/self.?storage/.test(s)) return 'SelfStorage';
  if (/industrial|warehouse|distribution|flex/.test(s)) return 'Industrial';
  if (/mixed/.test(s)) return 'MixedUse';
  if (/retail|mall|shopping|outlets/.test(s)) return 'Retail';
  if (/office/.test(s)) return 'Office';
  return 'Other';
}

/* Tenant-table parse: extract per-row (% NRA, lease-expiration date) pairs.
 * Returns the top tenant's % NRA and (when maturityDate known) the share of
 * NRA whose lease expires before maturity. Status flag explains nulls.
 *
 * Single-tenant pages omit the tenant table — those records get tenantData
 * Status='single-tenant' with largestTenantPct=1.0 (100% concentration). */
interface TenantTableResult {
  largestTenantPct: number | null;
  pctIncomeExpiringWithinTerm: number | null;
  status: 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null;
}
function parseTenantTable(
  slice: string,
  catalog: LabelCatalog,
  maturityDate: string | null,
  assetType: string | null,
): TenantTableResult {
  // 1) Asset-type N/A short-circuit. These types have no tenant table by design.
  if (assetType !== null) {
    const t = assetType.toLowerCase();
    if (/hotel|hospitality|lodging|multifamily|manufactured|mhc|self.?storage/.test(t)) {
      return { largestTenantPct: null, pctIncomeExpiringWithinTerm: null, status: 'na-by-asset-type' };
    }
  }
  // 2) Locate the tenant table header
  let anchorEnd = -1;
  for (const rx of catalog.tenantTableAnchor) {
    const m = rx.exec(slice);
    if (m) { anchorEnd = m.index + m[0].length; break; }
  }
  if (anchorEnd < 0) {
    // No tenant anchor — could be single-tenant (which often skips the table)
    // OR a non-typed property whose label catalog missed. Conservative:
    // mark parse-failed; the structural test treats this as null.
    return { largestTenantPct: null, pctIncomeExpiringWithinTerm: null, status: 'parse-failed' };
  }
  // 3) Capture table body until "Total Major Tenants", "Non-Major", "Vacant",
  //    "Occupied Collateral", or 3000 chars — whichever comes first.
  const tail = slice.slice(anchorEnd, anchorEnd + 3500);
  const endRe = /(Total Major Tenants|Total\/Wtd|Total \/ Wtd|Non-Major|Non Major|Occupied Collateral|Total Owned|Remaining Owned|Vacant\b|Total Tenants|Total Premises)/i;
  const endM = endRe.exec(tail);
  const body = endM ? tail.slice(0, endM.index) : tail;
  // 4) Tenant rows: <Name (with optional credit ratings)> <SF> <%> ... <date>
  //    Heuristic: a row carries a `<num.num>%` followed within 200 chars by a
  //    valid date (M/D/YYYY or M/D/YY). Capture the % and the date.
  const rows: { pctNra: number; expiry: Date | null; raw: string }[] = [];
  const rowRe = /(\d{1,2}(?:\.\d{1,2})?)\s*%[\s\S]{0,250}?(\d{1,2}\/\d{1,2}\/\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(body)) !== null) {
    const pctNra = Number(m[1]) / 100;
    if (pctNra > 1 || pctNra <= 0) continue;  // sanity
    rows.push({ pctNra, expiry: parseUSDate(m[2]), raw: m[0] });
  }
  if (rows.length === 0) {
    return { largestTenantPct: null, pctIncomeExpiringWithinTerm: null, status: 'parse-failed' };
  }
  // 5) Top tenant share = first row's pctNra. Sanity: every row's pctNra ≤ 1.0
  //    AND the sum-of-rows ≤ 1.0 (otherwise we're picking up non-tenant percentages).
  const sum = rows.reduce((s, r) => s + r.pctNra, 0);
  if (sum > 1.05) {
    return { largestTenantPct: null, pctIncomeExpiringWithinTerm: null, status: 'parse-failed' };
  }
  const top = rows[0]!.pctNra;
  // 6) Rollover: if loan maturity known, sum pctNra for rows whose expiry < maturity.
  let pctIncomeExpiringWithinTerm: number | null = null;
  if (maturityDate !== null) {
    const matD = parseUSDate(maturityDate);
    if (matD !== null) {
      let s = 0;
      for (const r of rows) {
        if (r.expiry !== null && r.expiry < matD) s += r.pctNra;
      }
      pctIncomeExpiringWithinTerm = s;
    }
  }
  return {
    largestTenantPct: top,
    pctIncomeExpiringWithinTerm,
    status: 'multi-tenant-parsed',
  };
}
function parseUSDate(s: string): Date | null {
  const trimmed = s.trim();
  // Format A: "M/D/YYYY" or "MM/DD/YY" (tenant lease-expiration columns).
  const a = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (a) {
    let yr = Number(a[3]);
    if (yr < 100) yr += yr < 50 ? 2000 : 1900;
    const d = new Date(yr, Number(a[1]) - 1, Number(a[2]));
    return Number.isFinite(d.getTime()) ? d : null;
  }
  // Format B: "Month DD, YYYY" (Maturity Date on WFRBS/WFCM body pages —
  // e.g., "December 1, 2022"). The extractor's grabDate helper already
  // captures both formats; parseUSDate just needs to read both.
  const MONTHS: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  };
  const b = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(trimmed);
  if (b) {
    const mo = MONTHS[b[1]!.toLowerCase()];
    if (mo === undefined) return null;
    const d = new Date(Number(b[3]), mo, Number(b[2]));
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/* ============================================================================
 * EXTRACT — the generalized entrypoint
 * ========================================================================== */

export function extractFromBodyPage(
  stripped: string,
  propertyName: string,
  catalog: LabelCatalog,
  preDiscoveredOffset?: number,
): BodyPageExtract {
  // The body-page extractor's locator searches by uppercase property name +
  // page signature. Shelves like MSBAM/CSMC put the name in title case on
  // the description page itself, so the discovery pass (which finds the
  // page signature in the deal-level scan) is the more robust locator —
  // accept a pre-discovered offset to skip the locator entirely.
  const offset = preDiscoveredOffset !== undefined && preDiscoveredOffset >= 0
    ? preDiscoveredOffset
    : findBodyPageOffset(stripped, propertyName, catalog);
  if (offset < 0) return empty();
  // Description page labels are typically ABOVE the page-signature anchor
  // (signature appears mid-page in the labeled-field block). Slice a wider
  // window centered on the signature: 1500 before + 5000 after.
  const sliceStart = Math.max(0, offset - 1500);
  const slice = stripped.slice(sliceStart, offset + 5000);

  let uwDscrNoi: number | null = null, uwDscrNcf: number | null = null;
  if (catalog.dscrMode === 'separate') {
    uwDscrNoi = grabDscrX(slice, catalog.uwDscrNoi);
    uwDscrNcf = grabDscrX(slice, catalog.uwDscrNcf);
  } else {
    [uwDscrNoi, uwDscrNcf] = grabDualX(slice, catalog.dscrCombined);
  }
  let uwDyNoi: number | null = null, uwDyNcf: number | null = null;
  if (catalog.dyMode === 'separate') {
    uwDyNoi = grabPct(slice, catalog.uwDebtYieldNoi);
    uwDyNcf = grabPct(slice, catalog.uwDebtYieldNcf);
  } else {
    [uwDyNoi, uwDyNcf] = grabDualPct(slice, catalog.dyCombined);
  }

  // Asset-type from the labeled "Property Type" field. Normalize to a
  // canonical bucket so downstream loss-rate analysis is consistent.
  const propertyTypeRaw = grabText(slice, catalog.propertyType);
  const specificPropertyTypeRaw = catalog.specificPropertyType.length > 0
    ? grabText(slice, catalog.specificPropertyType)
    : null;
  const assetType = normalizeAssetType(propertyTypeRaw);
  const subType = specificPropertyTypeRaw ?? propertyTypeRaw;

  // Tenant table → concentration + rollover. The extract slice is
  // 1500 chars before + 5000 after the page signature; the tenant table
  // sits 4-10K chars further down. Use a WIDER slice for the tenant scan.
  const tenantSlice = stripped.slice(sliceStart, offset + 15_000);
  const maturityDate = grabDate(slice, catalog.maturityDate);
  const tenant = parseTenantTable(tenantSlice, catalog, maturityDate, assetType);

  return {
    loanAmount: grabMoney(slice, catalog.loanAmount),
    coupon: grabPct(slice, catalog.coupon),
    concludedValue: grabMoney(slice, catalog.concludedValue),
    concludedLtv: grabPct(slice, catalog.concludedLtv),
    uwDscrNoi, uwDscrNcf,
    uwDebtYieldNoi: uwDyNoi, uwDebtYieldNcf: uwDyNcf,
    assetType,
    subType,
    largestTenantPct: tenant.largestTenantPct,
    pctIncomeExpiringWithinTerm: tenant.pctIncomeExpiringWithinTerm,
    tenantDataStatus: tenant.status,
    uwY1Noi: grabMoney(slice, catalog.uwY1Noi),
    uwY1Ncf: grabMoney(slice, catalog.uwY1Ncf),
    t12Noi: grabMoney(slice, catalog.t12Noi),
    maturityDate: grabDate(slice, catalog.maturityDate),
    source: 'body-page',
    bodyPageOffset: sliceStart,
    shelfLabelCatalog: catalog.shelf,
  };
}

function empty(): BodyPageExtract {
  return {
    loanAmount: null, coupon: null, concludedValue: null, concludedLtv: null,
    uwDscrNoi: null, uwDscrNcf: null, uwDebtYieldNoi: null, uwDebtYieldNcf: null,
    uwY1Noi: null, uwY1Ncf: null, t12Noi: null, maturityDate: null,
    assetType: null, subType: null,
    largestTenantPct: null, pctIncomeExpiringWithinTerm: null, tenantDataStatus: null,
    source: null, bodyPageOffset: null, shelfLabelCatalog: null,
  };
}

/* ============================================================================
 * DSCR ORDER SANITY — used by the composer to assert NCF < NOI per CMBS
 * convention on every shelf, never assume.
 * ========================================================================== */
export function dscrOrderConsistent(extract: BodyPageExtract): boolean | null {
  if (extract.uwDscrNoi === null || extract.uwDscrNcf === null) return null;
  return extract.uwDscrNcf <= extract.uwDscrNoi;
}

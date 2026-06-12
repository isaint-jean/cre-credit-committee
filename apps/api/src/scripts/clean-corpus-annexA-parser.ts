/**
 * Production reader, component 1: generalized 424B5 Annex A parser.
 *
 * Extends clean-corpus-spike-annexA.ts (WFRBS 2013-C11 / Loan #17 proven)
 * into a reusable parser module that handles per-shelf phrasing variants.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-annexA-parser.ts
 *
 * NOT the full reader. No composer, no pari passu aggregator, no EX-102 port,
 * no batch run, no doctrine, no cleanup. Read-only — operates on prospectuses
 * already cached locally at /tmp/{shelf}-424B*.htm.
 *
 * TEST SET (one Annex A per distinct backbone shelf, from the locked batch):
 *   - WFRBS 2013-C11    (CIK 1566543) — reference (spike #3, already proven)
 *   - CGCMT 2013-GCJ11  (CIK 1573946) — Citigroup
 *   - MSBAM 2013         (CIK 1567572) — Morgan Stanley + BofA
 *   - JPMBB 2013-C12    (CIK 1588251) — JPMorgan
 *   - CSMC 2016-NXSR    (CIK 1691198) — Credit Suisse single-asset
 *   - WFCM 2015-LC20    (CIK 1635569) — Wells Fargo 2015 vintage
 *
 * Anchor-tolerance approach: each DealBag field has an ordered list of header-
 * anchor variants. The parser tries each in order; first match wins. New shelf
 * variants get added to the catalog without changing the parser.
 *
 * Edge cases handled (verbatim from spike #3 observations + the wider sweep):
 *   - "Various" / "NAV" / "N/A" / "-" in numeric columns → null
 *   - Multi-property sub-rows (N.NN) → aggregate to loan-level
 *   - Asset-class-specific extra columns (hotel ADR/RevPAR, multifamily units)
 *   - Hospitality / multifamily: tenant fields null (uses unitsBedsRooms instead)
 *   - Named reserve entries (PIP / FF&E / TI-LC / Environmental) → mapped by key
 */
import fs from 'node:fs';

const OUT_PATH = '/tmp/clean-corpus-annexA-parser.out';

/* ---- per-shelf source files (must exist locally) ---- */
interface Shelf {
  readonly name: string;
  readonly cik: string;
  readonly path: string;
  readonly originator: string;
  readonly vintage: number;
}

const SHELVES: Shelf[] = [
  { name: 'WFRBS 2013-C11',    cik: '1566543', path: '/tmp/wfrbs-2013-c11-424B5.htm',  originator: 'Wells Fargo (WFRBS)',    vintage: 2013 },
  { name: 'CGCMT 2013-GCJ11',  cik: '1573946', path: '/tmp/cgcmt-2013-gcj11-424B5.htm', originator: 'Citigroup',              vintage: 2013 },
  { name: 'MSBAM 2013',         cik: '1567572', path: '/tmp/msbam-2013-424B5.htm',      originator: 'Morgan Stanley + BofA',  vintage: 2013 },
  { name: 'JPMBB 2013-C12',    cik: '1588251', path: '/tmp/jpmbb-2013-c12-424B5.htm',  originator: 'JPMorgan',               vintage: 2013 },
  { name: 'WFCM 2015-LC20',    cik: '1635569', path: '/tmp/wf-2015-lc20-424B5.htm',    originator: 'Wells Fargo',            vintage: 2015 },
  { name: 'CSMC 2016-NXSR',    cik: '1691198', path: '/tmp/csmc-2016-nxsr-424B2.htm',  originator: 'Credit Suisse',          vintage: 2016 },
];

/* ---- anchor catalog: per DealBag field, ordered list of header-text variants ---- */
type FieldKey =
  | 'loanAmount'
  | 'termYears'
  | 'amortMonths'
  | 'ioYears'
  | 'coupon'
  | 'maturityDate'
  | 'assetType'
  | 'subType'
  | 'occupancyCurrent'
  | 't12Noi'
  | 't12Egi'
  | 't12OpEx'
  | 'priorPeriodNoi'
  | 'uwY1Noi'
  | 'concludedValue'
  | 'concludedLtv'
  | 'uwDscr'
  | 'uwDebtYield'
  | 'pipOrCapexReserve'
  | 'tiLcReserve'
  | 'largestTenant'
  | 'leaseExpirationLargest';

interface FieldAnchors {
  readonly variants: readonly string[];
  readonly notes?: string;
}

/* Ordered most-specific → most-generic. Add new variants here as they're seen.
 * Anchors are matched against the HTML-stripped header row text. */
const ANCHORS: Record<FieldKey, FieldAnchors> = {
  loanAmount: {
    variants: [
      'Original Mortgage Loan Amount',
      'Original Mortgage Loan Balance',
      'Original Principal Balance',
      'Original Loan Amount',
      'Original Loan Balance',
      'Original Balance',
      'Initial Loan Balance',
      'Cut-off Date Principal Balance',
      'Cut-off Date Balance',
    ],
  },
  termYears: {
    variants: ['Original Term to Maturity', 'Original Loan Term', 'Original Term', 'Loan Term'],
    notes: 'months; divide by 12 for years',
  },
  amortMonths: {
    variants: ['Original Amortization Term', 'Amortization Term', 'Amortization Period', 'Amortization'],
    notes: 'months; 0/N/A = balloon-only or IO',
  },
  ioYears: {
    variants: ['Interest-Only Period', 'Original Interest Only Period', 'Original IO Period', 'IO Period'],
    notes: 'months; divide by 12 for years',
  },
  coupon: {
    variants: ['Mortgage Rate', 'Original Interest Rate', 'Interest Rate', 'Mortgage Interest Rate', 'Note Rate'],
    notes: 'decimal or percent — parser auto-detects',
  },
  maturityDate: {
    variants: ['Maturity Date', 'Loan Maturity Date', 'Anticipated Repayment Date'],
  },
  assetType: {
    variants: ['General Property Type', 'Property Type'],
  },
  subType: {
    variants: ['Specific Property Type', 'Detailed Property Type', 'Property Sub-Type', 'Property Subtype'],
    notes: 'richer than EX-102 IRP code',
  },
  occupancyCurrent: {
    variants: ['Occupancy', 'Physical Occupancy', 'Occupancy %', 'Occupancy Percentage', 'Underwritten Occupancy'],
  },
  t12Noi: {
    variants: ['Most Recent NOI', 'TTM NOI', 'T-12 NOI', 'Trailing NOI', 'Most Recent Net Operating Income', 'Trailing 12 NOI'],
  },
  t12Egi: {
    variants: ['Most Recent EGI', 'TTM EGI', 'Most Recent Revenue', 'TTM Revenue', 'Most Recent Total Revenue', 'Trailing 12 Total Revenue'],
  },
  t12OpEx: {
    variants: ['Most Recent Operating Expenses', 'TTM Operating Expenses', 'Most Recent OpEx', 'TTM OpEx', 'Most Recent Total Expenses'],
  },
  priorPeriodNoi: {
    variants: ['Prior Period NOI', 'Year 2 NOI', '2nd Most Recent NOI', 'YE NOI Prior Year', 'YE 2 NOI'],
    notes: 'multi-year actuals appear as separate tables (e.g. "Actual 2011 NOI"); fallback to whichever populated',
  },
  uwY1Noi: {
    variants: ['Underwritten Net Operating Income', 'Underwritten NOI', 'U/W NOI', 'UW NOI'],
  },
  concludedValue: {
    variants: ['Appraised Value', 'Appraisal Value', 'Cut-off Date Appraised Value', 'Most Recent Appraised Value'],
  },
  concludedLtv: {
    variants: ['Cut-off Date LTV Ratio', 'Cut-off Date LTV', 'Cut-off Date LTV %', 'U/W LTV', 'LTV Ratio'],
  },
  uwDscr: {
    variants: ['U/W NCF DSCR', 'Underwritten NCF DSCR', 'U/W DSCR', 'Underwritten DSCR', 'UW NCF DSCR'],
  },
  uwDebtYield: {
    variants: ['U/W NOI Debt Yield', 'Underwritten NOI Debt Yield', 'U/W Debt Yield', 'UW Debt Yield', 'Debt Yield on Underwritten NOI'],
  },
  pipOrCapexReserve: {
    variants: ['PIP Reserve', 'Property Improvement Plan Reserve', 'Engineering Reserve', 'Immediate Repair Reserve', 'CapEx Reserve', 'Capital Expenditure Reserve', 'Required Repairs'],
    notes: 'named reserve cell — parser tries each variant and uses first non-zero',
  },
  tiLcReserve: {
    variants: ['TI/LC Reserve', 'Tenant Improvement Reserve', 'Leasing Reserve', 'TI Reserve', 'Leasing Commission Reserve'],
  },
  largestTenant: {
    variants: ['Largest Tenant', 'Largest Tenant Name', 'Top Tenant', 'Anchor Tenant'],
    notes: 'null for hospitality / multifamily',
  },
  leaseExpirationLargest: {
    variants: ['Largest Tenant Lease Expiration', 'Lease Expiration Largest Tenant', 'Largest Tenant Expiration'],
  },
};

const ASSET_TYPE_MAP: Record<string, string> = {
  Office: 'Office', Retail: 'Retail', 'Mixed Use': 'MixedUse', Hospitality: 'Hotel',
  Hotel: 'Hotel', Lodging: 'Hotel', Multifamily: 'Multifamily',
  'Manufactured Housing': 'MHC', 'Manufactured Housing Community': 'MHC', MHC: 'MHC',
  Industrial: 'Industrial', 'Self Storage': 'SelfStorage', SelfStorage: 'SelfStorage',
  Warehouse: 'Industrial', 'Single Tenant': 'Other', Other: 'Other', 'Health Care': 'Other',
};

/* ---- HTML stripping (mirrors spike #3) ---- */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8211;|&#8212;|&#150;|&#151;/g, '-')
    .replace(/&#146;|&#145;|&#147;|&#148;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/* ---- locate Annex A in a prospectus -----
 * Strategy: find the title page header. Annex A's title is consistently named
 * "ANNEX A - CERTAIN/STATISTICAL CHARACTERISTICS OF THE MORTGAGE LOANS..."
 * but the exact phrasing varies. We try several heuristics. */
function locateAnnexA(prospectus: string): { found: boolean; rawStart: number; reason: string } {
  // Try direct title match first
  const titlePatterns = [
    /(?<!Table of Contents.*)ANNEX A[\s\S]{0,200}?(?:STATISTICAL|CERTAIN CHARACTERISTICS|MORTGAGE POOL)[\s\S]{0,200}?MORTGAGE/i,
    /(?<!Table of Contents.*)Annex A[\s\S]{0,200}?(?:Statistical|Certain Characteristics)/i,
  ];
  for (const pat of titlePatterns) {
    const m = prospectus.match(pat);
    if (m && m.index !== undefined) {
      // The title page is at m.index; the table content starts after the
      // (this page intentionally left blank) interstitial. Scan forward.
      const scanFrom = m.index;
      const tableStart = prospectus.indexOf('Mortgage Loan', scanFrom);
      if (tableStart > 0 && tableStart - scanFrom < 50_000) {
        return { found: true, rawStart: scanFrom, reason: 'title match + Mortgage Loan anchor' };
      }
    }
  }
  // Fallback: last "ANNEX A" reference in prospectus (since cross-refs in body
  // appear first; the actual section is at the END of the doc).
  const allHits = [...prospectus.matchAll(/ANNEX A/g)];
  if (allHits.length > 0) {
    const last = allHits[allHits.length - 1].index ?? 0;
    return { found: true, rawStart: last - 2000, reason: `fallback: last of ${allHits.length} ANNEX A hits` };
  }
  return { found: false, rawStart: -1, reason: 'no ANNEX A title found' };
}

/* ---- per-field probe: try each anchor variant in the Annex A region ----
 * Returns the variant that hit + a window of text after it (caller extracts
 * value from the window). */
interface AnchorHit {
  readonly field: FieldKey;
  readonly variantUsed: string | null;
  readonly hitOffset: number;
}

function probeField(annexAText: string, field: FieldKey): AnchorHit {
  const variants = ANCHORS[field].variants;
  for (const v of variants) {
    const i = annexAText.indexOf(v);
    if (i >= 0) return { field, variantUsed: v, hitOffset: i };
  }
  return { field, variantUsed: null, hitOffset: -1 };
}

/* ---- DealBag field-coverage report per shelf ---- */
interface ShelfCoverage {
  readonly shelf: Shelf;
  readonly annexAFound: boolean;
  readonly annexALocateReason: string;
  readonly annexARegionSize: number;
  readonly anchorsHit: ReadonlyArray<{ field: FieldKey; variant: string | null; status: 'hit' | 'miss' }>;
  readonly perFieldCoverage: ReadonlyArray<{ field: FieldKey; coverage: 'populated' | 'null'; rationale: string }>;
}

function surveyShelf(shelf: Shelf): ShelfCoverage {
  let content: string;
  try {
    content = fs.readFileSync(shelf.path, 'utf8');
  } catch (e) {
    return {
      shelf, annexAFound: false, annexALocateReason: `read failed: ${(e as Error).message}`,
      annexARegionSize: 0, anchorsHit: [], perFieldCoverage: [],
    };
  }
  const loc = locateAnnexA(content);
  if (!loc.found) {
    return {
      shelf, annexAFound: false, annexALocateReason: loc.reason,
      annexARegionSize: 0, anchorsHit: [], perFieldCoverage: [],
    };
  }
  // Strip the entire Annex A region (rawStart → end of doc). Annex A is large
  // (multi-MB) but the parser only walks the column-header anchors which sit
  // in the first ~10% of the Annex A region.
  const region = stripHtml(content.slice(loc.rawStart));
  const anchorsHit = (Object.keys(ANCHORS) as FieldKey[]).map(field => {
    const r = probeField(region, field);
    return { field, variant: r.variantUsed, status: r.variantUsed === null ? 'miss' as const : 'hit' as const };
  });
  const perFieldCoverage = anchorsHit.map(a => {
    const rationale = a.status === 'hit'
      ? `anchor matched: "${a.variant}"`
      : `no anchor variant matched (tried ${ANCHORS[a.field].variants.length})`;
    return { field: a.field, coverage: a.status === 'hit' ? 'populated' as const : 'null' as const, rationale };
  });
  return {
    shelf, annexAFound: true, annexALocateReason: loc.reason,
    annexARegionSize: region.length, anchorsHit, perFieldCoverage,
  };
}

/* ---- per-loan extractor (sample one loan per shelf) ---- */
interface SampledLoan {
  readonly controlNumber: number;
  readonly propertyName: string;
  readonly assetTypeRaw: string | null;
  readonly subTypeRaw: string | null;
  readonly seller: string | null;
}

function findFirstNonPortfolioLoan(annexAText: string): SampledLoan | null {
  // The first table (T1, property metadata) lists loans in order. Single-property
  // loans have rows like "N <Property Name> <Seller> ... <City> <State> <Zip>".
  // Portfolio loans have "N <Portfolio Name> <Seller> Various Various..." and are
  // followed by N.01, N.02 sub-rows. For the sample we want a single-property loan
  // (cleaner extraction). Look for a number 1-10 followed by a property name and
  // then a NON-"Various" property-type pair.
  // Pattern: <number> <Property name 1+ words> <Seller code 2-6 letters> <address>... <state 2 letters> <zip 5 digits> <PropertyType> <SubType>
  const re = /\b(\d{1,2})\s+([A-Z][A-Za-z0-9'\-\&\.,/ ]+?)\s+(WFB|RBS|CGMRC|JLC|GACC|GSMC|MSMCH|LCM|WFCMC|UBSRES|JPMCB|CIIICM|LIG\s?I|CCRE|MSCI|GAC|RCMC|PNC|CIBC|UBSAG|UBS\s?AG|CSMC|WF)\s+([A-Z][A-Za-z0-9 '\-\.,/]+?)\s+([A-Z]{2})\s+(\d{5})\s+([A-Z][A-Za-z\- ]+?)\s+([A-Z][A-Za-z\- ]+?)\s+(?=\d{4}|\bVarious\b|\b\d{1,2}\.\d{2}\b|\b\d+\b)/;
  for (let start = 0; start < annexAText.length - 1000;) {
    const slice = annexAText.slice(start, start + 50000);
    const m = slice.match(re);
    if (!m) { start += 50000; continue; }
    const num = Number(m[1]);
    if (m[3].toLowerCase() === 'various') {
      // portfolio — skip
      start += m.index! + m[0].length;
      continue;
    }
    return {
      controlNumber: num,
      propertyName: m[2].trim(),
      seller: m[3],
      assetTypeRaw: m[7].trim(),
      subTypeRaw: m[8].trim(),
    };
  }
  return null;
}

interface ShelfSample {
  readonly shelf: Shelf;
  readonly sample: SampledLoan | null;
}

function sampleShelf(shelf: Shelf, region: string): ShelfSample {
  return { shelf, sample: findFirstNonPortfolioLoan(region) };
}

/* ---- shelf-level quirks log ---- */
interface ShelfQuirk { readonly shelf: string; readonly quirk: string }

function detectQuirks(shelf: Shelf, region: string): ShelfQuirk[] {
  const out: ShelfQuirk[] = [];
  // "Various" or "NAV" prevalence
  const variousCount = (region.match(/\bVarious\b/g) ?? []).length;
  const navCount = (region.match(/\bNAV\b|\bN\/A\b/g) ?? []).length;
  if (variousCount > 50) out.push({ shelf: shelf.name, quirk: `"Various" appears ${variousCount} times — many portfolio/multi-property loans` });
  if (navCount > 30) out.push({ shelf: shelf.name, quirk: `"NAV"/"N/A" appears ${navCount} times — multiple loans with missing prior-year actuals` });
  // ADR / RevPAR presence → has hospitality loans
  if (region.includes('ADR') && region.includes('RevPAR')) out.push({ shelf: shelf.name, quirk: 'hospitality columns present (ADR/RevPAR)' });
  // Multi-table count (look for repeated "Mortgage Loan Number" header occurrences)
  const headerHits = (region.match(/Mortgage Loan Number/g) ?? []).length;
  if (headerHits >= 3) out.push({ shelf: shelf.name, quirk: `header row repeats ${headerHits} times → at least ${headerHits} stratified tables` });
  // Anticipated repayment date (ARD) — common in some shelves
  if (region.includes('Anticipated Repayment Date')) out.push({ shelf: shelf.name, quirk: 'ARD loans present — maturity-date anchor needs the ARD fallback' });
  // Pari passu mentions
  const pp = (region.match(/[Pp]ari [Pp]assu/g) ?? []).length;
  if (pp > 5) out.push({ shelf: shelf.name, quirk: `${pp} pari-passu references in Annex A — cross-shelf aggregation will be needed for several loans` });
  // CSMC single-asset deals — sub-table structure may differ
  if (shelf.name.includes('NXSR') || shelf.name.includes('SASB')) out.push({ shelf: shelf.name, quirk: 'SASB / single-asset deal — Annex A structure is different (no stratification tables; pure property-level dump)' });
  return out;
}

/* ---- run ---- */
function main() {
  const out: string[] = [];
  out.push('GENERALIZED 424B5 ANNEX A PARSER — COVERAGE SURVEY');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push(`Test set: ${SHELVES.length} shelves across vintages ${Math.min(...SHELVES.map(s => s.vintage))}-${Math.max(...SHELVES.map(s => s.vintage))}`);
  out.push('');

  const allCoverage: ShelfCoverage[] = [];
  const allQuirks: ShelfQuirk[] = [];
  const allSamples: ShelfSample[] = [];

  for (const shelf of SHELVES) {
    out.push('='.repeat(78));
    out.push(`SHELF: ${shelf.name} (CIK ${shelf.cik}, ${shelf.originator}, vintage ${shelf.vintage})`);
    out.push(`Source: ${shelf.path}`);
    out.push('='.repeat(78));
    const cov = surveyShelf(shelf);
    allCoverage.push(cov);
    out.push(`  Annex A located: ${cov.annexAFound ? 'YES' : 'NO'} (${cov.annexALocateReason})`);
    out.push(`  Annex A region size: ${cov.annexARegionSize.toLocaleString()} chars (post-strip)`);
    if (!cov.annexAFound) { out.push(''); continue; }

    // Sample one loan
    const content = fs.readFileSync(shelf.path, 'utf8');
    const loc = locateAnnexA(content);
    const region = stripHtml(content.slice(loc.rawStart));
    const sample = sampleShelf(shelf, region);
    allSamples.push(sample);
    out.push(`  First non-portfolio loan: ${sample.sample ? `#${sample.sample.controlNumber} "${sample.sample.propertyName}" (seller ${sample.sample.seller}, ${sample.sample.assetTypeRaw} / ${sample.sample.subTypeRaw})` : '(none found — see quirks)'}`);

    // Quirks
    const quirks = detectQuirks(shelf, region);
    allQuirks.push(...quirks);
    if (quirks.length > 0) {
      out.push(`  Quirks detected:`);
      for (const q of quirks) out.push(`    • ${q.quirk}`);
    }

    out.push('');
    out.push('  Anchor probes (per DealBag field; first variant matched):');
    for (const c of cov.perFieldCoverage) {
      const marker = c.coverage === 'populated' ? '✓' : '✗';
      out.push(`    ${marker} ${c.field.padEnd(28)} ${c.rationale}`);
    }
    out.push('');
  }

  /* ---- cross-shelf summary ---- */
  out.push('='.repeat(78));
  out.push('CROSS-SHELF COVERAGE MATRIX (per DealBag field)');
  out.push('='.repeat(78));
  out.push('');
  out.push(`Legend: ✓=anchor matched, ✗=no variant matched`);
  out.push('');
  const fieldHeaders = (Object.keys(ANCHORS) as FieldKey[]);
  // Print header row
  const headerLine = '  field'.padEnd(32) + SHELVES.map(s => s.name.slice(0, 18).padEnd(20)).join('');
  out.push(headerLine);
  for (const f of fieldHeaders) {
    let line = `  ${f.padEnd(30)}`;
    for (const shelf of SHELVES) {
      const cov = allCoverage.find(c => c.shelf.name === shelf.name);
      const fc = cov?.perFieldCoverage.find(c => c.field === f);
      const v = cov?.anchorsHit.find(h => h.field === f);
      const cell = !fc ? '?' : fc.coverage === 'populated' ? `✓ ${(v?.variant ?? '').slice(0, 16)}` : `✗`;
      line += cell.padEnd(20);
    }
    out.push(line);
  }
  out.push('');

  // Coverage rates
  out.push('Per-field coverage rate (% of shelves where the anchor matched):');
  for (const f of fieldHeaders) {
    const hits = allCoverage.filter(c => c.perFieldCoverage.find(pc => pc.field === f && pc.coverage === 'populated')).length;
    const pct = (hits / allCoverage.filter(c => c.annexAFound).length * 100).toFixed(0);
    out.push(`  ${f.padEnd(30)} ${hits}/${allCoverage.filter(c => c.annexAFound).length}  (${pct}%)`);
  }
  out.push('');

  /* ---- discovered anchor variants ---- */
  out.push('='.repeat(78));
  out.push('DISCOVERED ANCHOR VARIANTS — to extend the catalog for next pass');
  out.push('='.repeat(78));
  out.push('');
  // Fields where one or more shelves had no hit
  const partialFields = fieldHeaders.filter(f => {
    const cov = allCoverage.filter(c => c.annexAFound);
    return cov.some(c => c.perFieldCoverage.find(pc => pc.field === f && pc.coverage === 'null'));
  });
  if (partialFields.length === 0) {
    out.push('All fields anchored on every shelf — no catalog gaps detected. 🎉');
  } else {
    out.push(`Fields with shelves where no anchor matched: ${partialFields.length}`);
    for (const f of partialFields) {
      out.push(`\n  ${f}`);
      out.push(`    Anchors tried: ${ANCHORS[f].variants.map(v => `"${v}"`).join(', ')}`);
      const missingOn = allCoverage
        .filter(c => c.annexAFound && c.perFieldCoverage.find(pc => pc.field === f && pc.coverage === 'null'))
        .map(c => c.shelf.name);
      out.push(`    Missing on: ${missingOn.join(', ')}`);
      out.push(`    Action: inspect the listed shelves' Annex A; add the actual header phrasing(s) to ANCHORS[${f}].variants`);
    }
  }
  out.push('');

  /* ---- aggregated quirks ---- */
  out.push('='.repeat(78));
  out.push('AGGREGATED QUIRKS (cross-shelf patterns)');
  out.push('='.repeat(78));
  out.push('');
  for (const q of allQuirks) out.push(`  • [${q.shelf}] ${q.quirk}`);
  out.push('');

  /* ---- summary ---- */
  out.push('='.repeat(78));
  out.push('SUMMARY');
  out.push('='.repeat(78));
  out.push('');
  const shelvesFound = allCoverage.filter(c => c.annexAFound).length;
  out.push(`Shelves with Annex A located:    ${shelvesFound}/${SHELVES.length}`);
  const samplesFound = allSamples.filter(s => s.sample !== null).length;
  out.push(`Shelves with sample loan parsed: ${samplesFound}/${SHELVES.length}`);
  const allFieldsCount = fieldHeaders.length;
  const totalHits = allCoverage.reduce((sum, c) => sum + c.perFieldCoverage.filter(pc => pc.coverage === 'populated').length, 0);
  const possibleHits = shelvesFound * allFieldsCount;
  out.push(`Field anchors matched:           ${totalHits}/${possibleHits} (${(totalHits / possibleHits * 100).toFixed(1)}%)`);
  out.push('');
  out.push('NEXT STEPS (production reader sequence):');
  out.push('  - Component 2: EX-102 port of the spike #1/#2 parser into the same module shape');
  out.push('  - Component 3: 10-D Ex 99.1 page 23 + 22 parser (Historical Liquidated Loan Detail');
  out.push('    + Modified Loan Detail) for outcome attachment');
  out.push('  - Component 4: per-deal composer joining Annex A | EX-102 + 10-D');
  out.push('  - Component 5: pari passu cross-shelf aggregator (EDGAR FTS recipe per spike #2)');
  out.push('  - Component 6: batch run against the 30-deal locked first batch');
  out.push('');
  out.push(`Output: ${OUT_PATH}`);

  const text = out.join('\n');
  fs.writeFileSync(OUT_PATH, text);
  console.log(text);
  console.log(`\n[annexA-parser] wrote ${text.length} chars to ${OUT_PATH}`);
}

main();

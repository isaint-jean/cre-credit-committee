/**
 * Clean-corpus scale-up step 1 — CMBS deal enumeration + data-availability survey.
 *
 * Builds the target corpus MANIFEST: which CMBS deals we'll build the answer-
 * key from, tagged by vintage / asset-type / data-availability / realized-loss
 * presence. We pick the final composition FROM the manifest; the production
 * reader build happens AFTER.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-enumerate.ts
 *
 * No reader build, no doctrine run, no production-code edits, no repo cleanup.
 * Read-only / additive (writes to /tmp).
 *
 * The ABS-EE boundary (~Nov 2016, Reg AB II Phase 2):
 *   POST: full machine-readable EX-102 + monthly EX-103 + 10-D Ex 99.1. Easiest.
 *   PRE:  origination data in 424B5 Annex A (PDF/HTM, no machine-readable XML);
 *         later-life performance in 10-D (and ABS-EE for the post-2016 tail of
 *         a deal's lifetime). True ground-truth realized losses live in 10-D
 *         page 23 ("Historical Liquidated Loan Detail") for resolved deals.
 *
 * Strategy:
 *   1. Enumerate ABS-EE issuers (post-2016 CMBS trusts) via EDGAR FTS.
 *   2. Sample pre-2016 vintages (2013-2015) via EDGAR company browse for
 *      "Commercial Mortgage Trust" filers.
 *   3. For each candidate deal: pull manifest metadata (CIK, vintage, latest
 *      ABS-EE accession, latest 10-D accession), check whether the 10-D's
 *      page 23 "Historical Liquidated Loan Detail" carries booked realized
 *      losses (not just the schema).
 *   4. Aggregate into a vintage × asset-type × realized-loss cohort summary.
 *
 * EDGAR rate-limit etiquette: SEC publishes a guideline of 10 req/sec per IP.
 * This script sleeps 200ms between hits = 5 req/sec. Safe.
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'CRE-Credit-Committee Research isaint-jean@mapaon.com';
const OUT_DIR = '/tmp/cmbs-survey';
const MANIFEST_PATH = '/tmp/cmbs-corpus-manifest.json';
const SUMMARY_PATH = '/tmp/cmbs-corpus-summary.out';

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ----- fetch w/ cache + politeness ----- */
async function get(url: string, cacheFile?: string): Promise<string> {
  if (cacheFile && fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');
  await new Promise(r => setTimeout(r, 200)); // 5 req/sec — SEC-friendly
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
  const text = await resp.text();
  if (cacheFile) fs.writeFileSync(cacheFile, text);
  return text;
}

/* ----- EDGAR FTS enumerator ----- */
async function ftsEnumerate(query: string, forms: string, startdt: string, enddt: string): Promise<any[]> {
  // FTS returns max 100 hits/page; paginate via `from=`.
  const allHits: any[] = [];
  for (let from = 0; from < 1000; from += 100) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=${forms}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}`;
    const cacheFile = path.join(OUT_DIR, `fts_${query.replace(/[^a-z0-9]/gi, '_')}_${forms}_${startdt}_${enddt}_from${from}.json`);
    let json: any;
    try {
      json = JSON.parse(await get(url, cacheFile));
    } catch {
      try { fs.unlinkSync(cacheFile); } catch {}
      break;
    }
    const hits = json?.hits?.hits ?? [];
    if (hits.length === 0) break;
    allHits.push(...hits);
    const total = json?.hits?.total?.value ?? 0;
    if (allHits.length >= total) break;
  }
  return allHits;
}

interface Issuer {
  readonly cik: string;
  readonly name: string;
  readonly firstSeen: string;     // earliest filing date in scope
  readonly lastSeen: string;      // latest filing date in scope
  readonly absEeCount: number;
}

/* Per-year ABS-EE enumeration — aggregates filings by issuer CIK. */
async function enumerateYearAbsEe(year: number): Promise<Issuer[]> {
  // Split year into halves to dodge the FTS "Internal server error" we hit
  // on year-wide queries in mid-2017.
  const halves: Array<{ a: string; b: string }> = [
    { a: `${year}-01-01`, b: `${year}-06-30` },
    { a: `${year}-07-01`, b: `${year}-12-31` },
  ];
  const byCik = new Map<string, { name: string; first: string; last: string; count: number }>();
  for (const h of halves) {
    let hits: any[] = [];
    try { hits = await ftsEnumerate('"Mortgage Trust"', 'ABS-EE', h.a, h.b); }
    catch { continue; }
    for (const hit of hits) {
      const src = hit._source ?? {};
      const cik = (src.ciks?.[0] ?? '').padStart(10, '0');
      const name = src.display_names?.[0] ?? '';
      const date = src.file_date ?? '';
      if (!cik || !name) continue;
      const prev = byCik.get(cik);
      if (!prev) byCik.set(cik, { name, first: date, last: date, count: 1 });
      else {
        prev.count++;
        if (date < prev.first) prev.first = date;
        if (date > prev.last) prev.last = date;
      }
    }
  }
  return [...byCik.entries()].map(([cik, v]) => ({
    cik, name: v.name, firstSeen: v.first, lastSeen: v.last, absEeCount: v.count,
  }));
}

/* ----- vintage extraction from issuer name ----- */
function extractVintageFromName(name: string): number | null {
  // CMBS shelf naming: "BANK 2018-BNK11", "COMM 2018-COR3", "BMARK 2019-V12",
  // "Citigroup Commercial Mortgage Trust 2017-P7", "Wells Fargo Commercial
  // Mortgage Trust 2018-C44", "DBJPM 2017-C6 Mortgage Trust", etc.
  // First 4-digit year > 2010 is typically the vintage.
  const m = name.match(/(20\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 2010 && y <= 2030 ? y : null;
}

/* ----- per-deal survey ----- */
interface DealSurvey {
  readonly cik: string;
  readonly name: string;
  readonly vintageInferred: number | null;
  readonly absEeLatest: string | null;     // accession of latest ABS-EE
  readonly tenDLatest: string | null;      // accession of latest 10-D
  readonly fourTwoBLatest: string | null;  // accession of latest 424B
  readonly absEeLatestFileDate: string | null;
  readonly tenDLatestFileDate: string | null;
  readonly inferredAssetTypes: readonly string[]; // dominant types from EX-102 propertyTypeCode
  readonly assetCount: number | null;              // assets in latest EX-102
  readonly hasRealizedLossPopulated: boolean | null; // 10-D page 23 — null when not checked
  readonly notes: readonly string[];
}

async function fetchFilingIndex(cik: string, form: string, count = 5): Promise<Array<{ accession: string; filingDate: string }>> {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=${count}&output=atom`;
  const cacheFile = path.join(OUT_DIR, `idx_${cik}_${form}.xml`);
  let xml: string;
  try { xml = await get(url, cacheFile); } catch { return []; }
  // atom format: each <entry> has <link href> + <updated>
  const out: Array<{ accession: string; filingDate: string }> = [];
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const e of entries) {
    const href = e.match(/href="([^"]+)"/)?.[1] ?? '';
    const date = e.match(/<updated>([^<]+)<\/updated>/)?.[1]?.slice(0, 10) ?? '';
    const accMatch = href.match(/(\d{10}-\d{2}-\d{6})/) ?? href.match(/(\d{18})/);
    const accession = accMatch?.[1] ?? '';
    if (accession) out.push({ accession, filingDate: date });
  }
  return out;
}

/* Quick check: does 10-D Ex 99.1 page 23 carry any realized-loss rows, or
 * "No liquidated loans this period"? We fetch the 10-D's accession directory,
 * find the Ex 99.1 htm, and string-scan for the page 23 status. */
async function probe10DRealizedLoss(cik: string, accession: string): Promise<boolean | null> {
  const accNoDashes = accession.replace(/-/g, '');
  const dirUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDashes}/`;
  const dirCache = path.join(OUT_DIR, `10D_${cik}_${accNoDashes}_dir.html`);
  let dirHtml: string;
  try { dirHtml = await get(dirUrl, dirCache); } catch { return null; }
  // Find the ex991 htm (the distribution report)
  const m = dirHtml.match(/href="([^"]+ex991[^"]+\.htm)"/i)
        ?? dirHtml.match(/href="([^"]+ex991[^"]+)"/i)
        ?? dirHtml.match(/href="([^"]+_10d-\d+\.htm)"/i);
  if (!m) return null;
  const ex991Path = m[1].startsWith('/') ? `https://www.sec.gov${m[1]}` : `${dirUrl}${m[1].split('/').pop()}`;
  const ex991Cache = path.join(OUT_DIR, `10D_${cik}_${accNoDashes}_ex991.htm`);
  let html: string;
  try { html = await get(ex991Path, ex991Cache); } catch { return null; }
  // Strip HTML; scan for the page 23 zone
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  // Look for the Historical Liquidated Loan Detail header
  const idx = text.indexOf('Historical Liquidated Loan Detail');
  if (idx < 0) return null;
  // Look from there in a ~2000-char window for the "No liquidated loans" sentinel
  const window = text.slice(idx, idx + 4000);
  // The TOC has "Historical Liquidated Loan Detail" too — find the body
  // version (page header). Look for "Page 23" or "Page 24" near the second hit.
  const bodyIdx = text.indexOf('Historical Liquidated Loan Detail', idx + 100);
  const bodyWindow = bodyIdx > 0 ? text.slice(bodyIdx, bodyIdx + 4000) : window;
  if (/No liquidated loans this period/i.test(bodyWindow)) return false;
  // If the body has dollar amounts following the table headers, treat as populated.
  // Heuristic: at least 5 numeric tokens with comma separators in the body window
  // AFTER the column header row.
  const tableArea = bodyWindow.slice(0, 4000);
  // Look for typical realized-loss column values (8+ digit dollar figures)
  const moneyMatches = (tableArea.match(/\$?\s?\d{1,3}(?:,\d{3})+/g) ?? []).length;
  if (moneyMatches >= 10) return true;
  return false;
}

async function fetchPropertyTypesFromAbsEe(cik: string, accession: string): Promise<{ types: string[]; count: number } | null> {
  const accNoDashes = accession.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDashes}/exh_102.xml`;
  const cache = path.join(OUT_DIR, `ee_${cik}_${accNoDashes}_ex102.xml`);
  let xml: string;
  try { xml = await get(url, cache); } catch { return null; }
  const codes = xml.match(/<propertyTypeCode>([^<]+)<\/propertyTypeCode>/g) ?? [];
  const types = codes.map(c => c.replace(/<\/?propertyTypeCode>/g, '').trim());
  return { types, count: (xml.match(/<assetNumber>/g) ?? []).length };
}

function summarizePropertyTypes(types: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.map(([code, n]) => `${code}(${n})`);
}

async function surveyDeal(cik: string, name: string): Promise<DealSurvey> {
  const vintage = extractVintageFromName(name);
  const notes: string[] = [];
  const absEe = await fetchFilingIndex(cik, 'ABS-EE', 1);
  const tenD = await fetchFilingIndex(cik, '10-D', 1);
  const fourB = await fetchFilingIndex(cik, '424B5', 1);
  let assetTypes: string[] = [];
  let assetCount: number | null = null;
  let hasRealizedLoss: boolean | null = null;
  if (absEe.length > 0) {
    const r = await fetchPropertyTypesFromAbsEe(cik, absEe[0].accession);
    if (r) { assetTypes = summarizePropertyTypes(r.types); assetCount = r.count; }
    else notes.push('ABS-EE present but EX-102 not extractable');
  }
  if (tenD.length > 0) {
    hasRealizedLoss = await probe10DRealizedLoss(cik, tenD[0].accession);
    if (hasRealizedLoss === null) notes.push('10-D Ex 99.1 page 23 not parseable');
  }
  return {
    cik, name,
    vintageInferred: vintage,
    absEeLatest: absEe[0]?.accession ?? null,
    tenDLatest: tenD[0]?.accession ?? null,
    fourTwoBLatest: fourB[0]?.accession ?? null,
    absEeLatestFileDate: absEe[0]?.filingDate ?? null,
    tenDLatestFileDate: tenD[0]?.filingDate ?? null,
    inferredAssetTypes: assetTypes,
    assetCount,
    hasRealizedLossPopulated: hasRealizedLoss,
    notes,
  };
}

/* ----- pre-2016 vintages: scan 10-D filings (CMBS trusts file 10-D monthly) ----- */
async function enumeratePre2016Vintages(startYear: number, endYear: number): Promise<Issuer[]> {
  const byCik = new Map<string, { name: string; first: string; last: string; count: number }>();
  for (let y = startYear; y <= endYear; y++) {
    const halves = [
      { a: `${y}-01-01`, b: `${y}-06-30` },
      { a: `${y}-07-01`, b: `${y}-12-31` },
    ];
    for (const h of halves) {
      let hits: any[] = [];
      try { hits = await ftsEnumerate('"Commercial Mortgage Trust"', '10-D', h.a, h.b); }
      catch { continue; }
      for (const hit of hits) {
        const src = hit._source ?? {};
        const cik = (src.ciks?.[0] ?? '').padStart(10, '0');
        const name = src.display_names?.[0] ?? '';
        const date = src.file_date ?? '';
        if (!cik || !name) continue;
        // Filter: name should contain a year token within startYear-endYear range
        const vintage = extractVintageFromName(name);
        if (vintage === null || vintage < startYear || vintage > endYear) continue;
        const prev = byCik.get(cik);
        if (!prev) byCik.set(cik, { name, first: date, last: date, count: 1 });
        else {
          prev.count++;
          if (date < prev.first) prev.first = date;
          if (date > prev.last) prev.last = date;
        }
      }
    }
  }
  return [...byCik.entries()].map(([cik, v]) => ({
    cik, name: v.name, firstSeen: v.first, lastSeen: v.last, absEeCount: v.count,
  }));
}

/* ----- IRP code → asset class label ----- */
function classCodeLabel(code: string): string {
  const m: Record<string, string> = {
    RT: 'Retail', OF: 'Office', MF: 'Multifamily', LO: 'Hotel',
    IN: 'Industrial', MH: 'MHC', SS: 'SelfStorage', MU: 'MixedUse',
    WH: 'Industrial', HC: 'HealthCare', SE: 'Securities', CH: 'CoopHousing',
    SF: 'SFR', ZZ: 'Unknown', '98': 'Other',
  };
  return m[code.toUpperCase()] ?? code;
}

/* ----- main ----- */
async function main() {
  console.log('=== Step 1: enumerate post-2016 CMBS deals via EDGAR FTS (ABS-EE) ===');
  const postCohorts = new Map<number, Issuer[]>();
  for (const y of [2016, 2017, 2018, 2019]) {
    console.log(`  enumerating ${y} ...`);
    const issuers = await enumerateYearAbsEe(y);
    // Filter to issuers whose name vintage matches the search year
    const matched = issuers.filter(i => extractVintageFromName(i.name) === y);
    postCohorts.set(y, matched);
    console.log(`    ${y}: ${issuers.length} ABS-EE filers in FTS, ${matched.length} with ${y} vintage`);
  }

  console.log('\n=== Step 2: enumerate pre-2016 CMBS trusts via 10-D FTS ===');
  const pre = await enumeratePre2016Vintages(2013, 2015);
  console.log(`  pre-2016 candidates: ${pre.length}`);

  // Combine
  const allCandidates = new Map<string, { issuer: Issuer; cohort: number }>();
  for (const [y, list] of postCohorts) for (const it of list) allCandidates.set(it.cik, { issuer: it, cohort: y });
  for (const it of pre) {
    const v = extractVintageFromName(it.name) ?? 0;
    if (!allCandidates.has(it.cik)) allCandidates.set(it.cik, { issuer: it, cohort: v });
  }
  console.log(`\nTotal unique candidates across 2013-2019: ${allCandidates.size}`);

  // SAMPLE-SURVEY per cohort. Pre-2016 cohort needs full survey (realized-loss
  // verification); post-2016 cohort can be sampled.
  console.log('\n=== Step 3: sample-survey ===');
  const surveys: DealSurvey[] = [];

  // Pre-2016: survey ALL (small set, realized-loss verification is the load-bearing
  // question)
  const preCandidates = pre.filter(p => {
    const v = extractVintageFromName(p.name);
    return v !== null && v >= 2013 && v <= 2015;
  });
  console.log(`  pre-2016 survey: ${preCandidates.length} deals (load-bearing for realized-loss verification)`);
  for (const c of preCandidates.slice(0, 30)) {
    try {
      const s = await surveyDeal(c.cik, c.name);
      surveys.push(s);
      const lossLabel = s.hasRealizedLossPopulated === true ? 'BOOKED' : s.hasRealizedLossPopulated === false ? 'empty' : '?';
      console.log(`    ${s.name.slice(0, 50).padEnd(50)} v=${s.vintageInferred} ABS-EE=${s.absEeLatestFileDate ?? '-'} 10-D=${s.tenDLatestFileDate ?? '-'} realized-loss=${lossLabel} types=${s.inferredAssetTypes.slice(0, 4).join(',')}`);
    } catch (e) { console.log(`    [skip] ${c.name}: ${(e as Error).message}`); }
  }

  // Post-2016: sample 8-12 per vintage for the cohort-summary
  for (const y of [2016, 2017, 2018, 2019]) {
    const cohort = postCohorts.get(y) ?? [];
    const sample = cohort.slice(0, 10);
    console.log(`  ${y} sample: ${sample.length} of ${cohort.length}`);
    for (const c of sample) {
      try {
        const s = await surveyDeal(c.cik, c.name);
        surveys.push(s);
        const lossLabel = s.hasRealizedLossPopulated === true ? 'BOOKED' : s.hasRealizedLossPopulated === false ? 'empty' : '?';
        console.log(`    ${s.name.slice(0, 50).padEnd(50)} v=${s.vintageInferred} 10-D=${s.tenDLatestFileDate ?? '-'} realized-loss=${lossLabel} assetCount=${s.assetCount} types=${s.inferredAssetTypes.slice(0, 4).join(',')}`);
      } catch (e) { console.log(`    [skip] ${c.name}: ${(e as Error).message}`); }
    }
  }

  // Aggregate
  const byCohort = new Map<number, DealSurvey[]>();
  for (const s of surveys) {
    const c = s.vintageInferred ?? 0;
    if (!byCohort.has(c)) byCohort.set(c, []);
    byCohort.get(c)!.push(s);
  }

  const summary: string[] = [];
  summary.push('CMBS CORPUS ENUMERATION + DATA-AVAILABILITY SURVEY');
  summary.push(`Survey timestamp: ${new Date().toISOString()}`);
  summary.push('');
  summary.push('=== ENUMERATION MECHANICS (reusable by the production reader) ===');
  summary.push('');
  summary.push('Post-2016 vintages (Reg AB II Phase 2 onwards):');
  summary.push('  EDGAR FTS: q="Mortgage Trust"&forms=ABS-EE&dateRange=custom&startdt=Y-01-01&enddt=Y-12-31');
  summary.push('  Filter by vintage in issuer name (first 20YY token); each ABS-EE filer = one CMBS trust.');
  summary.push('  Year-wide queries occasionally 500; split into H1+H2 halves to mitigate.');
  summary.push('');
  summary.push('Pre-2016 vintages:');
  summary.push('  EDGAR FTS: q="Commercial Mortgage Trust"&forms=10-D&dateRange=custom&startdt=Y-01-01&enddt=Y-12-31');
  summary.push('  Filter by vintage token in issuer name. (10-D is the monthly investor report — every');
  summary.push('  CMBS trust files them.)');
  summary.push('');
  summary.push('Per-issuer probes:');
  summary.push('  - /cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=ABS-EE&count=N&output=atom');
  summary.push('  - /cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=10-D&count=N&output=atom');
  summary.push('  - /cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=424B5&count=N&output=atom');
  summary.push('');
  summary.push('Per-deal data probes:');
  summary.push('  - EX-102: /Archives/edgar/data/{cik}/{accession-no-dashes}/exh_102.xml');
  summary.push('  - 10-D Ex 99.1 distribution report: locate via the accession dir HTML index');
  summary.push('  - Realized-loss presence: parse Ex 99.1 → find "Historical Liquidated Loan Detail"');
  summary.push('    section → check for "No liquidated loans this period" sentinel vs populated rows');
  summary.push('');
  summary.push('=== COHORT SUMMARY ===');
  summary.push('');
  for (const y of [...byCohort.keys()].sort((a, b) => a - b)) {
    const list = byCohort.get(y) ?? [];
    if (list.length === 0) continue;
    const withRealizedLoss = list.filter(s => s.hasRealizedLossPopulated === true).length;
    const withoutRealizedLoss = list.filter(s => s.hasRealizedLossPopulated === false).length;
    const unknown = list.filter(s => s.hasRealizedLossPopulated === null).length;
    const withAbsEe = list.filter(s => s.absEeLatest !== null).length;
    const allTypeCodes = list.flatMap(s => s.inferredAssetTypes).map(t => t.replace(/\(\d+\)$/, ''));
    const typeCounts = new Map<string, number>();
    for (const t of allTypeCodes) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    const dominantTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    summary.push(`${y} VINTAGE (${list.length} surveyed)`);
    summary.push(`  ABS-EE coverage:           ${withAbsEe}/${list.length}`);
    summary.push(`  10-D realized-loss BOOKED: ${withRealizedLoss}/${list.length}`);
    summary.push(`  10-D realized-loss empty:  ${withoutRealizedLoss}/${list.length}`);
    summary.push(`  10-D inconclusive:         ${unknown}/${list.length}`);
    summary.push(`  Dominant asset types:      ${dominantTypes.map(([c, n]) => `${classCodeLabel(c)}=${n}`).join(', ')}`);
    summary.push('');
  }

  summary.push('=== PER-DEAL MANIFEST (full list) ===');
  summary.push('');
  for (const s of surveys.sort((a, b) => (a.vintageInferred ?? 0) - (b.vintageInferred ?? 0))) {
    const lossLabel = s.hasRealizedLossPopulated === true ? 'BOOKED✓' : s.hasRealizedLossPopulated === false ? 'empty' : '   ?  ';
    const typeStr = s.inferredAssetTypes.slice(0, 6).join(',');
    summary.push(`  v${s.vintageInferred ?? '????'} CIK${s.cik.replace(/^0+/, '').padEnd(7)} ${s.name.slice(0, 45).padEnd(45)} ABS-EE=${(s.absEeLatestFileDate ?? '-').padEnd(10)} 10-D=${(s.tenDLatestFileDate ?? '-').padEnd(10)} realized-loss=${lossLabel} assets=${(s.assetCount ?? '-').toString().padStart(3)} types=${typeStr}`);
  }
  summary.push('');
  summary.push('=== RECOMMENDED FIRST-BATCH COMPOSITION ===');
  summary.push('');
  const booked = surveys.filter(s => s.hasRealizedLossPopulated === true);
  summary.push(`BACKBONE (booked realized losses): ${booked.length} deals available in survey`);
  for (const s of booked.slice(0, 15)) summary.push(`  v${s.vintageInferred} CIK${s.cik.replace(/^0+/, '')} ${s.name}`);
  summary.push('');
  summary.push('SUPPLEMENT (2017-2019, classified via expected-loss / in-flight distress):');
  const supplement = surveys.filter(s => (s.vintageInferred ?? 0) >= 2017 && (s.vintageInferred ?? 0) <= 2019 && s.absEeLatest !== null);
  summary.push(`  ${supplement.length} deals with ABS-EE present`);

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(surveys, null, 2));
  fs.writeFileSync(SUMMARY_PATH, summary.join('\n'));
  console.log(`\n[manifest] wrote ${surveys.length} surveyed deals to ${MANIFEST_PATH}`);
  console.log(`[summary] wrote summary to ${SUMMARY_PATH}`);
  console.log('\n' + summary.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });

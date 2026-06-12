/**
 * Scale-up step 1b — diversification sweep + lock the first-batch manifest.
 *
 * Builds on /tmp/cmbs-corpus-manifest.json (step 1's output) and
 * /tmp/cmbs-survey/* (its caches). Adds:
 *
 *   1. Fixed realized-loss probe regex (covers _ex991-, _ex99_1-, ex99-1,
 *      ex99_1- naming variants). Re-probes the prior step's "inconclusive"
 *      deals to recover their booked/empty status.
 *
 *   2. Shelf-specific FTS sweeps for the pre-2016 originators the
 *      "Commercial Mortgage Trust" query missed:
 *        - GS Mortgage Securities Trust (GSMS)
 *        - Citigroup Commercial Mortgage Trust (CGCMT / GC series; partly
 *          covered already, expand)
 *        - JPMBB Commercial Mortgage Securities Trust / JPMCC
 *        - Morgan Stanley Bank of America Merrill Lynch Trust (MSBAM)
 *        - Morgan Stanley Capital I Trust (MSC)
 *        - COMM (Deutsche/Cantor shelf)
 *        - UBS-Barclays Commercial Mortgage Trust (UBSBB)
 *
 *   3. Survey new candidates (same probe pipeline as step 1).
 *
 *   4. Rebalance + lock the 30-deal first batch:
 *        - Backbone (~15): all booked realized losses, ≥4-5 distinct
 *          originators, preserving 2013/2014/2015 vintage spread.
 *        - Supplement (~15): keep the existing diverse 2017-2019 set.
 *
 *   5. Output the LOCKED batch + a diversity summary.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/clean-corpus-enumerate-diversify.ts
 *
 * No reader build, no doctrine, no repo cleanup.
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'CRE-Credit-Committee Research isaint-jean@mapaon.com';
const CACHE_DIR = '/tmp/cmbs-survey';
const STEP1_MANIFEST = '/tmp/cmbs-corpus-manifest.json';
const NEW_MANIFEST = '/tmp/cmbs-corpus-manifest-v2.json';
const LOCKED_BATCH = '/tmp/cmbs-locked-batch.out';

fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ----- fetch (cache-first) ----- */
async function get(url: string, cacheFile?: string): Promise<string> {
  if (cacheFile && fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');
  await new Promise(r => setTimeout(r, 200));
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
  const text = await resp.text();
  if (cacheFile) fs.writeFileSync(cacheFile, text);
  return text;
}

/* ----- FTS enumerator (same as step 1) ----- */
async function ftsEnumerate(query: string, forms: string, startdt: string, enddt: string): Promise<any[]> {
  const allHits: any[] = [];
  for (let from = 0; from < 1000; from += 100) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=${forms}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}`;
    const cacheFile = path.join(CACHE_DIR, `fts_${query.replace(/[^a-z0-9]/gi, '_')}_${forms}_${startdt}_${enddt}_from${from}.json`);
    let json: any;
    try { json = JSON.parse(await get(url, cacheFile)); }
    catch { try { fs.unlinkSync(cacheFile); } catch {} ; break; }
    const hits = json?.hits?.hits ?? [];
    if (hits.length === 0) break;
    allHits.push(...hits);
    const total = json?.hits?.total?.value ?? 0;
    if (allHits.length >= total) break;
  }
  return allHits;
}

function extractVintage(name: string): number | null {
  const m = name.match(/(20\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 2010 && y <= 2030 ? y : null;
}

/* ----- Originator inference from issuer name (shelf-based heuristic) -----
 *   Each major shelf has a distinctive naming pattern; this maps issuer
 *   names → shelf → originator family for the diversification summary. */
function inferOriginator(name: string): string {
  const n = name.toUpperCase();
  if (/WFRBS|WELLS FARGO/.test(n)) return 'Wells Fargo (WFRBS/WFCM)';
  if (/JPMBB|JPMCC|JPMDB|JP\s?MORGAN/.test(n)) return 'JPMorgan (JPMBB/JPMCC/JPMDB)';
  if (/CITIGROUP|CGCMT|\bGC[J]?\d/.test(n)) return 'Citigroup (CGCMT/GC)';
  if (/GSMS|GS\s+MORTGAGE/.test(n)) return 'Goldman Sachs (GSMS)';
  if (/MSBAM|MORGAN STANLEY BANK/.test(n)) return 'Morgan Stanley + BofA (MSBAM)';
  if (/^MSC\b|MORGAN STANLEY CAPITAL/.test(n)) return 'Morgan Stanley (MSC)';
  if (/^COMM\s|DBGS|DBJPM|DBUBS|DEUTSCHE/.test(n)) return 'Deutsche/COMM/DBGS';
  if (/UBS-BARCLAYS|UBS\b/.test(n)) return 'UBS / UBS-Barclays (UBSBB)';
  if (/BBCMS|BANK 20\d{2}-BNK|BANK\s+20\d{2}/.test(n)) return 'BANK (BofA/Wells/Morgan Stanley)';
  if (/BENCHMARK|BMARK/.test(n)) return 'Benchmark (DB/JPM/CG)';
  if (/CSAIL|CSMC|CREDIT SUISSE/.test(n)) return 'Credit Suisse (CSAIL/CSMC)';
  if (/CD\s+20\d{2}|CD\s+MORTGAGE/.test(n)) return 'CD (Citi/Deutsche)';
  if (/CF\s+20\d{2}|CF\s+MORTGAGE/.test(n)) return 'CF (Cantor/UBS)';
  if (/BANK OF AMERICA MERRILL/.test(n)) return 'BAML';
  return 'Other / unknown';
}

/* ----- FIXED realized-loss probe (extended regex) ----- */
async function probe10DRealizedLossV2(cik: string, accession: string): Promise<{ status: boolean | null; reason: string }> {
  const accNoDashes = accession.replace(/-/g, '');
  const dirUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDashes}/`;
  const dirCache = path.join(CACHE_DIR, `10D_${cik}_${accNoDashes}_dir.html`);
  let dirHtml: string;
  try { dirHtml = await get(dirUrl, dirCache); } catch { return { status: null, reason: 'dir-fetch-failed' }; }
  // EXTENDED LOCATOR — covers ex991, _ex991-, _ex99_1-, ex99-1, ex99_1-,
  // ex99.1, plus the older _10d- htm naming used by some 2013-vintage filers.
  const candidates: RegExp[] = [
    /href="([^"]+_ex991-[^"]+\.htm)"/i,
    /href="([^"]+_ex99_1-[^"]+\.htm)"/i,
    /href="([^"]+ex99[-_]1[^"]*\.htm)"/i,
    /href="([^"]+ex991[^"]*\.htm)"/i,
    /href="([^"]+ex99\.1[^"]*\.htm)"/i,
    /href="([^"]+_10[dD]-\d+\.htm)"/i,        // composite 10-D body filing
    /href="([^"]+_10[dD]\d*\.htm)"/i,
  ];
  let exHrefMatch: string | null = null;
  for (const re of candidates) {
    const m = dirHtml.match(re);
    if (m) { exHrefMatch = m[1]; break; }
  }
  if (!exHrefMatch) {
    // Last-resort scan: any .htm with "10d" or "991" in its name
    const broad = dirHtml.match(/href="([^"]+(?:10d|991|99[._-]1)[^"]*\.htm)"/i);
    if (broad) exHrefMatch = broad[1];
  }
  if (!exHrefMatch) return { status: null, reason: 'no-ex991-locator-match' };

  const url = exHrefMatch.startsWith('/') ? `https://www.sec.gov${exHrefMatch}` : `${dirUrl}${exHrefMatch.split('/').pop()}`;
  const exCache = path.join(CACHE_DIR, `10D_${cik}_${accNoDashes}_ex991.htm`);
  let html: string;
  try { html = await get(url, exCache); } catch { return { status: null, reason: 'ex991-fetch-failed' }; }
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const idx = text.indexOf('Historical Liquidated Loan Detail');
  if (idx < 0) return { status: null, reason: 'no-liquidated-section' };
  // body version (not TOC)
  const bodyIdx = text.indexOf('Historical Liquidated Loan Detail', idx + 100);
  const target = bodyIdx > 0 ? bodyIdx : idx;
  const window = text.slice(target, target + 4000);
  if (/No liquidated loans this period/i.test(window)) return { status: false, reason: 'empty-sentinel' };
  const moneyCount = (window.match(/\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?/g) ?? []).length;
  if (moneyCount >= 10) return { status: true, reason: `${moneyCount} money tokens in body window` };
  return { status: null, reason: `ambiguous (${moneyCount} money tokens, no sentinel)` };
}

/* ----- IRP code label ----- */
function classCodeLabel(code: string): string {
  const m: Record<string, string> = {
    RT: 'Retail', OF: 'Office', MF: 'Multifamily', LO: 'Hotel',
    IN: 'Industrial', MH: 'MHC', SS: 'SelfStorage', MU: 'MixedUse',
    WH: 'Industrial', HC: 'HealthCare', SE: 'Securities', CH: 'CoopHousing',
    SF: 'SFR', ZZ: 'Unknown', '98': 'Other',
  };
  return m[code.toUpperCase()] ?? code;
}

/* ----- per-deal survey (shorter than step 1; reuses caches) ----- */
async function fetchFilingIndex(cik: string, form: string, count = 5): Promise<Array<{ accession: string; filingDate: string }>> {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=${count}&output=atom`;
  const cacheFile = path.join(CACHE_DIR, `idx_${cik}_${form}.xml`);
  let xml: string;
  try { xml = await get(url, cacheFile); } catch { return []; }
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

interface DealSurvey {
  readonly cik: string;
  readonly name: string;
  readonly originator: string;
  readonly vintageInferred: number | null;
  readonly absEeLatest: string | null;
  readonly tenDLatest: string | null;
  readonly absEeLatestFileDate: string | null;
  readonly tenDLatestFileDate: string | null;
  readonly hasRealizedLossPopulated: boolean | null;
  readonly probeReason: string;
  readonly inferredAssetTypes: readonly string[];
  readonly assetCount: number | null;
}

async function surveyDeal(cik: string, name: string, options: { skipEx102?: boolean } = {}): Promise<DealSurvey> {
  const vintage = extractVintage(name);
  const originator = inferOriginator(name);
  const absEe = await fetchFilingIndex(cik, 'ABS-EE', 1);
  const tenD = await fetchFilingIndex(cik, '10-D', 1);
  let realizedLoss: boolean | null = null;
  let probeReason = '(not probed)';
  if (tenD.length > 0) {
    const r = await probe10DRealizedLossV2(cik, tenD[0].accession);
    realizedLoss = r.status;
    probeReason = r.reason;
  }
  // Asset-type tally only for post-2016 deals (pre-2016 has no ABS-EE);
  // step 1 already did this for most post-2016 candidates.
  let types: string[] = [];
  let assetCount: number | null = null;
  if (!options.skipEx102 && absEe.length > 0) {
    const accNoDashes = absEe[0].accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accNoDashes}/exh_102.xml`;
    const cache = path.join(CACHE_DIR, `ee_${cik}_${accNoDashes}_ex102.xml`);
    try {
      const xml = await get(url, cache);
      const codes = xml.match(/<propertyTypeCode>([^<]+)<\/propertyTypeCode>/g) ?? [];
      types = codes.map(c => c.replace(/<\/?propertyTypeCode>/g, '').trim());
      assetCount = (xml.match(/<assetNumber>/g) ?? []).length;
    } catch { /* leave empty */ }
  }
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}(${n})`);
  return {
    cik, name, originator,
    vintageInferred: vintage,
    absEeLatest: absEe[0]?.accession ?? null,
    tenDLatest: tenD[0]?.accession ?? null,
    absEeLatestFileDate: absEe[0]?.filingDate ?? null,
    tenDLatestFileDate: tenD[0]?.filingDate ?? null,
    hasRealizedLossPopulated: realizedLoss,
    probeReason,
    inferredAssetTypes: summary,
    assetCount,
  };
}

/* ----- shelf-specific enumeration for pre-2016 (2013-2015) ----- */
const SHELF_QUERIES: Array<{ shelf: string; query: string }> = [
  { shelf: 'GSMS',                  query: '"GS Mortgage Securities"' },
  { shelf: 'JPMBB/JPMCC/JPMDB',     query: '"JPMBB"' },
  { shelf: 'JPMCC',                 query: '"JPMCC"' },
  { shelf: 'MSBAM',                 query: '"Morgan Stanley Bank of America Merrill Lynch Trust"' },
  { shelf: 'MSC',                   query: '"Morgan Stanley Capital I Trust"' },
  { shelf: 'COMM/DBJPM/DBUBS',      query: '"COMM" "Mortgage Trust"' },
  { shelf: 'UBSBB',                 query: '"UBS-Barclays Commercial Mortgage Trust"' },
  { shelf: 'CITI-GC',               query: '"Citigroup Commercial Mortgage Trust"' },
  { shelf: 'WFRBS',                 query: '"WFRBS Commercial Mortgage Trust"' },
  { shelf: 'BAML',                  query: '"Bank of America Merrill Lynch Commercial Mortgage Trust"' },
];

async function enumerateShelfPre2016(): Promise<Array<{ cik: string; name: string; shelf: string }>> {
  const out = new Map<string, { name: string; shelf: string }>();
  for (const sq of SHELF_QUERIES) {
    for (const y of [2013, 2014, 2015]) {
      const halves = [
        { a: `${y}-01-01`, b: `${y}-06-30` },
        { a: `${y}-07-01`, b: `${y}-12-31` },
      ];
      for (const h of halves) {
        let hits: any[] = [];
        try { hits = await ftsEnumerate(sq.query, '10-D', h.a, h.b); } catch { continue; }
        for (const hit of hits) {
          const src = hit._source ?? {};
          const cik = (src.ciks?.[0] ?? '').padStart(10, '0');
          const name = src.display_names?.[0] ?? '';
          if (!cik || !name) continue;
          const v = extractVintage(name);
          if (v === null || v < y || v > y) continue;
          if (!out.has(cik)) out.set(cik, { name, shelf: sq.shelf });
        }
      }
    }
  }
  return [...out.entries()].map(([cik, v]) => ({ cik, name: v.name, shelf: v.shelf }));
}

/* ----- main ----- */
async function main() {
  /* Step 1: load step-1's manifest + re-probe its inconclusives with the
   *         fixed regex. */
  console.log('=== Step 1: re-probe step-1 inconclusives with the fixed regex ===');
  const step1: any[] = JSON.parse(fs.readFileSync(STEP1_MANIFEST, 'utf8'));
  const inconclusives = step1.filter(d => d.hasRealizedLossPopulated === null && d.tenDLatest !== null);
  console.log(`  inconclusive deals to re-probe: ${inconclusives.length}`);

  const reProbed = new Map<string, { status: boolean | null; reason: string }>();
  for (const d of inconclusives) {
    // Force a fresh dir+ex991 fetch by deleting the prior cache that pre-fixed
    // the regex couldn't find. (Step-1's caches may still be present for some.)
    const accNoDashes = (d.tenDLatest ?? '').replace(/-/g, '');
    const oldDir = path.join(CACHE_DIR, `10D_${d.cik}_${accNoDashes}_dir.html`);
    const oldEx = path.join(CACHE_DIR, `10D_${d.cik}_${accNoDashes}_ex991.htm`);
    try { fs.unlinkSync(oldEx); } catch {}
    // keep dir cache (it was successful — only the regex was wrong)
    const r = await probe10DRealizedLossV2(d.cik, d.tenDLatest);
    reProbed.set(d.cik, r);
    const dl = r.status === true ? 'BOOKED✓' : r.status === false ? 'empty' : 'still-?';
    console.log(`    ${d.name.slice(0, 55).padEnd(55)} ${dl}  (${r.reason})`);
  }
  // Update step-1 records
  for (const d of step1) {
    if (reProbed.has(d.cik)) {
      const r = reProbed.get(d.cik)!;
      d.hasRealizedLossPopulated = r.status;
      d.probeReason = r.reason;
    }
  }
  const recovered = [...reProbed.values()].filter(r => r.status !== null).length;
  console.log(`  recovered: ${recovered}/${inconclusives.length} now have a definite verdict`);

  /* Step 2: shelf-specific pre-2016 sweep across non-WFRBS shelves. */
  console.log('\n=== Step 2: shelf-specific pre-2016 sweep ===');
  const candidates = await enumerateShelfPre2016();
  console.log(`  raw shelf candidates: ${candidates.length}`);
  // Filter out duplicates with step-1 manifest by CIK
  const known = new Set(step1.map(d => d.cik));
  const newCandidates = candidates.filter(c => !known.has(c.cik));
  console.log(`  new (not in step-1 manifest): ${newCandidates.length}`);
  // Surface per-shelf breakdown
  const byShelf = new Map<string, typeof newCandidates>();
  for (const c of newCandidates) {
    if (!byShelf.has(c.shelf)) byShelf.set(c.shelf, []);
    byShelf.get(c.shelf)!.push(c);
  }
  for (const [s, list] of byShelf) console.log(`    ${s.padEnd(20)} ${list.length} candidates`);

  /* Step 3: survey new candidates. */
  console.log('\n=== Step 3: survey new candidates ===');
  const newSurveys: DealSurvey[] = [];
  for (const c of newCandidates.slice(0, 40)) {
    try {
      const s = await surveyDeal(c.cik, c.name);
      newSurveys.push(s);
      const dl = s.hasRealizedLossPopulated === true ? 'BOOKED✓' : s.hasRealizedLossPopulated === false ? 'empty' : '?';
      console.log(`    ${s.name.slice(0, 55).padEnd(55)} v${s.vintageInferred} ${s.originator.padEnd(28)} ${dl}`);
    } catch (e) { console.log(`    [skip] ${c.name}: ${(e as Error).message}`); }
  }

  /* Step 4: merge into v2 manifest. */
  const v2: any[] = [...step1, ...newSurveys];
  // Backfill originator on step-1 records too (so the summary is uniform)
  for (const d of v2) if (!d.originator) d.originator = inferOriginator(d.name);
  fs.writeFileSync(NEW_MANIFEST, JSON.stringify(v2, null, 2));
  console.log(`\n[manifest] wrote v2 manifest (${v2.length} deals) to ${NEW_MANIFEST}`);

  /* Step 5: lock the 30-deal first batch. */
  console.log('\n=== Step 5: lock the 30-deal first batch ===');
  const out: string[] = [];
  out.push('CMBS CORPUS — LOCKED FIRST BATCH (30 DEALS)');
  out.push(`Locked: ${new Date().toISOString()}`);
  out.push(`Source manifest: ${NEW_MANIFEST}`);
  out.push('');

  // BACKBONE: 15 pre-2016 deals with BOOKED realized losses, spread across ≥4 originators
  const bookedPre2016 = v2.filter(d =>
    d.hasRealizedLossPopulated === true &&
    (d.vintageInferred ?? 0) >= 2013 &&
    (d.vintageInferred ?? 0) <= 2016,
  );
  // Group by originator
  const byOrigAll = new Map<string, any[]>();
  for (const d of bookedPre2016) {
    const o = d.originator ?? inferOriginator(d.name);
    if (!byOrigAll.has(o)) byOrigAll.set(o, []);
    byOrigAll.get(o)!.push(d);
  }
  // Pick at most 4 per originator, max 15 total, prioritize 2013/2014/2015 spread
  const backbone: any[] = [];
  const perOrig: Record<string, number> = {};
  const perVintage: Record<number, number> = {};
  const MAX_PER_ORIG = 4;
  const MAX_PER_VINTAGE = 6;
  // Round-robin across originators
  for (let round = 0; round < 10 && backbone.length < 15; round++) {
    for (const [orig, deals] of byOrigAll) {
      if (backbone.length >= 15) break;
      perOrig[orig] = perOrig[orig] ?? 0;
      if (perOrig[orig] >= MAX_PER_ORIG) continue;
      // sort: prefer the vintage with fewest slots filled
      const sorted = [...deals].sort((a, b) => {
        const va = a.vintageInferred ?? 0;
        const vb = b.vintageInferred ?? 0;
        return (perVintage[va] ?? 0) - (perVintage[vb] ?? 0);
      });
      const pick = sorted.find(d => !backbone.includes(d) && (perVintage[d.vintageInferred ?? 0] ?? 0) < MAX_PER_VINTAGE);
      if (pick) {
        backbone.push(pick);
        perOrig[orig]++;
        perVintage[pick.vintageInferred ?? 0] = (perVintage[pick.vintageInferred ?? 0] ?? 0) + 1;
      }
    }
  }

  // SUPPLEMENT: 15 post-2016 deals (2017-2019) with ABS-EE, prefer booked,
  // spread across shelves + asset classes
  const post2016 = v2.filter(d =>
    (d.vintageInferred ?? 0) >= 2017 &&
    (d.vintageInferred ?? 0) <= 2019 &&
    d.absEeLatest !== null,
  );
  const byOrigPost = new Map<string, any[]>();
  for (const d of post2016) {
    const o = d.originator ?? inferOriginator(d.name);
    if (!byOrigPost.has(o)) byOrigPost.set(o, []);
    byOrigPost.get(o)!.push(d);
  }
  const supplement: any[] = [];
  const perOrigPost: Record<string, number> = {};
  const perVintagePost: Record<number, number> = {};
  const MAX_PER_ORIG_POST = 3;
  const MAX_PER_VINTAGE_POST = 6;
  for (let round = 0; round < 10 && supplement.length < 15; round++) {
    for (const [orig, deals] of byOrigPost) {
      if (supplement.length >= 15) break;
      perOrigPost[orig] = perOrigPost[orig] ?? 0;
      if (perOrigPost[orig] >= MAX_PER_ORIG_POST) continue;
      const sorted = [...deals].sort((a, b) => {
        // prefer booked first, then vintage-balance
        const ba = a.hasRealizedLossPopulated === true ? 0 : 1;
        const bb = b.hasRealizedLossPopulated === true ? 0 : 1;
        if (ba !== bb) return ba - bb;
        const va = a.vintageInferred ?? 0;
        const vb = b.vintageInferred ?? 0;
        return (perVintagePost[va] ?? 0) - (perVintagePost[vb] ?? 0);
      });
      const pick = sorted.find(d => !supplement.includes(d) && (perVintagePost[d.vintageInferred ?? 0] ?? 0) < MAX_PER_VINTAGE_POST);
      if (pick) {
        supplement.push(pick);
        perOrigPost[orig]++;
        perVintagePost[pick.vintageInferred ?? 0] = (perVintagePost[pick.vintageInferred ?? 0] ?? 0) + 1;
      }
    }
  }

  /* render */
  out.push('==============================================================================');
  out.push(`BACKBONE — ${backbone.length} deals (all BOOKED realized losses; pre-2016 → 424B5 origination path)`);
  out.push('==============================================================================');
  out.push('');
  for (const d of backbone.sort((a, b) => (a.vintageInferred ?? 0) - (b.vintageInferred ?? 0))) {
    out.push(`  v${d.vintageInferred} CIK${d.cik.replace(/^0+/, '').padEnd(7)} ${d.name.slice(0, 50).padEnd(50)} originator=${d.originator}`);
  }
  out.push('');

  out.push('==============================================================================');
  out.push(`SUPPLEMENT — ${supplement.length} deals (2017-2019 ABS-EE; full machine-readable origination path)`);
  out.push('==============================================================================');
  out.push('');
  for (const d of supplement.sort((a, b) => (a.vintageInferred ?? 0) - (b.vintageInferred ?? 0))) {
    const dl = d.hasRealizedLossPopulated === true ? 'BOOKED✓' : d.hasRealizedLossPopulated === false ? 'empty' : '?';
    const typeStr = (d.inferredAssetTypes ?? []).slice(0, 5).join(',');
    out.push(`  v${d.vintageInferred} CIK${d.cik.replace(/^0+/, '').padEnd(7)} ${d.name.slice(0, 45).padEnd(45)} ${d.originator.padEnd(28)} loss=${dl} assets=${(d.assetCount ?? '?').toString().padStart(3)} types=${typeStr}`);
  }
  out.push('');

  out.push('==============================================================================');
  out.push('DIVERSITY SUMMARY');
  out.push('==============================================================================');
  out.push('');
  const all30 = [...backbone, ...supplement];
  // Originator spread
  const origCounts = new Map<string, number>();
  for (const d of all30) origCounts.set(d.originator, (origCounts.get(d.originator) ?? 0) + 1);
  out.push(`Originator spread (${origCounts.size} distinct shelves):`);
  for (const [o, n] of [...origCounts.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${o.padEnd(40)} ${n} deals`);
  }
  out.push('');
  // Vintage spread
  const vintageCounts = new Map<number, number>();
  for (const d of all30) vintageCounts.set(d.vintageInferred ?? 0, (vintageCounts.get(d.vintageInferred ?? 0) ?? 0) + 1);
  out.push(`Vintage spread:`);
  for (const [v, n] of [...vintageCounts.entries()].sort((a, b) => a[0] - b[0])) {
    out.push(`  ${v}: ${n} deals`);
  }
  out.push('');
  // Booked-loss count
  const totalBooked = all30.filter(d => d.hasRealizedLossPopulated === true).length;
  out.push(`Booked realized losses: ${totalBooked}/30 deals`);
  out.push('');
  // Asset-class spread (from post-2016 EX-102 tallies; pre-2016 contributes via 424B5 later)
  const acClassCounts = new Map<string, number>();
  for (const d of all30) {
    for (const t of d.inferredAssetTypes ?? []) {
      const codeMatch = t.match(/^([A-Z]+|\d+)\((\d+)\)$/);
      if (codeMatch) {
        const code = codeMatch[1];
        const cnt = Number(codeMatch[2]);
        acClassCounts.set(classCodeLabel(code), (acClassCounts.get(classCodeLabel(code)) ?? 0) + cnt);
      }
    }
  }
  out.push(`Asset-class spread (from post-2016 EX-102 tallies; pre-2016 path adds in 424B5):`);
  for (const [c, n] of [...acClassCounts.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${c.padEnd(15)} ${n} loans (in post-2016 supplement pools)`);
  }
  out.push('');
  // Estimated loan-record count
  const postCount = supplement.reduce((s, d) => s + (d.assetCount ?? 0), 0);
  // Pre-2016 avg conduit deal carries ~50-80 loans; estimate 60 each.
  const preCount = backbone.length * 60;
  out.push(`Estimated loan-record count:`);
  out.push(`  Pre-2016 backbone (no EX-102; ~60 loans/deal industry avg): ~${preCount}`);
  out.push(`  Post-2016 supplement (actual EX-102 asset counts):           ${postCount}`);
  out.push(`  TOTAL FIRST BATCH:                                           ~${preCount + postCount} loan records`);
  out.push('');
  out.push('Compared to the employer historical-UWs corpus (267 records):');
  out.push(`  Locked first batch ≈ ${Math.round((preCount + postCount) / 267)}× the employer corpus — already on`);
  out.push(`  the first batch alone, before scale-up.`);
  out.push('');

  out.push('==============================================================================');
  out.push('NEXT STEPS');
  out.push('==============================================================================');
  out.push('');
  out.push('1. BUILD the production reader (deferred from the spikes). Sequence:');
  out.push('   a. 424B5 Annex A parser (NEW; pre-2016 origination path) — this is the major new code.');
  out.push('   b. Composer that fetches per-deal (EX-102 for post-2016, 424B5 for pre-2016) + the');
  out.push('      10-D Ex 99.1 page 23 for realized-loss anchors + the monthly EX-102 trajectory.');
  out.push('   c. Per-loan classifier (3-class: CLEAN / STRESS-ONLY / LOSS) — already implemented');
  out.push('      in clean-corpus-spike-loss.ts; ports cleanly.');
  out.push('   d. Pari passu whole-loan aggregator — uses the loanStructureCode + cross-shelf');
  out.push('      EDGAR FTS recipe documented in spike #2.');
  out.push('2. RUN the reader against the locked batch; produce the answer-key corpus.');
  out.push('3. RE-VALIDATE engine constants (TIER_DELTA, doctrine band cap, COVERAGE_FLOOR_THRESHOLD,');
  out.push('   etc.) against the clean corpus. Bucket C from the cleanup audit.');

  fs.writeFileSync(LOCKED_BATCH, out.join('\n'));
  const text = out.join('\n');
  console.log('\n' + text);
  console.log(`\n[locked-batch] wrote ${text.length} chars to ${LOCKED_BATCH}`);
}

main().catch(e => { console.error(e); process.exit(1); });

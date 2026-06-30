/**
 * Build the CMBS comp corpus — the reproducible recipe (Phase 3a Step 3).
 * Reads the 15 manifest issuance EX-102s (fetch-if-missing from EDGAR),
 * content-addresses the raw XML into data/comps/raw/<sha256>.xml, parses via
 * parseCmbsComps, normalizes + persists one row per property into
 * data/comps/comps.db (keyed CIK+asset#; same-building stays separate, flagged
 * via propertyKey). The .db + raw blobs are gitignored (cre.db convention);
 * THIS script + comps-store.ts + the manifest are the committed recipe.
 *
 * Source of truth for the deal list: docs/recon/2026-06-29-comps-manifest.md.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseCmbsComps } from '../services/extract-cmbs-comps.js';
import { openCompsStore, upsertComp } from '../services/comps-store.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const STORE_DIR = resolve(REPO, 'data/comps');
const RAW_DIR = resolve(STORE_DIR, 'raw');
const UA = 'Isabelle Saint-Jean isaint-jean@mapaon.com';
const INGESTED_AT = '2026-06-29T00:00:00Z';

// [dealName, cik, accession(issuance), shelf, filingDate]
const MANIFEST: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['BANK 2024-BNK47', '2023106', '0001888524-24-011484', 'BANK', '2024-08-01'],
  ['BANK5 2024-5YR5', '2006016', '0001888524-24-009889', 'BANK5', '2024-07-01'],
  ['BANK5 2025-5YR15', '2071746', '0001888524-25-015610', 'BANK5', '2025-08-29'],
  ['BANK5 2025-5YR19', '2098810', '0001888524-26-001896', 'BANK5', '2026-01-30'],
  ['BBCMS 2024-C24', '2006370', '0001888524-24-011157', 'BBCMS', '2024-07-30'],
  ['BBCMS 2024-C28', '2030072', '0001888524-24-014233', 'BBCMS', '2024-09-30'],
  ['BBCMS 2024-5C31', '2044180', '0001888524-25-001334', 'BBCMS', '2025-01-30'],
  ['Benchmark 2024-V5', '2004982', '0001888524-24-010292', 'BMARK', '2024-07-23'],
  ['Benchmark 2024-V8', '2024274', '0001888524-24-012032', 'BMARK', '2024-08-27'],
  ['Benchmark 2024-V10', '2034418', '0001628297-24-000774', 'BMARK', '2024-10-31'],
  ['BMO 2024-C8', '2012263', '0001628297-24-000454', 'BMO', '2024-07-01'],
  ['BMO 2024-C9', '2024812', '0001888524-24-013070', 'BMO', '2024-08-30'],
  ['BMO 2024-C10', '2038432', '0001628297-24-000944', 'BMO', '2024-12-30'],
  ['WFCM 2024-C63', '2029929', '0001539497-24-001644', 'WFCM', '2024-08-12'],
  ['WFCM 2024-5C1', '2028411', '0001888524-24-012259', 'WFCM', '2024-08-27'],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function get(url: string, json: boolean): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'application/xml' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return json ? res.json() : res.text();
}

/** Read the EX-102 XML for a deal — from /tmp/comps-raw/ if present (Step 2), else fetch. */
async function loadEx102(cik: string, accession: string): Promise<string> {
  const nodash = accession.replace(/-/g, '');
  const tmp = `/tmp/comps-raw/${nodash}.xml`;
  if (existsSync(tmp)) return readFileSync(tmp, 'utf8');
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${nodash}/`;
  const idx = (await get(base + 'index.json', true)) as { directory: { item: Array<{ name: string; size: string }> } };
  await sleep(350);
  const items = idx.directory.item;
  const xmls = items.filter((i) => /\.xml$/i.test(i.name) && /102/.test(i.name));
  const pick = (xmls.length ? xmls : items.filter((i) => /\.xml$/i.test(i.name))).sort((a, b) => (+b.size || 0) - (+a.size || 0))[0];
  if (!pick) throw new Error('no EX-102 xml');
  const xml = (await get(base + pick.name, false)) as string;
  await sleep(350);
  return xml;
}

async function main(): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true });
  const db = openCompsStore(resolve(STORE_DIR, 'comps.db'));
  db.exec('DELETE FROM comps;'); // idempotent rebuild
  let inserted = 0, dup = 0;
  const perDeal: Array<{ name: string; comps: number }> = [];
  for (const [name, cik, accession, shelf] of MANIFEST) {
    const xml = await loadEx102(cik, accession);
    const sha = createHash('sha256').update(xml).digest('hex');
    const rawPath = resolve(RAW_DIR, `${sha}.xml`);
    if (!existsSync(rawPath)) {
      const tmp = `/tmp/comps-raw/${accession.replace(/-/g, '')}.xml`;
      if (existsSync(tmp)) copyFileSync(tmp, rawPath);
      else writeFileSync(rawPath, xml);
    }
    const ext = parseCmbsComps(xml, { sourceDeal: name, filingDate: null, filingAccession: accession });
    const tx = db.transaction(() => {
      for (const c of ext.comps) {
        const r = upsertComp(db, { ...c, filingDate: MANIFEST.find((m) => m[0] === name)![4] } as typeof c, {
          cik, shelf, rawBlobHash: sha, ingestedAt: INGESTED_AT,
        });
        if (r === 'inserted') inserted++; else dup++;
      }
    });
    tx();
    perDeal.push({ name, comps: ext.comps.length });
  }

  // === GATE REPORT ===
  const row = db.prepare('SELECT COUNT(*) n FROM comps').get() as { n: number };
  console.log(`★ CORPUS: ${row.n} rows | inserted ${inserted} | dedup hits ${dup}`);
  console.log('★ per-deal loan counts:');
  for (const d of perDeal) console.log('  ' + d.name.padEnd(20) + ' ' + d.comps);
  const cov = db.prepare('SELECT ROUND(fieldCoverage,1) c, COUNT(*) n FROM comps GROUP BY c ORDER BY c').all() as Array<{ c: number; n: number }>;
  console.log('★ completeness (fieldCoverage → count):', cov.map((x) => `${x.c}:${x.n}`).join('  '));
  console.log('  hasValue: ' + (db.prepare('SELECT COUNT(*) n FROM comps WHERE hasValue=1').get() as { n: number }).n + '/' + row.n);
  // office geography histogram (relevance floor for Sunroad)
  const SOCAL = ['San Diego', 'Los Angeles', 'Irvine', 'Anaheim', 'Santa Ana', 'Long Beach', 'Riverside', 'San Bernardino', 'Ontario', 'Carlsbad', 'Pasadena', 'Burbank', 'Glendale', 'Torrance', 'El Segundo', 'Santa Monica'];
  const off = (db.prepare("SELECT COUNT(*) n FROM comps WHERE propertyType='Office'").get() as { n: number }).n;
  const offCA = (db.prepare("SELECT COUNT(*) n FROM comps WHERE propertyType='Office' AND state='CA'").get() as { n: number }).n;
  const offSoCal = (db.prepare(`SELECT COUNT(*) n FROM comps WHERE propertyType='Office' AND state='CA' AND city IN (${SOCAL.map(() => '?').join(',')})`).get(...SOCAL) as { n: number }).n;
  const offSD = (db.prepare("SELECT COUNT(*) n FROM comps WHERE propertyType='Office' AND state='CA' AND city='San Diego'").get() as { n: number }).n;
  console.log(`★★ OFFICE comps: ${off} total | ${offCA} CA | ${offSoCal} SoCal | ${offSD} San Diego (Sunroad relevance floor)`);
  console.log('  CA office comps:', (db.prepare("SELECT propertyName, city FROM comps WHERE propertyType='Office' AND state='CA'").all() as Array<{ propertyName: string; city: string }>).map((x) => `${x.propertyName} (${x.city})`).join(' · '));
  db.close();
}

main().catch((e) => { console.log('FATAL:', (e as Error).message); process.exit(1); });

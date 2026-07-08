/**
 * PORTFOLIO PHASE 0 — SPIKE 1: EX-102 "un-collapse"
 *
 * Question: can the EX-102 path KEEP a multi-property loan's N component
 * properties as N structured per-property records, instead of flattening to
 * one DealBag? Test bed: Prime Storage-Blue Portfolio (Benchmark 2024-V8,
 * assetNumber 19, 5 components: Union City / Jersey City / Newark / Hoboken /
 * Garfield).
 *
 * SPIKE ONLY — read-only. Reuses the PRODUCTION comps parser
 * (extract-cmbs-comps.ts) against the content-addressed raw blob. Matches the
 * emitted per-property records against comps.db rows 19-001..19-005 as ground
 * truth. No DB writes, no doctrine, no commit.
 *
 *   cd apps/api && OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy \
 *     npx tsx src/scripts/portfolio-spike1-ex102-uncollapse.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { parseCmbsComps } from '../services/extract-cmbs-comps.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RAW_BLOB = resolve(
  REPO,
  'data/comps/raw/c9aa060c75e760af1d37972e100b33bb1d9e48deeb803c8df5b492646a359b74.xml',
);
const COMPS_DB = resolve(REPO, 'data/comps/comps.db');
const RAW_BLOB_HASH = 'c9aa060c75e760af1d37972e100b33bb1d9e48deeb803c8df5b492646a359b74';

/** Per-property record we want to prove survives (subset of the full CompRecord). */
interface PerPropertyRecord {
  readonly ordinal: number; // 1..N (0 = the aggregate rollup row, excluded)
  readonly propertyName: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly netRentableSF: number | null;
  readonly value: number | null;
  readonly noi: number | null;
  readonly capRate: number | null;
  readonly occupancyPct: number | null;
}

function approxEq(a: number | null, b: number | null, tol = 1e-4): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / scale <= tol;
}

function main(): void {
  const out: string[] = [];
  const log = (s = '') => out.push(s);

  log('PORTFOLIO PHASE 0 — SPIKE 1: EX-102 UN-COLLAPSE');
  log(`Run: ${new Date().toISOString()}`);
  log(`Raw blob: ${RAW_BLOB}`);
  log('');

  // --- Step 1: parse the raw EX-102 with the PRODUCTION parser ---
  const xml = readFileSync(RAW_BLOB, 'utf8');
  const ext = parseCmbsComps(xml, {
    sourceDeal: 'Benchmark 2024-V8',
    filingDate: '2024-08-27',
    filingAccession: '0001888524-24-012032',
  });
  log(`Parser emitted ${ext.comps.length} comps across ${ext.assetCount} assets.`);

  // FINDING: in this filing, the rollup (assetNumber '19', "Blue Portfolio")
  // and its 5 components ('19-001'..'19-005') are ALREADY separate <assets>
  // blocks in the raw EX-102 itself — each component is a fully independent
  // asset record with exactly one <property>. The production parser emits all
  // 6 as separate CompRecords with no cross-record loss.
  const aggregate = ext.comps.filter((c) => c.assetNumber === '19');
  const components = ext.comps
    .filter((c) => /^19-\d{3}$/.test(c.assetNumber ?? ''))
    .sort((a, b) => (a.assetNumber ?? '').localeCompare(b.assetNumber ?? ''));
  log(`Aggregate rollup rows (assetNumber '19'): ${aggregate.length}`);
  log(`Component rows (assetNumber '19-NNN'): ${components.length} (expect 5).`);
  log('');

  // Un-collapse: keep the 5 component records as N structured per-property
  // records. ★ This is the ENTIRE un-collapse: the parser ALREADY emits each
  // component as its own record. "Collapse to one DealBag" would be a
  // DOWNSTREAM choice (keep only the aggregate '19', drop '19-001..005').
  const perProperty: PerPropertyRecord[] = components.map((c, idx) => ({
    ordinal: idx + 1,
    propertyName: c.propertyName,
    city: c.city,
    state: c.state,
    netRentableSF: c.netRentableSF,
    value: c.value,
    noi: c.noi,
    capRate: c.capRate,
    occupancyPct: c.occupancyPct,
  }));

  log(`UN-COLLAPSED: ${perProperty.length} structured per-property records (5 survive as 5):`);
  for (const p of perProperty) {
    log(
      `  [${p.ordinal}] ${p.propertyName} — ${p.city}, ${p.state} | ` +
        `SF=${p.netRentableSF} val=$${p.value?.toLocaleString()} ` +
        `NOI=$${p.noi?.toLocaleString()} cap=${p.capRate} occ=${p.occupancyPct}`,
    );
  }
  log('');

  // --- Step 2: match against comps.db ground truth (19-001..19-005) ---
  const db = new Database(COMPS_DB, { readonly: true });
  const truthRows = db
    .prepare(
      `SELECT assetNumber, propertyName, city, state, netRentableSF, value, noi, capRate, occupancyPct
       FROM comps WHERE rawBlobHash = ? AND assetNumber LIKE '19-%' ORDER BY assetNumber`,
    )
    .all(RAW_BLOB_HASH) as Array<{
    assetNumber: string;
    propertyName: string;
    city: string;
    state: string;
    netRentableSF: number | null;
    value: number | null;
    noi: number | null;
    capRate: number | null;
    occupancyPct: number | null;
  }>;
  db.close();

  log(`Ground-truth comps.db rows (19-001..19-005): ${truthRows.length}`);
  log('');
  log('MATCH per-property record → comps.db ground truth (by ordinal):');

  let allMatch = truthRows.length === perProperty.length && perProperty.length === 5;
  const fieldsToCheck: Array<keyof PerPropertyRecord & keyof (typeof truthRows)[number]> = [
    'netRentableSF',
    'value',
    'noi',
    'capRate',
    'occupancyPct',
  ];

  for (let i = 0; i < Math.max(perProperty.length, truthRows.length); i++) {
    const p = perProperty[i];
    const t = truthRows[i];
    if (!p || !t) {
      allMatch = false;
      log(`  [${i + 1}] MISSING (parser=${p ? 'yes' : 'no'}, db=${t ? 'yes' : 'no'})`);
      continue;
    }
    const fieldResults = fieldsToCheck.map((f) => {
      const pv = p[f] as number | null;
      const tv = t[f] as number | null;
      const ok = approxEq(pv, tv);
      if (!ok) allMatch = false;
      return `${f}=${ok ? 'OK' : `MISMATCH(${pv}≠${tv})`}`;
    });
    // Name check is soft (parser is raw-case, db is title-cased); compare uppercased.
    const nameOk = (p.propertyName ?? '').toUpperCase().replace(/\s+/g, ' ').trim() ===
      (t.propertyName ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
    log(
      `  [${i + 1}] ${t.assetNumber} "${t.propertyName}" name=${nameOk ? 'OK' : 'diff-case'} | ` +
        fieldResults.join(' '),
    );
  }
  log('');

  // --- Verdict ---
  log('='.repeat(70));
  log('SPIKE 1 VERDICT');
  log('='.repeat(70));
  log(`  5 properties survive as 5 structured records: ${perProperty.length === 5 ? 'YES' : 'NO'}`);
  log(`  All per-property financial fields match comps.db ground truth: ${allMatch ? 'YES' : 'NO'}`);
  log('');
  log('  COLLAPSE POINT: there is NO lossy collapse in the parser itself.');
  log('    In this EX-102, the 5 components are ALREADY independent <assets>');
  log('    blocks (assetNumber 19-001..19-005), each with full per-property');
  log('    financials, PLUS a separate aggregate rollup block (assetNumber 19,');
  log('    "Blue Portfolio"). extract-cmbs-comps.ts:67-129 iterates every');
  log('    <assets> block and every <property> child, emitting one CompRecord');
  log('    each — all 6 survive. "Collapse to one DealBag" would be a DOWNSTREAM');
  log('    choice (keep the aggregate 19, discard 19-001..005). No collapse is');
  log('    forced by the parser.');
  log('  UN-COLLAPSE DIFFICULTY: trivial. The N components already exist as N');
  log('    fully-independent structured records (this is stronger than the');
  log('    "parser produces N internally" hypothesis in the brief — they are');
  log('    already N SEPARATE asset records). The only net-new work is a');
  log('    parent↔child LINK (recognize 19-001..005 as children of rollup 19');
  log('    via the assetNumber prefix + NumberProperties=5 on the parent).');
  log(`  RESULT: ${perProperty.length === 5 && allMatch ? 'PROVEN' : 'BLOCKED'}`);

  console.log(out.join('\n'));
  process.exitCode = perProperty.length === 5 && allMatch ? 0 : 1;
}

main();

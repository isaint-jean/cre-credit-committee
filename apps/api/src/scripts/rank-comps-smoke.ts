/**
 * Rank/smoke entrypoint for the CMBS comp ranker — ranks the office comp corpus
 * (data/comps/comps.db) against a subject property and prints the tier-primary
 * top-6 + the above-floor audit list. Read-only on comps.db. Defaults to Sunroad
 * (the BMARK 2024-V8 subject); pass a property-name LIKE substring as argv[2].
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rankComps, type CompRow, type SubjectVector } from '../services/rank-comps.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const subjectName = process.argv[2] ?? 'Sunroad';

function main(): void {
  const db = new Database(resolve(REPO, 'data/comps/comps.db'), { readonly: true });
  const s = db.prepare('SELECT * FROM comps WHERE propertyName LIKE ?').get(`%${subjectName}%`) as Record<string, unknown> | undefined;
  if (!s) { console.log(`subject "${subjectName}" not found in corpus`); db.close(); return; }
  const subject: SubjectVector = {
    propertyType: 'Office', city: s.city as string, state: s.state as string,
    netRentableSF: s.netRentableSF as number, vintageRef: s.filingDate as string,
    value: (s.value as number) ?? null, propertyKey: s.propertyKey as string,
  };
  const rows = db.prepare(
    "SELECT dealName, assetNumber, propertyName, city, state, netRentableSF, value, filingDate, largestTenant, propertyType, propertyKey, fieldCoverage FROM comps WHERE propertyType='Office'",
  ).all() as CompRow[];
  const r = rankComps(rows, subject);

  console.log(`SUBJECT: ${subjectName} — ${subject.city}, ${subject.state} | ${subject.netRentableSF} SF | vintage ${subject.vintageRef}`);
  console.log(`office candidates: ${rows.length} → pari-passu collapsed: ${r.ranked.length} | floor cleared: ${r.floorCleared} | ${r.cut} of ${r.ranked.length} ≥0.45`);
  if (r.message) { console.log('  ' + r.message); db.close(); return; }
  console.log(`\nTOP 6 (curated workbook deliverable; 6 of ${r.cut} above floor — curated top, not the universe):`);
  r.ranked.slice(0, 6).forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.tier}] ${c.propertyName} (${c.city}, ${c.state}) — within-tier ${c.withinTier.toFixed(3)}, audit ${c.composite.toFixed(3)} | ${c.rationale}${c.dealCount > 1 ? ` | same-building ×${c.dealCount}` : ''}${c.creditTenantTag ? ' | CREDIT-TENANT' : ''}`);
    console.log(`      provenance: ${c.provenance.deal} asset#${c.provenance.assetNumber} (${c.provenance.filingDate})`);
  });
  db.close();
}

main();

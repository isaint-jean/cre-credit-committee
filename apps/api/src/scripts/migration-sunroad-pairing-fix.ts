/**
 * One-time migration: fix the Sunroad answer-key pairing.
 *
 * Background (recon report 2026-06-03):
 *   The library had TWO records for Sunroad —
 *     - 3327fd55-…  filename "001- Sunroad Centrum - OK TO PRINT JN.xlsm"  (real answer key)
 *     - daa2cb8c-…  filename "010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx"  (source CF
 *                   accidentally imported as a "completed UW")
 *   The user uploaded a FINAL-vintage CF source doc via "Upload Supporting Documents"; the
 *   conservative matcher flagged the duplicate; the user picked the daa2cb8c (wrong) record.
 *   So the source CF is attached to a self-referential record and the OK-TO-PRINT answer key
 *   has no source docs at all.
 *
 * This script:
 *   1. Re-associates the CF intake blob from daa2cb8c → 3327fd55's cf slot
 *      (move the content-addressed blob on disk, move the manifest entry)
 *   2. Deletes daa2cb8c's intake folder (now empty)
 *   3. Deletes daa2cb8c from .data/historical-uws.json
 *
 * Atomic JSON writes via tmp+rename. Idempotent: re-running after success is a no-op (asserts
 * the target state, reports, exits 0).
 *
 * Run:
 *   cd apps/api && npx tsx src/scripts/migration-sunroad-pairing-fix.ts
 *
 * READ-ONLY DRY-RUN flag:
 *   DRY_RUN=1 npx tsx src/scripts/migration-sunroad-pairing-fix.ts
 *   Reports the planned operations without touching anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_ROOT = path.resolve(process.cwd(), '.data');
const UWS_FILE = path.join(DATA_ROOT, 'historical-uws.json');
const MANIFEST_FILE = path.join(DATA_ROOT, 'source-docs', 'source-doc-manifests.json');
const SOURCE_DOCS_DIR = path.join(DATA_ROOT, 'source-docs');

const DRY = process.env.DRY_RUN === '1';

const KEEP_ID = '3327fd55-e382-4286-8378-64d33a11e518';   // OK TO PRINT (answer key)
const REMOVE_ID = 'daa2cb8c-c84e-49fb-88e6-309b1ce6ef11'; // CF PRELIM as UW (delete)

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}
function writeJsonAtomic(p: string, v: unknown): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

interface UWRecord { id: string; dealName: string; fileName: string; [k: string]: unknown }
type UwsFile = Array<[string, UWRecord]>;   // serialized Map
interface Entry { fileHash: string; originalFileName: string; size: number; mimeType: string; uploadedAt: string; notes: string | null }
interface DealManifest {
  historicalUwId: string;
  dealName: string;
  slots: { asr: Entry[]; cf: Entry[]; rent_roll: Entry[]; pca: Entry[]; seller_uw: Entry[]; t12: Entry[]; appraisal: Entry[] };
  createdAt: string;
  updatedAt: string;
}

(function main(): void {
  console.log(`Sunroad pairing-fix migration${DRY ? ' [DRY-RUN]' : ''}`);
  console.log(`  Keep:   ${KEEP_ID} (OK TO PRINT — answer key)`);
  console.log(`  Remove: ${REMOVE_ID} (CF PRELIM as UW — duplicate)`);
  console.log('');

  // -------- READ + VERIFY -------------------------------------------------
  // historical-uws.json is serialized as Array<[id, UWRecord]> (Map → JSON).
  const uws = readJson<UwsFile>(UWS_FILE);
  const keep = uws.find(([id]) => id === KEEP_ID)?.[1];
  const remove = uws.find(([id]) => id === REMOVE_ID)?.[1];

  if (!keep) {
    console.log(`  pre-state: ${KEEP_ID} is NOT in historical-uws (idempotent target reached, or wrong id).`);
  } else {
    console.log(`  pre-state KEEP   record: dealName="${keep.dealName}" fileName="${keep.fileName}"`);
  }
  if (!remove) {
    console.log(`  pre-state REMOVE record is ABSENT (migration already ran).`);
  } else {
    console.log(`  pre-state REMOVE record: dealName="${remove.dealName}" fileName="${remove.fileName}"`);
  }

  const manifestFile = fs.existsSync(MANIFEST_FILE)
    ? readJson<{ version: number; manifests: DealManifest[] }>(MANIFEST_FILE)
    : { version: 1, manifests: [] as DealManifest[] };
  const keepManifest = manifestFile.manifests.find((m) => m.historicalUwId === KEEP_ID);
  const removeManifest = manifestFile.manifests.find((m) => m.historicalUwId === REMOVE_ID);
  console.log(`  pre-state KEEP   manifest exists? ${keepManifest ? 'YES' : 'no'}`);
  console.log(`  pre-state REMOVE manifest exists? ${removeManifest ? 'YES' : 'no'}`);

  // Files on disk
  const removeDir = path.join(SOURCE_DOCS_DIR, REMOVE_ID);
  const keepDir = path.join(SOURCE_DOCS_DIR, KEEP_ID);
  const removeCfDir = path.join(removeDir, 'cf');
  const keepCfDir = path.join(keepDir, 'cf');
  const removeCfFiles = fs.existsSync(removeCfDir) ? fs.readdirSync(removeCfDir) : [];
  const keepCfFiles = fs.existsSync(keepCfDir) ? fs.readdirSync(keepCfDir) : [];
  console.log(`  pre-state REMOVE/cf files: [${removeCfFiles.join(', ')}]`);
  console.log(`  pre-state KEEP/cf   files: [${keepCfFiles.join(', ')}]`);

  // -------- PLAN ----------------------------------------------------------
  const plan: string[] = [];

  // The CF blob(s) and manifest entries to migrate
  const cfEntries = removeManifest?.slots.cf ?? [];
  if (cfEntries.length === 0 && !removeManifest && removeCfFiles.length === 0 && !remove) {
    plan.push('NOOP — target state already reached.');
  } else {
    if (cfEntries.length > 0) {
      plan.push(`Move ${cfEntries.length} CF manifest entry(ies) from ${REMOVE_ID} → ${KEEP_ID}.`);
    }
    if (removeCfFiles.length > 0) {
      plan.push(`Move ${removeCfFiles.length} CF blob(s) on disk: ${removeDir}/cf/ → ${keepDir}/cf/`);
    }
    if (removeManifest) {
      plan.push(`Delete REMOVE record's manifest entry from source-doc-manifests.json.`);
    }
    if (fs.existsSync(removeDir)) {
      plan.push(`Delete empty directory ${removeDir}.`);
    }
    if (remove) {
      plan.push(`Delete REMOVE record from historical-uws.json (id=${REMOVE_ID}).`);
    }
  }

  console.log('');
  console.log('PLANNED OPERATIONS:');
  for (const p of plan) console.log(`  - ${p}`);
  console.log('');

  if (DRY) {
    console.log('DRY-RUN: no changes applied.');
    process.exit(0);
  }

  if (plan[0] === 'NOOP — target state already reached.') {
    console.log('Nothing to do.');
    process.exit(0);
  }

  // -------- EXECUTE -------------------------------------------------------
  // (1) Build the keep-side manifest entry (create if not present).
  let keepManifestNew: DealManifest;
  if (keepManifest) {
    keepManifestNew = { ...keepManifest, updatedAt: new Date().toISOString() };
  } else {
    keepManifestNew = {
      historicalUwId: KEEP_ID,
      dealName: keep?.dealName ?? 'Sunroad Centrum',
      slots: { asr: [], cf: [], rent_roll: [], pca: [], seller_uw: [], t12: [], appraisal: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  // Append the moved CF entries (de-dupe by fileHash defensively).
  const existingHashes = new Set(keepManifestNew.slots.cf.map((e) => e.fileHash));
  for (const e of cfEntries) {
    if (!existingHashes.has(e.fileHash)) {
      keepManifestNew.slots.cf.push(e);
      existingHashes.add(e.fileHash);
    }
  }

  // (2) Move blobs on disk.
  if (removeCfFiles.length > 0) {
    fs.mkdirSync(keepCfDir, { recursive: true });
    for (const f of removeCfFiles) {
      const src = path.join(removeCfDir, f);
      const dst = path.join(keepCfDir, f);
      if (fs.existsSync(dst)) {
        // Content-addressed: same hash → same bytes. Drop the duplicate from the source.
        fs.rmSync(src);
        console.log(`  blob (already at dst, removed src):  ${src}`);
      } else {
        fs.renameSync(src, dst);
        console.log(`  blob mv: ${src}  →  ${dst}`);
      }
    }
  }

  // (3) Delete the REMOVE record's manifest entry; install KEEP's updated one.
  const newManifests = manifestFile.manifests.filter((m) => m.historicalUwId !== REMOVE_ID);
  const keepIdx = newManifests.findIndex((m) => m.historicalUwId === KEEP_ID);
  if (keepIdx >= 0) {
    newManifests[keepIdx] = keepManifestNew;
  } else {
    newManifests.push(keepManifestNew);
  }
  writeJsonAtomic(MANIFEST_FILE, { ...manifestFile, manifests: newManifests });
  console.log(`  wrote ${MANIFEST_FILE}`);

  // (4) Delete REMOVE's directory.
  if (fs.existsSync(removeDir)) {
    fs.rmSync(removeDir, { recursive: true, force: true });
    console.log(`  removed ${removeDir}`);
  }

  // (5) Delete REMOVE from historical-uws.json.
  const newUws = uws.filter(([id]) => id !== REMOVE_ID);
  if (newUws.length !== uws.length) {
    writeJsonAtomic(UWS_FILE, newUws);
    console.log(`  wrote ${UWS_FILE} (${uws.length} → ${newUws.length} records)`);
  }

  // -------- POST-VERIFY ---------------------------------------------------
  console.log('');
  console.log('POST-STATE:');
  const uwsAfter = readJson<UwsFile>(UWS_FILE);
  const manifestAfter = readJson<{ version: number; manifests: DealManifest[] }>(MANIFEST_FILE);
  const sr = uwsAfter.filter(([_id, u]) => /sunroad/i.test(u.dealName));
  console.log(`  Sunroad records in historical-uws: ${sr.length}`);
  for (const [id, u] of sr) console.log(`    id=${id} fileName="${u.fileName}"`);
  const sm = manifestAfter.manifests.filter((m) => /sunroad/i.test(m.dealName));
  console.log(`  Sunroad manifests: ${sm.length}`);
  for (const m of sm) {
    console.log(`    id=${m.historicalUwId} dealName="${m.dealName}"`);
    for (const [slot, entries] of Object.entries(m.slots)) {
      const arr = entries as Entry[];
      if (arr.length > 0) {
        for (const e of arr) {
          console.log(`      ${slot}: ${e.originalFileName} (${e.size} bytes, hash=${e.fileHash.slice(0, 16)}…)`);
        }
      }
    }
  }
  const keepDirAfter = fs.existsSync(keepCfDir) ? fs.readdirSync(keepCfDir) : [];
  console.log(`  KEEP/cf files on disk: [${keepDirAfter.join(', ')}]`);
  const removeDirExists = fs.existsSync(removeDir);
  console.log(`  REMOVE dir exists? ${removeDirExists ? 'YES (unexpected)' : 'no (deleted)'}`);

  console.log('');
  console.log('Migration complete.');
})();

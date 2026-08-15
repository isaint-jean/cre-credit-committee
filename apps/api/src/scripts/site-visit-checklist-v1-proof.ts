/**
 * PROOF — site-visit / PCR checklist v1 (BASE checklists + structured state).
 * READ-ONLY on cre.db (store runs in-memory). DISPLAY-ONLY / MINT-SAFE.
 *
 * Gates:
 *  (A) catalog: buildChecklist generates a NON-EMPTY base list for every AssetType;
 *      the five dedicated types keep their key; SelfStorage/MHC/MixedUse/Other/null
 *      fall back to 'Other'. Item ids are unique (they are the checked[] keys).
 *  (B) flood STUB: TRIGGERED.flood exists (catalog-ready) but a v1 buildChecklist
 *      call (no triggers) NEVER emits a trigger group — flood does not fire.
 *  (C) store: the JSON payload round-trips under fieldType 'site_visit_checklist'
 *      on the SAME servicer_inputs table (coexists with the narrative fields).
 *  (D) payload parse is defensive (malformed / legacy → empty, never throws).
 *  (E) route: the allowlist accepts 'site_visit_checklist'; PUT is servicer-gated
 *      (analysis:revise — servicer yes, buyer no).
 *  (F) display-only / mint-safe: catalog + store touch NO mint/doctrine; not coupled
 *      to the shelved negotiation surface.
 *  (G) canonical byte-identical (BMARK 17, 640 head; servicer_inputs absent).
 *
 * Run: npx tsx src/scripts/site-visit-checklist-v1-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';
import {
  ASSET_TYPES,
  buildChecklist,
  resolveChecklistAssetKey,
  parseChecklistPayload,
  summarizeChecklist,
  TRIGGERED,
  CHECKLIST_CATALOG_VERSION,
  EMPTY_CHECKLIST_PAYLOAD,
  type AssetType,
  type ChecklistPayload,
} from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const REPO = path.join(process.cwd(), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function partA(): void {
  console.log('\n(A) catalog — non-empty base list per AssetType + fallback + unique ids:');
  const dedicated = new Set<AssetType>(['Office', 'Multifamily', 'Retail', 'Industrial', 'Hotel']);
  const globalIds = new Set<string>();
  let dup = false;
  for (const at of ASSET_TYPES) {
    const cl = buildChecklist(at);
    const items = cl.groups.flatMap((g) => g.items);
    const nonEmpty = items.length > 0;
    const key = cl.assetKey;
    const expectKey = dedicated.has(at) ? at : 'Other';
    check(`${at} → non-empty (${items.length}) + assetKey '${key}'`, nonEmpty && key === expectKey, `expected key ${expectKey}`);
    // per-checklist id uniqueness (checked[] must key cleanly)
    const ids = items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) { dup = true; }
    ids.forEach((id) => globalIds.add(id));
  }
  check('no duplicate item ids within any checklist', !dup);
  // null/undefined → Other list, still non-empty
  const nullCl = buildChecklist(null);
  check('null AssetType → Other fallback, non-empty', nullCl.assetKey === 'Other' && nullCl.groups[0]!.items.length > 0);
  check("resolveChecklistAssetKey('SelfStorage') → 'Other'", resolveChecklistAssetKey('SelfStorage') === 'Other');
  check("resolveChecklistAssetKey('Office') → 'Office'", resolveChecklistAssetKey('Office') === 'Office');
  check('version stamped on the built checklist', nullCl.version === CHECKLIST_CATALOG_VERSION);
}

function partB(): void {
  console.log('\n(B) flood STUB — catalog-ready, never fires in v1:');
  check('TRIGGERED.flood exists + non-empty (catalog-ready)', Array.isArray(TRIGGERED.flood) && TRIGGERED.flood.length > 0);
  // v1: buildChecklist with no triggers emits ONLY the base group — no flood, no trigger group.
  const anyTriggerGroup = ASSET_TYPES.some((at) => buildChecklist(at).groups.some((g) => g.key.startsWith('trigger-')));
  check('v1 buildChecklist(assetType) emits NO trigger group (flood does not fire)', !anyTriggerGroup);
  const office = buildChecklist('Office');
  check('Office checklist is base-only (single group, key=base)', office.groups.length === 1 && office.groups[0]!.key === 'base');
  // proves the plumbing is activatable for v2 (not called in v1) without asserting v1 uses it
  const withFlood = buildChecklist('Office', ['flood']);
  check('flood IS activatable when explicitly passed (v2 path present)', withFlood.groups.some((g) => g.key === 'trigger-flood'));
}

function partC(): void {
  console.log('\n(C) store — JSON payload round-trips under site_visit_checklist:');
  const store = new ServicerInputsStore(':memory:');
  // coexist with a narrative field on the same loan
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit', value: 'Roof aging.', author: 'a@x.com', now: '2026-08-14T10:00:00Z' });
  const payload: ChecklistPayload = {
    checked: ['office-parking', 'office-roof'],
    added: [{ id: 'added-1', text: 'Verify monument signage lighting' }],
    preferAssetManagerVisit: true,
    assetType: 'Office',
    version: CHECKLIST_CATALOG_VERSION,
  };
  store.upsert({ poolId: 'P', loanInPoolId: 'L', fieldType: 'site_visit_checklist', value: JSON.stringify(payload), author: 'a@x.com', now: '2026-08-14T11:00:00Z' });
  const back = store.getOne('P', 'L', 'site_visit_checklist');
  check('checklist row reads back', back !== null);
  const parsed = parseChecklistPayload(back?.value ?? null);
  check('checked round-trips', parsed.checked.length === 2 && parsed.checked.includes('office-roof'));
  check('added round-trips', parsed.added.length === 1 && parsed.added[0]!.text.includes('monument'));
  check('preferAssetManagerVisit round-trips', parsed.preferAssetManagerVisit === true);
  check('coexists with site_visit narrative on the loan (2 rows)', store.listForLoan('P', 'L').length === 2);
  check('summary line renders', summarizeChecklist(parsed, 12) === 'Site-visit checklist: 2/12 complete; Asset Manager visit requested');
  store.rawDb().close();
}

function partD(): void {
  console.log('\n(D) payload parse is defensive:');
  check('malformed JSON → empty (no throw)', parseChecklistPayload('{not json') === EMPTY_CHECKLIST_PAYLOAD || parseChecklistPayload('{not json').checked.length === 0);
  check('null → empty', parseChecklistPayload(null).checked.length === 0 && parseChecklistPayload(null).preferAssetManagerVisit === false);
  const partial = parseChecklistPayload(JSON.stringify({ checked: ['x', 1, null], preferAssetManagerVisit: 'yes' }));
  check('junk fields filtered (checked strings only, AM strict-bool)', partial.checked.length === 1 && partial.checked[0] === 'x' && partial.preferAssetManagerVisit === false);
}

function partE(): void {
  console.log('\n(E) route — allowlist + servicer-gate:');
  const routes = read('apps/api/src/routes/pool.routes.ts');
  check("PUT allowlist accepts 'site_visit_checklist'", /SERVICER_INPUT_FIELDS[\s\S]{0,200}site_visit_checklist/.test(routes));
  const put = routes.slice(routes.indexOf('servicer-inputs/:fieldType'), routes.indexOf('servicer-inputs/:fieldType') + 600);
  check('PUT servicer-gated (analysis:revise)', put.includes("enforcePermission(req, res, 'analysis:revise'"));
  const roles = read('packages/contracts/src/roles.ts');
  const buyer = roles.slice(roles.indexOf('BUYER: ['), roles.indexOf('BUYER: [') + 400);
  check('BUYER does NOT have analysis:revise (write denied)', !buyer.includes("'analysis:revise'"));
}

function partF(): void {
  console.log('\n(F) display-only / mint-safe / not negotiation-coupled:');
  const catalog = read('packages/contracts/src/site-visit-checklist-catalog.ts');
  const store = read('apps/api/src/storage/servicer-inputs-store.ts');
  const noMint = (s: string) => !/evaluateAndNarrate|ingestExtractionResult|computeContentHash|DoctrineEvaluation|applyRevisionDelta|insertRevision/.test(s);
  check('catalog touches NO mint/doctrine', noMint(catalog));
  check('store touches NO mint/doctrine', noMint(store));
  check('catalog imports only the AssetType contract (no engine/negotiation)', !/overlay-patches-store|negotiation-flag|requireNegotiationLoop|doctrine-clean|render-memo/.test(catalog));
}

function partG(): void {
  console.log('\n(G) canonical byte-identical (read-only):');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='servicer_inputs'`).get();
  db.close();
  check('BMARK 17 + 640 head intact', bmark === 17 && !!head, `BMARK ${bmark}`);
  check('servicer_inputs table absent on canonical (no write happened)', !hasTable);
}

console.log('\nSite-visit checklist v1 proof (read-only on cre.db)');
partA(); partB(); partC(); partD(); partE(); partF(); partG();
console.log(failures === 0 ? '\nsite-visit checklist v1 proof: OK\n' : `\nsite-visit checklist v1 proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

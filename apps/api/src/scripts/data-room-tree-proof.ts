/**
 * PROOF — Data Room Chunk 1: the read-only nested tree (GET /:poolId/tree via
 * projectTree). READ-ONLY against the canonical cre.db. Proves the CORRECTED
 * hierarchy:
 *
 *   Deal/Pool → New Issue → Deal name → BANK → CATEGORY → loan-file
 *
 * i.e. the CATEGORY is the folder and LOANS are the leaf files inside it (a file
 * is labeled by its loan) — NOT loan-first. Checks:
 *   1. New Issue + deal-name levels present;
 *   2. BANK level from mortgageLoanSeller (GSMC, "GSMC, BMO");
 *   3. category-holds-loans — leaves are loan-labeled files directly under a category;
 *   4. Sunroad renders as a file under GSMC; 640 as a file under "GSMC, BMO";
 *   5. on-demand folders (no empty bank / category);
 *   6. counts reconcile; ordering (banks A→Z, categories canonical, files by
 *      loan→doc-type→version); one selected version per (loan, doc-type) slot.
 *
 * Run: npx tsx src/scripts/data-room-tree-proof.ts   (from apps/api)
 */
import { CATEGORIES_IN_ORDER, DOC_TYPE_TAXONOMY } from '@cre/contracts';
import type { LoanInPoolId, PoolId, DataRoomTreeFile } from '@cre/contracts';
import { projectTree, listPoolDocs } from '../services/data-room-store.service.js';
import { PoolStore } from '../storage/pool-store.js';

// The canonical pool that holds the Sunroad + 640 data-room docs (recon-verified).
const POOL_ID = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const CAT_ORDER = new Map(CATEGORIES_IN_ORDER.map((c, i) => [c, i] as const));
const SLOT_ORDER = new Map(DOC_TYPE_TAXONOMY.map((t, i) => [t.id, i] as const));

function main(): void {
  const pools = new PoolStore();
  const poolId = POOL_ID;
  const docs = listPoolDocs(poolId);
  console.log(`\nData Room tree proof — pool ${poolId} (${docs.length} docs)\n`);
  if (docs.length === 0) {
    console.error('  ✗ no data-room docs found for the pool — nothing to prove');
    process.exit(1);
  }

  const pool = pools.getPool(poolId as PoolId);
  const membership = pool?.currentTapeId ? pools.getMembership(pool.currentTapeId) : [];
  const loanInfo = new Map<string, { name: string | null; bank: string | null }>();
  for (const m of membership) {
    loanInfo.set(m.loanInPoolId, { name: m.propertyName ?? null, bank: m.mortgageLoanSeller ?? null });
  }

  const tree = projectTree(poolId, {
    poolName: pool?.shelfName ?? null,
    seller: pool?.seller ?? null,
    resolveLoan: (id) => {
      const info = loanInfo.get(id);
      const name = info?.name ?? pools.getLoanInPool(id as LoanInPoolId)?.dealRef ?? null;
      return { name, bank: info?.bank ?? null };
    },
  });

  // 1 — New Issue + deal-name levels present.
  check('New Issue level present', tree.newIssue !== null);
  const ni = tree.newIssue!;
  check('deal-name repeat under New Issue == pool name', ni.dealName === (pool?.shelfName ?? null), `${ni.dealName}`);

  // 2 — BANK level from mortgageLoanSeller.
  const bankNames = ni.banks.map((b) => b.bank);
  check('bank level present (from mortgageLoanSeller)', ni.banks.length > 0, bankNames.join(' | '));
  check('GSMC bank present (Sunroad)', bankNames.includes('GSMC'));
  check('"GSMC, BMO" co-seller bank present (640)', bankNames.includes('GSMC, BMO'));
  check('banks in A→Z order', bankNames.every((b, i) => i === 0 || bankNames[i - 1]!.localeCompare(b) <= 0), bankNames.join(', '));

  // flatten every leaf file, remembering its bank + category.
  const leaves: { bank: string; category: string; file: DataRoomTreeFile }[] = [];
  for (const b of ni.banks) for (const c of b.categories) for (const f of c.files) leaves.push({ bank: b.bank, category: c.category, file: f });

  // 3 — category-holds-loans (the inversion): the leaf is a FILE labeled by a
  //     loan, sitting DIRECTLY under a category (there is no loan folder level).
  check('every leaf is a loan-labeled file (no loan subfolder)', leaves.every((l) => typeof l.file.loanName === 'string' && l.file.loanName.length > 0));
  check('every leaf carries its doc-type as metadata', leaves.every((l) => l.file.docType.length > 0 && l.file.docTypeLabel.length > 0));

  // 4 — Sunroad under GSMC, 640 under "GSMC, BMO".
  const sunroad = leaves.find((l) => l.file.loanName.toLowerCase().includes('sunroad'));
  const sixforty = leaves.find((l) => l.file.loanName.toLowerCase().includes('640'));
  check('Sunroad is a FILE under the GSMC bank', !!sunroad && sunroad.bank === 'GSMC', sunroad ? `${sunroad.file.loanName} @ ${sunroad.bank} / ${sunroad.category}` : '(not found)');
  check('640 is a FILE under the "GSMC, BMO" bank', !!sixforty && sixforty.bank === 'GSMC, BMO', sixforty ? `${sixforty.file.loanName} @ ${sixforty.bank} / ${sixforty.category}` : '(not found)');

  // 5 — on-demand folders: no empty bank / category.
  let empties = 0;
  for (const b of ni.banks) {
    if (b.fileCount === 0 || b.categories.length === 0) empties++;
    for (const c of b.categories) {
      if (c.fileCount === 0 || c.files.length === 0 || c.files.length !== c.fileCount) empties++;
    }
  }
  check('no empty bank / category (on-demand folders)', empties === 0, `${empties} empties`);

  // 6 — counts reconcile.
  const bankSum = ni.banks.reduce((n, b) => n + b.fileCount, 0);
  const leafSum = leaves.length;
  check('tree.fileCount == listPoolDocs length', tree.fileCount === docs.length, `${tree.fileCount} == ${docs.length}`);
  check('tree.fileCount == Σ bank.fileCount', tree.fileCount === bankSum, `${tree.fileCount} == ${bankSum}`);
  check('tree.fileCount == leaf count', tree.fileCount === leafSum, `${tree.fileCount} == ${leafSum}`);

  // ordering: categories canonical, files by loan→doc-type→version.
  let orderViolations = 0;
  for (const b of ni.banks) {
    for (let i = 1; i < b.categories.length; i++) {
      if (CAT_ORDER.get(b.categories[i - 1]!.category)! >= CAT_ORDER.get(b.categories[i]!.category)!) orderViolations++;
    }
    for (const c of b.categories) {
      for (let i = 1; i < c.files.length; i++) {
        const a = c.files[i - 1]!, cur = c.files[i]!;
        const cmp = a.loanName.localeCompare(cur.loanName)
          || (SLOT_ORDER.get(a.docType)! - SLOT_ORDER.get(cur.docType)!)
          || (a.versionIndex - cur.versionIndex);
        if (cmp > 0) orderViolations++;
      }
    }
  }
  check('categories canonical + files ordered (loan→doc-type→version)', orderViolations === 0, `${orderViolations} violations`);

  // version tiebreak: exactly one selected per (loan, doc-type) slot; multi-version exists.
  const bySlot = new Map<string, DataRoomTreeFile[]>();
  for (const l of leaves) {
    const k = `${l.file.loanInPoolId} ${l.file.docType}`;
    (bySlot.get(k) ?? bySlot.set(k, []).get(k)!).push(l.file);
  }
  let badSelected = 0, multiVersion = 0;
  for (const [, versions] of bySlot) {
    if (versions.filter((v) => v.isSelectedVersion).length !== 1) badSelected++;
    if (versions.length > 1) multiVersion++;
    if (versions.some((v) => v.versionCount !== versions.length)) badSelected++;
  }
  check('exactly one selected version per (loan, doc-type) slot', badSelected === 0, `${badSelected} bad slots`);
  check('at least one multi-version slot present (badges exercised)', multiVersion > 0, `${multiVersion} multi-version slots`);

  // read-only invariant.
  check('read-only — doc count unchanged after projection', listPoolDocs(poolId).length === docs.length);

  console.log(
    failures === 0
      ? `\ndata-room tree proof: OK (${ni.banks.length} banks, ${tree.fileCount} files; New Issue → Deal → Bank → Category → loan-file verified)\n`
      : `\ndata-room tree proof: ${failures} FAILURE(S)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();

/**
 * PROOF — Data Room Chunk 1: the read-only nested tree (GET /:poolId/tree via
 * projectTree). Runs against the canonical cre.db, READ-ONLY (projectTree is a
 * pure projection; this script never writes). Proves:
 *
 *   1. structure — Deal → Loan → Category → docType slot → file, nested correctly;
 *   2. on-demand folders — no empty loan / category / slot node is ever emitted;
 *   3. real data — the pool's real loans (Sunroad Centrum, 640 Fifth Ave) render
 *      with their real doc-types;
 *   4. counts — pool.fileCount == Σ loan == Σ slot files == listPoolDocs length;
 *   5. ordering — categories in CATEGORIES_IN_ORDER, slots in taxonomy order,
 *      versions newest-first;
 *   6. version badges — exactly one selected version per slot; a multi-version
 *      slot exists (640) and its badges are consistent.
 *
 * Run: npx tsx apps/api/src/scripts/data-room-tree-proof.ts
 */
import { CATEGORIES_IN_ORDER, DOC_TYPE_TAXONOMY } from '@cre/contracts';
import type { LoanInPoolId, PoolId } from '@cre/contracts';
import { projectTree, listPoolDocs } from '../services/data-room-store.service.js';
import { PoolStore } from '../storage/pool-store.js';

// The canonical pool that holds the Sunroad + 640 data-room docs (recon-verified).
const POOL_ID = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
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

  const tree = projectTree(poolId, {
    poolName: pools.getPool(poolId as PoolId)?.shelfName ?? null,
    seller: pools.getPool(poolId as PoolId)?.seller ?? null,
    resolveLoanName: (id) => {
      const loan = pools.getLoanInPool(id as LoanInPoolId);
      return loan?.propertyName ?? loan?.dealRef ?? null;
    },
  });

  // 1 + 4 — structure + count reconciliation.
  const loanSum = tree.loans.reduce((n, l) => n + l.fileCount, 0);
  const slotFileSum = tree.loans.reduce(
    (n, l) => n + l.categories.reduce((m, c) => m + c.slots.reduce((k, s) => k + s.files.length, 0), 0),
    0,
  );
  check('tree has loans', tree.loans.length > 0, `${tree.loans.length} loans`);
  check('pool.fileCount == listPoolDocs length', tree.fileCount === docs.length, `${tree.fileCount} == ${docs.length}`);
  check('pool.fileCount == Σ loan.fileCount', tree.fileCount === loanSum, `${tree.fileCount} == ${loanSum}`);
  check('pool.fileCount == Σ slot files', tree.fileCount === slotFileSum, `${tree.fileCount} == ${slotFileSum}`);

  // 2 — on-demand folders: no empty node anywhere.
  let emptyNodes = 0;
  for (const loan of tree.loans) {
    if (loan.fileCount === 0 || loan.categories.length === 0) emptyNodes++;
    for (const cat of loan.categories) {
      if (cat.fileCount === 0 || cat.slots.length === 0) emptyNodes++;
      const catSum = cat.slots.reduce((k, s) => k + s.files.length, 0);
      if (catSum !== cat.fileCount) emptyNodes++;
      for (const slot of cat.slots) if (slot.files.length === 0) emptyNodes++;
    }
  }
  check('no empty loan / category / slot nodes (on-demand folders)', emptyNodes === 0, `${emptyNodes} empties`);

  // 5 — ordering: categories in CATEGORIES_IN_ORDER, slots in taxonomy order,
  //     versions newest-first.
  let orderViolations = 0;
  const newestFirstBad: string[] = [];
  for (const loan of tree.loans) {
    for (let i = 1; i < loan.categories.length; i++) {
      if (CAT_ORDER.get(loan.categories[i - 1]!.category)! >= CAT_ORDER.get(loan.categories[i]!.category)!) orderViolations++;
    }
    for (const cat of loan.categories) {
      for (let i = 1; i < cat.slots.length; i++) {
        if (SLOT_ORDER.get(cat.slots[i - 1]!.docType)! >= SLOT_ORDER.get(cat.slots[i]!.docType)!) orderViolations++;
      }
      for (const slot of cat.slots) {
        for (let i = 1; i < slot.files.length; i++) {
          const a = slot.files[i - 1]!;
          const b = slot.files[i]!;
          // newest-first: a should not be OLDER than b.
          const ad = a.docEffectiveDate, bd = b.docEffectiveDate;
          const older = ad && bd ? ad < bd : ad && !bd ? false : !ad && bd ? true : a.uploadedAt < b.uploadedAt;
          if (older) newestFirstBad.push(`${slot.docType}: ${a.fileName}`);
          // versionIndex is 1-based, sequential.
          if (a.versionIndex !== i || b.versionIndex !== i + 1) orderViolations++;
        }
      }
    }
  }
  check('categories + slots in canonical order', orderViolations === 0, `${orderViolations} violations`);
  check('versions newest-first within each slot', newestFirstBad.length === 0, newestFirstBad.slice(0, 3).join('; '));

  // 6 — exactly one selected version per slot; a multi-version slot exists.
  let multiVersionSlots = 0;
  let badSelected = 0;
  for (const loan of tree.loans) {
    for (const cat of loan.categories) {
      for (const slot of cat.slots) {
        const selected = slot.files.filter((f) => f.isSelectedVersion).length;
        if (selected !== 1) badSelected++;
        if (slot.files.length > 1) multiVersionSlots++;
        // versionCount == files.length on every file.
        if (slot.files.some((f) => f.versionCount !== slot.files.length)) badSelected++;
      }
    }
  }
  check('exactly one selected version per slot', badSelected === 0, `${badSelected} bad slots`);
  check('at least one multi-version slot present (version badges exercised)', multiVersionSlots > 0, `${multiVersionSlots} multi-version slots`);

  // 3 — real data: Sunroad + 640 loans render with real docs.
  const names = tree.loans.map((l) => (l.propertyName ?? l.loanInPoolId).toLowerCase());
  const sunroad = tree.loans.find((l) => (l.propertyName ?? '').toLowerCase().includes('sunroad'));
  const sixforty = tree.loans.find((l) => (l.propertyName ?? '').toLowerCase().includes('640'));
  check('Sunroad loan present in tree', !!sunroad, sunroad?.propertyName ?? '(not found)');
  check('640 loan present in tree', !!sixforty, sixforty?.propertyName ?? '(not found)');
  if (sunroad) {
    const slotIds = sunroad.categories.flatMap((c) => c.slots.map((s) => s.docType));
    check('Sunroad has real doc-types', slotIds.length > 0, slotIds.join(', '));
  }
  if (!sunroad && !sixforty) {
    console.log(`    (loan names seen: ${names.join(' | ')})`);
  }

  // Read-only invariant: listPoolDocs unchanged after projection.
  check('read-only — doc count unchanged after projection', listPoolDocs(poolId).length === docs.length);

  console.log(
    failures === 0
      ? `\ndata-room tree proof: OK (${tree.loans.length} loans, ${tree.fileCount} files, structure + ordering + on-demand + versions verified)\n`
      : `\ndata-room tree proof: ${failures} FAILURE(S)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();

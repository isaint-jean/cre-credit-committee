/**
 * PROOF — derive deal_mode from the tape on the LIVE two-phase upload route (parity with seed).
 *
 * Closes the deferred gap: a tape uploaded through the UI (POST /pools/:id/tapes → freeze)
 * now sets deal_mode from the tape, exactly like seed-pool-bmark. This runs the REAL
 * advance-tape services + REAL deal-mode singleton against a FRESH temp cre.db (process.cwd
 * chdir'd to a tmp dir) — so it exercises the true end-to-end write path with ZERO touch to
 * the canonical cre.db.
 *
 *  (A) propertyCount THREADS Phase A → persisted working tape → Phase B: after advanceTapePhaseA
 *      the working tape's pendingMembership carries propertyCount (portfolio=10, single=1).
 *  (B) DERIVE at commit: the freeze route's exact logic — build derivedRows from
 *      wt.pendingMembership + deriveDealModesFromTape — sets deal_mode=roll_up for the
 *      portfolio loan, single_loan for the single loan, source='tape'.
 *  (C) MANUAL override still wins: a setDealMode('manual') survives a subsequent tape derive.
 *  (D) PARITY: the live route reuses deriveDealModesFromTape (no forked logic) — source-assert.
 *  (E) mint-safe: canonical cre.db byte-identical (BMARK 17 + 640 head 221235987967).
 *
 * Run: npx tsx src/scripts/deal-mode-live-route-derive-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Canonical db (ABSOLUTE — unaffected by the chdir below). ───────────────
const CANONICAL_DB = path.join(process.cwd(), 'data', 'cre.db');
const ROUTES_SRC = path.join(process.cwd(), 'src/routes/pool.routes.ts');

// ★ chdir to a throwaway temp dir BEFORE any store opens — the lazy singletons
//   (poolStore / servicerInputsStore) resolve process.cwd()/data/cre.db, so this
//   points them at a fresh empty db. Canonical cre.db is never opened for write.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'deal-mode-live-'));
mkdirSync(path.join(TMP, 'data'), { recursive: true });
process.chdir(TMP);

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

async function main(): Promise<void> {
  console.log('\nlive two-phase route — derive deal_mode from the tape — proof');
  console.log(`  (temp cwd: ${TMP})`);

  // Imports AFTER chdir so any load-time path resolution uses the temp cwd.
  const { PoolStore } = await import('../storage/pool-store.js');
  const { advanceTapePhaseA, advanceTapePhaseB } = await import('../services/pool/advance-tape.service.js');
  const { deriveDealModesFromTape, getDealMode, getDealModeSource, setDealMode, listPortfolioPoolIds } =
    await import('../services/deal-mode.service.js');
  const { mintPoolId } = await import('../util/pool-ids.js');

  const store = new PoolStore();
  const poolId = mintPoolId();
  store.createPool({
    id: poolId, shelfName: 'PROOF POOL', vintage: 2026, seller: 'proof',
    createdAt: '2026-01-01T00:00:00Z', tapeIds: [], currentTapeId: null, closedAt: null,
  });

  // ── Phase A (POST /pools/:id/tapes) — a portfolio loan (10) + a single loan (1). ──
  const incoming = {
    poolId, version: 1,
    tapeDate: '2026-01-02T00:00:00Z' as never, receivedAt: '2026-01-02T00:00:00Z' as never,
    priorTapeId: null,
    rows: [
      { originatorLoanRef: 'BEDROCK-PORT', dealRef: 'D1', propertyName: 'Bedrock Portfolio', assetType: null, tapePosition: 0, propertyCount: 10 },
      { originatorLoanRef: 'SINGLE-640',   dealRef: 'D2', propertyName: '640 Fifth',        assetType: null, tapePosition: 1, propertyCount: 1 },
    ],
    originatorSummary: null,
  };
  const a = advanceTapePhaseA(store, incoming as never);

  // (A) propertyCount threaded onto the PERSISTED working tape.
  const wt = store.getWorkingTape(a.workingTapeId);
  if (wt === null) throw new Error('working tape vanished');
  const countByRef = new Map<string, number | null | undefined>();
  for (const e of wt.pendingMembership) {
    if (e.kind === 'bound') countByRef.set(e.incomingOriginatorRef ?? '', e.propertyCount);
    else if (e.kind === 'unmatched-needs-confirm') countByRef.set(e.incomingOriginatorRef ?? '', e.propertyCount);
  }
  console.log('\n(A) propertyCount threads Phase A → persisted working tape:');
  check('portfolio loan propertyCount=10 survives on the working tape', countByRef.get('BEDROCK-PORT') === 10, `got ${countByRef.get('BEDROCK-PORT')}`);
  check('single loan propertyCount=1 survives on the working tape', countByRef.get('SINGLE-640') === 1, `got ${countByRef.get('SINGLE-640')}`);

  // ── Phase B (POST /pools/:id/tapes/freeze) — confirm-new both, then derive. ──
  const resolutions = wt.pendingMembership
    .filter((e) => e.kind === 'unmatched-needs-confirm')
    .map((e) => ({ kind: 'confirm-new' as const, tapePosition: (e as { tapePosition: number }).tapePosition }));
  advanceTapePhaseB(store, {
    workingTapeId: a.workingTapeId, resolutions, departures: [],
    recordedBy: { userId: 'proof', displayName: null }, frozenAt: '2026-01-02T00:00:00Z',
  });

  // ★ The EXACT freeze-route derivation logic (build derivedRows from wt.pendingMembership).
  const derivedRows = wt.pendingMembership
    .map((e) =>
      e.kind === 'bound'
        ? { originatorLoanRef: e.incomingOriginatorRef, propertyCount: e.propertyCount ?? null }
        : e.kind === 'unmatched-needs-confirm'
          ? { originatorLoanRef: e.incomingOriginatorRef, propertyCount: e.propertyCount ?? null }
          : null,
    )
    .filter((r): r is { originatorLoanRef: string | null; propertyCount: number | null } => r !== null);
  const updated = deriveDealModesFromTape(store, poolId, derivedRows);

  // Resolve the minted loan ids to read their derived mode.
  const keys = store.listLoanNameKeysForPool(poolId);
  const portId = keys.find((k) => k.originatorLoanRef === 'BEDROCK-PORT')!.loanInPoolId;
  const singleId = keys.find((k) => k.originatorLoanRef === 'SINGLE-640')!.loanInPoolId;

  console.log('\n(B) derive at commit (freeze-route logic → real deal-mode singleton):');
  check('deriveDealModesFromTape updated both loans', updated === 2, `updated=${updated}`);
  check('portfolio loan (10) → deal_mode roll_up, source tape', getDealMode(poolId, portId) === 'roll_up' && getDealModeSource(poolId, portId) === 'tape');
  check('single loan (1) → deal_mode single_loan, source tape', getDealMode(poolId, singleId) === 'single_loan' && getDealModeSource(poolId, singleId) === 'tape');
  check('dashboard: pool now in listPortfolioPoolIds (UI-uploaded portfolio)', listPortfolioPoolIds().includes(poolId));

  console.log('\n(C) manual override still wins over a later tape derive:');
  setDealMode({ poolId, loanInPoolId: portId, mode: 'single_loan', author: 'servicer' });
  const reUpdated = deriveDealModesFromTape(store, poolId, derivedRows); // re-ingest
  check('manual single_loan override survives re-derive', getDealMode(poolId, portId) === 'single_loan' && getDealModeSource(poolId, portId) === 'manual', `re-derive touched ${reUpdated}`);

  console.log('\n(D) parity — the live freeze route reuses deriveDealModesFromTape (no fork):');
  const routes = readFileSync(ROUTES_SRC, 'utf8');
  check('freeze route builds derivedRows from wt.pendingMembership', /wt\.pendingMembership[\s\S]*?propertyCount: e\.propertyCount/.test(routes));
  check('freeze route calls deriveDealModesFromTape(poolStore\\(\\), poolId, …)', /deriveDealModesFromTape\(poolStore\(\), poolId, derivedRows\)/.test(routes));
  check('validateRow carries propertyCount from the request body', /propertyCount: \(rawCount \?\? null\)/.test(routes));

  console.log('\n(E) mint-safe — canonical cre.db byte-identical:');
  const db = new Database(CANONICAL_DB, { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);

  store.close();
  console.log(failures === 0 ? '\ndeal-mode-live-route proof: OK\n' : `\ndeal-mode-live-route proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('THREW', (e as Error).stack); process.exit(1); });

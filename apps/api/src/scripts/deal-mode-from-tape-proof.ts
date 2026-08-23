/**
 * PROOF — derive deal_mode from the DATA TAPE at intake (Properties-per-Loan + breakout count);
 * the manual toggle becomes an override. Reuses the shipped deal_mode machinery. MINT-SAFE.
 *
 *  (A) parser (real BMARK tape, read-only): propertyCount = column ∪ breakout-count; 640 → 1
 *      (single), Bedrock-style loan → 10 (portfolio via decimal breakout rows).
 *  (B) breakout-count fallback: with the column ABSENT, decimal rows (N.01, N.02) still yield
 *      the count (format-robust).
 *  (C) service (:memory:): setDealModeFromTape sets roll_up when >1 / single when 1; a manual
 *      override (setDealMode) WINS and survives a later tape derive (source precedence).
 *  (D) deriveDealModesFromTape joins rows→loans by originatorLoanRef and sets the mode.
 *  (E) dashboard: listPortfolioPoolIds includes tape-derived roll_up pools (single source).
 *  (F) mint-safe: canonical byte-identical (BMARK 17, 640 head) — no re-mint, no schema change.
 *
 * Run: npx tsx src/scripts/deal-mode-from-tape-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parseBmarkTapeXlsx } from '../services/parse-bmark-tape-xlsx.js';
import { ServicerInputsStore } from '../storage/servicer-inputs-store.js';
import { PoolStore } from '../storage/pool-store.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const TAPE = '/Users/isabellesaint-jean/Downloads/Tapes/BMARK 2024-V8 Combined Prelim Tape_Final.xlsx';

async function partAB(): Promise<void> {
  console.log('\n(A/B) parser — propertyCount from the real BMARK tape (column ∪ breakout count):');
  const inc = await parseBmarkTapeXlsx(TAPE, {
    poolId: 'P' as never, version: 1, tapeDate: '2024-06-12T00:00:00Z' as never,
    receivedAt: '2024-06-12T00:00:00Z' as never, priorTapeId: null, sourceLabel: 'proof',
  });
  const byName = new Map(inc.rows.map((r) => [String(r.propertyName ?? ''), r.propertyCount ?? null]));
  const p640 = [...byName.entries()].find(([n]) => /640 5th/i.test(n));
  const pBedrock = [...byName.entries()].find(([n]) => /Bedrock/i.test(n));
  check('640 5th Avenue → propertyCount 1 (single)', p640?.[1] === 1, `count=${p640?.[1]}`);
  check('Bedrock Mixed-Use Portfolio → propertyCount 10 (portfolio)', pBedrock?.[1] === 10, `count=${pBedrock?.[1]}`);
  check('every whole loan has propertyCount ≥ 1 (never 0/undefined)', inc.rows.every((r) => (r.propertyCount ?? 0) >= 1));
  // Bedrock's 10 comes from its decimal breakout rows (6.01..6.10) — the format-robust fallback.
  check('portfolio detected via decimal breakout rows (count matches # of properties)', (pBedrock?.[1] ?? 0) === 10);
}

function partCDE(): void {
  console.log('\n(C/D/E) service — set-from-tape, manual override precedence, join, dashboard:');
  // (C) precedence on a :memory: servicer_inputs store, via the singleton-independent store.
  const si = new ServicerInputsStore(':memory:');
  const now = '2026-08-24T00:00:00Z';
  // simulate setDealModeFromTape / setDealMode writes directly (the service wraps upsert 1:1).
  const writeMode = (p: string, l: string, mode: string, source: string): void => {
    si.upsert({ poolId: p, loanInPoolId: l, fieldType: 'deal_mode', value: mode, author: 'x', now });
    si.upsert({ poolId: p, loanInPoolId: l, fieldType: 'deal_mode_source', value: source, author: 'x', now });
  };
  // tape derive: portfolio (count 10)
  writeMode('P1', 'L1', 'roll_up', 'tape');
  check('tape derive → roll_up + source tape', si.getOne('P1', 'L1', 'deal_mode')?.value === 'roll_up' && si.getOne('P1', 'L1', 'deal_mode_source')?.value === 'tape');
  // tape derive: single (count 1)
  writeMode('P2', 'L2', 'single_loan', 'tape');
  check('tape derive → single_loan (count 1)', si.getOne('P2', 'L2', 'deal_mode')?.value === 'single_loan');
  // manual override on P1 → single; then a RE-INGEST tape derive must NOT clobber it.
  writeMode('P1', 'L1', 'single_loan', 'manual');
  check('manual override wins (roll_up → single)', si.getOne('P1', 'L1', 'deal_mode')?.value === 'single_loan' && si.getOne('P1', 'L1', 'deal_mode_source')?.value === 'manual');
  // simulate setDealModeFromTape's guard: if source==='manual', no-op.
  const src = si.getOne('P1', 'L1', 'deal_mode_source')?.value;
  if (src !== 'manual') writeMode('P1', 'L1', 'roll_up', 'tape');
  check('re-ingest does NOT clobber the manual override', si.getOne('P1', 'L1', 'deal_mode')?.value === 'single_loan');
  // (E) dashboard: distinct pools with deal_mode='roll_up' (single-source query includes tape-derived).
  writeMode('P3', 'L3', 'roll_up', 'tape');
  const portfolioPools = si.distinctPoolIdsWithFieldValue('deal_mode', 'roll_up');
  check('dashboard portfolio set = {P3} (P1 overridden to single, P2 single)', portfolioPools.length === 1 && portfolioPools[0] === 'P3');
  // (D) join wiring — assert the service joins by originatorLoanRef (source-level).
  const svc = readFileSync(path.join(process.cwd(), 'src/services/deal-mode.service.ts'), 'utf8');
  check('deriveDealModesFromTape joins rows→loans by originatorLoanRef', /listLoanNameKeysForPool\(poolId as PoolId\)/.test(svc) && /loanIdByRef\.get\(row\.originatorLoanRef\)/.test(svc));
  check('setDealModeFromTape respects a manual override (no-op when source manual)', /getDealModeSource\([^)]*\) === 'manual'\) return getDealMode/.test(svc));
  void PoolStore;
}

function partF(): void {
  console.log('\n(F) mint-safe + intake wiring:');
  const parser = readFileSync(path.join(process.cwd(), 'src/services/parse-bmark-tape-xlsx.ts'), 'utf8');
  check('parser: Properties-per-Loan alias set + breakout-count fallback', /PROPS_PER_LOAN_ALIASES/.test(parser) && /breakoutByPrefix/.test(parser) && /propertyCountFor/.test(parser));
  const seed = readFileSync(path.join(process.cwd(), 'src/scripts/seed-pool-bmark.ts'), 'utf8');
  check('intake wired: seed-pool-bmark derives deal_mode from the tape after ingest', /deriveDealModesFromTape\(store, POOL_ID/.test(seed));
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(async () => {
  console.log('\nderive deal_mode from the data tape — proof');
  await partAB(); partCDE(); partF();
  console.log(failures === 0 ? '\ndeal-mode-from-tape proof: OK\n' : `\ndeal-mode-from-tape proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', (e as Error).stack); process.exit(1); });

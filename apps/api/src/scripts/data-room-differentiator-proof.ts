/**
 * PROOF — Data Room differentiator (Tier 1 + 1.5). READ-ONLY against cre.db.
 * Proves the server-side linkage the UI relies on:
 *   - loan dealRef → lookupAnalysisByDealRef resolves for Sunroad + 640 (Tier 1);
 *   - an unresolvable dealRef → no match → analysisId null (graceful "no underwriting");
 *   - projectTree stamps each file leaf with its loan's resolved analysisId;
 *   - the resolved analysis EXISTS (so /analyses/:id score+flags and
 *     /:id/intake-completeness — the Tier 1 + 1.5 fetches — will succeed).
 * No engine changes, no writes; canonical byte-identical.
 *
 * Run: npx tsx src/scripts/data-room-differentiator-proof.ts   (from apps/api)
 */
import { store } from '../storage/sqlite-store.js';
import { PoolStore } from '../storage/pool-store.js';
import { projectTree } from '../services/data-room-store.service.js';
import type { LoanInPoolId, PoolId, DataRoomTreeFile } from '@cre/contracts';

const BMARK = '323a1d02-aa5f-4a80-b280-b861fe76f6d9';
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function main(): void {
  const pools = new PoolStore();
  console.log('\nData Room differentiator proof (Tier 1 + 1.5; read-only)\n');

  // 1 — resolution (the fuzzy hop-2 resolver the tree uses).
  const sun = store.lookupAnalysisByDealRef('bmark2024v8-sunroad-centrum');
  const ftf = store.lookupAnalysisByDealRef('bmark2024v8-640-5th-avenue');
  const bogus = store.lookupAnalysisByDealRef('__no_such_dealref__');
  check('Sunroad dealRef resolves to an analysis', sun.length > 0 && !!(sun[0]!.graphId ?? sun[0]!.legacyId));
  check('640 dealRef resolves to an analysis', ftf.length > 0 && !!(ftf[0]!.graphId ?? ftf[0]!.legacyId));
  check('bogus dealRef → no match (graceful null)', bogus.length === 0);

  // The route's memoized resolver (same logic).
  const cache = new Map<string, string | null>();
  const resolveAnalysisId = (loanInPoolId: string): string | null => {
    if (cache.has(loanInPoolId)) return cache.get(loanInPoolId)!;
    const dealRef = pools.getLoanInPool(loanInPoolId as LoanInPoolId)?.dealRef ?? null;
    let id: string | null = null;
    if (dealRef) { const m = store.lookupAnalysisByDealRef(dealRef); id = m[0] ? (m[0].graphId ?? m[0].legacyId ?? null) : null; }
    cache.set(loanInPoolId, id);
    return id;
  };
  check('unresolvable loan → analysisId null (graceful)', resolveAnalysisId('__not_a_loan__') === null);

  // 2 — projectTree stamps analysisId on each file leaf.
  const pool = pools.getPool(BMARK as PoolId);
  const membership = pool?.currentTapeId ? pools.getMembership(pool.currentTapeId) : [];
  const info = new Map<string, { name: string | null; bank: string | null }>(
    membership.map((m) => [m.loanInPoolId as string, { name: m.propertyName ?? null, bank: m.mortgageLoanSeller ?? null }]),
  );
  const tree = projectTree(BMARK, {
    poolName: pool?.shelfName ?? null,
    seller: pool?.seller ?? null,
    resolveLoan: (id) => ({ name: info.get(id)?.name ?? null, bank: info.get(id)?.bank ?? null, analysisId: resolveAnalysisId(id) }),
  });
  const leaves: DataRoomTreeFile[] = (tree.newIssue?.banks ?? []).flatMap((b) => b.categories.flatMap((c) => c.files));
  const sunLeaf = leaves.find((f) => f.loanName.toLowerCase().includes('sunroad'));
  const ftfLeaf = leaves.find((f) => f.loanName.toLowerCase().includes('640'));
  check('Sunroad file leaf carries a non-null analysisId', !!sunLeaf?.analysisId, sunLeaf?.analysisId?.slice(0, 12));
  check('640 file leaf carries a non-null analysisId', !!ftfLeaf?.analysisId, ftfLeaf?.analysisId?.slice(0, 12));
  check('every leaf has the analysisId field (null or set)', leaves.every((f) => 'analysisId' in f));

  // 2b — Verdict visibility is gated to ingest=true (docs that fed underwriting).
  const ingestLeaves = leaves.filter((f) => f.ingest);
  const recordOnly = leaves.filter((f) => !f.ingest);
  check('every leaf carries ingest', leaves.every((f) => typeof f.ingest === 'boolean'));
  check('Verdict-eligible (ingest=true) leaves present', ingestLeaves.length > 0, `${ingestLeaves.length} files`);
  check('record-only (ingest=false) leaves present — NO Verdict button', recordOnly.length > 0, `${recordOnly.length} files`);
  check('ingest docTypes are the extracting ones', ingestLeaves.every((f) => ['asr', 'cf', 'rent_roll', 'pca', 'appraisal'].includes(f.docType)), Array.from(new Set(ingestLeaves.map((f) => f.docType))).join(','));
  check('record-only docTypes do NOT feed underwriting', recordOnly.every((f) => ['occupancy', 'phase_i_esa', 'seller_uw', 't12'].includes(f.docType)), Array.from(new Set(recordOnly.map((f) => f.docType))).join(','));

  // 3 — the resolved analysis EXISTS (the Tier-1/1.5 fetches will succeed).
  const legacyId = ftf[0]!.legacyId;
  if (legacyId) {
    check('640 resolved analysis exists (getAnalysis)', !!store.getAnalysis(legacyId), legacyId.slice(0, 12));
  } else {
    check('640 resolved to a graph id (no legacy row)', !!ftf[0]!.graphId);
  }

  console.log(failures === 0 ? '\ndata-room differentiator proof: OK\n' : `\ndata-room differentiator proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

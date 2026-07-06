/**
 * Sunroad registry repair — Phase 2 (score-neutral, one-off, additive).
 *
 *   tsx src/scripts/repair-sunroad-registry.ts [--db <path>] [--commit]
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
 * Sunroad's 4 `revision_evaluation_context` rows
 *   (3454c89f, 599f527, a7bb1a83, 617d77ce)
 * record that those revisions were evaluated against
 *   MarketBenchmarks 5ba8f6b2489156ffe95c157fbcb01955af1b1e8df27e3233bf91267cdc26ad15
 *   CreditManifesto  49d95f78544ff08e722e54c4540b42fe6aeb862f95719f15d8091e4b4df45266
 * but those registry rows were NEVER persisted (the pre-Phase-1 ingest defect:
 * it scored against an INLINE registry, computed + wrote the context id, but
 * never persisted the registry itself). Phase 1 closed the go-forward defect;
 * this repairs the 4 EXISTING orphans by re-persisting the ORIGINAL registry.
 *
 * ── HOW IT'S SOUND ──────────────────────────────────────────────────────────
 * The registry is content-addressed. We RECONSTRUCT Sunroad's exact Office
 * benchmarks/manifesto (the same inline objects the deal was scored against, as
 * carried by sunroad-signed-lease-reingest.ts), then HASH-VERIFY that the
 * reconstruction hashes to the EXACT referenced ids BEFORE inserting anything.
 * If either hash misses → STOP, insert NOTHING (inserting other content would be
 * a silent re-underwrite). Because we re-persist the ORIGINAL content under its
 * OWN id, the insert is purely additive: no revision, no doctrine eval, no score
 * is touched — it only makes the 4 dangling ids resolve.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *   - `--db <path>` aware; opens ONLY that db via a fresh RecordGraphStore.
 *   - Dry-run by default; `--commit` performs the (idempotent) inserts.
 *   - Idempotent: insertMarketBenchmarks / insertCreditManifesto are
 *     ON CONFLICT(id) DO NOTHING; re-running is a no-op.
 *   - Additive: touches ONLY market_benchmarks / manifesto_registry (+2 rows,
 *     or 0 on a repeat). Contexts / dispositions / analyses are never written.
 */
import path from 'path';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { computeMarketBenchmarksId, computeCreditManifestoId } from '../util/content-hash.js';
import { MANIFESTO_CONTRACT_VERSION } from '@cre/contracts';
import type { MarketBenchmarks, CreditManifesto, RevisionId } from '@cre/contracts';

/** The 4 Sunroad revisions whose eval contexts orphan the registry. */
const SUNROAD_REVISION_PREFIXES = ['3454c89f', '599f527', 'a7bb1a83', '617d77ce'] as const;

/** ★ The exact ids the 4 contexts reference — the load-bearing gate. */
const TARGET_MB_ID = '5ba8f6b2489156ffe95c157fbcb01955af1b1e8df27e3233bf91267cdc26ad15';
const TARGET_CM_ID = '49d95f78544ff08e722e54c4540b42fe6aeb862f95719f15d8091e4b4df45266';

const ALL_ASSET_TYPES = [
  'Office', 'Retail', 'Multifamily', 'Hotel', 'Industrial',
  'SelfStorage', 'MHC', 'MixedUse', 'Other',
] as const;

/** Reconstruct Sunroad's ORIGINAL Office registry — VERBATIM the inline objects
 *  from sunroad-signed-lease-reingest.ts (the deal was scored against these).
 *  `asOf` is the analysisAsOfDate the registry was keyed on. */
function reconstructRegistry(asOf: string): { mb: MarketBenchmarks; cm: CreditManifesto } {
  const fill = (dflt: number | null, office: number): Record<string, number | null> =>
    Object.fromEntries(ALL_ASSET_TYPES.map((t) => [t, t === 'Office' ? office : dflt]));

  const mbBody = {
    asOfDate: asOf,
    capRates: fill(null, 0.075),
    vacancyRates: fill(0.05, 0.10),
    expensesPerSqFt: fill(8.50, 8.50),
    interestRateAssumptions: { baseRate: 0.065, stressRate: 0.085 },
    marketLiquidityIndex: { primary: 0.85, secondary: 0.55, tertiary: 0.30 },
  };
  const mb = { id: computeMarketBenchmarksId(mbBody as never), ...mbBody } as never as MarketBenchmarks;

  const cmBody = {
    analysisAsOfDate: asOf,
    manifestoContractVersion: MANIFESTO_CONTRACT_VERSION,
    rules: [],
  };
  const cm = { id: computeCreditManifestoId(cmBody as never), ...cmBody } as never as CreditManifesto;

  return { mb, cm };
}

interface Counts {
  marketBenchmarks: number;
  manifestoRegistry: number;
  contexts: number;
  dispositions: number;
  analyses: number;
  orphans: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readCounts(rawDb: any): Counts {
  const n = (sql: string): number => (rawDb.prepare(sql).get() as { n: number }).n;
  return {
    marketBenchmarks: n(`SELECT COUNT(*) n FROM market_benchmarks`),
    manifestoRegistry: n(`SELECT COUNT(*) n FROM manifesto_registry`),
    contexts: n(`SELECT COUNT(*) n FROM revision_evaluation_context`),
    dispositions: n(`SELECT COUNT(*) n FROM disposition`),
    analyses: n(`SELECT COUNT(*) n FROM analyses`),
    orphans: n(
      `SELECT COUNT(*) n
         FROM revision_evaluation_context ctx
         LEFT JOIN market_benchmarks  mb ON mb.id = ctx.market_benchmarks_id
         LEFT JOIN manifesto_registry cm ON cm.id = ctx.credit_manifesto_id
        WHERE mb.id IS NULL OR cm.id IS NULL`,
    ),
  };
}

interface DealScore {
  revisionId: string;
  finalScore: number | null;
  ratingBand: string | null;
  flags: string[];
}

/** Read a revision's stored score/band/flags straight from its doctrine eval —
 *  the numbers the additive insert must NOT move. */
function readScore(store: RecordGraphStore, revisionId: string): DealScore | null {
  const env = store.getRevisionEnvelope(revisionId as RevisionId);
  if (!env) return null;
  const de = store.getDoctrineEvaluation(env.doctrineEvaluationId);
  if (!de) return null;
  const d = de as unknown as { finalScore?: number | null; ratingBand?: string | null; band?: string | null; flags?: string[] };
  return {
    revisionId: revisionId.slice(0, 12),
    finalScore: d.finalScore ?? null,
    ratingBand: d.ratingBand ?? d.band ?? null,
    flags: (d.flags ?? []) as string[],
  };
}

function resolveDbPath(): string {
  const i = process.argv.indexOf('--db');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return path.join(process.cwd(), 'data', 'cre.db');
}

function main(): void {
  const dbPath = resolveDbPath();
  const commit = process.argv.includes('--commit');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('Sunroad registry repair — Phase 2 — ' + (commit ? 'COMMIT (writes db)' : 'DRY RUN'));
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  db:', dbPath);

  const store = new RecordGraphStore(dbPath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (store as unknown as { db: any }).db;

  // ── Resolve the Sunroad orphan contexts + their keyed asOf ─────────────────
  const orphanCtxs = rawDb
    .prepare(
      `SELECT revision_id, market_benchmarks_id, credit_manifesto_id
         FROM revision_evaluation_context
        WHERE market_benchmarks_id = ? AND credit_manifesto_id = ?
        ORDER BY revision_id`,
    )
    .all(TARGET_MB_ID, TARGET_CM_ID) as Array<{ revision_id: string; market_benchmarks_id: string; credit_manifesto_id: string }>;

  console.log(`\n  Sunroad contexts referencing the target registry: ${orphanCtxs.length}`);
  for (const c of orphanCtxs) console.log('    ', c.revision_id.slice(0, 12), '→ mb', c.market_benchmarks_id.slice(0, 8), 'cm', c.credit_manifesto_id.slice(0, 8));
  if (orphanCtxs.length === 0) {
    console.error('  ✗ No contexts reference the target registry — nothing to repair (unexpected). Aborting.');
    process.exit(2);
  }

  // The asOf the registry was keyed on = the doctrine eval's analysisAsOfDate for
  // any of these revisions (all four share it). Derive it — do NOT hard-code.
  let asOf: string | null = null;
  for (const c of orphanCtxs) {
    const env = store.getRevisionEnvelope(c.revision_id as RevisionId);
    if (!env) continue;
    const de = store.getDoctrineEvaluation(env.doctrineEvaluationId);
    const aod = (de as unknown as { analysisAsOfDate?: string } | null)?.analysisAsOfDate;
    if (aod) { asOf = aod; break; }
  }
  if (!asOf) {
    console.error('  ✗ Could not derive analysisAsOfDate from any Sunroad revision. Aborting.');
    process.exit(2);
  }
  console.log('  derived analysisAsOfDate:', asOf);

  // ── ★ HASH-VERIFY — the load-bearing gate ──────────────────────────────────
  const { mb, cm } = reconstructRegistry(asOf);
  const mbOk = mb.id === TARGET_MB_ID;
  const cmOk = cm.id === TARGET_CM_ID;
  console.log('\n  ── HASH-VERIFY ─────────────────────────────────────────────');
  console.log('  reconstructed MarketBenchmarks id:', mb.id);
  console.log('    target                          :', TARGET_MB_ID, mbOk ? '✓ MATCH' : '✗ MISMATCH');
  console.log('  reconstructed CreditManifesto  id:', cm.id);
  console.log('    target                          :', TARGET_CM_ID, cmOk ? '✓ MATCH' : '✗ MISMATCH');
  if (!mbOk || !cmOk) {
    console.error('\n  ✗✗ HASH MISMATCH — reconstructed content does NOT hash to the referenced ids.');
    console.error('     Inserting it would be a SILENT RE-UNDERWRITE. Inserting NOTHING. STOP.');
    store.close?.();
    process.exit(3);
  }
  console.log('  ✓ Both hashes reproduce EXACTLY — reconstruction is the original registry.');

  // ── BEFORE snapshot (counts + Sunroad score/band/flags) ────────────────────
  const before = readCounts(rawDb);
  const scoresBefore = orphanCtxs.map((c) => readScore(store, c.revision_id)).filter((s): s is DealScore => s !== null);
  console.log('\n  ── BEFORE ─────────────────────────────────────────────────');
  console.log('  counts:', JSON.stringify(before));
  for (const s of scoresBefore) console.log('  score', s.revisionId, '→', s.finalScore, '| band', s.ratingBand, '| flags', JSON.stringify(s.flags));

  if (!commit) {
    console.log('\n  DRY RUN — wrote NOTHING. Re-run with --commit to persist the 2 registry rows.');
    store.close?.();
    return;
  }

  // ── INSERT (idempotent, additive) ──────────────────────────────────────────
  const mbRes = store.insertMarketBenchmarks(mb);
  const cmRes = store.insertCreditManifesto(cm);
  console.log('\n  ── INSERT ─────────────────────────────────────────────────');
  console.log('  insertMarketBenchmarks:', mbRes.inserted ? 'inserted' : 'already present (no-op)');
  console.log('  insertCreditManifesto :', cmRes.inserted ? 'inserted' : 'already present (no-op)');

  // ── AFTER snapshot + PROOFS ────────────────────────────────────────────────
  const after = readCounts(rawDb);
  const scoresAfter = orphanCtxs.map((c) => readScore(store, c.revision_id)).filter((s): s is DealScore => s !== null);
  console.log('\n  ── AFTER ──────────────────────────────────────────────────');
  console.log('  counts:', JSON.stringify(after));

  // Additive proof: only +2 registry rows; everything else identical.
  const additive =
    after.contexts === before.contexts &&
    after.dispositions === before.dispositions &&
    after.analyses === before.analyses &&
    after.marketBenchmarks === before.marketBenchmarks + (mbRes.inserted ? 1 : 0) &&
    after.manifestoRegistry === before.manifestoRegistry + (cmRes.inserted ? 1 : 0);
  console.log('\n  ── PROOF: additive ────────────────────────────────────────');
  console.log('  market_benchmarks :', before.marketBenchmarks, '→', after.marketBenchmarks);
  console.log('  manifesto_registry:', before.manifestoRegistry, '→', after.manifestoRegistry);
  console.log('  contexts          :', before.contexts, '→', after.contexts, before.contexts === after.contexts ? '(unchanged ✓)' : '(✗ CHANGED)');
  console.log('  dispositions      :', before.dispositions, '→', after.dispositions, before.dispositions === after.dispositions ? '(unchanged ✓)' : '(✗ CHANGED)');
  console.log('  analyses          :', before.analyses, '→', after.analyses, before.analyses === after.analyses ? '(unchanged ✓)' : '(✗ CHANGED)');
  console.log('  ADDITIVE:', additive ? '✓' : '✗✗ NON-ADDITIVE');

  // Orphans-resolve proof. Idempotency-correct: the success condition is that
  // ALL contexts now resolve (after.orphans === 0). On a fresh repair that means
  // the 4 Sunroad orphans went 4 → 0; on a repeat run they were already cleared.
  console.log('\n  ── PROOF: orphans resolve ─────────────────────────────────');
  console.log('  orphan contexts:', before.orphans, '→', after.orphans);
  const orphansCleared = after.orphans === 0;
  console.log('  all eval contexts resolve (0 orphans):', orphansCleared ? '✓' : '✗');

  // Score-neutral proof — byte-identical before/after.
  console.log('\n  ── PROOF: score-neutral (byte-identical) ──────────────────');
  let scoreNeutral = scoresBefore.length === scoresAfter.length;
  for (let i = 0; i < scoresBefore.length; i++) {
    const b = scoresBefore[i];
    const a = scoresAfter.find((x) => x.revisionId === b.revisionId);
    const same = !!a && a.finalScore === b.finalScore && a.ratingBand === b.ratingBand && JSON.stringify(a.flags) === JSON.stringify(b.flags);
    scoreNeutral = scoreNeutral && same;
    console.log(`  ${b.revisionId}: BEFORE ${b.finalScore}/${b.ratingBand}/${JSON.stringify(b.flags)}  AFTER ${a?.finalScore}/${a?.ratingBand}/${JSON.stringify(a?.flags)}  ${same ? '✓ identical' : '✗ MOVED'}`);
  }
  console.log('  SCORE-NEUTRAL:', scoreNeutral ? '✓ byte-identical' : '✗✗ SCORE MOVED');

  store.close?.();

  const allPass = additive && orphansCleared && scoreNeutral;
  console.log('\n  ═══ RESULT:', allPass ? '✓ ALL GATES PASS' : '✗ GATE FAILED', '═══');
  if (!allPass) process.exit(4);
}

main();

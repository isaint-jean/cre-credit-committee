/**
 * Registry-resolvability guard — boot/CI check (Sunroad registry fix, Phase 1).
 *
 *   npm run check:registry-resolvability
 *   tsx src/scripts/check-registry-resolvability.ts [dbPath]
 *
 * What this guards:
 *
 *   Every `revision_evaluation_context` row records the (marketBenchmarksId,
 *   creditManifestoId) a revision was evaluated against. Those ids MUST resolve
 *   to persisted rows in `market_benchmarks` / `manifesto_registry`. A context
 *   pointing at an absent registry row is an ORPHAN — the exact defect this fix
 *   closes: `ingestExtractionResult` accepted an INLINE registry, scored against
 *   it, computed the eval-context id for it, wrote the context, but never
 *   persisted the registry itself.
 *
 *   Phase 1 makes the ingest path persist the inline registry (idempotently)
 *   BEFORE writing the context, and adds a write-time guard so no NEW orphan can
 *   be born. This script is the standing invariant: a pure read-only SQL scan
 *   that FAILS LOUDLY if ANY context references an absent registry id.
 *
 *   Expected state:
 *     - Fresh / repaired db  → 0 orphans → exit 0 (green).
 *     - Current cre.db       → detects the 4 known Sunroad orphans → exit 1.
 *       That FAILURE IS CORRECT and expected until Phase 2 repairs the 4
 *       historical contexts by persisting their inline registries.
 *
 *   Read-only: opens the db with { readonly: true } and runs only SELECTs. It
 *   never mutates the file (safe to run against the live cre.db).
 */
import Database from 'better-sqlite3';
import path from 'path';

class RegistryResolvabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryResolvabilityError';
  }
}

interface OrphanRow {
  revision_id: string;
  market_benchmarks_id: string;
  credit_manifesto_id: string;
  mb_missing: number;
  cm_missing: number;
}

function main(): void {
  const dbPath =
    process.argv[2] ?? path.join(process.cwd(), 'data', 'cre.db');
  console.log(`registry-resolvability guard: scanning ${dbPath}`);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const totalContexts = (
      db.prepare(`SELECT COUNT(*) AS n FROM revision_evaluation_context`).get() as { n: number }
    ).n;

    // A context is an orphan if its benchmark id and/or its manifesto id has no
    // matching registry row. LEFT JOIN + NULL test surfaces both halves.
    const orphans = db
      .prepare(
        `SELECT ctx.revision_id,
                ctx.market_benchmarks_id,
                ctx.credit_manifesto_id,
                (mb.id IS NULL) AS mb_missing,
                (cm.id IS NULL) AS cm_missing
           FROM revision_evaluation_context ctx
           LEFT JOIN market_benchmarks  mb ON mb.id = ctx.market_benchmarks_id
           LEFT JOIN manifesto_registry cm ON cm.id = ctx.credit_manifesto_id
          WHERE mb.id IS NULL OR cm.id IS NULL
          ORDER BY ctx.revision_id`,
      )
      .all() as OrphanRow[];

    console.log(
      `  scanned ${totalContexts} revision_evaluation_context row(s); ${orphans.length} orphan(s) found`,
    );

    if (orphans.length > 0) {
      for (const o of orphans) {
        const missing: string[] = [];
        if (o.mb_missing) missing.push(`MarketBenchmarks=${o.market_benchmarks_id}`);
        if (o.cm_missing) missing.push(`CreditManifesto=${o.credit_manifesto_id}`);
        console.error(`  ✗ revision ${o.revision_id} → unresolvable: ${missing.join(', ')}`);
      }
      throw new RegistryResolvabilityError(
        `${orphans.length} revision_evaluation_context row(s) reference an absent registry id`,
      );
    }

    console.log('registry-resolvability guard: ok (all eval contexts resolve)');
  } finally {
    db.close();
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  if (err instanceof RegistryResolvabilityError) {
    console.error(`registry-resolvability guard FAILED: ${err.message}`);
  } else {
    console.error('registry-resolvability guard FAILED with unexpected error:', err);
  }
  process.exit(1);
}

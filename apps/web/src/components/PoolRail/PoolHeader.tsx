/**
 * PoolHeader — top-of-rail summary: shelf name, vintage, seller, and the
 * disabled "Advance tape" affordance that the next slice will wire to Phase A.
 */
import type { Pool, TapeId } from '@cre/contracts';
import { DisabledAffordance } from './DisabledAffordance';

export function PoolHeader({
  pool,
  currentTapeId,
}: {
  readonly pool: Pool;
  readonly currentTapeId: TapeId | null;
}) {
  const status = pool.closedAt !== null ? 'closed' : currentTapeId === null ? 'no tapes yet' : 'active';
  const statusColor =
    status === 'closed' ? 'bg-text-muted/20 text-text-muted'
    : status === 'no tapes yet' ? 'bg-accent/20 text-accent'
    : 'bg-score-strong/20 text-score-strong';
  return (
    <header className="border-b border-border-primary pb-6 mb-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-semibold text-text-primary">{pool.shelfName}</h1>
            <span className={`text-xs uppercase tracking-wide px-2 py-0.5 rounded ${statusColor}`}>
              {status}
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-text-secondary">
            <span><span className="text-text-muted">Vintage</span> <span className="text-text-primary font-medium ml-1">{pool.vintage}</span></span>
            {pool.seller !== null && (
              <span><span className="text-text-muted">Seller</span> <span className="text-text-primary font-medium ml-1">{pool.seller}</span></span>
            )}
            <span><span className="text-text-muted">Created</span> <span className="text-text-primary font-medium ml-1">{new Date(pool.createdAt).toLocaleDateString()}</span></span>
            {currentTapeId !== null && (
              <span className="font-mono text-xs"><span className="text-text-muted">Current tape</span> <span className="text-text-primary ml-1">{currentTapeId.slice(0, 12)}…</span></span>
            )}
          </div>
        </div>
        <DisabledAffordance label="Advance tape" hint="Phase A ingest — wired in the next UI slice" />
      </div>
    </header>
  );
}

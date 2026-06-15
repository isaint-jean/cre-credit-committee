/**
 * TapeHistoryPanel — chronological tape evolution.
 *
 * The backend doesn't yet expose a list-tapes endpoint; we reconstruct the
 * lineage by walking `priorTapeId` backwards from the current frozen tape. The
 * Pool record's `tapeIds[]` is also not persisted today (a backend gap, flagged).
 * For PR5's read-only slice this is fine — N tapes = N sequential GETs, bounded
 * by pool depth (4-15 in the prototype's worked example).
 */
import type { Tape } from '@cre/contracts';

export function TapeHistoryPanel({
  tapes,
  currentTapeId,
}: {
  /** Chronological order: oldest (v1) first, current tape last. */
  readonly tapes: readonly Tape[];
  readonly currentTapeId: string | null;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">
        Tape lineage
      </h2>
      {tapes.length === 0 ? (
        <div className="bg-bg-secondary border border-border-primary rounded p-4 text-text-muted text-sm">
          No frozen tapes yet — this pool was just created.
        </div>
      ) : (
        <ol className="border border-border-primary rounded overflow-hidden">
          {tapes.map((t, i) => {
            const isCurrent = t.id === currentTapeId;
            return (
              <li
                key={t.id}
                className={`flex items-center justify-between px-3 py-2 border-t border-border-primary first:border-t-0 ${
                  isCurrent ? 'bg-accent/10' : 'bg-bg-secondary'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-text-muted">v{t.version}</span>
                  <span className="text-sm text-text-primary">{new Date(t.tapeDate).toLocaleDateString()}</span>
                  <span className="text-xs text-text-muted">{t.membership.length} loans</span>
                  {isCurrent && (
                    <span className="text-[10px] uppercase tracking-wide text-accent">current</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono text-text-muted">{t.id.slice(0, 12)}…</span>
                  <span className="text-text-muted">
                    {i === 0 ? 'origin' : `from v${tapes[i - 1]!.version}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

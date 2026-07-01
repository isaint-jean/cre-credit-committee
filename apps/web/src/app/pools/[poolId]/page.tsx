/**
 * /pools/[poolId] — the loan tape, reconciled to the prototype (cre-pool-rail.html):
 * a deal cover (pool stats header + side accent), the tape-by-tape evolution,
 * pool-health roll-up, then the loan tape under THREE views:
 *
 *   All loans   — the current-tape membership (status chip "On tape"; the only
 *                 real membership status in data is "under-review").
 *   Final tape  — closed loans only. `pool.closed_at` is null for both pools, so
 *                 this is an honest EMPTY STATE ("no pool closed yet"). Kept as a
 *                 view — not hidden — so the shape is visible.
 *   Dispositions— the real 74 departure rows via GET /:poolId/dispositions, with
 *                 the real `reasons` surfaced. Kicked/Dropped chips from the
 *                 buyer-authoritative disposition payload.
 *
 * SIDE (P2): the active `?side` accents the cover and rides every downstream link
 * (rows → per-loan trajectory) via `withSide`.
 *
 * Read-only this slice. Loads pool detail + current tape membership + dispositions
 * + walks priorTapeId chain to reconstruct tape lineage. Mutation surfaces appear
 * as DisabledAffordance components labeled "next slice".
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import type {
  Disposition,
  LoanMembership,
  Pool,
  PoolId,
  Tape,
  TapeId,
} from '@cre/contracts';
import { PoolHeader } from '@/components/PoolRail/PoolHeader';
import { PoolHealthSummary } from '@/components/PoolRail/PoolHealthSummary';
import { TapeHistoryPanel } from '@/components/PoolRail/TapeHistoryPanel';
import { MembershipTable } from '@/components/PoolRail/MembershipTable';
import { DispositionsLedger } from '@/components/PoolRail/DispositionsLedger';
import { useSide } from '@/lib/side-context';
import { sideAccent, withSide } from '@/lib/side-accent';

type LoadState = 'loading' | 'loaded' | 'error';

/** The three tape views. `final` is closed loans only (empty until a pool closes). */
type TapeView = 'all' | 'final' | 'dispositions';

interface RailData {
  readonly pool: Pool;
  readonly currentWorkingTapeId: string | null;
  readonly tapes: readonly Tape[];                 // chronological, v1 → currentTape
  readonly currentMembership: readonly LoanMembership[];
  readonly dispositions: readonly Disposition[];
}

/** Walk priorTapeId backwards from currentTape; reverse so the result is v1 first. */
async function loadTapeLineage(poolId: string, currentTapeId: TapeId): Promise<Tape[]> {
  const chain: Tape[] = [];
  let cursor: TapeId | null = currentTapeId;
  for (let i = 0; cursor !== null && i < 256; i++) {
    const { tape }: { tape: Tape } = await api.getTape(poolId, cursor);
    chain.push(tape);
    cursor = tape.priorTapeId;
  }
  return chain.reverse();
}

export default function PoolRailPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const side = useSide();
  const accent = sideAccent(side);
  const [data, setData] = useState<RailData | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [view, setView] = useState<TapeView>('all');

  const fetch = useCallback(async () => {
    setLoad('loading');
    setErrMsg(null);
    try {
      const detail = await api.getPoolDetail(poolId);
      let tapes: Tape[] = [];
      let currentMembership: LoanMembership[] = [];
      if (detail.pool.currentTapeId !== null) {
        tapes = await loadTapeLineage(poolId, detail.pool.currentTapeId);
        const last = tapes[tapes.length - 1];
        if (last !== undefined) {
          const { membership } = await api.getMembership(poolId, last.id);
          currentMembership = membership.slice();
        }
      }
      const { dispositions } = await api.getDispositions(poolId);
      setData({
        pool: detail.pool,
        currentWorkingTapeId: detail.currentWorkingTapeId,
        tapes,
        currentMembership,
        dispositions,
      });
      setLoad('loaded');
    } catch (e) {
      setErrMsg((e as Error).message);
      setLoad('error');
    }
  }, [poolId]);

  useEffect(() => { fetch(); }, [fetch]);

  if (load === 'loading') {
    return <div className="max-w-7xl mx-auto px-6 py-10 text-sm text-text-muted">Loading pool…</div>;
  }
  if (load === 'error') {
    return (
      <div className="max-w-7xl mx-auto px-6 py-10">
        <Link href={withSide('/pools', side)} className="text-accent hover:text-accent-hover text-sm">← Pools</Link>
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm mt-4">
          Could not load pool: {errMsg}
        </div>
      </div>
    );
  }
  if (data === null) return null;

  const isClosed = data.pool.closedAt !== null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <Link href={withSide('/pools', side)} className="text-accent hover:text-accent-hover text-sm">← Pools</Link>
      <div className="mt-3">
        {/* Deal cover — side-accented top rail + header. */}
        <div className={`border-t-[3px] ${accent.borderTop} rounded-t-panel`}>
          {side !== null && (
            <div className={`font-mono text-[11px] tracking-[0.14em] uppercase pt-4 ${accent.text}`}>
              {accent.label}
            </div>
          )}
          <PoolHeader pool={data.pool} currentTapeId={data.pool.currentTapeId} />
        </div>

        {data.currentWorkingTapeId !== null && (
          <div className={`${accent.softBg} border ${accent.border} rounded p-3 mb-6 text-sm ${accent.text}`}>
            ★ Open working tape in review (id {data.currentWorkingTapeId.slice(0, 12)}…). The review-queue
            mutation surface is wired in the next UI slice; reads only here.
          </div>
        )}

        {data.pool.currentTapeId === null ? (
          <div className="bg-bg-secondary border border-border-primary rounded p-8 text-center">
            <p className="text-text-secondary mb-2">No frozen tapes yet.</p>
            <p className="text-text-muted text-xs">Advance the first tape to ingest the originator&apos;s v1 — next slice.</p>
          </div>
        ) : (
          <>
            <PoolHealthSummary membership={data.currentMembership} dispositions={data.dispositions} />
            <TapeHistoryPanel tapes={data.tapes} dispositions={data.dispositions} currentTapeId={data.pool.currentTapeId} />

            {/* Three-view tab bar. */}
            <ViewTabs
              view={view}
              onChange={setView}
              accentText={accent.text}
              accentSoft={accent.softBg}
              counts={{
                all: data.currentMembership.length,
                dispositions: data.dispositions.length,
              }}
            />

            {view === 'all' && (
              <MembershipTable
                poolId={data.pool.id as PoolId}
                membership={data.currentMembership}
                side={side}
              />
            )}

            {view === 'final' && (
              <FinalTapeView isClosed={isClosed} />
            )}

            {view === 'dispositions' && (
              <DispositionsLedger dispositions={data.dispositions} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* View tab bar — All loans / Final tape / Dispositions                       */
/* -------------------------------------------------------------------------- */

function ViewTabs({
  view, onChange, accentText, accentSoft, counts,
}: {
  readonly view: TapeView;
  readonly onChange: (v: TapeView) => void;
  readonly accentText: string;
  readonly accentSoft: string;
  readonly counts: { readonly all: number; readonly dispositions: number };
}) {
  const tabs: ReadonlyArray<{ value: TapeView; label: string; count: number | null }> = [
    { value: 'all',          label: 'All loans',    count: counts.all },
    { value: 'final',        label: 'Final tape',   count: null },
    { value: 'dispositions', label: 'Dispositions', count: counts.dispositions },
  ];
  return (
    <div className="flex items-center gap-1 bg-bg-secondary border border-border-primary rounded-panel p-1 w-fit mb-4">
      {tabs.map(t => {
        const active = view === t.value;
        return (
          <button
            key={t.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(t.value)}
            className={`px-4 py-2 text-sm font-medium rounded-sm2 flex items-center gap-2 transition-colors ${
              active
                ? `${accentSoft} ${accentText}`
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
            {t.count !== null && (
              <span className="font-mono text-[11px] opacity-80">{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Final tape — closed loans only. Honest empty state (no pool closed yet).   */
/* -------------------------------------------------------------------------- */

function FinalTapeView({ isClosed }: { readonly isClosed: boolean }) {
  // Both pools' closed_at is null → this view is intentionally empty. When a pool
  // closes (P4), the final sealed tape's membership renders here.
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">Final tape</h2>
      <div className="bg-bg-secondary border border-border-primary rounded-panel p-10 text-center">
        <p className="text-text-primary mb-1 font-medium">
          {isClosed ? 'No loans on the final tape.' : 'No pool closed yet.'}
        </p>
        <p className="text-text-muted text-xs">
          The final tape appears once the pool is sealed — the definitive list of loans that made it in.
        </p>
      </div>
    </section>
  );
}

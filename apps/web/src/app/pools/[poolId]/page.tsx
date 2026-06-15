/**
 * /pools/[poolId] — the rail (main view).
 *
 * Read-only this slice. Loads pool detail + current tape membership + dispositions
 * + walks priorTapeId chain to reconstruct tape lineage. Mutation surfaces appear
 * as DisabledAffordance components labeled "next slice".
 *
 * The N tape walks below are bounded by pool depth (4-15 in the prototype's worked
 * example); a list-tapes endpoint is a future backend enhancement.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
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

type LoadState = 'loading' | 'loaded' | 'error';

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
  // Bound the walk defensively (no pool should have more than a few hundred tapes).
  for (let i = 0; cursor !== null && i < 256; i++) {
    const { tape }: { tape: Tape } = await api.getTape(poolId, cursor);
    chain.push(tape);
    cursor = tape.priorTapeId;
  }
  return chain.reverse();
}

export default function PoolRailPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const [data, setData] = useState<RailData | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);

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
        <Link href="/pools" className="text-accent hover:text-accent-hover text-sm">← Pools</Link>
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm mt-4">
          Could not load pool: {errMsg}
        </div>
      </div>
    );
  }
  if (data === null) return null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <Link href="/pools" className="text-accent hover:text-accent-hover text-sm">← Pools</Link>
      <div className="mt-3">
        <PoolHeader pool={data.pool} currentTapeId={data.pool.currentTapeId} />

        {data.currentWorkingTapeId !== null && (
          <div className="bg-accent/10 border border-accent/30 rounded p-3 mb-6 text-sm text-accent">
            ★ Open working tape in review (id {data.currentWorkingTapeId.slice(0, 12)}…). The review-queue
            mutation surface is wired in the next UI slice; reads only here.
          </div>
        )}

        {data.pool.currentTapeId === null ? (
          <div className="bg-bg-secondary border border-border-primary rounded p-8 text-center">
            <p className="text-text-secondary mb-2">No frozen tapes yet.</p>
            <p className="text-text-muted text-xs">Advance the first tape to ingest the originator's v1 — next slice.</p>
          </div>
        ) : (
          <>
            <PoolHealthSummary membership={data.currentMembership} dispositions={data.dispositions} />
            <TapeHistoryPanel tapes={data.tapes} currentTapeId={data.pool.currentTapeId} />
            <MembershipTable poolId={data.pool.id as PoolId} membership={data.currentMembership} />
            <DispositionsLedger dispositions={data.dispositions} />
          </>
        )}
      </div>
    </div>
  );
}

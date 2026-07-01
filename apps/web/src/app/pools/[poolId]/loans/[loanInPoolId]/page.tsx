/**
 * /pools/[poolId]/loans/[loanInPoolId] — per-loan pool-side trajectory.
 *
 * ★ DELEGATION BOUNDARY (the pool/engine seam, made UI-visible).
 *
 * This page shows the loan's POOL-SIDE history (which tapes it appeared on, with
 * what status, and if it departed, the disposition). It does NOT render any
 * underwriting — those are the engine's concern. The "Open underwriting" link
 * routes to /analysis/[dealRef] where the existing single-deal view takes over.
 *
 * The pool layer owns pool / tape / membership / disposition presentation; it
 * delegates per-loan underwriting presentation to what already exists.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import type { Disposition, LoanInPool, LoanMembership, OnTapeStatus } from '@cre/contracts';
import { useSide } from '@/lib/side-context';
import { withSide } from '@/lib/side-accent';

type LoadState = 'loading' | 'loaded' | 'error';

interface TrajectoryData {
  readonly loan: LoanInPool;
  readonly history: readonly LoanMembership[];
  readonly disposition: Disposition | null;
}

const STATUS_TONE: Record<OnTapeStatus, string> = {
  'clean':         'bg-score-strong/15 text-score-strong border-score-strong/30',
  'conditioned':   'bg-accent/15 text-accent border-accent/30',
  'kick-flagged':  'bg-risk-high/15 text-risk-high border-risk-high/30',
  'under-review':  'bg-text-muted/15 text-text-secondary border-border-secondary',
};

export default function LoanTrajectoryPage() {
  const { poolId, loanInPoolId } = useParams<{ poolId: string; loanInPoolId: string }>();
  const side = useSide();
  const [data, setData] = useState<TrajectoryData | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoad('loading');
    setErrMsg(null);
    try {
      const { loan } = await api.getLoanInPool(poolId, loanInPoolId);
      const { history } = await api.getLoanHistory(poolId, loanInPoolId);
      let disposition: Disposition | null = null;
      if (loan.currentDispositionId !== null) {
        const { dispositions } = await api.getDispositions(poolId);
        disposition = dispositions.find(d => d.id === loan.currentDispositionId) ?? null;
      }
      setData({ loan, history, disposition });
      setLoad('loaded');
    } catch (e) {
      setErrMsg((e as Error).message);
      setLoad('error');
    }
  }, [poolId, loanInPoolId]);

  useEffect(() => { fetch(); }, [fetch]);

  if (load === 'loading') {
    return <div className="max-w-5xl mx-auto px-6 py-10 text-sm text-text-muted">Loading loan trajectory…</div>;
  }
  if (load === 'error') {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool rail</Link>
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm mt-4">
          Could not load loan: {errMsg}
        </div>
      </div>
    );
  }
  if (data === null) return null;

  const { loan, history, disposition } = data;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool rail</Link>

      <header className="border-b border-border-primary pb-6 mt-3 mb-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary mb-1">Loan trajectory</h1>
            <div className="text-sm text-text-secondary space-y-1">
              <div><span className="text-text-muted">Pool-side id</span> <span className="font-mono text-xs ml-1">{loan.id}</span></div>
              <div><span className="text-text-muted">Originator ref</span> <span className="text-text-primary ml-1">{loan.originatorLoanRef ?? '—'}</span></div>
              {loan.propertyName !== null && (
                <div><span className="text-text-muted">Property</span> <span className="text-text-primary ml-1">{loan.propertyName}</span></div>
              )}
              <div><span className="text-text-muted">Asset type</span> <span className="text-text-primary ml-1">{loan.assetType ?? 'Unknown'}</span></div>
              <div>
                <span className="text-text-muted">Status</span>{' '}
                {disposition === null
                  ? <span className="text-score-strong ml-1">active in pool</span>
                  : <span className="text-risk-high ml-1">departed — buyer: {disposition.buyerLabel}{disposition.override ? ' (OVERRIDE)' : ''}</span>}
              </div>
            </div>
          </div>

          {/* ★ DELEGATION BOUNDARY: underwriting drill-down → existing /analysis/[dealRef]. */}
          <Link
            href={`/analysis/${loan.dealRef}`}
            className="btn-primary text-sm"
            title="Pool layer delegates per-loan underwriting to the engine surface via dealRef"
          >
            Open underwriting →
          </Link>
        </div>
      </header>

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">
          Tape-by-tape · {history.length} appearances
        </h2>
        {history.length === 0 ? (
          <div className="bg-bg-secondary border border-border-primary rounded p-4 text-text-muted text-sm">
            No tape history.
          </div>
        ) : (
          <div className="border border-border-primary rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-tertiary">
                <tr className="text-left text-text-secondary text-xs uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Tape</th>
                  <th className="px-3 py-2 font-medium">Position</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Conditions</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {history.map((m, i) => (
                  <tr key={`${m.loanInPoolId}-${i}`} className="border-t border-border-primary">
                    <td className="px-3 py-2 font-mono text-xs text-text-muted">tape #{i + 1}</td>
                    <td className="px-3 py-2 text-text-secondary">{m.tapePosition}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_TONE[m.status]}`}>
                        {m.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-secondary text-xs">
                      {m.conditions.length === 0 ? <span className="text-text-muted">—</span>
                        : m.conditions.map(c => c.label).join(', ')}
                    </td>
                    <td className="px-3 py-2 text-text-secondary text-xs">
                      {m.notes ?? <span className="text-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {disposition !== null && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">Departure</h2>
          <div className="border border-border-primary rounded bg-bg-secondary p-4 text-sm space-y-2">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-text-muted text-xs uppercase tracking-wide block">Originator label</span>
                <span className="font-mono">{disposition.originatorLabel}</span>
              </div>
              <span className="text-text-muted">→</span>
              <div>
                <span className="text-text-muted text-xs uppercase tracking-wide block">Buyer label (authoritative)</span>
                <span className="font-mono">{disposition.buyerLabel}</span>
              </div>
              {disposition.override && (
                <span className="text-xs px-2 py-0.5 rounded bg-risk-medium/15 text-risk-medium border border-risk-medium/30 font-semibold ml-4">
                  OVERRIDE
                </span>
              )}
            </div>
            {disposition.reasons.length > 0 && (
              <div>
                <span className="text-text-muted text-xs uppercase tracking-wide block mb-1">Reasons</span>
                <ul className="text-text-secondary text-xs list-disc pl-5">
                  {disposition.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            <div className="text-xs text-text-muted">
              Recorded {new Date(disposition.recordedAt).toLocaleString()} · by {disposition.recordedBy.userId}
              {disposition.recordedBy.displayName !== null ? ` (${disposition.recordedBy.displayName})` : ''}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

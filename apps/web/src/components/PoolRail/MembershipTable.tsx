/**
 * MembershipTable — the filterable per-loan table for the current tape.
 *
 * Read-only this slice: rows are clickable to drill into the loan's pool-side
 * trajectory; the trajectory page delegates underwriting to the engine surface
 * via dealRef (the boundary, now in the UI).
 */
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { LoanMembership, OnTapeStatus, PoolId } from '@cre/contracts';
import { DisabledAffordance } from './DisabledAffordance';

const STATUS_TONE: Record<OnTapeStatus, string> = {
  'clean':         'bg-score-strong/15 text-score-strong border-score-strong/30',
  'conditioned':   'bg-accent/15 text-accent border-accent/30',
  'kick-flagged':  'bg-risk-high/15 text-risk-high border-risk-high/30',
  'under-review':  'bg-text-muted/15 text-text-secondary border-border-secondary',
};

const STATUS_FILTERS: ReadonlyArray<{ label: string; value: OnTapeStatus | 'all' }> = [
  { label: 'All',          value: 'all' },
  { label: 'Clean',        value: 'clean' },
  { label: 'Conditioned',  value: 'conditioned' },
  { label: 'Kick-flagged', value: 'kick-flagged' },
  { label: 'Under review', value: 'under-review' },
];

export function MembershipTable({
  poolId,
  membership,
}: {
  readonly poolId: PoolId;
  readonly membership: readonly LoanMembership[];
}) {
  const [statusFilter, setStatusFilter] = useState<OnTapeStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return membership.filter(m => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (term.length > 0) {
        const hay = `${m.dealRef} ${m.loanInPoolId} ${m.notes ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [membership, statusFilter, search]);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
          Current tape · {membership.length} loans
        </h2>
        <DisabledAffordance label="Edit status / conditions" hint="Buyer edits in the review queue — next slice" />
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by deal ref, id, notes…"
          className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                     focus:outline-none focus:border-accent placeholder-text-muted flex-1 max-w-xs"
        />
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                statusFilter === f.value
                  ? 'bg-accent text-bg-primary border-accent font-medium'
                  : 'bg-bg-tertiary text-text-secondary border-border-secondary hover:border-accent/60'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="border border-border-primary rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-tertiary">
            <tr className="text-left text-text-secondary text-xs uppercase tracking-wide">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Deal ref</th>
              <th className="px-3 py-2 font-medium">Loan in pool</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Conditions</th>
              <th className="px-3 py-2 font-medium">Notes</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-text-muted text-sm">
                No loans match the filter.
              </td></tr>
            ) : filtered.map(m => (
              <tr key={m.loanInPoolId} className="border-t border-border-primary hover:bg-bg-tertiary/40 transition-colors">
                <td className="px-3 py-2 text-text-muted font-mono text-xs">{m.tapePosition}</td>
                <td className="px-3 py-2 text-text-primary font-mono">{m.dealRef}</td>
                <td className="px-3 py-2 text-text-muted font-mono text-xs">{m.loanInPoolId.slice(0, 8)}…</td>
                <td className="px-3 py-2">
                  <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_TONE[m.status]}`}>
                    {m.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-text-secondary text-xs">
                  {m.conditions.length === 0 ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <span>{m.conditions.map(c => c.label).join(', ')}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-text-secondary text-xs">{m.notes ?? <span className="text-text-muted">—</span>}</td>
                <td className="px-3 py-2 text-right">
                  <Link
                    href={`/pools/${poolId}/loans/${m.loanInPoolId}`}
                    className="text-accent hover:text-accent-hover text-xs"
                  >
                    Trajectory →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

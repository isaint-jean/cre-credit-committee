'use client';

/**
 * Rent-roll slot extraction display (Data Room Tier 2c) — READ-ONLY. Opens the
 * engine's ingest-time rent-roll extraction for a loan: summary + a paginated
 * tenant/unit table (50/page — MF rent rolls run to thousands). Credit-free (pure
 * read of a boundary-honoring display DTO). analysisId null / no extraction →
 * "Rent roll not extracted" (calm, not an error).
 */
import { useEffect, useState } from 'react';
import type { RentRollSlotExtraction } from '@cre/contracts';
import { api } from '@/lib/api-client';

function fmt(n: number | null, period: 'annual' | 'monthly'): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}/${period === 'annual' ? 'yr' : 'mo'}`;
}
function fmtDate(d: string | null): string {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

export function RentRollTable({ analysisId, depth }: { analysisId: string | null; depth: number }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<RentRollSlotExtraction | null>(null);
  const [state, setState] = useState<'loading' | 'present' | 'not_extracted' | 'error'>('loading');
  const pad = { paddingLeft: `${8 + depth * 16 + 16}px` } as const;

  useEffect(() => {
    if (!analysisId) { setState('not_extracted'); return; }
    let cancelled = false;
    setState('loading');
    api.getSlotExtraction(analysisId, 'rent_roll', offset)
      .then((r) => {
        if (cancelled) return;
        if (r.status === 'present' && r.extraction) { setData(r.extraction); setState('present'); }
        else setState('not_extracted');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [analysisId, offset]);

  if (state === 'loading') return <div className="py-1 text-xs text-text-secondary" style={pad}>Loading rent roll…</div>;
  if (state === 'not_extracted') return <div className="py-1 text-xs text-text-secondary" style={pad}>Rent roll not extracted for this loan.</div>;
  if (state === 'error' || !data) return <div className="py-1 text-xs text-text-secondary" style={pad}>Rent roll unavailable.</div>;

  const { summary, units, totalCount, limit } = data;
  const from = data.offset + 1;
  const to = Math.min(data.offset + limit, totalCount);

  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary/40 py-2 pr-3 text-xs" style={pad}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-text-secondary">Rent roll</span>
        <span className="text-text-primary">{summary.totalUnits} units</span>
        <span className="text-text-secondary">· {summary.occupiedUnits} occupied</span>
        {summary.occupancyPct != null && <span className="text-text-secondary">· {(summary.occupancyPct * 100).toFixed(0)}% occ.</span>}
        {data.source && <span className="ml-auto text-text-secondary">source: {data.source}</span>}
      </div>
      <div className="mt-2 space-y-0.5">
        <div className="flex gap-3 border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">
          <span className="flex-1">Tenant / unit</span>
          <span className="w-16 shrink-0">Status</span>
          <span className="w-24 shrink-0 text-right">In-place</span>
          <span className="w-20 shrink-0 text-right">Lease end</span>
        </div>
        {units.map((u, i) => (
          <div key={`${u.label}-${i}`} className="flex gap-3">
            <span className="flex-1 truncate text-text-primary" title={u.detail ? `${u.label} · ${u.detail}` : u.label}>
              {u.label}{u.detail ? <span className="text-text-secondary"> · {u.detail}</span> : null}
            </span>
            <span className="w-16 shrink-0 text-text-secondary">{u.status.toLowerCase()}</span>
            <span className="w-24 shrink-0 text-right text-text-secondary">{fmt(u.inPlaceRent, u.rentPeriod)}</span>
            <span className="w-20 shrink-0 text-right text-text-secondary">{fmtDate(u.leaseEnd)}</span>
          </div>
        ))}
      </div>
      {totalCount > limit && (
        <div className="mt-2 flex items-center gap-2 text-text-secondary">
          <button type="button" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - limit))} className="rounded border border-border-primary px-1.5 py-0.5 hover:text-text-primary disabled:opacity-40">Prev</button>
          <span>{from}–{to} of {totalCount}</span>
          <button type="button" disabled={to >= totalCount} onClick={() => setOffset(data.offset + limit)} className="rounded border border-border-primary px-1.5 py-0.5 hover:text-text-primary disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );
}

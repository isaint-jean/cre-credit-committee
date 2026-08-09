'use client';

/**
 * PCA (Property Condition Assessment) slot extraction display (Data Room Tier 2c,
 * pca variant) — READ-ONLY. Opens the engine's ingest-time PCA extraction for a
 * loan: Table-1 repair totals, the Table-2 per-year capex schedule, and the four
 * system narratives. Credit-free (pure read of a boundary-honoring display DTO).
 * analysisId null / no extraction → "not extracted" (calm, not an error).
 * Mirrors RentRollTable's fetch/state pattern; no pagination (schedules are ~12yr).
 */
import { useEffect, useState } from 'react';
import type { PcaSlotExtraction } from '@cre/contracts';
import { api } from '@/lib/api-client';

function usd(n: number | null): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function PcaDetail({ analysisId, depth }: { analysisId: string | null; depth: number }) {
  const [data, setData] = useState<PcaSlotExtraction | null>(null);
  const [state, setState] = useState<'loading' | 'present' | 'not_extracted' | 'error'>('loading');
  const pad = { paddingLeft: `${8 + depth * 16 + 16}px` } as const;

  useEffect(() => {
    if (!analysisId) { setState('not_extracted'); return; }
    let cancelled = false;
    setState('loading');
    api.getPcaExtraction(analysisId)
      .then((r) => {
        if (cancelled) return;
        if (r.status === 'present' && r.extraction) { setData(r.extraction); setState('present'); }
        else setState('not_extracted');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [analysisId]);

  if (state === 'loading') return <div className="py-1 text-xs text-text-secondary" style={pad}>Loading condition report…</div>;
  if (state === 'not_extracted') return <div className="py-1 text-xs text-text-secondary" style={pad}>Property condition not extracted for this loan.</div>;
  if (state === 'error' || !data) return <div className="py-1 text-xs text-text-secondary" style={pad}>Condition report unavailable.</div>;

  const { capexSchedule, narratives } = data;
  const narrativeRows = ([
    ['Roof', narratives.roof],
    ['HVAC', narratives.hvac],
    ['Plumbing', narratives.plumbing],
    ['Electrical', narratives.electrical],
  ] as const).filter(([, v]) => v);
  const capexTotal = capexSchedule.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary/40 py-2 pr-3 text-xs" style={pad}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-text-secondary">Property condition</span>
        <span className="text-text-primary">Immediate {usd(data.immediateRepairs)}</span>
        <span className="text-text-secondary">· Short-term {usd(data.shortTermRepairs)}</span>
        {data.evaluationPeriodYears != null && (
          <span className="ml-auto text-text-secondary">{data.evaluationPeriodYears}-yr schedule</span>
        )}
      </div>

      {capexSchedule.length > 0 && (
        <div className="mt-2">
          <div className="flex items-baseline justify-between border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">
            <span>Replacement reserve schedule (inflated)</span>
            <span>Total {usd(capexTotal)}</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3">
            {capexSchedule.map((e) => (
              <div key={e.year} className="flex justify-between">
                <span className="text-text-secondary">Yr {e.year}</span>
                <span className="text-text-primary">{usd(e.amount)}</span>
              </div>
            ))}
          </div>
          {data.reservePerSfPerYearInflated != null && (
            <div className="mt-1 text-text-secondary">
              Avg reserve ${data.reservePerSfPerYearInflated.toFixed(2)}/SF/yr
              {data.inflationRate != null && ` · ${(data.inflationRate * 100).toFixed(1)}% inflation`}
            </div>
          )}
        </div>
      )}

      {narrativeRows.length > 0 && (
        <div className="mt-2">
          <div className="border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">System narratives</div>
          <ul className="mt-1 space-y-1">
            {narrativeRows.map(([label, text]) => (
              <li key={label} className="flex gap-2">
                <span className="w-16 shrink-0 text-text-secondary">{label}</span>
                <span className="flex-1 text-text-primary">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

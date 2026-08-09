'use client';

/**
 * ASR (Analytical Summary Report) slot extraction display (Data Room Tier 2c, asr
 * variant) — READ-ONLY. Opens the engine's ingest-time ASR extraction for a loan:
 * the valuation triple (NOI / implied value / implied cap rate), the Sources &
 * Uses table, and the multi-year Underwritten Cash Flows ladder. Credit-free
 * (pure read of a boundary-honoring display DTO). analysisId null / no extraction
 * → "not extracted". Mirrors RentRollTable / PcaDetail's fetch/state pattern.
 */
import { useEffect, useState } from 'react';
import type { AsrSlotExtraction } from '@cre/contracts';
import { api } from '@/lib/api-client';

function usd(n: number | null): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function usdShort(n: number | null): string {
  if (n == null) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border-primary bg-bg-secondary/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-text-secondary">{label}</div>
      <div className="text-text-primary">{value}</div>
    </div>
  );
}

export function AsrDetail({ analysisId, depth }: { analysisId: string | null; depth: number }) {
  const [data, setData] = useState<AsrSlotExtraction | null>(null);
  const [state, setState] = useState<'loading' | 'present' | 'not_extracted' | 'error'>('loading');
  const pad = { paddingLeft: `${8 + depth * 16 + 16}px` } as const;

  useEffect(() => {
    if (!analysisId) { setState('not_extracted'); return; }
    let cancelled = false;
    setState('loading');
    api.getAsrExtraction(analysisId)
      .then((r) => {
        if (cancelled) return;
        if (r.status === 'present' && r.extraction) { setData(r.extraction); setState('present'); }
        else setState('not_extracted');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [analysisId]);

  if (state === 'loading') return <div className="py-1 text-xs text-text-secondary" style={pad}>Loading underwriting…</div>;
  if (state === 'not_extracted') return <div className="py-1 text-xs text-text-secondary" style={pad}>Underwriting summary not extracted for this loan.</div>;
  if (state === 'error' || !data) return <div className="py-1 text-xs text-text-secondary" style={pad}>Underwriting summary unavailable.</div>;

  const { sources, uses, cashFlows } = data;

  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary/40 py-2 pr-3 text-xs" style={pad}>
      <div className="text-[11px] uppercase tracking-wide text-text-secondary">Underwriting summary (ASR)</div>

      {/* valuation triple */}
      <div className="mt-1 grid grid-cols-3 gap-2">
        <Stat label="U/W NOI" value={usd(data.underwrittenNOI)} />
        <Stat label="Implied value" value={usd(data.impliedValue)} />
        <Stat label="Implied cap" value={data.impliedCapRate != null ? `${(data.impliedCapRate * 100).toFixed(2)}%` : '—'} />
      </div>

      {/* sources & uses */}
      {(sources.length > 0 || uses.length > 0) && (
        <div className="mt-2 grid grid-cols-2 gap-x-6">
          <div>
            <div className="border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">Sources</div>
            <ul className="mt-1 space-y-0.5">
              {sources.length === 0 && <li className="text-text-secondary">—</li>}
              {sources.map((s) => (
                <li key={s.label} className="flex justify-between gap-2">
                  <span className="text-text-secondary">{s.label}</span>
                  <span className="text-text-primary">{usd(s.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">Uses</div>
            <ul className="mt-1 space-y-0.5">
              {uses.length === 0 && <li className="text-text-secondary">—</li>}
              {uses.map((u) => (
                <li key={u.label} className="flex justify-between gap-2">
                  <span className="text-text-secondary">{u.label}</span>
                  <span className="text-text-primary">{usd(u.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* multi-year cash-flow ladder — metrics as rows, columns as years */}
      {cashFlows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <div className="border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">Underwritten cash flows</div>
          <table className="mt-1 w-full min-w-max border-collapse">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-0.5 pr-3 text-left font-medium">Metric</th>
                {cashFlows.map((c) => (
                  <th key={c.label} className="py-0.5 pl-3 text-right font-medium">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {([
                ['PGR', (c: (typeof cashFlows)[number]) => c.potentialGrossRevenue],
                ['EGR', (c: (typeof cashFlows)[number]) => c.effectiveGrossRevenue],
                ['Expenses', (c: (typeof cashFlows)[number]) => c.totalExpenses],
                ['NOI', (c: (typeof cashFlows)[number]) => c.netOperatingIncome],
                ['NCF', (c: (typeof cashFlows)[number]) => c.netCashFlow],
              ] as const).map(([label, pick]) => (
                <tr key={label}>
                  <td className="py-0.5 pr-3 text-left text-text-secondary">{label}</td>
                  {cashFlows.map((c) => (
                    <td key={c.label} className="py-0.5 pl-3 text-right text-text-primary">{usdShort(pick(c))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

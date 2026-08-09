'use client';

/**
 * Appraisal slot extraction display (Data Room Tier 2c, appraisal variant) —
 * READ-ONLY. Opens the engine's ingest-time appraisal extraction for a loan: a
 * value card (as-is / as-stabilized values, cap rates, occupancy) + an optional
 * pro-forma block. Credit-free (pure read of a boundary-honoring display DTO).
 *
 * ★ The NOT-EXTRACTED state is a FIRST-CLASS case, not an afterthought: appraisal
 *   extraction is template-dependent and commonly null (the appraisal exists as a
 *   document but wasn't machine-parsed). That renders as a calm, honest panel —
 *   never a broken/empty card, never a fabricated value.
 */
import { useEffect, useState } from 'react';
import type { AppraisalSlotExtraction } from '@cre/contracts';
import { api } from '@/lib/api-client';

function usd(n: number | null): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function pct(n: number | null): string {
  return n == null ? '—' : `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
}
function fmtDate(d: string | null): string {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border-primary bg-bg-secondary/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-text-secondary">{label}</div>
      <div className="text-text-primary">{value}</div>
    </div>
  );
}

export function AppraisalCard({ analysisId, depth }: { analysisId: string | null; depth: number }) {
  const [data, setData] = useState<AppraisalSlotExtraction | null>(null);
  const [state, setState] = useState<'loading' | 'present' | 'not_extracted' | 'error'>('loading');
  const pad = { paddingLeft: `${8 + depth * 16 + 16}px` } as const;

  useEffect(() => {
    if (!analysisId) { setState('not_extracted'); return; }
    let cancelled = false;
    setState('loading');
    api.getAppraisalExtraction(analysisId)
      .then((r) => {
        if (cancelled) return;
        if (r.status === 'present' && r.extraction) { setData(r.extraction); setState('present'); }
        else setState('not_extracted');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [analysisId]);

  if (state === 'loading') return <div className="py-1 text-xs text-text-secondary" style={pad}>Loading appraisal…</div>;
  if (state === 'error') return <div className="py-1 text-xs text-text-secondary" style={pad}>Appraisal unavailable.</div>;

  // ★ First-class not-extracted state — calm + honest, points at the source doc.
  if (state === 'not_extracted' || !data) {
    return (
      <div className="rounded-md border border-dashed border-border-primary bg-bg-tertiary/30 px-3 py-2 text-xs" style={pad}>
        <div className="text-text-primary">This appraisal hasn&apos;t been machine-extracted.</div>
        <div className="mt-0.5 text-text-secondary">
          Appraisal parsing is template-dependent, so this is common — the value card isn&apos;t
          available here. Open the source document to review the appraisal directly.
        </div>
      </div>
    );
  }

  const hasProForma = data.stabilizedProForma || data.currentProForma;

  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary/40 py-2 pr-3 text-xs" style={pad}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-text-secondary">Appraisal</span>
        {data.methodology && <span className="text-text-secondary">{data.methodology}</span>}
        {data.source && <span className="text-text-secondary">· {data.source.toUpperCase()}</span>}
        {data.valuationDate && <span className="ml-auto text-text-secondary">as of {fmtDate(data.valuationDate)}</span>}
      </div>

      {/* value card */}
      <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="As-is value" value={usd(data.asIsValue)} />
        <Stat label="As-stabilized" value={usd(data.asStabilizedValue)} />
        <Stat label="Cap rate" value={pct(data.asIsCapRate)} />
        {data.terminalCapRate != null && <Stat label="Terminal cap" value={pct(data.terminalCapRate)} />}
        {data.stabilizedOccupancy != null && <Stat label="Stab. occ." value={pct(data.stabilizedOccupancy)} />}
        {data.currentOccupancy != null && <Stat label="Current occ." value={pct(data.currentOccupancy)} />}
      </div>

      {/* optional pro-forma block */}
      {hasProForma && (
        <div className="mt-2">
          <div className="border-b border-border-primary/50 pb-0.5 font-medium text-text-secondary">Pro forma</div>
          <table className="mt-1 w-full border-collapse">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-0.5 pr-3 text-left font-medium">Line</th>
                {data.stabilizedProForma && <th className="py-0.5 pl-3 text-right font-medium">Stabilized</th>}
                {data.currentProForma && <th className="py-0.5 pl-3 text-right font-medium">Current</th>}
              </tr>
            </thead>
            <tbody>
              {([
                ['EGI', (p: NonNullable<typeof data.stabilizedProForma>) => p.egi],
                ['OpEx', (p: NonNullable<typeof data.stabilizedProForma>) => p.opex],
                ['NOI', (p: NonNullable<typeof data.stabilizedProForma>) => p.noi],
              ] as const).map(([label, pick]) => (
                <tr key={label}>
                  <td className="py-0.5 pr-3 text-left text-text-secondary">{label}</td>
                  {data.stabilizedProForma && <td className="py-0.5 pl-3 text-right text-text-primary">{usd(pick(data.stabilizedProForma))}</td>}
                  {data.currentProForma && <td className="py-0.5 pl-3 text-right text-text-primary">{usd(pick(data.currentProForma))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

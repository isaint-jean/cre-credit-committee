'use client';

/**
 * PortfolioStructure — Phase A manual portfolio definition. The servicer hand-defines a
 * cross-collateralized loan's N properties (name/geo/type + value/NOI/NCF/occupancy + the
 * ALLOCATED loan amount) so the already-built rollup aggregator/composer/export run on a
 * real deal — before per-property doc extraction (Phase B). Servicer edits; others read-only.
 * DISPLAY/EXPORT-ONLY — persists on servicer_inputs, never re-mints. Honest-blank: fields
 * left empty stay empty (not 0). N>1 → the deal exports as a portfolio rollup.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import type { ManualPortfolioProperty, ManualPortfolioDefinition } from '@cre/contracts';

const BLANK_PROP: ManualPortfolioProperty = {
  propertyName: null, address: null, city: null, state: null, propertyType: null,
  netRentableSF: null, value: null, noi: null, ncf: null, occupancyPct: null, allocatedLoanAmount: null,
};

const numField = (v: number | null): string => (v === null ? '' : String(v));
const parseNum = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t.replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const strField = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export function PortfolioStructure({ poolId, loanInPoolId }: { poolId: string; loanInPoolId: string }) {
  const side = useSide();
  const canEdit = side === 'originator'; // the servicer defines; others view read-only
  const [props, setProps] = useState<ManualPortfolioProperty[]>([]);
  const [wholeLoanDS, setWholeLoanDS] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getPortfolioStructure(poolId, loanInPoolId)
      .then((r) => {
        if (cancelled) return;
        setProps(r.definition.properties.map((p) => ({ ...p })));
        setWholeLoanDS(r.definition.wholeLoanDebtService);
        setState('idle');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  function edit(i: number, patch: Partial<ManualPortfolioProperty>): void {
    setProps((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function save(): Promise<void> {
    if (!canEdit) return;
    setState('saving');
    const definition: ManualPortfolioDefinition = { properties: props, wholeLoanDebtService: wholeLoanDS };
    try {
      const r = await api.putPortfolioStructure(poolId, loanInPoolId, definition);
      setProps(r.definition.properties.map((p) => ({ ...p })));
      setWholeLoanDS(r.definition.wholeLoanDebtService);
      setState('saved');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('error');
    }
  }

  const allocSum = props.reduce((s, p) => s + (p.allocatedLoanAmount ?? 0), 0);
  const isPortfolio = props.length > 1;

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-baseline justify-between text-left" aria-expanded={open}>
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Portfolio structure</span>
          <span className="text-[11px] text-text-muted">One loan, N properties · allocated amounts · drives the rollup export</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-text-muted">
          {state === 'loading' ? 'Loading…' : `${props.length} propert${props.length === 1 ? 'y' : 'ies'}`}
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && state !== 'loading' && (
        <div className="mt-3 space-y-3">
          {props.length === 0 ? (
            <p className="text-xs text-text-secondary">No properties defined. A single-property deal underwrites as a single loan; add 2+ properties to underwrite the loan as a portfolio rollup.</p>
          ) : (
            <div className="space-y-3">
              {props.map((p, i) => (
                <div key={i} className="rounded border border-border-primary p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-text-primary">Property {i + 1}</span>
                    {canEdit && (
                      <button type="button" onClick={() => setProps((ps) => ps.filter((_, j) => j !== i))} className="text-[11px] text-risk-high hover:underline">Remove</button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Field label="Name" value={p.propertyName ?? ''} onChange={(v) => edit(i, { propertyName: strField(v) })} disabled={!canEdit} />
                    <Field label="City" value={p.city ?? ''} onChange={(v) => edit(i, { city: strField(v) })} disabled={!canEdit} />
                    <Field label="State" value={p.state ?? ''} onChange={(v) => edit(i, { state: strField(v) })} disabled={!canEdit} />
                    <Field label="Property type" value={p.propertyType ?? ''} onChange={(v) => edit(i, { propertyType: strField(v) })} disabled={!canEdit} />
                    <Field label="Net rentable SF" value={numField(p.netRentableSF)} onChange={(v) => edit(i, { netRentableSF: parseNum(v) })} disabled={!canEdit} />
                    <Field label="Occupancy (0–1)" value={numField(p.occupancyPct)} onChange={(v) => edit(i, { occupancyPct: parseNum(v) })} disabled={!canEdit} />
                    <Field label="Value ($)" value={numField(p.value)} onChange={(v) => edit(i, { value: parseNum(v) })} disabled={!canEdit} />
                    <Field label="NOI ($)" value={numField(p.noi)} onChange={(v) => edit(i, { noi: parseNum(v) })} disabled={!canEdit} />
                    <Field label="NCF ($)" value={numField(p.ncf)} onChange={(v) => edit(i, { ncf: parseNum(v) })} disabled={!canEdit} />
                    <Field label="Allocated loan ($)" value={numField(p.allocatedLoanAmount)} onChange={(v) => edit(i, { allocatedLoanAmount: parseNum(v) })} disabled={!canEdit} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => setProps((ps) => [...ps, { ...BLANK_PROP }])} className="rounded border border-border-primary px-2 py-1 text-xs text-text-primary hover:bg-bg-tertiary">+ Add property</button>
              <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                Whole-loan debt service ($/yr)
                <input value={numField(wholeLoanDS)} onChange={(e) => setWholeLoanDS(parseNum(e.target.value))} className="w-28 rounded border border-border-primary bg-bg-primary px-1 py-0.5 text-xs" placeholder="optional" />
              </label>
              <button type="button" onClick={() => { void save(); }} disabled={state === 'saving'} className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">
                {state === 'saving' ? 'Saving…' : 'Save portfolio'}
              </button>
              {state === 'saved' && <span className="text-[11px] text-risk-positive">Saved</span>}
              {state === 'error' && <span className="text-[11px] text-risk-high">Something went wrong — try again.</span>}
            </div>
          )}

          <p className="text-[11px] text-text-muted">
            {isPortfolio
              ? `${props.length} properties · allocated total $${allocSum.toLocaleString()}. This loan will export as a portfolio rollup. Allocated amounts drive the weighted aggregates + portfolio LTV / debt yield; blanks stay honest-unavailable.`
              : 'Add 2+ properties for a portfolio rollup. Fields left blank stay blank (never fabricated) — the human-in-the-loop boundary, per property.'}
          </p>
        </div>
      )}
    </section>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] text-text-muted">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="rounded border border-border-primary bg-bg-primary px-1.5 py-1 text-xs text-text-primary disabled:opacity-60" />
    </label>
  );
}

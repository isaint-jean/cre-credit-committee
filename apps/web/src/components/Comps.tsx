'use client';

/**
 * Comps — servicer-entered SALE comparables. The servicer adds up to 4 sale comps (fields +
 * a photo each); at export they fill the workbook's "Sales Comps" tab (rows 7-10 + embedded
 * photos). The SUBJECT row is auto-filled by the generator — the servicer enters only comps.
 * Servicer edits; others read-only. DISPLAY/EXPORT-ONLY — persists on servicer_inputs, never
 * re-mints. Honest-blank: fields left empty stay empty. (Lease comps come next.)
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { MAX_SALE_COMPS, type SaleComp, type SalesCompsPayload } from '@cre/contracts';

const BLANK: SaleComp = {
  buildingName: null, address: null, cityState: null, distance: null, direction: null,
  totalSf: null, yearBuilt: null, yearRenov: null, occupancyAtSale: null,
  saleDate: null, salePrice: null, capRate: null, pricePerMeasure: null, photoHash: null, photoFileName: null,
};
const numField = (v: number | null): string => (v === null ? '' : String(v));
const parseNum = (s: string): number | null => { const t = s.replace(/[$,%\s]/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const strField = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export function Comps({ poolId, loanInPoolId }: { poolId: string; loanInPoolId: string }) {
  const side = useSide();
  const canEdit = side === 'originator';
  const [comps, setComps] = useState<SaleComp[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fileRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getSalesComps(poolId, loanInPoolId)
      .then((r) => { if (!cancelled) { setComps(r.salesComps.comps.map((c) => ({ ...c }))); setState('idle'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  function edit(i: number, patch: Partial<SaleComp>): void {
    setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  async function save(next?: SaleComp[]): Promise<void> {
    if (!canEdit) return;
    setState('saving'); setErrorMsg(null);
    const payload: SalesCompsPayload = { comps: next ?? comps };
    try {
      const r = await api.putSalesComps(poolId, loanInPoolId, payload);
      setComps(r.salesComps.comps.map((c) => ({ ...c })));
      setState('saved'); setTimeout(() => setState('idle'), 1500);
    } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); setState('error'); }
  }

  async function onPickPhoto(i: number, e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = (e.target.files ?? [])[0];
    if (!file || !canEdit) return;
    try {
      const r = await api.uploadSalesCompPhoto(poolId, loanInPoolId, file);
      const next = comps.map((c, j) => (j === i ? { ...c, photoHash: r.hash, photoFileName: r.fileName } : c));
      setComps(next);
      await save(next); // persist the hash immediately so the thumbnail resolves
    } catch (err) { setErrorMsg(err instanceof Error ? err.message : String(err)); setState('error'); }
    const ref = fileRefs.current[i]; if (ref) ref.value = '';
  }

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-baseline justify-between text-left" aria-expanded={open}>
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Sales comps</span>
          <span className="text-[11px] text-text-muted">Servicer-entered sale comparables · fills the workbook Sales Comps tab</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-text-muted">
          {state === 'loading' ? 'Loading…' : `${comps.length}/${MAX_SALE_COMPS}`}
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && state !== 'loading' && (
        <div className="mt-3 space-y-3">
          {comps.length === 0 ? (
            <p className="text-xs text-text-secondary">No sale comps yet. Add up to {MAX_SALE_COMPS}; the subject row is filled automatically from the deal.</p>
          ) : (
            <div className="space-y-3">
              {comps.map((c, i) => (
                <div key={i} className="rounded border border-border-primary p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-text-primary">Comp {i + 1}</span>
                    {canEdit && <button type="button" onClick={() => { const next = comps.filter((_, j) => j !== i); setComps(next); void save(next); }} className="text-[11px] text-risk-high hover:underline">Remove</button>}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <F label="Building name" value={c.buildingName ?? ''} onChange={(v) => edit(i, { buildingName: strField(v) })} d={!canEdit} />
                    <F label="Address" value={c.address ?? ''} onChange={(v) => edit(i, { address: strField(v) })} d={!canEdit} />
                    <F label="City, State" value={c.cityState ?? ''} onChange={(v) => edit(i, { cityState: strField(v) })} d={!canEdit} />
                    <F label="Distance" value={c.distance ?? ''} onChange={(v) => edit(i, { distance: strField(v) })} d={!canEdit} />
                    <F label="Direction" value={c.direction ?? ''} onChange={(v) => edit(i, { direction: strField(v) })} d={!canEdit} />
                    <F label="Total SF" value={numField(c.totalSf)} onChange={(v) => edit(i, { totalSf: parseNum(v) })} d={!canEdit} />
                    <F label="Year built" value={numField(c.yearBuilt)} onChange={(v) => edit(i, { yearBuilt: parseNum(v) })} d={!canEdit} />
                    <F label="Year renov" value={numField(c.yearRenov)} onChange={(v) => edit(i, { yearRenov: parseNum(v) })} d={!canEdit} />
                    <F label="Occupancy at sale (0–1)" value={numField(c.occupancyAtSale)} onChange={(v) => edit(i, { occupancyAtSale: parseNum(v) })} d={!canEdit} />
                    <F label="Sale date" value={c.saleDate ?? ''} onChange={(v) => edit(i, { saleDate: strField(v) })} d={!canEdit} />
                    <F label="Sale price ($)" value={numField(c.salePrice)} onChange={(v) => edit(i, { salePrice: parseNum(v) })} d={!canEdit} />
                    <F label="Cap rate (0–1)" value={numField(c.capRate)} onChange={(v) => edit(i, { capRate: parseNum(v) })} d={!canEdit} />
                    <F label="Price / SF ($)" value={numField(c.pricePerMeasure)} onChange={(v) => edit(i, { pricePerMeasure: parseNum(v) })} d={!canEdit} />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    {c.photoHash ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={api.salesCompPhotoUrl(poolId, loanInPoolId, c.photoHash)} alt={c.photoFileName ?? 'comp'} className="h-16 w-24 rounded border border-border-primary object-cover" />
                    ) : <span className="text-[11px] text-text-muted">No photo</span>}
                    {canEdit && (
                      <input ref={(el) => { fileRefs.current[i] = el; }} type="file" accept="image/*" onChange={(e) => { void onPickPhoto(i, e); }} className="text-xs text-text-secondary" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              {comps.length < MAX_SALE_COMPS && <button type="button" onClick={() => setComps((cs) => [...cs, { ...BLANK }])} className="rounded border border-border-primary px-2 py-1 text-xs text-text-primary hover:bg-bg-tertiary">+ Add comp</button>}
              <button type="button" onClick={() => { void save(); }} disabled={state === 'saving'} className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">{state === 'saving' ? 'Saving…' : 'Save comps'}</button>
              {state === 'saved' && <span className="text-[11px] text-risk-positive">Saved</span>}
              {state === 'error' && <span className="text-[11px] text-risk-high">{errorMsg ?? 'Something went wrong — try again.'}</span>}
            </div>
          )}
          <p className="text-[11px] text-text-muted">Up to {MAX_SALE_COMPS} sale comps. Blank fields stay blank in the workbook (never fabricated); each photo is resized + embedded into its comp region. The subject row is filled automatically from the deal.</p>
        </div>
      )}
    </section>
  );
}

function F({ label, value, onChange, d }: { label: string; value: string; onChange: (v: string) => void; d: boolean }) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] text-text-muted">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={d} className="rounded border border-border-primary bg-bg-primary px-1.5 py-1 text-xs text-text-primary disabled:opacity-60" />
    </label>
  );
}

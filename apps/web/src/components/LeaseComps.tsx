'use client';

/**
 * LeaseComps — servicer-entered LEASE comparables (twin of Comps.tsx for sales). Up to 4 comps,
 * each the shared fields + a photo + the rate metrics FOR THE DEAL'S ASSET TYPE (commercial:
 * lease type / lease rate / exp. reimb.; MF-SS-MHC: concessions / monthly rent / rent PSF;
 * hotel: rack rate / ADR / RevPAR). At export they fill the "Lease Comps" tab. Subject row is
 * auto-filled by the generator. Servicer edits; others read-only. DISPLAY/EXPORT-ONLY, mint-safe.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { MAX_LEASE_COMPS, leaseRateModeForAssetType, type LeaseComp, type LeaseCompsPayload, type AssetType } from '@cre/contracts';

const BLANK: LeaseComp = {
  buildingName: null, address: null, cityState: null, distance: null, direction: null,
  totalSf: null, yearBuilt: null, yearRenov: null, occupancy: null,
  leaseType: null, leaseRate: null, expenseReimb: null,
  concessions: null, monthlyRent: null, rentPsf: null,
  rackRate: null, adr: null, revPar: null, photoHash: null, photoFileName: null,
};
const numField = (v: number | null): string => (v === null ? '' : String(v));
const parseNum = (s: string): number | null => { const t = s.replace(/[$,%\s]/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const strField = (s: string): string | null => (s.trim() === '' ? null : s.trim());

// The 3 rate fields (key + label + numeric?) shown for the deal's asset type.
type RateField = { key: keyof LeaseComp; label: string; numeric: boolean };
function rateFieldsFor(assetType: AssetType | null): RateField[] {
  switch (leaseRateModeForAssetType(assetType)) {
    case 'hotel': return [
      { key: 'rackRate', label: 'Rack rate ($)', numeric: true },
      { key: 'adr', label: 'ADR ($)', numeric: true },
      { key: 'revPar', label: 'RevPAR ($)', numeric: true },
    ];
    case 'residential': return [
      { key: 'concessions', label: 'Concessions ($)', numeric: true },
      { key: 'monthlyRent', label: 'Monthly rent ($)', numeric: true },
      { key: 'rentPsf', label: 'Rent / SF ($)', numeric: true },
    ];
    case 'commercial': default: return [
      { key: 'leaseType', label: 'Lease type', numeric: false },
      { key: 'leaseRate', label: 'Lease rate ($)', numeric: true },
      { key: 'expenseReimb', label: 'Exp. reimb. ($)', numeric: true },
    ];
  }
}

export function LeaseComps({ poolId, loanInPoolId, assetType }: { poolId: string; loanInPoolId: string; assetType: AssetType | null }) {
  const side = useSide();
  const canEdit = side === 'originator';
  const [comps, setComps] = useState<LeaseComp[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fileRefs = useRef<Array<HTMLInputElement | null>>([]);
  const rateFields = rateFieldsFor(assetType);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getLeaseComps(poolId, loanInPoolId)
      .then((r) => { if (!cancelled) { setComps(r.leaseComps.comps.map((c) => ({ ...c }))); setState('idle'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  function edit(i: number, patch: Partial<LeaseComp>): void {
    setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  async function save(next?: LeaseComp[]): Promise<void> {
    if (!canEdit) return;
    setState('saving'); setErrorMsg(null);
    const payload: LeaseCompsPayload = { comps: next ?? comps };
    try {
      const r = await api.putLeaseComps(poolId, loanInPoolId, payload);
      setComps(r.leaseComps.comps.map((c) => ({ ...c })));
      setState('saved'); setTimeout(() => setState('idle'), 1500);
    } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); setState('error'); }
  }

  async function onPickPhoto(i: number, e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = (e.target.files ?? [])[0];
    if (!file || !canEdit) return;
    try {
      const r = await api.uploadLeaseCompPhoto(poolId, loanInPoolId, file);
      const next = comps.map((c, j) => (j === i ? { ...c, photoHash: r.hash, photoFileName: r.fileName } : c));
      setComps(next);
      await save(next);
    } catch (err) { setErrorMsg(err instanceof Error ? err.message : String(err)); setState('error'); }
    const ref = fileRefs.current[i]; if (ref) ref.value = '';
  }

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-baseline justify-between text-left" aria-expanded={open}>
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Lease comps</span>
          <span className="text-[11px] text-text-muted">Servicer-entered lease comparables · fills the workbook Lease Comps tab</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-text-muted">
          {state === 'loading' ? 'Loading…' : `${comps.length}/${MAX_LEASE_COMPS}`}
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && state !== 'loading' && (
        <div className="mt-3 space-y-3">
          {comps.length === 0 ? (
            <p className="text-xs text-text-secondary">No lease comps yet. Add up to {MAX_LEASE_COMPS}; the rate fields match the deal&apos;s asset type. The subject row is filled automatically.</p>
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
                    <F label="Total SF / units" value={numField(c.totalSf)} onChange={(v) => edit(i, { totalSf: parseNum(v) })} d={!canEdit} />
                    <F label="Year built" value={numField(c.yearBuilt)} onChange={(v) => edit(i, { yearBuilt: parseNum(v) })} d={!canEdit} />
                    <F label="Year renov" value={numField(c.yearRenov)} onChange={(v) => edit(i, { yearRenov: parseNum(v) })} d={!canEdit} />
                    <F label="Occupancy (0–1)" value={numField(c.occupancy)} onChange={(v) => edit(i, { occupancy: parseNum(v) })} d={!canEdit} />
                    {rateFields.map((rf) => (
                      <F key={rf.key} label={rf.label}
                        value={rf.numeric ? numField(c[rf.key] as number | null) : ((c[rf.key] as string | null) ?? '')}
                        onChange={(v) => edit(i, { [rf.key]: rf.numeric ? parseNum(v) : strField(v) } as Partial<LeaseComp>)}
                        d={!canEdit} />
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    {c.photoHash ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={api.leaseCompPhotoUrl(poolId, loanInPoolId, c.photoHash)} alt={c.photoFileName ?? 'comp'} className="h-16 w-24 rounded border border-border-primary object-cover" />
                    ) : <span className="text-[11px] text-text-muted">No photo</span>}
                    {canEdit && <input ref={(el) => { fileRefs.current[i] = el; }} type="file" accept="image/*" onChange={(e) => { void onPickPhoto(i, e); }} className="text-xs text-text-secondary" />}
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              {comps.length < MAX_LEASE_COMPS && <button type="button" onClick={() => setComps((cs) => [...cs, { ...BLANK }])} className="rounded border border-border-primary px-2 py-1 text-xs text-text-primary hover:bg-bg-tertiary">+ Add comp</button>}
              <button type="button" onClick={() => { void save(); }} disabled={state === 'saving'} className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">{state === 'saving' ? 'Saving…' : 'Save comps'}</button>
              {state === 'saved' && <span className="text-[11px] text-risk-positive">Saved</span>}
              {state === 'error' && <span className="text-[11px] text-risk-high">{errorMsg ?? 'Something went wrong — try again.'}</span>}
            </div>
          )}
          <p className="text-[11px] text-text-muted">Up to {MAX_LEASE_COMPS} lease comps. Rate fields match the deal&apos;s asset type; blank fields stay blank; each photo is resized + embedded. The subject row is filled automatically.</p>
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

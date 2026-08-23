'use client';

/**
 * SiteInspection — the servicer's structured inspection FORM (7 sections, ~57 free-text/number
 * fields) that fills the workbook's "Site Inspection" tab at export. One form (not a list).
 * Servicer edits; others read-only. DISPLAY/EXPORT-ONLY — persists on servicer_inputs, never
 * re-mints. Honest-blank: fields left empty stay empty. NRA / Occupancy / Year Built / Renov
 * fill automatically from the deal (shown as a note, not entered here).
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { isSiteInspectionNumberField, type SiteInspection as SiteInspectionData } from '@cre/contracts';

// The form layout: sections → [fieldId, label]. Field ids match the contract + the cell map.
const SECTIONS: ReadonlyArray<{ title: string; fields: ReadonlyArray<[string, string]> }> = [
  { title: 'Property Summary', fields: [
    ['numberOfBldgs', 'Number of Bldgs.'], ['numberOfStories', 'Number of Stories'], ['elevators', 'Elevators'],
    ['parkingSpaces', 'Parking Spaces'], ['dateAcquired', 'Date Acquired'], ['propertyQuality', 'Property Quality'],
  ] },
  { title: 'Location / Neighborhood', fields: [
    ['cornerLocation', 'Corner Location'], ['ingressEgress', 'Ingress & Egress'], ['areaType', 'Area Type'],
    ['growthPattern', 'Growth Pattern'], ['visibility', 'Visibility'], ['newConstruction', 'New Construction'],
    ['streetAppeal', 'Street Appeal'], ['changeInUse', 'Change in Use'], ['roadwayType', 'Roadway Type'],
    ['signalized', 'Signalized'], ['trafficVolume', 'Traffic Volume'],
  ] },
  { title: 'Neighborhood Development (% mix)', fields: [
    ['residential', 'Residential'], ['office', 'Office'], ['multiFamily', 'Multi Family'],
    ['industrial', 'Industrial'], ['retail', 'Retail'], ['hotel', 'Hotel'],
  ] },
  { title: 'Competitive Set', fields: [
    ['generalComparisonToComps', 'General Comparison to Market Comps'], ['rentLevelVsCompSet', 'Rent Level vs. Comp Set'],
    ['occupancyVsCompSet', 'Occupancy vs. Comp Set'], ['newSupply', 'New Supply'], ['sponsorExposure', 'Sponsor Exposure to Market'],
  ] },
  { title: 'Property Management', fields: [
    ['managementCompany', 'Management Company'], ['borrowerSponsorAffiliated', 'Borrower / Sponsor Affiliated'],
    ['marketExperienceLevel', 'Market Experience Level'], ['reputation', 'Reputation'],
  ] },
  { title: 'Construction Details', fields: [
    ['exteriorConstruction', 'Exterior Construction'], ['roofConstruction', 'Roof (construction)'], ['sprinklers', 'Sprinklers'], ['hvac', 'HVAC'],
    ['exteriorCondition', 'Exterior Condition'], ['interiorCondition', 'Interior Condition'],
    ['extGeneralCondition', 'General Condition (ext)'], ['intGeneralCondition', 'General Condition (int)'],
    ['windows', 'Windows'], ['ceilings', 'Ceilings'], ['landscaping', 'Landscaping'], ['paint', 'Paint'],
    ['roofCondition', 'Roof (condition)'], ['walls', 'Walls (int)'], ['roads', 'Roads'], ['commonAreas', 'Common Areas'],
    ['parking', 'Parking'], ['flooring', 'Flooring'], ['extWalls', 'Walls (ext)'], ['lighting', 'Lighting'],
  ] },
  { title: 'Inspection Details', fields: [
    ['dateOfInspectionTop', 'Date of Inspection'], ['dateOfInspection', 'Date of Inspection (detail)'],
    ['company', 'Company'], ['dayOfWeekTime', 'Day of Week / Time'], ['contactTitle', 'Contact / Title'],
  ] },
];

const parseNum = (s: string): number | null => { const t = s.replace(/[$,%\s]/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const strField = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export function SiteInspection({ poolId, loanInPoolId }: { poolId: string; loanInPoolId: string }) {
  const side = useSide();
  const canEdit = side === 'originator';
  const [data, setData] = useState<Record<string, string | number | null>>({});
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getSiteInspection(poolId, loanInPoolId)
      .then((r) => { if (!cancelled) { setData({ ...(r.siteInspection as Record<string, string | number | null>) }); setState('idle'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  function fieldValue(id: string): string {
    const v = data[id];
    return v === null || v === undefined ? '' : String(v);
  }
  function edit(id: string, raw: string): void {
    setData((d) => ({ ...d, [id]: isSiteInspectionNumberField(id) ? parseNum(raw) : strField(raw) }));
  }

  async function save(): Promise<void> {
    if (!canEdit) return;
    setState('saving'); setErrorMsg(null);
    try {
      const r = await api.putSiteInspection(poolId, loanInPoolId, data as SiteInspectionData);
      setData({ ...(r.siteInspection as Record<string, string | number | null>) });
      setState('saved'); setTimeout(() => setState('idle'), 1500);
    } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); setState('error'); }
  }

  const filledCount = Object.values(data).filter((v) => v !== null && v !== undefined && v !== '').length;

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-baseline justify-between text-left" aria-expanded={open}>
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Site Inspection</span>
          <span className="text-[11px] text-text-muted">Structured inspection form · fills the workbook Site Inspection tab</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-text-muted">
          {state === 'loading' ? 'Loading…' : `${filledCount} filled`}
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && state !== 'loading' && (
        <div className="mt-3 space-y-4">
          <p className="rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-[11px] text-text-muted">
            NRA, Current Occupancy and Year Built / Renovated fill automatically from the deal — no need to enter them here.
          </p>
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{sec.title}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {sec.fields.map(([id, label]) => (
                  <label key={id} className="flex flex-col gap-0.5 text-[10px] text-text-muted">
                    {label}
                    <input
                      value={fieldValue(id)}
                      onChange={(e) => edit(id, e.target.value)}
                      disabled={!canEdit}
                      inputMode={isSiteInspectionNumberField(id) ? 'decimal' : undefined}
                      className="rounded border border-border-primary bg-bg-primary px-1.5 py-1 text-xs text-text-primary disabled:opacity-60"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => { void save(); }} disabled={state === 'saving'} className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50">{state === 'saving' ? 'Saving…' : 'Save inspection'}</button>
              {state === 'saved' && <span className="text-[11px] text-risk-positive">Saved</span>}
              {state === 'error' && <span className="text-[11px] text-risk-high">{errorMsg ?? 'Something went wrong — try again.'}</span>}
            </div>
          )}
          <p className="text-[11px] text-text-muted">Free text; blank fields stay blank in the workbook (never fabricated). The Neighborhood Development mix and counts take numbers.</p>
        </div>
      )}
    </section>
  );
}

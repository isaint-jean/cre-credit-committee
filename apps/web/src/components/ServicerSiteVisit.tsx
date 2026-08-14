'use client';

/**
 * ServicerSiteVisit — Phase 2 fillable human input. The servicer records a site-
 * visit note; it flows into the workbook (Site Inspection) + the memo's due-
 * diligence red-flags section. DISPLAY-ONLY: additive annotation, never re-scores.
 *
 * The SERVICER (originator side) can fill/edit/save; buyer/admin see it read-only.
 * Calm + uncluttered — a labeled textarea with saved state + who/when.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';

type Saved = { value: string; author: string; updatedAt: string } | null;

export function ServicerSiteVisit({ poolId, loanInPoolId }: { poolId: string; loanInPoolId: string }) {
  const side = useSide();
  const canEdit = side === 'originator'; // the servicer writes; others read-only
  const [saved, setSaved] = useState<Saved>(null);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getServicerInputs(poolId, loanInPoolId)
      .then((r) => {
        if (cancelled) return;
        const sv = r.inputs.find((i) => i.fieldType === 'site_visit') ?? null;
        setSaved(sv);
        setDraft(sv?.value ?? '');
        setState('idle');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  async function save() {
    if (!canEdit || draft.trim().length === 0) return;
    setState('saving');
    try {
      const { input } = await api.putServicerInput(poolId, loanInPoolId, 'site_visit', draft.trim());
      setSaved({ value: input.value, author: input.author, updatedAt: input.updatedAt });
      setDirty(false);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  const fmtWhen = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-text-primary">Site visit</h3>
        <span className="text-[11px] text-text-muted">Servicer field observation · display-only</span>
      </div>

      {state === 'loading' ? (
        <div className="mt-2 text-xs text-text-secondary">Loading…</div>
      ) : canEdit ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
            placeholder="What the servicer saw on site — condition, deferred maintenance, occupancy, anything a spreadsheet won't tell you."
            rows={4}
            className="w-full rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-xs text-text-primary"
          />
          <div className="mt-1 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={state === 'saving' || !dirty || draft.trim().length === 0}
              className="rounded border border-accent/40 bg-accent-soft px-2 py-1 text-xs text-accent hover:opacity-80 disabled:opacity-50"
            >
              {state === 'saving' ? 'Saving…' : saved ? 'Update' : 'Save'}
            </button>
            {saved && !dirty && (
              <span className="text-[11px] text-text-muted">Saved {fmtWhen(saved.updatedAt)} by {saved.author}</span>
            )}
            {state === 'error' && <span className="text-[11px] text-risk-high">Couldn’t save — try again.</span>}
          </div>
        </div>
      ) : saved ? (
        <div className="mt-2 text-xs">
          <p className="whitespace-pre-wrap text-text-primary">{saved.value}</p>
          <p className="mt-1 text-[11px] text-text-muted">Recorded {fmtWhen(saved.updatedAt)} by {saved.author}</p>
        </div>
      ) : (
        <div className="mt-2 text-xs text-text-secondary">No site-visit note yet.</div>
      )}
    </section>
  );
}

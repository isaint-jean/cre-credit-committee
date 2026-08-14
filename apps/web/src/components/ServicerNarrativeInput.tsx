'use client';

/**
 * ServicerNarrativeInput — Phase 2 fillable human input (reusable across the
 * narrative field types: site_visit, broker_feedback, …). The servicer records a
 * note; it flows into the workbook + the memo's due-diligence red-flags section.
 * DISPLAY-ONLY: additive annotation, never re-scores.
 *
 * The SERVICER (originator side) fills/edits/saves; buyer/admin see it read-only.
 * Calm + uncluttered — a labeled textarea with saved state + who/when.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';

type Saved = { value: string; author: string; updatedAt: string } | null;

export function ServicerNarrativeInput({
  poolId,
  loanInPoolId,
  fieldType,
  label,
  eyebrow,
  placeholder,
}: {
  poolId: string;
  loanInPoolId: string;
  fieldType: string;
  label: string;
  eyebrow: string;
  placeholder: string;
}) {
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
        const found = r.inputs.find((i) => i.fieldType === fieldType) ?? null;
        setSaved(found);
        setDraft(found?.value ?? '');
        setState('idle');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId, fieldType]);

  async function save() {
    if (!canEdit || draft.trim().length === 0) return;
    setState('saving');
    try {
      const { input } = await api.putServicerInput(poolId, loanInPoolId, fieldType, draft.trim());
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
        <h3 className="text-sm font-medium text-text-primary">{label}</h3>
        <span className="text-[11px] text-text-muted">{eyebrow} · display-only</span>
      </div>

      {state === 'loading' ? (
        <div className="mt-2 text-xs text-text-secondary">Loading…</div>
      ) : canEdit ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
            placeholder={placeholder}
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
        <div className="mt-2 text-xs text-text-secondary">No {label.toLowerCase()} note yet.</div>
      )}
    </section>
  );
}

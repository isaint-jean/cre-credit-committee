'use client';

/**
 * SiteVisitChecklist — Phase 2 v1. A per-loan site-visit / PCR checklist that
 * generates from the loan's AssetType (BASE items only in v1; no engine-flag
 * triggers yet). The SERVICER works through it: checks items off, adds their own,
 * and can toggle "prefer Asset Manager to visit".
 *
 * DISPLAY-ONLY / MINT-SAFE. State is a JSON payload stored on servicer_inputs
 * (fieldType 'site_visit_checklist') via the same transport the narrative inputs
 * use — an additive annotation that never re-scores. The SERVICER (originator side)
 * fills/edits; buyer/admin see it read-only.
 *
 * Collapsible ("not too much screen space"): a compact header with the completion
 * summary; the item groups expand on demand.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import {
  buildChecklist,
  parseChecklistPayload,
  CHECKLIST_CATALOG_VERSION,
  type AssetType,
  type ChecklistPayload,
  type ChecklistAddedItem,
} from '@cre/contracts';

const FIELD_TYPE = 'site_visit_checklist';

export function SiteVisitChecklist({
  poolId,
  loanInPoolId,
  assetType,
}: {
  poolId: string;
  loanInPoolId: string;
  assetType: AssetType | null;
}) {
  const side = useSide();
  const canEdit = side === 'originator'; // the servicer writes; others read-only

  const checklist = useMemo(() => buildChecklist(assetType), [assetType]);
  const totalItems = useMemo(
    () => checklist.groups.reduce((n, g) => n + g.items.length, 0),
    [checklist],
  );

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<ChecklistAddedItem[]>([]);
  const [preferAM, setPreferAM] = useState(false);
  const [savedMeta, setSavedMeta] = useState<{ author: string; updatedAt: string } | null>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const [newItem, setNewItem] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getServicerInputs(poolId, loanInPoolId)
      .then((r) => {
        if (cancelled) return;
        const found = r.inputs.find((i) => i.fieldType === FIELD_TYPE) ?? null;
        const payload = parseChecklistPayload(found?.value ?? null);
        setChecked(new Set(payload.checked));
        setAdded([...payload.added]);
        setPreferAM(payload.preferAssetManagerVisit);
        setSavedMeta(found ? { author: found.author, updatedAt: found.updatedAt } : null);
        setDirty(false);
        setState('idle');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  const doneCount = checked.size;

  function toggleItem(id: string): void {
    if (!canEdit) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setDirty(true);
  }

  function addOwnItem(): void {
    if (!canEdit) return;
    const text = newItem.trim();
    if (text.length === 0) return;
    const id = `added-${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${doneCount}-${added.length}-${text.length}`}`;
    setAdded((prev) => [...prev, { id, text }]);
    setChecked((prev) => new Set(prev).add(id)); // an added item starts checked (it was done/observed)
    setNewItem('');
    setDirty(true);
  }

  function removeAdded(id: string): void {
    if (!canEdit) return;
    setAdded((prev) => prev.filter((a) => a.id !== id));
    setChecked((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setDirty(true);
  }

  async function save(): Promise<void> {
    if (!canEdit) return;
    setState('saving');
    const payload: ChecklistPayload = {
      checked: [...checked],
      added,
      preferAssetManagerVisit: preferAM,
      assetType,
      version: CHECKLIST_CATALOG_VERSION,
    };
    try {
      const { input } = await api.putServicerInput(poolId, loanInPoolId, FIELD_TYPE, JSON.stringify(payload));
      setSavedMeta({ author: input.author, updatedAt: input.updatedAt });
      setDirty(false);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  const fmtWhen = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline justify-between text-left"
        aria-expanded={open}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Site-visit checklist</span>
          <span className="text-[11px] text-text-muted">
            {checklist.assetKey === 'Other' ? 'generic' : checklist.assetKey} · display-only
          </span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-text-muted">
          {state === 'loading' ? 'Loading…' : `${doneCount}/${totalItems}`}
          {preferAM && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">AM visit</span>}
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && state !== 'loading' && (
        <div className="mt-3 space-y-3">
          {checklist.groups.map((g) => (
            <div key={g.key}>
              <p className="text-[11px] uppercase tracking-wide text-text-secondary">{g.label}</p>
              <ul className="mt-1 space-y-0.5">
                {g.items.map((it) => (
                  <li key={it.id} className="text-xs">
                    <label className={`flex items-start gap-2 ${canEdit ? 'cursor-pointer' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked.has(it.id)}
                        onChange={() => toggleItem(it.id)}
                        disabled={!canEdit}
                        className="mt-0.5"
                      />
                      <span className={checked.has(it.id) ? 'text-text-muted line-through' : 'text-text-primary'}>
                        {it.watch && <span className="text-risk-high" title="Look closely">⚠ </span>}
                        {it.text}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Servicer-added items */}
          {added.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-text-secondary">Added by servicer</p>
              <ul className="mt-1 space-y-0.5">
                {added.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 text-xs">
                    <label className={`flex flex-1 items-start gap-2 ${canEdit ? 'cursor-pointer' : ''}`}>
                      <input type="checkbox" checked={checked.has(a.id)} onChange={() => toggleItem(a.id)} disabled={!canEdit} className="mt-0.5" />
                      <span className={checked.has(a.id) ? 'text-text-muted line-through' : 'text-text-primary'}>{a.text}</span>
                    </label>
                    {canEdit && (
                      <button type="button" onClick={() => removeAdded(a.id)} className="text-[11px] text-text-muted hover:text-risk-high" title="Remove">×</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canEdit && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOwnItem(); } }}
                placeholder="Add your own item…"
                className="flex-1 rounded border border-border-primary bg-bg-tertiary px-2 py-1 text-xs text-text-primary"
              />
              <button type="button" onClick={addOwnItem} disabled={newItem.trim().length === 0} className="rounded border border-border-primary px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">Add</button>
            </div>
          )}

          {/* Prefer Asset Manager to visit */}
          <label className={`flex items-center gap-2 text-xs ${canEdit ? 'cursor-pointer' : ''}`}>
            <input
              type="checkbox"
              checked={preferAM}
              onChange={() => { if (canEdit) { setPreferAM((v) => !v); setDirty(true); } }}
              disabled={!canEdit}
            />
            <span className="text-text-primary">Prefer Asset Manager to visit (critical asset)</span>
          </label>

          {canEdit && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => { void save(); }}
                disabled={state === 'saving' || !dirty}
                className="rounded border border-accent/40 bg-accent-soft px-2 py-1 text-xs text-accent hover:opacity-80 disabled:opacity-50"
              >
                {state === 'saving' ? 'Saving…' : savedMeta ? 'Update' : 'Save'}
              </button>
              {savedMeta && !dirty && (
                <span className="text-[11px] text-text-muted">Saved {fmtWhen(savedMeta.updatedAt)} by {savedMeta.author}</span>
              )}
              {state === 'error' && <span className="text-[11px] text-risk-high">Couldn’t save — try again.</span>}
            </div>
          )}
          {!canEdit && savedMeta && (
            <p className="text-[11px] text-text-muted">Recorded {fmtWhen(savedMeta.updatedAt)} by {savedMeta.author}</p>
          )}
        </div>
      )}
    </section>
  );
}

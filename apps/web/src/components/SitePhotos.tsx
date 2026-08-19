'use client';

/**
 * SitePhotos — Chunk 1 capture widget. The servicer uploads site-visit photos (any count);
 * each is stored in the blob store and associated to the loan via servicer_inputs 'site_photos'.
 * Thumbnails render via the serve endpoint. DISPLAY-ONLY; the SERVICER (originator) uploads /
 * removes, buyer/admin see thumbnails read-only. Collapsible, calm — matches the other inputs.
 *
 * No resize yet (Chunk 4) and no workbook embedding yet (Chunk 3) — just capture + list + delete.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { parseSitePhotos, type SitePhotoRef } from '@cre/contracts';

export function SitePhotos({ poolId, loanInPoolId }: { poolId: string; loanInPoolId: string }) {
  const side = useSide();
  const canEdit = side === 'originator'; // the servicer uploads; others view read-only
  const [photos, setPhotos] = useState<SitePhotoRef[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'uploading' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    api.getServicerInputs(poolId, loanInPoolId)
      .then((r) => {
        if (cancelled) return;
        const found = r.inputs.find((i) => i.fieldType === 'site_photos');
        setPhotos(parseSitePhotos(found?.value ?? null).photos.slice());
        setState('idle');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [poolId, loanInPoolId]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0 || !canEdit) return;
    setState('uploading');
    setErrorMsg(null);
    try {
      const r = await api.uploadSitePhotos(poolId, loanInPoolId, files);
      setPhotos(r.photos);
      setState('idle');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  async function remove(hash: string): Promise<void> {
    if (!canEdit) return;
    try {
      const r = await api.deleteSitePhoto(poolId, loanInPoolId, hash);
      setPhotos(r.photos);
    } catch {
      setState('error');
    }
  }

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline justify-between text-left"
        aria-expanded={open}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">Site photos</span>
          <span className="text-[11px] text-text-muted">Servicer field photos · display-only</span>
        </span>
        <span className="flex items-center gap-2 text-[11px] text-text-muted">
          {state === 'loading' ? 'Loading…' : `${photos.length}`}
          <span aria-hidden>{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && state !== 'loading' && (
        <div className="mt-3 space-y-3">
          {photos.length === 0 ? (
            <p className="text-xs text-text-secondary">No site photos yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.hash} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={api.sitePhotoUrl(poolId, loanInPoolId, p.hash)}
                    alt={p.fileName}
                    title={p.fileName}
                    loading="lazy"
                    className="h-24 w-full rounded border border-border-primary object-cover"
                  />
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => { void remove(p.hash); }}
                      className="absolute right-1 top-1 rounded bg-black/60 px-1 text-xs leading-none text-white hover:bg-risk-high"
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <div className="flex items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => { void onPick(e); }}
                disabled={state === 'uploading'}
                className="text-xs text-text-secondary"
              />
              {state === 'uploading' && <span className="text-[11px] text-text-muted">Uploading…</span>}
              {state === 'error' && <span className="text-[11px] text-risk-high">{errorMsg ?? 'Something went wrong — try again.'}</span>}
            </div>
          )}

          <p className="text-[11px] text-text-muted">
            Any number of photos. Stored full-size for now; positioned into the workbook’s Site Photos grid at export (coming next).
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * NewDealForm — Data Room v2 Piece A. The REAL "New deal" action that replaces
 * the old DisabledAffordance on the pool home base.
 *
 * "Create new deal" MINTS the deal AND its room as one connected act: a pool is
 * the deal, and the data room keys on the returned pool.id from birth
 * (data_room_doc.pool_id) — no separate room-attach step. On a successful 201 we
 * navigate the user straight into the new deal's data room, an empty room ready
 * for the first drop.
 *
 * FIELDS: shelfName (required text), vintage (required int, defaults to the
 * current year), seller (optional text).
 *
 * ★ HONEST RBAC CAVEAT: pool creation is NOT bank-access-controlled. No
 * bank/counterparty role exists yet (pool RBAC is deferred), so this flow is a
 * ROLE PROXY, not enforced RBAC. The note below labels that honestly — it makes
 * NO "banks-only" / "banks can create deals" enforcement claim, because none is
 * enforced. The button is NOT gated on a fake role.
 *
 * FRONTEND-ONLY over the shipped POST /api/pools (pool.routes.ts).
 */
'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { sideAccent, withSide } from '@/lib/side-accent';

type SubmitState = 'idle' | 'pending';

export function NewDealForm() {
  const side = useSide();
  const accent = sideAccent(side);
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [shelfName, setShelfName] = useState('');
  const [vintage, setVintage] = useState<string>(String(new Date().getFullYear()));
  const [seller, setSeller] = useState('');
  const [submit, setSubmit] = useState<SubmitState>('idle');
  const [err, setErr] = useState<string | null>(null);

  const reset = useCallback(() => {
    setShelfName('');
    setVintage(String(new Date().getFullYear()));
    setSeller('');
    setErr(null);
    setSubmit('idle');
  }, []);

  const close = useCallback(() => {
    if (submit === 'pending') return; // don't drop the modal mid-flight
    setOpen(false);
    reset();
  }, [submit, reset]);

  const nameOk = shelfName.trim() !== '';
  const vintageNum = Number(vintage);
  const vintageOk = vintage.trim() !== '' && Number.isInteger(vintageNum);
  const canSubmit = nameOk && vintageOk && submit === 'idle';

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setSubmit('pending');
      setErr(null);
      try {
        const { pool } = await api.createPool({
          shelfName: shelfName.trim(),
          vintage: vintageNum,
          seller: seller.trim() === '' ? null : seller.trim(),
        });
        // Land the user IN the new deal — its data room, connected from birth
        // (keyed by pool.id), empty and ready for the first drop.
        router.push(withSide(`/pools/${pool.id}/data-room`, side));
      } catch (e2) {
        setErr((e2 as Error).message || 'Could not create the deal.');
        setSubmit('idle');
      }
    },
    [canSubmit, shelfName, vintageNum, seller, router, side],
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded
                    border ${accent.border} ${accent.text} bg-bg-tertiary
                    hover:${accent.softBg} transition-colors`}
      >
        <span className="text-sm leading-none">+</span>
        <span>New deal</span>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create a new deal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md bg-bg-secondary border border-border-primary rounded-panel shadow-card p-6"
      >
        <header className="mb-4">
          <h2 className="font-display text-lg font-semibold text-text-primary mb-1">New deal</h2>
          <p className="text-xs text-text-secondary">
            Creating a deal mints its pool and its data room together — the room is
            keyed to the deal from birth and opens empty, ready for the first drop.
          </p>
        </header>

        <div className="space-y-4">
          <label className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide text-text-muted mb-1">
              Shelf name <span className="text-risk-high">*</span>
            </span>
            <input
              type="text"
              value={shelfName}
              onChange={(e) => setShelfName(e.target.value)}
              placeholder="e.g. BANK 2026-C1"
              autoFocus
              disabled={submit === 'pending'}
              className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                         focus:outline-none focus:border-accent placeholder-text-muted disabled:opacity-60"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-text-muted mb-1">
                Vintage <span className="text-risk-high">*</span>
              </span>
              <input
                type="number"
                value={vintage}
                onChange={(e) => setVintage(e.target.value)}
                placeholder={String(new Date().getFullYear())}
                disabled={submit === 'pending'}
                className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                           focus:outline-none focus:border-accent placeholder-text-muted disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-text-muted mb-1">
                Seller <span className="text-text-muted normal-case">(optional)</span>
              </span>
              <input
                type="text"
                value={seller}
                onChange={(e) => setSeller(e.target.value)}
                placeholder="Originator"
                disabled={submit === 'pending'}
                className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                           focus:outline-none focus:border-accent placeholder-text-muted disabled:opacity-60"
              />
            </label>
          </div>
        </div>

        {/* ★ HONEST RBAC label — no false "banks-only" enforcement claim. */}
        <p className="mt-4 text-[11px] leading-relaxed text-text-muted border-t border-border-primary/50 pt-3">
          Note: deal creation is not yet access-controlled. A dedicated
          bank / counterparty role is planned but not enforced today.
        </p>

        {err !== null && (
          <div className="mt-4 bg-risk-high/10 border border-risk-high/30 rounded p-3 text-risk-high text-xs">
            Could not create the deal: {err}
          </div>
        )}

        <footer className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={close}
            disabled={submit === 'pending'}
            className="text-xs text-text-muted hover:text-text-primary px-3 py-2 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded
                        border ${accent.border} ${accent.text} bg-bg-tertiary
                        hover:${accent.softBg} transition-colors
                        disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {submit === 'pending' ? 'Creating…' : 'Create deal'}
          </button>
        </footer>
      </form>
    </div>
  );
}

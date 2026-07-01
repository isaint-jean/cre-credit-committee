/**
 * /pools — DEAL-PICKER HOME BASE.
 *
 * The screen Isabelle lands on. A B-piece buyer works 2–3 deals at once, so the
 * top-level selector IS the deal (pool). Each active deal is a card communicating
 * AT A GLANCE: name, seller/originator, vintage, current tape, loan count,
 * status breakdown, and ★ whether something is waiting (open working tape in
 * review / under-review loans / kick-flagged loans).
 *
 * Layout (the deliberate choices — easy to restyle):
 *   - Hero: "Active deals" grid of `DealCard` (responsive 1/2/3 columns).
 *   - Below: "Inactive / closed" section, de-emphasized, collapsed by default.
 *   - Filters (vintage / seller) are SECONDARY — they sit in a small toolbar.
 *
 * READ-ONLY (PR6 — same lane as PR5). Clicking a card navigates; no mutation.
 * "Create pool" stays a DisabledAffordance until the next slice.
 *
 * Design choices stated plainly for redirect:
 *   - Cards in a CSS grid (not a table). Tables read as "data dump"; cards read
 *     as "things I can pick from." Fits the workspace mental model.
 *   - Each card is self-contained (`DealCard.tsx`) so visual iteration is one
 *     file to edit, not a tangle across this page.
 *   - "What's waiting" footer + status badge are the load-bearing signals.
 *   - Inactive section uses the same card component but renders under a
 *     collapsed-by-default disclosure; old pools don't shout for attention.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import type { Pool } from '@cre/contracts';
import { DealCard } from '@/components/PoolRail/DealCard';
import { DisabledAffordance } from '@/components/PoolRail/DisabledAffordance';
import { useSide } from '@/lib/side-context';
import { sideAccent } from '@/lib/side-accent';

type LoadState = 'loading' | 'loaded' | 'error';

export default function PoolHomeBasePage() {
  const side = useSide();
  const accent = sideAccent(side);
  const [pools, setPools] = useState<Pool[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [vintage, setVintage] = useState<string>('');
  const [seller, setSeller] = useState<string>('');
  const [showInactive, setShowInactive] = useState<boolean>(false);

  const fetchPools = useCallback(async () => {
    setLoad('loading');
    setErrMsg(null);
    try {
      const filter: { vintage?: number; seller?: string } = {};
      if (vintage.trim() !== '' && !Number.isNaN(Number(vintage))) filter.vintage = Number(vintage);
      if (seller.trim() !== '') filter.seller = seller.trim();
      const res = await api.listPools(filter);
      setPools(res.pools);
      setLoad('loaded');
    } catch (e) {
      setErrMsg((e as Error).message);
      setLoad('error');
    }
  }, [vintage, seller]);

  useEffect(() => { fetchPools(); }, [fetchPools]);

  const { active, inactive } = useMemo(() => {
    const a: Pool[] = [];
    const i: Pool[] = [];
    for (const p of pools) {
      if (p.closedAt !== null) i.push(p);
      else if (p.currentTapeId === null) i.push(p);  // no tapes yet — not "live work"
      else a.push(p);
    }
    return { active: a, inactive: i };
  }, [pools]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <header className="flex items-start justify-between gap-6 mb-8">
        <div>
          {side !== null && (
            <div className={`font-mono text-[11px] tracking-[0.14em] uppercase mb-1.5 ${accent.text}`}>
              {accent.label}
            </div>
          )}
          <h1 className="font-display text-2xl font-semibold text-text-primary mb-1">Your deals</h1>
          <p className="text-sm text-text-secondary">
            Pick a deal to open its pool rail.
            {load === 'loaded' && active.length > 0 && (
              <span className="ml-2 text-text-muted">{active.length} active.</span>
            )}
          </p>
        </div>
        <DisabledAffordance label="New deal" hint="Pool creation — next UI slice" />
      </header>

      {/* Secondary toolbar — filters de-emphasized vs. PR5's primary placement */}
      <section className="flex items-end gap-3 mb-8 pb-4 border-b border-border-primary/50">
        <label className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Vintage</span>
          <input
            type="number"
            value={vintage}
            onChange={e => setVintage(e.target.value)}
            placeholder="2026"
            className="bg-bg-tertiary border border-border-primary rounded px-2 py-1.5 text-text-primary text-xs
                       focus:outline-none focus:border-accent placeholder-text-muted w-24"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Seller</span>
          <input
            type="text"
            value={seller}
            onChange={e => setSeller(e.target.value)}
            placeholder="Originator"
            className="bg-bg-tertiary border border-border-primary rounded px-2 py-1.5 text-text-primary text-xs
                       focus:outline-none focus:border-accent placeholder-text-muted w-48"
          />
        </label>
        {(vintage !== '' || seller !== '') && (
          <button
            type="button"
            onClick={() => { setVintage(''); setSeller(''); }}
            className="text-xs text-text-muted hover:text-text-primary px-2 py-1.5"
          >
            Clear filters
          </button>
        )}
      </section>

      {/* Body */}
      {load === 'loading' && (
        <div className="text-sm text-text-muted py-12 text-center">Loading your deals…</div>
      )}
      {load === 'error' && (
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm">
          Could not load deals: {errMsg}
        </div>
      )}
      {load === 'loaded' && pools.length === 0 && (
        <div className="bg-bg-secondary border border-border-primary rounded p-10 text-center">
          <p className="text-text-primary mb-2 font-medium">No deals yet.</p>
          <p className="text-text-muted text-sm">When you onboard your first pool, it will appear here.</p>
        </div>
      )}
      {load === 'loaded' && pools.length > 0 && (
        <>
          {/* Active deals — the hero */}
          {active.length > 0 ? (
            <section className="mb-10">
              <h2 className="text-xs uppercase tracking-wide text-text-muted mb-3 font-medium">Active</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {active.map(p => <DealCard key={p.id} pool={p} />)}
              </div>
            </section>
          ) : (
            <section className="mb-10 bg-bg-secondary border border-border-primary rounded p-8 text-center">
              <p className="text-text-primary mb-1">No active deals.</p>
              <p className="text-text-muted text-xs">
                {inactive.length > 0
                  ? `${inactive.length} pool${inactive.length === 1 ? '' : 's'} below need a first tape advance.`
                  : 'Onboard a pool to begin.'}
              </p>
            </section>
          )}

          {/* Inactive / closed — collapsed by default */}
          {inactive.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowInactive(s => !s)}
                className="text-xs uppercase tracking-wide text-text-muted mb-3 font-medium hover:text-text-primary
                           transition-colors flex items-center gap-2"
              >
                <span className={`inline-block transition-transform ${showInactive ? 'rotate-90' : ''}`}>›</span>
                Inactive · {inactive.length}
              </button>
              {showInactive && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 opacity-75">
                  {inactive.map(p => <DealCard key={p.id} pool={p} />)}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

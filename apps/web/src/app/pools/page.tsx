/**
 * /pools — pool list (entry point for the rail).
 *
 * PR5 UI slice 1 (read-only). GET /api/pools with optional vintage/seller filters.
 * Empty/loading/error states are honest (no mocked rows).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import type { Pool } from '@cre/contracts';
import { DisabledAffordance } from '@/components/PoolRail/DisabledAffordance';

type LoadState = 'loading' | 'loaded' | 'error';

export default function PoolListPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [vintage, setVintage] = useState<string>('');
  const [seller, setSeller] = useState<string>('');

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

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary mb-1">Pools</h1>
          <p className="text-sm text-text-secondary">
            Deals-as-collections-of-loans. Each pool versions by dated tape.
          </p>
        </div>
        <DisabledAffordance label="Create pool" hint="Pool creation — next UI slice" />
      </div>

      <section className="mb-6 flex items-end gap-3">
        <label className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-text-muted mb-1">Vintage</span>
          <input
            type="number"
            value={vintage}
            onChange={e => setVintage(e.target.value)}
            placeholder="2026"
            className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                       focus:outline-none focus:border-accent placeholder-text-muted w-32"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-text-muted mb-1">Seller</span>
          <input
            type="text"
            value={seller}
            onChange={e => setSeller(e.target.value)}
            placeholder="Originator name"
            className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                       focus:outline-none focus:border-accent placeholder-text-muted w-64"
          />
        </label>
      </section>

      {load === 'loading' && (
        <div className="text-sm text-text-muted py-12 text-center">Loading pools…</div>
      )}
      {load === 'error' && (
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm">
          Could not load pools: {errMsg}
        </div>
      )}
      {load === 'loaded' && pools.length === 0 && (
        <div className="bg-bg-secondary border border-border-primary rounded p-8 text-center">
          <p className="text-text-secondary mb-2">No pools yet.</p>
          <p className="text-text-muted text-xs">Create your first pool — next slice.</p>
        </div>
      )}
      {load === 'loaded' && pools.length > 0 && (
        <div className="border border-border-primary rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr className="text-left text-text-secondary text-xs uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Shelf</th>
                <th className="px-3 py-2 font-medium">Vintage</th>
                <th className="px-3 py-2 font-medium">Seller</th>
                <th className="px-3 py-2 font-medium">Tapes</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {pools.map(p => (
                <tr key={p.id} className="border-t border-border-primary hover:bg-bg-tertiary/40 transition-colors">
                  <td className="px-3 py-2">
                    <Link href={`/pools/${p.id}`} className="text-accent hover:text-accent-hover font-medium">
                      {p.shelfName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-text-primary">{p.vintage}</td>
                  <td className="px-3 py-2 text-text-secondary">{p.seller ?? <span className="text-text-muted">—</span>}</td>
                  <td className="px-3 py-2 text-text-secondary">{p.tapeIds.length}</td>
                  <td className="px-3 py-2">
                    {p.closedAt !== null ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-text-muted/20 text-text-muted">closed</span>
                    ) : p.currentTapeId === null ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-accent/20 text-accent">no tapes</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-score-strong/20 text-score-strong">active</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-text-muted text-xs">{new Date(p.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

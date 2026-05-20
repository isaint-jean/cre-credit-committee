// AuditViewToggle (Phase 4 - operational workflow UX).
//
// Read-only audit-replay view. Toggle expands the panel; expansion fetches
// GET /audit-replay and renders the chains object as-is. The panel is purely
// a viewer over server-projected data: each chain is the output of the
// rebuildAuditChain projection function in apps/api/src/services/replay-overlays.ts.
//
// DISCIPLINE:
//   - No client-side replay. We never reconstruct overlay state in the browser.
//     The server has already chronologically chained the events; we render them.
//   - No filtering, sorting, grouping, or interpretation. Insertion order is
//     deterministic (chain-walk order from the server) and we preserve it.

'use client';

import React, { useState, useCallback } from 'react';
import type { DoctrineEvaluationId } from '@cre/contracts';
import { api, type AuditReplayResponse } from '@/lib/api-client';

interface Props {
  readonly rootId: DoctrineEvaluationId;
}

interface AuditEntry {
  readonly id?: string;
  readonly kind?: string;
  readonly author?: string;
  readonly occurredAt?: string;
  readonly payload?: unknown;
}

export function AuditViewToggle({ rootId }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AuditReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (data !== null) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAuditReplay(rootId);
      setData(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, data, rootId]);

  const overlayIds = data === null ? [] : Object.keys(data.chains);

  return (
    <section className="space-y-3 border border-gray-200 rounded p-4 bg-white">
      <div className="flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
          Audit View Mode
        </h2>
        <button
          type="button"
          onClick={() => { void toggle(); }}
          className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-100"
        >
          {open ? 'Hide' : 'Show audit replay'}
        </button>
      </div>

      {open && loading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : null}
      {open && error !== null ? (
        <p className="text-xs text-red-700 font-mono">{error}</p>
      ) : null}
      {open && data !== null && overlayIds.length === 0 ? (
        <p className="text-xs text-gray-500">No audit chains for this deal yet.</p>
      ) : null}
      {open && data !== null && overlayIds.length > 0 ? (
        <div className="space-y-3">
          {overlayIds.map((overlayId) => {
            const events = data.chains[overlayId] as readonly AuditEntry[];
            return (
              <div key={overlayId} className="border border-gray-100 rounded">
                <header className="px-3 py-2 bg-gray-50 border-b border-gray-100">
                  <span className="text-xs font-mono text-gray-700">
                    overlay: {overlayId.slice(0, 16)}…
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {events.length} event{events.length === 1 ? '' : 's'}
                  </span>
                </header>
                <table className="min-w-full text-xs">
                  <thead className="bg-white text-gray-500">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">When</th>
                      <th className="px-3 py-1.5 text-left font-medium">Kind</th>
                      <th className="px-3 py-1.5 text-left font-medium">Author</th>
                      <th className="px-3 py-1.5 text-left font-medium">Event Id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={(e.id ?? '') + ':' + i} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-mono text-gray-600">{e.occurredAt ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-900">{e.kind ?? '—'}</td>
                        <td className="px-3 py-1.5 text-gray-700">{e.author ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-500">
                          {e.id !== undefined ? e.id.slice(0, 16) + '…' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

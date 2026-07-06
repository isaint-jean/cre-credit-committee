/**
 * /pools/[poolId]/data-room — the per-pool DATA ROOM (Data-Room Phase 1, D4).
 *
 * FRONTEND-ONLY over the shipped /api/data-room endpoints (D2 + D3). One pile,
 * two projections + bulk-drop → manual-assign seam + per-user read/unread +
 * download-what's-new. No backend touched.
 *
 * FLOW (traceable end-to-end):
 *   bulk drop  → POST /:poolId/staging        (DropAssign)
 *   assign     → POST /:poolId/assign         (DropAssign — the Phase-2 seam)
 *   browse     → GET  /:poolId/by-doc-type    (ByDocTypeView, tier a→b→c)
 *              → GET  /:poolId/by-loan         (ByLoanView)
 *   read/unread→ GET  /:poolId/unread + POST /:poolId/read + GET /doc/:hash
 *   download   → GET  /:poolId/download        (zip-what's-new; advances cursor)
 *
 * SIDE (P2): the active `?side` accents the drop zone, the view toggle, and the
 * download button via useSide()/sideAccent().
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  api,
  type DocTypeEntry,
  type DataRoomDocTypeGroup,
  type DataRoomLoanGroup,
} from '@/lib/api-client';
import { useSide } from '@/lib/side-context';
import { sideAccent, withSide } from '@/lib/side-accent';
import { DropAssign, type AssignLoanOption } from '@/components/DataRoom/DropAssign';
import { ByDocTypeView } from '@/components/DataRoom/ByDocTypeView';
import { ByLoanView } from '@/components/DataRoom/ByLoanView';

type LoadState = 'loading' | 'loaded' | 'error';
type RoomView = 'byDocType' | 'byLoan';

export default function DataRoomPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const side = useSide();
  const accent = sideAccent(side);

  const [load, setLoad] = useState<LoadState>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<RoomView>('byDocType');

  const [docTypes, setDocTypes] = useState<readonly DocTypeEntry[]>([]);
  const [byDocType, setByDocType] = useState<readonly DataRoomDocTypeGroup[]>([]);
  const [byLoan, setByLoan] = useState<readonly DataRoomLoanGroup[]>([]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const [loanOptions, setLoanOptions] = useState<readonly AssignLoanOption[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);

  // Resolve the pool membership so the assign picker offers REAL loans and the
  // By-Loan view can label groups by property name. Best-effort: if it fails the
  // room still works with the raw loanInPoolId (the picker just has no options).
  const loadLoanOptions = useCallback(async () => {
    try {
      const detail = await api.getPoolDetail(poolId);
      if (detail.pool.currentTapeId === null) return;
      const { membership } = await api.getMembership(poolId, detail.pool.currentTapeId);
      setLoanOptions(
        membership.map((m) => ({
          loanInPoolId: m.loanInPoolId,
          label: m.propertyName ?? m.dealRef,
        })),
      );
    } catch {
      /* leave options empty — room stays usable */
    }
  }, [poolId]);

  // Re-fetch the two projections + the per-user unread set. Called on mount and
  // after every assign so a filed doc immediately shows under its folder + loan.
  const refresh = useCallback(async () => {
    const [dt, loan, un] = await Promise.all([
      api.dataRoomByDocType(poolId),
      api.dataRoomByLoan(poolId),
      api.dataRoomUnread(poolId),
    ]);
    setByDocType(dt.groups);
    setByLoan(loan.groups);
    setUnread(new Set(un.unread));
  }, [poolId]);

  const bootstrap = useCallback(async () => {
    setLoad('loading');
    setErr(null);
    try {
      const [{ docTypes: taxo }] = await Promise.all([api.dataRoomDocTypes()]);
      setDocTypes(taxo);
      await Promise.all([refresh(), loadLoanOptions()]);
      setLoad('loaded');
    } catch (e) {
      setErr((e as Error).message);
      setLoad('error');
    }
  }, [refresh, loadLoanOptions]);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  // Optimistic dot-clear when a doc is opened (DocRow already POSTed /read).
  const handleRead = useCallback((fileHash: string) => {
    setUnread((prev) => {
      if (!prev.has(fileHash)) return prev;
      const next = new Set(prev);
      next.delete(fileHash);
      return next;
    });
  }, []);

  async function downloadNew() {
    setDownloading(true);
    setDownloadNote(null);
    try {
      const { newCount } = await api.dataRoomDownloadNew(poolId);
      setDownloadNote(
        newCount > 0 ? `Pulled ${newCount} new file${newCount === 1 ? '' : 's'}.` : 'Nothing new since your last pull.',
      );
      // The cursor advanced server-side; unread is a good proxy for "new", so
      // re-sync it so the count badge reflects the pull.
      await refresh();
    } catch (e) {
      setDownloadNote((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  const docTypeLabels = useMemo(
    () => new Map(docTypes.map((t) => [t.id, t.label] as const)),
    [docTypes],
  );
  const loanLabels = useMemo(
    () => new Map(loanOptions.map((l) => [l.loanInPoolId, l.label] as const)),
    [loanOptions],
  );

  const totalDocs = byDocType.reduce((n, g) => n + g.docs.length, 0);

  if (load === 'loading') {
    return <div className="max-w-6xl mx-auto px-6 py-10 text-sm text-text-muted">Loading data room…</div>;
  }
  if (load === 'error') {
    return (
      <div className="max-w-6xl mx-auto px-6 py-10">
        <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool</Link>
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm mt-4">
          Could not load the data room: {err}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool</Link>

      {/* Cover — side-accented top rail. */}
      <div className={`mt-3 border-t-[3px] ${accent.borderTop} rounded-t-panel`}>
        {side !== null && (
          <div className={`font-mono text-[11px] tracking-[0.14em] uppercase pt-4 ${accent.text}`}>{accent.label}</div>
        )}
        <div className="flex items-end justify-between pt-3 pb-5">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Data Room</h1>
            <p className="text-text-muted text-sm mt-1">
              {totalDocs} document{totalDocs === 1 ? '' : 's'} · one pile, two projections
              {unread.size > 0 && <span className={`ml-2 ${accent.text}`}>· {unread.size} unread</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={downloadNew}
            disabled={downloading}
            className={`text-sm font-medium px-3 py-2 rounded-sm2 border transition-opacity disabled:opacity-50 ${accent.border} ${accent.softBg} ${accent.text}`}
          >
            {downloading ? 'Preparing…' : `Download what's new${unread.size > 0 ? ` (${unread.size})` : ''}`}
          </button>
        </div>
      </div>

      {downloadNote && <p className="mb-4 text-xs text-text-secondary">{downloadNote}</p>}

      {/* Bulk drop + manual-assign seam. */}
      <DropAssign
        poolId={poolId}
        accent={accent}
        docTypes={docTypes}
        loanOptions={loanOptions}
        onAssigned={refresh}
      />

      {/* Two-view toggle. */}
      <div className="flex items-center gap-1 bg-bg-secondary border border-border-primary rounded-panel p-1 w-fit mb-4">
        {([
          { value: 'byDocType' as const, label: 'By doc-type', count: byDocType.length },
          { value: 'byLoan' as const, label: 'By loan', count: byLoan.length },
        ]).map((t) => {
          const active = view === t.value;
          return (
            <button
              key={t.value}
              type="button"
              aria-pressed={active}
              onClick={() => setView(t.value)}
              className={`px-4 py-2 text-sm font-medium rounded-sm2 flex items-center gap-2 transition-colors ${
                active ? `${accent.softBg} ${accent.text}` : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
              <span className="font-mono text-[11px] opacity-80">{t.count}</span>
            </button>
          );
        })}
      </div>

      {view === 'byDocType' && (
        <ByDocTypeView poolId={poolId} groups={byDocType} unread={unread} onRead={handleRead} />
      )}
      {view === 'byLoan' && (
        <ByLoanView
          poolId={poolId}
          groups={byLoan}
          unread={unread}
          onRead={handleRead}
          loanLabels={loanLabels}
          docTypeLabels={docTypeLabels}
        />
      )}
    </div>
  );
}

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
  type DataRoomCategorySummary,
  type DataRoomHeldDoc,
  type DocTypeCategory,
} from '@/lib/api-client';
import { DOC_TYPE_CATEGORY } from '@cre/contracts';
import { useSide } from '@/lib/side-context';
import { sideAccent, withSide } from '@/lib/side-accent';
import { DropAssign, type AssignLoanOption } from '@/components/DataRoom/DropAssign';
import { InviteBuyerButton } from '@/components/DataRoom/InviteBuyerButton';
import { ConfidentialityGate } from '@/components/DataRoom/ConfidentialityGate';
import { CategoryView } from '@/components/DataRoom/CategoryView';
import { ByDocTypeView } from '@/components/DataRoom/ByDocTypeView';
import { ByLoanView } from '@/components/DataRoom/ByLoanView';
import { HeldView } from '@/components/DataRoom/HeldView';
import { TreeView } from '@/components/DataRoom/TreeView';
import type { DataRoomTree } from '@cre/contracts';

type LoadState = 'loading' | 'loaded' | 'error';
// ★ DEFAULT surface = 'category' (the five category cards, NEVER a flat file
// list). 'byLoan' stays available as a toggle (loan-level view). A category
// drill-in switches to 'byDocType' scoped to the selected category. 'tree' is
// the read-only nested browser (Chunk 1), collapsed-by-default.
type RoomView = 'category' | 'byDocType' | 'byLoan' | 'tree';

export default function DataRoomPage() {
  const { poolId } = useParams<{ poolId: string }>();
  const side = useSide();
  const accent = sideAccent(side);

  const [load, setLoad] = useState<LoadState>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<RoomView>('category');
  // When drilled into a category from a card click, the by-doc-type view is
  // SCOPED to it. null = show all doc-types (reached via the toggle, not a card).
  const [scopedCategory, setScopedCategory] = useState<DocTypeCategory | null>(null);

  const [docTypes, setDocTypes] = useState<readonly DocTypeEntry[]>([]);
  const [categories, setCategories] = useState<readonly DataRoomCategorySummary[]>([]);
  const [byDocType, setByDocType] = useState<readonly DataRoomDocTypeGroup[]>([]);
  const [byLoan, setByLoan] = useState<readonly DataRoomLoanGroup[]>([]);
  const [tree, setTree] = useState<DataRoomTree | null>(null);
  const [confiRequired, setConfiRequired] = useState(false);
  const [confiVersion, setConfiVersion] = useState('');
  const [held, setHeld] = useState<readonly DataRoomHeldDoc[]>([]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const [loanOptions, setLoanOptions] = useState<readonly AssignLoanOption[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);
  // Honest post-retry summary — surfaced after a held blob resolves into real files.
  const [retryNote, setRetryNote] = useState<string | null>(null);

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
    const [cat, dt, loan, un, hld, tre] = await Promise.all([
      api.getPoolByCategory(poolId),
      api.dataRoomByDocType(poolId),
      api.dataRoomByLoan(poolId),
      api.dataRoomUnread(poolId),
      api.dataRoomHeld(poolId),
      api.dataRoomTree(poolId),
    ]);
    setCategories(cat.categories);
    setByDocType(dt.groups);
    setByLoan(loan.groups);
    setUnread(new Set(un.unread));
    setHeld(hld.held);
    setTree(tre);
  }, [poolId]);

  const bootstrap = useCallback(async () => {
    setLoad('loading');
    setErr(null);
    try {
      // Chunk 3c: confidentiality gate first. If required (flag ON + buyer + not yet
      // accepted), show the gate and SKIP the room fetches (which would 403). When the
      // flag is off, `required` is always false → dark (no gate).
      const confi = await api.confiStatus(poolId).catch(() => ({ required: false, accepted: true, agreementVersion: '' }));
      if (confi.required) {
        setConfiVersion(confi.agreementVersion);
        setConfiRequired(true);
        setLoad('loaded');
        return;
      }
      setConfiRequired(false);
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

  // Chunk 3c: buyer must accept the confidentiality agreement before the room opens.
  if (confiRequired) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8">
        <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool</Link>
        <ConfidentialityGate
          poolId={poolId}
          agreementVersion={confiVersion}
          onAccepted={() => { setConfiRequired(false); void bootstrap(); }}
        />
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
              {totalDocs} document{totalDocs === 1 ? '' : 's'} · organized by category
              {unread.size > 0 && <span className={`ml-2 ${accent.text}`}>· {unread.size} unread</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Chunk 3d — originator/admin can invite a buyer to this room. */}
            {side !== 'buyer' && <InviteBuyerButton poolId={poolId} />}
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

      {/* SLICE 3 — the durable "needs identification" set. Accepted-but-unrouted
          files kept in cre.db (never dropped); a human identifies each → routed.
          Renders nothing when the held set is empty. */}
      {retryNote && (
        <p className="mb-4 text-xs text-text-secondary">{retryNote}</p>
      )}
      <HeldView
        poolId={poolId}
        held={held}
        accent={accent}
        docTypes={docTypes}
        loanOptions={loanOptions}
        onIdentified={refresh}
        onRetried={setRetryNote}
      />

      {/* View toggle. ★ DEFAULT = Categories (the five cards, never a flat file
          list). By loan stays a SUMMARIZED loan-level toggle. Doc-type view is
          reached by drilling INTO a category card (scoped), not from the top
          toggle — the room's primary axis is the category, not the doc-type. */}
      <div className="flex items-center gap-1 bg-bg-secondary border border-border-primary rounded-panel p-1 w-fit mb-4">
        {([
          { value: 'category' as const, label: 'Categories', count: categories.length },
          { value: 'byLoan' as const, label: 'By loan', count: byLoan.length },
          { value: 'tree' as const, label: 'Tree', count: tree?.fileCount ?? 0 },
        ]).map((t) => {
          const active = view === t.value;
          return (
            <button
              key={t.value}
              type="button"
              aria-pressed={active}
              onClick={() => { setView(t.value); setScopedCategory(null); }}
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

      {/* ★ DEFAULT SURFACE — category cards (count + new-badge + download). */}
      {view === 'category' && (
        <CategoryView
          poolId={poolId}
          categories={categories}
          accent={accent}
          onDrillIn={(category) => { setScopedCategory(category); setView('byDocType'); }}
          onDownloaded={refresh}
        />
      )}

      {/* SECONDARY — a category's files (by-doc-type, scoped to the drilled-in
          category). Reached only via a card click; a back link returns to the
          cards. */}
      {view === 'byDocType' && (
        <>
          <button
            type="button"
            onClick={() => { setView('category'); setScopedCategory(null); }}
            className={`mb-3 text-xs ${accent.text} hover:opacity-80`}
          >
            ← All categories
          </button>
          {scopedCategory !== null && (
            <p className="mb-3 text-sm font-semibold text-text-primary">{scopedCategory}</p>
          )}
          <ByDocTypeView
            poolId={poolId}
            groups={
              scopedCategory === null
                ? byDocType
                : byDocType.filter((g) => DOC_TYPE_CATEGORY[g.docType] === scopedCategory)
            }
            unread={unread}
            onRead={handleRead}
          />
        </>
      )}

      {view === 'byLoan' && (
        <ByLoanView
          poolId={poolId}
          groups={byLoan}
          unread={unread}
          onRead={handleRead}
          onChanged={refresh}
          loanLabels={loanLabels}
          docTypeLabels={docTypeLabels}
        />
      )}

      {/* Nested tree (Chunk 1) + manual Move control (Chunk 2c): Deal → New Issue
          → Deal → Bank → Category → loan-file, collapsed-by-default, version/pin
          badges, per-file re-file. */}
      {view === 'tree' && tree !== null && (
        <TreeView tree={tree} poolId={poolId} docTypes={docTypes} loans={loanOptions} onMoved={refresh} />
      )}
    </div>
  );
}

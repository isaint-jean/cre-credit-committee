/**
 * DocRow — one document line, shared by both projections (By Doc-type / By Loan).
 *
 * Shows: an unread DOT (teal, from the per-user unread set), the file name, an
 * optional loan/doc-type context label, the tier chip, size + date, and an OPEN
 * action. Opening → GET /data-room/:poolId/doc/:fileHash (blob → new tab) AND
 * POST /data-room/:poolId/read to clear the dot. Read-state is per-user.
 */
'use client';

import { api, type DataRoomDocEntry } from '@/lib/api-client';
import { formatBytes, formatDate, tierChip, shortLoan } from './data-room-utils';

export function DocRow({
  poolId,
  doc,
  unread,
  context,
  onRead,
}: {
  readonly poolId: string;
  readonly doc: DataRoomDocEntry;
  readonly unread: boolean;
  /** 'loan' shows the loan id (in the doc-type view); 'docType' shows the doc-type
   *  (in the loan view). null hides the context column. */
  readonly context: { readonly kind: 'loan' | 'docType'; readonly value: string } | null;
  readonly onRead: (fileHash: string) => void;
}) {
  const chip = tierChip(doc.tier);

  async function open() {
    try {
      const blob = await api.dataRoomOpenDoc(poolId, doc.fileHash);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after a beat so the new tab has time to load the object URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      // Fall through — even if the blob open fails, still clear the dot below so
      // the user's intent (they clicked the doc) is honored.
    }
    if (unread) {
      try {
        await api.dataRoomMarkRead(poolId, doc.fileHash);
        onRead(doc.fileHash);
      } catch {
        /* leave the dot; a later refresh reconciles */
      }
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-t border-border-primary hover:bg-bg-tertiary/40 transition-colors">
      {/* Unread dot — teal, per-user. Reserves width even when read so rows align. */}
      <span
        aria-label={unread ? 'Unread' : 'Read'}
        title={unread ? 'Unread' : 'Read'}
        className={`shrink-0 w-2 h-2 rounded-full ${unread ? 'bg-accent' : 'bg-transparent border border-border-primary'}`}
      />
      <button
        type="button"
        onClick={open}
        className="flex-1 min-w-0 text-left group"
        title={`Open ${doc.fileName}`}
      >
        <div className={`truncate text-sm ${unread ? 'font-semibold text-text-primary' : 'text-text-secondary'} group-hover:text-accent`}>
          {doc.fileName}
        </div>
        {context !== null && (
          <div className="text-[10px] font-mono text-text-subtle mt-0.5 truncate">
            {context.kind === 'loan' ? `loan ${shortLoan(context.value)}` : context.value}
          </div>
        )}
      </button>
      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${chip.cls}`}>{chip.label}</span>
      <span className="shrink-0 text-[11px] font-mono text-text-muted w-16 text-right">{formatBytes(doc.size)}</span>
      <span className="shrink-0 text-[11px] text-text-muted w-24 text-right hidden sm:block">{formatDate(doc.uploadedAt)}</span>
    </div>
  );
}

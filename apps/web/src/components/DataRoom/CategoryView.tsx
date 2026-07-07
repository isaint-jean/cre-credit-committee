/**
 * CategoryView — Piece D: the CATEGORY-CONTROL surface of the data room.
 *
 * ★ THE SCALE CORRECTION: a pool holds thousands of files. The default surface is
 * NOT a flat file list — it is the FIVE CATEGORIES (ASRs · Excels · Third-Party
 * Reports · Legal · General, from CATEGORIES_IN_ORDER). One CARD per category,
 * each carrying: the category name, a file COUNT, an unread/new BADGE (hidden at
 * 0), and a DOWNLOAD button → GET /:poolId/download?category={category} (the
 * category-structured zip: a {Category}/loan/docType/ folder tree).
 *
 * The API feeds this a SUMMARY only ({category, count, unreadCount}) — never the
 * rows — so the room never bombards. Drilling into a category's files (opening
 * the by-doc-type / by-loan view scoped to that category) is a SECONDARY action
 * on a card click, surfaced by the parent page; this component just signals the
 * selection via onDrillIn.
 *
 * A zero-doc category renders MUTED with "No documents" — it is NOT hidden. The
 * five categories are the stable shape of the room.
 */
'use client';

import { useState } from 'react';
import type { DataRoomCategorySummary, DocTypeCategory } from '@/lib/api-client';
import { api } from '@/lib/api-client';
import type { SideAccent } from '@/lib/side-accent';

export function CategoryView({
  poolId,
  categories,
  accent,
  onDrillIn,
  onDownloaded,
}: {
  readonly poolId: string;
  readonly categories: readonly DataRoomCategorySummary[];
  readonly accent: SideAccent;
  /** Card click → open this category's files (the secondary, scoped file view). */
  readonly onDrillIn: (category: DocTypeCategory) => void;
  /** After a successful category download (so the page can re-sync unread). */
  readonly onDownloaded?: (category: DocTypeCategory, newCount: number) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {categories.map((c) => (
        <CategoryCard
          key={c.category}
          poolId={poolId}
          summary={c}
          accent={accent}
          onDrillIn={onDrillIn}
          onDownloaded={onDownloaded}
        />
      ))}
    </div>
  );
}

function CategoryCard({
  poolId,
  summary,
  accent,
  onDrillIn,
  onDownloaded,
}: {
  readonly poolId: string;
  readonly summary: DataRoomCategorySummary;
  readonly accent: SideAccent;
  readonly onDrillIn: (category: DocTypeCategory) => void;
  readonly onDownloaded?: (category: DocTypeCategory, newCount: number) => void;
}) {
  const { category, count, unreadCount } = summary;
  const empty = count === 0;
  const [downloading, setDownloading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function download(e: React.MouseEvent) {
    // Don't let the download bubble into the card's drill-in click.
    e.stopPropagation();
    setDownloading(true);
    setNote(null);
    try {
      // Hits GET /:poolId/download?category={category} → the {Category}/ zip tree.
      const { newCount } = await api.dataRoomDownloadCategory(poolId, category);
      setNote(
        newCount > 0
          ? `Pulled ${newCount} file${newCount === 1 ? '' : 's'}.`
          : 'Nothing new since your last pull.',
      );
      onDownloaded?.(category, newCount);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section
      role="button"
      tabIndex={empty ? -1 : 0}
      aria-disabled={empty}
      onClick={() => { if (!empty) onDrillIn(category); }}
      onKeyDown={(e) => {
        if (empty) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDrillIn(category); }
      }}
      className={`flex flex-col rounded-panel border p-4 transition-colors ${
        empty
          ? 'border-border-primary bg-bg-secondary/50 opacity-60 cursor-default'
          : `border-border-primary bg-bg-secondary cursor-pointer ${accent.hoverBorder}`
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">{category}</h3>
        {unreadCount > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-soft text-accent border border-accent/30 whitespace-nowrap">
            {unreadCount} new
          </span>
        )}
      </div>

      <p className="mt-1 text-xs text-text-muted">
        {empty ? 'No documents' : `${count} file${count === 1 ? '' : 's'}`}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={download}
          disabled={empty || downloading}
          className={`text-xs font-medium px-2.5 py-1.5 rounded-sm2 border transition-opacity disabled:opacity-40 ${accent.border} ${accent.softBg} ${accent.text}`}
        >
          {downloading ? 'Preparing…' : 'Download'}
        </button>
        {!empty && (
          <span className="text-[11px] text-text-subtle">Open files →</span>
        )}
      </div>

      {note && <p className="mt-2 text-[11px] text-text-secondary">{note}</p>}
    </section>
  );
}

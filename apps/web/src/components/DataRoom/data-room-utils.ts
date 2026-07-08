/**
 * Data-Room (D4) shared UI helpers — pure presentation, no state, no backend.
 */
import type { DataRoomDocEntry } from '@/lib/api-client';

/** Human byte size for the doc rows. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short ISO date for the uploaded-at column. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Tier chip label + token classes. Tier-(c) room-only docs are first-class. */
export function tierChip(tier: DataRoomDocEntry['tier']): { label: string; cls: string } {
  switch (tier) {
    case 'ingesting':
      return { label: 'Ingested', cls: 'bg-score-strong/15 text-score-strong border-score-strong/30' };
    case 'stored':
      return { label: 'Stored', cls: 'bg-bg-tertiary text-text-secondary border-border-primary' };
    case 'room_only':
    default:
      return { label: 'Room only', cls: 'bg-accent-soft text-accent border-accent/30' };
  }
}

/** Short loan display id. loanInPoolId can be a long uuid; keep it scannable. */
export function shortLoan(loanInPoolId: string): string {
  return loanInPoolId.length > 16 ? `${loanInPoolId.slice(0, 14)}…` : loanInPoolId;
}

/** Compact "2023-07" effective-date label for the version picker, or "(no date)"
 *  when the version has no parseable content date. */
export function effectiveDateLabel(iso: string | null | undefined): string {
  if (!iso) return '(no date)';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '(no date)';
  return d.toISOString().slice(0, 7); // YYYY-MM
}

/**
 * The version the ENGINE will underwrite, computed client-side — an EXACT mirror
 * of the server's `pickWinningVersion` (underwrite-loan.service.ts):
 *   1. a pinned version wins outright;
 *   2. else the latest `docEffectiveDate` (a present date beats a null one);
 *   3. else the latest `uploadedAt` (honest fallback when no date is parseable).
 * Returns the winning entry and WHY it won, so the UI never leaves it ambiguous.
 */
export function pickSelectedVersion(
  versions: readonly DataRoomDocEntry[],
): { winner: DataRoomDocEntry; reason: 'pinned' | 'latest-date' | 'latest-upload' } {
  const pinnedVersions = versions.filter((v) => v.pinned === true);
  const isPinned = pinnedVersions.length > 0;
  const pool = isPinned ? pinnedVersions : versions;
  const winner = pool.slice().sort((a, b) => {
    const ad = a.docEffectiveDate ?? null;
    const bd = b.docEffectiveDate ?? null;
    if (ad !== null && bd !== null && ad !== bd) return ad < bd ? 1 : -1;
    if (ad !== null && bd === null) return -1;
    if (ad === null && bd !== null) return 1;
    return a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0;
  })[0]!;
  const reason: 'pinned' | 'latest-date' | 'latest-upload' = isPinned
    ? 'pinned'
    : winner.docEffectiveDate
      ? 'latest-date'
      : 'latest-upload';
  return { winner, reason };
}

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

/**
 * VersionPicker — the SLICE-4 version-pin override surface (Data-Room).
 *
 * Renders ONE (loan, docType) slot that has 2+ versions of the same document
 * (e.g. two appraisals). It shows every version with its effective date, marks
 * WHICH one the engine will underwrite + WHY (honest, never ambiguous), and lets
 * an operator PIN a specific version (or unpin back to the auto default).
 *
 * ★ Selection is computed CLIENT-SIDE via pickSelectedVersion — an exact mirror
 *   of the server's pickWinningVersion (pinned > latest docEffectiveDate > latest
 *   uploadedAt). No extra round-trip to know the winner.
 *
 * ★ Pinning is OPTIONAL and does NOT re-fire an underwrite. A pin changes WHICH
 *   version the NEXT underwrite reads (a data change) — it never silently starts
 *   an LLM run. The button copy says so. On pin/unpin success we call onChanged()
 *   → the page refetches the doc view so the selected marker + reason update.
 *
 * Single-version slots never reach here (ByLoanView renders a plain DocRow) — so
 * there is zero pin friction where there is nothing to choose.
 */
'use client';

import { useState } from 'react';
import { api, type DataRoomDocEntry } from '@/lib/api-client';
import { DocRow } from './DocRow';
import { effectiveDateLabel, pickSelectedVersion } from './data-room-utils';

export function VersionPicker({
  poolId,
  docTypeLabel,
  versions,
  unread,
  onRead,
  onChanged,
}: {
  readonly poolId: string;
  readonly docTypeLabel: string;
  /** All versions of ONE (loan, docType) slot. Guaranteed length ≥ 2 by caller. */
  readonly versions: readonly DataRoomDocEntry[];
  readonly unread: ReadonlySet<string>;
  readonly onRead: (fileHash: string) => void;
  /** Refetch the doc view after a pin/unpin so the selected marker + reason update. */
  readonly onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { winner, reason } = pickSelectedVersion(versions);
  const loanInPoolId = versions[0]!.loanInPoolId;
  const docType = versions[0]!.docType;

  // Honest one-liner: WHICH version underwrites + WHY. Never ambiguous.
  const dateLabel = effectiveDateLabel(winner.docEffectiveDate);
  const usingLine =
    reason === 'pinned'
      ? `Pinned (${dateLabel})`
      : reason === 'latest-date'
        ? `Using latest (${dateLabel})`
        : `Using latest upload (${dateLabel})`;

  async function pin(fileHash: string) {
    setBusy(fileHash);
    setErr(null);
    try {
      const { result } = await api.dataRoomPinDoc(poolId, loanInPoolId, docType, fileHash);
      if (result.status !== 'pinned') throw new Error(result.error ?? 'pin_failed');
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function unpin() {
    setBusy('__unpin__');
    setErr(null);
    try {
      const { result } = await api.dataRoomUnpinDoc(poolId, loanInPoolId, docType);
      if (result.status !== 'unpinned') throw new Error(result.error ?? 'unpin_failed');
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-border-primary bg-bg-tertiary/20">
      {/* Slot header — the honest "which version underwrites + why" line. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <span className="text-[11px] font-semibold text-text-secondary">{docTypeLabel}</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted border border-border-primary">
          {versions.length} versions
        </span>
        <span
          className={`ml-auto text-[11px] font-medium px-1.5 py-0.5 rounded border ${
            reason === 'pinned'
              ? 'bg-accent-soft text-accent border-accent/30'
              : 'bg-score-strong/10 text-score-strong border-score-strong/30'
          }`}
          title="The version the NEXT underwrite will read for this slot."
        >
          {usingLine}
        </span>
      </div>

      {/* One row per version — file line + selected marker + pin/unpin control. */}
      {versions.map((v) => {
        const isSelected = v.fileHash === winner.fileHash;
        const isPinnedRow = v.pinned === true;
        return (
          <div key={v.fileHash} className="flex items-stretch">
            <div className="flex-1 min-w-0">
              <DocRow
                poolId={poolId}
                doc={v}
                unread={unread.has(v.fileHash)}
                context={{ kind: 'plain', value: effectiveDateLabel(v.docEffectiveDate) }}
                onRead={onRead}
              />
            </div>
            <div className="shrink-0 flex items-center gap-2 px-3 border-t border-border-primary">
              {isSelected && (
                <span
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-score-strong/10 text-score-strong border border-score-strong/30"
                  title="This version is the current underwrite input for the slot."
                >
                  ✓ underwrites
                </span>
              )}
              {isPinnedRow ? (
                <button
                  type="button"
                  onClick={unpin}
                  disabled={busy !== null}
                  className="text-[11px] font-medium px-2 py-1 rounded border border-accent/40 text-accent hover:bg-accent-soft disabled:opacity-50"
                  title="Remove the pin → next underwrite reverts to the latest version."
                >
                  {busy === '__unpin__' ? 'Unpinning…' : 'Pinned ✓ — Unpin'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => pin(v.fileHash)}
                  disabled={busy !== null}
                  className="text-[11px] font-medium px-2 py-1 rounded border border-border-primary text-text-secondary hover:text-text-primary hover:border-accent/40 disabled:opacity-50"
                  title="Pin this version — used on the NEXT underwrite (does not re-run one now)."
                >
                  {busy === v.fileHash ? 'Pinning…' : 'Pin this version'}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* Honest footnote: a pin is a data change, not a re-underwrite trigger. */}
      <p className="px-3 pb-2 pt-0.5 text-[10px] text-text-subtle">
        Pinning changes which version the <span className="font-medium">next</span> underwrite uses — it does not re-run one now.
      </p>
      {err && <p className="px-3 pb-2 text-[10px] text-risk-high">{err}</p>}
    </div>
  );
}

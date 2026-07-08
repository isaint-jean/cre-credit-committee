/**
 * HeldView — Data-Room content-routing SLICE 3: the DURABLE "needs identification"
 * set.
 *
 * These are accepted-but-unidentified files the routing cascade
 * (folder→filename→content) couldn't confidently place on BOTH axes, so they can't
 * sit in the routed room (data_room_doc). Rather than drop them (or lose them when
 * the transient staging batch expires), they're kept DURABLY in cre.db and surfaced
 * here, each pre-filled with whatever PARTIAL hint the cascade found (docType and/or
 * loan, plus a browse category). A human identifies each one (loan + doc-type) →
 * it MOVES to the routed set and underwrites on settle.
 *
 * Security-rejected zip entries never appear here — they were refused at the unpack
 * gate and never admitted (held ≠ security-reject).
 */
'use client';

import { useState } from 'react';
import { api, type DataRoomHeldDoc, type DocTypeEntry } from '@/lib/api-client';
import type { SideAccent } from '@/lib/side-accent';
import type { AssignLoanOption } from './DropAssign';
import { shortLoan } from './data-room-utils';

export function HeldView({
  poolId,
  held,
  accent,
  docTypes,
  loanOptions,
  onIdentified,
  onRetried,
}: {
  readonly poolId: string;
  readonly held: readonly DataRoomHeldDoc[];
  readonly accent: SideAccent;
  readonly docTypes: readonly DocTypeEntry[];
  readonly loanOptions: readonly AssignLoanOption[];
  /** Called after a held file is identified (moved to routed) so the room refreshes. */
  readonly onIdentified: () => void;
  /** Called after a held blob RESOLVES via retry — the room refreshes AND the honest
   *  post-retry summary bubbles up so the page can surface it (not a silent no-op). */
  readonly onRetried?: (summary: string) => void;
}) {
  if (held.length === 0) return null;

  return (
    <section className="mb-6 border border-amber-500/40 bg-amber-500/5 rounded-panel overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-500/20 flex items-center gap-2">
        <span className="text-amber-400 text-sm font-semibold">Needs identification</span>
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
          {held.length}
        </span>
        <span className="ml-auto text-xs text-text-muted">
          Kept but not yet placed — assign each to a loan + doc-type.
        </span>
      </div>
      <div className="divide-y divide-amber-500/10">
        {held.map((h) => (
          <HeldRow
            key={h.fileHash}
            poolId={poolId}
            held={h}
            accent={accent}
            docTypes={docTypes}
            loanOptions={loanOptions}
            onIdentified={onIdentified}
            onRetried={onRetried}
          />
        ))}
      </div>
    </section>
  );
}

function HeldRow({
  poolId,
  held,
  accent,
  docTypes,
  loanOptions,
  onIdentified,
  onRetried,
}: {
  readonly poolId: string;
  readonly held: DataRoomHeldDoc;
  readonly accent: SideAccent;
  readonly docTypes: readonly DocTypeEntry[];
  readonly loanOptions: readonly AssignLoanOption[];
  readonly onIdentified: () => void;
  readonly onRetried?: (summary: string) => void;
}) {
  // Pre-fill from whatever the cascade found (a null hint = the axis refused).
  const [loanInPoolId, setLoanInPoolId] = useState<string>(held.hintLoanInPoolId ?? '');
  const [docType, setDocType] = useState<string>(held.hintDocType ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Retry (PRIMARY action) — its own state so it never contends with the manual
  // assign's `busy`/`err`. `note` surfaces the honest post-retry summary inline.
  const [retrying, setRetrying] = useState(false);
  const [retryErr, setRetryErr] = useState<string | null>(null);

  const canIdentify = loanInPoolId.length > 0 && docType.length > 0 && !busy;

  async function identify() {
    if (!canIdentify) return;
    setBusy(true);
    setErr(null);
    try {
      await api.dataRoomIdentifyHeld(poolId, held.fileHash, loanInPoolId, docType);
      onIdentified(); // the row leaves the held set on the next refresh
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setRetryErr(null);
    try {
      const r = await api.dataRoomRetryHeld(poolId, held.fileHash);
      const s = r.summary;
      if (!r.resolved) {
        // A folder zip whose every entry was rejected/empty — nothing routed, the
        // opaque blob is STILL held. Say so honestly; don't refresh into a no-op.
        setRetryErr(
          s.rejectedCount > 0
            ? `Couldn't unpack — all ${s.rejectedCount} ${s.rejectedCount === 1 ? 'entry was' : 'entries were'} rejected. Assign it manually below.`
            : 'Nothing to unpack — the archive was empty. Assign it manually below.',
        );
        setRetrying(false);
        return;
      }
      // Resolved: the opaque blob is gone, its docs routed / newly-held. Surface the
      // honest summary to the page FIRST (this card is about to unmount on refresh),
      // then refresh the room so the real outcome shows: the blob is gone and any
      // newly-held per-file items appear as their OWN held cards. Not a silent no-op.
      const summary =
        `Unpacked ${s.unpackedCount} · ${s.autoRoutedCount} routed · ${s.heldCount} need identification` +
        (s.rejectedCount > 0 ? ` · ${s.rejectedCount} rejected` : '');
      onRetried?.(summary);
      onIdentified();
    } catch (e) {
      const err = e as Error & { code?: string; status?: number };
      // Honest 409 message: the held file simply isn't a zip → the retry can't help,
      // steer the user to the manual assign below rather than surface a raw error.
      if (err.status === 409 || err.code === 'not_a_folder_zip') {
        setRetryErr("This isn't a zip — assign it manually below.");
      } else {
        setRetryErr(err.message);
      }
      setRetrying(false);
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-text-primary font-medium truncate max-w-[24rem]" title={held.fileName}>
          {held.fileName}
        </span>
        <span className="text-[10px] font-mono text-text-subtle">{shortLoan(held.fileHash)}</span>
        {held.hintCategory !== null && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted border border-border-primary">
            {held.hintCategory}
          </span>
        )}
        {held.hintDocType === null && held.hintLoanInPoolId === null && (
          <span className="text-[10px] text-text-subtle italic">no hints — cascade refused both axes</span>
        )}
      </div>

      {/* PRIMARY action — a blob held before a routing improvement (e.g. an
          unrecognized zip whose .zip extension was stripped) should be RE-RUN, not
          hand-assigned. The manual loan/doc-type assign below stays as the fallback. */}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className={`text-xs font-semibold px-3 py-1.5 rounded-sm2 border transition-opacity disabled:opacity-40 ${accent.border} ${accent.softBg} ${accent.text}`}
        >
          {retrying ? 'Retrying…' : 'Retry identification'}
        </button>
        <span className="text-[11px] text-text-subtle">Re-run through the routing gate (unpacks a zip)</span>
        {retryErr !== null && <span className="text-[11px] text-risk-high">{retryErr}</span>}
      </div>

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-text-subtle mr-1">Or assign manually:</span>
        <select
          value={loanInPoolId}
          onChange={(e) => setLoanInPoolId(e.target.value)}
          className="text-xs bg-bg-secondary border border-border-primary rounded-sm2 px-2 py-1.5 text-text-primary"
        >
          <option value="">Select loan…</option>
          {loanOptions.map((l) => (
            <option key={l.loanInPoolId} value={l.loanInPoolId}>
              {l.label}
            </option>
          ))}
        </select>
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
          className="text-xs bg-bg-secondary border border-border-primary rounded-sm2 px-2 py-1.5 text-text-primary"
        >
          <option value="">Select doc-type…</option>
          {docTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={identify}
          disabled={!canIdentify}
          className={`text-xs font-medium px-3 py-1.5 rounded-sm2 border transition-opacity disabled:opacity-40 ${accent.border} ${accent.softBg} ${accent.text}`}
        >
          {busy ? 'Identifying…' : 'Identify → route'}
        </button>
        {err !== null && <span className="text-[11px] text-risk-high">{err}</span>}
      </div>
    </div>
  );
}

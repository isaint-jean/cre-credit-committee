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
}: {
  readonly poolId: string;
  readonly held: readonly DataRoomHeldDoc[];
  readonly accent: SideAccent;
  readonly docTypes: readonly DocTypeEntry[];
  readonly loanOptions: readonly AssignLoanOption[];
  /** Called after a held file is identified (moved to routed) so the room refreshes. */
  readonly onIdentified: () => void;
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
}: {
  readonly poolId: string;
  readonly held: DataRoomHeldDoc;
  readonly accent: SideAccent;
  readonly docTypes: readonly DocTypeEntry[];
  readonly loanOptions: readonly AssignLoanOption[];
  readonly onIdentified: () => void;
}) {
  // Pre-fill from whatever the cascade found (a null hint = the axis refused).
  const [loanInPoolId, setLoanInPoolId] = useState<string>(held.hintLoanInPoolId ?? '');
  const [docType, setDocType] = useState<string>(held.hintDocType ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

      <div className="mt-2 flex items-center gap-2 flex-wrap">
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

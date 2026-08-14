/**
 * /pools/[poolId]/loans/[loanInPoolId] — per-loan pool-side trajectory.
 *
 * ★ DELEGATION BOUNDARY (the pool/engine seam, made UI-visible).
 *
 * This page shows the loan's POOL-SIDE history (which tapes it appeared on, with
 * what status, and if it departed, the disposition). It does NOT render any
 * underwriting — those are the engine's concern. The "Open underwriting" link
 * routes to /analysis/[dealRef] where the existing single-deal view takes over.
 *
 * The pool layer owns pool / tape / membership / disposition presentation; it
 * delegates per-loan underwriting presentation to what already exists.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import type { Disposition, DispositionKind, LoanInPool, LoanMembership, OnTapeStatus, ReasonCategory } from '@cre/contracts';
import { REASON_CATEGORIES, REASON_CATEGORY_OUTCOME, isReasonCategoryValidForOutcome } from '@cre/contracts';
import { useSide, type Side } from '@/lib/side-context';
import { sideAccent, withSide } from '@/lib/side-accent';

type LoadState = 'loading' | 'loaded' | 'error';

interface TrajectoryData {
  readonly loan: LoanInPool;
  readonly history: readonly LoanMembership[];
  readonly disposition: Disposition | null;
}

const STATUS_TONE: Record<OnTapeStatus, string> = {
  'clean':         'bg-score-strong/15 text-score-strong border-score-strong/30',
  'conditioned':   'bg-accent/15 text-accent border-accent/30',
  'kick-flagged':  'bg-risk-high/15 text-risk-high border-risk-high/30',
  'under-review':  'bg-text-muted/15 text-text-secondary border-border-secondary',
};

/**
 * P4c — the outcome of an Approve-&-close attempt, surfaced honestly. `idle` is
 * pre-click; `closing` is in-flight; `closed` is the ONLY green; `blocked`
 * carries the server's specific reason (422 NOT_CLEARED / 409 departed / …).
 */
type CloseOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'closing' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

/**
 * Phase 4 — the outcome of a standalone reject/withdraw attempt, surfaced
 * honestly (mirrors CloseOutcome). `idle` pre-click; `submitting` in-flight;
 * `disposed` is the ONLY success (carries the authoritative outcome for the
 * confirmation copy); `blocked` carries the server's specific reason
 * (409 LOAN_ALREADY_CLOSED / 409 LOAN_ALREADY_DISPOSED / 422 NO_CURRENT_TAPE / …).
 */
type DisposeOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'disposed'; readonly outcome: DispositionKind }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

/** Human labels for the reason-category enum keys (§7 taxonomy). */
const REASON_CATEGORY_LABEL: Record<ReasonCategory, string> = {
  disqualifying:     'Disqualifying',
  couldnt_structure: "Couldn't structure",
  expired:           'Expired',
  withdrawn:         'Withdrawn by servicer',
};

/** Human labels for the two authoritative outcomes. */
const OUTCOME_LABEL: Record<DispositionKind, string> = {
  kicked:  'Reject (kicked)',
  dropped: 'Withdraw (dropped)',
};

export default function LoanTrajectoryPage() {
  const { poolId, loanInPoolId } = useParams<{ poolId: string; loanInPoolId: string }>();
  const side = useSide();
  const [data, setData] = useState<TrajectoryData | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [close, setClose] = useState<CloseOutcome>({ kind: 'idle' });
  const [dispose, setDispose] = useState<DisposeOutcome>({ kind: 'idle' });

  const fetch = useCallback(async () => {
    setLoad('loading');
    setErrMsg(null);
    try {
      const { loan } = await api.getLoanInPool(poolId, loanInPoolId);
      const { history } = await api.getLoanHistory(poolId, loanInPoolId);
      let disposition: Disposition | null = null;
      if (loan.currentDispositionId !== null) {
        const { dispositions } = await api.getDispositions(poolId);
        disposition = dispositions.find(d => d.id === loan.currentDispositionId) ?? null;
      }
      setData({ loan, history, disposition });
      setLoad('loaded');
    } catch (e) {
      setErrMsg((e as Error).message);
      setLoad('error');
    }
  }, [poolId, loanInPoolId]);

  useEffect(() => { fetch(); }, [fetch]);

  // ★ Approve & close — the pool-lifecycle POSITIVE TERMINAL (lifecycleStatus:'closed';
  // the loan STAYS in the pool and goes onto the final tape). This is NOT the
  // disposition write (that's the departure path, unchanged). The server RE-DERIVES
  // Cleared and owns legality; we surface whatever it returns, honestly:
  //   - success  → the loan comes back lifecycleStatus:'closed'; refetch + confirm.
  //   - 422 NOT_CLEARED / CLEARED_UNRESOLVABLE → show the server reason (NO fake green).
  //   - 409 LOAN_ALREADY_DEPARTED → "already departed — can't close".
  const onApproveAndClose = useCallback(async () => {
    setClose({ kind: 'closing' });
    const result = await api.closeLoan(poolId, loanInPoolId);
    if (result.ok) {
      setClose({ kind: 'closed' });
      await fetch(); // pull the now-closed loan (lifecycleStatus) back into view.
      return;
    }
    setClose({ kind: 'blocked', code: result.code, message: result.message });
  }, [poolId, loanInPoolId, fetch]);

  // ★ Phase 4 — standalone reject/withdraw (the pool-lifecycle NEGATIVE TERMINAL,
  // now LIVE). Records a Disposition directly (no tape freeze). The server owns
  // legality (mutual exclusion vs. Closed, already-disposed, no-current-tape); we
  // surface exactly what it returns, honestly:
  //   - success  → the loan comes back currentDispositionId set; refetch + confirm.
  //   - 409 LOAN_ALREADY_CLOSED    → "can't reject — loan already closed".
  //   - 409 LOAN_ALREADY_DISPOSED  → "already disposed".
  //   - 422 NO_CURRENT_TAPE        → "no current tape to depart from".
  const onDispose = useCallback(
    async (input: { outcome: DispositionKind; reasonCategory: ReasonCategory | null; note: string | null }) => {
      setDispose({ kind: 'submitting' });
      const result = await api.dispositionLoan(poolId, loanInPoolId, input);
      if (result.ok) {
        setDispose({ kind: 'disposed', outcome: result.disposition.authoritative });
        await fetch(); // pull the now-disposed loan (currentDispositionId) back into view.
        return;
      }
      setDispose({ kind: 'blocked', code: result.code, message: result.message });
    },
    [poolId, loanInPoolId, fetch],
  );

  if (load === 'loading') {
    return <div className="max-w-5xl mx-auto px-6 py-10 text-sm text-text-muted">Loading loan trajectory…</div>;
  }
  if (load === 'error') {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool rail</Link>
        <div className="bg-risk-high/10 border border-risk-high/30 rounded p-4 text-risk-high text-sm mt-4">
          Could not load loan: {errMsg}
        </div>
      </div>
    );
  }
  if (data === null) return null;

  const { loan, history, disposition } = data;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link href={withSide(`/pools/${poolId}`, side)} className="text-accent hover:text-accent-hover text-sm">← Pool rail</Link>

      <header className="border-b border-border-primary pb-6 mt-3 mb-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary mb-1">Loan trajectory</h1>
            <div className="text-sm text-text-secondary space-y-1">
              <div><span className="text-text-muted">Pool-side id</span> <span className="font-mono text-xs ml-1">{loan.id}</span></div>
              <div><span className="text-text-muted">Servicer ref</span> <span className="text-text-primary ml-1">{loan.originatorLoanRef ?? '—'}</span></div>
              {loan.propertyName !== null && (
                <div><span className="text-text-muted">Property</span> <span className="text-text-primary ml-1">{loan.propertyName}</span></div>
              )}
              <div><span className="text-text-muted">Asset type</span> <span className="text-text-primary ml-1">{loan.assetType ?? 'Unknown'}</span></div>
              <div>
                <span className="text-text-muted">Status</span>{' '}
                {loan.lifecycleStatus === 'closed'
                  ? <span className="text-score-strong ml-1">closed — funded to the final tape</span>
                  : disposition === null
                    ? <span className="text-score-strong ml-1">active in pool</span>
                    : <span className="text-risk-high ml-1">departed — buyer: {disposition.buyerLabel}{disposition.override ? ' (OVERRIDE)' : ''}</span>}
              </div>
            </div>
          </div>

          {/* ★ DELEGATION BOUNDARY: underwriting drill-down → existing /analysis/[dealRef]. */}
          <Link
            href={`/analysis/${loan.dealRef}`}
            className="btn-primary text-sm"
            title="Pool layer delegates per-loan underwriting to the engine surface via dealRef"
          >
            Open underwriting →
          </Link>
        </div>
      </header>

      {/* ★ DispositionBar — the pool-lifecycle terminal for THIS loan. "Approve &
         close" is the LIVE lifecycle write (not the disposition path). It lives
         here, not on the graph-native NegotiationSurface, because closing needs
         the loan's pool context (poolId/loanInPoolId) which that surface lacks. */}
      <CloseBar
        loan={loan}
        disposition={disposition}
        outcome={close}
        onApproveAndClose={onApproveAndClose}
      />

      {/* ★ Phase 4 — DispositionBar, sibling of CloseBar. The pool-lifecycle
         NEGATIVE TERMINAL (reject/withdraw) is now a LIVE write here — NOT on the
         graph-native NegotiationSurface (that DispositionBar stays a preview). It
         lives here because the disposition write needs the loan's pool context
         (poolId/loanInPoolId) which the graph surface lacks. Mutual exclusion:
         disabled when the loan is closed; shows the existing disposition (not the
         form) once departed. */}
      <DispositionBar
        loan={loan}
        disposition={disposition}
        outcome={dispose}
        onDispose={onDispose}
        side={side}
      />

      <section className="mb-6">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">
          Tape-by-tape · {history.length} appearances
        </h2>
        {history.length === 0 ? (
          <div className="bg-bg-secondary border border-border-primary rounded p-4 text-text-muted text-sm">
            No tape history.
          </div>
        ) : (
          <div className="border border-border-primary rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-tertiary">
                <tr className="text-left text-text-secondary text-xs uppercase tracking-wide">
                  <th className="px-3 py-2 font-medium">Tape</th>
                  <th className="px-3 py-2 font-medium">Position</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Conditions</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {history.map((m, i) => (
                  <tr key={`${m.loanInPoolId}-${i}`} className="border-t border-border-primary">
                    <td className="px-3 py-2 font-mono text-xs text-text-muted">tape #{i + 1}</td>
                    <td className="px-3 py-2 text-text-secondary">{m.tapePosition}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_TONE[m.status]}`}>
                        {m.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-secondary text-xs">
                      {m.conditions.length === 0 ? <span className="text-text-muted">—</span>
                        : m.conditions.map(c => c.label).join(', ')}
                    </td>
                    <td className="px-3 py-2 text-text-secondary text-xs">
                      {m.notes ?? <span className="text-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {disposition !== null && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">Departure</h2>
          <div className="border border-border-primary rounded bg-bg-secondary p-4 text-sm space-y-2">
            <div className="flex items-center gap-4">
              <div>
                <span className="text-text-muted text-xs uppercase tracking-wide block">Servicer label</span>
                <span className="font-mono">{disposition.originatorLabel}</span>
              </div>
              <span className="text-text-muted">→</span>
              <div>
                <span className="text-text-muted text-xs uppercase tracking-wide block">Buyer label (authoritative)</span>
                <span className="font-mono">{disposition.buyerLabel}</span>
              </div>
              {disposition.override && (
                <span className="text-xs px-2 py-0.5 rounded bg-risk-medium/15 text-risk-medium border border-risk-medium/30 font-semibold ml-4">
                  OVERRIDE
                </span>
              )}
            </div>
            {disposition.reasons.length > 0 && (
              <div>
                <span className="text-text-muted text-xs uppercase tracking-wide block mb-1">Reasons</span>
                <ul className="text-text-secondary text-xs list-disc pl-5">
                  {disposition.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            <div className="text-xs text-text-muted">
              Recorded {new Date(disposition.recordedAt).toLocaleString()} · by {disposition.recordedBy.userId}
              {disposition.recordedBy.displayName !== null ? ` (${disposition.recordedBy.displayName})` : ''}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CloseBar — the pool-lifecycle terminal. "Approve & close" is the LIVE       */
/* lifecycle write (api.closeLoan). The server owns legality (re-derives       */
/* Cleared); this bar surfaces exactly what it returns — success, or the       */
/* specific 422/409 reason. NO fake green. "Reject / withdraw" stays on the    */
/* existing disposition path and is unchanged (a labeled pointer here).        */
/* -------------------------------------------------------------------------- */
function CloseBar({
  loan,
  disposition,
  outcome,
  onApproveAndClose,
}: {
  readonly loan: LoanInPool;
  readonly disposition: Disposition | null;
  readonly outcome: CloseOutcome;
  readonly onApproveAndClose: () => void;
}) {
  const alreadyClosed = loan.lifecycleStatus === 'closed';
  const departed = disposition !== null;
  const closing = outcome.kind === 'closing';
  // Disable the write when there's nothing left to do (already closed / departed)
  // or a request is in flight. The server is still the authority on Cleared — we
  // do NOT pre-gate on a client-derived Cleared here; we let it answer 422.
  const disabled = alreadyClosed || departed || closing;

  return (
    <section className="mb-6">
      <div className="border border-border-primary rounded-panel bg-bg-secondary p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wide text-text-muted">Outcome</div>
            <div className="text-sm text-text-secondary mt-0.5">
              {alreadyClosed
                ? 'Closed — funded to the final tape.'
                : departed
                  ? 'Departed the pool — the disposition is terminal.'
                  : 'In the pool. Approve & close is the lifecycle terminal (loan stays in, onto the final tape).'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={onApproveAndClose}
              title={
                alreadyClosed ? 'Already closed'
                  : departed ? 'A disposed loan cannot close (mutual exclusion)'
                    : 'Lifecycle write — the server re-derives Cleared and closes if legal'
              }
              className={`text-sm font-semibold px-4 py-2 rounded-sm2 border transition-colors ${
                disabled
                  ? 'border-border-primary text-text-muted cursor-not-allowed'
                  : 'border-score-strong/40 text-score-strong hover:bg-score-strong/10'
              }`}
            >
              {closing ? 'Closing…' : alreadyClosed ? 'Closed' : 'Approve & close'}
            </button>
            {/* Reject / withdraw stays on the existing disposition path — unchanged. */}
            <span
              className="text-xs text-text-muted"
              title="Departures ride the existing pool Disposition path — unchanged here."
            >
              Reject / withdraw → disposition path
            </span>
          </div>
        </div>

        {/* Honest outcome banner — the ONLY green is a real close. */}
        {outcome.kind === 'closed' && (
          <div className="mt-3 bg-score-strong/10 border border-score-strong/30 rounded p-3 text-sm text-score-strong">
            Closed — funded to the final tape.
          </div>
        )}
        {outcome.kind === 'blocked' && (
          <div className="mt-3 bg-risk-high/10 border border-risk-high/30 rounded p-3 text-sm text-risk-high">
            {outcome.code === 'LOAN_ALREADY_DEPARTED' ? (
              <>Already departed (rejected / withdrawn) — can&apos;t close.</>
            ) : outcome.code === 'NOT_CLEARED' ? (
              <>
                Can&apos;t close — not cleared.{' '}
                <span className="text-text-secondary">{outcome.message}</span>
              </>
            ) : (
              <>
                Can&apos;t close ({outcome.code}).{' '}
                <span className="text-text-secondary">{outcome.message}</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* DispositionBar (Phase 4) — the pool-lifecycle NEGATIVE TERMINAL, LIVE.      */
/* Sibling of CloseBar. Records a Disposition (kicked|dropped) directly via    */
/* api.dispositionLoan — no tape freeze. The server owns legality (actor is    */
/* stamped server-side, mutual exclusion + no-current-tape enforced there);    */
/* this bar surfaces EXACTLY what it returns — success, or the specific        */
/* 409/422 reason. NO fake success. Mutual exclusion in the UI:                */
/*   - loan closed (lifecycleStatus==='closed') → disabled with a note.        */
/*   - already disposed (currentDispositionId != null) → show the existing     */
/*     disposition (rendered by the page's Departure section) instead of a     */
/*     form; here we render a short pointer, not a re-entry form.              */
/* The reasonCategory options are OUTCOME-FILTERED via the contract taxonomy   */
/* (isReasonCategoryValidForOutcome / REASON_CATEGORY_OUTCOME).                */
/* -------------------------------------------------------------------------- */
function DispositionBar({
  loan,
  disposition,
  outcome,
  onDispose,
  side,
}: {
  readonly loan: LoanInPool;
  readonly disposition: Disposition | null;
  readonly outcome: DisposeOutcome;
  readonly onDispose: (input: {
    outcome: DispositionKind;
    reasonCategory: ReasonCategory | null;
    note: string | null;
  }) => void;
  readonly side: Side | null;
}) {
  const accent = sideAccent(side);
  const closed = loan.lifecycleStatus === 'closed';
  const departed = disposition !== null;
  const submitting = outcome.kind === 'submitting';

  // Form state (only meaningful when the form is shown — i.e. neither closed nor
  // departed). Default outcome 'kicked' (reject); reasonCategory null (optional).
  const [chosenOutcome, setChosenOutcome] = useState<DispositionKind>('kicked');
  const [reasonCategory, setReasonCategory] = useState<ReasonCategory | null>(null);
  const [note, setNote] = useState<string>('');

  // Outcome-filtered categories — ONLY those valid for the chosen outcome. If a
  // previously-chosen category is no longer valid (outcome switched), drop it.
  const validCategories = REASON_CATEGORIES.filter(
    (c) => REASON_CATEGORY_OUTCOME[c] === chosenOutcome,
  );
  const effectiveCategory =
    reasonCategory !== null && isReasonCategoryValidForOutcome(reasonCategory, chosenOutcome)
      ? reasonCategory
      : null;

  const onOutcomeChange = (next: DispositionKind) => {
    setChosenOutcome(next);
    // Clear a now-invalid category so we never submit a mismatched pair.
    if (!isReasonCategoryValidForOutcome(reasonCategory, next)) setReasonCategory(null);
  };

  const onSubmit = () => {
    onDispose({
      outcome: chosenOutcome,
      reasonCategory: effectiveCategory,
      note: note.trim() === '' ? null : note.trim(),
    });
  };

  return (
    <section className="mb-6">
      <div className={`border ${accent.border} rounded-panel bg-bg-secondary p-4`}>
        <div className="flex items-center justify-between gap-4 flex-wrap mb-1">
          <div>
            <div className={`text-xs uppercase tracking-wide ${accent.text}`}>Departure</div>
            <div className="text-sm text-text-secondary mt-0.5">
              {closed
                ? 'Closed — funded to the final tape. A closed loan cannot depart (mutual exclusion).'
                : departed
                  ? 'Departed the pool — the disposition is terminal (shown below).'
                  : 'Reject or withdraw this loan out-of-band. Records a disposition directly — no tape freeze.'}
            </div>
          </div>
        </div>

        {/* Mutual exclusion — closed: disabled note. */}
        {closed && (
          <div className="mt-2 text-xs text-text-muted">
            Reject / withdraw is disabled while the loan is closed.
          </div>
        )}

        {/* Mutual exclusion — departed: point at the existing disposition (the
            page's Departure section renders it in full). NO re-entry form. */}
        {!closed && departed && (
          <div className="mt-2 text-xs text-text-muted">
            Already disposed —{' '}
            <span className="text-text-secondary">
              {disposition!.authoritative === 'kicked' ? 'rejected (kicked)' : 'withdrawn (dropped)'}
            </span>
            . See the departure record below.
          </div>
        )}

        {/* The LIVE form — only when neither closed nor departed. */}
        {!closed && !departed && (
          <div className="mt-3 space-y-3">
            {/* Outcome selector. */}
            <div>
              <label className="text-xs uppercase tracking-wide text-text-muted block mb-1">
                Outcome
              </label>
              <div className="flex gap-2">
                {(['kicked', 'dropped'] as const).map((o) => (
                  <button
                    key={o}
                    type="button"
                    disabled={submitting}
                    onClick={() => onOutcomeChange(o)}
                    className={`text-sm px-3 py-1.5 rounded-sm2 border transition-colors ${
                      chosenOutcome === o
                        ? `${accent.border} ${accent.text} ${accent.softBg}`
                        : 'border-border-primary text-text-secondary hover:border-border-secondary'
                    } ${submitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>
            </div>

            {/* reasonCategory — outcome-filtered (only valid parents shown). */}
            <div>
              <label className="text-xs uppercase tracking-wide text-text-muted block mb-1">
                Reason category <span className="text-text-muted">(optional)</span>
              </label>
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setReasonCategory(null)}
                  className={`text-sm px-3 py-1.5 rounded-sm2 border transition-colors ${
                    effectiveCategory === null
                      ? `${accent.border} ${accent.text} ${accent.softBg}`
                      : 'border-border-primary text-text-secondary hover:border-border-secondary'
                  } ${submitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Unspecified
                </button>
                {validCategories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={submitting}
                    onClick={() => setReasonCategory(c)}
                    className={`text-sm px-3 py-1.5 rounded-sm2 border transition-colors ${
                      effectiveCategory === c
                        ? `${accent.border} ${accent.text} ${accent.softBg}`
                        : 'border-border-primary text-text-secondary hover:border-border-secondary'
                    } ${submitting ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {REASON_CATEGORY_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>

            {/* Optional note. */}
            <div>
              <label className="text-xs uppercase tracking-wide text-text-muted block mb-1">
                Note <span className="text-text-muted">(optional)</span>
              </label>
              <textarea
                value={note}
                disabled={submitting}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Free-form context for this departure…"
                className="w-full text-sm bg-bg-tertiary border border-border-primary rounded-sm2 px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border-secondary disabled:opacity-50"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={submitting}
                onClick={onSubmit}
                className={`text-sm font-semibold px-4 py-2 rounded-sm2 border transition-colors ${
                  submitting
                    ? 'border-border-primary text-text-muted cursor-not-allowed'
                    : 'border-risk-high/40 text-risk-high hover:bg-risk-high/10'
                }`}
              >
                {submitting
                  ? 'Recording…'
                  : chosenOutcome === 'kicked'
                    ? 'Reject loan'
                    : 'Withdraw loan'}
              </button>
              <span className="text-xs text-text-muted">
                Records a buyer-authoritative disposition — actor stamped server-side.
              </span>
            </div>
          </div>
        )}

        {/* Honest outcome banner. Success is the ONLY green. */}
        {outcome.kind === 'disposed' && (
          <div className="mt-3 bg-score-strong/10 border border-score-strong/30 rounded p-3 text-sm text-score-strong">
            {outcome.outcome === 'kicked'
              ? 'Rejected — kicked from the tape.'
              : 'Withdrawn — dropped.'}
          </div>
        )}
        {outcome.kind === 'blocked' && (
          <div className="mt-3 bg-risk-high/10 border border-risk-high/30 rounded p-3 text-sm text-risk-high">
            {outcome.code === 'LOAN_ALREADY_CLOSED' ? (
              <>Can&apos;t reject — loan already closed.</>
            ) : outcome.code === 'LOAN_ALREADY_DISPOSED' ? (
              <>Already disposed.</>
            ) : outcome.code === 'NO_CURRENT_TAPE' ? (
              <>No current tape to depart from.</>
            ) : (
              <>
                Couldn&apos;t record disposition ({outcome.code}).{' '}
                <span className="text-text-secondary">{outcome.message}</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

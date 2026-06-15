/**
 * DealCard — one deal (pool) on the home base.
 *
 * Self-contained on purpose: this is the screen Isabelle lives on, so the card
 * layout and visual hierarchy should be a single file to iterate on. The card
 * does its own per-pool state-fetch (detail + membership + dispositions) so the
 * parent home base doesn't block on the slowest deal.
 *
 * The "what's waiting for me" signal — open working tape, under-review loans,
 * recent overrides — is what makes the deal-picker a workspace instead of a list.
 *
 * READ-ONLY (PR6): the whole card is a Link to the deal's rail; no mutation.
 *
 * COST NOTE: for N active deals, the home base fires 3N parallel reads on mount
 * (detail + membership + dispositions per card). Acceptable for 2–3 deals
 * (target use case); becomes a problem above ~50. If that day comes, add a
 * "/api/pools?include=summary" projection endpoint so the home base loads in one
 * round-trip. Today's read shape stays as-is.
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import type { Disposition, LoanMembership, OnTapeStatus, Pool } from '@cre/contracts';

/* -------------------------------------------------------------------------- */
/* Projection: real backend payloads → card visual state                      */
/* -------------------------------------------------------------------------- */

export interface DealCardState {
  readonly currentTapeVersion: number | null;
  readonly currentWorkingTapeId: string | null;   // → "in review" badge
  readonly loanCount: number;
  readonly statusCounts: Readonly<Record<OnTapeStatus, number>>;
  readonly departuresCount: number;
  readonly overridesCount: number;
}

/** Pure projection from server payloads → card state. Exported for fixture-shape tests. */
export function projectDealCardState(args: {
  readonly currentWorkingTapeId: string | null;
  readonly currentTape: { readonly version: number } | null;
  readonly membership: readonly LoanMembership[];
  readonly dispositions: readonly Disposition[];
}): DealCardState {
  const statusCounts: Record<OnTapeStatus, number> = {
    'clean': 0, 'conditioned': 0, 'kick-flagged': 0, 'under-review': 0,
  };
  for (const m of args.membership) statusCounts[m.status] += 1;
  return {
    currentTapeVersion: args.currentTape?.version ?? null,
    currentWorkingTapeId: args.currentWorkingTapeId,
    loanCount: args.membership.length,
    statusCounts,
    departuresCount: args.dispositions.length,
    overridesCount: args.dispositions.filter(d => d.override).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Visual                                                                     */
/* -------------------------------------------------------------------------- */

type LoadState = 'loading' | 'loaded' | 'error';

export function DealCard({ pool }: { readonly pool: Pool }) {
  const [state, setState] = useState<DealCardState | null>(null);
  const [load, setLoad] = useState<LoadState>(pool.currentTapeId === null ? 'loaded' : 'loading');

  useEffect(() => {
    if (pool.currentTapeId === null) {
      // Pool has no frozen tapes yet — nothing to project. Card still renders
      // (name/seller/vintage) and is clickable to the rail.
      setState(null);
      setLoad('loaded');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Three parallel reads. The card's loading state is per-card — the home
        // base does NOT block on the slowest of N.
        const [detail, tapeRes, membershipRes, dispositionsRes] = await Promise.all([
          api.getPoolDetail(pool.id),
          api.getTape(pool.id, pool.currentTapeId!),
          api.getMembership(pool.id, pool.currentTapeId!),
          api.getDispositions(pool.id),
        ]);
        if (cancelled) return;
        setState(projectDealCardState({
          currentWorkingTapeId: detail.currentWorkingTapeId,
          currentTape: { version: tapeRes.tape.version },
          membership: membershipRes.membership,
          dispositions: dispositionsRes.dispositions,
        }));
        setLoad('loaded');
      } catch {
        if (cancelled) return;
        setLoad('error');
      }
    })();
    return () => { cancelled = true; };
  }, [pool.id, pool.currentTapeId]);

  const hasOpenWorkingTape = state?.currentWorkingTapeId !== null && state?.currentWorkingTapeId !== undefined;
  const underReview = state?.statusCounts['under-review'] ?? 0;
  const kickFlagged = state?.statusCounts['kick-flagged'] ?? 0;
  const attentionCount = (hasOpenWorkingTape ? 1 : 0) + underReview + kickFlagged;

  return (
    <Link
      href={`/pools/${pool.id}`}
      className="block bg-bg-secondary border border-border-primary rounded p-4 hover:border-accent/60
                 hover:bg-bg-secondary/80 transition-colors group"
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary group-hover:text-accent transition-colors truncate">
            {pool.shelfName}
          </h3>
          <div className="text-xs text-text-secondary mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{pool.vintage}</span>
            {pool.seller !== null && <><span className="text-text-muted">·</span><span className="truncate">{pool.seller}</span></>}
          </div>
        </div>
        <StatusBadge pool={pool} attention={attentionCount} hasOpenWorkingTape={hasOpenWorkingTape} />
      </header>

      {/* Body — state signals or honest loading/error */}
      {load === 'loading' && (
        <div className="text-xs text-text-muted">Loading state…</div>
      )}
      {load === 'error' && (
        <div className="text-xs text-risk-medium">Couldn't load deal state — open to retry.</div>
      )}
      {load === 'loaded' && state === null && (
        // No frozen tapes — nothing to summarize, but the card is still clickable.
        <div className="text-xs text-text-muted">No tapes yet — advance the first to begin.</div>
      )}
      {load === 'loaded' && state !== null && (
        <DealCardBody state={state} />
      )}

      {/* Foot — what's waiting */}
      {load === 'loaded' && state !== null && attentionCount > 0 && (
        <footer className="mt-3 pt-3 border-t border-border-primary/50 flex items-center gap-3 text-xs">
          {hasOpenWorkingTape && (
            <span className="text-accent font-medium">★ working tape in review</span>
          )}
          {underReview > 0 && (
            <span className="text-text-secondary">{underReview} under review</span>
          )}
          {kickFlagged > 0 && (
            <span className="text-risk-high">{kickFlagged} kick-flagged</span>
          )}
        </footer>
      )}
    </Link>
  );
}

function StatusBadge({
  pool, attention, hasOpenWorkingTape,
}: {
  readonly pool: Pool;
  readonly attention: number;
  readonly hasOpenWorkingTape: boolean;
}) {
  if (pool.closedAt !== null) {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-text-muted/20 text-text-muted">closed</span>;
  }
  if (pool.currentTapeId === null) {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-accent/20 text-accent">new · no tapes</span>;
  }
  if (hasOpenWorkingTape) {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-accent text-bg-primary font-semibold">in review</span>;
  }
  if (attention > 0) {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-risk-medium/20 text-risk-medium">attention</span>;
  }
  return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-score-strong/20 text-score-strong">active</span>;
}

function DealCardBody({ state }: { readonly state: DealCardState }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-text-muted text-xs uppercase tracking-wide">Tape</span>
        <span className="text-text-primary font-semibold">v{state.currentTapeVersion}</span>
        <span className="text-text-muted">·</span>
        <span className="text-text-secondary">{state.loanCount} loan{state.loanCount === 1 ? '' : 's'}</span>
      </div>
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {state.statusCounts['clean']        > 0 && <Pill tone="strong"   label="clean"        n={state.statusCounts['clean']} />}
        {state.statusCounts['conditioned']  > 0 && <Pill tone="accent"   label="conditioned"  n={state.statusCounts['conditioned']} />}
        {state.statusCounts['kick-flagged'] > 0 && <Pill tone="risk"     label="kick-flagged" n={state.statusCounts['kick-flagged']} />}
        {state.statusCounts['under-review'] > 0 && <Pill tone="muted"    label="under-review" n={state.statusCounts['under-review']} />}
        {state.departuresCount > 0 && <Pill tone="muted-ghost" label="departed" n={state.departuresCount} />}
        {state.overridesCount  > 0 && <Pill tone="warn-ghost"  label="overrides" n={state.overridesCount} />}
      </div>
    </div>
  );
}

function Pill({
  tone, label, n,
}: {
  readonly tone: 'strong' | 'accent' | 'risk' | 'muted' | 'muted-ghost' | 'warn-ghost';
  readonly label: string;
  readonly n: number;
}) {
  const toneClass = {
    strong:       'bg-score-strong/15 text-score-strong border-score-strong/30',
    accent:       'bg-accent/15 text-accent border-accent/30',
    risk:         'bg-risk-high/15 text-risk-high border-risk-high/30',
    muted:        'bg-text-muted/15 text-text-secondary border-border-secondary',
    'muted-ghost':'bg-transparent text-text-muted border-border-secondary',
    'warn-ghost': 'bg-transparent text-risk-medium border-risk-medium/40',
  }[tone];
  return (
    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${toneClass}`}>
      {n} {label}
    </span>
  );
}

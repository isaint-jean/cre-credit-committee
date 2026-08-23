/**
 * DealCard — one deal (pool) on the home base, reconciled to the prototype's
 * flowcard (docs/mockups/cre-pool-rail.html). A side-accented top rail (ochre
 * originator / steel buyer / teal neutral), a stat band (balance · loans ·
 * vintage), a status-chip row, and a "what's waiting" footer.
 *
 * Self-contained on purpose: this is the screen Isabelle lives on, so the card
 * layout and visual hierarchy are a single file to iterate on. The card does
 * its own per-pool state-fetch (detail + tape + membership + dispositions) so
 * the parent home base doesn't block on the slowest deal.
 *
 * REAL STATS ONLY (P2): balance = Σ per-tape cutOffBalance (nullable-tolerant);
 * loanCount = current-tape membership length; vintage = pool.vintage. WAC is
 * NOT returned by any pool read, so it is honestly omitted (no invented figure).
 *
 * SIDE (P2): the card's accent + its link's `?side` reflect the active side from
 * the URL, consistent with the P1 home doors.
 *
 * READ-ONLY: the whole card is a Link to the deal's rail; no mutation.
 *
 * COST NOTE: for N active deals, the home base fires ~4N parallel reads on mount.
 * Acceptable for 2–3 deals (target use case). Above ~50, add a
 * "/api/pools?include=summary" projection; today's read shape stays as-is.
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import type { Disposition, LoanMembership, OnTapeStatus, Pool } from '@cre/contracts';
import { useSide } from '@/lib/side-context';
import { sideAccent, withSide } from '@/lib/side-accent';

/* -------------------------------------------------------------------------- */
/* Projection: real backend payloads → card visual state                      */
/* -------------------------------------------------------------------------- */

export interface DealCardState {
  readonly currentTapeVersion: number | null;
  readonly currentWorkingTapeId: string | null;   // → "in review" badge
  readonly loanCount: number;
  readonly statusCounts: Readonly<Record<OnTapeStatus, number>>;
  /** Σ of per-tape cutOffBalance; null when NO row carries a balance. */
  readonly totalBalance: number | null;
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
  let balSum = 0;
  let anyBal = false;
  for (const m of args.membership) {
    statusCounts[m.status] += 1;
    if (m.cutOffBalance !== null && m.cutOffBalance !== undefined && Number.isFinite(m.cutOffBalance)) {
      balSum += m.cutOffBalance;
      anyBal = true;
    }
  }
  return {
    currentTapeVersion: args.currentTape?.version ?? null,
    currentWorkingTapeId: args.currentWorkingTapeId,
    loanCount: args.membership.length,
    statusCounts,
    totalBalance: anyBal ? balSum : null,
    departuresCount: args.dispositions.length,
    overridesCount: args.dispositions.filter(d => d.override).length,
  };
}

/** Dollar formatter for stat band ($X.XXB / $XXXmm / $XXXk). */
function fmtBalance(b: number | null): string {
  if (b === null || !Number.isFinite(b)) return '—';
  if (b >= 1e9) return `$${(b / 1e9).toFixed(2)}B`;
  if (b >= 1e6) return `$${Math.round(b / 1e6)}mm`;
  if (b >= 1e3) return `$${Math.round(b / 1e3)}k`;
  return `$${Math.round(b)}`;
}

/* -------------------------------------------------------------------------- */
/* Visual                                                                     */
/* -------------------------------------------------------------------------- */

type LoadState = 'loading' | 'loaded' | 'error';

export function DealCard({ pool, isPortfolio = false }: { readonly pool: Pool; readonly isPortfolio?: boolean }) {
  const side = useSide();
  const accent = sideAccent(side);
  const [state, setState] = useState<DealCardState | null>(null);
  const [load, setLoad] = useState<LoadState>(pool.currentTapeId === null ? 'loaded' : 'loading');

  useEffect(() => {
    if (pool.currentTapeId === null) {
      setState(null);
      setLoad('loaded');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
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
      href={withSide(`/pools/${pool.id}`, side)}
      className={`group block bg-bg-secondary border border-line rounded-panel shadow-card overflow-hidden
                  border-t-[3px] ${accent.borderTop} ${accent.hoverBorder}
                  transition-[border-color,transform] duration-150 hover:-translate-y-0.5`}
    >
      <div className="p-4">
        <header className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className={`font-display text-base font-semibold text-text-primary truncate transition-colors group-hover:${accent.text}`}>
              {pool.shelfName}
            </h3>
            <div className="text-xs text-text-secondary mt-0.5 flex items-center gap-2 flex-wrap font-body">
              <span>{pool.vintage}</span>
              {pool.seller !== null && <><span className="text-text-muted">·</span><span className="truncate">{pool.seller}</span></>}
              {/* Loan Type (#4) — reads the same persisted deal-mode flag as the input + export. */}
              <span className="text-text-muted">·</span>
              <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${isPortfolio ? 'bg-accent-soft text-accent' : 'bg-bg-tertiary text-text-muted'}`}>
                {isPortfolio ? 'Portfolio' : 'Single Loan'}
              </span>
            </div>
          </div>
          <StatusBadge pool={pool} attention={attentionCount} hasOpenWorkingTape={hasOpenWorkingTape} accentText={accent.text} accentSoft={accent.softBg} />
        </header>

        {/* Stat band — real stats only */}
        {load === 'loading' && (
          <div className="text-xs text-text-muted">Loading state…</div>
        )}
        {load === 'error' && (
          <div className="text-xs text-risk-medium">Couldn&apos;t load deal state — open to retry.</div>
        )}
        {load === 'loaded' && state === null && (
          <div className="text-xs text-text-muted">No tapes yet — advance the first to begin.</div>
        )}
        {load === 'loaded' && state !== null && (
          <DealCardBody state={state} vintage={pool.vintage} />
        )}
      </div>

      {/* Foot — what's waiting */}
      {load === 'loaded' && state !== null && attentionCount > 0 && (
        <footer className="px-4 py-2.5 border-t border-border-primary/60 bg-bg-tertiary flex items-center gap-3 text-xs font-mono">
          {hasOpenWorkingTape && (
            <span className={`${accent.text} font-medium`}>★ working tape in review</span>
          )}
          {underReview > 0 && (
            <span className="text-text-secondary">{underReview} on tape · under review</span>
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
  pool, attention, hasOpenWorkingTape, accentText, accentSoft,
}: {
  readonly pool: Pool;
  readonly attention: number;
  readonly hasOpenWorkingTape: boolean;
  readonly accentText: string;
  readonly accentSoft: string;
}) {
  if (pool.closedAt !== null) {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-text-muted/20 text-text-muted">closed</span>;
  }
  if (pool.currentTapeId === null) {
    return <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded ${accentSoft} ${accentText}`}>new · no tapes</span>;
  }
  if (hasOpenWorkingTape) {
    return <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded ${accentSoft} ${accentText} font-semibold`}>in review</span>;
  }
  if (attention > 0) {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-risk-medium/20 text-risk-medium">attention</span>;
  }
  return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-score-strong/20 text-score-strong">active</span>;
}

function DealCardBody({ state, vintage }: { readonly state: DealCardState; readonly vintage: number }) {
  return (
    <div className="space-y-3">
      {/* Stat band — balance · loans · vintage (all real). */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Balance" value={fmtBalance(state.totalBalance)} />
        <Stat label="Loans" value={`${state.loanCount}`} />
        <Stat label="Vintage" value={`${vintage}`} />
      </div>

      <div className="flex items-center gap-2 text-xs flex-wrap">
        <span className="text-text-muted text-[11px] uppercase tracking-wide font-mono">Tape v{state.currentTapeVersion}</span>
        {state.statusCounts['clean']        > 0 && <Pill tone="strong"   label="clean"        n={state.statusCounts['clean']} />}
        {state.statusCounts['conditioned']  > 0 && <Pill tone="accent"   label="conditioned"  n={state.statusCounts['conditioned']} />}
        {state.statusCounts['kick-flagged'] > 0 && <Pill tone="risk"     label="kick-flagged" n={state.statusCounts['kick-flagged']} />}
        {state.statusCounts['under-review'] > 0 && <Pill tone="muted"    label="on tape"      n={state.statusCounts['under-review']} />}
        {state.departuresCount > 0 && <Pill tone="muted-ghost" label="departed" n={state.departuresCount} />}
        {state.overridesCount  > 0 && <Pill tone="warn-ghost"  label="overrides" n={state.overridesCount} />}
      </div>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-bg-tertiary border border-border-primary/60 rounded-sm2 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wide text-text-muted mb-0.5">{label}</div>
      <div className="font-mono text-sm text-text-primary tabular-nums">{value}</div>
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

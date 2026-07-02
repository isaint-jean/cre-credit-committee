/**
 * MembershipTable — the filterable per-loan table for the current tape.
 *
 * Read-only on its own data axis: rows drill into the loan's pool-side trajectory.
 * Funnel PR — each row is now ANALYSIS-STATE-AWARE: it asks the engine
 * "does an analysis exist for this dealRef?" via api.lookupAnalysisByDealRef
 * and branches between "Open underwriting" (found → existing /analysis/[id]
 * view; the dealRef delegation) and "New analysis" (not found → /analysis/new
 * pre-filled with this dealRef).
 *
 * COST DECISION (the N+1 question, stated): lookups are LIFTED to the table
 * level — ONE effect over the filtered membership fires N parallel
 * lookupAnalysisByDealRef calls via Promise.all and stores results in a
 * Map<dealRef, state>. Per row is just a Map.get(). This:
 *   (a) degrades gracefully: a slow row never blocks the table; per-row state
 *       resolves independently as Promise.all settles individually-rendered.
 *   (b) makes it a ONE-LINE swap to a batched endpoint (POST /api/analyses/
 *       lookup with body { dealRefs: string[] }) when active deals grow above
 *       ~50 loans per tape — the recon noted this as a future option; do NOT
 *       build it now (this PR is apps/web only).
 */
'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import type { LoanMembership, OnTapeStatus, PoolId } from '@cre/contracts';
import { DisabledAffordance } from './DisabledAffordance';
import type { Side } from '@/lib/side-context';
import { withSide } from '@/lib/side-accent';

/**
 * Real-state status chips. The ONLY membership status present in the data is
 * `under-review`, which the prototype renders as "On tape". The other three
 * statuses (clean / conditioned / kick-flagged) are part of the contract but not
 * yet in data; the chip renders them faithfully if/when they appear — no invented
 * vocabulary, no seeds.
 */
const STATUS_TONE: Record<OnTapeStatus, string> = {
  'clean':         'bg-score-strong/15 text-score-strong border-score-strong/30',
  'conditioned':   'bg-accent/15 text-accent border-accent/30',
  'kick-flagged':  'bg-risk-high/15 text-risk-high border-risk-high/30',
  'under-review':  'bg-buyer-soft text-buyer border-buyer/30',
};

const STATUS_LABEL: Record<OnTapeStatus, string> = {
  'clean':         'Clean',
  'conditioned':   'Conditioned',
  'kick-flagged':  'Kick-flagged',
  'under-review':  'On tape',
};

/**
 * Per-dealRef lookup state. Exported alongside the table so the branch logic
 * is testable in isolation (the fixture-shape check projects fixture responses
 * through `branchForLookup` and verifies the link URLs).
 */
export type LookupState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'found'; readonly analysisId: string; readonly status: string | null }
  | { readonly kind: 'not-found' };

export interface LoanRowBranch {
  readonly variant: 'open-underwriting' | 'new-analysis' | 'loading' | 'error';
  readonly href: string;
  readonly label: string;
  readonly statusHint: string | null;
}

/**
 * Pure projection: given a dealRef's lookup state, produce the link URL + label
 * the row should render. Exported for the fixture-shape test (verifies the
 * funnel's UI branch logic against the wire shape without React).
 */
export function branchForLookup(dealRef: string, state: LookupState | undefined): LoanRowBranch {
  if (state === undefined || state.kind === 'loading') {
    return { variant: 'loading', href: '#', label: 'Checking…', statusHint: null };
  }
  if (state.kind === 'error') {
    return { variant: 'error', href: '#', label: "Couldn't check", statusHint: null };
  }
  if (state.kind === 'found') {
    return {
      variant: 'open-underwriting',
      href: `/analysis/${state.analysisId}`,
      label: 'Open underwriting →',
      statusHint: state.status,
    };
  }
  // not-found
  return {
    variant: 'new-analysis',
    href: `/analysis/new?dealRef=${encodeURIComponent(dealRef)}`,
    label: 'New analysis →',
    statusHint: null,
  };
}

export function MembershipTable({
  poolId,
  membership,
  side = null,
}: {
  readonly poolId: PoolId;
  readonly membership: readonly LoanMembership[];
  readonly side?: Side | null;
}) {
  const [search, setSearch] = useState('');

  // Per-dealRef lookup state. Initialized 'loading' for every unique dealRef
  // on mount; resolves to 'found' | 'not-found' | 'error' as parallel lookups
  // settle. Row reads via Map.get(dealRef); rest of the row renders immediately.
  const [lookups, setLookups] = useState<Map<string, LookupState>>(() => new Map());

  // ★ P4c — Closed chip cross-reference. `lifecycleStatus` lives on `loan_in_pool`,
  // NOT on the membership row we render, so we can't read it off `m`. Instead we
  // fetch the pool's final tape (the per-loan CLOSED set) ONCE and mark any row
  // whose loanInPoolId is in it as Closed. Frontend-only; endpoint that exists.
  const [closedIds, setClosedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    api.getFinalTape(poolId)
      .then(({ loans }) => {
        if (cancelled) return;
        setClosedIds(new Set(loans.map(l => l.id)));
      })
      .catch(() => { /* advisory — no chip beats a wrong chip */ });
    return () => { cancelled = true; };
  }, [poolId]);

  // Unique dealRefs from the full membership (not the filtered view — filtering
  // is a UI-only concern; we don't want to re-fetch when the filter changes).
  const dealRefs = useMemo(() => {
    const set = new Set<string>();
    for (const m of membership) set.add(m.dealRef);
    return Array.from(set);
  }, [membership]);

  useEffect(() => {
    // Seed every dealRef as 'loading' on mount / when membership changes.
    setLookups(new Map(dealRefs.map(d => [d, { kind: 'loading' } as LookupState])));
    if (dealRefs.length === 0) return;
    let cancelled = false;
    // Fire all lookups in parallel. NOTE: when a batched endpoint becomes
    // available (POST /api/analyses/lookup body { dealRefs }), swap this entire
    // block for one api.batchLookupAnalysesByDealRef(dealRefs) call and
    // populate the Map in one setLookups call. The per-row API doesn't change.
    Promise.allSettled(dealRefs.map(d => api.lookupAnalysisByDealRef(d).then(r => [d, r] as const)))
      .then(results => {
        if (cancelled) return;
        setLookups(prev => {
          const next = new Map(prev);
          for (const r of results) {
            if (r.status === 'fulfilled') {
              const [dealRef, resp] = r.value;
              next.set(dealRef, resp.found
                ? { kind: 'found', analysisId: resp.analysisId, status: resp.status }
                : { kind: 'not-found' });
            }
            // For rejected (fetch error / 4xx), find the dealRef by elimination
            // — we don't have it in the rejection reason. Mark remaining
            // 'loading' entries as 'error'.
          }
          for (const d of dealRefs) {
            if (next.get(d)?.kind === 'loading') next.set(d, { kind: 'error' });
          }
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [dealRefs]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return membership.filter(m => {
      if (term.length > 0) {
        // Reseed PR B — search hits propertyName + city + dealRef + notes.
        const hay = `${m.propertyName ?? ''} ${m.city ?? ''} ${m.state ?? ''} ${m.dealRef} ${m.loanInPoolId} ${m.notes ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [membership, search]);

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
          Current tape · {membership.length} loans
        </h2>
        <DisabledAffordance label="Edit status / conditions" hint="Buyer edits in the review queue — next slice" />
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by property, city, deal ref…"
          className="bg-bg-tertiary border border-border-primary rounded px-3 py-2 text-text-primary text-sm
                     focus:outline-none focus:border-accent placeholder-text-muted flex-1 max-w-xs"
        />
      </div>

      <div className="border border-border-primary rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-tertiary">
            <tr className="text-left text-text-secondary text-xs uppercase tracking-wide">
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Property</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium text-right">Balance</th>
              <th className="px-3 py-2 font-medium">Seller</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Analysis</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-text-muted text-sm">
                No loans match the filter.
              </td></tr>
            ) : filtered.map(m => {
              const branch = branchForLookup(m.dealRef, lookups.get(m.dealRef));
              const identity = m.propertyName ?? m.dealRef; // backward-compat: synthetic pools fall back to dealRef
              const sub = formatLocationSub(m.city ?? null, m.state ?? null);
              return (
                <tr key={m.loanInPoolId} className="border-t border-border-primary hover:bg-bg-tertiary/40 transition-colors">
                  <td className="px-3 py-2 text-text-muted font-mono text-xs align-top">{m.tapePosition}</td>
                  <td className="px-3 py-2 align-top">
                    <div className="font-sans text-text-primary font-medium">{identity}</div>
                    {sub !== null && (
                      <div className="text-text-muted text-xs mt-0.5">{sub}</div>
                    )}
                    {/* dealRef de-emphasized audit handle (the funnel join key, not the identity). */}
                    <div className="text-text-subtle text-[10px] font-mono mt-0.5 truncate" title={m.dealRef}>
                      {m.dealRef}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-text-secondary text-xs align-top">
                    {m.propertyType ?? <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-text-primary font-mono text-right tabular-nums align-top">
                    {formatBalance(m.cutOffBalance ?? null)}
                  </td>
                  <td className="px-3 py-2 text-text-secondary text-xs font-mono align-top">
                    {m.mortgageLoanSeller ?? <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 align-top">
                    {closedIds.has(m.loanInPoolId) ? (
                      // ★ Closed cross-ref (getFinalTape). A closed loan STAYS in the
                      // pool → still on this tape; the Closed terminal supersedes the
                      // per-tape review chip, so we show Closed in its place.
                      <span
                        className="text-xs px-2 py-0.5 rounded border bg-score-strong/15 text-score-strong border-score-strong/30"
                        title="Closed — funded to the final tape"
                      >
                        Closed
                      </span>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_TONE[m.status]}`}>
                        {STATUS_LABEL[m.status]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs align-top">
                    <LoanFunnelCell branch={branch} />
                  </td>
                  <td className="px-3 py-2 text-right align-top">
                    <Link
                      href={withSide(`/pools/${poolId}/loans/${m.loanInPoolId}`, side)}
                      className="text-accent hover:text-accent-hover text-xs"
                    >
                      Trajectory →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Dollar formatter for the balance column ($X.XB / $XXXmm / $XXXk). */
function formatBalance(b: number | null | undefined): ReactNode {
  if (b === null || b === undefined || !Number.isFinite(b)) {
    return <span className="text-text-muted">—</span>;
  }
  if (b >= 1e9)  return `$${(b / 1e9).toFixed(2)}B`;
  if (b >= 1e6)  return `$${Math.round(b / 1e6)}mm`;
  if (b >= 1e3)  return `$${Math.round(b / 1e3)}k`;
  return `$${Math.round(b)}`;
}

/** "San Diego, CA" — or null when neither is present. */
function formatLocationSub(city: string | null, state: string | null): string | null {
  if (city === null && state === null) return null;
  if (city !== null && state !== null) return `${city}, ${state}`;
  return city ?? state;
}

/**
 * Renders one cell from a LoanRowBranch — clickable Link for found/not-found,
 * inert text for loading/error. The "couldn't check" error state deliberately
 * does NOT show a fake button — a row whose analysis status is unknown stays
 * navigable via the Trajectory link to its right but doesn't pretend it can
 * resolve underwriting.
 */
function LoanFunnelCell({ branch }: { readonly branch: LoanRowBranch }) {
  if (branch.variant === 'loading') {
    return <span className="text-text-muted">Checking…</span>;
  }
  if (branch.variant === 'error') {
    return <span className="text-risk-medium" title="Couldn't check analysis status — try refresh">Couldn't check</span>;
  }
  if (branch.variant === 'open-underwriting') {
    return (
      <Link href={branch.href} className="text-accent hover:text-accent-hover">
        {branch.label}
        {branch.statusHint !== null && (
          <span className="text-text-muted ml-1">· {branch.statusHint}</span>
        )}
      </Link>
    );
  }
  // new-analysis
  return (
    <Link
      href={branch.href}
      className="inline-flex items-center px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
    >
      {branch.label}
    </Link>
  );
}

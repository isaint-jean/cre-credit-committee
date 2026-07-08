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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

/**
 * ★ Data-Room P0 — per-loan DOC-COVERAGE chip. ORTHOGONAL to Status/score: a
 * document signal ("are the facts sourced?"), never a credit signal. The palette
 * is deliberately NEUTRAL / slate — explicitly NOT the score-strong green the
 * Clean / Closed chips use — so a green-coverage / High-Risk deal reads honestly.
 * Copy is doc-vocabulary only ("Docs complete" / "Missing …" / "No docs") — never
 * credit words like "clean" or "approved".
 */
type CoverageState = 'complete' | 'partial' | 'none';
interface LoanCoverage {
  readonly loanInPoolId: string;
  readonly state: CoverageState;
  readonly missing: readonly string[];
}

/**
 * ★ Data-Room Phase 3, P1 — per-loan transient state for the "Underwrite now"
 * action. idle (default, not in the map) → running → done | failed. This is a
 * PROCESS signal (did the ingest run?), distinct from BOTH the coverage chip
 * (docs on hand) and the Status verdict (credit opinion) — three separate axes.
 */
type UnderwriteRowState =
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * ★ Data-Room Phase 3, P3 — the ASYNC (queue-backed) job state per loan, polled
 * from GET /pools/:poolId/underwrite-jobs. Distinct from the P1 manual
 * `UnderwriteRowState` above: THIS is the durable-queue status a settle enqueued.
 *   pending | running → "Underwriting…" (inert — the worker is draining it)
 *   done              → chip resolves to the P0 coverage (complete/partial)
 *   failed | interrupted → the REAL reason (coverage stays doc-truth, no fake green)
 */
type JobState = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
interface LoanJob {
  readonly loanInPoolId: string;
  readonly state: JobState;
  readonly reason: string | null;
}
const JOB_ACTIVE: ReadonlySet<JobState> = new Set(['pending', 'running']);

const COVERAGE_TONE: Record<CoverageState, string> = {
  // Neutral / slate — NOT score-strong. A calm filled slate = "docs complete".
  'complete': 'bg-text-secondary/10 text-text-secondary border-text-secondary/30',
  // Muted outline — some docs, not all.
  'partial':  'bg-bg-tertiary text-text-muted border-border-primary',
  // Ghost — nothing on file.
  'none':     'bg-transparent text-text-subtle border-border-primary/50',
};

/** Doc-vocabulary copy for a coverage cell. Missing types are named for partial. */
function coverageLabel(cov: LoanCoverage | undefined): { text: string; title: string } {
  if (cov === undefined) return { text: '—', title: 'Coverage not yet loaded' };
  if (cov.state === 'complete') {
    return { text: 'Docs complete', title: 'Required source-doc facts are all extracted (doc coverage — not a credit signal)' };
  }
  if (cov.state === 'none') {
    return { text: 'No docs', title: 'No source documents on file for this loan' };
  }
  const types = cov.missing.join(', ');
  return {
    text: types.length > 0 ? `Missing ${types}` : 'Partial docs',
    title: types.length > 0
      ? `Source docs still missing / un-extracted: ${types} (doc coverage — not a credit signal)`
      : 'Some source-doc facts extracted, some still missing',
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

  // ★ P0 — per-loan DOC-COVERAGE. Fetched ONCE for the pool (same lift-to-table
  // pattern as closedIds); keyed by loanInPoolId. Coverage is a DOCUMENT signal,
  // orthogonal to the Status column's credit verdict — a separate column entirely.
  const [coverage, setCoverage] = useState<Map<string, LoanCoverage>>(() => new Map());
  const refetchCoverage = useCallback(() => {
    return api.getPoolCoverage(poolId)
      .then(({ coverage: rows }) => {
        setCoverage(new Map(rows.map(r => [r.loanInPoolId, r])));
      })
      .catch(() => { /* advisory — no chip beats a wrong chip */ });
  }, [poolId]);
  useEffect(() => {
    let cancelled = false;
    api.getPoolCoverage(poolId)
      .then(({ coverage: rows }) => {
        if (cancelled) return;
        setCoverage(new Map(rows.map(r => [r.loanInPoolId, r])));
      })
      .catch(() => { /* advisory — no chip beats a wrong chip */ });
    return () => { cancelled = true; };
  }, [poolId]);

  // ★ Data-Room Phase 3, P3 — ASYNC underwrite job state, keyed by loanInPoolId.
  // Polled while any job is active (pending|running) so "Underwriting…" resolves
  // live as the worker drains; when a job flips to `done` we also refetch coverage
  // so the chip re-derives to complete/partial. failed|interrupted surface the
  // real reason. Poll STOPS once no job is active (nothing left to watch).
  //
  // ★ The manual "Underwrite now" is now ASYNC too — it enqueues onto THIS same
  // queue and returns fast, so it feeds the SAME poll (no separate sync path). The
  // poll loop is a self-scheduling ref so `runUnderwrite` can (re)start it after an
  // enqueue without duplicating the tick.
  const [jobs, setJobs] = useState<Map<string, LoanJob>>(() => new Map());
  const cancelledRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveRef = useRef(false);
  const pollTick = useCallback(async () => {
    try {
      const { jobs: rows } = await api.getPoolUnderwriteJobs(poolId);
      if (cancelledRef.current) return;
      const next = new Map(rows.map(r => [r.loanInPoolId, { loanInPoolId: r.loanInPoolId, state: r.state, reason: r.reason }]));
      setJobs(next);
      const active = rows.some(r => JOB_ACTIVE.has(r.state));
      // A job just finished draining (was active, now none) → coverage + lookups moved.
      if (prevActiveRef.current && !active) {
        void refetchCoverage();
        void refetchLookupsRef.current();
      }
      prevActiveRef.current = active;
      // Keep polling only while something is in flight.
      if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }
      if (active && !cancelledRef.current) pollTimerRef.current = setTimeout(() => void pollTick(), 2500);
    } catch { /* advisory — no chip beats a wrong chip */ }
  }, [poolId, refetchCoverage]);
  // refetchLookupsRef is a stable escape hatch so the poll can re-resolve dealRef
  // lookups (a no-root loan flips "New analysis →" → "Open underwriting →" once its
  // root is minted) without pollTick depending on the lookups closure.
  const refetchLookupsRef = useRef<() => void>(() => {});
  useEffect(() => {
    cancelledRef.current = false;
    void pollTick();
    return () => { cancelledRef.current = true; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, [pollTick]);

  // ★ Data-Room Phase 3 — the manual "Underwrite now" action. NOW FIRE-AND-POLL
  // (was a sync/blocking call): the POST ENQUEUES a durable job and returns FAST
  // (202) — no socket-timeout on a heavy 60 MB extraction. We mark the row
  // "running" optimistically, then let the SHARED job poll (above) surface
  // "Underwriting…" and resolve to done | failed | interrupted as the worker
  // drains off-request. The enqueue is dedup'd server-side (one active job per
  // loan) so a manual click + a settle auto-fire, or a double-click, never
  // double-runs a loan. `alreadyActive` just means we joined an in-flight job.
  const [underwrite, setUnderwrite] = useState<Map<string, UnderwriteRowState>>(() => new Map());
  const runUnderwrite = useCallback((loanInPoolId: string, _dealRef: string) => {
    void _dealRef; // dealRef re-lookup now happens on poll completion (refetchLookupsRef).
    setUnderwrite(prev => new Map(prev).set(loanInPoolId, { kind: 'running' }));
    api.underwriteLoan(poolId, loanInPoolId)
      .then(() => {
        // Enqueued (or joined an in-flight job). Optimistically seed the job map so
        // "Underwriting…" shows before the first poll returns, then (re)start the
        // poll to watch it drain. The button state hands off to the shared chip.
        setJobs(prev => {
          if (prev.has(loanInPoolId) && JOB_ACTIVE.has(prev.get(loanInPoolId)!.state)) return prev;
          return new Map(prev).set(loanInPoolId, { loanInPoolId, state: 'pending', reason: null });
        });
        setUnderwrite(prev => { const m = new Map(prev); m.delete(loanInPoolId); return m; });
        prevActiveRef.current = true; // ensure the finish-of-drain coverage refetch fires
        void pollTick();
      })
      .catch((e: unknown) => {
        // Only the ENQUEUE can fail here (404 / network) — extraction failures are
        // reported by the job poll (failed|interrupted), not this promise.
        const reason = e instanceof Error ? e.message : 'Could not queue underwrite';
        setUnderwrite(prev => new Map(prev).set(loanInPoolId, { kind: 'failed', reason }));
      });
  }, [poolId, pollTick]);

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

  // Re-resolve every dealRef lookup (called by the job poll when a drain finishes:
  // a no-root loan that just got its first underwrite flips "New analysis →" →
  // "Open underwriting →" once the analysis exists). Kept off pollTick's dep list
  // via a ref so the poll loop stays stable.
  const refetchAllLookups = useCallback(() => {
    Promise.allSettled(dealRefs.map(d => api.lookupAnalysisByDealRef(d).then(r => [d, r] as const)))
      .then(results => {
        setLookups(prev => {
          const next = new Map(prev);
          for (const r of results) {
            if (r.status === 'fulfilled') {
              const [dealRef, resp] = r.value;
              next.set(dealRef, resp.found
                ? { kind: 'found', analysisId: resp.analysisId, status: resp.status }
                : { kind: 'not-found' });
            }
          }
          return next;
        });
      })
      .catch(() => { /* advisory */ });
  }, [dealRefs]);
  useEffect(() => { refetchLookupsRef.current = refetchAllLookups; }, [refetchAllLookups]);

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
              <th className="px-3 py-2 font-medium">Coverage</th>
              <th className="px-3 py-2 font-medium">Analysis</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-text-muted text-sm">
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
                  <td className="px-3 py-2 align-top">
                    {(() => {
                      const cov = coverage.get(m.loanInPoolId);
                      const { text, title } = coverageLabel(cov);
                      const tone = cov ? COVERAGE_TONE[cov.state] : COVERAGE_TONE.none;
                      const hasDocs = cov !== undefined && cov.state !== 'none';
                      const uw = underwrite.get(m.loanInPoolId);
                      const job = jobs.get(m.loanInPoolId);
                      return (
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={`text-xs px-2 py-0.5 rounded border ${tone}`}
                            title={title}
                          >
                            {text}
                          </span>
                          {/* ★ P3 async queue status takes precedence: an enqueued
                              (settle-fired) job shows "Underwriting…" / the real
                              failure reason. done → falls through to the manual
                              P1 affordance so a later doc drop can re-underwrite. */}
                          {job && JOB_ACTIVE.has(job.state) ? (
                            <span className="text-[11px] text-text-muted" title="Queued underwrite in flight — the worker is draining it off-request">
                              Underwriting…
                            </span>
                          ) : job && (job.state === 'failed' || job.state === 'interrupted') ? (
                            <button
                              type="button"
                              onClick={() => runUnderwrite(m.loanInPoolId, m.dealRef)}
                              className="text-[11px] text-risk-high hover:underline"
                              title={job.state === 'interrupted'
                                ? `Underwrite interrupted (process restarted mid-flight — outcome unknown). ${job.reason ?? ''} Click to re-run.`
                                : `Underwrite failed: ${job.reason ?? 'unknown reason'}. Click to retry.`}
                            >
                              {job.state === 'interrupted' ? 'Underwrite interrupted — re-run' : 'Underwrite failed — retry'}
                            </button>
                          ) : (
                            <UnderwriteAction
                              state={uw}
                              enabled={hasDocs}
                              onRun={() => runUnderwrite(m.loanInPoolId, m.dealRef)}
                            />
                          )}
                        </div>
                      );
                    })()}
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

/**
 * ★ Data-Room Phase 3 — the "Underwrite now" action button. ENQUEUES ONE durable
 * job (async — returns fast, no socket-timeout) that runs the ingest/append for
 * the loan from its data-room tier-(a) docs. Disabled (with a doc-vocabulary hint)
 * when the loan has NO ingestable docs — never fire nothing. Transient states:
 * running → "Underwriting…" (the brief enqueue window; then the shared job chip
 * takes over as the worker drains); done → a quiet re-run affordance (a later doc
 * drop re-underwrites); failed → the enqueue error in a tooltip (extraction
 * failures surface on the job chip, not here). A PROCESS control, kept
 * doc-vocabulary + neutral so it never reads as a credit action.
 */
function UnderwriteAction({
  state,
  enabled,
  onRun,
}: {
  readonly state: UnderwriteRowState | undefined;
  readonly enabled: boolean;
  readonly onRun: () => void;
}) {
  if (state?.kind === 'running') {
    return <span className="text-[11px] text-text-muted" title="Queuing underwrite — the worker will drain it off-request">Underwriting…</span>;
  }
  if (!enabled) {
    return (
      <span
        className="text-[11px] text-text-subtle"
        title="No ingestable (ASR / cash-flow / rent-roll / PCA / appraisal) docs on file yet"
      >
        No docs to underwrite
      </span>
    );
  }
  if (state?.kind === 'failed') {
    return (
      <button
        type="button"
        onClick={onRun}
        className="text-[11px] text-risk-high hover:underline"
        title={`Underwrite failed: ${state.reason}. Click to retry.`}
      >
        Underwrite failed — retry
      </button>
    );
  }
  const label = state?.kind === 'done' ? 'Re-underwrite' : 'Underwrite now';
  return (
    <button
      type="button"
      onClick={onRun}
      className="text-[11px] text-accent hover:text-accent-hover hover:underline"
      title={state?.kind === 'done'
        ? 'Re-run ingest over the current doc set (a new child revision)'
        : 'Run ingest over this loan’s source docs (extractor + engine)'}
    >
      {label}
    </button>
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

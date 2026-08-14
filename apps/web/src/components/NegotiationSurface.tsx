'use client';

/**
 * NegotiationSurface — the deal-room negotiation interaction, ported onto the
 * graph/rendered surface (converge phase i). Mounts INSIDE RenderedAnalysisView
 * above the analytics sections; every field it reads comes from the
 * RenderedAnalysis (`data.*`) or the committee projection the page already fetched
 * (`workflow` / `timeline`). NOTHING here reads legacy `Analysis` fields.
 *
 * What ported from DealRoom.tsx (UI only):
 *   - the 3-tier role/access seam (`roleView().access`) — presentation preview
 *   - the `?side` accents (ochre / steel / teal) via useSide + sideAccentC
 *   - contested-point cards (doctrine flags + findings → expandable cards)
 *   - the P4b 7-lever agreement ledger (LEVERS), bound to `data.mitigations`
 *   - ConvergenceBar (ratified-mitigant COUNT — never the credit score)
 *   - DispositionBar shell (4 reason-category preview)
 *   - the per-point / per-lever comment composer (LIVE — graph-native, see note below)
 *
 * ★ REAL OVERRIDE (net-new vs DealRoom's session Set):
 *   lever "agree" → api.createOverlay (mints/fetches the deterministic overlay-created
 *   anchor per lever) → api.submitOverrideDecision (persisted OVERRIDE_DECISION on the
 *   committee ledger). The ratified state is a DERIVED READ of the persisted timeline,
 *   not a session Set. Each lever gets a stable overlayId (overlayKey = `lever:<id>`),
 *   so a persisted OVERRIDE whose summary carries that overlayId = that lever ratified.
 *
 * ★ GRAPH-NATIVE COMMENT COMPOSER (LIVE): the composer posts a `comment-added` overlay
 *   patch — api.createOverlay mints/fetches a deterministic anchor per "re:" path
 *   (overlayKey = `comment:<path>`), then api.postOverlayComment writes the patch body
 *   (kind:'comment', path, author, text, createdAt) + a hash-EXCLUDED `side` column.
 *   Posted comments read back via api.getOverlayComments, side-tagged ochre (originator)
 *   / steel (buyer) via the P1 tokens with the "re:" path shown. This retires the legacy
 *   per-point transport (`api.addComment`, which keyed on the uuid analysis id).
 *
 * ★ BANKED as legacy-only parity follow-up (NOT ported — they don't exist on
 *   RenderedAnalysis): the DealRoom workspace-drawer tabs criteriaEvaluations /
 *   crossCheckFindings / research / bPieceDecision. request-a-call stays a labeled
 *   preview. RA's own sections (stress / handbook / doctrine / score / findings /
 *   mitigants / narrative) stay in RenderedAnalysisView, untouched.
 */

import React, { useEffect, useState } from 'react';
import type {
  CommitteeTimeline,
  DealWorkflowState,
  DispositionKind,
  DoctrineEvaluationId,
  ReasonCategory,
  RenderedAnalysis,
  RenderedMitigationProposal,
  RenderBadgeSeverity,
} from '@cre/contracts';
import { REASON_CATEGORIES, REASON_CATEGORY_OUTCOME, isReasonCategoryValidForOutcome } from '@cre/contracts';
import { api, type LoanForRootResolution, type OverlayCommentView } from '@/lib/api-client';
import { useSide, type Side } from '@/lib/side-context';
import { negotiationLoopEnabled } from '@/lib/flags';

type Role = 'bp_spire' | 'originator';

/* ─────────────────────── Phase B — terminal-action outcomes ──────────────────── */
/*
 * The graph-native DispositionBar goes LIVE for a DETERMINATE loan (the Phase-A
 * forward resolver turned data.rootId into a single {poolId, loanInPoolId}). These
 * mirror the pool-page CloseOutcome / DisposeOutcome exactly — honest, code-
 * distinguished results; the ONLY green is a real close / disposition, every 409/422
 * surfaces the server's specific reason (NO fake success).
 */
type CloseOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'closing' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

type DisposeOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'disposed'; readonly outcome: DispositionKind }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

/** Human labels for the two authoritative disposition outcomes (mirrors pool page). */
const OUTCOME_LABEL: Record<DispositionKind, string> = {
  kicked: 'Reject (kicked)',
  dropped: 'Withdraw (dropped)',
};

/** Human labels for the reason-category enum keys (§7 taxonomy; mirrors pool page). */
const REASON_CATEGORY_LABEL: Record<ReasonCategory, string> = {
  disqualifying: 'Disqualifying',
  couldnt_structure: "Couldn't structure",
  expired: 'Expired',
  withdrawn: 'Withdrawn by servicer',
};

// ── Wireframe palette (explicit; scoped to this surface) ───────────────────────
const C = {
  bg: '#F5F7F8', surface: '#FFFFFF', surface2: '#FBFCFC', border: '#E2E8EA', borderStrong: '#CCD6D9',
  ink: '#15262C', ink2: '#4A5C62', ink3: '#8A979C',
  teal: '#0C6E78', tealDeep: '#0A555D', tealSoft: '#E6F1F2',
  amber: '#A9641F', amberSoft: '#F6ECDD',
  flagged: '#A9641F', contested: '#345F9E', resolved: '#2E7D5B', conceded: '#6B7A80', kicked: '#AE3A33',
} as const;
const SANS = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const num = (color: string = C.ink): React.CSSProperties => ({ fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color });

/* ───────────────────────── Contested points (RA-native) ─────────────────────── */

interface ContestedPoint {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: RenderBadgeSeverity | 'info';
}

const oneLine = (s: string, max = 130): string => {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * On the graph surface a "contested point" is a doctrine flag (RenderBadge: code /
 * label / severity — the richest human-readable signal the RA carries) augmented with
 * the raw findings (ruleId / reasonCode). RenderedFinding is minimal by contract
 * (ruleId + reasonCode only — no title/explanation/severity), so it feeds the card's
 * subtitle, while the badge label leads.
 */
function deriveContestedPoints(data: RenderedAnalysis): ContestedPoint[] {
  const fromFlags: ContestedPoint[] = data.doctrine.flags.map((b) => ({
    id: `flag:${b.code}`,
    title: b.label,
    summary: oneLine(b.code),
    severity: b.severity,
  }));
  // Findings that aren't already surfaced as a doctrine flag (dedupe by reasonCode).
  const flagCodes = new Set(data.doctrine.flags.map((b) => b.code));
  const fromFindings: ContestedPoint[] = data.findings
    .filter((f) => !flagCodes.has(f.reasonCode) && !flagCodes.has(f.ruleId))
    .map((f) => ({
      id: `finding:${f.ruleId}:${f.reasonCode}`,
      title: oneLine(f.reasonCode.replace(/_/g, ' '), 72),
      summary: oneLine(f.ruleId),
      severity: 'info' as const,
    }));
  return [...fromFlags, ...fromFindings];
}

function severityColor(sev: ContestedPoint['severity']): string {
  return sev === 'critical' ? C.kicked : sev === 'warning' ? C.flagged : C.conceded;
}

/* ───────────────────────── 7-lever agreement ledger ─────────────────────────── */
/*
 * ★ NO TOY SCORE. The doctrine score renders AS-IS in RenderedAnalysisView and NEVER
 * moves when a lever is agreed. Agreeing a lever records a persisted OVERRIDE_DECISION
 * + increments the ratified-mitigant CONVERGENCE count. `reduce_proceeds` is the sole
 * lever that re-scores for real (via a graph revision), surfaced as a labeled
 * affordance rather than a faked score move.
 *
 * Binding is by the RA's canonical MitigationLever enum (exact match) — a strict
 * improvement over the legacy keyword matching.
 */
interface LeverDef {
  readonly id: string;
  readonly name: string;
  /** Exact RenderedMitigationProposal.lever values that bind this ledger row. */
  readonly levers: readonly string[];
  readonly orig: string;
  readonly buyer: string;
  readonly buyerWhy: string;
  /** proceeds is the last-resort economic lever — the ONLY one that really re-scores. */
  readonly lastResort?: boolean;
}
const LEVERS: readonly LeverDef[] = [
  { id: 'reserve', name: 'Lease-up reserve', levers: ['fund_reserve', 'cash_sweep_refi_reserve'],
    orig: 'Minimal reserve', buyer: 'Fund a lease-up / carry reserve', buyerWhy: 'Funds carry the asset through stabilization' },
  { id: 'cash', name: 'Cash management', levers: ['springing_cash_management', 'in_place_cash_management'],
    orig: 'No lockbox', buyer: 'Springing / in-place lockbox', buyerWhy: 'Traps cash if lease-up stalls' },
  { id: 'guaranty', name: 'Recourse / guaranty', levers: ['require_guaranty', 'leverage_band_recourse', 'springing_dscr_recourse'],
    orig: 'Non-recourse', buyer: 'Springing recourse on milestones', buyerWhy: 'Recourse triggers if lease-up misses' },
  { id: 'amort', name: 'Amortization', levers: ['require_amortization'],
    orig: 'Full-term interest-only', buyer: 'Amortize after stabilization', buyerWhy: 'Builds equity once stabilized' },
  { id: 'cp', name: 'Conditions precedent', levers: ['condition_precedent'],
    orig: 'None at close', buyer: 'Estoppel + lease-up evidence at close', buyerWhy: 'Verifies the anchor before funding' },
  { id: 'proceeds', name: 'Loan proceeds', levers: ['reduce_proceeds'], lastResort: true,
    orig: 'Full request', buyer: 'Reduce proceeds (lower basis)', buyerWhy: 'De-risks by lowering basis' },
];

interface LeverBinding {
  readonly def: LeverDef;
  readonly mitigant: RenderedMitigationProposal | null;
}
function bindLevers(mitigations: readonly RenderedMitigationProposal[]): LeverBinding[] {
  const used = new Set<string>();
  return LEVERS.map((def) => {
    const mitigant = mitigations.find((m) => !used.has(m.id) && def.levers.includes(m.lever)) ?? null;
    if (mitigant) used.add(mitigant.id);
    return { def, mitigant };
  });
}

/** Map the active URL `?side` onto the explicit C palette (ochre / steel / teal). */
function sideAccentC(side: Side | null): { accent: string; soft: string; label: string } {
  if (side === 'originator') return { accent: C.amber, soft: C.amberSoft, label: 'Servicer' };
  if (side === 'buyer') return { accent: C.contested, soft: '#EAF0F8', label: 'B-piece buyer' };
  return { accent: C.teal, soft: C.tealSoft, label: 'Platform' };
}

/**
 * P1 side tokens applied to a POSTED comment's stored `side` (ochre = originator,
 * steel = buyer). A comment with no stored side falls back to neutral. This is the
 * READ-BACK tag — distinct from the viewer's own `?side` chip.
 */
function commentSideTag(side: OverlayCommentView['side']): { accent: string; soft: string; label: string } {
  if (side === 'originator') return { accent: C.amber, soft: C.amberSoft, label: 'Servicer' };
  if (side === 'buyer') return { accent: C.contested, soft: '#EAF0F8', label: 'B-piece buyer' };
  return { accent: C.conceded, soft: C.surface2, label: 'Unattributed' };
}

/** ★ THE SINGLE ROLE SEAM — a 3-tier access object future server authz plugs into.
 *  workbook: buyer-only · memo: shared · points: shared. Presentation preview only. */
function roleView(role: Role) {
  const access = {
    workbook: role === 'bp_spire' ? ('buyer-only' as const) : ('hidden' as const),
    memo: 'shared' as const,
    points: 'shared' as const,
  };
  if (role === 'bp_spire') {
    return { label: 'BP Spire', accent: C.teal, canComment: true, pointActions: ['Respond', 'Resolve', 'Kick back'] };
  }
  return { label: 'Servicer', accent: C.amber, canComment: false, pointActions: ['Provide evidence'] };
}

/* ───────────────────────────── Ratification read ─────────────────────────────── */
/*
 * Which levers are ratified is a DERIVED READ of the PERSISTED committee ledger, not a
 * session Set. Each lever's overlay carries a deterministic id the server derives from
 * (rootId, renderedAnalysisId, overlayKey='lever:<id>'); a persisted OVERRIDE_DECISION
 * whose server-built summary carries that overlayId means that lever is ratified.
 * The summary format is deterministic ('...registered for overlay <overlayId>'), so a
 * substring match is a sound read of append-only state.
 */
function ratifiedLeverIds(timeline: CommitteeTimeline | undefined): Set<string> {
  const out = new Set<string>();
  if (timeline === undefined) return out;
  for (const e of timeline.entries) {
    if (e.kind !== 'committee-action' || e.subKind !== 'OVERRIDE_DECISION') continue;
    for (const def of LEVERS) {
      // The server embeds the sanitized overlayKey ('lever:<id>' -> 'lever-<id>') in the
      // overlayId ('ov-lever-<id>-<hash>'), and the OVERRIDE_DECISION summary carries the
      // overlayId verbatim ('...registered for overlay ov-lever-<id>-<hash>'). So a stable
      // substring match on the lever marker is a sound read of persisted state — no hash
      // recompute, no session Set. The trailing '-' avoids id-prefix collisions.
      if (e.summary.includes(`ov-lever-${def.id}-`)) out.add(def.id);
    }
  }
  return out;
}

/* ─────────────────────────────── Component ───────────────────────────────────── */

interface Props {
  readonly data: RenderedAnalysis;
  readonly workflow?: DealWorkflowState;
  readonly timeline?: CommitteeTimeline;
  /** Called after a successful override so the page refetches workflow + timeline. */
  readonly onWorkflowChanged?: () => void;
}

export function NegotiationSurface({ data, workflow, timeline, onWorkflowChanged }: Props): React.ReactElement | null {
  // Shelved with the negotiation loop (default off). Constant flag → stable render;
  // the parent (RenderedAnalysisView) also re-fronts to the workspace/score primary.
  if (!negotiationLoopEnabled) return null;
  const side = useSide();
  const [role, setRole] = useState<Role>('bp_spire');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyLever, setBusyLever] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Chunk 7c — the originator's negotiation actions (push back / request a call /
  // send to buyer), posted as the 7b committee-action events, gated by the 7a perms.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [callRequests, setCallRequests] = useState<Set<string>>(new Set());
  // Ratified levers, seeded from persisted timeline + optimistically extended on agree
  // (the page refetch collapses the optimistic set back into the derived read).
  const [ratifiedOptimistic, setRatifiedOptimistic] = useState<Set<string>>(new Set());
  // Posted comments (graph-native overlay-comment patches), keyed by their "re:" path
  // for per-point / per-lever rendering. Fetched on mount + refetched after each post.
  const [comments, setComments] = useState<readonly OverlayCommentView[]>([]);
  const [busyComposer, setBusyComposer] = useState<string | null>(null);
  // Panel collapse — the contested points ("Red Flags") and the negotiation ledger
  // ("Let's Structure This Deal Together") now render as two titled boxes (flag →
  // structure). Both default open so the doctrine reads first; the ▾ tucks either away.
  // View-only: no shared flag↔lever state was moved — only the visual frame was split,
  // so every ratify / comment / related-mitigant path stays in this component's scope.
  const [flagsOpen, setFlagsOpen] = useState(true);
  const [structureOpen, setStructureOpen] = useState(true);

  // ── Phase B — forward root → loan resolution (pool identity for the terminal ──
  // actions). Resolved ONCE on mount from data.rootId. `null` = still resolving;
  // determinate (resolved:true) unlocks the LIVE close / reject / withdraw writes;
  // ambiguous (resolved:false) keeps the bar an honest preview/deep-link.
  const [resolution, setResolution] = useState<LoanForRootResolution | null>(null);
  const [closeOutcome, setCloseOutcome] = useState<CloseOutcome>({ kind: 'idle' });
  const [disposeOutcome, setDisposeOutcome] = useState<DisposeOutcome>({ kind: 'idle' });

  const refetchComments = React.useCallback(async () => {
    try {
      const res = await api.getOverlayComments(data.rootId);
      setComments(res.comments);
    } catch {
      /* read is advisory; a fetch failure leaves the last-known set in place */
    }
  }, [data.rootId]);

  useEffect(() => {
    void refetchComments();
  }, [refetchComments]);

  // ★ Phase B — resolve the pool identity ONCE from data.rootId. Read-only; never
  // throws for the ambiguous case (the client returns a discriminated union). A
  // resolution failure leaves `resolution` null → the bar stays a safe preview.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await api.getLoanForRoot(data.rootId);
        if (live) setResolution(r);
      } catch {
        if (live) setResolution({ resolved: false, ambiguous: true, reason: 'ROOT_NOT_FOUND', matchCount: 0 });
      }
    })();
    return () => { live = false; };
  }, [data.rootId]);

  const commentsByPath = React.useMemo(() => {
    const m = new Map<string, OverlayCommentView[]>();
    for (const c of comments) {
      const arr = m.get(c.path) ?? [];
      arr.push(c);
      m.set(c.path, arr);
    }
    return m;
  }, [comments]);

  // ★ Post a comment — graph-native. Mints/fetches the deterministic overlay anchor for
  // this path (overlayKey = the "re:" path), then writes the comment-added patch carrying
  // the path + the viewer's ?side. The overlayKey namespace is the path itself so each
  // point/lever thread rides its own stable overlay chain.
  const postComment = async (path: string, text: string): Promise<boolean> => {
    if (busyComposer !== null || text.trim().length === 0) return false;
    setBusyComposer(path);
    setError(null);
    try {
      const overlayKey = `comment:${path}`;
      const { overlayId } = await api.createOverlay({
        rootId: data.rootId,
        renderedAnalysisId: data.id,
        overlayKey,
      });
      await api.postOverlayComment({ overlayId, path, text: text.trim(), side });
      await refetchComments();
      return true;
    } catch (e) {
      setError((e as Error).message || 'Could not post the comment.');
      return false;
    } finally {
      setBusyComposer(null);
    }
  };

  const persistedRatified = ratifiedLeverIds(timeline);
  useEffect(() => {
    // When the persisted read catches up, drop optimistic entries it now covers.
    setRatifiedOptimistic((prev) => {
      const next = new Set(prev);
      for (const id of prev) if (persistedRatified.has(id)) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline]);
  const isRatified = (leverId: string): boolean => persistedRatified.has(leverId) || ratifiedOptimistic.has(leverId);

  const view = roleView(role);
  const sideC = sideAccentC(side);
  const points = deriveContestedPoints(data);
  const criticalCount = points.filter((p) => p.severity === 'critical').length;

  // ── Lever ledger — REAL bindings, no toy score ────────────────────────────────
  const leverBindings = bindLevers(data.mitigations);
  const structuralBound = leverBindings.filter((b) => !b.def.lastResort && b.mitigant);
  const ratifiedCount = structuralBound.filter((b) => isRatified(b.def.id)).length;
  const convergenceTotal = structuralBound.length;

  // ── Cleared = derived read-only predicate (RA + workflow) ─────────────────────
  const hasFatalFlag = data.doctrine.flags.some((b) => b.severity === 'critical')
    || data.summary.coverage.insufficientCoverageGate.value === true;
  const band = String(data.summary.ratingBand.value ?? '').toLowerCase();
  const bandOk = band.length > 0 && !band.includes('decline') && !band.includes('high risk');
  const structuralAllRatified = convergenceTotal > 0 && ratifiedCount === convergenceTotal;
  const derivedCleared = !hasFatalFlag && bandOk && (convergenceTotal === 0 || structuralAllRatified);

  const toggle = (pid: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  const requestCall = (key: string) => setCallRequests((p) => new Set(p).add(key));

  // ★ Chunk 7c — post an originator comms event (7b) via the committee-action channel.
  // The server gates each kind by the 7a permission (originator-only); on success the
  // page refetches the workflow so the derived state (e.g. SENT_TO_BUYER → "waiting on
  // buyer") appears. Constructive, collaborative — the "structure this together" posture.
  const postOriginatorAction = async (
    label: string,
    body: Parameters<typeof api.submitCommitteeAction>[0]['payload'],
    kind: Parameters<typeof api.submitCommitteeAction>[0]['kind'],
  ): Promise<void> => {
    if (busyAction !== null) return;
    setBusyAction(label);
    setError(null);
    try {
      await api.submitCommitteeAction({ rootId: data.rootId, renderedAnalysisId: data.id, kind, payload: body });
      onWorkflowChanged?.();
    } catch (e) {
      setError((e as Error).message || 'Could not submit that action.');
    } finally {
      setBusyAction(null);
    }
  };

  // ★ Lever "agree" → REAL persisted OVERRIDE_DECISION.
  const ratifyLever = async (b: LeverBinding): Promise<void> => {
    if (b.def.lastResort) return;            // proceeds re-scores via revision, not here
    if (isRatified(b.def.id) || busyLever !== null) return;
    setBusyLever(b.def.id);
    setError(null);
    try {
      const overlayKey = `lever:${b.def.id}`;
      const { overlayId } = await api.createOverlay({
        rootId: data.rootId,
        renderedAnalysisId: data.id,
        overlayKey,
      });
      await api.submitOverrideDecision({
        rootId: data.rootId,
        renderedAnalysisId: data.id,
        overlayId,
      });
      setRatifiedOptimistic((p) => new Set(p).add(b.def.id));
      onWorkflowChanged?.();
    } catch (e) {
      setError((e as Error).message || 'Could not record ratification.');
    } finally {
      setBusyLever(null);
    }
  };

  // ★ Phase B — Approve & close, LIVE for a DETERMINATE loan. Same real write as the
  // pool page (api.closeLoan against the resolved pool identity). The server owns
  // legality (re-derives Cleared); we surface exactly what it returns — success, or
  // the specific 422 NOT_CLEARED / 409 LOAN_ALREADY_DEPARTED reason. NO fake green.
  const onApproveAndClose = async (): Promise<void> => {
    if (resolution === null || !resolution.resolved) return; // never write when ambiguous
    if (closeOutcome.kind === 'closing') return;
    setCloseOutcome({ kind: 'closing' });
    const result = await api.closeLoan(resolution.poolId, resolution.loanInPoolId);
    if (result.ok) {
      setCloseOutcome({ kind: 'closed' });
      onWorkflowChanged?.(); // let the page refetch workflow + timeline
      return;
    }
    setCloseOutcome({ kind: 'blocked', code: result.code, message: result.message });
  };

  // ★ Phase B — reject/withdraw, LIVE for a DETERMINATE loan. Same real write as the
  // pool page (api.dispositionLoan against the resolved pool identity). Actor is
  // stamped server-side. Honest outcomes — success, or the specific 409/422 reason.
  const onDispose = async (input: {
    outcome: DispositionKind;
    reasonCategory: ReasonCategory | null;
    note: string | null;
  }): Promise<void> => {
    if (resolution === null || !resolution.resolved) return; // never write when ambiguous
    if (disposeOutcome.kind === 'submitting') return;
    setDisposeOutcome({ kind: 'submitting' });
    const result = await api.dispositionLoan(resolution.poolId, resolution.loanInPoolId, input);
    if (result.ok) {
      setDisposeOutcome({ kind: 'disposed', outcome: result.disposition.authoritative });
      onWorkflowChanged?.();
      return;
    }
    setDisposeOutcome({ kind: 'blocked', code: result.code, message: result.message });
  };

  return (
    <>
      {/* The error banner sits OUTSIDE both panels so a ratify/comment failure stays
          visible even if the panel that raised it is collapsed. */}
      {error && (
        <div style={{ fontSize: 12, color: C.kicked, background: '#FBECEB', border: `1px solid ${C.kicked}`, borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>{error}</div>
      )}

      {/* ── Red Flags — the contested points lifted into their own titled box so the
           doctrine reads first (flags → structure). Same cards, same per-card expand,
           same comment threads / related-mitigants; the shared state still lives in this
           component, so the flag↔lever wiring below is untouched — only the frame moved. */}
      <CollapsibleSection
        title="Red Flags"
        meta={points.length === 0
          ? 'none open'
          : `${points.length} flag${points.length === 1 ? '' : 's'}${criticalCount > 0 ? ` · ${criticalCount} critical` : ''}`}
        open={flagsOpen}
        onToggle={() => setFlagsOpen((v) => !v)}
      >
        {points.length === 0 ? (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface2, padding: 16, color: C.ink3, fontSize: 14, marginTop: 8 }}>No open flags or findings to contest.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            {points.map((p, i) => {
              const open = expanded.has(p.id);
              const sc = severityColor(p.severity);
              // Mitigants that target this point's rule (RA has no findingId link; group by
              // principleId / rule appearing in the flag code when available, else show all
              // when the point is the single flag). Kept honest: only exact code matches.
              const related = data.mitigations.filter((m) =>
                m.principleIds.some((pid) => p.id.includes(pid)));
              return (
                <div key={p.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface2, overflow: 'hidden' }}>
                  <button onClick={() => toggle(p.id)} style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: sc, borderRadius: 5, padding: '3px 7px', marginTop: 1, flexShrink: 0 }}>{p.severity === 'critical' ? 'Critical' : p.severity === 'warning' ? 'Flagged' : 'Finding'}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>{p.title}</span>
                      <span style={{ display: 'block', fontSize: 12, color: C.ink2, marginTop: 2, lineHeight: 1.4, fontFamily: MONO }}>{p.summary}</span>
                    </span>
                    <span style={{ ...num(C.ink3), fontSize: 12, flexShrink: 0, marginTop: 2 }}>#{String(i + 1).padStart(2, '0')}</span>
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={C.ink3} style={{ flexShrink: 0, marginTop: 3, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {open && (
                    <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ borderLeft: `3px solid ${C.teal}`, background: C.tealSoft, borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.tealDeep, fontWeight: 600, marginBottom: 3 }}>BP Spire — position</div>
                        <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5 }}>Doctrine flagged <span style={{ fontFamily: MONO }}>{p.summary}</span>. Structure must cure or the committee must accept the risk.</div>
                      </div>
                      {related.map((m) => (
                        <div key={m.id} style={{ borderLeft: `3px solid ${C.resolved}`, background: '#F0F6F2', borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                          <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.resolved, fontWeight: 600, marginBottom: 3 }}>Mitigant</div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{m.title}</div>
                          {m.description && <div style={{ fontSize: 12, color: C.ink2, marginTop: 2, lineHeight: 1.4 }}>{m.description}</div>}
                        </div>
                      ))}
                      <CommentThread comments={commentsByPath.get(p.id) ?? []} />
                      {view.canComment ? (
                        <PointComposer
                          path={p.id}
                          side={side}
                          busy={busyComposer === p.id}
                          onPost={(t) => postComment(p.id, t)}
                        />
                      ) : (
                        <div style={{ borderLeft: `3px solid ${C.amber}`, background: C.amberSoft, borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                          <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.amber, fontWeight: 600, marginBottom: 3 }}>Servicer — response</div>
                          <div style={{ fontSize: 13, color: C.ink3, fontStyle: 'italic' }}>Awaiting response — the servicer cannot post yet (no servicer account).</div>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, paddingTop: 2, flexWrap: 'wrap' }}>
                        {view.pointActions.map((label) => (
                          <button key={label} disabled title="Preview — no actions are saved yet"
                            style={{ fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 6, cursor: 'not-allowed', border: `1px solid ${C.border}`, background: C.surface2, color: C.ink3 }}>{label}</button>
                        ))}
                        <button onClick={() => requestCall(p.id)} title="Preview — not sent yet"
                          style={{ fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${C.borderStrong}`, background: callRequests.has(p.id) ? C.tealSoft : C.surface, color: C.ink2 }}>
                          {callRequests.has(p.id) ? 'Call requested — preview' : 'Request a call on this point'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>

      {/* ── Let's Structure This Deal Together — convergence, disposition, and the
           7-lever agreement ledger. The contested points moved up (Red Flags); every
           lever binding / ratify / comment path here is byte-for-byte unchanged — it all
           reads the same shared component state. ─────────────────────────────────────── */}
      <CollapsibleSection title="Let's Structure This Deal Together" open={structureOpen} onToggle={() => setStructureOpen((v) => !v)}>
        {/* Header: side chip + the Deal-Room descriptor (the panel title now leads) +
            request-a-call + role seam. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', margin: '10px 0 6px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 12, color: C.ink3 }}>negotiation view — on the graph surface</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: sideC.accent, background: sideC.soft, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 10px' }}>{sideC.label}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* The old preview "Request a call" is hidden for the originator — they get
                the REAL 7c action below. Buyer/platform keep the preview. */}
            {side !== 'originator' ? (
              <button onClick={() => requestCall('deal')}
                style={{ fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${C.borderStrong}`, background: callRequests.has('deal') ? C.tealSoft : C.surface, color: C.ink2 }}>
                {callRequests.has('deal') ? 'Call requested — preview, not sent' : 'Request a call'}
              </button>
            ) : null}
            <span style={{ fontSize: 12, color: C.ink3 }}>Viewing as</span>
            <div style={{ display: 'inline-flex', border: `1px solid ${C.borderStrong}`, borderRadius: 7, overflow: 'hidden' }}>
              {(['bp_spire', 'originator'] as Role[]).map((r) => {
                const on = role === r; const a = r === 'bp_spire' ? C.teal : C.amber;
                return (
                  <button key={r} onClick={() => setRole(r)}
                    style={{ fontSize: 12, fontWeight: on ? 600 : 500, padding: '6px 14px', border: 'none', cursor: 'pointer', background: on ? a : C.surface, color: on ? '#fff' : C.ink2 }}>
                    {r === 'bp_spire' ? 'BP Spire' : 'Servicer'}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 10, color: C.ink3, marginBottom: 12 }}>Role toggle is a presentation preview, not access control.</div>

        {/* ── Chunk 7c/7d — originator-action status chip. SIDE-AWARE: the originator
             sees the "waiting" framing; the BUYER sees what the originator did (7d — closes
             the loop). SENT_TO_BUYER carries the "awaiting buyer" meaning (a distinct
             AWAITING_BUYER state would be a dead enum member — no buyer-ack event produces
             it, deferred). The full history is in the committee timeline below. ────────── */}
        {(() => {
          const s = workflow?.state;
          if (s !== 'SENT_TO_BUYER' && s !== 'PUSHED_BACK' && s !== 'CALL_REQUESTED') return null;
          const isBuyer = side === 'buyer';
          const icon = s === 'SENT_TO_BUYER' ? '⏳' : s === 'CALL_REQUESTED' ? '📞' : '↩';
          const lead = isBuyer
            ? (s === 'SENT_TO_BUYER' ? 'Originator sent you the updated UW'
              : s === 'CALL_REQUESTED' ? 'Originator requested a call'
              : 'Originator pushed back')
            : (s === 'SENT_TO_BUYER' ? 'Waiting on buyer'
              : s === 'CALL_REQUESTED' ? 'You requested a call'
              : 'You pushed back');
          const tail = isBuyer
            ? (s === 'SENT_TO_BUYER' ? '— the servicer underwriting is with you for review.'
              : s === 'CALL_REQUESTED' ? '— they want to talk this through.'
              : '— they are contesting a requirement and proposing to structure instead.')
            : (s === 'SENT_TO_BUYER' ? '— your servicer underwriting is with the buyer for review.'
              : s === 'CALL_REQUESTED' ? '— awaiting the buyer to schedule.'
              : '— your position is on the buyer’s desk.');
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.tealSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', marginBottom: 12, fontSize: 13, color: C.tealDeep }}>
              <span aria-hidden>{icon}</span>
              <span style={{ fontWeight: 600 }}>{lead}</span>
              <span style={{ color: C.ink3 }}>{tail}</span>
            </div>
          );
        })()}

        {/* ── Convergence (ratified-mitigant COUNT; NOT the score) + derived Cleared ── */}
        <ConvergenceBar
          ratified={ratifiedCount} total={convergenceTotal}
          cleared={derivedCleared} hasFatalFlag={hasFatalFlag} bandOk={bandOk}
          accent={sideC.accent} workflowState={workflow?.state}
        />

        {/* ── DispositionBar — Phase B. LIVE for a DETERMINATE loan (the forward
           resolver turned data.rootId into a single pool identity); an honest
           preview/deep-link when the resolution is ambiguous. Same real writes as
           the pool page (api.closeLoan / api.dispositionLoan). ─────────────────── */}
        <DispositionBar
          resolution={resolution}
          cleared={derivedCleared}
          hasFatalFlag={hasFatalFlag}
          side={side}
          closeOutcome={closeOutcome}
          disposeOutcome={disposeOutcome}
          onApproveAndClose={() => { void onApproveAndClose(); }}
          onDispose={(input) => { void onDispose(input); }}
        />

        {role === 'originator' && (
          <div style={{ background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#6e4a1d' }}>
            You see the buyer&apos;s flags and headline numbers — not the underwriting workbook (held above in the rendered view).
          </div>
        )}

        {/* ── Agreement ledger — the 7 levers, bound to REAL mitigants ──────────── */}
        <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3, margin: '18px 0 8px' }}>
          Agreement ledger <span style={{ textTransform: 'none', letterSpacing: 0, color: C.ink3 }}>— structural levers ratify a mitigant (persisted override); the score stays put</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {leverBindings.map((b) => (
            <LeverRow
              key={b.def.id} binding={b}
              ratified={isRatified(b.def.id)}
              busy={busyLever === b.def.id}
              onRatify={() => { void ratifyLever(b); }}
              canComment={view.canComment}
              accent={sideC.accent}
              side={side}
              comments={commentsByPath.get(`lever:${b.def.id}`) ?? []}
              composerBusy={busyComposer === `lever:${b.def.id}`}
              onPostComment={(t) => postComment(`lever:${b.def.id}`, t)}
            />
          ))}
        </div>

        {/* ── Chunk 7c — the ORIGINATOR's moves (side === 'originator' only; the buyer's
             view of these is 7d, held). Constructive: push back / request a call are
             understated; "Send to buyer" is the meaningful submit (primary). ────────── */}
        {side === 'originator' ? (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>
              Your move <span style={{ textTransform: 'none', letterSpacing: 0, color: C.ink3 }}>— how you want to move this forward with the buyer</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                disabled={busyAction !== null}
                onClick={() => { void postOriginatorAction('pushback', { kind: 'ORIGINATOR_PUSHBACK', reason: 'Contesting the buyer requirement — proposing to structure instead.' }, 'ORIGINATOR_PUSHBACK'); }}
                style={{ fontSize: 13, fontWeight: 500, padding: '7px 14px', borderRadius: 7, cursor: busyAction ? 'not-allowed' : 'pointer', border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.ink2, opacity: busyAction && busyAction !== 'pushback' ? 0.5 : 1 }}>
                {busyAction === 'pushback' ? 'Pushing back…' : 'Push back'}
              </button>
              <button
                disabled={busyAction !== null}
                onClick={() => { void postOriginatorAction('call', { kind: 'CALL_REQUESTED', topic: null }, 'CALL_REQUESTED'); }}
                style={{ fontSize: 13, fontWeight: 500, padding: '7px 14px', borderRadius: 7, cursor: busyAction ? 'not-allowed' : 'pointer', border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.ink2, opacity: busyAction && busyAction !== 'call' ? 0.5 : 1 }}>
                {busyAction === 'call' ? 'Requesting…' : 'Request a call'}
              </button>
              <button
                disabled={busyAction !== null}
                onClick={() => { void postOriginatorAction('send', { kind: 'SEND_TO_BUYER', summary: 'Servicer underwriting submitted to the buyer for review.' }, 'SEND_TO_BUYER'); }}
                style={{ fontSize: 13, fontWeight: 600, padding: '7px 16px', borderRadius: 7, cursor: busyAction ? 'not-allowed' : 'pointer', border: 'none', background: C.teal, color: '#fff', opacity: busyAction && busyAction !== 'send' ? 0.6 : 1 }}>
                {busyAction === 'send' ? 'Sending…' : 'Send to buyer'}
              </button>
            </div>
          </div>
        ) : null}
      </CollapsibleSection>
    </>
  );
}

/* ── Titled, boxed, collapsible section — matches BuyerDiffPanel's calm frame so the
 *    Red Flags + "Let's Structure This Deal Together" panels read as one visual language
 *    (white box, ▾ header, quiet meta). Presentational only — no state of its own. ────── */
function CollapsibleSection({ title, meta, open, onToggle, children }: {
  readonly title: string;
  readonly meta?: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, overflow: 'hidden', marginTop: 12, fontFamily: SANS, color: C.ink }}>
      <button onClick={onToggle} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: C.ink }}>{open ? '▾' : '▸'} {title}</span>
        {meta !== undefined ? <span style={{ fontSize: 13, color: C.ink3 }}>{meta}</span> : null}
      </button>
      {open ? <div style={{ padding: '4px 18px 18px', borderTop: `1px solid ${C.border}` }}>{children}</div> : null}
    </section>
  );
}

/* ── Convergence indicator — ratified-mitigant COUNT (never the score) ── */
function ConvergenceBar({ ratified, total, cleared, hasFatalFlag, bandOk, accent, workflowState }: {
  ratified: number; total: number; cleared: boolean; hasFatalFlag: boolean; bandOk: boolean; accent: string; workflowState?: string;
}) {
  const pct = total > 0 ? Math.round((ratified / total) * 100) : (cleared ? 100 : 0);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>Structural convergence</span>
          <span style={{ ...num(C.ink), fontSize: 15, fontWeight: 700 }}>{ratified}<span style={{ color: C.ink3, fontWeight: 400 }}> of {total}</span></span>
          <span style={{ fontSize: 11, color: C.ink3 }}>mitigants ratified — not the credit score</span>
          {workflowState && <span style={{ fontSize: 10, color: C.ink3, fontFamily: MONO }}>· committee: {workflowState}</span>}
        </div>
        {cleared ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: C.resolved, background: '#F0F6F2', border: `1px solid ${C.resolved}`, borderRadius: 999, padding: '3px 12px' }}>Cleared (derived)</span>
        ) : hasFatalFlag ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: C.kicked, background: '#FBECEB', border: `1px solid ${C.kicked}`, borderRadius: 999, padding: '3px 12px' }}>Disqualifying flag — no structure cures it</span>
        ) : (
          <span style={{ fontSize: 12, fontWeight: 500, color: C.ink3 }}>{!bandOk ? 'Rating below the desk bar' : `${total - ratified} to ratify to clear`}</span>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 3, background: C.border, marginTop: 10, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: cleared ? C.resolved : accent, transition: 'width .25s' }} />
      </div>
      <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 6 }}>
        Cleared ⟺ no open disqualifying flag · rating band better than Decline · every backed structural mitigant ratified (persisted override). Derived read — no status is written.
      </div>
    </div>
  );
}

/* ── DispositionBar (Phase B) — LIVE for a determinate loan, preview when ambiguous.
 *
 * When the forward resolver turned data.rootId into exactly ONE pool loan
 * (resolution.resolved), "Approve & close" writes via api.closeLoan and
 * reject/withdraw writes via api.dispositionLoan — the SAME real writes as the pool
 * page, keyed on the resolved {poolId, loanInPoolId}. reasonCategory is
 * OUTCOME-FILTERED via the contract taxonomy (REASON_CATEGORY_OUTCOME /
 * isReasonCategoryValidForOutcome), identical to the pool-page DispositionBar.
 * Honest outcomes only — the ONLY green is a real close / disposition; every 409/422
 * surfaces the server's specific reason.
 *
 * When the resolution is ambiguous (NONE / MULTIPLE / ROOT_NOT_FOUND — un-pooled or
 * name-less root, or a deal legitimately in >1 pool) the bar STAYS a preview/deep-
 * link EXACTLY as before — no write is attempted; it points at the pool page. It
 * never guesses a target. ── */
function DispositionBar({
  resolution,
  cleared,
  hasFatalFlag,
  side,
  closeOutcome,
  disposeOutcome,
  onApproveAndClose,
  onDispose,
}: {
  resolution: LoanForRootResolution | null;
  cleared: boolean;
  hasFatalFlag: boolean;
  side: Side | null;
  closeOutcome: CloseOutcome;
  disposeOutcome: DisposeOutcome;
  onApproveAndClose: () => void;
  onDispose: (input: { outcome: DispositionKind; reasonCategory: ReasonCategory | null; note: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const accent = sideAccentC(side).accent;

  // Disposition form state (only meaningful in the LIVE determinate path).
  const [chosenOutcome, setChosenOutcome] = useState<DispositionKind>('kicked');
  const [reasonCategory, setReasonCategory] = useState<ReasonCategory | null>(null);
  const [note, setNote] = useState<string>('');

  // Outcome-filtered categories — ONLY those valid for the chosen outcome.
  const validCategories = REASON_CATEGORIES.filter((c) => REASON_CATEGORY_OUTCOME[c] === chosenOutcome);
  const effectiveCategory =
    reasonCategory !== null && isReasonCategoryValidForOutcome(reasonCategory, chosenOutcome) ? reasonCategory : null;
  const onOutcomeChange = (next: DispositionKind) => {
    setChosenOutcome(next);
    if (!isReasonCategoryValidForOutcome(reasonCategory, next)) setReasonCategory(null);
  };

  const resolving = resolution === null;
  const determinate = resolution !== null && resolution.resolved;
  const closing = closeOutcome.kind === 'closing';
  const submitting = disposeOutcome.kind === 'submitting';
  const closed = closeOutcome.kind === 'closed';
  const disposed = disposeOutcome.kind === 'disposed';
  // Once a terminal write has succeeded on either arm the other is spent too.
  const terminalReached = closed || disposed;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface2, padding: '12px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>Outcome</span>
          <span style={{ fontSize: 13, color: C.ink2 }}>
            {hasFatalFlag ? 'A disqualifying flag is raised.' : cleared ? 'Structure cleared — approvable, or still walk.' : 'In negotiation.'}
          </span>
          {resolving ? (
            <span style={{ fontSize: 10, color: C.ink3, fontFamily: MONO }}>· resolving pool identity…</span>
          ) : determinate ? (
            <span style={{ fontSize: 10, color: C.resolved, fontFamily: MONO }}>· live on this loan</span>
          ) : (
            <span style={{ fontSize: 10, color: C.amber, fontFamily: MONO }}>· preview (no unique pool loan)</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {determinate ? (
            // ★ LIVE close — api.closeLoan against the resolved pool identity.
            <button onClick={onApproveAndClose} disabled={closing || terminalReached}
              title="Approve & close — the lifecycle write (api.closeLoan). The server re-derives Cleared; NOT_CLEARED is surfaced honestly."
              style={{ fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.resolved}`, background: closing || terminalReached ? C.surface2 : '#F0F6F2', color: closing || terminalReached ? C.ink3 : C.resolved, cursor: closing || terminalReached ? 'not-allowed' : 'pointer' }}>
              {closing ? 'Closing…' : closed ? 'Closed' : 'Approve & close'}
            </button>
          ) : (
            // Ambiguous — honest deep-link pointer, no write.
            <button disabled title="Approve & close (the lifecycle write) is LIVE on the loan's pool page — /pools/[poolId]/loans/[loanInPoolId]. This root does not resolve to a unique pool loan, so it stays a pointer here."
              style={{ fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.border}`, background: C.surface, color: C.ink3, cursor: 'not-allowed' }}>
              Approve &amp; close (on pool page)
            </button>
          )}
          <button onClick={() => setOpen((o) => !o)}
            style={{ fontSize: 12, fontWeight: 500, padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.ink2, cursor: 'pointer' }}>
            {determinate ? (open ? 'Reject / withdraw ▲' : 'Reject / withdraw') : 'Reject / withdraw (preview)'}
          </button>
        </div>
      </div>

      {/* Honest close-outcome banner — the ONLY green is a real close. */}
      {closeOutcome.kind === 'closed' && (
        <div style={{ fontSize: 12, color: C.resolved, background: '#F0F6F2', border: `1px solid ${C.resolved}`, borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
          Closed — funded to the final tape.
        </div>
      )}
      {closeOutcome.kind === 'blocked' && (
        <div style={{ fontSize: 12, color: C.kicked, background: '#FBECEB', border: `1px solid ${C.kicked}`, borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
          {closeOutcome.code === 'LOAN_ALREADY_DEPARTED'
            ? 'Already departed (rejected / withdrawn) — can’t close.'
            : closeOutcome.code === 'NOT_CLEARED'
              ? `Can’t close — not cleared. ${closeOutcome.message}`
              : `Can’t close (${closeOutcome.code}). ${closeOutcome.message}`}
        </div>
      )}

      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 12 }}>
          {determinate ? (
            // ★ LIVE reject/withdraw form — api.dispositionLoan against the resolved
            // pool identity, outcome-filtered reasonCategory, honest outcomes.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>
                Depart the pool — records a disposition directly (actor stamped server-side)
              </div>

              {/* Outcome selector. */}
              <div>
                <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 6 }}>Outcome</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['kicked', 'dropped'] as const).map((o) => {
                    const on = chosenOutcome === o;
                    return (
                      <button key={o} type="button" disabled={submitting || terminalReached} onClick={() => onOutcomeChange(o)}
                        style={{ fontSize: 12, fontWeight: on ? 600 : 500, padding: '6px 12px', borderRadius: 6, cursor: submitting || terminalReached ? 'not-allowed' : 'pointer', border: `1px solid ${on ? accent : C.border}`, background: on ? sideAccentC(side).soft : C.surface, color: on ? accent : C.ink2 }}>
                        {OUTCOME_LABEL[o]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* reasonCategory — outcome-filtered (only valid parents shown). */}
              <div>
                <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 6 }}>Reason category <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" disabled={submitting || terminalReached} onClick={() => setReasonCategory(null)}
                    style={{ fontSize: 12, fontWeight: effectiveCategory === null ? 600 : 500, padding: '6px 12px', borderRadius: 6, cursor: submitting || terminalReached ? 'not-allowed' : 'pointer', border: `1px solid ${effectiveCategory === null ? accent : C.border}`, background: effectiveCategory === null ? sideAccentC(side).soft : C.surface, color: effectiveCategory === null ? accent : C.ink2 }}>
                    Unspecified
                  </button>
                  {validCategories.map((c) => {
                    const on = effectiveCategory === c;
                    return (
                      <button key={c} type="button" disabled={submitting || terminalReached} onClick={() => setReasonCategory(c)}
                        style={{ fontSize: 12, fontWeight: on ? 600 : 500, padding: '6px 12px', borderRadius: 6, cursor: submitting || terminalReached ? 'not-allowed' : 'pointer', border: `1px solid ${on ? accent : C.border}`, background: on ? sideAccentC(side).soft : C.surface, color: on ? accent : C.ink2 }}>
                        {REASON_CATEGORY_LABEL[c]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Optional note. */}
              <div>
                <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 6 }}>Note <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>
                <textarea value={note} disabled={submitting || terminalReached} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder="Free-form context for this departure…"
                  style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, resize: 'vertical', fontFamily: SANS }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" disabled={submitting || terminalReached}
                  onClick={() => onDispose({ outcome: chosenOutcome, reasonCategory: effectiveCategory, note: note.trim() === '' ? null : note.trim() })}
                  style={{ fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.kicked}`, background: submitting || terminalReached ? C.surface2 : '#FBECEB', color: submitting || terminalReached ? C.ink3 : C.kicked, cursor: submitting || terminalReached ? 'not-allowed' : 'pointer' }}>
                  {submitting ? 'Recording…' : chosenOutcome === 'kicked' ? 'Reject loan' : 'Withdraw loan'}
                </button>
                <span style={{ fontSize: 10.5, color: C.ink3 }}>Records a buyer-authoritative disposition — the SAME write as the pool page.</span>
              </div>

              {/* Honest disposition-outcome banner. Success is the ONLY green. */}
              {disposeOutcome.kind === 'disposed' && (
                <div style={{ fontSize: 12, color: C.resolved, background: '#F0F6F2', border: `1px solid ${C.resolved}`, borderRadius: 8, padding: '8px 12px' }}>
                  {disposeOutcome.outcome === 'kicked' ? 'Rejected — kicked from the tape.' : 'Withdrawn — dropped.'}
                </div>
              )}
              {disposeOutcome.kind === 'blocked' && (
                <div style={{ fontSize: 12, color: C.kicked, background: '#FBECEB', border: `1px solid ${C.kicked}`, borderRadius: 8, padding: '8px 12px' }}>
                  {disposeOutcome.code === 'LOAN_ALREADY_CLOSED'
                    ? 'Can’t reject — loan already closed.'
                    : disposeOutcome.code === 'LOAN_ALREADY_DISPOSED'
                      ? 'Already disposed.'
                      : disposeOutcome.code === 'NO_CURRENT_TAPE'
                        ? 'No current tape to depart from.'
                        : `Couldn’t record disposition (${disposeOutcome.code}). ${disposeOutcome.message}`}
                </div>
              )}
            </div>
          ) : (
            // Ambiguous — the honest preview taxonomy + deep-link pointer, unchanged.
            <>
              <div style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>Why didn&apos;t it close? — preview taxonomy, nothing is written here</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                {REASON_CATEGORIES.map((c) => (
                  <div key={c} style={{ border: `1px solid ${C.border}`, borderRadius: 9, background: C.surface, padding: '10px 12px' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>{REASON_CATEGORY_LABEL[c]}</div>
                    <div style={{ fontSize: 11.5, color: C.ink3, marginTop: 2 }}>{OUTCOME_LABEL[REASON_CATEGORY_OUTCOME[c]]}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 8 }}>
                This root does not resolve to a unique pool loan{resolution !== null && !resolution.resolved ? ` (${resolution.reason.toLowerCase().replace(/_/g, ' ')})` : ''} — resolve on the pool page (<code>/pools/[poolId]/loans/[loanInPoolId]</code>). Existing disposition data is untouched.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── LeverRow — one lever, bound to its REAL mitigant (or "not modeled"). ── */
function LeverRow({ binding, ratified, busy, onRatify, canComment, accent, side, comments, composerBusy, onPostComment }: {
  binding: LeverBinding; ratified: boolean; busy: boolean; onRatify: () => void; canComment: boolean; accent: string;
  side: Side | null; comments: readonly OverlayCommentView[]; composerBusy: boolean; onPostComment: (text: string) => Promise<boolean>;
}) {
  const { def, mitigant } = binding;
  const notModeled = !mitigant && !def.lastResort;
  const isProceeds = !!def.lastResort;
  const done = ratified && !isProceeds;
  const border = done ? C.resolved : notModeled ? C.border : C.borderStrong;
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 11, background: done ? '#F5FAF7' : C.surface, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: C.ink }}>{def.name}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {isProceeds && <span style={{ fontSize: 10, fontWeight: 600, color: C.amber }}>re-scores — run via revision</span>}
          {notModeled && <span style={{ fontSize: 10, fontWeight: 600, color: C.ink3, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 5, padding: '2px 7px' }}>not modeled</span>}
          {done && <span style={{ fontSize: 11, fontWeight: 600, color: C.resolved }}>✓ agreed</span>}
        </div>
      </div>

      <div style={{ fontSize: 10.5, color: done ? C.resolved : notModeled ? C.ink3 : C.flagged, marginTop: 4 }}>
        {mitigant
          ? (done ? `ratified: ${mitigant.title}` : `open mitigant: ${mitigant.title}`)
          : isProceeds
            ? 'economic lever — only reduce_proceeds actually re-runs the doctrine score'
            : 'no matching mitigant produced by the engine for this deal'}
      </div>

      {!done && !notModeled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, margin: '10px 0' }}>
            <LeverPosition accent={C.amber} who="Originator proposes" term={def.orig} />
            <LeverPosition accent={accent} who="Buyer requires" term={mitigant?.title ?? def.buyer} why={def.buyerWhy} />
          </div>
          {mitigant && mitigant.structuralChanges.length > 0 && (
            <ul style={{ margin: '0 0 10px', paddingLeft: 16 }}>
              {mitigant.structuralChanges.map((sc, i) => <li key={i} style={{ fontSize: 12, color: C.ink2, lineHeight: 1.4 }}>{sc}</li>)}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isProceeds ? (
              <button disabled title="reduce_proceeds re-runs the deal — create a revision (Edit Underwriting above); not written from the deal room"
                style={{ fontSize: 12, fontWeight: 600, padding: '7px 13px', borderRadius: 7, border: `1px solid ${C.amber}`, background: C.amberSoft, color: C.amber, cursor: 'not-allowed' }}>
                Reduce proceeds — re-scores (last resort)
              </button>
            ) : (
              <button onClick={onRatify} disabled={busy}
                style={{ fontSize: 12, fontWeight: 600, padding: '7px 13px', borderRadius: 7, border: 'none', background: busy ? C.border : accent, color: '#fff', cursor: busy ? 'default' : 'pointer' }}>
                {busy ? 'Recording override…' : 'Agree structure — records a persisted override (score holds)'}
              </button>
            )}
          </div>
        </>
      )}
      {done && (
        <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 8 }}>
          {mitigant?.title ?? def.buyer}<span style={{ color: C.ink3 }}> — ratified via committee override; the doctrine score is unchanged.</span>
        </div>
      )}
      {notModeled && (
        <div style={{ fontSize: 12, color: C.ink3, fontStyle: 'italic', marginTop: 6 }}>
          The engine produced no mitigant for this lever on this deal — shown honestly rather than faking agreement. Buyer ask: {def.buyer}.
        </div>
      )}

      {comments.length > 0 && (
        <div style={{ marginTop: 10 }}><CommentThread comments={comments} /></div>
      )}
      {canComment && !done && !notModeled ? (
        <div style={{ marginTop: 10 }}>
          <PointComposer path={`lever:${def.id}`} side={side} busy={composerBusy} onPost={onPostComment} />
        </div>
      ) : null}
    </div>
  );
}
function LeverPosition({ accent, who, term, why }: { accent: string; who: string; term: string; why?: string }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderLeft: `3px solid ${accent}`, borderRadius: 8, background: C.surface2, padding: '9px 11px' }}>
      <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: accent, fontWeight: 600 }}>{who}</div>
      <div style={{ fontSize: 12.5, color: C.ink, marginTop: 3 }}>{term}</div>
      {why && <div style={{ fontSize: 11.5, color: C.ink3, marginTop: 2 }}>{why}</div>}
    </div>
  );
}

/**
 * CommentThread — READ-BACK of posted graph-native comment patches for one "re:" path.
 * Each posted comment is side-tagged with the P1 tokens (ochre = originator, steel =
 * buyer), shows its "re:" path, author, and text. Empty threads render nothing.
 */
function CommentThread({ comments }: { comments: readonly OverlayCommentView[] }) {
  if (comments.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {comments.map((c) => {
        const tag = commentSideTag(c.side);
        return (
          <div key={c.patchId} style={{ border: `1px solid ${C.border}`, borderLeft: `3px solid ${tag.accent}`, background: tag.soft, borderRadius: '0 8px 8px 0', padding: '9px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: tag.accent, borderRadius: 5, padding: '2px 7px' }}>{tag.label}</span>
              <span style={{ fontSize: 11, color: C.ink3, fontFamily: MONO }}>re: {c.path}</span>
              <span style={{ fontSize: 11, color: C.ink3, marginLeft: 'auto' }}>{c.author}</span>
            </div>
            <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.text}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Comment composer — LIVE (converge phase i+). Posts a graph-native `comment-added`
 * overlay patch carrying the "re:" path + the viewer's ?side. The overlay anchor is
 * minted (or fetched) per path by the parent's postComment. The legacy per-point
 * transport (api.addComment, keyed on the uuid analysis id) is retired here.
 */
function PointComposer({ path, side, busy, onPost }: {
  path: string; side: Side | null; busy: boolean; onPost: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const tag = commentSideTag(side);
  const submit = async () => {
    const ok = await onPost(text);
    if (ok) setText('');
  };
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.tealDeep, fontWeight: 600 }}>Add to thread</span>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: tag.accent, borderRadius: 5, padding: '2px 7px' }}>{tag.label}</span>
        <span style={{ fontSize: 11, color: C.ink3, fontFamily: MONO }}>re: {path}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment lands on the overlay patch (graph-native, side-tagged)…" rows={2}
          style={{ flex: 1, fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, resize: 'vertical', fontFamily: SANS }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 10, color: C.ink3 }}>Posts a persisted comment-added overlay patch (hash-excluded side).</span>
        <button onClick={() => { void submit(); }} disabled={busy || text.trim().length === 0}
          title="Post a graph-native comment patch onto this point/lever"
          style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: busy || text.trim().length === 0 ? 'not-allowed' : 'pointer', background: busy || text.trim().length === 0 ? C.border : tag.accent, color: '#fff' }}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}

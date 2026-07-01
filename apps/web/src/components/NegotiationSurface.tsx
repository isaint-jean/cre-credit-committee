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
 *   - the per-point / per-lever comment composer (preview — see note below)
 *
 * ★ REAL OVERRIDE (net-new vs DealRoom's session Set):
 *   lever "agree" → api.createOverlay (mints/fetches the deterministic overlay-created
 *   anchor per lever) → api.submitOverrideDecision (persisted OVERRIDE_DECISION on the
 *   committee ledger). The ratified state is a DERIVED READ of the persisted timeline,
 *   not a session Set. Each lever gets a stable overlayId (overlayKey = `lever:<id>`),
 *   so a persisted OVERRIDE whose summary carries that overlayId = that lever ratified.
 *
 * ★ BANKED as legacy-only parity follow-up (NOT ported — they don't exist on
 *   RenderedAnalysis): the DealRoom workspace-drawer tabs criteriaEvaluations /
 *   crossCheckFindings / research / bPieceDecision, and the legacy per-point comment
 *   TRANSPORT (`api.addComment`, which keys on the uuid analysis id). The composer UI
 *   ports as an honest disabled preview; the graph-native target is a `comment-added`
 *   overlay patch (deferred). RA's own sections (stress / handbook / doctrine / score /
 *   findings / mitigants / narrative) stay in RenderedAnalysisView, untouched.
 */

import React, { useEffect, useState } from 'react';
import type {
  CommitteeTimeline,
  DealWorkflowState,
  DoctrineEvaluationId,
  RenderedAnalysis,
  RenderedMitigationProposal,
  RenderBadgeSeverity,
} from '@cre/contracts';
import { api } from '@/lib/api-client';
import { useSide, type Side } from '@/lib/side-context';

type Role = 'bp_spire' | 'originator';

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
  if (side === 'originator') return { accent: C.amber, soft: C.amberSoft, label: 'Originator' };
  if (side === 'buyer') return { accent: C.contested, soft: '#EAF0F8', label: 'B-piece buyer' };
  return { accent: C.teal, soft: C.tealSoft, label: 'Platform' };
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
  return { label: 'Originator', accent: C.amber, canComment: false, pointActions: ['Provide evidence'] };
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

export function NegotiationSurface({ data, workflow, timeline, onWorkflowChanged }: Props): React.ReactElement {
  const side = useSide();
  const [role, setRole] = useState<Role>('bp_spire');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyLever, setBusyLever] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callRequests, setCallRequests] = useState<Set<string>>(new Set());
  // Ratified levers, seeded from persisted timeline + optimistically extended on agree
  // (the page refetch collapses the optimistic set back into the derived read).
  const [ratifiedOptimistic, setRatifiedOptimistic] = useState<Set<string>>(new Set());

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

  return (
    <section style={{ background: C.bg, color: C.ink, fontFamily: SANS, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginTop: 8 }}>
      {/* ── Header: role seam + side chip ────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.teal }}>Deal Room</span>
          <span style={{ fontSize: 12, color: C.ink3 }}>negotiation view — on the graph surface</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: sideC.accent, background: sideC.soft, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 10px' }}>{sideC.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => requestCall('deal')}
            style={{ fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${C.borderStrong}`, background: callRequests.has('deal') ? C.tealSoft : C.surface, color: C.ink2 }}>
            {callRequests.has('deal') ? 'Call requested — preview, not sent' : 'Request a call'}
          </button>
          <span style={{ fontSize: 12, color: C.ink3 }}>Viewing as</span>
          <div style={{ display: 'inline-flex', border: `1px solid ${C.borderStrong}`, borderRadius: 7, overflow: 'hidden' }}>
            {(['bp_spire', 'originator'] as Role[]).map((r) => {
              const on = role === r; const a = r === 'bp_spire' ? C.teal : C.amber;
              return (
                <button key={r} onClick={() => setRole(r)}
                  style={{ fontSize: 12, fontWeight: on ? 600 : 500, padding: '6px 14px', border: 'none', cursor: 'pointer', background: on ? a : C.surface, color: on ? '#fff' : C.ink2 }}>
                  {r === 'bp_spire' ? 'BP Spire' : 'Originator'}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right', fontSize: 10, color: C.ink3, marginBottom: 12 }}>Role toggle is a presentation preview, not access control.</div>

      {error && (
        <div style={{ fontSize: 12, color: C.kicked, background: '#FBECEB', border: `1px solid ${C.kicked}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>{error}</div>
      )}

      {/* ── Convergence (ratified-mitigant COUNT; NOT the score) + derived Cleared ── */}
      <ConvergenceBar
        ratified={ratifiedCount} total={convergenceTotal}
        cleared={derivedCleared} hasFatalFlag={hasFatalFlag} bandOk={bandOk}
        accent={sideC.accent} workflowState={workflow?.state}
      />

      {/* ── DispositionBar — LABELED PREVIEW (no write; taxonomy is phase ii) ──── */}
      <DispositionBarPreview cleared={derivedCleared} hasFatalFlag={hasFatalFlag} />

      {role === 'originator' && (
        <div style={{ background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#6e4a1d' }}>
          You see the buyer&apos;s flags and headline numbers — not the underwriting workbook (held above in the rendered view).
        </div>
      )}

      {/* ── Contested-point cards (doctrine flags + findings) ─────────────────── */}
      <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>Contested points</div>
      {points.length === 0 ? (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, padding: 16, color: C.ink3, fontSize: 14 }}>No open flags or findings to contest.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {points.map((p, i) => {
            const open = expanded.has(p.id);
            const sc = severityColor(p.severity);
            // Mitigants that target this point's rule (RA has no findingId link; group by
            // principleId / rule appearing in the flag code when available, else show all
            // when the point is the single flag). Kept honest: only exact code matches.
            const related = data.mitigations.filter((m) =>
              m.principleIds.some((pid) => p.id.includes(pid)));
            return (
              <div key={p.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, overflow: 'hidden' }}>
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
                    {view.canComment ? (
                      <PointComposerPreview />
                    ) : (
                      <div style={{ borderLeft: `3px solid ${C.amber}`, background: C.amberSoft, borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.amber, fontWeight: 600, marginBottom: 3 }}>Originator — response</div>
                        <div style={{ fontSize: 13, color: C.ink3, fontStyle: 'italic' }}>Awaiting response — the originator cannot post yet (no originator account).</div>
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
          />
        ))}
      </div>
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

/* ── DispositionBar — LABELED PREVIEW. 4 reason categories; write is phase ii. ── */
const DISPOSITION_REASONS: readonly { id: string; label: string; hint: string }[] = [
  { id: 'disqualifying', label: 'Disqualifying', hint: 'Sponsor character / fatal credit' },
  { id: 'couldnt_structure', label: "Couldn't structure", hint: "Economics won't pencil even maxing levers" },
  { id: 'expired', label: 'Expired', hint: 'Missed the pool cutoff / ran out of time' },
  { id: 'withdrawn', label: 'Withdrawn', hint: 'Borrower took a competing term sheet' },
];
function DispositionBarPreview({ cleared, hasFatalFlag }: { cleared: boolean; hasFatalFlag: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface2, padding: '12px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>Outcome</span>
          <span style={{ fontSize: 13, color: C.ink2 }}>
            {hasFatalFlag ? 'A disqualifying flag is raised.' : cleared ? 'Structure cleared — approvable, or still walk.' : 'In negotiation.'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled title="Preview — Closed status is phase ii (needs the disposition write path)"
            style={{ fontSize: 12, fontWeight: 600, padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.border}`, background: C.surface, color: C.ink3, cursor: 'not-allowed' }}>
            Approve &amp; close (preview)
          </button>
          <button onClick={() => setOpen((o) => !o)}
            style={{ fontSize: 12, fontWeight: 500, padding: '7px 14px', borderRadius: 7, border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.ink2, cursor: 'pointer' }}>
            Reject / withdraw (preview)
          </button>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 12 }}>
          <div style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>Why didn&apos;t it close? — preview taxonomy, nothing is written</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
            {DISPOSITION_REASONS.map((r) => (
              <div key={r.id} style={{ border: `1px solid ${C.border}`, borderRadius: 9, background: C.surface, padding: '10px 12px' }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink }}>{r.label}</div>
                <div style={{ fontSize: 11.5, color: C.ink3, marginTop: 2 }}>{r.hint}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 8 }}>
            The <code>reasonCategory</code> write + disposition record are phase ii (ride the existing pool Disposition taxonomy). Existing disposition data is untouched.
          </div>
        </div>
      )}
    </div>
  );
}

/* ── LeverRow — one lever, bound to its REAL mitigant (or "not modeled"). ── */
function LeverRow({ binding, ratified, busy, onRatify, canComment, accent }: {
  binding: LeverBinding; ratified: boolean; busy: boolean; onRatify: () => void; canComment: boolean; accent: string;
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

      {canComment && !done && !notModeled ? (
        <div style={{ marginTop: 10 }}><PointComposerPreview /></div>
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
 * Comment composer — ported UI, HONEST PREVIEW. The legacy per-point comment transport
 * (api.addComment) keys on the uuid analysis id and writes to legacy Analysis.comments,
 * which the graph surface deliberately does not depend on. The graph-native target is a
 * `comment-added` overlay patch (banked as a phase-i+ follow-up). Rendered disabled so
 * the interaction is visible without a misleading write.
 */
function PointComposerPreview() {
  const [text, setText] = useState('');
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: 10 }}>
      <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.tealDeep, fontWeight: 600, marginBottom: 6 }}>Add to thread — BP Spire (preview)</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <select disabled style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink3 }}>
          <option>Note</option>
        </select>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment thread lands on the overlay patch (graph-native transport — follow-up)…" rows={2}
          style={{ flex: 1, fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, resize: 'vertical', fontFamily: SANS }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 10, color: C.ink3 }}>Preview — graph-native comment-added overlay patch is a follow-up.</span>
        <button disabled title="Comment transport migrates to the overlay patch (graph-native); not wired in phase i"
          style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'not-allowed', background: C.border, color: '#fff' }}>Post</button>
      </div>
    </div>
  );
}

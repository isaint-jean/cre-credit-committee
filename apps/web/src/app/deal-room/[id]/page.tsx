'use client';

/**
 * Deal Room — a negotiation-shaped view over a REAL analysis.
 *
 * PRESENTATION: faithful to the deal-room wireframe — a LIGHT theme with explicit
 * palette values scoped to this page (the app's global theme is dark; the root is an
 * explicit light container so nothing bleeds through).
 *
 * PASS 2 — the negotiation surface:
 *   - Memo is a SHARED download (both rails); the workbook stays BUYER-ONLY.
 *   - "Request a call" — per-point + deal-level escape hatch (visual/local-only today).
 *   - Per-point comment threads reuse the EXISTING comment system (addComment +
 *     analysis.comments grouped by findingId). The buyer can post; the originator side
 *     stays honest "awaiting" until a real originator user exists.
 *
 * ★ HONESTY CAVEATS (unchanged):
 *  - The ROLE TOGGLE is a PRESENTATION PREVIEW, not access control. The role boundary
 *    is a SINGLE 3-tier seam (`roleView().access`) future server authz plugs into.
 *  - POINTS COME FROM REAL DATA. No negotiation has happened, so points are 'flagged',
 *    the originator half is "awaiting", impact is "not yet computed". No fabrication —
 *    originator messages are never invented.
 */
import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import { formatCurrencyFull, formatDecimalPercent, formatMultipleSafe } from '@/lib/format';
import type { Analysis, Finding, Comment } from '@cre/shared';

type Role = 'bp_spire' | 'originator';

// ── Wireframe palette (explicit; scoped to this page) ──────────────────────────
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

interface ContestedPoint {
  readonly id: string;            // = finding.id (comments key on this)
  readonly title: string;
  readonly summary: string;
  readonly buyerPosition: string;
  readonly severity: string;
}

const oneLine = (s: string, max = 130): string => {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
function splitFinding(f: Finding): { title: string; summary: string } {
  const full = (f.title || '').trim();
  const ci = full.indexOf(':');
  if (ci > 10 && ci < 90) return { title: full.slice(0, ci).trim(), summary: oneLine(full.slice(ci + 1)) };
  return { title: oneLine(full, 72), summary: oneLine(f.explanation || '') };
}
function deriveContestedPoints(findings: ReadonlyArray<Finding>): ContestedPoint[] {
  return findings.map((f) => {
    const { title, summary } = splitFinding(f);
    return { id: f.id, title, summary, buyerPosition: f.explanation, severity: String(f.severity) };
  });
}

/** ★ THE SINGLE ROLE SEAM — a 3-tier access object future server authz plugs into.
 *  workbook: buyer-only (the one private artifact) · memo: shared · points: shared. */
function roleView(role: Role) {
  const access = {
    workbook: role === 'bp_spire' ? ('buyer-only' as const) : ('hidden' as const),
    memo: 'shared' as const,
    points: 'shared' as const,
  };
  if (role === 'bp_spire') {
    return { label: 'BP Spire', accent: C.teal, railTitle: 'Your underwriting', access, canComment: true, pointActions: ['Respond', 'Resolve', 'Kick back'] };
  }
  return { label: 'Originator', accent: C.amber, railTitle: 'Credit memo', access, canComment: false, pointActions: ['Provide evidence'] };
}

export default function DealRoom() {
  const { id } = useParams<{ id: string }>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState<Role>('bp_spire');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [callRequests, setCallRequests] = useState<Set<string>>(new Set()); // local-only (preview)
  const [localFlags, setLocalFlags] = useState<Array<{ id: string; title: string; rationale: string; addedBy: string }>>([]); // local-only (preview; clears on refresh)

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await api.getAnalysis(id);
        if (!alive) return;
        setLoading(false);
        if (response.kind === 'legacy') setAnalysis(response.body.analysis as Analysis);
        else setUnsupported(true);
      } catch {
        if (alive) { setLoading(false); setError('Could not load this deal.'); }
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const refetch = async () => {
    const r = await api.getAnalysis(id);
    if (r.kind === 'legacy') setAnalysis(r.body.analysis as Analysis);
  };
  const postComment = async (findingId: string, stance: string, text: string) => {
    await api.addComment(id, { sectionId: 'deal-room', findingId, stance, text });
    await refetch();
  };
  const requestCall = (key: string) => setCallRequests((p) => new Set(p).add(key)); // local/visual only

  const shell = (inner: React.ReactNode) => (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: SANS }}>{inner}</div>
  );
  if (loading) return shell(<div style={{ padding: 80, textAlign: 'center', color: C.ink3, fontSize: 13 }}>Loading deal room…</div>);
  if (error || unsupported) return shell(
    <div style={{ padding: 80, textAlign: 'center' }}>
      <div style={{ color: C.ink2, fontSize: 13 }}>{error || 'Deal room is available for classic analyses.'}</div>
      {unsupported && <div style={{ color: C.ink3, fontSize: 12, marginTop: 4 }}>This analysis uses the graph-rendered format.</div>}
    </div>
  );
  if (!analysis) return null;

  const view = roleView(role);
  const findings = analysis.findings ?? [];
  const points = deriveContestedPoints(findings);
  const comments = analysis.comments ?? [];
  const score = analysis.creditScore;
  const uw = analysis.uwModel;
  const loan = uw?.loanAmount ?? null;
  const uwNoi = uw && loan != null && uw.debtYield != null ? uw.debtYield * loan : null;
  const value = uw && loan != null && uw.ltv ? loan / uw.ltv : null;

  const toggle = (pid: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });

  const MemoButton = ({ accent }: { accent: string }) => (
    <button onClick={() => api.downloadMemo(analysis.id, `${analysis.name} — Credit Committee Memo.html`)}
      style={{ width: '100%', fontSize: 13, fontWeight: 600, padding: '8px 0', borderRadius: 7, cursor: 'pointer',
        background: C.surface, color: accent, border: `1px solid ${accent}` }}>
      Download memo
    </button>
  );

  return shell(
    <>
      {/* ── 1. Header ─────────────────────────────────────────── */}
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: '14px 24px' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: C.teal }}>Deal Room</span>
            <span style={{ fontSize: 12, color: C.ink3 }}>negotiation view</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Deal-level Request a call (either role; visual/local-only) */}
            <button onClick={() => requestCall('deal')}
              style={{ fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
                border: `1px solid ${C.borderStrong}`, background: callRequests.has('deal') ? C.tealSoft : C.surface, color: C.ink2 }}>
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
        <div style={{ maxWidth: 1180, margin: '2px auto 0', textAlign: 'right', fontSize: 10, color: C.ink3 }}>Preview — presentation only, not access control</div>
      </header>

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 24px' }}>
        {/* ── 2. Deal bar ─────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: C.ink, margin: 0 }}>{analysis.name}</h1>
            <div style={{ fontSize: 13, color: C.ink2, marginTop: 3 }}>
              <span style={{ textTransform: 'capitalize' }}>{analysis.assetType}</span>
              {' · '}<span style={num(C.ink2)}>{loan != null ? formatCurrencyFull(loan) : '—'}</span>
              {' · '}<span style={num(C.ink3)}>#{analysis.id.slice(0, 8)}</span>
            </div>
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.flagged, background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderRadius: 999, padding: '4px 12px' }}>In review</span>
        </div>

        {/* ── 3. Tally strip ──────────────────────────────────── */}
        <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, marginBottom: 18, overflow: 'hidden' }}>
          {([['Flagged', points.length, C.flagged], ['Contested', 0, C.contested], ['Resolved', 0, C.resolved], ['Conceded', 0, C.conceded]] as const).map(([label, n, sw], i) => (
            <div key={label} style={{ flex: 1, padding: '12px 16px', borderRight: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: sw, display: 'inline-block' }} />
                <span style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>{label}</span>
              </div>
              <div style={{ ...num(i === 0 ? C.flagged : C.ink), fontSize: 24, fontWeight: 700, marginTop: 2 }}>{n}</div>
            </div>
          ))}
          <div style={{ flex: 1.6, padding: '12px 16px', background: C.surface2 }}>
            <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>Implied terms impact</div>
            <div style={{ fontSize: 14, color: C.ink3, fontStyle: 'italic', marginTop: 6 }}>not yet computed</div>
          </div>
        </div>

        {/* ── Originator banner (originator view only) ─────────── */}
        {role === 'originator' && (
          <div style={{ background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#6e4a1d' }}>
            You see the buyer&apos;s flags and headline numbers — not the underwriting workbook.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>
          {/* ── 4. Contested-point cards ──────────────────────── */}
          <main>
            <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>Contested points</div>
            {points.length === 0 ? (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, padding: 16, color: C.ink3, fontSize: 14 }}>No findings to contest.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {points.map((p, i) => {
                  const open = expanded.has(p.id);
                  const thread = comments.filter((c) => c.findingId === p.id);
                  return (
                    <div key={p.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, overflow: 'hidden' }}>
                      <button onClick={() => toggle(p.id)} style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: C.flagged, borderRadius: 5, padding: '3px 7px', marginTop: 1, flexShrink: 0 }}>Flagged</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>{p.title}</span>
                          <span style={{ display: 'block', fontSize: 12, color: C.ink2, marginTop: 2, lineHeight: 1.4 }}>{p.summary}</span>
                        </span>
                        {thread.length > 0 && <span style={{ ...num(C.teal), fontSize: 11, flexShrink: 0, marginTop: 2 }}>{thread.length} 💬</span>}
                        <span style={{ ...num(C.ink3), fontSize: 12, flexShrink: 0, marginTop: 2 }}>#{String(i + 1).padStart(2, '0')}</span>
                        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={C.ink3} style={{ flexShrink: 0, marginTop: 3, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {open && (
                        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {/* BUYER stance — the real finding rationale */}
                          <div style={{ borderLeft: `3px solid ${C.teal}`, background: C.tealSoft, borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                            <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.tealDeep, fontWeight: 600, marginBottom: 3 }}>BP Spire — position</div>
                            <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5 }}>{p.buyerPosition}</div>
                          </div>

                          {/* Comment thread — existing comments grouped by findingId */}
                          {thread.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {thread.map((c: Comment) => (
                                <div key={c.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: '8px 10px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#fff', borderRadius: 4, padding: '1px 6px',
                                      background: c.stance === 'agree' ? C.resolved : c.stance === 'disagree' ? C.kicked : C.conceded }}>{c.stance}</span>
                                    <span style={{ fontSize: 11, color: C.ink2 }}>{c.author}</span>
                                    <span style={{ ...num(C.ink3), fontSize: 10, marginLeft: 'auto' }}>{new Date(c.createdAt).toLocaleDateString()}</span>
                                  </div>
                                  <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.45 }}>{c.text}</div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* ORIGINATOR stance — honest "awaiting" until a real originator user exists */}
                          {view.canComment ? (
                            <PointComposer onPost={(stance, text) => postComment(p.id, stance, text)} />
                          ) : (
                            <div style={{ borderLeft: `3px solid ${C.amber}`, background: C.amberSoft, borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                              <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.amber, fontWeight: 600, marginBottom: 3 }}>Originator — response</div>
                              <div style={{ fontSize: 13, color: C.ink3, fontStyle: 'italic' }}>Awaiting response — the originator cannot post yet (no originator account).</div>
                            </div>
                          )}

                          {/* Action layer: role actions (local) + Request a call (per-point) */}
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

            {/* User-added flags — local/preview, visually DISTINCT from engine flags */}
            {localFlags.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                {localFlags.map((lf) => (
                  <div key={lf.id} style={{ border: `1px dashed ${C.contested}`, borderRadius: 10, background: C.surface, padding: 14, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fff', background: C.contested, borderRadius: 5, padding: '3px 7px', marginTop: 1, flexShrink: 0 }}>Added</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>{lf.title}</span>
                      {lf.rationale && <span style={{ display: 'block', fontSize: 12, color: C.ink2, marginTop: 2, lineHeight: 1.4 }}>{lf.rationale}</span>}
                      <span style={{ display: 'block', fontSize: 11, color: C.contested, fontStyle: 'italic', marginTop: 4 }}>added by {lf.addedBy} — preview, not saved yet</span>
                    </span>
                    <button onClick={() => setLocalFlags((p) => p.filter((x) => x.id !== lf.id))} title="Remove (local)"
                      style={{ fontSize: 13, color: C.ink3, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Add a flag — both roles; local/preview only */}
            <AddFlagComposer onAdd={(title, rationale) =>
              setLocalFlags((p) => [...p, { id: crypto.randomUUID(), title, rationale, addedBy: view.label }])} />
          </main>

          {/* ── 5. Right rail (sticky) ────────────────────────── */}
          <aside style={{ position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3, marginBottom: 12 }}>{view.railTitle}</div>
              {score && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                  <div style={{ width: 84, height: 84, borderRadius: '50%', flexShrink: 0, background: `conic-gradient(${view.accent} ${score.overall ?? 0}%, ${C.border} ${score.overall ?? 0}% 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 64, height: 64, borderRadius: '50%', background: C.surface, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ ...num(C.ink), fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{score.overall}</span>
                      <span style={{ fontSize: 9, color: C.ink3 }}>/ 100</span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, textTransform: 'capitalize' }}>{score.riskTier?.replace('_', ' ')}</div>
                    <div style={{ fontSize: 12, color: C.ink3, textTransform: 'capitalize' }}>{score.recommendation?.replace(/_/g, ' ')}</div>
                  </div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                <Metric label="DSCR" value={uw ? formatMultipleSafe(uw.dscr) : '—'} />
                <Metric label="Debt yield" value={uw ? formatDecimalPercent(uw.debtYield) : '—'} />
                <Metric label="Value" value={value != null ? formatCurrencyFull(value) : '—'} />
                <Metric label="UW NOI" value={uwNoi != null ? formatCurrencyFull(uwNoi) : '—'} />
              </div>

              {/* Artifacts — memo SHARED (both rails); workbook BUYER-ONLY */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {view.access.workbook === 'buyer-only' ? (
                  <button onClick={() => api.downloadPopulatedTemplate(analysis.id, `${analysis.name}_Workbook.xlsx`)}
                    style={{ width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 0', borderRadius: 7, border: 'none', cursor: 'pointer', background: C.teal, color: '#fff' }}>
                    Open full workbook
                  </button>
                ) : null}
                <MemoButton accent={view.accent} />
              </div>
              <div style={{ fontSize: 11, color: C.ink3, marginTop: 8 }}>
                {view.access.workbook === 'buyer-only'
                  ? 'The underwriting workbook is private to BP Spire. The memo is shared.'
                  : 'The underwriting workbook is held by the buyer. The memo is shared.'}
              </div>
            </div>

            {/* ORIGINATOR rail: what's being asked of them */}
            {role === 'originator' && points.length > 0 && (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: 16 }}>
                <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 8 }}>What you need to provide</div>
                <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {points.map((p) => <li key={p.id} style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.4 }}>{p.title}</li>)}
                </ul>
              </div>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

function PointComposer({ onPost }: { onPost: (stance: string, text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [stance, setStance] = useState('note');
  const [posting, setPosting] = useState(false);
  const submit = async () => {
    if (!text.trim() || posting) return;
    setPosting(true);
    try { await onPost(stance, text.trim()); setText(''); setStance('note'); } finally { setPosting(false); }
  };
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: 10 }}>
      <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.tealDeep, fontWeight: 600, marginBottom: 6 }}>Add to thread — BP Spire</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <select value={stance} onChange={(e) => setStance(e.target.value)}
          style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink }}>
          <option value="note">Note</option>
          <option value="agree">Agree</option>
          <option value="disagree">Disagree</option>
        </select>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…" rows={2}
          style={{ flex: 1, fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, resize: 'vertical', fontFamily: SANS }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button onClick={submit} disabled={!text.trim() || posting}
          style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: text.trim() && !posting ? 'pointer' : 'not-allowed', background: text.trim() && !posting ? C.teal : C.border, color: '#fff' }}>
          {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
}

function AddFlagComposer({ onAdd }: { onAdd: (title: string, rationale: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const submit = () => { if (!title.trim()) return; onAdd(title.trim(), rationale.trim()); setTitle(''); setRationale(''); setOpen(false); };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ marginTop: 10, width: '100%', fontSize: 12, fontWeight: 500, padding: '9px 0', borderRadius: 8, cursor: 'pointer', border: `1px dashed ${C.borderStrong}`, background: C.surface, color: C.ink2 }}>
        + Add a flag
      </button>
    );
  }
  return (
    <div style={{ marginTop: 10, border: `1px dashed ${C.contested}`, borderRadius: 10, background: C.surface, padding: 12 }}>
      <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.contested, fontWeight: 600, marginBottom: 6 }}>Add a flag — preview, not saved</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Flag title"
        style={{ width: '100%', fontSize: 14, fontWeight: 600, padding: '7px 9px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, marginBottom: 6, fontFamily: SANS, boxSizing: 'border-box' }} />
      <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="One-line rationale (optional)"
        style={{ width: '100%', fontSize: 13, padding: '7px 9px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink, fontFamily: SANS, boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <button onClick={() => { setOpen(false); setTitle(''); setRationale(''); }}
          style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink2, cursor: 'pointer' }}>Cancel</button>
        <button onClick={submit} disabled={!title.trim()}
          style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: title.trim() ? 'pointer' : 'not-allowed', background: title.trim() ? C.contested : C.border, color: '#fff' }}>Add flag</button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: C.ink3 }}>{label}</div>
      <div style={{ ...num(C.ink), fontSize: 16, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

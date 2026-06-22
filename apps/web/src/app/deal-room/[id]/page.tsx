'use client';

/**
 * Deal Room — a negotiation-shaped view over a REAL analysis (read-only today).
 *
 * Renders the contested-points ledger derived from the analysis's genuine findings,
 * a role-aware right rail, and a buyer-only workbook affordance. NOTHING here writes:
 * point actions are local/visual only; there is no negotiation engine, no originator
 * account, no server-side access control yet.
 *
 * ★ HONESTY CAVEATS (do not soften):
 *  - The ROLE TOGGLE is a PRESENTATION PREVIEW, not access control. It swaps the two
 *    views client-side. It does NOT enforce workbook privacy. There is no real
 *    originator user, so nothing is exposed to anyone — but the role boundary is a
 *    SINGLE seam (`roleView`) that future server-enforced authz can plug into.
 *  - POINTS COME FROM REAL DATA. Each contested point is derived from a real finding
 *    (title + explanation + severity). No negotiation has happened, so every point is
 *    'flagged', the originator response is empty ("awaiting"), the tally is N-flagged/
 *    0-else, and implied impact is "not yet computed" (no engine). Honest-blank, not
 *    fabricated wireframe copy.
 */
import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import { formatCurrencyFull, formatDecimalPercent, formatMultipleSafe } from '@/lib/format';
import type { Analysis, Finding } from '@cre/shared';

type Role = 'bp_spire' | 'originator';

/** Contested point derived 1:1 from a real finding. originatorResponse is null
 *  (no negotiation engine); state is always 'flagged' today. */
interface ContestedPoint {
  readonly id: string;
  readonly title: string;
  readonly buyerPosition: string;       // finding.explanation — the real rationale
  readonly severity: string;
  readonly state: 'flagged';            // the only state today
  readonly originatorResponse: null;    // awaiting — nothing submitted
  readonly evidence: ReadonlyArray<never>;
}

function deriveContestedPoints(findings: ReadonlyArray<Finding>): ContestedPoint[] {
  return findings.map((f) => ({
    id: f.id,
    title: f.title,
    buyerPosition: f.explanation,
    severity: String(f.severity),
    state: 'flagged' as const,
    originatorResponse: null,
    evidence: [],
  }));
}

/** ★ THE SINGLE ROLE SEAM. Everything role-dependent reads from this one object,
 *  so a future server-enforced authz layer plugs in HERE (not scattered conditionals).
 *  `showWorkbook` is the workbook-privacy boundary — buyer only. */
function roleView(role: Role) {
  if (role === 'bp_spire') {
    return {
      label: 'BP Spire — Buyer',
      railTitle: 'Your underwriting',
      showWorkbook: true as const,        // buyer sees the full workbook
      pointActions: ['Respond', 'Resolve', 'Kick back'],
    };
  }
  return {
    label: 'Originator',
    railTitle: 'Your credit memo',
    showWorkbook: false as const,         // ABSENT for the originator
    pointActions: ['Provide evidence'],
  };
}

export default function DealRoom() {
  const { id } = useParams<{ id: string }>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState<Role>('bp_spire');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await api.getAnalysis(id);
        if (!alive) return;
        setLoading(false);
        // The deal room reads the classic Analysis shape (findings + score + uwModel).
        if (response.kind === 'legacy') setAnalysis(response.body.analysis as Analysis);
        else setUnsupported(true);
      } catch {
        if (alive) { setLoading(false); setError('Could not load this deal.'); }
      }
    })();
    return () => { alive = false; };
  }, [id]);

  if (loading) {
    return <div className="min-h-screen bg-bg-primary flex items-center justify-center text-text-muted text-sm">Loading deal room…</div>;
  }
  if (error || unsupported) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="text-text-secondary text-sm mb-1">{error || 'Deal room is available for classic analyses.'}</div>
          <div className="text-text-muted text-xs">{unsupported ? 'This analysis uses the graph-rendered format.' : ''}</div>
        </div>
      </div>
    );
  }
  if (!analysis) return null;

  const view = roleView(role);
  const findings = analysis.findings ?? [];
  const points = deriveContestedPoints(findings);
  const score = analysis.creditScore;
  const uw = analysis.uwModel;

  const toggle = (pid: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });

  const sevBadge = (sev: string) => `badge badge-${sev}`;

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="border-b border-border-primary bg-bg-secondary/60 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-serif font-semibold">{analysis.name}</h1>
              <span className="badge badge-medium">{analysis.assetType?.toUpperCase()}</span>
            </div>
            <div className="text-xs text-text-muted mt-0.5">Deal Room · negotiation view · <span className="font-mono">{analysis.id.slice(0, 8)}</span></div>
          </div>
          {/* ROLE TOGGLE — labeled preview, NOT access control */}
          <div className="text-right">
            <div className="inline-flex rounded border border-border-primary overflow-hidden text-xs">
              {(['bp_spire', 'originator'] as Role[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={`px-3 py-1.5 transition-colors ${role === r ? 'bg-accent text-bg-primary font-semibold' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {r === 'bp_spire' ? 'BP Spire' : 'Originator'}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-muted mt-1">Preview — presentation only, not access control</div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* ── Spine: tally + contested-points ledger ─────────────── */}
        <main>
          {/* Negotiation-state tally — derived honestly */}
          <div className="flex items-center gap-6 mb-5 text-sm">
            <Tally n={points.length} label="Flagged" tone="medium" />
            <Tally n={0} label="Contested" tone="muted" />
            <Tally n={0} label="Resolved" tone="positive" />
            <Tally n={0} label="Conceded" tone="muted" />
            <span className="text-xs text-text-muted ml-auto">No negotiation has started — every point awaits an originator response.</span>
          </div>

          <h2 className="text-xs uppercase tracking-wide text-text-muted mb-2">Contested points</h2>
          {points.length === 0 ? (
            <div className="text-text-muted text-sm border border-border-primary rounded p-4">No findings to contest.</div>
          ) : (
            <div className="space-y-2">
              {points.map((p) => {
                const open = expanded.has(p.id);
                return (
                  <div key={p.id} className="border border-border-primary rounded bg-bg-secondary/40">
                    <button onClick={() => toggle(p.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
                      <span className={`${sevBadge(p.severity)} shrink-0`}>{p.severity}</span>
                      <span className="text-sm text-text-primary flex-1">{p.title}</span>
                      <span className="text-xs text-risk-medium shrink-0">Flagged</span>
                      <svg className={`w-3.5 h-3.5 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </button>
                    {open && (
                      <div className="px-4 pb-4 space-y-3 border-t border-border-primary pt-3">
                        {/* Buyer position — real finding rationale (teal) */}
                        <div className="rounded border border-accent/30 bg-accent/5 p-3">
                          <div className="text-[11px] uppercase tracking-wide text-accent mb-1">Buyer position — BP Spire</div>
                          <div className="text-sm text-text-secondary">{p.buyerPosition}</div>
                        </div>
                        {/* Originator response — empty/awaiting (amber) */}
                        <div className="rounded border border-risk-medium/30 bg-risk-medium/5 p-3">
                          <div className="text-[11px] uppercase tracking-wide text-risk-medium mb-1">Originator response</div>
                          <div className="text-sm text-text-muted italic">Awaiting response — no rebuttal or evidence submitted.</div>
                        </div>
                        {/* Implied impact — no engine yet */}
                        <div className="text-xs text-text-muted">Implied impact: <span className="italic">not yet computed</span></div>
                        {/* Role-specific actions — VISUAL/LOCAL ONLY today (no write) */}
                        <div className="flex gap-2 pt-1">
                          {view.pointActions.map((label) => (
                            <button key={label} disabled className="text-xs px-3 py-1.5 rounded border border-border-primary bg-bg-tertiary text-text-muted cursor-not-allowed" title="Preview — no actions are saved yet">
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {/* ── Role-aware right rail (the asymmetry) ──────────────── */}
        <aside className="space-y-4">
          <div className="border border-border-primary rounded bg-bg-secondary/40 p-4">
            <div className="text-xs uppercase tracking-wide text-text-muted mb-3">{view.railTitle}</div>

            {/* Headline numbers — real, both roles */}
            {score && (
              <div className="flex items-baseline gap-2 mb-3">
                <span className={`text-2xl font-mono font-bold text-score-${score.riskTier ?? 'high_risk'}`}>{score.overall}</span>
                <span className="text-xs text-text-muted">/100 · {score.riskTier?.replace('_', ' ')}</span>
              </div>
            )}
            <dl className="space-y-1.5 text-sm">
              <Row label="Loan" value={uw ? formatCurrencyFull(uw.loanAmount) : '—'} />
              <Row label="DSCR" value={uw ? formatMultipleSafe(uw.dscr) : '—'} />
              <Row label="LTV" value={uw ? formatDecimalPercent(uw.ltv) : '—'} />
              <Row label="Debt yield" value={uw ? formatDecimalPercent(uw.debtYield) : '—'} />
            </dl>
          </div>

          {/* BUYER ONLY: the full workbook affordance (the privacy boundary) */}
          {view.showWorkbook ? (
            <button
              onClick={() => api.downloadPopulatedTemplate(analysis.id, `${analysis.name}_Workbook.xlsx`)}
              className="btn-primary w-full text-sm py-2"
            >
              Download full workbook
            </button>
          ) : (
            /* ORIGINATOR: no workbook; instead, what's being asked of them */
            <div className="border border-border-primary rounded bg-bg-secondary/40 p-4">
              <div className="text-xs uppercase tracking-wide text-text-muted mb-2">What you need to provide</div>
              {points.length === 0 ? (
                <div className="text-sm text-text-muted">Nothing outstanding.</div>
              ) : (
                <ul className="list-disc list-inside space-y-1 text-sm text-text-secondary">
                  {points.map((p) => <li key={p.id}>{p.title}</li>)}
                </ul>
              )}
              <div className="text-[11px] text-text-muted mt-2 italic">The buyer&apos;s workbook is not shared.</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Tally({ n, label, tone }: { n: number; label: string; tone: 'medium' | 'positive' | 'muted' }) {
  const color = tone === 'medium' ? 'text-risk-medium' : tone === 'positive' ? 'text-risk-positive' : 'text-text-muted';
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-xl font-mono font-bold ${color}`}>{n}</span>
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-mono text-text-primary">{value}</dd>
    </div>
  );
}

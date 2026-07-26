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
import { api } from '@/lib/api-client';
import { AddDocumentControl } from '@/components/AddDocumentControl';
import { formatCurrencyFull, formatDecimalPercent, formatMultipleSafe, formatPercent } from '@/lib/format';
import type { Analysis, Finding, Comment, UnderwritingModel, MitigationStrategy } from '@cre/shared';
import { recalculateFullModel } from '@cre/shared';
import { useSide, type Side } from '@/lib/side-context';

type Role = 'bp_spire' | 'originator';
type WSTab = 'adjust' | 'criteria' | 'score' | 'crosscheck' | 'research' | 'decision' | 'stress' | 'schedule' | 'handbook';
const WS_TABS: ReadonlyArray<{ key: WSTab; label: string }> = [
  { key: 'adjust', label: 'Adjust inputs' },
  { key: 'criteria', label: 'Criteria' }, { key: 'score', label: 'Score detail' }, { key: 'crosscheck', label: 'Cross-check' },
  { key: 'research', label: 'Research' }, { key: 'decision', label: 'B-piece decision' }, { key: 'stress', label: 'Stress' },
  { key: 'schedule', label: 'Schedule' }, { key: 'handbook', label: 'Handbook' },
];

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

/* ───────────────────────────────────────────────────────────────────────────
 * P4b — the 7-lever agreement ledger (re-skin of the mockup's LEVERS).
 *
 * ★ NO TOY SCORE. The mockup adds a fixed weight to a rising `SCORE_BASE` per
 * cleared lever; that has NO correspondence to the real doctrine blend
 * (recon §2). Here the doctrine score renders AS-IS from analysis.creditScore
 * and NEVER moves when a lever is agreed. The ONLY thing "agree" moves is the
 * flag state (clears it) + the ratified-mitigant CONVERGENCE count. `proceeds`
 * is the sole lever that re-scores for real (reduce_proceeds re-runs the deal);
 * that write path is graph-format only and unreachable from this legacy surface,
 * so proceeds is surfaced as a labeled "re-scores — run via revision" affordance
 * rather than faking a score move.
 * ─────────────────────────────────────────────────────────────────────────── */
interface LeverDef {
  readonly id: string;
  readonly name: string;
  /** Keyword matchers to bind this lever to a REAL mitigant (strategy text / structuralChanges). */
  readonly match: ReadonlyArray<string>;
  readonly orig: string;
  readonly buyer: string;
  readonly buyerWhy: string;
  /** proceeds is the last-resort economic lever — the ONLY one that really re-scores. */
  readonly lastResort?: boolean;
}
const LEVERS: ReadonlyArray<LeverDef> = [
  { id: 'reserve', name: 'Lease-up reserve', match: ['reserve', 'escrow', 'ti/lc', 'tilc', 'fund_reserve'],
    orig: 'Minimal reserve', buyer: 'Fund a lease-up / carry reserve', buyerWhy: 'Funds carry the asset through stabilization' },
  { id: 'cash', name: 'Cash management', match: ['cash management', 'lockbox', 'cash sweep', 'sweep', 'cash trap', 'springing_cash'],
    orig: 'No lockbox', buyer: 'Springing lockbox / cash trap', buyerWhy: 'Traps cash if lease-up stalls' },
  { id: 'guaranty', name: 'Recourse / guaranty', match: ['guaranty', 'recourse', 'guarantee'],
    orig: 'Non-recourse', buyer: 'Springing recourse on milestones', buyerWhy: 'Recourse triggers if lease-up misses' },
  { id: 'amort', name: 'Amortization', match: ['amort', 'paydown', 'deleverage', 'require_amortization'],
    orig: 'Full-term interest-only', buyer: 'Amortize after stabilization', buyerWhy: 'Builds equity once stabilized' },
  { id: 'cp', name: 'Conditions precedent', match: ['condition precedent', 'condition_precedent', 'estoppel', 'closing condition', 'cp '],
    orig: 'None at close', buyer: 'Estoppel + lease-up evidence at close', buyerWhy: 'Verifies the anchor before funding' },
  { id: 'proceeds', name: 'Loan proceeds', match: ['reduce_proceeds', 'proceeds', 'haircut', 'reduce loan', 'loan from'], lastResort: true,
    orig: 'Full request', buyer: 'Reduce proceeds (lower basis)', buyerWhy: 'De-risks by lowering basis' },
];

/** A lever bound to its real mitigant (or null = "not modeled" — shown honestly). */
interface LeverBinding {
  readonly def: LeverDef;
  readonly mitigant: MitigationStrategy | null;
  readonly finding: ContestedPoint | null;
  /** commentary key for the real comments table (finding id when bound, else lever id). */
  readonly commentKey: string;
}
function bindLevers(
  mitigations: ReadonlyArray<MitigationStrategy>,
  points: ReadonlyArray<ContestedPoint>,
): LeverBinding[] {
  const used = new Set<string>();
  return LEVERS.map((def) => {
    // Match a real mitigant by keyword against its strategy text + structural changes.
    const mitigant = mitigations.find((m) => {
      if (used.has(m.id)) return false;
      const hay = `${m.strategy} ${(m.structuralChanges ?? []).join(' ')} ${m.description ?? ''}`.toLowerCase();
      return def.match.some((k) => hay.includes(k));
    }) ?? null;
    if (mitigant) used.add(mitigant.id);
    const finding = mitigant ? (points.find((p) => p.id === mitigant.findingId) ?? null) : null;
    return { def, mitigant, finding, commentKey: mitigant?.findingId ?? `lever:${def.id}` };
  });
}

/** Map the active URL `?side` onto the DealRoom's explicit C palette (ochre / steel / neutral teal). */
function sideAccentC(side: Side | null): { accent: string; soft: string; label: string } {
  if (side === 'originator') return { accent: C.amber, soft: C.amberSoft, label: 'Originator' };
  if (side === 'buyer') return { accent: C.contested, soft: '#EAF0F8', label: 'B-piece buyer' };
  return { accent: C.teal, soft: C.tealSoft, label: 'Platform' };
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

export function DealRoom({ id }: { id: string }) {
  const side = useSide();                                   // P1/P2/P3 — carried via `?side`
  const [ratified, setRatified] = useState<Set<string>>(new Set()); // lever ids agreed (convergence state)
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState<Role>('bp_spire');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [callRequests, setCallRequests] = useState<Set<string>>(new Set()); // local-only (preview)
  const [localFlags, setLocalFlags] = useState<Array<{ id: string; title: string; rationale: string; addedBy: string }>>([]); // local-only (preview; clears on refresh)
  const [workspaceOpen, setWorkspaceOpen] = useState(false);          // buyer-only depth drawer
  const [workspaceTab, setWorkspaceTab] = useState<WSTab>('criteria');
  const [handbookEval, setHandbookEval] = useState<{ firedFlags?: Array<{ principleId: string; severity: string; flag_message: string; metricValue?: unknown }> } | null>(null);
  const [scenario, setScenario] = useState<UnderwritingModel | null>(null); // client-side what-if (NON-persisting); null = showing the actual underwriting
  const [hasActiveTemplate, setHasActiveTemplate] = useState<boolean | null>(null); // export-availability probe
  // Leasing-assumption override (persisted via /revisions; isolated from scoring). Edits keyed by field.
  const [leasingEdits, setLeasingEdits] = useState<Record<string, string>>({});
  const [leasingErr, setLeasingErr] = useState('');
  const [leasingBusy, setLeasingBusy] = useState(false);

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

  // Soft-fetch the handbook evaluation (fired principles) by graph revision; non-blocking.
  useEffect(() => {
    const rev = analysis?.graphRevisionId;
    if (!rev) return;
    let alive = true;
    api.getHandbookEvaluation(rev).then((he) => { if (alive) setHandbookEval(he as never); }).catch(() => {});
    return () => { alive = false; };
  }, [analysis?.graphRevisionId]);

  // Export-availability probe (mirrors the analysis page): an active UW template gates the
  // BP Spire / Bank workbook exports. Soft — failure → unavailable, exports disable cleanly.
  useEffect(() => {
    let alive = true;
    api.getActiveTemplate('single_loan').then(() => { if (alive) setHasActiveTemplate(true); }).catch(() => { if (alive) setHasActiveTemplate(false); });
    return () => { alive = false; };
  }, []);

  const refetch = async () => {
    const r = await api.getAnalysis(id);
    if (r.kind === 'legacy') setAnalysis(r.body.analysis as Analysis);
  };
  const postComment = async (findingId: string, stance: string, text: string) => {
    await api.addComment(id, { sectionId: 'deal-room', findingId, stance, text });
    await refetch();
  };
  const requestCall = (key: string) => setCallRequests((p) => new Set(p).add(key)); // local/visual only

  // ★ Adjust inputs = a NON-PERSISTING client-side what-if. We clone the projected uwModel,
  // apply the edit (mirroring the backend's applyLoanTermUpdates field-setting), and run the
  // SAME engine (recalculateFullModel from @cre/shared) in-browser. Nothing is written — no
  // revision rows, no lineage growth, no LLM, no 404. Reset returns to the actual underwriting.
  const applyLoanTerms = (updates: { interestRate?: number; loanAmount?: number; ioMonths?: number; amortizationMonths?: number; termMonths?: number }) => {
    const base = scenario ?? analysis?.uwModel;
    if (!base) return;
    const next = JSON.parse(JSON.stringify(base)) as UnderwritingModel;
    if (updates.interestRate !== undefined) { next.interestRate = updates.interestRate; if (next.loanDetails) next.loanDetails.interestRate = updates.interestRate; }
    if (updates.loanAmount !== undefined) { next.loanAmount = updates.loanAmount; if (next.loanDetails) next.loanDetails.loanAmount = updates.loanAmount; }
    if (updates.ioMonths !== undefined && next.loanDetails) next.loanDetails.ioMonths = updates.ioMonths;
    if (updates.amortizationMonths !== undefined) { if (next.loanDetails) next.loanDetails.amortizationMonths = updates.amortizationMonths; next.amortizationYears = updates.amortizationMonths / 12; }
    if (updates.termMonths !== undefined) { if (next.loanDetails) next.loanDetails.termMonths = updates.termMonths; next.termYears = updates.termMonths / 12; }
    (next as { asReported?: boolean }).asReported = false;
    setScenario(recalculateFullModel(next));
  };
  const applyCapRate = (value: number) => {
    const base = scenario ?? analysis?.uwModel;
    if (!base) return;
    const next = JSON.parse(JSON.stringify(base)) as UnderwritingModel;
    (next as { capRate?: number }).capRate = value;
    (next as { asReported?: boolean }).asReported = false;
    setScenario(recalculateFullModel(next));
  };
  const resetScenario = () => setScenario(null);

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
  const sideC = sideAccentC(side);
  const findings = analysis.findings ?? [];
  const points = deriveContestedPoints(findings);
  const comments = analysis.comments ?? [];
  const score = analysis.creditScore;

  // ── P4b lever ledger — REAL bindings, no toy score ─────────────────────────
  const leverBindings = bindLevers(analysis.mitigations ?? [], points);
  // Structural (non-proceeds) levers with a REAL mitigant behind them are the
  // universe of the CONVERGENCE indicator. Levers with no real backing are
  // "not modeled" and never counted toward convergence.
  const structuralBound = leverBindings.filter((b) => !b.def.lastResort && b.mitigant);
  const ratifiedCount = structuralBound.filter((b) => ratified.has(b.def.id)).length;
  const convergenceTotal = structuralBound.length;                     // N of M ratified — NOT the score
  // ★ Cleared = DERIVED read-only predicate (recon §Decision 2): no open
  //   fatal/disqualifying flag + rating band better than Decline + every backed
  //   structural mitigant ratified. Never a stored status, never a rising number.
  const hasFatalFlag = findings.some((f) => {
    const sev = String(f.severity ?? '').toLowerCase();
    return sev === 'critical' || sev === 'fatal' || sev === 'disqualifying';
  });
  const bandOk = score != null && score.riskTier !== 'high_risk' && score.riskTier !== 'insufficient_data'
    && (score.recommendation ?? '').toLowerCase() !== 'decline';
  const structuralAllRatified = convergenceTotal > 0 && ratifiedCount === convergenceTotal;
  const derivedCleared = !hasFatalFlag && bandOk && (convergenceTotal === 0 || structuralAllRatified);

  const ratifyLever = (b: LeverBinding) => {
    setRatified((p) => { const n = new Set(p); if (n.has(b.def.id)) n.delete(b.def.id); else n.add(b.def.id); return n; });
    // Record the ratification as a real "agree" comment on the finding the lever maps to
    // (the OVERRIDE_DECISION overlay write is graph-format only and unreachable here).
    if (b.finding && !ratified.has(b.def.id)) {
      postComment(b.finding.id, 'agree', `Agreed structural mitigant — ${b.def.name}: ${b.mitigant?.strategy ?? b.def.buyer}.`).catch(() => {});
    }
  };
  const uw = analysis.uwModel;
  const effUw = scenario ?? uw;                 // what the rail shows: the what-if if active, else the actual UW
  const scenarioActive = scenario !== null;
  const loan = effUw?.loanAmount ?? null;
  const uwNoi = (effUw as { netOperatingIncome?: number } | null)?.netOperatingIncome ?? (effUw && loan != null && effUw.debtYield != null ? effUw.debtYield * loan : null);
  const value = effUw && loan != null && effUw.ltv ? loan / effUw.ltv : null;

  // Workspace sub-tabs are DATA-DRIVEN — a tab appears only when its data is non-empty
  // (and reappears automatically for deals that populate it). Handbook is async — only
  // available once firedFlags has loaded. The active tab falls back to the first
  // available, so the drawer never opens on a hidden tab.
  const wsAvail: Record<WSTab, boolean> = {
    adjust: !!uw,
    criteria: (analysis.criteriaEvaluations?.length ?? 0) > 0,
    score: (score?.categories?.length ?? 0) > 0,
    crosscheck: (analysis.crossCheckFindings?.length ?? 0) > 0,
    research: !!analysis.research && (['sponsor', 'market', 'news'] as const).some((k) => (((analysis.research as never as Record<string, unknown[] | undefined>)?.[k]?.length) ?? 0) > 0),
    decision: analysis.bPieceDecision != null,
    stress: (analysis.stressScenarios?.length ?? 0) > 0,
    schedule: (((uw?.repaymentSchedule as never as { entries?: unknown[] } | null)?.entries?.length) ?? 0) > 0,
    handbook: (handbookEval?.firedFlags?.length ?? 0) > 0,
  };
  const availableTabs = WS_TABS.filter((t) => wsAvail[t.key]);
  const effectiveTab: WSTab | null = availableTabs.some((t) => t.key === workspaceTab) ? workspaceTab : (availableTabs[0]?.key ?? null);

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
            {/* Append a source document — buyer-only (behind the access seam). Reused verbatim. */}
            {role === 'bp_spire' && <AddDocumentControl analysisId={analysis.id} onAppended={refetch} />}
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

        {/* ── Market-vs-in-place (per appraisal leasing assumptions) ──
            Honest-blank: renders nothing unless BOTH market + in-place are
            present (appraisal must be ingested). Verdict is computed from the
            numbers (±2% band), never hardcoded. Display-only. */}
        {(() => {
          const la = analysis.appraisalExtraction?.leasingAssumptions;
          const market = la?.marketRentPsfPerMonth != null ? la.marketRentPsfPerMonth * 12 : null;
          const inPlace = la?.weightedInPlaceRentPsfPerMonth != null ? la.weightedInPlaceRentPsfPerMonth * 12 : null;
          if (market == null || inPlace == null) return null;
          const delta = inPlace / market - 1;
          const verdict = Math.abs(delta) <= 0.02 ? 'at market' : delta > 0 ? 'above market' : 'below market';
          const vColor = verdict === 'at market' ? C.ink2 : verdict === 'above market' ? C.flagged : C.teal;
          return (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 16, fontSize: 13, color: C.ink2 }}>
              <span>
                Appraisal Market Rent <span style={num(C.ink)}>${market.toFixed(2)}/SF</span>
                {' vs In-Place '}<span style={num(C.ink)}>${inPlace.toFixed(2)}/SF</span>
                {' — '}<span style={{ fontWeight: 600, color: vColor }}>{verdict}</span>
              </span>
              <span style={{ fontSize: 11, color: C.ink3 }}>per appraisal</span>
            </div>
          );
        })()}

        {/* ── Leasing-assumption override (per appraisal; analyst-overridable) ──
            Pre-fills from the appraisal's leasingAssumptions; persists via
            /revisions (applyRevisionDelta) — ISOLATED from scoring (the income-
            catch can't move). Honest-blank: empty fields, never $NaN. bp_spire only. */}
        {role === 'bp_spire' && analysis.graphRevisionId && (() => {
          const la = analysis.appraisalExtraction?.leasingAssumptions;
          const defaults: Record<string, string> = {
            marketRentPsf:  la?.marketRentPsfPerMonth != null ? (la.marketRentPsfPerMonth * 12).toFixed(2) : '',
            tiNewPsf:       la?.tiNewPsf != null ? String(la.tiNewPsf) : '',
            tiRenewPsf:     la?.tiRenewPsf != null ? String(la.tiRenewPsf) : '',
            downtimeMonths: la?.downtimeMonths != null ? String(la.downtimeMonths) : '',
            leaseTermYears: la?.avgLeaseTermMonths != null ? String(la.avgLeaseTermMonths / 12) : '',
          };
          const fields: ReadonlyArray<readonly [string, string, string]> = [
            ['marketRentPsf', 'Market Rent', '$/SF/yr'], ['tiNewPsf', 'New TI', '$/SF'],
            ['tiRenewPsf', 'Renew TI', '$/SF'], ['downtimeMonths', 'Downtime', 'mo'],
            ['leaseTermYears', 'Lease Term', 'yr'],
          ];
          const val = (k: string) => leasingEdits[k] ?? defaults[k];
          const changed = (k: string) => leasingEdits[k] != null && leasingEdits[k] !== '' && leasingEdits[k] !== defaults[k];
          const dirty = fields.some(([k]) => changed(k));
          const submit = async () => {
            const overrides = fields.filter(([k]) => changed(k))
              .map(([k]) => ({ path: `assumptions.leasing.${k}`, value: Number(leasingEdits[k]) }))
              .filter((o) => Number.isFinite(o.value));
            if (overrides.length === 0) return;
            setLeasingBusy(true); setLeasingErr('');
            try {
              await api.createGraphRevision(analysis.graphRevisionId as string, overrides);
              await refetch();
              setLeasingEdits({});
            } catch (e) { setLeasingErr((e as Error).message || 'Override failed'); }
            finally { setLeasingBusy(false); }
          };
          return (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, padding: '12px 16px', marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3 }}>Leasing assumptions</span>
                <span style={{ fontSize: 11, color: C.ink3 }}>per appraisal — override to set</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
                {fields.map(([k, label, unit]) => (
                  <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 11, color: C.ink2 }}>{label} <span style={{ color: C.ink3 }}>{unit}</span></span>
                    <input value={val(k)} placeholder="—" inputMode="decimal"
                      onChange={(ev) => setLeasingEdits((p) => ({ ...p, [k]: ev.target.value }))}
                      style={{ width: 88, padding: '5px 8px', fontSize: 13, ...num(changed(k) ? C.teal : C.ink), background: C.bg, border: `1px solid ${C.borderStrong}`, borderRadius: 6 }} />
                  </label>
                ))}
                <button onClick={submit} disabled={!dirty || leasingBusy}
                  style={{ fontSize: 12, fontWeight: 600, color: dirty ? C.bg : C.ink3, background: dirty && !leasingBusy ? C.teal : C.surface2, border: `1px solid ${C.borderStrong}`, borderRadius: 7, padding: '6px 14px', cursor: dirty && !leasingBusy ? 'pointer' : 'default' }}>
                  {leasingBusy ? 'Saving…' : 'Save override'}</button>
              </div>
              {leasingErr && <div style={{ fontSize: 11, color: C.flagged, marginTop: 6 }}>{leasingErr}</div>}
            </div>
          );
        })()}

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

        {/* ── Convergence + Cleared (derived; NOT the score) ──────
            Convergence = N of M REAL structural mitigants ratified (override
            state), clearly distinct from the doctrine score. Cleared = the
            derived predicate. Neither fabricates a rising number. */}
        <ConvergenceBar
          ratified={ratifiedCount} total={convergenceTotal}
          cleared={derivedCleared} hasFatalFlag={hasFatalFlag} bandOk={bandOk}
          accent={sideC.accent} soft={sideC.soft}
        />

        {/* ── DispositionBar — LABELED PREVIEW (no write; taxonomy is P4c) ── */}
        <DispositionBarPreview cleared={derivedCleared} hasFatalFlag={hasFatalFlag} />

        {/* ── Originator banner (originator view only) ─────────── */}
        {role === 'originator' && (
          <div style={{ background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#6e4a1d' }}>
            You see the buyer&apos;s flags and headline numbers — not the underwriting workbook.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>
          {/* ── 4. Contested-point cards ──────────────────────── */}
          <main>
            {scenarioActive && (
              <div style={{ fontSize: 12, color: '#6e4a1d', background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
                These findings reflect the <strong>original underwriting</strong> — they were not re-run on the what-if inputs.
              </div>
            )}
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

                          {/* Mitigants relocated onto the point (keyed by findingId; blank when none) */}
                          {(analysis.mitigations ?? []).filter((m) => m.findingId === p.id).map((m, mi) => (
                            <div key={mi} style={{ borderLeft: `3px solid ${C.resolved}`, background: '#F0F6F2', borderRadius: '0 8px 8px 0', padding: '10px 12px' }}>
                              <div style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: C.resolved, fontWeight: 600, marginBottom: 3 }}>Mitigant</div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{m.strategy}</div>
                              {m.description && <div style={{ fontSize: 12, color: C.ink2, marginTop: 2, lineHeight: 1.4 }}>{m.description}</div>}
                            </div>
                          ))}

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

            {/* ── 4b. Agreement ledger — the 7 levers, bound to REAL mitigants ──
                Each structural lever ratifies its real mitigant (clears the flag,
                records an "agree" comment) — the doctrine score does NOT move.
                Levers with no real mitigant behind them are shown honestly as
                "not modeled". Proceeds re-scores for real (labeled). */}
            <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3, margin: '18px 0 8px' }}>
              Agreement ledger <span style={{ textTransform: 'none', letterSpacing: 0, color: C.ink3 }}>— structural levers ratify a mitigant; the score stays put</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {leverBindings.map((b) => (
                <LeverRow
                  key={b.def.id} binding={b}
                  ratified={ratified.has(b.def.id)} onRatify={() => ratifyLever(b)}
                  thread={comments.filter((c) => c.findingId === b.commentKey)}
                  canComment={view.canComment}
                  onPost={(stance, text) => postComment(b.commentKey, stance, text)}
                  accent={sideC.accent}
                />
              ))}
            </div>

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
                score.riskTier === 'insufficient_data' ? (
                  // Engine abstained (coverage gate) — the score is ABSENT, not 0.
                  // Render "Insufficient data", never a "0/100" ring that reads as
                  // a catastrophic score.
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                    <div style={{ width: 84, height: 84, borderRadius: '50%', flexShrink: 0, background: C.border, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 64, height: 64, borderRadius: '50%', background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ ...num(C.ink3), fontSize: 24, fontWeight: 700, lineHeight: 1 }}>—</span>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Insufficient data</div>
                      <div style={{ fontSize: 12, color: C.ink3 }}>engine abstained — no valuation source</div>
                    </div>
                  </div>
                ) : (
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
                )
              )}
              {scenarioActive && (
                <div style={{ fontSize: 11, color: C.amber, background: C.amberSoft, border: `1px solid ${C.borderStrong}`, borderRadius: 6, padding: '6px 8px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span><strong>Scenario (not saved)</strong> — metrics recomputed from adjusted inputs. Score &amp; findings are the original underwriting.</span>
                  <button onClick={resetScenario} style={{ fontSize: 11, fontWeight: 600, color: C.teal, background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>Reset</button>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                <Metric label="DSCR" value={effUw ? formatMultipleSafe(effUw.dscr) : '—'} />
                <Metric label="Debt yield" value={effUw ? formatDecimalPercent(effUw.debtYield) : '—'} />
                <Metric label="Value" value={value != null ? formatCurrencyFull(value) : '—'} />
                <Metric label="UW NOI" value={uwNoi != null ? formatCurrencyFull(uwNoi) : '—'} />
              </div>

              {/* Artifacts — memo SHARED (both rails); workbook BUYER-ONLY */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {view.access.workbook === 'buyer-only' ? (
                  <>
                    {/* Primary workbook download — the on-demand /export path (bp_spire = the full
                        populated workbook; same engine + active uw_template). Gated on the template probe. */}
                    <button disabled={hasActiveTemplate !== true}
                      onClick={() => api.exportUnderwriting(analysis.id, { profile: 'bp_spire', assetClass: analysis.assetType, underwritingMode: 'single_loan' }, `${analysis.name}_Workbook.xlsx`)}
                      style={{ width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 0', borderRadius: 7, border: 'none', cursor: hasActiveTemplate === true ? 'pointer' : 'not-allowed', background: hasActiveTemplate === true ? C.teal : C.border, color: '#fff' }}>
                      Open full workbook
                    </button>
                    <button onClick={() => setWorkspaceOpen(true)}
                      style={{ width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 0', borderRadius: 7, cursor: 'pointer', background: C.surface, color: C.teal, border: `1px solid ${C.teal}` }}>
                      Underwriting workspace
                    </button>
                  </>
                ) : null}
                <MemoButton accent={view.accent} />
              </div>
              <div style={{ fontSize: 11, color: C.ink3, marginTop: 8 }}>
                {view.access.workbook === 'buyer-only'
                  ? 'The underwriting workbook is private to BP Spire. The memo is shared.'
                  : 'The underwriting workbook is held by the buyer. The memo is shared.'}
              </div>

              {/* Bank-profile workbook — the alternate export (the primary "Open full workbook"
                  above is the BP Spire profile; same /export engine, different input profile). */}
              {view.access.workbook === 'buyer-only' && hasActiveTemplate === true && (
                <button onClick={() => api.exportUnderwriting(analysis.id, { profile: 'bank', assetClass: analysis.assetType, underwritingMode: 'single_loan' }, `Bank_UW_${analysis.name}.xlsx`)}
                  style={{ width: '100%', marginTop: 10, fontSize: 11, fontWeight: 600, padding: '7px 0', borderRadius: 6, cursor: 'pointer', border: `1px solid ${C.border}`, background: C.surface, color: C.ink2 }}>
                  Bank-profile workbook
                </button>
              )}
              {view.access.workbook === 'buyer-only' && hasActiveTemplate === false && (
                <div style={{ fontSize: 10, color: C.ink3, marginTop: 10 }}>No active UW template — workbook export unavailable.</div>
              )}
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

      {/* ── Buyer-only Underwriting workspace drawer (read-only depth) ───────── */}
      {workspaceOpen && role === 'bp_spire' && (
        <div onClick={() => setWorkspaceOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(21,38,44,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(760px, 94vw)', height: '100%', background: C.bg, borderLeft: `1px solid ${C.borderStrong}`, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>Underwriting workspace</div>
                <div style={{ fontSize: 11, color: C.ink3 }}>Buyer-only · read-only · BP Spire&apos;s working detail</div>
              </div>
              <button onClick={() => setWorkspaceOpen(false)} style={{ fontSize: 16, color: C.ink3, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
            {availableTabs.length > 0 && (
              <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, overflowX: 'auto' }}>
                {availableTabs.map((t) => {
                  const on = effectiveTab === t.key;
                  return (
                    <button key={t.key} onClick={() => setWorkspaceTab(t.key)}
                      style={{ fontSize: 12, fontWeight: on ? 600 : 500, padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: on ? C.tealSoft : 'transparent', color: on ? C.tealDeep : C.ink2 }}>{t.label}</button>
                  );
                })}
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
              {effectiveTab === null && <WSEmpty label="No underwriting detail computed for this deal yet." />}
              {effectiveTab === 'adjust' && <AdjustInputs uw={effUw as never} scenarioActive={scenarioActive} onApplyTerms={applyLoanTerms} onApplyCapRate={applyCapRate} onReset={resetScenario} />}
              {effectiveTab === 'criteria' && <CriteriaList items={analysis.criteriaEvaluations ?? []} />}
              {effectiveTab === 'score' && <ScoreDetail score={score} />}
              {effectiveTab === 'crosscheck' && <CrossCheckList items={analysis.crossCheckFindings ?? []} />}
              {effectiveTab === 'research' && <ResearchView research={analysis.research as never} />}
              {effectiveTab === 'decision' && <DecisionPanel decision={analysis.bPieceDecision as never} />}
              {effectiveTab === 'stress' && <StressTable scenarios={(analysis.stressScenarios ?? []) as never} uwNoi={uwNoi} />}
              {effectiveTab === 'schedule' && <ScheduleTable schedule={(uw?.repaymentSchedule ?? null) as never} />}
              {effectiveTab === 'handbook' && <HandbookList firedFlags={handbookEval?.firedFlags ?? null} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface ResearchItem { title: string; snippet?: string; source?: string; publishedDate?: string; url?: string; riskSignal?: string }

// ── Workspace read-only renderers (light palette; real data; no edits) ─────────
const wsCol: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const wsCard: React.CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, padding: 12 };
const wsCell: React.CSSProperties = { padding: '6px 8px', fontSize: 12, borderBottom: `1px solid ${C.border}`, textAlign: 'left' };
function WSEmpty({ label }: { label: string }) {
  return <div style={{ ...wsCard, color: C.ink3, fontSize: 13 }}>{label}</div>;
}
function WSPill({ text, tone }: { text: string; tone: string }) {
  return <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#fff', background: tone, borderRadius: 4, padding: '2px 7px' }}>{text}</span>;
}

function CriteriaList({ items }: { items: ReadonlyArray<{ ruleName: string; result: string; reason?: string; source?: string }> }) {
  if (!items.length) return <WSEmpty label="No criteria evaluations." />;
  return <div style={wsCol}>{items.map((c, i) => (
    <div key={i} style={wsCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <WSPill text={c.result} tone={c.result === 'pass' ? C.resolved : c.result === 'fail' ? C.kicked : C.conceded} />
        <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>{c.ruleName}</span>
      </div>
      {c.reason && <div style={{ fontSize: 12, color: C.ink2, marginTop: 5, lineHeight: 1.5 }}>{c.reason}</div>}
      {c.source && <div style={{ fontSize: 11, color: C.teal, marginTop: 2 }}>{c.source}</div>}
    </div>
  ))}</div>;
}

function ScoreDetail({ score }: { score: { overall?: number; riskTier?: string; recommendation?: string; whyThisScore?: string; howToImprove?: string; categories?: ReadonlyArray<{ category: string; weightedScore: number; weight: number; score: number; maxScore: number; tier?: string | null; explanation?: string }> } | null | undefined }) {
  if (!score) return <WSEmpty label="No score." />;
  const gated = score.riskTier === 'insufficient_data';
  return <div style={wsCol}>
    <div style={wsCard}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        {gated ? (
          <span style={{ ...num(C.ink), fontSize: 20, fontWeight: 700 }}>Insufficient data</span>
        ) : (
          <>
            <span style={{ ...num(C.ink), fontSize: 28, fontWeight: 700 }}>{score.overall}</span>
            <span style={{ fontSize: 12, color: C.ink3, textTransform: 'capitalize' }}>/ 100 · {score.riskTier?.replace('_', ' ')} · {score.recommendation?.replace(/_/g, ' ')}</span>
          </>
        )}
      </div>
      {gated && <div style={{ fontSize: 12, color: C.ink3, marginTop: 2 }}>The engine abstained from scoring — no valuation source to anchor the credit read.</div>}
      {score.whyThisScore && <div style={{ fontSize: 12, color: C.ink2, marginTop: 6, lineHeight: 1.5 }}>{score.whyThisScore}</div>}
      {score.howToImprove && <div style={{ fontSize: 12, color: C.ink2, marginTop: 4, lineHeight: 1.5 }}><strong>To improve:</strong> {score.howToImprove}</div>}
    </div>
    {(score.categories ?? []).map((cat) => {
      const pct = cat.maxScore ? Math.round((cat.score / cat.maxScore) * 100) : 0;
      return (
        <div key={cat.category} style={wsCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, textTransform: 'capitalize' }}>{cat.category.replace(/_/g, ' ')}</span>
            <span style={{ ...num(C.ink2), fontSize: 12 }}>{Math.round(cat.weightedScore)} / {cat.weight}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: C.border, marginTop: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct >= 70 ? C.resolved : pct >= 40 ? C.amber : C.kicked }} />
          </div>
          {cat.explanation && <div style={{ fontSize: 11, color: C.ink3, marginTop: 5 }}>{cat.explanation}</div>}
        </div>
      );
    })}
  </div>;
}

function CrossCheckList({ items }: { items: ReadonlyArray<{ metric: string; sellerBankValue?: string; bpSpiralValue?: string; percentVariance?: number | null; flag?: string; commentary?: string }> }) {
  if (!items.length) return <WSEmpty label="No cross-check findings." />;
  return <div style={wsCol}>{items.map((c, i) => (
    <div key={i} style={wsCard}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{c.metric}</span>
        {c.flag && <WSPill text={c.flag} tone={c.flag === 'material' ? C.kicked : c.flag === 'moderate' ? C.amber : C.conceded} />}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 12 }}>
        <span style={{ color: C.ink2 }}>Seller/Bank <span style={num(C.ink)}>{c.sellerBankValue ?? '—'}</span></span>
        <span style={{ color: C.ink2 }}>BP Spire <span style={num(C.ink)}>{c.bpSpiralValue ?? '—'}</span></span>
        {c.percentVariance != null && <span style={{ ...num(c.percentVariance >= 0 ? C.resolved : C.kicked) }}>{c.percentVariance >= 0 ? '+' : ''}{c.percentVariance.toFixed(1)}%</span>}
      </div>
      {c.commentary && <div style={{ fontSize: 12, color: C.ink2, marginTop: 5, lineHeight: 1.4 }}>{c.commentary}</div>}
    </div>
  ))}</div>;
}

function ResearchView({ research }: { research: { sponsor?: ReadonlyArray<ResearchItem>; market?: ReadonlyArray<ResearchItem>; news?: ReadonlyArray<ResearchItem> } | null }) {
  if (!research) return <WSEmpty label="No research." />;
  const groups: ReadonlyArray<[string, ReadonlyArray<ResearchItem> | undefined]> = [['Sponsor', research.sponsor], ['Market', research.market], ['News', research.news]];
  const any = groups.some(([, g]) => (g?.length ?? 0) > 0);
  if (!any) return <WSEmpty label="No research results." />;
  return <div style={wsCol}>{groups.map(([label, g]) => (g && g.length > 0) ? (
    <div key={label}>
      <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3, marginBottom: 6 }}>{label}</div>
      <div style={wsCol}>{g.map((r, i) => (
        <div key={i} style={wsCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{r.title}</span>
            {r.riskSignal && <WSPill text={r.riskSignal} tone={r.riskSignal === 'negative' ? C.kicked : r.riskSignal === 'positive' ? C.resolved : C.conceded} />}
          </div>
          {r.snippet && <div style={{ fontSize: 12, color: C.ink2, marginTop: 4 }}>{r.snippet}</div>}
          <div style={{ fontSize: 11, color: C.ink3, marginTop: 4 }}>{r.source}{r.publishedDate ? ` · ${r.publishedDate}` : ''}{r.url ? <> · <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: C.teal }}>View source</a></> : null}</div>
        </div>
      ))}</div>
    </div>
  ) : null)}</div>;
}

function DecisionPanel({ decision }: { decision: { recommendation?: string; conviction?: string; summary?: string; dealBreakers?: ReadonlyArray<string>; keyConditions?: ReadonlyArray<string>; pricingGuidance?: string } | null }) {
  if (!decision) return <WSEmpty label="No B-piece decision." />;
  return <div style={wsCol}>
    <div style={wsCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <WSPill text={(decision.recommendation ?? '').replace(/_/g, ' ')} tone={decision.recommendation === 'approve' ? C.resolved : decision.recommendation === 'decline' ? C.kicked : C.amber} />
        {decision.conviction && <span style={{ fontSize: 12, color: C.ink2 }}>conviction: {decision.conviction}</span>}
      </div>
      {decision.summary && <div style={{ fontSize: 13, color: C.ink, marginTop: 8, lineHeight: 1.5 }}>{decision.summary}</div>}
    </div>
    {(decision.dealBreakers?.length ?? 0) > 0 && <div style={wsCard}><div style={{ fontSize: 11, textTransform: 'uppercase', color: C.kicked, fontWeight: 600, marginBottom: 4 }}>Deal breakers</div><ul style={{ margin: 0, paddingLeft: 16 }}>{decision.dealBreakers!.map((d, i) => <li key={i} style={{ fontSize: 12.5, color: C.ink2, marginBottom: 2 }}>{d}</li>)}</ul></div>}
    {(decision.keyConditions?.length ?? 0) > 0 && <div style={wsCard}><div style={{ fontSize: 11, textTransform: 'uppercase', color: C.amber, fontWeight: 600, marginBottom: 4 }}>Key conditions</div><ul style={{ margin: 0, paddingLeft: 16 }}>{decision.keyConditions!.map((d, i) => <li key={i} style={{ fontSize: 12.5, color: C.ink2, marginBottom: 2 }}>{d}</li>)}</ul></div>}
    {decision.pricingGuidance && <div style={wsCard}><div style={{ fontSize: 11, textTransform: 'uppercase', color: C.ink3, fontWeight: 600, marginBottom: 4 }}>Pricing guidance</div><div style={{ fontSize: 12.5, color: C.ink2 }}>{decision.pricingGuidance}</div></div>}
  </div>;
}

function StressTable({ scenarios, uwNoi }: { scenarios: ReadonlyArray<{ name: string; results?: { noi?: number; dscr?: number | null; ltv?: number | null; debtYield?: number | null; dscrBreached?: boolean | null; ltvBreached?: boolean | null }; breaksCovenants?: boolean }>; uwNoi: number | null }) {
  if (!scenarios.length) return <WSEmpty label="No stress scenarios." />;
  const breach = (v: boolean | null | undefined): React.CSSProperties => v ? { color: C.kicked, fontWeight: 600 } : {};
  return <div style={{ ...wsCard, padding: 0, overflow: 'hidden' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{['Scenario', 'NOI', 'DSCR', 'LTV', 'Covenants'].map((h) => <th key={h} style={{ ...wsCell, fontSize: 10, textTransform: 'uppercase', color: C.ink3, background: C.surface2 }}>{h}</th>)}</tr></thead>
      <tbody>
        {uwNoi != null && <tr><td style={{ ...wsCell, color: C.ink2 }}>Base case</td><td style={{ ...wsCell, ...num(C.ink) }}>{formatCurrencyFull(uwNoi)}</td><td style={wsCell}>—</td><td style={wsCell}>—</td><td style={wsCell}>—</td></tr>}
        {scenarios.map((s, i) => (
          <tr key={i}>
            <td style={{ ...wsCell, color: C.ink }}>{s.name}</td>
            <td style={{ ...wsCell, ...num(C.ink) }}>{s.results?.noi != null ? formatCurrencyFull(s.results.noi) : '—'}</td>
            <td style={{ ...wsCell, ...num(C.ink), ...breach(s.results?.dscrBreached) }}>{formatMultipleSafe(s.results?.dscr ?? null)}</td>
            <td style={{ ...wsCell, ...num(C.ink), ...breach(s.results?.ltvBreached) }}>{formatDecimalPercent(s.results?.ltv ?? null)}</td>
            <td style={wsCell}><WSPill text={s.breaksCovenants ? 'fail' : 'pass'} tone={s.breaksCovenants ? C.kicked : C.resolved} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>;
}

function ScheduleTable({ schedule }: { schedule: { entries?: ReadonlyArray<{ month: number; date: string; isIO: boolean; beginningBalance: number; interest: number; totalPayment: number; endingBalance: number }>; summary?: { totalInterest: number; totalPrincipal: number; balloonBalance: number; balloonDate: string } } | null }) {
  if (!schedule || !(schedule.entries?.length)) return <WSEmpty label="No repayment schedule." />;
  const rows = schedule.entries.filter((_, i) => i % 12 === 0 || i === schedule.entries!.length - 1); // annual cadence for readability
  return <div style={wsCol}>
    {schedule.summary && (
      <div style={{ ...wsCard, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: C.ink2 }}>Total interest <span style={num(C.ink)}>{formatCurrencyFull(schedule.summary.totalInterest)}</span></span>
        <span style={{ fontSize: 12, color: C.ink2 }}>Balloon <span style={num(C.ink)}>{formatCurrencyFull(schedule.summary.balloonBalance)}</span></span>
        <span style={{ fontSize: 12, color: C.ink2 }}>Balloon date <span style={num(C.ink)}>{schedule.summary.balloonDate}</span></span>
      </div>
    )}
    <div style={{ ...wsCard, padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Mo', 'Date', 'Type', 'Begin', 'Interest', 'Payment', 'End'].map((h) => <th key={h} style={{ ...wsCell, fontSize: 10, textTransform: 'uppercase', color: C.ink3, background: C.surface2 }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((e, i) => (
          <tr key={i}>
            <td style={{ ...wsCell, ...num(C.ink2) }}>{e.month}</td>
            <td style={{ ...wsCell, color: C.ink2 }}>{e.date}</td>
            <td style={wsCell}><WSPill text={e.isIO ? 'IO' : 'P+I'} tone={e.isIO ? C.amber : C.teal} /></td>
            <td style={{ ...wsCell, ...num(C.ink) }}>{formatCurrencyFull(e.beginningBalance)}</td>
            <td style={{ ...wsCell, ...num(C.ink) }}>{formatCurrencyFull(e.interest)}</td>
            <td style={{ ...wsCell, ...num(C.ink) }}>{formatCurrencyFull(e.totalPayment)}</td>
            <td style={{ ...wsCell, ...num(C.ink) }}>{formatCurrencyFull(e.endingBalance)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  </div>;
}

interface UwLite {
  loanAmount: number; interestRate: number; capRate: number;
  termYears?: number; amortizationYears?: number;
  loanDetails?: { ioMonths?: number; termMonths?: number; amortizationMonths?: number } | null;
}
function AdjustInputs({ uw, scenarioActive, onApplyTerms, onApplyCapRate, onReset }: {
  uw: UwLite | null; scenarioActive: boolean;
  onApplyTerms: (updates: Record<string, number>) => void; onApplyCapRate: (value: number) => void; onReset: () => void;
}) {
  if (!uw) return <WSEmpty label="No underwriting model to adjust." />;
  const ld = uw.loanDetails ?? {};
  const term = ld.termMonths ?? (uw.termYears ? uw.termYears * 12 : 0);
  const amort = ld.amortizationMonths ?? (uw.amortizationYears ? uw.amortizationYears * 12 : 0);
  return (
    <div style={wsCol}>
      <div style={{ ...wsCard, background: C.tealSoft, borderColor: C.teal, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12, color: C.tealDeep, lineHeight: 1.5 }}>
          <strong>What-if (not saved).</strong> Edits recompute the rail metrics using the real underwriting engine, in-browser. Nothing is written — no revision, no lineage change. Score &amp; findings stay the original underwriting.
        </div>
        {scenarioActive && <button onClick={onReset} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: C.teal, border: 'none', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Reset</button>}
      </div>
      <LightTermInput label="Loan amount" value={uw.loanAmount} display={formatCurrencyFull(uw.loanAmount)} onApply={(v) => onApplyTerms({ loanAmount: v })} />
      <LightTermInput label="Interest rate" value={uw.interestRate} display={formatPercent(uw.interestRate)} step={0.125} onApply={(v) => onApplyTerms({ interestRate: v })} />
      <LightTermInput label="Cap rate" value={uw.capRate} display={formatDecimalPercent(uw.capRate)} step={0.00125} onApply={(v) => onApplyCapRate(v)} />
      <LightTermInput label="IO period (months)" value={ld.ioMonths ?? 0} display={`${ld.ioMonths ?? 0} mo`} step={1} onApply={(v) => onApplyTerms({ ioMonths: v })} />
      <LightTermInput label="Term (months)" value={term} display={`${term} mo`} step={12} onApply={(v) => onApplyTerms({ termMonths: v })} />
      <LightTermInput label="Amortization (months)" value={amort} display={`${amort} mo`} step={12} onApply={(v) => onApplyTerms({ amortizationMonths: v })} />
    </div>
  );
}
function LightTermInput({ label, value, display, step, onApply }: {
  label: string; value: number; display: string; step?: number; onApply: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const apply = () => { const v = parseFloat(draft); if (!Number.isNaN(v)) onApply(v); setEditing(false); };
  return (
    <div style={{ ...wsCard, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ fontSize: 13, color: C.ink }}>{label}</span>
      {editing ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" step={step ?? 'any'} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') setEditing(false); }}
            style={{ width: 130, fontSize: 13, padding: '5px 7px', borderRadius: 6, border: `1px solid ${C.teal}`, fontFamily: MONO, boxSizing: 'border-box' }} />
          <button onClick={apply} style={{ fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 6, border: 'none', background: C.teal, color: '#fff', cursor: 'pointer' }}>Apply</button>
          <button onClick={() => setEditing(false)} style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.ink2, cursor: 'pointer' }}>✕</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ ...num(C.ink), fontSize: 14, fontWeight: 600 }}>{display}</span>
          <button onClick={() => { setDraft(String(value)); setEditing(true); }} style={{ fontSize: 11, color: C.teal, background: 'none', border: 'none', cursor: 'pointer' }}>Edit</button>
        </div>
      )}
    </div>
  );
}

function HandbookList({ firedFlags }: { firedFlags: ReadonlyArray<{ principleId: string; severity: string; flag_message: string; metricValue?: unknown }> | null }) {
  if (!firedFlags) return <WSEmpty label="Handbook evaluation not available for this deal." />;
  if (!firedFlags.length) return <WSEmpty label="No principles fired." />;
  return <div style={wsCol}>{firedFlags.map((f, i) => (
    <div key={i} style={wsCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...num(C.ink3), fontSize: 11 }}>{f.principleId}</span>
        <WSPill text={f.severity} tone={f.severity === 'critical' || f.severity === 'high' ? C.kicked : f.severity === 'medium' ? C.amber : C.conceded} />
      </div>
      <div style={{ fontSize: 13, color: C.ink, marginTop: 5, lineHeight: 1.5 }}>{f.flag_message}</div>
    </div>
  ))}</div>;
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

/* ── Convergence indicator — ratified-mitigant COUNT (never the score) + derived Cleared ── */
function ConvergenceBar({ ratified, total, cleared, hasFatalFlag, bandOk, accent, soft }: {
  ratified: number; total: number; cleared: boolean; hasFatalFlag: boolean; bandOk: boolean; accent: string; soft: string;
}) {
  const pct = total > 0 ? Math.round((ratified / total) * 100) : (cleared ? 100 : 0);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface, padding: '12px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: C.ink3 }}>Structural convergence</span>
          <span style={{ ...num(C.ink), fontSize: 15, fontWeight: 700 }}>{ratified}<span style={{ color: C.ink3, fontWeight: 400 }}> of {total}</span></span>
          <span style={{ fontSize: 11, color: C.ink3 }}>mitigants ratified — not the credit score</span>
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
        Cleared ⟺ no open disqualifying flag · rating band better than Decline · every backed structural mitigant ratified. Derived read — no status is written.
      </div>
    </div>
  );
}

/* ── DispositionBar — LABELED PREVIEW. Renders the mockup's 4 reason categories.
      No write: the `reasonCategory` taxonomy + the disposition write are P4c. ── */
const DISPOSITION_REASONS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
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
          <button disabled title="Preview — Closed status is P4c (needs the status write path)"
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
            The <code>reasonCategory</code> write + disposition record are P4c. Existing disposition data is untouched.
          </div>
        </div>
      )}
    </div>
  );
}

/* ── LeverRow — one lever, bound to its REAL mitigant (or "not modeled"). ──
      Agree ratifies the mitigant (clears the flag + records an "agree" comment)
      WITHOUT moving the doctrine score. Per-lever commentary posts to the real
      comments table keyed on the mapped finding (or the lever id when unbacked). */
function LeverRow({ binding, ratified, onRatify, thread, canComment, onPost, accent }: {
  binding: LeverBinding; ratified: boolean; onRatify: () => void;
  thread: ReadonlyArray<Comment>; canComment: boolean;
  onPost: (stance: string, text: string) => Promise<void>; accent: string;
}) {
  const [showThread, setShowThread] = useState(false);
  const { def, mitigant, finding } = binding;
  const notModeled = !mitigant && !def.lastResort;
  const isProceeds = !!def.lastResort;
  const done = ratified && !isProceeds;
  const border = done ? C.resolved : notModeled ? C.border : C.borderStrong;
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 11, background: done ? '#F5FAF7' : C.surface, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: DISP_FALLBACK, fontSize: 15, fontWeight: 600, color: C.ink }}>{def.name}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {thread.length > 0 && <button onClick={() => setShowThread((s) => !s)} style={{ ...num(accent), fontSize: 11, background: 'none', border: 'none', cursor: 'pointer' }}>{thread.length} 💬</button>}
          {isProceeds && (
            <span style={{ fontSize: 10, fontWeight: 600, color: C.amber }}>re-scores — run via revision</span>
          )}
          {notModeled && <span style={{ fontSize: 10, fontWeight: 600, color: C.ink3, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 5, padding: '2px 7px' }}>not modeled</span>}
          {done && <span style={{ fontSize: 11, fontWeight: 600, color: C.resolved }}>✓ agreed</span>}
        </div>
      </div>

      {/* Flag line — the real finding this lever ratifies (or the honest gap). */}
      <div style={{ fontSize: 10.5, color: done ? C.resolved : notModeled ? C.ink3 : C.flagged, marginTop: 4 }}>
        {finding
          ? (done ? `flag cleared: ${finding.title}` : `red flag: ${finding.title}`)
          : isProceeds
            ? 'economic lever — only reduce_proceeds actually re-runs the doctrine score'
            : 'no matching mitigant produced by the engine for this deal'}
      </div>

      {!done && !notModeled && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, margin: '10px 0' }}>
            <LeverPosition accent={C.amber} who="Originator proposes" term={def.orig} />
            <LeverPosition accent={accent} who="Buyer requires" term={mitigant?.strategy ?? def.buyer} why={def.buyerWhy} />
          </div>
          {mitigant && (mitigant.structuralChanges?.length ?? 0) > 0 && (
            <ul style={{ margin: '0 0 10px', paddingLeft: 16 }}>
              {mitigant.structuralChanges.map((sc, i) => <li key={i} style={{ fontSize: 12, color: C.ink2, lineHeight: 1.4 }}>{sc}</li>)}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isProceeds ? (
              <button disabled title="reduce_proceeds re-runs the deal — create a revision (graph path); not written from the deal room"
                style={{ fontSize: 12, fontWeight: 600, padding: '7px 13px', borderRadius: 7, border: `1px solid ${C.amber}`, background: C.amberSoft, color: C.amber, cursor: 'not-allowed' }}>
                Reduce proceeds — re-scores (last resort)
              </button>
            ) : (
              <button onClick={onRatify}
                style={{ fontSize: 12, fontWeight: 600, padding: '7px 13px', borderRadius: 7, border: 'none', background: accent, color: '#fff', cursor: 'pointer' }}>
                Agree structure — clears the flag (score holds)
              </button>
            )}
          </div>
        </>
      )}
      {done && (
        <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 8 }}>
          {mitigant?.strategy ?? def.buyer}<span style={{ color: C.ink3 }}> — ratified; the doctrine score is unchanged.</span>
          <button onClick={onRatify} style={{ marginLeft: 8, fontSize: 11, color: accent, background: 'none', border: 'none', cursor: 'pointer' }}>undo</button>
        </div>
      )}
      {notModeled && (
        <div style={{ fontSize: 12, color: C.ink3, fontStyle: 'italic', marginTop: 6 }}>
          The engine produced no mitigant for this lever on this deal — shown honestly rather than faking agreement. Buyer ask: {def.buyer}.
        </div>
      )}

      {/* Per-lever commentary → the REAL comments table (keyed on the mapped finding). */}
      {showThread && thread.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {thread.map((c) => (
            <div key={c.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#fff', borderRadius: 4, padding: '1px 6px', background: c.stance === 'agree' ? C.resolved : c.stance === 'disagree' ? C.kicked : C.conceded }}>{c.stance}</span>
                <span style={{ fontSize: 11, color: C.ink2 }}>{c.author}</span>
                <span style={{ ...num(C.ink3), fontSize: 10, marginLeft: 'auto' }}>{new Date(c.createdAt).toLocaleDateString()}</span>
              </div>
              <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.45 }}>{c.text}</div>
            </div>
          ))}
        </div>
      )}
      {canComment ? (
        <div style={{ marginTop: 10 }}>
          <PointComposer onPost={onPost} />
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
const DISP_FALLBACK = SANS;

// RenderedAnalysisView - read-only consumer of the server-side RenderedAnalysis.
//
// CONSUMER-MIGRATION DISCIPLINE (post-6.8):
//   - Renders RenderedAnalysis as materialized truth from the server.
//   - NEVER re-derives metrics. The server has already computed DSCR, LTV, debt yield,
//     NOI, valuation, mechanical score, weighted aggregate, etc.
//   - NEVER re-formats values. Each RenderCell carries displayValue; the UI prints it.
//     No formatCurrency / formatPercent / formatMultiple / formatDecimalPercent calls.
//   - NEVER reclassifies bands or applies thresholds. RatingBand and badges arrive
//     from the server with their final classification.
//   - NEVER re-renders sentinels. "-" / "Insufficient data" come from the server.
//
// This component reads cell.displayValue strings directly. The render-version string
// is shown for audit visibility but never used for branching.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type {
  CommitteeTimeline,
  DataConfidence,
  DealWorkflowState,
  DoctrineEvaluationId,
  FieldValue,
  FiredFlag,
  HandbookEvaluation,
  RenderedAnalysis,
  RenderedAnalysisId,
  RenderBadge,
  RenderBadgeSeverity,
  RenderedFinding,
  RenderedLineItem,
  RenderedMitigationProposal,
  RenderedNarrativeSection,
  RenderedStressScenario,
  SkippedPrinciple,
} from '@cre/contracts';
import { ROLE_PERMISSIONS, DQ_CODE_TO_SLOT } from '@cre/contracts';
import { CommitteeStatusHeader } from './CommitteeStatusHeader';
import { CommitteeTimelinePanel } from './CommitteeTimelinePanel';
import { CommitteeActionButtons } from './CommitteeActionButtons';
import { AuditViewToggle } from './AuditViewToggle';
import { SnapshotViewer } from './SnapshotViewer';
import { WorkbookReadiness } from './WorkbookReadiness';
import { NegotiationSurface } from './NegotiationSurface';
import { BuyerDiffPanel } from './BuyerDiffPanel';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api-client';
import { useSide, type Side } from '@/lib/side-context';
import {
  buildPath,
  isEditablePath,
  pathInputStep,
  pathToUiUnit,
  pathUnitLabel,
  uiUnitToBackend,
} from '@/lib/uw-edit-utils';

// ── P1 tokens (explicit hexes — the SAME palette NegotiationSurface uses, so the
//    shell no longer clashes with the negotiation panel embedded in it). Stage 3/4:
//    teal #0C6E78 (platform/neutral), ink/paper light ramp, ochre (originator) /
//    steel (buyer) side accents, IBM Plex Sans / Mono with tabular-nums. ────────────
const C = {
  bg: '#F5F7F8', surface: '#FFFFFF', surface2: '#FBFCFC', border: '#E2E8EA', borderStrong: '#CCD6D9',
  ink: '#15262C', ink2: '#4A5C62', ink3: '#8A979C',
  teal: '#0C6E78', tealDeep: '#0A555D', tealSoft: '#E6F1F2',
  amber: '#A9641F', amberSoft: '#F6ECDD',
  flagged: '#A9641F', contested: '#345F9E', resolved: '#2E7D5B', conceded: '#6B7A80', kicked: '#AE3A33',
} as const;
const SANS = '"IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const DISPLAY = '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif';
const num = (color: string = C.ink): React.CSSProperties => ({ fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color });

/** Map the active `?side` onto the explicit C palette (ochre / steel / neutral teal). */
function sideAccentC(side: Side | null): { accent: string; soft: string; label: string } {
  if (side === 'originator') return { accent: C.amber, soft: C.amberSoft, label: 'Originator' };
  if (side === 'buyer') return { accent: C.contested, soft: '#EAF0F8', label: 'B-piece buyer' };
  return { accent: C.teal, soft: C.tealSoft, label: 'Platform' };
}

// ── Workspace drawer tabs — the deep READ-ONLY sections behind tabs instead of a
//    stacked scroll. Data-driven: a tab appears only when its data is non-empty
//    (mirrors DealRoom's wsAvail/availableTabs pattern). 'adjust' carries the
//    editable line-item tables (edit path rides in verbatim). ─────────────────────
type WSTab = 'adjust' | 'stress' | 'valuation' | 'doctrine' | 'handbook' | 'mitigations' | 'narrative' | 'findings' | 'quality';
type WSGroup = 'Financials' | 'Summary' | 'Data';
// Grouped tab bar (Stage 3.1): the flat 9-tab strip is regrouped into three
// labeled groups. Content per tab is unchanged — only ordering/labels/grouping.
//   Financials: Adjust inputs · Valuation · Stress · Score detail (+ Handbook —
//               the principle-band metrics read as financial evaluation)
//   Summary:    Exec summary (narrative) · Mitigants · Findings
//   Data:       Data quality
const WS_TABS: ReadonlyArray<{ key: WSTab; label: string; group: WSGroup }> = [
  { key: 'adjust',      label: 'Adjust inputs', group: 'Financials' },
  { key: 'valuation',   label: 'Valuation',     group: 'Financials' },
  { key: 'stress',      label: 'Stress',        group: 'Financials' },
  { key: 'doctrine',    label: 'Score detail',  group: 'Financials' },
  { key: 'handbook',    label: 'Handbook',      group: 'Financials' },
  { key: 'narrative',   label: 'Exec summary',  group: 'Summary' },
  { key: 'mitigations', label: 'Mitigants',     group: 'Summary' },
  { key: 'findings',    label: 'Findings',      group: 'Summary' },
  { key: 'quality',     label: 'Data quality',  group: 'Data' },
];
const WS_GROUP_ORDER: readonly WSGroup[] = ['Financials', 'Summary', 'Data'];

const eyebrow: React.CSSProperties = { fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.ink3 };

// Server attaches lineageRootId + revisionOrdinal at the route layer (8.7); the
// RenderedAnalysis contract type doesn't declare them yet (intentional: those are
// route-context, not render truth). We read them via this local extension at the
// component boundary rather than widening the FE GetAnalysisResponse type, which
// would ripple through the page state shape unnecessarily for v1.
type RenderedWithLineage = RenderedAnalysis & {
  readonly lineageRootId?: string;
  readonly revisionOrdinal?: number;
};

interface Props {
  readonly data: RenderedAnalysis;
  // Phase 3 (post-7.2) - optional workflow projection + timeline. When present,
  // the view renders the committee status header and timeline panel as additive
  // sections. When absent, the view shows only the rendered analysis as before;
  // backward-compatible with consumer-migration v1.
  readonly workflow?: DealWorkflowState;
  readonly timeline?: CommitteeTimeline;
  // Phase 4 - optional callback the page passes so action buttons can refresh
  // workflow state after a successful POST. Absent in read-only contexts.
  readonly onWorkflowChanged?: () => void;
  // 8.8 — optional callback the page passes so the view can request a refetch
  // of GET /:id after a successful revision save. Absent in read-only contexts;
  // when absent the edit affordance does not render (no point editing if the
  // page can't refresh).
  readonly onRevisionSaved?: () => void | Promise<void>;
  // #31 Commit 3 — handbook engine output for this analysis. null = analysis
  // exists but no eval was produced (pre-Commit-2 deals); undefined = prop not
  // passed (fetch hasn't completed). Both render to "no section."
  readonly handbookEvaluation?: HandbookEvaluation | null;
  // P3b — the URL analysis id (deal id). When present, the WorkbookReadiness
  // panel (advisory intake completeness + always-on Create-workbook CTA) mounts.
  // Absent in contexts that lack the routed id (backward compatible).
  readonly analysisId?: string;
  // Synthetic-fixture guard. True iff this analysis is the seeded DEMO cleared-deal
  // fixture (dealRef 'DEMO-CLEARED-MF-001'), resolved at the page layer via the
  // dealRef→analysisId lookup (the RenderedAnalysis payload carries no dealRef/
  // propertyName). Renders a prominent warning banner so the deal room cannot be
  // screenshotted and mistaken for a real deal. Purely additive; false for real deals.
  readonly synthetic?: boolean;
}

function userCanRevise(role: string | undefined): boolean {
  if (role === undefined) return false;
  const perms = (ROLE_PERMISSIONS as { readonly [k: string]: readonly string[] })[role];
  return perms !== undefined && perms.indexOf('analysis:revise') >= 0;
}

const SEVERITY_TONE: { readonly [K in RenderBadgeSeverity]: { fg: string; bg: string } } = {
  info: { fg: C.contested, bg: '#EAF0F8' },
  warning: { fg: C.flagged, bg: C.amberSoft },
  critical: { fg: C.kicked, bg: '#FBECEB' },
};

function Badge({ badge }: { badge: RenderBadge }): React.ReactElement {
  const tone = SEVERITY_TONE[badge.severity];
  return (
    <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 5, border: `1px solid ${tone.fg}`, color: tone.fg, background: tone.bg }}>
      {badge.label}
    </span>
  );
}

// ── Fix 5 (+ Fix 6, 2026-07-02) — actionable Data-Quality chips ──────────────
// Each DQ flag chip is a button opening an inline action popover with two paths.
// BOTH paths write the SAME persisted `dq:<code>` overlay comment (side:'originator'),
// mirroring NegotiationSurface's postComment EXACTLY:
//   api.createOverlay({ rootId, renderedAnalysisId, overlayKey:'comment:dq:<code>' })
//   → api.postOverlayComment({ overlayId, path:'dq:<code>', text, side:'originator' }).
// The write is persisted, content-hashed, audited and side-attributed. There is NO
// notification endpoint, so ALL confirmation copy says "logged" + "on the originator's
// open-flags list" — NEVER "sent"/"notified"/"delivered"/"resolved".
//   (b) "Flag to originator" — a general "this data is missing" flag.
//   (a) "Request document from originator" — a STRUCTURED request naming the missing
//       DOCUMENT (reframed from the old disabled "Add the data yourself"). It is a
//       request routed to the same open-flags list, NOT a self-entry of a value: keying
//       a scalar without the source document would fabricate an underwriting input.
// The receiving side is BUILD 1's OriginatorOpenFlagsPanel, which reads these back with
// the SAME filter (side==='originator' && path.startsWith('dq:')) — the round-trip.
// The chip keeps its severity styling (P1 tokens). Only the DQ-quality chips get this.

// ── DQ code → the document a missing-doc/incomplete-doc flag asks the originator to
//    supply. Keyed on the missing-doc ledger (apply-judgment-adjustments.ts
//    buildMissingDocLedger) + the incomplete-rent-roll flag. Used to (a) humanize the
//    code for display and (b) name the document in the "Request document" action.
//    A code absent from this map has no known document → the request action hides. ──
const DQ_DOCUMENT_LABEL: { readonly [code: string]: string } = {
  JE_RENT_ROLL_MISSING: 'rent roll',
  JE_RENT_ROLL_UNIT_INCOMPLETE: 'complete rent roll (with per-unit in-place rent and concessions)',
  JE_TRAILING_ACTUALS_MISSING: 'trailing-12 operating statement',
  JE_IN_PLACE_MISSING: 'in-place operating statement',
  JE_LOAN_TERMS_MISSING: 'loan terms / term sheet',
  JE_PCA_MISSING: 'property condition assessment (PCA)',
  JE_APPRAISAL_MISSING: 'appraisal',
};

// ── DQ code → the append-document SLOT the originator uploads to answer the flag.
//    DERIVED from the single doc-type taxonomy (@cre/contracts DQ_CODE_TO_SLOT):
//      rent_roll / pca / appraisal re-extract directly; the T-12 / in-place statement
//      arrives through the `cf` slot (there is no standalone extracting `t12` slot).
//    ★ JE_LOAN_TERMS_MISSING is DELIBERATELY ABSENT — loan terms are request-only
//      (taxonomy slot=null, requestOnly=true), reconstructed from the parent's
//      AdjustedInputs, NOT an uploadable doc. The taxonomy excludes it from
//      DQ_CODE_TO_SLOT by construction (no slot), so the upload action hides and
//      we never offer an unanswerable upload. This is no longer a 4th parallel list.
const DQ_UPLOAD_SLOT: { readonly [code: string]: string } = DQ_CODE_TO_SLOT;

/** Humanize a DQ code (e.g. JE_PCA_MISSING → "PCA missing") for display. Falls back
 *  to a title-cased strip of the JE_ prefix so unknown codes still read cleanly. */
function humanizeDqCode(code: string): string {
  return code
    .replace(/^JE_/, '')
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

type DqFlagState = 'idle' | 'posting' | 'flagged' | 'error';

function DataQualityFlagChip({
  badge,
  rootId,
  renderedAnalysisId,
  alreadyFlagged,
}: {
  badge: RenderBadge;
  rootId: DoctrineEvaluationId;
  renderedAnalysisId: RenderedAnalysisId;
  alreadyFlagged: boolean;
}): React.ReactElement {
  const tone = SEVERITY_TONE[badge.severity];
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DqFlagState>(alreadyFlagged ? 'flagged' : 'idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const documentLabel = DQ_DOCUMENT_LABEL[badge.code];

  // Shared writer — BOTH actions post the SAME `dq:<code>` overlay comment
  // (side:'originator'), the exact shape the OriginatorOpenFlagsPanel reads back.
  // `text` differs only in wording (a general flag vs. a document request); the
  // anchor/path/side are identical, so both land on the originator open-flags list.
  const postDqOverlay = async (text: string): Promise<void> => {
    if (state === 'posting') return;
    setState('posting');
    setErrorMsg(null);
    try {
      // ── Mirror NegotiationSurface.postComment's exact call shape ──
      const path = `dq:${badge.code}`;
      const overlayKey = `comment:${path}`;
      const { overlayId } = await api.createOverlay({
        rootId,
        renderedAnalysisId,
        overlayKey,
      });
      await api.postOverlayComment({
        overlayId,
        path,
        text,
        side: 'originator',
      });
      setState('flagged');
    } catch (e) {
      setErrorMsg((e as Error).message || 'Could not log the flag.');
      setState('error');
    }
  };

  const flagToOriginator = (): Promise<void> =>
    postDqOverlay(`Buyer flagged missing data (${badge.label}) — originator to supply.`);

  const requestDocument = (): Promise<void> =>
    postDqOverlay(
      documentLabel !== undefined
        ? `Document request: please supply the ${documentLabel} (flag ${badge.code}).`
        : `Document request for ${badge.label} (flag ${badge.code}).`,
    );

  const chipLabel = state === 'flagged' ? `${badge.label} — flagged` : badge.label;

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Data-quality flag — click for actions"
        style={{
          display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px',
          borderRadius: 5, border: `1px solid ${tone.fg}`, color: tone.fg, background: tone.bg,
          cursor: 'pointer', font: 'inherit', lineHeight: 1.4,
          textDecoration: state === 'flagged' ? 'none' : undefined,
          opacity: state === 'flagged' ? 0.85 : 1,
        }}
      >
        {state === 'flagged' ? '✓ ' : ''}{chipLabel}
      </button>
      {open ? (
        <div
          role="dialog"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, width: 268,
            background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: 8,
            boxShadow: '0 6px 20px rgba(21,38,44,0.14)', padding: 12, textAlign: 'left',
          }}
        >
          <div style={{ fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: C.ink3, marginBottom: 2 }}>
            Data quality
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 2 }}>{badge.label}</div>
          <div style={{ fontSize: 10, fontFamily: MONO, color: C.ink3, marginBottom: 10 }}>{badge.code}</div>

          {/* Path (b) — REAL persisted write */}
          <button
            type="button"
            onClick={() => { void flagToOriginator(); }}
            disabled={state === 'posting' || state === 'flagged'}
            style={{
              width: '100%', textAlign: 'left', fontSize: 12, fontWeight: 600, padding: '7px 10px',
              borderRadius: 6, border: `1px solid ${C.teal}`, marginBottom: 8,
              background: state === 'flagged' ? C.tealSoft : C.surface,
              color: C.teal, cursor: state === 'posting' || state === 'flagged' ? 'default' : 'pointer',
              opacity: state === 'posting' ? 0.5 : 1,
            }}
          >
            {state === 'posting' ? 'Logging…'
              : state === 'flagged' ? '✓ Logged — on the originator’s open-flags list'
              : 'Flag to originator'}
          </button>
          {state === 'flagged' ? (
            <div style={{ fontSize: 10, color: C.ink3, marginBottom: 8 }}>
              Logged (persisted, attributable) and now appears on the originator’s
              open-flags list for this deal. Not a notification — nothing is sent or
              delivered.
            </div>
          ) : null}
          {state === 'error' && errorMsg !== null ? (
            <div style={{ fontSize: 10, color: C.kicked, marginBottom: 8 }}>{errorMsg}</div>
          ) : null}

          {/* Path (a) — REAL "Request document" write (reframed from the old disabled
              "Add the data yourself"). Writes the SAME dq:<code> overlay as path (b);
              it is a structured REQUEST for the missing document, NOT a value-entry.
              Shown only when the code maps to a known document. */}
          {documentLabel !== undefined ? (
            <>
              <button
                type="button"
                onClick={() => { void requestDocument(); }}
                disabled={state === 'posting' || state === 'flagged'}
                style={{
                  width: '100%', textAlign: 'left', fontSize: 12, fontWeight: 600, padding: '7px 10px',
                  borderRadius: 6, border: `1px solid ${C.borderStrong}`,
                  background: state === 'flagged' ? C.surface2 : C.surface,
                  color: C.ink, cursor: state === 'posting' || state === 'flagged' ? 'default' : 'pointer',
                  opacity: state === 'posting' ? 0.5 : 1,
                }}
              >
                {state === 'flagged'
                  ? '✓ Document request logged'
                  : `Request ${documentLabel} from originator`}
              </button>
              <div style={{ fontSize: 10, color: C.ink3, marginTop: 6 }}>
                Logs a request for the {documentLabel} on the originator’s open-flags
                list. A request, not a self-entry — nothing is keyed in, sent, or
                delivered.
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function DataQualityFlags({
  flags,
  rootId,
  renderedAnalysisId,
}: {
  flags: readonly RenderBadge[];
  rootId: DoctrineEvaluationId;
  renderedAnalysisId: RenderedAnalysisId;
}): React.ReactElement {
  // Optional (recon §4): reflect codes already flagged via an existing `comment:dq:<code>`
  // overlay so a chip shows "flagged". Clean read: api.getOverlayComments returns every
  // persisted comment with its `path` — our anchor path is `dq:<code>`. Best-effort;
  // failure is silent (chips just start un-flagged).
  const [flaggedCodes, setFlaggedCodes] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getOverlayComments(rootId);
        if (cancelled) return;
        const codes = new Set<string>();
        for (const c of res.comments) {
          if (c.path.startsWith('dq:')) codes.add(c.path.slice('dq:'.length));
        }
        setFlaggedCodes(codes);
      } catch {
        /* best-effort read; leave chips un-flagged on failure */
      }
    })();
    return () => { cancelled = true; };
  }, [rootId]);

  return (
    <div className="flex flex-wrap gap-2">
      {flags.map((b) => (
        <DataQualityFlagChip
          key={b.code}
          badge={b}
          rootId={rootId}
          renderedAnalysisId={renderedAnalysisId}
          alreadyFlagged={flaggedCodes.has(b.code)}
        />
      ))}
    </div>
  );
}

// ── BUILD 1 (2026-07-02) — originator-facing OPEN FLAGS panel (the receiving side).
//    Reads back the buyer-written DQ overlays for this deal via getOverlayComments(rootId)
//    and filters with the EXACT SAME shape the buyer action writes:
//        side === 'originator' && path.startsWith('dq:')
//    (the live filter at DataQualityFlags below). Every "Flag to originator" / "Request
//    document" write lands here — this is what makes "the originator sees it" TRUE.
//
//    OPEN flags only. Overlay comments are append-only with NO resolution/status field,
//    so there is no "resolved" state to show or imply. The panel lists open flags only.
//
//    Read-only. No write, no new route, no store. Reuses the existing overlay-comments
//    read. Rendered when the viewer entered the deal as the originator (useSide()==='originator').
interface OpenFlag {
  readonly code: string;
  readonly text: string;
  readonly createdAt: string;
}

// ── Per-flag "Supply the document" action (BUILDs 1-3) ───────────────────────
// The ORIGINATOR-side answer to a buyer's `dq:<code>` request. Reuses api.appendDocument
// verbatim — POST /api/analyses/:id/append-document → re-ingest as a CHILD revision
// (append-only, parent preserved). Frontend-only; no governed touch.
//
// PHASE 1: maps dq:<code> → append slot via DQ_UPLOAD_SLOT (JE_LOAN_TERMS_MISSING has
//   no slot → this component is not rendered for it; the panel shows it request-only).
// PHASE 2: append is fully SYNCHRONOUS (blocks through PDF parse + LLM). We show an
//   HONEST blocking "Processing — this re-runs the underwriting…" state (no fake instant
//   success), then on 201 call onAppended() → the page re-fetches GET /:id so the new
//   child revision + re-derived flags surface.
// PHASE 3: honest outcomes — the flag may re-fire on the child ("deal updated", never
//   "resolved"); a no-op append (empty provenance diff) says "no change"; typed/500
//   errors surface honestly (never green). The 201 body carries childRevisionId +
//   revisionOrdinal as an audit breadcrumb.
type UploadPhase = 'idle' | 'processing' | 'done' | 'error';

function FlagUploadAction({
  analysisId,
  slot,
  documentLabel,
  onAppended,
}: {
  analysisId: string;
  slot: string;
  documentLabel: string;
  onAppended: () => void | Promise<void>;
}): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [outcome, setOutcome] = useState<{ ordinal: number; childId: string } | null>(null);

  const submit = async (): Promise<void> => {
    if (!file || phase === 'processing') return;
    setPhase('processing');
    setErrorMsg('');
    setOutcome(null);
    try {
      const res = await api.appendDocument(analysisId, slot, file);
      if (res.ok) {
        // ★ 201: a NEW child revision exists. The flag does NOT auto-clear here — it
        //   re-derives on the refetched revision. We say "deal updated," never "resolved."
        setOutcome({ ordinal: res.revisionOrdinal, childId: res.childRevisionId });
        setPhase('done');
        setFile(null);
        await onAppended(); // re-fetch GET /:id → advanced child revision + re-derived flags
      } else if (
        res.status === 422 &&
        (res.error === 'no_eval_context' || res.error === 'parent_context_unresolvable')
      ) {
        setErrorMsg("This deal can't accept new documents (created before append support).");
        setPhase('error');
      } else if (res.status === 400 && res.error === 'invalid_slot') {
        setErrorMsg('That document type is not accepted here.');
        setPhase('error');
      } else {
        // 500 append_failed / 404 / other typed errors — honest, not green.
        setErrorMsg('Upload failed — the document could not be processed. Retry.');
        setPhase('error');
      }
    } catch {
      setErrorMsg('Upload failed — the document could not be processed. Retry.');
      setPhase('error');
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <label
        style={{
          fontSize: 11, fontWeight: 600, color: C.amber, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <span>{file ? 'Change file' : `Upload the ${documentLabel}`}</span>
        <input
          type="file"
          disabled={phase === 'processing'}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (phase === 'error' || phase === 'done') { setPhase('idle'); setErrorMsg(''); setOutcome(null); }
          }}
          style={{ display: 'none' }}
        />
      </label>

      {file !== null && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: C.ink2, fontFamily: MONO, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={phase === 'processing'}
            style={{
              fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: phase === 'processing' ? 'default' : 'pointer',
              background: C.amber, color: '#fff', border: 'none', opacity: phase === 'processing' ? 0.6 : 1,
            }}
          >
            {phase === 'processing' ? 'Processing…' : 'Submit & re-underwrite'}
          </button>
        </div>
      )}

      {/* ★ Score-can-move disclosure — a CONFIDENT feature, not a warning. */}
      <div style={{ fontSize: 10, color: C.ink3, marginTop: 6, lineHeight: 1.4 }}>
        Uploading re-runs the underwriting on a new revision — the score and flags may
        change as the analysis responds to new information. It is an auditable new child
        revision, not a silent rewrite.
      </div>

      {phase === 'processing' && (
        <div style={{ fontSize: 11, color: C.ink2, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="animate-spin" style={{ width: 12, height: 12, border: `2px solid ${C.amber}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block' }} />
          Processing — this re-runs the underwriting, may take a moment.
        </div>
      )}

      {phase === 'done' && outcome !== null && (
        <div style={{ fontSize: 11, color: C.resolved, marginTop: 6, lineHeight: 1.4 }}>
          Document added — deal updated (revision #{outcome.ordinal}). The analysis was
          re-underwritten; the flags above have been re-derived on the new revision. If a
          flag remains, the document did not supply the expected field.
          <div style={{ fontSize: 9.5, fontFamily: MONO, color: C.ink3, marginTop: 2 }}>
            child {outcome.childId.slice(0, 8)}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div style={{ fontSize: 11, color: C.kicked, marginTop: 6 }}>{errorMsg}</div>
      )}
    </div>
  );
}

function OriginatorOpenFlagsPanel(
  { rootId, analysisId, onAppended }: {
    rootId: DoctrineEvaluationId;
    // The routed deal id — required to call append-document. Absent in contexts without
    // the routed id → upload actions hide (the panel stays read-only, backward compatible).
    analysisId?: string;
    // Page-level refetch (GET /:id) so the advanced child revision + re-derived flags
    // surface after an append. Same callback the revision-save path uses.
    onAppended?: () => void | Promise<void>;
  },
): React.ReactElement {
  const [flags, setFlags] = useState<readonly OpenFlag[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getOverlayComments(rootId);
        if (cancelled) return;
        // ★ SAME filter shape as the buyer write (side:'originator', path:'dq:<code>').
        const open: OpenFlag[] = [];
        for (const c of res.comments) {
          if (c.side === 'originator' && c.path.startsWith('dq:')) {
            open.push({ code: c.path.slice('dq:'.length), text: c.text, createdAt: c.createdAt });
          }
        }
        setFlags(open);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    // Re-read the flags whenever the revision advances (rootId changes after an append),
    // so the panel reflects the re-derived flag state on the child.
    return () => { cancelled = true; };
  }, [rootId]);

  return (
    <div style={{ border: `1px solid ${C.amber}`, borderRadius: 12, background: C.amberSoft, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ ...eyebrow, color: C.amber }}>Open flags for this deal</div>
        <div style={{ fontSize: 11, color: C.ink2, marginTop: 2 }}>
          Data-quality flags and document requests logged by the buyer for you to address.
          Supply the requested document to re-underwrite the deal. Append-only — there is
          no resolved state; the flags re-derive on the new revision.
        </div>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {failed ? (
          <div style={{ fontSize: 12, color: C.ink3 }}>Could not load open flags.</div>
        ) : flags === null ? (
          <div style={{ fontSize: 12, color: C.ink3 }}>Loading…</div>
        ) : flags.length === 0 ? (
          <div style={{ fontSize: 12, color: C.ink3 }}>No open flags. Nothing has been flagged for you on this deal.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {flags.map((f, i) => {
              const slot = DQ_UPLOAD_SLOT[f.code];
              const documentLabel = DQ_DOCUMENT_LABEL[f.code] ?? humanizeDqCode(f.code);
              const canUpload = slot !== undefined && analysisId !== undefined && onAppended !== undefined;
              return (
                <li key={f.code + ':' + i} style={{ borderLeft: `3px solid ${C.amber}`, paddingLeft: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{humanizeDqCode(f.code)}</div>
                  <div style={{ fontSize: 9.5, fontFamily: MONO, color: C.ink3 }}>{f.code}</div>
                  <div style={{ fontSize: 12, color: C.ink2, marginTop: 3 }}>{f.text}</div>
                  <div style={{ fontSize: 10, color: C.ink3, marginTop: 3 }}>
                    {(() => { const d = new Date(f.createdAt); return Number.isNaN(d.getTime()) ? f.createdAt : d.toLocaleString(); })()}
                  </div>
                  {canUpload ? (
                    <FlagUploadAction
                      analysisId={analysisId!}
                      slot={slot!}
                      documentLabel={documentLabel}
                      onAppended={onAppended!}
                    />
                  ) : slot === undefined ? (
                    // ★ JE_LOAN_TERMS_MISSING & any code with no uploadable slot — request-only.
                    <div style={{ fontSize: 10, color: C.ink3, marginTop: 6, fontStyle: 'italic' }}>
                      No document upload — this request is answered outside the document intake.
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Cell({ label, displayValue }: { label: string; displayValue: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 12, border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
      <span style={eyebrow}>{label}</span>
      <span style={{ ...num(C.ink), fontSize: 18, fontWeight: 600 }}>{displayValue}</span>
    </div>
  );
}

/** Sticky-rail metric tile (compact, tabular-nums). */
function RailMetric({ label, displayValue }: { label: string; displayValue: string }): React.ReactElement {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface2, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: C.ink3 }}>{label}</div>
      <div style={{ ...num(C.ink), fontSize: 16, fontWeight: 600, marginTop: 2 }}>{displayValue}</div>
    </div>
  );
}

/** Score donut — reads the server's finalScore displayValue (never re-derives). The
 *  ring fills to `pct` (finalScore value 0..100 when numeric; else an empty ring). The
 *  center prints the server displayValue string verbatim so no re-formatting happens. */
function ScoreDonut({ finalScoreValue, finalScoreDisplay, band, accent }: {
  finalScoreValue: number | null; finalScoreDisplay: string; band: string; accent: string;
}): React.ReactElement {
  const pct = finalScoreValue != null && Number.isFinite(finalScoreValue)
    ? Math.max(0, Math.min(100, finalScoreValue)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
      <div style={{ width: 84, height: 84, borderRadius: '50%', flexShrink: 0, background: `conic-gradient(${accent} ${pct}%, ${C.border} ${pct}% 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: C.surface, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ ...num(C.ink), fontFamily: DISPLAY, fontSize: 19, fontWeight: 700, lineHeight: 1 }}>{finalScoreDisplay}</span>
          <span style={{ fontSize: 9, color: C.ink3 }}>/ 100</span>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{band}</div>
        <div style={{ fontSize: 11, color: C.ink3 }}>rating band</div>
      </div>
    </div>
  );
}

// =============================================================================
// HandbookEvaluation rendering helpers (#31 Commit 3)
// =============================================================================

function formatMetricValue(value: FieldValue): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const fixed = value.toFixed(3);
    return fixed.replace(/\.?0+$/, '') || '0';
  }
  if (Array.isArray(value)) {
    return value.map((v) => formatMetricValue(v as FieldValue)).join(', ');
  }
  return String(value);
}

function filterSkipsForDisplay(
  skips: readonly SkippedPrinciple[],
): readonly SkippedPrinciple[] {
  return skips.filter((s) => s.reason === 'missing_field');
}

type HandbookSeverity = 'critical' | 'high' | 'medium' | 'advisory';

function severityToBadgeTone(severity: HandbookSeverity): RenderBadgeSeverity {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'critical';
    case 'medium':
      return 'warning';
    case 'advisory':
      return 'info';
  }
}

const HANDBOOK_SEVERITY_RANK: Record<HandbookSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  advisory: 3,
};

function sortFiredFlagsForDisplay(
  flags: readonly FiredFlag[],
): readonly FiredFlag[] {
  const indexed = flags.map((flag, i) => ({ flag, i }));
  indexed.sort((a, b) => {
    const rankDiff =
      HANDBOOK_SEVERITY_RANK[a.flag.severity] - HANDBOOK_SEVERITY_RANK[b.flag.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.i - b.i;
  });
  return indexed.map((x) => x.flag);
}

function HandbookEvaluationSection(
  { evaluation }: { evaluation: HandbookEvaluation },
): React.ReactElement {
  const sortedFlags = sortFiredFlagsForDisplay(evaluation.firedFlags);
  const displaySkips = filterSkipsForDisplay(evaluation.skippedPrinciples);
  const totalSkips = evaluation.skippedPrinciples.length;

  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
        Handbook Says
      </h2>

      {sortedFlags.length > 0 && (
        <div className="overflow-x-auto border border-gray-200 rounded bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Severity</th>
                <th className="px-3 py-2 text-left font-medium">Principle</th>
                <th className="px-3 py-2 text-left font-medium">Metric</th>
                <th className="px-3 py-2 text-left font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {sortedFlags.map((flag, i) => (
                <tr
                  key={flag.principleId + ':' + flag.groupIndex + ':' + flag.bandIndex + ':' + i}
                  className="border-t border-gray-100"
                >
                  <td className="px-3 py-2">
                    <Badge
                      badge={{
                        code: flag.principleId + ':' + flag.groupIndex + ':' + flag.bandIndex,
                        label: flag.severity,
                        severity: severityToBadgeTone(flag.severity as HandbookSeverity),
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{flag.principleId}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-900">
                    {formatMetricValue(flag.metricValue)}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{flag.flag_message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sortedFlags.length === 0 && (
        <p className="text-sm text-gray-500 italic">No flags fired.</p>
      )}

      {displaySkips.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide font-semibold text-gray-500">
            Data Gaps ({displaySkips.length} missing-data {displaySkips.length === 1 ? 'skip' : 'skips'} of {totalSkips} total)
          </h3>
          <div className="overflow-x-auto border border-gray-200 rounded bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Principle</th>
                  <th className="px-3 py-2 text-left font-medium">Missing</th>
                </tr>
              </thead>
              <tbody>
                {displaySkips.map((skip, i) => (
                  <tr
                    key={skip.principleId + ':' + i}
                    className="border-t border-gray-100"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-gray-600">{skip.principleId}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-900">{skip.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Evaluated against handbook v{evaluation.handbookVersion} (engine {evaluation.engineVersion})
        {' · '}
        {new Date(evaluation.analysisAsOfDate).toISOString().slice(0, 10)}
      </p>
    </section>
  );
}

// Mitigations doctrine v1 output (render version 7.9). Bijective passthrough of
// RenderedAnalysis.mitigations[] — one card per structured MitigationProposal.
// reduce_proceeds proposals render a before/after metric table (concluded-model
// snapshot vs. counterfactual-recalc snapshot) and the required-equity line.
// fund_reserve proposals render the required-reserve dollars and the coverage
// statement. Mounted ABOVE NarrativeSection so structured proposals lead and
// the Piece A prose substantiates them. Renders nothing when the array is empty
// (commit 1 ships with empty arrays for all deals; commit 2 wires the producer).
function MitigationsSection(
  { proposals, dataConfidence }: {
    proposals: readonly RenderedMitigationProposal[];
    dataConfidence: DataConfidence;
  },
): React.ReactElement | null {
  if (proposals.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
        Mitigations
      </h2>
      {/* Render v7.12 — caveat banner (NOT suppress). The cards still
        illustrate "if these held, here's the structuring fix" but the
        unvalidated inputs they were sized off of need replacement first. */}
      {dataConfidence === 'unvalidated' ? (
        <div className="border-l-4 border-amber-500 bg-amber-50 p-3 rounded text-sm text-amber-800">
          Sized off unvalidated metrics — re-run after obtaining the documents noted in the recommendation.
        </div>
      ) : null}
      <div className="space-y-3">
        {proposals.map((p) => (
          <div key={p.id} className="border border-gray-200 rounded bg-white p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">{p.title}</h3>
              <Badge
                badge={{
                  code: p.lever,
                  label: p.severity,
                  severity: p.severity === 'critical' || p.severity === 'high'
                    ? 'warning' as RenderBadgeSeverity
                    : 'info' as RenderBadgeSeverity,
                }}
              />
              {p.targetMetric !== null ? (
                <span className="font-mono text-xs text-gray-500">
                  binding: {p.targetMetric}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-gray-700">{p.description}</p>
            {p.structuralChanges.length > 0 ? (
              <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5">
                {p.structuralChanges.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : null}
            {p.leverKind === 'recalc_delta' && p.recalcBefore !== null && p.recalcAfter !== null ? (
              <div className="overflow-x-auto border border-gray-100 rounded">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Metric</th>
                      <th className="px-3 py-2 text-right font-medium">Before</th>
                      <th className="px-3 py-2 text-right font-medium">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-gray-100">
                      <td className="px-3 py-1.5 text-gray-700">DSCR</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcBefore.dscr.displayValue}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcAfter.dscr.displayValue}</td>
                    </tr>
                    <tr className="border-t border-gray-100">
                      <td className="px-3 py-1.5 text-gray-700">LTV</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcBefore.ltv.displayValue}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcAfter.ltv.displayValue}</td>
                    </tr>
                    <tr className="border-t border-gray-100">
                      <td className="px-3 py-1.5 text-gray-700">Debt Yield</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcBefore.debtYield.displayValue}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcAfter.debtYield.displayValue}</td>
                    </tr>
                    <tr className="border-t border-gray-100">
                      <td className="px-3 py-1.5 text-gray-700">Implied Value</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcBefore.impliedValue.displayValue}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.recalcAfter.impliedValue.displayValue}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-4 text-xs">
              {p.requiredEquity.value !== null ? (
                <div>
                  <span className="text-gray-500">Required Equity: </span>
                  <span className="font-mono text-gray-900">{p.requiredEquity.displayValue}</span>
                </div>
              ) : null}
              {p.requiredReserve.value !== null ? (
                <div>
                  <span className="text-gray-500">Required Reserve: </span>
                  <span className="font-mono text-gray-900">{p.requiredReserve.displayValue}</span>
                </div>
              ) : null}
              {p.coverageStatement !== null ? (
                <div className="text-gray-700 italic">{p.coverageStatement}</div>
              ) : null}
              <div>
                <span className="text-gray-500">Risk reduction: </span>
                <span className="text-gray-900">{p.riskReduction}</span>
              </div>
            </div>
            {p.principleIds.length > 0 ? (
              <div className="text-xs text-gray-500">
                Addresses:{' '}
                {p.principleIds.map((id, i) => (
                  <span key={id + ':' + i} className="font-mono">
                    {i > 0 ? ', ' : ''}{id}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// Piece A narrative output. Bijective passthrough of RenderedAnalysis.narrative —
// four slots composed by the narrative engine: executive_summary, red_flag_assessment,
// mitigation_suggestions, committee_recommendation. Renders nothing when the analysis
// has no narrative attached (pre-Piece-A deals or composition failure).
//
// `whitespace-pre-line` preserves the \n separators in bulleted slot prose
// (red_flag_assessment / mitigation_suggestions ship as "- [P-XX] …\n- …" strings;
// executive_summary / committee_recommendation are paragraph form). Render must NOT
// re-format, re-rank, or merge slots per the RD2 / read-pole discipline.
function NarrativeSection(
  { narrative }: { narrative: RenderedNarrativeSection | null },
): React.ReactElement | null {
  if (narrative === null) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
        Narrative
      </h2>
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide font-semibold text-gray-500">
            Executive Summary
          </h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">
            {narrative.executiveSummary}
          </p>
        </div>
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide font-semibold text-gray-500">
            Red Flag Assessment
          </h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">
            {narrative.redFlagAssessment}
          </p>
        </div>
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide font-semibold text-gray-500">
            Mitigation Suggestions
          </h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">
            {narrative.mitigationSuggestions}
          </p>
        </div>
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide font-semibold text-gray-500">
            Committee Recommendation
          </h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">
            {narrative.committeeRecommendation}
          </p>
        </div>
      </div>
      <p className="text-xs text-gray-400">
        Composed by narrative engine v{narrative.engineVersion}
      </p>
    </section>
  );
}

function FindingsList(
  { findings }: { findings: readonly RenderedFinding[] },
): React.ReactElement {
  // D04: producer-owned semantics, rendered exactly as materialized. Order preserved
  // from the producer's reasons[] array. No grouping, no severity reconstruction, no
  // dynamic prioritization, no "smart summaries" - this is a deterministic display
  // of the doctrine's bounded explainability ledger.
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Findings</h2>
      <div className="overflow-x-auto border border-gray-200 rounded bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Rule</th>
              <th className="px-3 py-2 text-left font-medium">Reason Code</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={f.ruleId + ':' + f.reasonCode + ':' + i} className="border-t border-gray-100">
                <td className="px-3 py-2 font-mono text-xs text-gray-600">{f.ruleId}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-900">{f.reasonCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StressScenarioTable(
  { method, scenarios }: { method: string; scenarios: readonly RenderedStressScenario[] },
): React.ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">
        Stress Scenarios <span className="font-mono text-xs text-gray-500">[{method}]</span>
      </h2>
      <div className="overflow-x-auto border border-gray-200 rounded bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Scenario</th>
              <th className="px-3 py-2 text-right font-medium">NOI</th>
              <th className="px-3 py-2 text-right font-medium">DSCR</th>
              <th className="px-3 py-2 text-right font-medium">Value</th>
              <th className="px-3 py-2 text-right font-medium">LTV</th>
              <th className="px-3 py-2 text-right font-medium">Debt Yield</th>
              <th className="px-3 py-2 text-left font-medium">Breaches</th>
              <th className="px-3 py-2 text-left font-medium">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.name} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2 font-medium text-gray-900">{s.name}</td>
                <td className="px-3 py-2 text-right text-gray-900">{s.noi.displayValue}</td>
                <td className="px-3 py-2 text-right text-gray-900">{s.dscr.displayValue}</td>
                <td className="px-3 py-2 text-right text-gray-900">{s.value.displayValue}</td>
                <td className="px-3 py-2 text-right text-gray-900">{s.ltv.displayValue}</td>
                <td className="px-3 py-2 text-right text-gray-900">{s.debtYield.displayValue}</td>
                <td className="px-3 py-2">
                  {s.breaches.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {s.breaches.map((b) => <Badge key={b.code} badge={b} />)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  {s.skipped.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {s.skipped.map((b) => <Badge key={b.code} badge={b} />)}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LineItemTable(
  { title, lines }: { title: string; lines: readonly RenderedLineItem[] },
): React.ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">{title}</h2>
      <div className="overflow-x-auto border border-gray-200 rounded bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Line</th>
              <th className="px-3 py-2 text-right font-medium">Raw</th>
              <th className="px-3 py-2 text-right font-medium">Adjusted</th>
              <th className="px-3 py-2 text-left font-medium">Source</th>
              <th className="px-3 py-2 text-left font-medium">Adjustments</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((li) => (
              <tr key={li.name} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2 font-medium text-gray-900">{li.name}</td>
                <td className="px-3 py-2 text-right text-gray-900">{li.raw.displayValue}</td>
                <td className="px-3 py-2 text-right text-gray-900">{li.adjusted.displayValue}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-600">{li.source}</td>
                <td className="px-3 py-2">
                  {li.adjustments.length > 0 ? (
                    <ul className="space-y-1">
                      {li.adjustments.map((a, i) => (
                        <li key={a.ruleId + ':' + i} className="text-xs">
                          <span className="font-mono text-gray-600">{a.ruleId}</span>
                          <span className="text-gray-500"> ({a.delta.displayValue})</span>
                          <span className="text-gray-700"> — {a.reason}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Edit-mode-aware variant of LineItemTable. Renders inputs for editable paths; falls
 *  back to display values for derived rollups and non-editable fields. */
function EditableLineItemTable(
  { section, title, lines, editMode, pendingEdits, onFieldChange }: {
    section: 'income' | 'expenses' | 'loan' | 'assumptions';
    title: string;
    lines: readonly RenderedLineItem[];
    editMode: boolean;
    pendingEdits: ReadonlyMap<string, number>;
    onFieldChange: (path: string, backendValue: number) => void;
  },
): React.ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">{title}</h2>
      <div className="overflow-x-auto border border-gray-200 rounded bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Line</th>
              <th className="px-3 py-2 text-right font-medium">Raw</th>
              <th className="px-3 py-2 text-right font-medium">Adjusted</th>
              <th className="px-3 py-2 text-left font-medium">Source</th>
              <th className="px-3 py-2 text-left font-medium">Adjustments</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((li) => {
              const path = buildPath(section, li.name);
              const editable = editMode && isEditablePath(path);
              return (
                <tr key={li.name} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2 font-medium text-gray-900">{li.name}</td>
                  <td className="px-3 py-2 text-right text-gray-900">{li.raw.displayValue}</td>
                  <td className="px-3 py-2 text-right text-gray-900">
                    {editable
                      ? <EditCell
                          path={path}
                          parentBackendValue={li.adjusted.value ?? 0}
                          pendingBackendValue={pendingEdits.get(path)}
                          onFieldChange={onFieldChange}
                        />
                      : li.adjusted.displayValue}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{li.source}</td>
                  <td className="px-3 py-2">
                    {li.adjustments.length > 0 ? (
                      <ul className="space-y-1">
                        {li.adjustments.map((a, i) => (
                          <li key={a.ruleId + ':' + i} className="text-xs">
                            <span className="font-mono text-gray-600">{a.ruleId}</span>
                            <span className="text-gray-500"> ({a.delta.displayValue})</span>
                            <span className="text-gray-700"> — {a.reason}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
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

function EditCell(
  { path, parentBackendValue, pendingBackendValue, onFieldChange }: {
    path: string;
    parentBackendValue: number;
    pendingBackendValue: number | undefined;
    onFieldChange: (path: string, backendValue: number) => void;
  },
): React.ReactElement {
  const backendValue = pendingBackendValue !== undefined ? pendingBackendValue : parentBackendValue;
  const uiValue = pathToUiUnit(path, backendValue);
  const unitLabel = pathUnitLabel(path);
  return (
    <div className="flex items-center justify-end gap-2">
      <input
        type="number"
        defaultValue={Number.isFinite(uiValue) ? uiValue : 0}
        step={pathInputStep(path)}
        onChange={(e) => {
          const ui = parseFloat(e.target.value);
          if (!Number.isFinite(ui)) return;
          onFieldChange(path, uiUnitToBackend(path, ui));
        }}
        className="w-32 px-2 py-1 text-right text-sm border border-gray-300 rounded font-mono"
      />
      <span className="text-xs text-gray-500 min-w-[3rem]">{unitLabel}</span>
    </div>
  );
}

export function RenderedAnalysisView({ data, workflow, timeline, onWorkflowChanged, onRevisionSaved, handbookEvaluation, analysisId, synthetic }: Props): React.ReactElement {
  const { user } = useAuth();
  const side = useSide();
  const sideC = sideAccentC(side);
  const canRevise = userCanRevise(user?.role);
  const editAvailable = canRevise && onRevisionSaved !== undefined;

  // 8.7 attaches lineageRootId + revisionOrdinal at the route layer; read defensively.
  const dataWithLineage = data as RenderedWithLineage;
  const lineageRootId = dataWithLineage.lineageRootId;

  const [editMode, setEditMode] = useState<boolean>(false);
  const [pendingEdits, setPendingEdits] = useState<Map<string, number>>(() => new Map());
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving'>('idle');
  const [saveError, setSaveError] = useState<{ message: string; code?: string; path?: string } | null>(null);
  // Tabbed workspace drawer — the deep read-only sections behind tabs (Stage 3).
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WSTab>('adjust');
  // Fix 4 — inline exec summary on the main page (click-to-expand). Reads the SAME
  // rendered narrative already on the page; the DEEP breakdown stays in the drawer's
  // Exec-summary tab. Default-open so the story leads.
  const [summaryOpen, setSummaryOpen] = useState(true);

  // beforeunload guard: prompt if the analyst tries to navigate away with unsaved edits.
  useEffect(() => {
    if (pendingEdits.size === 0) return;
    const handler = (e: BeforeUnloadEvent): string => {
      e.preventDefault();
      // Modern browsers ignore the returned string and show their own message; setting
      // returnValue is still required to trigger the prompt.
      e.returnValue = 'You have unsaved changes. Leave anyway?';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pendingEdits]);

  const handleEditToggle = useCallback((): void => {
    setSaveError(null);
    setPendingEdits(new Map());
    setEditMode(true);
    // The editable line-item tables now live in the workspace drawer's Adjust tab;
    // open it (on that tab) so entering edit mode surfaces the editor immediately.
    setWorkspaceTab('adjust');
    setWorkspaceOpen(true);
  }, []);

  const handleCancel = useCallback((): void => {
    setPendingEdits(new Map());
    setSaveError(null);
    setEditMode(false);
  }, []);

  const handleFieldChange = useCallback((path: string, backendValue: number): void => {
    setPendingEdits((prev) => {
      const next = new Map(prev);
      next.set(path, backendValue);
      return next;
    });
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    // No-op short-circuit at the UI level: skip the round-trip if the analyst didn't change anything.
    if (pendingEdits.size === 0) {
      setEditMode(false);
      return;
    }
    if (lineageRootId === undefined) {
      setSaveError({ message: 'Cannot save: this view is missing lineageRootId (server did not attach it).' });
      return;
    }
    setSaveStatus('saving');
    setSaveError(null);
    const overrides = Array.from(pendingEdits.entries()).map(([path, value]) => ({ path, value }));
    try {
      await api.createGraphRevision(lineageRootId, overrides);
      // Re-fetch happens in the page; clear local edit state and exit edit mode FIRST so
      // beforeunload doesn't fire during the await.
      setPendingEdits(new Map());
      setEditMode(false);
      setSaveStatus('idle');
      if (onRevisionSaved !== undefined) {
        await onRevisionSaved();
      }
    } catch (e) {
      setSaveStatus('idle');
      // Try to extract structured error fields from the response body.
      const err = e as Error & { code?: string; path?: string; message?: string };
      setSaveError({
        message: err.message ?? 'Save failed',
        code: err.code,
        path: err.path,
      });
    }
  }, [pendingEdits, lineageRootId, onRevisionSaved]);

  // ── Data-driven tab availability (a tab shows only when its data is non-empty).
  //    'adjust' is always available (the line-item/loan/assumptions tables + edit
  //    path); the rest gate on their section content. ────────────────────────────
  const wsAvail: Record<WSTab, boolean> = {
    adjust: true,
    stress: data.stress.scenarios.length > 0,
    valuation: true,
    doctrine: true,
    handbook: handbookEvaluation !== undefined && handbookEvaluation !== null,
    mitigations: data.mitigations.length > 0,
    narrative: data.narrative !== null,
    findings: data.findings.length > 0,
    quality: data.dataQuality.flags.length > 0,
  };
  const availableTabs = WS_TABS.filter((t) => wsAvail[t.key]);
  const effectiveTab: WSTab = availableTabs.some((t) => t.key === workspaceTab) ? workspaceTab : (availableTabs[0]?.key ?? 'adjust');

  // The editable line-item tables (income / expenses / loan / assumptions) — moved
  // WHOLE into the 'adjust' tab. Same component, same handleFieldChange / handleSave /
  // edit-mode / api.createGraphRevision path (persistence rides in unchanged).
  const adjustTables = (
    <div className="space-y-6">
      <EditableLineItemTable
        section="income"
        title="Income Lines"
        lines={data.incomeLines}
        editMode={editMode}
        pendingEdits={pendingEdits}
        onFieldChange={handleFieldChange}
      />
      <EditableLineItemTable
        section="expenses"
        title="Expense Lines"
        lines={data.expenseLines}
        editMode={editMode}
        pendingEdits={pendingEdits}
        onFieldChange={handleFieldChange}
      />
      {/*
        Loan terms (D21 / render version 7.0). The contract is a named-field struct
        (not an array), so we hand-build the explicit list of items to render via the
        same table. This is NOT Object.keys iteration: the field order and identity
        are encoded in source per the locked invariant. maturityBalance + debtServiceAnnual
        are derived fields; they appear in the table but are NOT editable.
      */}
      <EditableLineItemTable
        section="loan"
        title="Loan Terms"
        lines={[
          data.loan.loanAmount,
          data.loan.interestRate,
          data.loan.termMonths,
          data.loan.amortizationMonths,
          data.loan.ioPeriodMonths,
          data.loan.maturityBalance,
          data.loan.debtServiceAnnual,
        ]}
        editMode={editMode}
        pendingEdits={pendingEdits}
        onFieldChange={handleFieldChange}
      />
      {/* Assumptions section — render version 7.3 (#24). All four paths editable. */}
      <EditableLineItemTable
        section="assumptions"
        title="Assumptions"
        lines={[
          data.assumptions.capRate,
          data.assumptions.terminalCapRate,
          data.assumptions.rentGrowthPct,
          data.assumptions.expenseGrowthPct,
        ]}
        editMode={editMode}
        pendingEdits={pendingEdits}
        onFieldChange={handleFieldChange}
      />
    </div>
  );

  const tabBody = (t: WSTab): React.ReactElement | null => {
    switch (t) {
      case 'adjust':
        return adjustTables;
      case 'stress':
        return data.stress.scenarios.length > 0
          ? <StressScenarioTable method={data.stress.method} scenarios={data.stress.scenarios} />
          : null;
      case 'valuation':
        return (
          <section className="space-y-3">
            <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Valuation</h2>
            <div className="grid grid-cols-2 gap-3">
              <Cell label="Final Value" displayValue={data.valuation.finalValue.displayValue} />
              <Cell label="Anchor" displayValue={data.valuation.anchorUsed.displayValue} />
            </div>
          </section>
        );
      case 'doctrine':
        return (
          <div className="space-y-6">
            <section className="space-y-3">
              <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Doctrine</h2>
              <div className="grid grid-cols-2 gap-3">
                <Cell label="Mechanical Score" displayValue={data.doctrine.mechanicalScore.displayValue} />
                <Cell label="Weighted Aggregate" displayValue={data.doctrine.weightedAggregate.displayValue} />
              </div>
              {data.doctrine.flags.length > 0 ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  {data.doctrine.flags.map((b) => <Badge key={b.code} badge={b} />)}
                </div>
              ) : null}
            </section>
            {data.doctrine.components.length > 0 ? (
              <section className="space-y-3">
                <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Component Breakdown</h2>
                <div className="overflow-x-auto border border-gray-200 rounded bg-white">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Component</th>
                        <th className="px-3 py-2 text-left font-medium">Rule</th>
                        <th className="px-3 py-2 text-right font-medium">Raw</th>
                        <th className="px-3 py-2 text-right font-medium">Score</th>
                        <th className="px-3 py-2 text-right font-medium">Weight</th>
                        <th className="px-3 py-2 text-right font-medium">Contribution</th>
                        <th className="px-3 py-2 text-left font-medium">Reasons</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.doctrine.components.map((c) => (
                        <tr key={c.ruleId + ':' + c.name} className="border-t border-gray-100">
                          <td className="px-3 py-2 font-medium text-gray-900">{c.name}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-600">{c.ruleId}</td>
                          <td className="px-3 py-2 text-right text-gray-900">{c.rawValue.displayValue}</td>
                          <td className="px-3 py-2 text-right text-gray-900">{c.score.displayValue}</td>
                          <td className="px-3 py-2 text-right text-gray-900">{c.weight.displayValue}</td>
                          <td className="px-3 py-2 text-right text-gray-900">{c.contribution.displayValue}</td>
                          <td className="px-3 py-2">
                            {c.reasonCodes.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {c.reasonCodes.map((b) => <Badge key={b.code} badge={b} />)}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        );
      case 'handbook':
        return handbookEvaluation !== undefined && handbookEvaluation !== null
          ? <HandbookEvaluationSection evaluation={handbookEvaluation} />
          : null;
      case 'mitigations':
        return <MitigationsSection proposals={data.mitigations} dataConfidence={data.summary.dataConfidence.value ?? 'validated'} />;
      case 'narrative':
        return <NarrativeSection narrative={data.narrative} />;
      case 'findings':
        return data.findings.length > 0 ? <FindingsList findings={data.findings} /> : null;
      case 'quality':
        return data.dataQuality.flags.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Data Quality</h2>
            <DataQualityFlags flags={data.dataQuality.flags} rootId={data.rootId} renderedAnalysisId={data.id} />
          </section>
        ) : null;
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: SANS }}>
      {/* Synthetic-fixture banner. Renders ONLY for the seeded DEMO cleared-deal
          fixture (never for a real deal — `synthetic` is resolved at the page layer
          from the DEMO dealRef). Deliberately loud + sticky so a screenshot of the
          deal room can never be mistaken for a real underwriting. Full-bleed, above
          everything (survives the split-page re-layout). */}
      {synthetic ? (
        <div
          role="alert"
          className="sticky top-0 z-30 border-2 border-red-600 bg-red-600 text-white px-4 py-3 shadow-md flex items-center gap-3"
        >
          <span className="text-lg leading-none" aria-hidden="true">⚠</span>
          <div className="text-sm font-bold uppercase tracking-wide">
            DEMO — SYNTHETIC FIXTURE (not for underwriting)
          </div>
          <div className="text-xs font-normal opacity-90 ml-auto hidden sm:block">
            This deal was generated to exercise the cleared→closed flow. It is not a real loan.
          </div>
        </div>
      ) : null}

      {/* ── Header bar (full-bleed white, hairline bottom) ─────────────────────── */}
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: '14px 24px' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, color: C.ink }}>Analysis</span>
            <span style={{ fontSize: 11, color: C.ink3, fontFamily: MONO }}>#{data.rootId.slice(0, 8)}</span>
            {dataWithLineage.revisionOrdinal !== undefined && dataWithLineage.revisionOrdinal > 0 ? (
              <span style={{ fontSize: 11, fontWeight: 600, color: C.ink2, background: C.surface2, border: `1px solid ${C.borderStrong}`, borderRadius: 999, padding: '2px 10px' }}>
                Revision {dataWithLineage.revisionOrdinal}
              </span>
            ) : null}
            <span style={{ fontSize: 11, fontWeight: 600, color: sideC.accent, background: sideC.soft, border: `1px solid ${C.border}`, borderRadius: 999, padding: '2px 10px' }}>{sideC.label}</span>
          </div>
          {editAvailable ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {editMode ? (
                <>
                  <button type="button" onClick={handleCancel} disabled={saveStatus === 'saving'}
                    style={{ fontSize: 13, fontWeight: 500, padding: '6px 14px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.ink2, opacity: saveStatus === 'saving' ? 0.4 : 1 }}>
                    Cancel
                  </button>
                  <button type="button" onClick={() => { void handleSave(); }} disabled={saveStatus === 'saving'}
                    style={{ fontSize: 13, fontWeight: 600, padding: '6px 14px', borderRadius: 7, cursor: 'pointer', border: 'none', background: C.teal, color: '#fff', opacity: saveStatus === 'saving' ? 0.4 : 1 }}>
                    {saveStatus === 'saving' ? 'Saving...' : 'Save Changes'}
                  </button>
                </>
              ) : (
                <button type="button" onClick={handleEditToggle}
                  style={{ fontSize: 13, fontWeight: 600, padding: '6px 14px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${C.teal}`, background: C.surface, color: C.teal }}>
                  Edit Underwriting
                </button>
              )}
            </div>
          ) : null}
        </div>
        <div style={{ maxWidth: 1180, margin: '2px auto 0', fontSize: 10, color: C.ink3, fontFamily: MONO }}>
          rootId: {data.rootId} · renderVersion: {data.metadata.renderVersion}
        </div>
      </header>

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 24px' }}>
        {saveError !== null ? (
          <div style={{ border: `1px solid ${C.kicked}`, background: '#FBECEB', color: C.kicked, borderRadius: 8, padding: 12, fontSize: 13, marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>Could not save changes</div>
            {saveError.code !== undefined ? (
              <div style={{ fontFamily: MONO, fontSize: 11 }}>{saveError.code}{saveError.path !== undefined ? ` @ ${saveError.path}` : ''}</div>
            ) : null}
            <div>{saveError.message}</div>
          </div>
        ) : null}

        {/* Committee status + action buttons + snapshot — full-width above the split. */}
        {workflow !== undefined ? <div style={{ marginBottom: 12 }}><CommitteeStatusHeader workflow={workflow} /></div> : null}
        {workflow !== undefined && onWorkflowChanged !== undefined && !editMode ? (
          <div style={{ marginBottom: 12 }}>
            <CommitteeActionButtons
              rootId={data.rootId}
              renderedAnalysisId={data.id}
              workflow={workflow}
              onActionSubmitted={onWorkflowChanged}
            />
          </div>
        ) : null}
        {workflow !== undefined ? <div style={{ marginBottom: 12 }}><SnapshotViewer workflow={workflow} /></div> : null}

        {/* ── Doctrine banners (full-bleed, above the split — unchanged logic) ──── */}
        {data.summary.dataConfidence.value === 'unvalidated' ? (
          <section className="space-y-3 mb-3">
            <div className="border-l-4 border-amber-500 bg-amber-50 p-4 rounded">
              <div className="text-sm font-semibold text-amber-900 mb-1">Insufficient data — provisional figures</div>
              <p className="text-sm text-amber-800">
                The figures below are provisional, resting on conservative library fallbacks rather than validated cash flow. See the committee recommendation below.
              </p>
            </div>
          </section>
        ) : data.summary.dataConfidence.value === 'low_confidence' ? (
          <section className="space-y-3 mb-3">
            <div className="border-l-4 border-blue-400 bg-blue-50 p-4 rounded">
              <div className="text-sm font-semibold text-blue-900 mb-1">Low data confidence — underwriting on in-place / projected figures</div>
              <p className="text-sm text-blue-800">
                Concluded on in-place / underwriting figures — no trailing-12 actuals were available to validate against. This reflects documentation depth, not credit quality; obtain trailing operating statements to raise data confidence.
              </p>
            </div>
          </section>
        ) : null}

        {data.summary.coverage.insufficientCoverageGate.value === true ? (
          <section className="space-y-3 mb-3">
            <div className="border-l-4 border-slate-500 bg-slate-50 p-4 rounded">
              <div className="text-sm font-semibold text-slate-900 mb-1">Insufficient coverage — engine abstained</div>
              <p className="text-sm text-slate-800">{data.summary.coverage.bannerCopy.displayValue}</p>
            </div>
          </section>
        ) : data.summary.coverage.bandCapApplied.value === true ? (
          <section className="space-y-3 mb-3">
            <div className="border-l-4 border-indigo-400 bg-indigo-50 p-4 rounded">
              <div className="text-sm font-semibold text-indigo-900 mb-1">Band capped — risk dimensions unevaluated</div>
              <p className="text-sm text-indigo-800">{data.summary.coverage.bannerCopy.displayValue}</p>
            </div>
          </section>
        ) : null}

        {data.summary.noiDivergence?.status.value === 'flagged' ? (
          <section className="space-y-3 mb-3">
            <div className="border-l-4 border-red-600 bg-red-50 p-4 rounded">
              <div className="text-sm font-semibold text-red-900 mb-1">NOI materially below trailing-twelve actual</div>
              <p className="text-sm text-red-800">{data.summary.noiDivergence.caveat.displayValue}</p>
            </div>
          </section>
        ) : null}

        {/* P3b — advisory intake-completeness readiness + Create-workbook CTA. */}
        {analysisId !== undefined ? <div style={{ marginBottom: 16 }}><WorkbookReadiness analysisId={analysisId} /></div> : null}

        {/* ── ★ SPLIT PAGE: main (negotiation) + sticky rail (score/metrics) ────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>
          {/* Main column — the NegotiationSurface as the PRIMARY panel. Moved WHOLE
              with byte-identical props (data / workflow / timeline / onWorkflowChanged);
              all persistence (createOverlay / submitOverrideDecision / postOverlayComment
              / getOverlayComments) rides inside it, untouched. Mounts only in the
              committee/graph context && out of edit mode (edit uses the drawer's Adjust
              tab so the ratify buttons don't compete with the editor). */}
          <main style={{ minWidth: 0 }}>
            {workflow !== undefined && !editMode ? (
              <NegotiationSurface
                data={data}
                workflow={workflow}
                timeline={timeline}
                onWorkflowChanged={onWorkflowChanged}
              />
            ) : (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: 20, color: C.ink2, fontSize: 13 }}>
                {editMode
                  ? 'Editing underwriting inputs — open the Underwriting workspace (Adjust inputs) below, then Save Changes. The negotiation surface returns when you exit edit mode.'
                  : 'The negotiation surface mounts once the committee workflow is available for this deal. The underwriting detail is in the workspace drawer.'}
              </div>
            )}

            {/* ── Buyer-diff calm view — accept/reject the buyer's suggestions +
                 download the clean seller UW. Quiet by default; air-gapped from the score. */}
            {analysisId && <BuyerDiffPanel analysisId={analysisId} />}
          </main>

          {/* ── Sticky rail — score donut + headline metrics + status + memo ───── */}
          <aside style={{ position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* BUILD 1 — originator open-flags panel. The RECEIVING side of the buyer's
                "Flag to originator" / "Request document" writes. Shown when the viewer
                entered the deal AS the originator (useSide()==='originator'), so it leads
                the rail for the party the flags are addressed to. Read-only. */}
            {side === 'originator'
              ? <OriginatorOpenFlagsPanel rootId={data.rootId} analysisId={analysisId} onAppended={onRevisionSaved} />
              : null}
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, padding: 16 }}>
              <div style={{ ...eyebrow, marginBottom: 12 }}>Credit summary</div>
              <ScoreDonut
                finalScoreValue={data.summary.finalScore.value}
                finalScoreDisplay={data.summary.finalScore.displayValue}
                band={data.summary.ratingBand.displayValue}
                accent={sideC.accent}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                <RailMetric label="DSCR" displayValue={data.metrics.dscr.displayValue} />
                <RailMetric label="LTV" displayValue={data.metrics.ltv.displayValue} />
                <RailMetric label="Debt Yield" displayValue={data.metrics.debtYield.displayValue} />
                <RailMetric label="NOI" displayValue={data.metrics.noi.displayValue} />
                <RailMetric label="Value" displayValue={data.valuation.finalValue.displayValue} />
                <RailMetric label="Weighted Agg." displayValue={data.doctrine.weightedAggregate.displayValue} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button onClick={() => setWorkspaceOpen(true)}
                  style={{ width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 0', borderRadius: 7, cursor: 'pointer', background: C.surface, color: C.teal, border: `1px solid ${C.teal}` }}>
                  Underwriting workspace
                </button>
                {/* Download memo — the shared credit-memo artifact. Needs only the routed
                    analysis id (server renders from the persisted graph chain, no LLM). */}
                {analysisId !== undefined ? (
                  <button onClick={() => api.downloadMemo(analysisId, 'Credit Committee Memo.html')}
                    style={{ width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 0', borderRadius: 7, cursor: 'pointer', background: C.teal, color: '#fff', border: 'none' }}>
                    Download memo
                  </button>
                ) : null}
              </div>
              <div style={{ fontSize: 10.5, color: C.ink3, marginTop: 8 }}>
                Deep underwriting detail (income / expenses / loan / stress / doctrine / handbook) lives in the workspace drawer. The memo is shared.
              </div>
            </div>

            {/* Fix 4 — inline exec summary (click-to-expand). Reads data.narrative
                (executiveSummary + committeeRecommendation) — the SAME rendered
                narrative the drawer's Exec-summary tab shows; NO new API call. A few
                lines only (the story); the full four-slot breakdown stays in-drawer. */}
            {data.narrative !== null ? (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setSummaryOpen((v) => !v)}
                  aria-expanded={summaryOpen}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '12px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                >
                  <span style={eyebrow}>Executive summary</span>
                  <span style={{ fontSize: 12, color: C.ink3, transform: summaryOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} aria-hidden="true">▸</span>
                </button>
                {summaryOpen ? (
                  <div style={{ padding: '0 16px 14px' }}>
                    <p style={{ fontSize: 12.5, lineHeight: 1.5, color: C.ink2, whiteSpace: 'pre-line', margin: 0 }}>
                      {data.narrative.executiveSummary}
                    </p>
                    {data.narrative.committeeRecommendation.trim().length > 0 ? (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                        <div style={{ ...eyebrow, marginBottom: 4 }}>Recommendation</div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.5, color: C.ink2, whiteSpace: 'pre-line', margin: 0 }}>
                          {data.narrative.committeeRecommendation}
                        </p>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => { setWorkspaceTab('narrative'); setWorkspaceOpen(true); }}
                      style={{ marginTop: 12, fontSize: 12, fontWeight: 600, color: C.teal, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    >
                      Full breakdown →
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </aside>
        </div>

        {/* ── Timeline + audit toggle (full-width below the split) ──────────────── */}
        {timeline !== undefined ? <div style={{ marginTop: 20 }}><CommitteeTimelinePanel timeline={timeline} /></div> : null}
        {workflow !== undefined ? <div style={{ marginTop: 12 }}><AuditViewToggle rootId={data.rootId} /></div> : null}
      </div>

      {/* ── Tabbed workspace drawer — deep READ-ONLY sections behind tabs (Stage 3).
          Right-side overlay, opened from the rail. The 'Adjust inputs' tab carries the
          editable line-item tables + the same edit path (handleFieldChange/handleSave /
          api.createGraphRevision) — persistence untouched. ────────────────────────── */}
      {workspaceOpen ? (
        <div onClick={() => setWorkspaceOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(21,38,44,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(860px, 96vw)', height: '100%', background: C.bg, borderLeft: `1px solid ${C.borderStrong}`, display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontFamily: DISPLAY, fontSize: 15, fontWeight: 700, color: C.ink }}>Underwriting workspace</div>
                <div style={{ fontSize: 11, color: C.ink3 }}>Read-only detail · Adjust inputs carries the persisted edit path</div>
              </div>
              <button onClick={() => setWorkspaceOpen(false)} style={{ fontSize: 16, color: C.ink3, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>
            {availableTabs.length > 0 ? (
              <div style={{ display: 'flex', gap: 18, padding: '10px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, overflowX: 'auto' }}>
                {WS_GROUP_ORDER.map((g) => {
                  const groupTabs = availableTabs.filter((t) => t.group === g);
                  if (groupTabs.length === 0) return null;
                  return (
                    <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
                      <span style={{ fontSize: 9.5, letterSpacing: 0.7, textTransform: 'uppercase', fontWeight: 600, color: C.ink3, paddingLeft: 4 }}>{g}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {groupTabs.map((t) => {
                          const on = effectiveTab === t.key;
                          return (
                            <button key={t.key} onClick={() => setWorkspaceTab(t.key)}
                              style={{ fontSize: 12, fontWeight: on ? 600 : 500, padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: on ? C.tealSoft : 'transparent', color: on ? C.tealDeep : C.ink2 }}>
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {/* Edit-mode banner inside the drawer so the analyst knows Save/Cancel live
                in the header while editing the Adjust tables. */}
            {editMode ? (
              <div style={{ padding: '8px 18px', background: C.tealSoft, borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.tealDeep }}>
                Edit mode — change values in <strong>Adjust inputs</strong>, then <strong>Save Changes</strong> (top header) to persist a revision. Cancel discards.
              </div>
            ) : null}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
              {tabBody(effectiveTab)}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
  DealWorkflowState,
  FieldValue,
  FiredFlag,
  HandbookEvaluation,
  RenderedAnalysis,
  RenderBadge,
  RenderBadgeSeverity,
  RenderedFinding,
  RenderedLineItem,
  RenderedStressScenario,
  SkippedPrinciple,
} from '@cre/contracts';
import { ROLE_PERMISSIONS } from '@cre/contracts';
import { CommitteeStatusHeader } from './CommitteeStatusHeader';
import { CommitteeTimelinePanel } from './CommitteeTimelinePanel';
import { CommitteeActionButtons } from './CommitteeActionButtons';
import { AuditViewToggle } from './AuditViewToggle';
import { SnapshotViewer } from './SnapshotViewer';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api-client';
import {
  buildPath,
  isEditablePath,
  pathInputStep,
  pathToUiUnit,
  pathUnitLabel,
  uiUnitToBackend,
} from '@/lib/uw-edit-utils';

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
}

function userCanRevise(role: string | undefined): boolean {
  if (role === undefined) return false;
  const perms = (ROLE_PERMISSIONS as { readonly [k: string]: readonly string[] })[role];
  return perms !== undefined && perms.indexOf('analysis:revise') >= 0;
}

const SEVERITY_TONE: { readonly [K in RenderBadgeSeverity]: string } = {
  info: 'border-blue-300 text-blue-800 bg-blue-50',
  warning: 'border-amber-300 text-amber-800 bg-amber-50',
  critical: 'border-red-300 text-red-800 bg-red-50',
};

function Badge({ badge }: { badge: RenderBadge }): React.ReactElement {
  const tone = SEVERITY_TONE[badge.severity];
  return (
    <span className={'inline-block px-2 py-0.5 text-xs border rounded ' + tone}>
      {badge.label}
    </span>
  );
}

function Cell({ label, displayValue }: { label: string; displayValue: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1 p-3 border border-gray-200 rounded bg-white">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <span className="text-lg font-semibold text-gray-900">{displayValue}</span>
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

export function RenderedAnalysisView({ data, workflow, timeline, onWorkflowChanged, onRevisionSaved, handbookEvaluation }: Props): React.ReactElement {
  const { user } = useAuth();
  const canRevise = userCanRevise(user?.role);
  const editAvailable = canRevise && onRevisionSaved !== undefined;

  // 8.7 attaches lineageRootId + revisionOrdinal at the route layer; read defensively.
  const dataWithLineage = data as RenderedWithLineage;
  const lineageRootId = dataWithLineage.lineageRootId;

  const [editMode, setEditMode] = useState<boolean>(false);
  const [pendingEdits, setPendingEdits] = useState<Map<string, number>>(() => new Map());
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving'>('idle');
  const [saveError, setSaveError] = useState<{ message: string; code?: string; path?: string } | null>(null);

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

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <header className="space-y-2">
        <div className="text-xs text-gray-500 font-mono">
          rootId: {data.rootId} . renderVersion: {data.metadata.renderVersion}
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Analysis</h1>
            {/* 8.9 — revision-ordinal chip. Shown only when ordinal > 0; the root
                revision (ordinal=0) is the unmodified initial state and warrants no
                chip (chip's appearance itself signals "this has been revised").
                "Revision N of M" is deferred to issue #21 (needs GET /:id/lineage). */}
            {dataWithLineage.revisionOrdinal !== undefined && dataWithLineage.revisionOrdinal > 0 ? (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-300">
                Revision {dataWithLineage.revisionOrdinal}
              </span>
            ) : null}
          </div>
          {editAvailable ? (
            <div className="flex items-center gap-2">
              {editMode ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={saveStatus === 'saving'}
                    className="btn-secondary text-sm px-4 py-2 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleSave(); }}
                    disabled={saveStatus === 'saving'}
                    className="btn-primary text-sm px-4 py-2 disabled:opacity-40"
                  >
                    {saveStatus === 'saving' ? 'Saving...' : 'Save Changes'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleEditToggle}
                  className="btn-secondary text-sm px-4 py-2"
                >
                  Edit Underwriting
                </button>
              )}
            </div>
          ) : null}
        </div>
      </header>

      {saveError !== null ? (
        <div className="border border-red-300 bg-red-50 text-red-900 rounded p-3 text-sm space-y-1">
          <div className="font-semibold">Could not save changes</div>
          {saveError.code !== undefined ? (
            <div className="font-mono text-xs">{saveError.code}{saveError.path !== undefined ? ` @ ${saveError.path}` : ''}</div>
          ) : null}
          <div>{saveError.message}</div>
        </div>
      ) : null}

      {workflow !== undefined ? (
        <CommitteeStatusHeader workflow={workflow} />
      ) : null}

      {workflow !== undefined && onWorkflowChanged !== undefined && !editMode ? (
        <CommitteeActionButtons
          rootId={data.rootId}
          renderedAnalysisId={data.id}
          workflow={workflow}
          onActionSubmitted={onWorkflowChanged}
        />
      ) : null}

      {workflow !== undefined ? (
        <SnapshotViewer workflow={workflow} />
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Summary</h2>
        <div className="grid grid-cols-2 gap-3">
          <Cell label="Rating Band" displayValue={data.summary.ratingBand.displayValue} />
          <Cell label="Final Score" displayValue={data.summary.finalScore.displayValue} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Cell label="DSCR" displayValue={data.metrics.dscr.displayValue} />
          <Cell label="LTV" displayValue={data.metrics.ltv.displayValue} />
          <Cell label="Debt Yield" displayValue={data.metrics.debtYield.displayValue} />
          <Cell label="NOI" displayValue={data.metrics.noi.displayValue} />
        </div>
      </section>

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
        are derived fields (recomputed from loanAmount/interestRate/amortizationMonths);
        they appear in the table but are NOT editable (see EDITABLE_PATHS).
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

      {/* Assumptions section — render version 7.3 (#24). Named-field struct on data.assumptions
        mirrors AdjustedInputs.assumptions; 4 fields × RenderedLineItem. All four paths are
        editable (capRate / terminalCapRate / rentGrowthPct / expenseGrowthPct), all 0..1
        decimal so they classify as 'percent' input type per uw-edit-utils.ts. */}
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

      {data.stress.scenarios.length > 0 ? (
        <StressScenarioTable method={data.stress.method} scenarios={data.stress.scenarios} />
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Valuation</h2>
        <div className="grid grid-cols-2 gap-3">
          <Cell label="Final Value" displayValue={data.valuation.finalValue.displayValue} />
          <Cell label="Anchor" displayValue={data.valuation.anchorUsed.displayValue} />
        </div>
      </section>

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

      {handbookEvaluation !== undefined && handbookEvaluation !== null && (
        <HandbookEvaluationSection evaluation={handbookEvaluation} />
      )}

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

      {data.dataQuality.flags.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wide font-semibold text-gray-700">Data Quality</h2>
          <div className="flex flex-wrap gap-2">
            {data.dataQuality.flags.map((b) => <Badge key={b.code} badge={b} />)}
          </div>
        </section>
      ) : null}

      {data.findings.length > 0 ? (
        <FindingsList findings={data.findings} />
      ) : null}

      {timeline !== undefined ? (
        <CommitteeTimelinePanel timeline={timeline} />
      ) : null}

      {workflow !== undefined ? (
        <AuditViewToggle rootId={data.rootId} />
      ) : null}
    </div>
  );
}

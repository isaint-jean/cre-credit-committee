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

import React from 'react';
import type {
  CommitteeTimeline,
  DealWorkflowState,
  RenderedAnalysis,
  RenderBadge,
  RenderBadgeSeverity,
  RenderedFinding,
  RenderedLineItem,
  RenderedStressScenario,
} from '@cre/contracts';
import { CommitteeStatusHeader } from './CommitteeStatusHeader';
import { CommitteeTimelinePanel } from './CommitteeTimelinePanel';
import { CommitteeActionButtons } from './CommitteeActionButtons';
import { AuditViewToggle } from './AuditViewToggle';
import { SnapshotViewer } from './SnapshotViewer';

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

export function RenderedAnalysisView({ data, workflow, timeline, onWorkflowChanged }: Props): React.ReactElement {
  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <header className="space-y-2">
        <div className="text-xs text-gray-500 font-mono">
          rootId: {data.rootId} . renderVersion: {data.metadata.renderVersion}
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Analysis</h1>
      </header>

      {workflow !== undefined ? (
        <CommitteeStatusHeader workflow={workflow} />
      ) : null}

      {workflow !== undefined && onWorkflowChanged !== undefined ? (
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

      <LineItemTable title="Income Lines" lines={data.incomeLines} />
      <LineItemTable title="Expense Lines" lines={data.expenseLines} />

      {/*
        Loan terms (D21 / render version 7.0). The contract is a named-field struct
        (not an array), so we hand-build the explicit list of items to render via the
        same display-only LineItemTable. This is NOT Object.keys iteration: the field
        order and identity are encoded in source per the locked invariant.
      */}
      <LineItemTable
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

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import {
  formatCurrencyFull,
  formatPercent,
  formatMultiple,
  formatDecimalPercent,
  formatMultipleSafe,
  formatCurrencyFullSafe,
} from '@/lib/format';
import type { Analysis, Finding, Severity, Comment, StressScenario, CriteriaEvaluation, CrossCheckFinding, MitigationStrategy, ResearchResult, BPieceDecision, UnderwritingModel, RepaymentScheduleEntry } from '@cre/shared';
import type { CommitteeTimeline, DealWorkflowState, RenderedAnalysis } from '@cre/contracts';
import { RenderedAnalysisView } from '@/components/RenderedAnalysisView';

type Tab = 'summary' | 'findings' | 'crosscheck' | 'research' | 'mitigations' | 'score' | 'criteria' | 'decision';
type UWTab = 'income' | 'expenses' | 'metrics' | 'schedule' | 'stress';

export default function AnalysisDashboard() {
  const { id } = useParams<{ id: string }>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  // Post-6.8: graph-backed analyses arrive as RenderedAnalysis. We render a separate
  // read-only view for them; the legacy dashboard below runs only for the legacy
  // { analysis: ... } envelope returned by uuid-format ids.
  const [rendered, setRendered] = useState<RenderedAnalysis | null>(null);
  // Phase 4 - workflow projections fetched alongside the rendered analysis.
  // Pure server-derived state; never reconstructed in the browser.
  const [workflow, setWorkflow] = useState<DealWorkflowState | null>(null);
  const [timeline, setTimeline] = useState<CommitteeTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [uwTab, setUwTab] = useState<UWTab>('income');
  const [severityFilter, setSeverityFilter] = useState<Severity | 'all'>('all');
  const [commentText, setCommentText] = useState('');
  const [commentStance, setCommentStance] = useState<'agree' | 'disagree' | 'note'>('note');
  const [commentTarget, setCommentTarget] = useState<string>('');
  const [stressResults, setStressResults] = useState<StressScenario[]>([]);
  const [populatedTemplateInfo, setPopulatedTemplateInfo] = useState<{ available: boolean; fileName?: string; mappedFields?: any[]; unmappedFields?: string[]; tabsPopulated?: string[] } | null>(null);

  // Poll for status while processing
  useEffect(() => {
    let interval: NodeJS.Timeout;

    const fetchAnalysis = async () => {
      try {
        const response = await api.getAnalysis(id);
        setLoading(false);

        if (response.kind === 'rendered') {
          // Graph-backed analysis: content-hashed and immutable. Stop polling -
          // a content-hash root never changes status and never needs re-fetch.
          setRendered(response.body);
          clearInterval(interval);
          // Phase 4 - fetch workflow projections for this rootId. Failures are
          // soft (the rendered analysis remains usable without the committee
          // surface); errors are silenced so the page does not block on them.
          const rootId = response.body.rootId;
          try {
            const ws = await api.getWorkflowState(rootId);
            setWorkflow(ws);
          } catch {}
          try {
            const tl = await api.getCommitteeTimeline(rootId);
            setTimeline(tl);
          } catch {}
          return;
        }

        // Legacy path: { analysis: Analysis } envelope. Existing dashboard logic.
        const legacy = response.body.analysis as Analysis;
        setAnalysis(legacy);

        if (legacy.status === 'complete' || legacy.status === 'error') {
          clearInterval(interval);
          if (legacy.stressScenarios) {
            setStressResults(legacy.stressScenarios);
          }
          try {
            const templateInfo = await api.getPopulatedTemplateInfo(id);
            setPopulatedTemplateInfo(templateInfo);
          } catch { setPopulatedTemplateInfo({ available: false }); }
        }
      } catch {
        setLoading(false);
      }
    };

    fetchAnalysis();
    interval = setInterval(fetchAnalysis, 2000);
    return () => clearInterval(interval);
  }, [id]);

  const handleAddComment = useCallback(async (sectionId: string, findingId?: string) => {
    if (!commentText.trim()) return;
    try {
      await api.addComment(id, { sectionId, findingId, stance: commentStance, text: commentText });
      setCommentText('');
      const response = await api.getAnalysis(id);
      // Comment flow is legacy-only; the rendered view exposes no comment affordances.
      if (response.kind === 'legacy') setAnalysis(response.body.analysis as Analysis);
    } catch {}
  }, [id, commentText, commentStance]);

  // Batch 6.3 — UW edits create immutable revisions (POST /revisions). The response is the
  // full new analysis (decorated with credit-policy bands). Replace local state with the
  // new revision; URL stays at the lineage root.
  const handleUWUpdate = useCallback(async (path: string, value: number) => {
    try {
      const result = await api.createUwModelRevision(id, [{ path, value }]);
      if (result?.analysis) setAnalysis(result.analysis);
    } catch {}
  }, [id]);

  const handleLoanTermUpdate = useCallback(async (updates: Record<string, any>) => {
    try {
      const result = await api.createLoanTermsRevision(id, updates);
      if (result?.analysis) setAnalysis(result.analysis);
    } catch {}
  }, [id]);

  const handleRunStress = useCallback(async () => {
    try {
      const result = await api.runStressTest(id);
      setStressResults(result.results);
    } catch {}
  }, [id]);

  // Phase 4 - committee action buttons fire POST /committee-actions; on success
  // we refetch the workflow + timeline projections so the UI reflects the new
  // server-side state. State is NEVER mutated locally.
  const refetchWorkflow = useCallback(async () => {
    if (rendered === null) return;
    const rootId = rendered.rootId;
    try {
      const ws = await api.getWorkflowState(rootId);
      setWorkflow(ws);
    } catch {}
    try {
      const tl = await api.getCommitteeTimeline(rootId);
      setTimeline(tl);
    } catch {}
  }, [rendered]);

  // Post-6.8 consumer migration: render the materialized server output for
  // graph-backed (content-hashed) analyses. The legacy dashboard below runs only
  // for legacy { analysis: ... } responses. ONE renderer per shape; no dual
  // rendering paths in the client.
  if (rendered !== null) {
    return (
      <RenderedAnalysisView
        data={rendered}
        workflow={workflow ?? undefined}
        timeline={timeline ?? undefined}
        onWorkflowChanged={() => { void refetchWorkflow(); }}
        onRevisionSaved={async () => {
          // 8.8 — after a successful revision write, the latest in the lineage moved.
          // Re-run getAnalysis to fetch the new RenderedAnalysis (the server resolves
          // latest-by-lineage internally) and re-render. Workflow projections are
          // refreshed alongside because they may shift as part of the same edit.
          try {
            const response = await api.getAnalysis(id);
            if (response.kind === 'rendered') {
              setRendered(response.body);
              const rootId = response.body.rootId;
              try { setWorkflow(await api.getWorkflowState(rootId)); } catch {}
              try { setTimeline(await api.getCommitteeTimeline(rootId)); } catch {}
            }
          } catch {}
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-text-secondary">Loading analysis...</p>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return <div className="p-12 text-center text-text-secondary">Analysis not found.</div>;
  }

  // Processing state
  if (analysis.status !== 'complete' && analysis.status !== 'error') {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <div className="text-center max-w-md">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-lg font-semibold text-text-primary mb-2">Analyzing {analysis.name}</h2>
          <p className="text-sm text-text-secondary mb-4">{analysis.currentStep}</p>
          <div className="w-full bg-bg-tertiary rounded-full h-2 mb-2">
            <div
              className="bg-accent h-2 rounded-full transition-all duration-500"
              style={{ width: `${analysis.progress}%` }}
            />
          </div>
          <p className="text-xs text-text-muted">{analysis.progress}% complete</p>
        </div>
      </div>
    );
  }

  if (analysis.status === 'error') {
    return (
      <div className="max-w-2xl mx-auto p-12 text-center">
        <div className="text-risk-high text-lg font-semibold mb-2">Analysis Failed</div>
        <p className="text-sm text-text-secondary">{analysis.error}</p>
      </div>
    );
  }

  const findings = analysis.findings || [];
  const filteredFindings = severityFilter === 'all' ? findings : findings.filter((f) => f.severity === severityFilter);
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const highCount = findings.filter((f) => f.severity === 'high').length;
  const mediumCount = findings.filter((f) => f.severity === 'medium').length;
  const lowCount = findings.filter((f) => f.severity === 'low').length;

  const score = analysis.creditScore;
  const uw = analysis.uwModel;

  return (
    <div className="h-[calc(100vh-49px)] flex flex-col overflow-hidden">
      {/* Top Bar */}
      <div className="border-b border-border-primary bg-bg-secondary px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-text-primary">{analysis.name}</h1>
          <span className="badge badge-medium">{analysis.assetType.toUpperCase()}</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Bank Underwriter and BP Spire Underwriter — both use the SAME
              unified Excel export pipeline (/api/underwriting/export). They
              differ only in the `profile` parameter (input configuration). */}
          {analysis.status === 'complete' && analysis.uwModel && (
            <>
              <button
                onClick={() =>
                  api.exportUnderwriting(
                    analysis.id,
                    { profile: 'bank', assetClass: analysis.assetType, underwritingMode: 'single_loan' },
                    `Bank_UW_${analysis.name}.xlsx`,
                  )
                }
                className="text-xs px-4 py-2 flex items-center gap-2 rounded border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:border-text-muted transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Download Bank Underwriter
              </button>
              <button
                onClick={() =>
                  api.exportUnderwriting(
                    analysis.id,
                    { profile: 'bp_spire', assetClass: analysis.assetType, underwritingMode: 'single_loan' },
                    `BPSpire_UW_${analysis.name}.xlsx`,
                  )
                }
                className="btn-primary text-xs px-4 py-2 flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Download BP Spire Underwriting
              </button>
            </>
          )}
          {/* Populated Excel Template (tertiary option) */}
          {populatedTemplateInfo?.available && (
            <button
              onClick={() => api.downloadPopulatedTemplate(analysis.id, populatedTemplateInfo.fileName)}
              className="text-xs px-3 py-2 flex items-center gap-1.5 rounded border border-border-primary text-text-muted hover:text-text-secondary transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Excel
            </button>
          )}
          {score && (
            <>
              {/* Color sourced from server-emitted score.riskTier — no client-side threshold. */}
              <span className={`text-2xl font-mono font-bold text-score-${score.riskTier ?? 'high_risk'}`}>
                {score.overall}
              </span>
              <span className="text-xs text-text-muted">/100</span>
              <span className={`badge ${
                score.riskTier === 'strong' ? 'badge-pass' :
                score.riskTier === 'acceptable' ? 'badge-medium' :
                score.riskTier === 'watchlist' ? 'badge-medium' :
                'badge-fail'
              }`}>
                {score.riskTier?.replace('_', ' ').toUpperCase()}
              </span>
              <span className={`badge ${
                score.recommendation === 'approve' ? 'badge-pass' :
                score.recommendation === 'approve_with_conditions' ? 'badge-medium' :
                score.recommendation === 'decline' ? 'badge-fail' :
                'badge-unknown'
              }`}>
                {score.recommendation?.replace(/_/g, ' ').toUpperCase()}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Main 3-panel layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel — Findings */}
        <div className="w-[45%] border-r border-border-primary flex flex-col overflow-hidden">
          {/* Tabs — 10-section spec order */}
          <div className="flex border-b border-border-primary shrink-0 overflow-x-auto">
            {([
              ['summary', 'Summary'],
              ['findings', 'Red Flags'],
              ...(analysis.crossCheckFindings?.length ? [['crosscheck', 'Cross-Check']] : []),
              ['research', 'Research'],
              ['mitigations', 'Mitigations'],
              ['score', 'Score'],
              ['criteria', 'Criteria'],
              ...(analysis.bPieceDecision ? [['decision', 'Decision']] : []),
            ] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === key ? 'text-accent border-b-2 border-accent' : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {activeTab === 'summary' && (
              <div className="space-y-4">
                {analysis.executiveSummary ? (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Executive Summary</h3>
                    <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">{analysis.executiveSummary}</div>
                  </div>
                ) : (
                  <p className="text-sm text-text-muted py-8 text-center">Executive summary will appear after analysis completes.</p>
                )}

                {/* Version Info */}
                {analysis.status === 'complete' && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Version Info</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div>
                        <div className="text-text-muted">Input Hash</div>
                        <div className="text-text-primary font-mono">{analysis.inputHash?.substring(0, 12) || 'N/A'}...</div>
                      </div>
                      <div>
                        <div className="text-text-muted">Manifesto Version</div>
                        <div className="text-text-primary font-mono">{analysis.manifestoVersion?.substring(0, 12) || 'N/A'}...</div>
                      </div>
                      <div>
                        <div className="text-text-muted">Model Logic</div>
                        <div className="text-text-primary font-mono">{analysis.modelLogicVersion || 'N/A'}</div>
                      </div>
                      <div>
                        <div className="text-text-muted">Validation</div>
                        <div className={`font-medium ${analysis.validationResult?.passed ? 'text-risk-positive' : 'text-risk-high'}`}>
                          {analysis.validationResult?.passed ? `PASSED (${analysis.validationResult.checks.length} checks)` : 'NOT VALIDATED'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Quick stats */}
                {score && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="card text-center py-3">
                      <div className="text-xs text-text-muted mb-1">Credit Score</div>
                      {/* Color sourced from server-emitted score.riskTier — no client-side threshold. */}
                      <div className={`text-2xl font-mono font-bold text-score-${score.riskTier ?? 'high_risk'}`}>{score.overall}</div>
                    </div>
                    <div className="card text-center py-3">
                      <div className="text-xs text-text-muted mb-1">Red Flags</div>
                      <div className="text-2xl font-mono font-bold text-risk-high">{criticalCount + highCount}</div>
                      <div className="text-[10px] text-text-muted">{criticalCount} critical / {highCount} high</div>
                    </div>
                    <div className="card text-center py-3">
                      <div className="text-xs text-text-muted mb-1">Recommendation</div>
                      <div className={`text-sm font-bold mt-1 ${
                        score.recommendation === 'approve' ? 'text-risk-positive' :
                        score.recommendation === 'decline' ? 'text-risk-high' :
                        'text-risk-medium'
                      }`}>{score.recommendation?.replace(/_/g, ' ').toUpperCase()}</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'findings' && (
              <>
                {/* Severity filters */}
                <div className="flex gap-2 mb-3">
                  {[
                    { key: 'all', label: 'All', count: findings.length },
                    { key: 'critical', label: 'Critical', count: criticalCount },
                    { key: 'high', label: 'High', count: highCount },
                    { key: 'medium', label: 'Medium', count: mediumCount },
                    { key: 'low', label: 'Low', count: lowCount },
                  ].map(({ key, label, count }) => (
                    <button
                      key={key}
                      onClick={() => setSeverityFilter(key as any)}
                      className={`text-xs px-2 py-1 rounded transition-colors ${
                        severityFilter === key
                          ? 'bg-accent/20 text-accent'
                          : 'text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {label} ({count})
                    </button>
                  ))}
                </div>

                {/* Severity-grouped findings */}
                {severityFilter === 'all' ? (
                  <div className="space-y-4">
                    {([
                      { sev: 'critical' as Severity, label: 'CRITICAL RISK', color: 'text-risk-high', bg: 'bg-risk-high/10' },
                      { sev: 'high' as Severity, label: 'HIGH RISK', color: 'text-risk-high', bg: 'bg-risk-high/5' },
                      { sev: 'medium' as Severity, label: 'MEDIUM RISK', color: 'text-risk-medium', bg: 'bg-risk-medium/5' },
                      { sev: 'low' as Severity, label: 'LOW RISK', color: 'text-text-muted', bg: 'bg-bg-tertiary/30' },
                    ]).map(({ sev, label, color, bg }) => {
                      const group = findings.filter((f) => f.severity === sev);
                      if (group.length === 0) return null;
                      return (
                        <div key={sev}>
                          <div className={`text-xs font-bold ${color} uppercase tracking-wider mb-2 px-2 py-1 rounded ${bg}`}>
                            {label} ({group.length})
                          </div>
                          <div className="space-y-2">
                            {group.map((finding) => (
                              <FindingCard
                                key={finding.id}
                                finding={finding}
                                mitigationCount={(analysis.mitigations || []).filter((m) => m.findingId === finding.id).length}
                                onComment={(findingId) => setCommentTarget(findingId)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredFindings.map((finding) => (
                      <FindingCard
                        key={finding.id}
                        finding={finding}
                        mitigationCount={(analysis.mitigations || []).filter((m) => m.findingId === finding.id).length}
                        onComment={(findingId) => setCommentTarget(findingId)}
                      />
                    ))}
                    {filteredFindings.length === 0 && (
                      <p className="text-sm text-text-muted py-8 text-center">No findings at this severity level.</p>
                    )}
                  </div>
                )}
              </>
            )}

            {activeTab === 'crosscheck' && (
              <div className="space-y-3">
                {/* Overall Adjustment Bias */}
                {analysis.overallAdjustmentBias && (
                  <div className={`card py-2 px-4 flex items-center gap-3 ${
                    analysis.overallAdjustmentBias === 'conservative' ? 'border-risk-positive/30' :
                    analysis.overallAdjustmentBias === 'aggressive' ? 'border-risk-high/30' :
                    'border-border-primary'
                  }`}>
                    <span className="text-xs text-text-muted font-medium uppercase tracking-wider">Overall Adjustment Bias:</span>
                    <span className={`text-sm font-bold uppercase ${
                      analysis.overallAdjustmentBias === 'conservative' ? 'text-risk-positive' :
                      analysis.overallAdjustmentBias === 'aggressive' ? 'text-risk-high' :
                      'text-text-secondary'
                    }`}>{analysis.overallAdjustmentBias}</span>
                    <span className="text-xs text-text-muted">
                      {analysis.overallAdjustmentBias === 'conservative' ? '(BP Spiral applies tighter assumptions than seller)' :
                       analysis.overallAdjustmentBias === 'aggressive' ? '(BP Spiral assumptions are looser than seller)' :
                       '(BP Spiral adjustments are balanced)'}
                    </span>
                  </div>
                )}

                {(analysis.crossCheckFindings || []).length === 0 ? (
                  <p className="text-sm text-text-muted py-8 text-center">No cross-check findings. Upload both ASR and UW files to enable cross-validation.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th className="table-header text-left">Metric</th>
                          <th className="table-header">Seller / Bank Value</th>
                          <th className="table-header">BP Spiral UW Value</th>
                          <th className="table-header">% Variance</th>
                          <th className="table-header text-center">Flag</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(analysis.crossCheckFindings || []).map((cc) => (
                          <CrossCheckRow key={cc.id} finding={cc} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'mitigations' && (
              <div className="space-y-3">
                {(analysis.mitigations || []).length === 0 ? (
                  <p className="text-sm text-text-muted py-8 text-center">No mitigation strategies generated.</p>
                ) : (
                  (analysis.mitigations || []).map((mitigation) => {
                    const relatedFinding = findings.find((f) => f.id === mitigation.findingId);
                    return (
                      <div key={mitigation.id} className="card">
                        {relatedFinding && (
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`badge badge-${relatedFinding.severity}`}>{relatedFinding.severity}</span>
                            <span className="text-xs text-text-muted">{relatedFinding.title}</span>
                          </div>
                        )}
                        <h4 className="text-sm font-medium text-text-primary mb-1">{mitigation.strategy}</h4>
                        <p className="text-xs text-text-secondary mb-2">{mitigation.description}</p>
                        {mitigation.structuralChanges.length > 0 && (
                          <div className="mb-2">
                            <div className="text-xs font-semibold text-text-secondary mb-1">Structural Changes:</div>
                            <ul className="text-xs text-text-muted list-disc list-inside">
                              {mitigation.structuralChanges.map((change, i) => (
                                <li key={i}>{change}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className="flex gap-4 text-xs">
                          {mitigation.financialImpact.targetMetric && (
                            <div>
                              <span className="text-text-muted">{mitigation.financialImpact.targetMetric}: </span>
                              <span className="text-risk-high font-mono">{mitigation.financialImpact.currentValue}</span>
                              <span className="text-text-muted mx-1">&rarr;</span>
                              <span className="text-risk-positive font-mono">{mitigation.financialImpact.projectedValue}</span>
                              <span className="text-risk-positive ml-1">({mitigation.financialImpact.improvement})</span>
                            </div>
                          )}
                          {mitigation.requiredReserve != null && (
                            <div><span className="text-text-muted">Reserve: </span><span className="font-mono">{formatCurrencyFull(mitigation.requiredReserve)}</span></div>
                          )}
                          {mitigation.requiredEquity != null && (
                            <div><span className="text-text-muted">Equity: </span><span className="font-mono">{formatCurrencyFull(mitigation.requiredEquity)}</span></div>
                          )}
                        </div>
                        <div className="mt-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            mitigation.riskReduction === 'significant' ? 'bg-risk-positive/10 text-risk-positive' :
                            mitigation.riskReduction === 'moderate' ? 'bg-risk-medium/10 text-risk-medium' :
                            'bg-bg-tertiary text-text-muted'
                          }`}>
                            {mitigation.riskReduction} risk reduction
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {activeTab === 'research' && (
              <div className="space-y-4">
                {!analysis.research ? (
                  <p className="text-sm text-text-muted py-8 text-center">No research data available. Set BRAVE_SEARCH_API_KEY to enable external research.</p>
                ) : (
                  <>
                    {[
                      { key: 'sponsor' as const, label: 'Sponsor Research' },
                      { key: 'market' as const, label: 'Market Research' },
                      { key: 'news' as const, label: 'News' },
                    ].map(({ key, label }) => {
                      const results = analysis.research![key] || [];
                      return (
                        <div key={key}>
                          <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">{label}</h3>
                          {results.length === 0 ? (
                            <p className="text-xs text-text-muted mb-3">No results found.</p>
                          ) : (
                            <div className="space-y-2 mb-3">
                              {results.map((r: ResearchResult, i: number) => (
                                <div key={i} className="card py-2">
                                  <div className="flex items-start gap-2">
                                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                                      r.riskSignal === 'negative' ? 'bg-risk-high/10 text-risk-high' :
                                      r.riskSignal === 'positive' ? 'bg-risk-positive/10 text-risk-positive' :
                                      'bg-bg-tertiary text-text-muted'
                                    }`}>
                                      {r.riskSignal}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-sm text-text-primary font-medium truncate">{r.title}</div>
                                      <p className="text-xs text-text-secondary mt-0.5">{r.snippet}</p>
                                      <div className="flex items-center gap-2 mt-1">
                                        <span className="text-xs text-text-muted">{r.source}</span>
                                        {r.publishedDate && <span className="text-xs text-text-muted">{r.publishedDate}</span>}
                                        {r.url && (
                                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:text-accent-hover">
                                            View source
                                          </a>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {activeTab === 'criteria' && (
              <div className="space-y-2">
                {(analysis.criteriaEvaluations || []).map((evaluation, i) => (
                  <CriteriaCard key={i} evaluation={evaluation} />
                ))}
                {(!analysis.criteriaEvaluations || analysis.criteriaEvaluations.length === 0) && (
                  <p className="text-sm text-text-muted py-8 text-center">No criteria evaluations available.</p>
                )}
              </div>
            )}

            {activeTab === 'score' && score && (
              <div className="space-y-4">
                {/* Score Summary */}
                <div className="card text-center">
                  {/* Color sourced from server-emitted score.riskTier — no client-side threshold. */}
                  <div className={`text-5xl font-mono font-bold mb-2 text-score-${score.riskTier ?? 'high_risk'}`}>
                    {score.overall}
                  </div>
                  <div className="text-xs text-text-muted mb-4">Credit Score</div>

                  {/* Progress bar */}
                  <div className="w-full bg-bg-tertiary rounded-full h-3 mb-4">
                    <div
                      className={`h-3 rounded-full transition-all bg-score-${score.riskTier ?? 'high_risk'}`}
                      style={{ width: `${score.overall}%` }}
                    />
                  </div>
                </div>

                {/* Category Breakdown */}
                <div className="card">
                  <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Category Breakdown</h3>
                  <div className="space-y-3">
                    {(score.categories || []).map((cat) => (
                      <div key={cat.category}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-text-secondary capitalize">{cat.category.replace('_', ' ')}</span>
                          <span className="font-mono text-text-primary">
                            {Math.round(cat.weightedScore)} / {cat.weight}
                          </span>
                        </div>
                        <div className="w-full bg-bg-tertiary rounded-full h-2">
                          {/* Color sourced from server-emitted cat.tier — no client-side threshold. */}
                          <div
                            className={`h-2 rounded-full bg-score-${cat.tier ?? 'high_risk'}`}
                            style={{ width: `${cat.score}%` }}
                          />
                        </div>
                        {cat.explanation && (
                          <p className="text-xs text-text-muted mt-1">{cat.explanation}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Narrative */}
                {score.narrative && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">Credit Narrative</h3>
                    <p className="text-sm text-text-secondary leading-relaxed">{score.narrative}</p>
                  </div>
                )}

                {/* Why This Score */}
                {score.whyThisScore && (
                  <div className="card border-l-2 border-risk-medium">
                    <h3 className="text-xs font-semibold text-risk-medium uppercase tracking-wider mb-2">Why This Score</h3>
                    <p className="text-sm text-text-secondary leading-relaxed">{score.whyThisScore}</p>
                  </div>
                )}

                {/* How To Improve */}
                {score.howToImprove && (
                  <div className="card border-l-2 border-risk-positive">
                    <h3 className="text-xs font-semibold text-risk-positive uppercase tracking-wider mb-2">How To Improve</h3>
                    <p className="text-sm text-text-secondary leading-relaxed">{score.howToImprove}</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'decision' && analysis.bPieceDecision && (
              <div className="space-y-4">
                {/* Decision Header */}
                <div className={`card text-center py-6 ${
                  analysis.bPieceDecision.recommendation === 'approve' ? 'border-risk-positive bg-risk-positive/5' :
                  analysis.bPieceDecision.recommendation === 'decline' ? 'border-risk-high bg-risk-high/5' :
                  'border-risk-medium bg-risk-medium/5'
                }`}>
                  <div className={`text-2xl font-bold mb-1 ${
                    analysis.bPieceDecision.recommendation === 'approve' ? 'text-risk-positive' :
                    analysis.bPieceDecision.recommendation === 'decline' ? 'text-risk-high' :
                    'text-risk-medium'
                  }`}>
                    {analysis.bPieceDecision.recommendation.replace(/_/g, ' ').toUpperCase()}
                  </div>
                  <div className="text-xs text-text-muted">
                    Conviction: <span className="font-medium text-text-secondary">{analysis.bPieceDecision.conviction}</span>
                  </div>
                </div>

                {/* Summary */}
                <div className="card">
                  <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">Final Verdict</h3>
                  <p className="text-sm text-text-secondary leading-relaxed">{analysis.bPieceDecision.summary}</p>
                </div>

                {/* Deal Breakers */}
                {analysis.bPieceDecision.dealBreakers.length > 0 && (
                  <div className="card border-l-2 border-risk-high">
                    <h3 className="text-xs font-semibold text-risk-high uppercase tracking-wider mb-2">Deal Breakers</h3>
                    <ul className="space-y-1">
                      {analysis.bPieceDecision.dealBreakers.map((db, i) => (
                        <li key={i} className="text-sm text-text-secondary flex gap-2">
                          <span className="text-risk-high shrink-0">&#x2022;</span>
                          {db}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Key Conditions */}
                {analysis.bPieceDecision.keyConditions.length > 0 && (
                  <div className="card border-l-2 border-risk-medium">
                    <h3 className="text-xs font-semibold text-risk-medium uppercase tracking-wider mb-2">Key Conditions for Approval</h3>
                    <ul className="space-y-1">
                      {analysis.bPieceDecision.keyConditions.map((cond, i) => (
                        <li key={i} className="text-sm text-text-secondary flex gap-2">
                          <span className="text-risk-medium shrink-0">&#x2022;</span>
                          {cond}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Pricing Guidance */}
                {analysis.bPieceDecision.pricingGuidance && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">Pricing Guidance</h3>
                    <p className="text-sm text-text-secondary">{analysis.bPieceDecision.pricingGuidance}</p>
                  </div>
                )}

              </div>
            )}
          </div>
        </div>

        {/* Right Panel — Comments */}
        <div className="w-[55%] flex flex-col overflow-hidden">
          {/* Comments Section */}
          <div className="h-[40%] border-b border-border-primary flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-border-primary shrink-0">
              <h2 className="text-xs font-semibold text-accent uppercase tracking-wider">Comments & Annotations</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {(analysis.comments || []).length === 0 ? (
                <p className="text-xs text-text-muted text-center py-4">No comments yet.</p>
              ) : (
                <div className="space-y-2">
                  {(analysis.comments || []).map((comment) => (
                    <div key={comment.id} className="card py-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`badge ${
                          comment.stance === 'agree' ? 'badge-pass' :
                          comment.stance === 'disagree' ? 'badge-fail' :
                          'badge-unknown'
                        }`}>
                          {comment.stance}
                        </span>
                        <span className="text-xs text-text-muted">{comment.author}</span>
                        <span className="text-xs text-text-muted">
                          {new Date(comment.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm text-text-secondary">{comment.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Comment Input */}
            <div className="p-3 border-t border-border-primary shrink-0">
              <div className="flex gap-2 mb-2">
                {(['agree', 'disagree', 'note'] as const).map((stance) => (
                  <button
                    key={stance}
                    onClick={() => setCommentStance(stance)}
                    className={`text-xs px-2 py-1 rounded ${
                      commentStance === stance
                        ? stance === 'agree' ? 'bg-risk-positive/20 text-risk-positive' :
                          stance === 'disagree' ? 'bg-risk-high/20 text-risk-high' :
                          'bg-accent/20 text-accent'
                        : 'text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {stance}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Add a comment..."
                  className="input-field flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddComment(commentTarget || 'general', undefined);
                    }
                  }}
                />
                <button
                  onClick={() => handleAddComment(commentTarget || 'general', undefined)}
                  className="btn-primary text-xs"
                >
                  Add
                </button>
              </div>
            </div>
          </div>

          {/* Bottom Panel — UW Model */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex border-b border-border-primary shrink-0">
              {([['income', 'Income'], ['expenses', 'Expenses'], ['metrics', 'Metrics'], ['schedule', 'Loan Schedule'], ['stress', 'Stress Test']] as [UWTab, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setUwTab(key)}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${
                    uwTab === key ? 'text-accent border-b-2 border-accent' : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {uw ? (
                <>
                  {uwTab === 'income' && (
                    <UWTable
                      items={[
                        uw.income.grossPotentialRent,
                        uw.income.vacancyLoss,
                        uw.income.concessions,
                        uw.income.otherIncome,
                        ...uw.income.additionalItems,
                        uw.income.effectiveGrossIncome,
                      ]}
                      onUpdate={handleUWUpdate}
                      pathPrefix="income"
                    />
                  )}
                  {uwTab === 'expenses' && (
                    <UWTable
                      items={[
                        uw.expenses.realEstateTaxes,
                        uw.expenses.insurance,
                        uw.expenses.utilities,
                        uw.expenses.repairsAndMaintenance,
                        uw.expenses.management,
                        uw.expenses.generalAndAdmin,
                        uw.expenses.payroll,
                        uw.expenses.replacementReserves,
                        ...uw.expenses.additionalItems,
                        uw.expenses.totalExpenses,
                      ]}
                      onUpdate={handleUWUpdate}
                      pathPrefix="expenses"
                    />
                  )}
                  {uwTab === 'metrics' && (
                    <div className="space-y-3">
                      <MetricRow label="Net Operating Income" value={formatCurrencyFull(uw.netOperatingIncome)} />
                      {/* Cap Rate is stored as decimal (0.045 = 4.5%) — display layer multiplies by 100. */}
                      <MetricRow label="Cap Rate" value={formatDecimalPercent(uw.capRate)} editable onUpdate={(v) => handleUWUpdate('capRate', v)} currentValue={uw.capRate} />
                      <MetricRow label="Implied Value" value={formatCurrencyFullSafe(uw.impliedValue)} />
                      <div className="border-t border-border-primary my-2" />
                      <MetricRow label="Loan Amount" value={formatCurrencyFull(uw.loanAmount)} editable onUpdate={(v) => handleLoanTermUpdate({ loanAmount: v })} currentValue={uw.loanAmount} />
                      {/* Interest Rate is still stored in percent units (loan-amort math uses /100). */}
                      <MetricRow label="Interest Rate" value={formatPercent(uw.interestRate)} editable onUpdate={(v) => handleLoanTermUpdate({ interestRate: v })} currentValue={uw.interestRate} />
                      <MetricRow label="Rate Type" value={uw.loanDetails?.rateType === 'floating' ? 'Floating' : 'Fixed'} />
                      <MetricRow label="IO Period" value={`${uw.loanDetails?.ioMonths || 0} months`} editable onUpdate={(v) => handleLoanTermUpdate({ ioMonths: v })} currentValue={uw.loanDetails?.ioMonths || 0} />
                      <MetricRow label="Loan Term" value={`${uw.loanDetails?.termMonths || uw.termYears * 12} months (${uw.termYears}yr)`} editable onUpdate={(v) => handleLoanTermUpdate({ termMonths: v })} currentValue={uw.loanDetails?.termMonths || uw.termYears * 12} />
                      <MetricRow label="Amortization" value={`${uw.loanDetails?.amortizationMonths || uw.amortizationYears * 12} months (${uw.amortizationYears}yr)`} editable onUpdate={(v) => handleLoanTermUpdate({ amortizationMonths: v })} currentValue={uw.loanDetails?.amortizationMonths || uw.amortizationYears * 12} />
                      <MetricRow label="Annual Debt Service" value={formatCurrencyFullSafe(uw.annualDebtService)} />
                      {uw.loanDetails?.prepaymentTerms && (
                        <MetricRow label="Prepayment" value={uw.loanDetails.prepaymentTerms} />
                      )}
                      <div className="border-t border-border-primary my-2" />
                      {/* Bands are server-emitted (apps/api/src/services/doctrine/credit-policy-bands.ts); never recomputed here. */}
                      <MetricRow label="DSCR" value={formatMultipleSafe(uw.dscr)} highlight={uw.dscrBand ?? undefined} />
                      <MetricRow label="LTV" value={formatDecimalPercent(uw.ltv)} highlight={uw.ltvBand ?? undefined} />
                      <MetricRow label="Debt Yield" value={formatDecimalPercent(uw.debtYield)} highlight={uw.debtYieldBand ?? undefined} />
                      {uw.repaymentSchedule && (
                        <>
                          <div className="border-t border-border-primary my-2" />
                          <MetricRow label="Balloon Balance" value={formatCurrencyFull(uw.repaymentSchedule.summary.balloonBalance)} highlight={uw.repaymentSchedule.summary.balloonBand ?? undefined} />
                          <MetricRow label="Maturity Date" value={uw.repaymentSchedule.summary.balloonDate} />
                          <MetricRow label="Min Monthly DSCR" value={formatMultipleSafe(uw.repaymentSchedule.summary.minDSCR)} highlight={uw.repaymentSchedule.summary.minDscrBand ?? undefined} />
                        </>
                      )}
                    </div>
                  )}
                  {uwTab === 'schedule' && (
                    <LoanSchedulePanel
                      uwModel={uw}
                      onUpdateTerms={handleLoanTermUpdate}
                    />
                  )}
                  {uwTab === 'stress' && (
                    <div>
                      <button onClick={handleRunStress} className="btn-secondary text-xs mb-4">
                        Run Default Stress Scenarios
                      </button>
                      {stressResults.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr>
                                <th className="table-header text-left">Scenario</th>
                                <th className="table-header mono">NOI</th>
                                <th className="table-header mono">DSCR</th>
                                <th className="table-header mono">LTV</th>
                                <th className="table-header mono">Debt Yield</th>
                                <th className="table-header text-center">Covenant</th>
                              </tr>
                            </thead>
                            <tbody>
                              {/* Base case */}
                              <tr className="bg-bg-tertiary/50">
                                <td className="table-cell text-text-primary font-medium">Base Case</td>
                                <td className="table-cell mono">{formatCurrencyFull(uw.netOperatingIncome)}</td>
                                <td className="table-cell mono">{formatMultipleSafe(uw.dscr)}</td>
                                <td className="table-cell mono">{formatDecimalPercent(uw.ltv)}</td>
                                <td className="table-cell mono">{formatDecimalPercent(uw.debtYield)}</td>
                                <td className="table-cell text-center"><span className="badge-pass">PASS</span></td>
                              </tr>
                              {stressResults.map((s, i) => (
                                <tr key={i}>
                                  <td className="table-cell text-text-secondary">{s.name}</td>
                                  <td className="table-cell mono">{formatCurrencyFull(s.results.noi)}</td>
                                  {/* Per-cell breach flags are server-emitted. true = breached, false = pass, null = not computable. */}
                                  <td className={`table-cell mono ${s.results.dscrBreached === true ? 'text-risk-high' : ''}`}>
                                    {formatMultipleSafe(s.results.dscr)}
                                  </td>
                                  <td className={`table-cell mono ${s.results.ltvBreached === true ? 'text-risk-high' : ''}`}>
                                    {formatDecimalPercent(s.results.ltv)}
                                  </td>
                                  <td className={`table-cell mono ${s.results.debtYieldBreached === true ? 'text-risk-high' : ''}`}>
                                    {formatDecimalPercent(s.results.debtYield)}
                                  </td>
                                  <td className="table-cell text-center">
                                    <span className={s.breaksCovenants ? 'badge-fail' : 'badge-pass'}>
                                      {s.breaksCovenants ? 'FAIL' : 'PASS'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {/* Covenant breach details */}
                          {stressResults.filter((s) => s.breaksCovenants).map((s, i) => (
                            <div key={i} className="mt-2 p-2 bg-risk-high/5 border border-risk-high/20 rounded text-xs text-risk-high">
                              <span className="font-medium">{s.name}:</span>{' '}
                              {s.covenantBreaches.join('; ')}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-text-muted text-center py-8">Underwriting model not available.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Loan Schedule Panel ---

function LoanSchedulePanel({ uwModel, onUpdateTerms }: {
  uwModel: UnderwritingModel;
  onUpdateTerms: (updates: Record<string, any>) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const schedule = uwModel.repaymentSchedule;
  const details = uwModel.loanDetails;

  if (!schedule || !details) {
    return <p className="text-sm text-text-muted text-center py-8">Loan schedule not available. Loan details are required.</p>;
  }

  const entries: RepaymentScheduleEntry[] = schedule.entries || [];
  const displayEntries: RepaymentScheduleEntry[] = showAll ? entries : entries.filter((_, i) => {
    // Show first 12, last 6, and IO/amort transition months
    if (i < 12) return true;
    if (i >= entries.length - 6) return true;
    if (entries[i].isIO !== entries[i - 1]?.isIO) return true;
    // Show every 12th month (annual summary)
    if ((i + 1) % 12 === 0) return true;
    return false;
  });

  const ioMonths = details.ioMonths || 0;
  const termMonths = details.termMonths || 0;
  const amortMonths = details.amortizationMonths || 0;

  return (
    <div className="space-y-4">
      {/* Loan Structure Summary */}
      <div className="card">
        <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Loan Structure</h3>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <span className="text-text-muted">Term: </span>
            <span className="font-mono text-text-primary">{termMonths} months ({(termMonths / 12).toFixed(1)}yr)</span>
          </div>
          <div>
            <span className="text-text-muted">IO Period: </span>
            <span className={`font-mono ${ioMonths > 0 ? 'text-risk-medium' : 'text-text-primary'}`}>{ioMonths} months</span>
          </div>
          <div>
            <span className="text-text-muted">Amortization: </span>
            <span className="font-mono text-text-primary">{amortMonths} months ({(amortMonths / 12).toFixed(0)}yr)</span>
          </div>
          <div>
            <span className="text-text-muted">Rate: </span>
            <span className="font-mono text-text-primary">{uwModel.interestRate}% {details.rateType}</span>
          </div>
          <div>
            <span className="text-text-muted">Payment: </span>
            <span className="font-mono text-text-primary">{details.paymentFrequency}</span>
          </div>
          {details.prepaymentTerms && (
            <div>
              <span className="text-text-muted">Prepayment: </span>
              <span className="font-mono text-text-primary">{details.prepaymentTerms}</span>
            </div>
          )}
        </div>
      </div>

      {/* Schedule Summary KPIs */}
      <div className="grid grid-cols-4 gap-2">
        <div className="card py-2 text-center">
          <div className="text-[10px] text-text-muted mb-0.5">Total Interest</div>
          <div className="text-xs font-mono font-medium text-text-primary">{formatCurrencyFull(schedule.summary.totalInterest)}</div>
        </div>
        <div className="card py-2 text-center">
          <div className="text-[10px] text-text-muted mb-0.5">Total Principal</div>
          <div className="text-xs font-mono font-medium text-text-primary">{formatCurrencyFull(schedule.summary.totalPrincipal)}</div>
        </div>
        <div className="card py-2 text-center">
          <div className="text-[10px] text-text-muted mb-0.5">Balloon Balance</div>
          {/* Band sourced from server (summary.balloonBand). 'danger' → high-risk color; otherwise neutral. */}
          <div className={`text-xs font-mono font-medium ${schedule.summary.balloonBand === 'danger' ? 'text-risk-high' : 'text-text-primary'}`}>
            {formatCurrencyFull(schedule.summary.balloonBalance)}
          </div>
        </div>
        <div className="card py-2 text-center">
          <div className="text-[10px] text-text-muted mb-0.5">Min DSCR</div>
          {/* Band sourced from server (summary.minDscrBand). null → muted (degraded). */}
          <div className={`text-xs font-mono font-medium ${
            schedule.summary.minDscrBand == null
              ? 'text-text-muted'
              : schedule.summary.minDscrBand === 'danger'
              ? 'text-risk-high'
              : schedule.summary.minDscrBand === 'warning'
              ? 'text-risk-medium'
              : 'text-risk-positive'
          }`}>
            {schedule.summary.minDSCR === null ? 'NOT COMPUTABLE' : formatMultipleSafe(schedule.summary.minDSCR)}
          </div>
          <div className="text-[10px] text-text-muted">
            {schedule.summary.minDSCRMonth === null ? '—' : `Month ${schedule.summary.minDSCRMonth}`}
          </div>
        </div>
      </div>

      {/* IO/Amort Visual Timeline */}
      {termMonths > 0 && (
        <div className="card">
          <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">Timeline</h3>
          <div className="w-full h-6 bg-bg-tertiary rounded-full overflow-hidden flex">
            {ioMonths > 0 && (
              <div
                className="h-full bg-risk-medium/40 flex items-center justify-center text-[10px] text-risk-medium font-medium"
                style={{ width: `${(ioMonths / termMonths) * 100}%` }}
              >
                IO ({ioMonths}m)
              </div>
            )}
            <div
              className="h-full bg-accent/30 flex items-center justify-center text-[10px] text-accent font-medium"
              style={{ width: `${((termMonths - ioMonths) / termMonths) * 100}%` }}
            >
              P+I ({termMonths - ioMonths}m)
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-text-muted mt-1">
            <span>{details.originationDate}</span>
            {ioMonths > 0 && <span>IO ends: {schedule.summary.ioEndDate}</span>}
            <span>Maturity: {schedule.summary.balloonDate}</span>
          </div>
        </div>
      )}

      {/* Interactive Term Controls */}
      <div className="card">
        <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Adjust Loan Terms</h3>
        <div className="grid grid-cols-2 gap-3">
          <LoanTermInput label="Interest Rate (%)" value={uwModel.interestRate} onSave={(v) => onUpdateTerms({ interestRate: v })} step={0.125} />
          <LoanTermInput label="IO Period (months)" value={ioMonths} onSave={(v) => onUpdateTerms({ ioMonths: v })} step={1} />
          <LoanTermInput label="Term (months)" value={termMonths} onSave={(v) => onUpdateTerms({ termMonths: v })} step={12} />
          <LoanTermInput label="Amortization (months)" value={amortMonths} onSave={(v) => onUpdateTerms({ amortizationMonths: v })} step={12} />
        </div>
      </div>

      {/* Month-by-Month Schedule Table */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-accent uppercase tracking-wider">Payment Schedule</h3>
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs text-accent hover:text-accent-hover"
          >
            {showAll ? 'Show Summary' : `Show All ${entries.length} Months`}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="table-header text-left">Month</th>
                <th className="table-header text-left">Date</th>
                <th className="table-header text-center">Period</th>
                <th className="table-header mono">Beg Balance</th>
                <th className="table-header mono">Principal</th>
                <th className="table-header mono">Interest</th>
                <th className="table-header mono">Total Pmt</th>
                <th className="table-header mono">End Balance</th>
                <th className="table-header mono">Cum. Principal</th>
                <th className="table-header mono">DSCR</th>
              </tr>
            </thead>
            <tbody>
              {displayEntries.map((entry, idx) => {
                // Detect gap between compressed rows
                const prevEntry = idx > 0 ? displayEntries[idx - 1] : null;
                const hasGap = prevEntry && entry.month - prevEntry.month > 1;

                return (
                  <React.Fragment key={entry.month}>
                    {hasGap && !showAll && (
                      <tr>
                        <td colSpan={10} className="text-center text-text-muted py-1 text-[10px] bg-bg-tertiary/30">
                          ... months {prevEntry.month + 1}–{entry.month - 1} ...
                        </td>
                      </tr>
                    )}
                    <tr className={`${entry.isIO ? 'bg-risk-medium/5' : ''} ${entry.month === ioMonths + 1 && ioMonths > 0 ? 'border-t-2 border-accent' : ''}`}>
                      <td className="table-cell font-mono">{entry.month}</td>
                      <td className="table-cell">{entry.date}</td>
                      <td className="table-cell text-center">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${entry.isIO ? 'bg-risk-medium/10 text-risk-medium' : 'bg-accent/10 text-accent'}`}>
                          {entry.isIO ? 'IO' : 'P+I'}
                        </span>
                      </td>
                      <td className="table-cell mono text-right">{formatCurrencyFull(entry.beginningBalance)}</td>
                      <td className="table-cell mono text-right">{formatCurrencyFull(entry.scheduledPrincipal)}</td>
                      <td className="table-cell mono text-right">{formatCurrencyFull(entry.interest)}</td>
                      <td className="table-cell mono text-right font-medium">{formatCurrencyFull(entry.totalPayment)}</td>
                      <td className="table-cell mono text-right">{formatCurrencyFull(entry.endingBalance)}</td>
                      <td className="table-cell mono text-right">{formatCurrencyFull(entry.cumulativePrincipal)}</td>
                      {/* Band sourced from server (entry.monthlyDscrBand). null → muted (degraded). */}
                      <td className={`table-cell mono text-right ${
                        entry.monthlyDscrBand == null
                          ? 'text-text-muted'
                          : entry.monthlyDscrBand === 'danger'
                          ? 'text-risk-high'
                          : entry.monthlyDscrBand === 'warning'
                          ? 'text-risk-medium'
                          : 'text-risk-positive'
                      }`}>
                        {entry.monthlyDSCR === null ? 'N/A' : formatMultipleSafe(entry.monthlyDSCR)}
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LoanTermInput({ label, value, onSave, step }: {
  label: string;
  value: number;
  onSave: (val: number) => void;
  step: number;
}) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState(String(value));

  return (
    <div>
      <label className="text-[10px] text-text-muted block mb-1">{label}</label>
      {editing ? (
        <input
          type="number"
          value={inputVal}
          step={step}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={() => {
            const num = parseFloat(inputVal);
            if (!isNaN(num) && num !== value) onSave(num);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const num = parseFloat(inputVal);
              if (!isNaN(num) && num !== value) onSave(num);
              setEditing(false);
            }
            if (e.key === 'Escape') setEditing(false);
          }}
          className="input-field w-full text-right font-mono text-sm py-1"
          autoFocus
        />
      ) : (
        <div
          onClick={() => { setInputVal(String(value)); setEditing(true); }}
          className="input-field w-full text-right font-mono text-sm py-1 cursor-pointer hover:border-accent"
        >
          {value}
        </div>
      )}
    </div>
  );
}

// --- Sub-components ---

function FindingCard({ finding, mitigationCount, onComment }: { finding: Finding; mitigationCount?: number; onComment: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  const confidenceColor = finding.confidence === 'high' ? 'bg-risk-positive/10 text-risk-positive' :
    finding.confidence === 'low' ? 'bg-risk-high/10 text-risk-high' :
    'bg-bg-tertiary text-text-muted';

  return (
    <div className="card py-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="flex items-start gap-2">
        <span className={`badge badge-${finding.severity} shrink-0 mt-0.5`}>{finding.severity}</span>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-text-primary">{finding.title}</h4>
          <div className="flex items-center gap-2 mt-0.5">
            {finding.pageReferences?.[0] && (
              <span className="text-xs text-accent">
                p.{finding.pageReferences[0].page} — {finding.pageReferences[0].sectionTitle}
              </span>
            )}
            {finding.confidence && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-medium ${confidenceColor}`}>
                {finding.confidence} conf
              </span>
            )}
            {(mitigationCount ?? 0) > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                {mitigationCount} mitigation{mitigationCount! > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pl-6">
          <p className="text-xs text-text-secondary mb-2">{finding.explanation}</p>
          {finding.impact?.description && (
            <p className="text-xs text-risk-medium mb-2">Impact: {finding.impact.description}</p>
          )}
          {finding.pageReferences?.map((ref, i) => (
            <div key={i} className="text-xs text-text-muted mb-1">
              <span className="text-accent">Page {ref.page}</span> — {ref.sectionTitle}
              {ref.excerpt && <span className="italic ml-1">"{ref.excerpt.slice(0, 100)}"</span>}
            </div>
          ))}
          <button
            onClick={(e) => { e.stopPropagation(); onComment(finding.id); }}
            className="text-xs text-accent hover:text-accent-hover mt-1"
          >
            Add Comment
          </button>
        </div>
      )}
    </div>
  );
}

function CrossCheckRow({ finding }: { finding: CrossCheckFinding }) {
  const [expanded, setExpanded] = useState(false);

  const sellerVal = finding.sellerBankValue || finding.asrValue || '';
  const bpVal = finding.bpSpiralValue || finding.uwValue || '';
  const pctVar = finding.percentVariance;
  const flag = finding.flag;
  const commentary = finding.commentary;

  const flagColor = flag === 'material' ? 'bg-risk-high/20 text-risk-high' :
                    flag === 'moderate' ? 'bg-risk-medium/20 text-risk-medium' :
                    'bg-bg-tertiary text-text-muted';
  const flagLabel = flag === 'material' ? 'Material Credit Deviation' :
                    flag === 'moderate' ? 'Moderate Adjustment' :
                    'Minor Adjustment';

  return (
    <>
      <tr className="cursor-pointer hover:bg-bg-tertiary/30" onClick={() => setExpanded(!expanded)}>
        <td className="table-cell text-text-primary font-medium">{finding.metric}</td>
        <td className="table-cell mono text-center">{sellerVal}</td>
        <td className="table-cell mono text-center font-medium">{bpVal}</td>
        <td className="table-cell mono text-center">
          {pctVar !== null && pctVar !== undefined ? (
            <span className={pctVar > 0 ? 'text-risk-positive' : pctVar < 0 ? 'text-risk-high' : 'text-text-muted'}>
              {pctVar >= 0 ? '+' : ''}{pctVar.toFixed(1)}%
            </span>
          ) : (
            <span className="text-text-muted">{finding.absoluteVariance || finding.difference || 'N/A'}</span>
          )}
        </td>
        <td className="table-cell text-center">
          {flag ? (
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${flagColor}`}>{flag}</span>
          ) : (
            <span className={`badge badge-${finding.severity}`}>{finding.severity}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="px-4 py-3 bg-bg-tertiary/20">
            {commentary && (
              <p className="text-xs text-text-primary mb-2">{commentary}</p>
            )}
            {!commentary && finding.explanation && (
              <p className="text-xs text-text-secondary mb-2">{finding.explanation}</p>
            )}
            <div className="flex gap-4 text-xs text-text-muted">
              {finding.sellerSource?.sectionTitle && (
                <span>Source: {finding.sellerSource.sectionTitle}{finding.sellerSource.page ? ` (p.${finding.sellerSource.page})` : ''}</span>
              )}
              {!finding.sellerSource?.sectionTitle && finding.asrSource?.sectionTitle && (
                <span>ASR: p.{finding.asrSource.page} — {finding.asrSource.sectionTitle}</span>
              )}
              <span>BP: {finding.bpSource || 'BP Spiral UW Model'}</span>
              {flag && <span className={`font-medium ${flagColor}`}>{flagLabel}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function CriteriaCard({ evaluation }: { evaluation: CriteriaEvaluation }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card py-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="flex items-center gap-2">
        <span className={`badge badge-${evaluation.result === 'pass' ? 'pass' : evaluation.result === 'fail' ? 'fail' : 'unknown'}`}>
          {evaluation.result.toUpperCase()}
        </span>
        <span className="text-sm text-text-primary">{evaluation.ruleName}</span>
      </div>
      {expanded && (
        <div className="mt-2 pl-6">
          <p className="text-xs text-text-secondary">{evaluation.reason}</p>
          {evaluation.source && (
            <p className="text-xs text-accent mt-1">{evaluation.source}</p>
          )}
        </div>
      )}
    </div>
  );
}

function UWTable({ items, onUpdate, pathPrefix }: {
  items: any[];
  onUpdate: (path: string, value: number) => void;
  pathPrefix: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="table-header text-left">Line Item</th>
          <th className="table-header mono">Annual Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className={item.label.includes('Total') || item.label.includes('Effective') ? 'bg-bg-tertiary/50 font-medium' : ''}>
            <td className="table-cell text-text-secondary">{item.label}</td>
            <td className="table-cell mono">
              {item.isEditable && !item.label.includes('Total') && !item.label.includes('Effective') ? (
                <EditableCell
                  value={item.annualAmount}
                  onSave={(val) => {
                    const fieldMap: Record<string, string> = {
                      'Gross Potential Rent': `${pathPrefix}.grossPotentialRent.annualAmount`,
                      'Vacancy Loss': `${pathPrefix}.vacancyLoss.annualAmount`,
                      'Concessions': `${pathPrefix}.concessions.annualAmount`,
                      'Other Income': `${pathPrefix}.otherIncome.annualAmount`,
                      'Real Estate Taxes': `${pathPrefix}.realEstateTaxes.annualAmount`,
                      'Insurance': `${pathPrefix}.insurance.annualAmount`,
                      'Utilities': `${pathPrefix}.utilities.annualAmount`,
                      'Repairs & Maintenance': `${pathPrefix}.repairsAndMaintenance.annualAmount`,
                      'Management Fee': `${pathPrefix}.management.annualAmount`,
                      'General & Admin': `${pathPrefix}.generalAndAdmin.annualAmount`,
                      'Payroll': `${pathPrefix}.payroll.annualAmount`,
                      'Replacement Reserves': `${pathPrefix}.replacementReserves.annualAmount`,
                    };
                    const path = fieldMap[item.label];
                    if (path) onUpdate(path, val);
                  }}
                />
              ) : (
                <span className={item.annualAmount < 0 ? 'text-risk-high' : ''}>
                  {formatCurrencyFull(item.annualAmount)}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditableCell({ value, onSave }: { value: number; onSave: (val: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState(String(value));

  if (editing) {
    return (
      <input
        type="number"
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onBlur={() => {
          const num = parseFloat(inputVal);
          if (!isNaN(num) && num !== value) onSave(num);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const num = parseFloat(inputVal);
            if (!isNaN(num) && num !== value) onSave(num);
            setEditing(false);
          }
          if (e.key === 'Escape') setEditing(false);
        }}
        className="input-field w-32 text-right font-mono text-sm py-0.5"
        autoFocus
      />
    );
  }

  return (
    <span
      onClick={() => { setInputVal(String(value)); setEditing(true); }}
      className={`cursor-pointer hover:text-accent ${value < 0 ? 'text-risk-high' : ''}`}
      title="Click to edit"
    >
      {formatCurrencyFull(value)}
    </span>
  );
}

function MetricRow({ label, value, highlight, editable, onUpdate, currentValue }: {
  label: string;
  value: string;
  highlight?: 'safe' | 'warning' | 'danger';
  editable?: boolean;
  onUpdate?: (val: number) => void;
  currentValue?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState(String(currentValue || 0));

  const colorClass = highlight === 'danger' ? 'text-risk-high' : highlight === 'warning' ? 'text-risk-medium' : highlight === 'safe' ? 'text-risk-positive' : 'text-text-primary';

  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-text-secondary">{label}</span>
      {editable && editing ? (
        <input
          type="number"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={() => {
            const num = parseFloat(inputVal);
            if (!isNaN(num) && onUpdate) onUpdate(num);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const num = parseFloat(inputVal);
              if (!isNaN(num) && onUpdate) onUpdate(num);
              setEditing(false);
            }
          }}
          className="input-field w-32 text-right font-mono text-sm py-0.5"
          autoFocus
        />
      ) : (
        <span
          className={`font-mono text-sm ${colorClass} ${editable ? 'cursor-pointer hover:text-accent' : ''}`}
          onClick={() => {
            if (editable) {
              setInputVal(String(currentValue || 0));
              setEditing(true);
            }
          }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { ASSET_TYPES } from '@cre/shared';
import type { AssetType } from '@cre/shared';

interface AdjustmentStats {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  sampleSize: number;
}

interface RejectionPattern {
  pattern: string;
  metric: string;
  threshold: number | null;
  rejectionRate: number;
  sampleSize: number;
  totalRejected: number;
  severity: 'critical' | 'high' | 'medium';
}

interface PatternInsights {
  assetType: string;
  totalDeals: number;
  outcomeBreakdown: { approved: number; modified: number; rejected: number };
  noiHaircut: AdjustmentStats | null;
  capRateExpansion: AdjustmentStats | null;
  maxLTV: AdjustmentStats | null;
  avgDSCR: AdjustmentStats | null;
  reserveSizes: AdjustmentStats | null;
  topDealKillers: { reason: string; frequency: number }[];
  rejectionPatterns: RejectionPattern[];
  rejectedDealStats: {
    avgDSCR: AdjustmentStats | null;
    avgLTV: AdjustmentStats | null;
    avgVacancy: AdjustmentStats | null;
    avgNOIHaircut: AdjustmentStats | null;
  } | null;
  lastUpdated: string;
}

interface LearnedRule {
  id: string;
  rule: string;
  assetType: string;
  category: string;
  metric: string | null;
  threshold: number | null;
  pctDealsAffected: number | null;
  pctDealsRejected: number | null;
  confidenceLevel: string;
  sampleSize: number;
  status: string;
  version: number;
}

interface RuleMetadata {
  lastUpdated: string | null;
  totalDeals: number;
  rejected: number;
  approved: number;
  modified: number;
  ruleCount: number;
  ruleVersion: number;
}

interface RuleVersionEntry {
  ruleId: string;
  version: number;
  rule: string;
  confidenceLevel: string;
  sampleSize: number;
  createdAt: string;
  reason: string;
}

interface OutcomeMatchEntry {
  rowIndex: number;
  dealName: string;
  assetClass: string;
  year: number | null;
  outcome: string;
  kickReason: string | null;
  notes: string | null;
  matchedUWId: string | null;
  matchedDealName: string | null;
  matchConfidence: string;
  reviewStatus: string;
  matchScore: number;
  applied: boolean;
}

interface OutcomesUploadResult {
  fileName: string;
  totalRows: number;
  matched: number;
  needsReview: number;
  unmatched: number;
  applied: number;
  affectedAssetTypes: string[];
  matches: OutcomeMatchEntry[];
  uploadedAt: string;
}

export default function UnderwritingInsightsPage() {
  const [assetType, setAssetType] = useState<AssetType | undefined>(undefined);
  const [insights, setInsights] = useState<PatternInsights | null>(null);
  const [rules, setRules] = useState<LearnedRule[]>([]);
  const [sufficiency, setSufficiency] = useState<{ sufficient: boolean; totalDeals: number; minimumRequired: number; message: string } | null>(null);
  const [ruleMetadata, setRuleMetadata] = useState<RuleMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<string | null>(null);
  const [versionHistory, setVersionHistory] = useState<RuleVersionEntry[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  // --- Rejected Deals Upload state ---
  const [outcomesFile, setOutcomesFile] = useState<File | null>(null);
  const [outcomesUploading, setOutcomesUploading] = useState(false);
  const [outcomesResult, setOutcomesResult] = useState<OutcomesUploadResult | null>(null);
  const [outcomesError, setOutcomesError] = useState<string | null>(null);
  const [outcomesExpanded, setOutcomesExpanded] = useState(true);

  // --- Unmatched Outcomes state ---
  const [unmatchedOutcomes, setUnmatchedOutcomes] = useState<{ id: string; sourceFileName: string; sourceRowId: number; dealName: string | null; propertyName: string | null; loanAmount: number | null; city: string | null; state: string | null; assetClass: string | null; year: number | null; outcome: string; kickReason: string | null; notes: string | null; linkedUWId: string | null; uploadedAt: string }[]>([]);
  const [unmatchedLoading, setUnmatchedLoading] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkUWSearch, setLinkUWSearch] = useState('');
  const [uwSearchResults, setUwSearchResults] = useState<{ id: string; dealName: string; assetType: string; city: string; state: string; year: number }[]>([]);
  const [syncing, setSyncing] = useState(false);

  // --- Credit Manifesto state ---
  const [manifestoFile, setManifestoFile] = useState<File | null>(null);
  const [manifestoUploading, setManifestoUploading] = useState(false);
  const [manifestoError, setManifestoError] = useState<string | null>(null);
  const [manifestoSuccess, setManifestoSuccess] = useState<string | null>(null);
  const [activeManifesto, setActiveManifesto] = useState<any | null>(null);
  const [manifestoHistory, setManifestoHistory] = useState<any[]>([]);
  const [manifestoExpanded, setManifestoExpanded] = useState(true);
  const [manifestoProcessing, setManifestoProcessing] = useState<string | null>(null);

  // --- Template Management state ---
  const [templateExpanded, setTemplateExpanded] = useState(true);
  const [singleLoanFile, setSingleLoanFile] = useState<File | null>(null);
  const [rollUpFile, setRollUpFile] = useState<File | null>(null);
  const [singleLoanTemplates, setSingleLoanTemplates] = useState<any[]>([]);
  const [rollUpTemplates, setRollUpTemplates] = useState<any[]>([]);
  const [templateUploading, setTemplateUploading] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSuccess, setTemplateSuccess] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [insightsData, rulesData, suffData, metaData] = await Promise.all([
        api.getInsights(assetType),
        api.listLearnedRules(assetType),
        api.getDataSufficiency(assetType),
        api.getRuleMetadata(),
      ]);
      setInsights(insightsData.insights);
      setRules(rulesData.rules);
      setSufficiency(suffData);
      setRuleMetadata(metaData.metadata);
    } catch {}
    setLoading(false);
  }, [assetType]);

  const loadTemplates = useCallback(async () => {
    try {
      const [singleData, rollUpData] = await Promise.all([
        api.listTemplates('single_loan'),
        api.listTemplates('roll_up'),
      ]);
      setSingleLoanTemplates(singleData.templates || []);
      setRollUpTemplates(rollUpData.templates || []);
    } catch {}
  }, []);

  const loadManifesto = useCallback(async () => {
    try {
      const [activeData, historyData] = await Promise.all([
        api.getActiveManifesto().catch(() => ({ manifesto: null, hasManifesto: false })),
        api.getManifestoHistory(),
      ]);
      setActiveManifesto(activeData.manifesto || null);
      setManifestoHistory(historyData.manifestos || []);
    } catch {}
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);
  useEffect(() => { loadManifesto(); }, [loadManifesto]);

  const handleRecalculateRules = async () => {
    setGenerating(true);
    try {
      await api.generateRules(assetType);
      await loadData();
    } catch {}
    setGenerating(false);
  };

  const handleRuleAction = async (id: string, status: string) => {
    await api.updateLearnedRule(id, { status });
    await loadData();
  };

  const handleDeleteRule = async (id: string) => {
    await api.deleteLearnedRule(id);
    await loadData();
  };

  const handleApproveAll = async () => {
    const pending = rules.filter(r => r.status !== 'approved');
    if (pending.length === 0) return;
    for (const rule of pending) {
      await api.updateLearnedRule(rule.id, { status: 'approved' });
    }
    await loadData();
  };

  const handleToggleVersions = async (ruleId: string) => {
    if (expandedVersions === ruleId) {
      setExpandedVersions(null);
      setVersionHistory([]);
      return;
    }
    setExpandedVersions(ruleId);
    setLoadingVersions(true);
    try {
      const data = await api.getRuleVersions(ruleId);
      setVersionHistory(data.versions || []);
    } catch {
      setVersionHistory([]);
    }
    setLoadingVersions(false);
  };

  const handleRollback = async (ruleId: string, version: number) => {
    await api.rollbackRule(ruleId, version);
    await loadData();
    setExpandedVersions(null);
  };

  // --- Unmatched Outcomes loading ---
  const loadUnmatchedOutcomes = useCallback(async () => {
    setUnmatchedLoading(true);
    try {
      const data = await api.listUnmatchedOutcomes();
      setUnmatchedOutcomes(data.outcomes || []);
    } catch {
      setUnmatchedOutcomes([]);
    }
    setUnmatchedLoading(false);
  }, []);

  useEffect(() => { loadUnmatchedOutcomes(); }, [loadUnmatchedOutcomes]);

  const handleLinkOutcome = async (unmatchedId: string, uwId: string) => {
    try {
      await api.linkUnmatchedOutcome(unmatchedId, uwId);
      setLinkingId(null);
      setLinkUWSearch('');
      setUwSearchResults([]);
      await loadUnmatchedOutcomes();
      await loadData();
    } catch {}
  };

  const handleDeleteUnmatched = async (id: string) => {
    try {
      await api.deleteUnmatchedOutcome(id);
      await loadUnmatchedOutcomes();
    } catch {}
  };

  const handleSearchUWForLink = async (query: string) => {
    setLinkUWSearch(query);
    if (query.trim().length < 2) { setUwSearchResults([]); return; }
    try {
      const data = await api.listHistoricalUWs();
      const q = query.toLowerCase();
      const filtered = (data.underwritings || [])
        .filter((u: any) => u.dealName?.toLowerCase().includes(q) || u.city?.toLowerCase().includes(q))
        .slice(0, 10)
        .map((u: any) => ({ id: u.id, dealName: u.dealName, assetType: u.assetType, city: u.city, state: u.state, year: u.year }));
      setUwSearchResults(filtered);
    } catch { setUwSearchResults([]); }
  };

  // --- Rejected Deals Upload handlers ---
  const handleOutcomesUpload = async () => {
    if (!outcomesFile) return;
    setOutcomesUploading(true);
    setOutcomesError(null);
    setOutcomesResult(null);
    try {
      const result = await api.uploadDealOutcomes(outcomesFile);
      setOutcomesResult(result);
      // Refresh insights data and unmatched outcomes
      if (result.applied > 0) {
        await loadData();
      }
      await loadUnmatchedOutcomes();
    } catch (err: any) {
      setOutcomesError(err.message || 'Upload failed');
    }
    setOutcomesUploading(false);
  };

  const handleApplyOutcome = async (match: OutcomeMatchEntry) => {
    if (!match.matchedUWId) return;
    try {
      await api.applyOutcomeMatch(match.matchedUWId, match.outcome, match.kickReason || undefined, match.notes || undefined);
      // Update the local result to reflect the change
      if (outcomesResult) {
        const updatedMatches = outcomesResult.matches.map(m =>
          m.rowIndex === match.rowIndex ? { ...m, applied: true, reviewStatus: 'matched' } : m
        );
        setOutcomesResult({
          ...outcomesResult,
          matches: updatedMatches,
          applied: outcomesResult.applied + 1,
          matched: outcomesResult.matched + 1,
          needsReview: Math.max(0, outcomesResult.needsReview - 1),
        });
      }
      await loadData();
    } catch {}
  };

  // --- Template Management handlers ---
  const handleTemplateUpload = async (templateType: 'single_loan' | 'roll_up') => {
    const file = templateType === 'single_loan' ? singleLoanFile : rollUpFile;
    if (!file) return;
    setTemplateUploading(templateType);
    setTemplateError(null);
    setTemplateSuccess(null);
    try {
      const result = await api.uploadTemplate(file, templateType);
      if (templateType === 'single_loan') setSingleLoanFile(null);
      else setRollUpFile(null);
      await loadTemplates();
      const structure = result.structure;
      const tabSummary = structure?.tabs
        ? `${structure.totalTabs} tabs detected (${structure.totalFormulaCells} formulas, ${structure.totalInputCells} input cells)`
        : '';
      setTemplateSuccess(`Template successfully uploaded and saved. ${tabSummary}`);
    } catch (err: any) {
      setTemplateError(err.message || 'Upload failed – file not saved correctly. Please retry.');
    }
    setTemplateUploading(null);
  };

  const handleActivateTemplate = async (id: string) => {
    try {
      await api.activateTemplateVersion(id);
      await loadTemplates();
    } catch {}
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await api.deleteTemplate(id);
      await loadTemplates();
    } catch {}
  };

  // --- Manifesto handlers ---
  const handleManifestoUpload = async () => {
    if (!manifestoFile) return;
    setManifestoUploading(true);
    setManifestoError(null);
    setManifestoSuccess(null);
    try {
      const result = await api.uploadManifesto(manifestoFile);
      setManifestoSuccess(`Manifesto v${result.version} uploaded. Extracting rules...`);
      setManifestoProcessing(result.id);
      setManifestoFile(null);
      // Poll for completion
      const interval = setInterval(async () => {
        try {
          const status = await api.getManifestoStatus(result.id);
          if (status.status === 'active') {
            clearInterval(interval);
            setManifestoProcessing(null);
            setManifestoSuccess(`Manifesto active: ${status.extractedRulesCount} rules extracted, ${status.ambiguitiesCount} ambiguities flagged.`);
            await loadManifesto();
            await loadData();
          } else if (status.status === 'error') {
            clearInterval(interval);
            setManifestoProcessing(null);
            setManifestoError(`Extraction failed: ${status.error}`);
            await loadManifesto();
          }
        } catch {
          clearInterval(interval);
          setManifestoProcessing(null);
        }
      }, 3000);
    } catch (err: any) {
      setManifestoError(err.message || 'Upload failed');
    }
    setManifestoUploading(false);
  };

  const handleActivateManifesto = async (id: string) => {
    try {
      await api.activateManifesto(id);
      await loadManifesto();
      await loadData();
    } catch {}
  };

  const formatTimestamp = (iso: string | null) => {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Underwriting Insights</h1>
          <p className="text-sm text-text-secondary">
            Patterns and credit rules from historical underwritings and deal outcomes
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={handleRecalculateRules}
            disabled={generating || !sufficiency?.sufficient}
            className="btn-primary text-sm disabled:opacity-40"
          >
            {generating ? 'Recalculating...' : 'Recalculate Credit Rules'}
          </button>
          {ruleMetadata && ruleMetadata.lastUpdated && (
            <div className="text-xs text-text-muted text-right">
              <div>Last Updated: {formatTimestamp(ruleMetadata.lastUpdated)}</div>
              <div>
                Based on: {ruleMetadata.totalDeals} deals | {ruleMetadata.rejected} rejected | {ruleMetadata.approved} approved
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Asset Type Filter */}
      <div className="flex gap-2 mb-6 flex-wrap">
        <button
          onClick={() => setAssetType(undefined)}
          className={`px-4 py-2 rounded text-sm transition-colors ${
            !assetType
              ? 'bg-accent text-bg-primary font-semibold'
              : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'
          }`}
        >
          All
        </button>
        {ASSET_TYPES.map((type) => (
          <button
            key={type.value}
            onClick={() => setAssetType(type.value)}
            className={`px-4 py-2 rounded text-sm transition-colors ${
              assetType === type.value
                ? 'bg-accent text-bg-primary font-semibold'
                : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* ================================================================= */}
      {/* Credit Manifesto                                                    */}
      {/* ================================================================= */}
      <div className="mb-8 border border-border-primary rounded-lg overflow-hidden">
        <button
          onClick={() => setManifestoExpanded(!manifestoExpanded)}
          className="w-full flex items-center justify-between px-6 py-4 bg-bg-secondary hover:bg-bg-tertiary transition-colors"
        >
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-bold text-text-primary uppercase tracking-wider">Credit Manifesto</h2>
            {activeManifesto ? (
              <span className="text-xs px-2 py-0.5 rounded bg-risk-positive/20 text-risk-positive">
                v{activeManifesto.version} Active
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded bg-risk-high/20 text-risk-high">
                Not Uploaded
              </span>
            )}
          </div>
          <span className="text-xs text-text-muted">{manifestoExpanded ? 'Collapse' : 'Expand'}</span>
        </button>

        {manifestoExpanded && (
          <div className="p-6">
            {!activeManifesto && (
              <div className="mb-4 p-3 bg-risk-high/10 border border-risk-high/30 rounded text-sm text-risk-high">
                No credit manifesto uploaded. Analyses are blocked until a manifesto is provided. The manifesto is the single source of truth for all credit decisions.
              </div>
            )}

            <p className="text-xs text-text-muted mb-4">
              Upload your credit policy document (PDF, DOCX, or TXT). All credit rules will be extracted and enforced automatically. Only rules defined in the manifesto will be used for underwriting decisions.
            </p>

            {manifestoError && (
              <div className="mb-4 p-3 bg-risk-high/10 border border-risk-high/30 rounded text-sm text-risk-high">
                {manifestoError}
              </div>
            )}
            {manifestoSuccess && (
              <div className="mb-4 p-3 bg-risk-positive/10 border border-risk-positive/30 rounded text-sm text-risk-positive">
                {manifestoSuccess}
              </div>
            )}

            {/* Upload Section */}
            <div className="flex items-center gap-3 mb-6">
              <label className="text-sm text-text-secondary font-medium">Upload Credit Manifesto:</label>
              <input
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={(e) => setManifestoFile(e.target.files?.[0] || null)}
                className="text-sm text-text-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-bg-tertiary file:text-text-primary file:cursor-pointer"
              />
              <button
                onClick={handleManifestoUpload}
                disabled={!manifestoFile || manifestoUploading || !!manifestoProcessing}
                className="btn-primary text-sm disabled:opacity-40"
              >
                {manifestoUploading ? 'Uploading...' : manifestoProcessing ? 'Extracting Rules...' : 'Upload'}
              </button>
            </div>

            {/* Processing indicator */}
            {manifestoProcessing && (
              <div className="mb-4 p-3 bg-accent/10 border border-accent/30 rounded text-sm text-accent flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                Extracting credit rules from manifesto... This may take 30-60 seconds.
              </div>
            )}

            {/* Active Manifesto Card */}
            {activeManifesto && (
              <div className="mb-6 p-4 bg-bg-secondary rounded border border-border-primary">
                <h3 className="text-sm font-bold text-text-primary mb-2">Active Manifesto</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                  <div>
                    <div className="text-text-muted">Version</div>
                    <div className="text-text-primary font-medium">v{activeManifesto.version}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">File</div>
                    <div className="text-text-primary font-medium">{activeManifesto.fileName}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">Rules Extracted</div>
                    <div className="text-text-primary font-medium">{activeManifesto.extractedRulesCount}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">Ambiguities</div>
                    <div className={`font-medium ${activeManifesto.ambiguitiesCount > 0 ? 'text-risk-high' : 'text-risk-positive'}`}>
                      {activeManifesto.ambiguitiesCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-text-muted">Uploaded</div>
                    <div className="text-text-primary font-medium">{formatTimestamp(activeManifesto.uploadedAt)}</div>
                  </div>
                  <div>
                    <div className="text-text-muted">Asset Types</div>
                    <div className="text-text-primary font-medium">
                      {activeManifesto.assetTypesCovered?.includes('all') ? 'All' : activeManifesto.assetTypesCovered?.join(', ')}
                    </div>
                  </div>
                </div>

                {/* Ambiguities */}
                {activeManifesto.ambiguities && activeManifesto.ambiguities.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-xs font-bold text-risk-high mb-2 uppercase tracking-wider">
                      Ambiguities Requiring Clarification ({activeManifesto.ambiguities.length})
                    </h4>
                    <div className="space-y-2">
                      {activeManifesto.ambiguities.map((a: any, i: number) => (
                        <div key={a.id || i} className="p-3 bg-bg-tertiary rounded border border-risk-high/20 text-xs">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                              a.severity === 'high' ? 'bg-risk-high/20 text-risk-high' :
                              a.severity === 'medium' ? 'bg-risk-medium/20 text-risk-medium' :
                              'bg-risk-low/20 text-risk-low'
                            }`}>{a.severity}</span>
                            <span className="text-text-muted">{a.location}</span>
                          </div>
                          <div className="text-text-primary mb-1 italic">&ldquo;{a.text}&rdquo;</div>
                          <div className="text-text-secondary"><span className="font-medium">Issue:</span> {a.issue}</div>
                          <div className="text-text-muted"><span className="font-medium">Suggestion:</span> {a.suggestion}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Version History */}
            {manifestoHistory.length > 1 && (
              <div>
                <h3 className="text-xs font-bold text-text-primary mb-2 uppercase tracking-wider">Version History</h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-muted border-b border-border-primary">
                      <th className="text-left py-2 pr-4">Version</th>
                      <th className="text-left py-2 pr-4">File</th>
                      <th className="text-left py-2 pr-4">Rules</th>
                      <th className="text-left py-2 pr-4">Status</th>
                      <th className="text-left py-2 pr-4">Uploaded</th>
                      <th className="text-left py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifestoHistory.map((m: any) => (
                      <tr key={m.id} className="border-b border-border-primary/50">
                        <td className="py-2 pr-4 text-text-primary">v{m.version}</td>
                        <td className="py-2 pr-4 text-text-secondary">{m.fileName}</td>
                        <td className="py-2 pr-4 text-text-primary">{m.extractedRulesCount}</td>
                        <td className="py-2 pr-4">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                            m.isActive ? 'bg-risk-positive/20 text-risk-positive' :
                            m.status === 'error' ? 'bg-risk-high/20 text-risk-high' :
                            'bg-bg-tertiary text-text-muted'
                          }`}>{m.isActive ? 'Active' : m.status}</span>
                        </td>
                        <td className="py-2 pr-4 text-text-muted">{formatTimestamp(m.uploadedAt)}</td>
                        <td className="py-2">
                          {!m.isActive && m.status !== 'error' && m.status !== 'processing' && (
                            <button
                              onClick={() => handleActivateManifesto(m.id)}
                              className="text-accent hover:underline"
                            >
                              Activate
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* Underwriting Template Management                                   */}
      {/* ================================================================= */}
      <div className="mb-8 border border-border-primary rounded-lg overflow-hidden">
        <button
          onClick={() => setTemplateExpanded(!templateExpanded)}
          className="w-full flex items-center justify-between px-6 py-4 bg-bg-secondary hover:bg-bg-tertiary transition-colors"
        >
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-bold text-text-primary uppercase tracking-wider">Underwriting Template Management</h2>
            <span className="text-xs text-text-muted">
              {(singleLoanTemplates.find((t: any) => t.isActive) ? 1 : 0) + (rollUpTemplates.find((t: any) => t.isActive) ? 1 : 0)} of 2 templates active
            </span>
          </div>
          <span className="text-xs text-text-muted">{templateExpanded ? 'Collapse' : 'Expand'}</span>
        </button>

        {templateExpanded && (
          <div className="p-6">
            <p className="text-xs text-text-muted mb-6">
              Upload and manage standardized underwriting templates. These templates are automatically applied when users create a new analysis.
              Each template is versioned — previous versions are retained and can be reactivated.
            </p>

            {templateError && (
              <div className="mb-4 p-3 bg-risk-high/10 border border-risk-high/30 rounded text-sm text-risk-high">
                {templateError}
              </div>
            )}

            {templateSuccess && (
              <div className="mb-4 p-3 bg-risk-positive/10 border border-risk-positive/30 rounded text-sm text-risk-positive">
                {templateSuccess}
              </div>
            )}

            <div className="grid grid-cols-2 gap-6">
              {/* Single Loan Template */}
              <div className="card">
                <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Single Loan Template</h3>
                {(() => {
                  const active = singleLoanTemplates.find((t: any) => t.isActive);
                  return active ? (
                    <div className="mb-4 p-3 bg-risk-positive/5 border border-risk-positive/30 rounded">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-risk-positive">{active.fileName}</div>
                          <div className="text-xs text-text-muted mt-1">
                            v{active.version} &middot; {(active.fileSize / 1024).toFixed(1)} KB &middot; Uploaded {formatTimestamp(active.uploadedAt)}
                          </div>
                          <div className="text-xs text-text-muted">by {active.uploadedBy}</div>
                        </div>
                        <a
                          href={api.getTemplateDownloadUrl(active.id)}
                          className="text-xs text-accent hover:underline"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="mb-4 p-3 bg-risk-medium/5 border border-risk-medium/30 rounded">
                      <div className="text-sm text-risk-medium">No Single Loan template uploaded</div>
                    </div>
                  );
                })()}

                {/* Upload / Replace */}
                <div className="flex items-center gap-3">
                  <label className="flex-1">
                    <input
                      type="file"
                      accept=".xlsx,.xls,.xlsm"
                      onChange={(e) => { setSingleLoanFile(e.target.files?.[0] || null); setTemplateError(null); }}
                      className="block w-full text-sm text-text-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-accent/10 file:text-accent hover:file:bg-accent/20 file:cursor-pointer"
                    />
                  </label>
                  <button
                    onClick={() => handleTemplateUpload('single_loan')}
                    disabled={!singleLoanFile || templateUploading === 'single_loan'}
                    className="btn-primary text-xs px-4 py-2 disabled:opacity-40 whitespace-nowrap"
                  >
                    {templateUploading === 'single_loan' ? 'Uploading...' : singleLoanTemplates.some((t: any) => t.isActive) ? 'Replace' : 'Upload'}
                  </button>
                </div>

                {/* Version History */}
                {singleLoanTemplates.length > 1 && (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-text-secondary mb-2">Version History</div>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {singleLoanTemplates.map((t: any) => (
                        <div key={t.id} className={`flex items-center justify-between text-xs px-3 py-2 rounded ${t.isActive ? 'bg-risk-positive/5 border border-risk-positive/20' : 'bg-bg-secondary border border-border-primary'}`}>
                          <div>
                            <span className="font-mono text-text-primary">v{t.version}</span>
                            <span className="text-text-muted ml-2">{t.fileName}</span>
                            {t.isActive && <span className="ml-2 text-risk-positive font-semibold">Active</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            {!t.isActive && (
                              <button onClick={() => handleActivateTemplate(t.id)} className="text-accent hover:underline">
                                Activate
                              </button>
                            )}
                            {!t.isActive && (
                              <button onClick={() => handleDeleteTemplate(t.id)} className="text-risk-critical hover:underline">
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Roll-Up / Portfolio Template */}
              <div className="card">
                <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Roll-Up / Portfolio Template</h3>
                {(() => {
                  const active = rollUpTemplates.find((t: any) => t.isActive);
                  return active ? (
                    <div className="mb-4 p-3 bg-risk-positive/5 border border-risk-positive/30 rounded">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-risk-positive">{active.fileName}</div>
                          <div className="text-xs text-text-muted mt-1">
                            v{active.version} &middot; {(active.fileSize / 1024).toFixed(1)} KB &middot; Uploaded {formatTimestamp(active.uploadedAt)}
                          </div>
                          <div className="text-xs text-text-muted">by {active.uploadedBy}</div>
                        </div>
                        <a
                          href={api.getTemplateDownloadUrl(active.id)}
                          className="text-xs text-accent hover:underline"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="mb-4 p-3 bg-risk-medium/5 border border-risk-medium/30 rounded">
                      <div className="text-sm text-risk-medium">No Roll-Up template uploaded</div>
                    </div>
                  );
                })()}

                {/* Upload / Replace */}
                <div className="flex items-center gap-3">
                  <label className="flex-1">
                    <input
                      type="file"
                      accept=".xlsx,.xls,.xlsm"
                      onChange={(e) => { setRollUpFile(e.target.files?.[0] || null); setTemplateError(null); }}
                      className="block w-full text-sm text-text-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-accent/10 file:text-accent hover:file:bg-accent/20 file:cursor-pointer"
                    />
                  </label>
                  <button
                    onClick={() => handleTemplateUpload('roll_up')}
                    disabled={!rollUpFile || templateUploading === 'roll_up'}
                    className="btn-primary text-xs px-4 py-2 disabled:opacity-40 whitespace-nowrap"
                  >
                    {templateUploading === 'roll_up' ? 'Uploading...' : rollUpTemplates.some((t: any) => t.isActive) ? 'Replace' : 'Upload'}
                  </button>
                </div>

                {/* Version History */}
                {rollUpTemplates.length > 1 && (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-text-secondary mb-2">Version History</div>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {rollUpTemplates.map((t: any) => (
                        <div key={t.id} className={`flex items-center justify-between text-xs px-3 py-2 rounded ${t.isActive ? 'bg-risk-positive/5 border border-risk-positive/20' : 'bg-bg-secondary border border-border-primary'}`}>
                          <div>
                            <span className="font-mono text-text-primary">v{t.version}</span>
                            <span className="text-text-muted ml-2">{t.fileName}</span>
                            {t.isActive && <span className="ml-2 text-risk-positive font-semibold">Active</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            {!t.isActive && (
                              <button onClick={() => handleActivateTemplate(t.id)} className="text-accent hover:underline">
                                Activate
                              </button>
                            )}
                            {!t.isActive && (
                              <button onClick={() => handleDeleteTemplate(t.id)} className="text-risk-critical hover:underline">
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-text-muted">Loading insights...</div>
      ) : (
        <>
          {/* Data Sufficiency Banner */}
          {sufficiency && !sufficiency.sufficient && (
            <div className="card mb-6 border-risk-medium/30 bg-risk-medium/5">
              <p className="text-sm text-risk-medium">{sufficiency.message}</p>
              <a href="/admin/underwriting-library" className="text-xs text-accent hover:text-accent-hover mt-1 inline-block">
                Go to Underwriting Library to upload files
              </a>
            </div>
          )}

          {insights && insights.totalDeals > 0 && (
            <>
              {/* Overview Cards */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <StatCard label="Total Deals" value={String(insights.totalDeals)} />
                <StatCard
                  label="Outcome Split"
                  value={`${insights.outcomeBreakdown.approved}A / ${insights.outcomeBreakdown.modified}M / ${insights.outcomeBreakdown.rejected}R`}
                />
                <StatCard
                  label="Avg NOI Haircut"
                  value={insights.noiHaircut ? `${Math.abs(insights.noiHaircut.mean).toFixed(1)}%` : 'N/A'}
                  sub={insights.noiHaircut ? `n=${insights.noiHaircut.sampleSize}` : ''}
                />
                <StatCard
                  label="Avg Cap Rate Expansion"
                  value={insights.capRateExpansion ? `+${insights.capRateExpansion.mean.toFixed(0)}bps` : 'N/A'}
                  sub={insights.capRateExpansion ? `n=${insights.capRateExpansion.sampleSize}` : ''}
                />
              </div>

              {/* Detailed Stats */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                {insights.maxLTV && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">LTV Distribution</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-text-muted">Average:</span> <span className="font-mono">{(insights.maxLTV.mean * 100).toFixed(1)}%</span></div>
                      <div><span className="text-text-muted">Median:</span> <span className="font-mono">{(insights.maxLTV.median * 100).toFixed(1)}%</span></div>
                      <div><span className="text-text-muted">Min:</span> <span className="font-mono">{(insights.maxLTV.min * 100).toFixed(1)}%</span></div>
                      <div><span className="text-text-muted">Max:</span> <span className="font-mono">{(insights.maxLTV.max * 100).toFixed(1)}%</span></div>
                      <div className="col-span-2"><span className="text-text-muted">Sample:</span> <span className="font-mono">{insights.maxLTV.sampleSize} deals</span></div>
                    </div>
                  </div>
                )}
                {insights.avgDSCR && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">DSCR Distribution</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-text-muted">Average:</span> <span className="font-mono">{insights.avgDSCR.mean.toFixed(2)}x</span></div>
                      <div><span className="text-text-muted">Median:</span> <span className="font-mono">{insights.avgDSCR.median.toFixed(2)}x</span></div>
                      <div><span className="text-text-muted">Min:</span> <span className="font-mono">{insights.avgDSCR.min.toFixed(2)}x</span></div>
                      <div><span className="text-text-muted">Max:</span> <span className="font-mono">{insights.avgDSCR.max.toFixed(2)}x</span></div>
                      <div className="col-span-2"><span className="text-text-muted">Sample:</span> <span className="font-mono">{insights.avgDSCR.sampleSize} deals</span></div>
                    </div>
                  </div>
                )}
                {insights.reserveSizes && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Reserve Sizes</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-text-muted">Average:</span> <span className="font-mono">${insights.reserveSizes.mean.toLocaleString()}</span></div>
                      <div><span className="text-text-muted">Median:</span> <span className="font-mono">${insights.reserveSizes.median.toLocaleString()}</span></div>
                      <div><span className="text-text-muted">Min:</span> <span className="font-mono">${insights.reserveSizes.min.toLocaleString()}</span></div>
                      <div><span className="text-text-muted">Max:</span> <span className="font-mono">${insights.reserveSizes.max.toLocaleString()}</span></div>
                    </div>
                  </div>
                )}
                {insights.topDealKillers.length > 0 && (
                  <div className="card">
                    <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">Top Deal Rejection Drivers</h3>
                    <ul className="space-y-2">
                      {insights.topDealKillers.map((killer, i) => (
                        <li key={i} className="flex items-center justify-between text-sm">
                          <span className="text-text-primary">{killer.reason}</span>
                          <span className="badge badge-fail">{killer.frequency}x</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Rejection Intelligence — quantitative patterns from kicked deals */}
              {insights.rejectionPatterns && insights.rejectionPatterns.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-sm font-semibold text-text-primary mb-1">Rejection Intelligence</h2>
                  <p className="text-xs text-text-muted mb-4">
                    Quantitative patterns extracted from rejected deals. These feed into rule generation and credit scoring.
                  </p>
                  <div className="space-y-2">
                    {insights.rejectionPatterns.map((rp, i) => (
                      <div key={i} className={`card flex items-center justify-between border-l-2 ${
                        rp.severity === 'critical' ? 'border-risk-critical' :
                        rp.severity === 'high' ? 'border-risk-high' : 'border-risk-medium'
                      }`}>
                        <div className="flex-1">
                          <div className="text-sm text-text-primary">{rp.pattern}</div>
                          <div className="text-xs text-text-muted mt-0.5">
                            {rp.metric} threshold: {rp.threshold ?? 'N/A'} &middot; {rp.totalRejected} rejected of {rp.sampleSize} deals
                          </div>
                        </div>
                        <div className="text-right ml-4 shrink-0">
                          <div className={`text-lg font-bold font-mono ${
                            rp.rejectionRate >= 70 ? 'text-risk-critical' :
                            rp.rejectionRate >= 45 ? 'text-risk-high' : 'text-risk-medium'
                          }`}>
                            {rp.rejectionRate}%
                          </div>
                          <div className="text-xs text-text-muted">rejection rate</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Rejected Deal Profile — stats from kicked deals only */}
              {insights.rejectedDealStats && (
                <div className="grid grid-cols-4 gap-4 mb-6">
                  {insights.rejectedDealStats.avgDSCR && (
                    <div className="card border-l-2 border-risk-high">
                      <div className="text-xs text-text-muted mb-1">Rejected Deals — Avg DSCR</div>
                      <div className="text-lg font-semibold font-mono text-risk-high">{insights.rejectedDealStats.avgDSCR.mean.toFixed(2)}x</div>
                      <div className="text-xs text-text-muted">Range: {insights.rejectedDealStats.avgDSCR.min.toFixed(2)}x – {insights.rejectedDealStats.avgDSCR.max.toFixed(2)}x</div>
                    </div>
                  )}
                  {insights.rejectedDealStats.avgLTV && (
                    <div className="card border-l-2 border-risk-high">
                      <div className="text-xs text-text-muted mb-1">Rejected Deals — Avg LTV</div>
                      <div className="text-lg font-semibold font-mono text-risk-high">{(insights.rejectedDealStats.avgLTV.mean * 100).toFixed(1)}%</div>
                      <div className="text-xs text-text-muted">Range: {(insights.rejectedDealStats.avgLTV.min * 100).toFixed(1)}% – {(insights.rejectedDealStats.avgLTV.max * 100).toFixed(1)}%</div>
                    </div>
                  )}
                  {insights.rejectedDealStats.avgVacancy && (
                    <div className="card border-l-2 border-risk-high">
                      <div className="text-xs text-text-muted mb-1">Rejected Deals — Avg Vacancy</div>
                      <div className="text-lg font-semibold font-mono text-risk-high">{(insights.rejectedDealStats.avgVacancy.mean * 100).toFixed(1)}%</div>
                      <div className="text-xs text-text-muted">Range: {(insights.rejectedDealStats.avgVacancy.min * 100).toFixed(1)}% – {(insights.rejectedDealStats.avgVacancy.max * 100).toFixed(1)}%</div>
                    </div>
                  )}
                  {insights.rejectedDealStats.avgNOIHaircut && (
                    <div className="card border-l-2 border-risk-high">
                      <div className="text-xs text-text-muted mb-1">Rejected Deals — Avg NOI Haircut</div>
                      <div className="text-lg font-semibold font-mono text-risk-high">{Math.abs(insights.rejectedDealStats.avgNOIHaircut.mean).toFixed(1)}%</div>
                      <div className="text-xs text-text-muted">Range: {Math.abs(insights.rejectedDealStats.avgNOIHaircut.max).toFixed(1)}% – {Math.abs(insights.rejectedDealStats.avgNOIHaircut.min).toFixed(1)}%</div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {insights && insights.totalDeals === 0 && (
            <div className="card text-center py-12 mb-6">
              <p className="text-text-muted text-sm">No historical data available yet.</p>
              <a href="/admin/underwriting-library" className="text-xs text-accent hover:text-accent-hover mt-2 inline-block">
                Upload underwriting files to get started
              </a>
            </div>
          )}

          {/* Learned Rules */}
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-sm font-semibold text-text-primary mb-1">Learned Credit Rules</h2>
              <p className="text-xs text-text-muted">
                Rules generated from historical patterns and deal outcomes. Approve rules to apply them during deal analysis.
              </p>
            </div>
            {rules.filter(r => r.status !== 'approved').length > 0 && (
              <button
                onClick={handleApproveAll}
                className="btn-primary text-xs px-4 py-2 whitespace-nowrap shrink-0 ml-4"
              >
                Approve All ({rules.filter(r => r.status !== 'approved').length})
              </button>
            )}
          </div>

          {rules.length === 0 ? (
            <div className="card text-center py-8">
              <p className="text-text-muted text-sm">
                {sufficiency?.sufficient
                  ? 'No rules generated yet. Click "Recalculate Credit Rules" to extract patterns from underwriting data and deal outcomes.'
                  : 'Upload more deals to enable rule generation.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="table-header text-left">Rule</th>
                    <th className="table-header text-center w-20">Metric</th>
                    <th className="table-header text-center w-24">Confidence</th>
                    <th className="table-header text-center w-16">Deals</th>
                    <th className="table-header text-center w-20">% Affected</th>
                    <th className="table-header text-center w-20">% Rejected</th>
                    <th className="table-header text-center w-24">Status</th>
                    <th className="table-header text-center w-40">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <>
                      <tr key={rule.id} className={rule.status === 'rejected' || rule.status === 'disabled' ? 'opacity-40' : ''}>
                        <td className="table-cell">
                          <div className="text-sm text-text-primary">{rule.rule}</div>
                          <div className="text-xs text-text-muted mt-0.5 capitalize">{rule.category} | {rule.assetType}</div>
                        </td>
                        <td className="table-cell text-center">
                          <span className="text-xs font-mono text-text-secondary">{rule.metric || '—'}</span>
                        </td>
                        <td className="table-cell text-center">
                          <span className={`badge ${
                            rule.confidenceLevel === 'high' ? 'badge-pass' :
                            rule.confidenceLevel === 'medium' ? 'badge-unknown' : 'badge-fail'
                          }`}>
                            {rule.confidenceLevel}
                          </span>
                        </td>
                        <td className="table-cell text-center font-mono text-sm">{rule.sampleSize}</td>
                        <td className="table-cell text-center font-mono text-sm">
                          {rule.pctDealsAffected != null ? `${rule.pctDealsAffected}%` : '—'}
                        </td>
                        <td className="table-cell text-center">
                          {rule.pctDealsRejected != null ? (
                            <span className={`font-mono text-sm font-semibold ${
                              rule.pctDealsRejected >= 60 ? 'text-risk-critical' :
                              rule.pctDealsRejected >= 30 ? 'text-risk-high' :
                              'text-text-secondary'
                            }`}>
                              {rule.pctDealsRejected}%
                            </span>
                          ) : '—'}
                        </td>
                        <td className="table-cell text-center">
                          <span className={`badge ${
                            rule.status === 'approved' ? 'badge-pass' :
                            rule.status === 'pending' ? 'badge-unknown' :
                            'badge-fail'
                          }`}>
                            {rule.status}
                          </span>
                        </td>
                        <td className="table-cell text-center space-x-2">
                          {rule.status !== 'approved' && (
                            <button
                              onClick={() => handleRuleAction(rule.id, 'approved')}
                              className="text-xs text-risk-positive hover:underline"
                            >
                              Approve
                            </button>
                          )}
                          {rule.status !== 'rejected' && (
                            <button
                              onClick={() => handleRuleAction(rule.id, 'rejected')}
                              className="text-xs text-risk-high hover:underline"
                            >
                              Reject
                            </button>
                          )}
                          {rule.status === 'approved' && (
                            <button
                              onClick={() => handleRuleAction(rule.id, 'disabled')}
                              className="text-xs text-text-muted hover:underline"
                            >
                              Disable
                            </button>
                          )}
                          <button
                            onClick={() => handleToggleVersions(rule.id)}
                            className="text-xs text-accent hover:underline"
                          >
                            {expandedVersions === rule.id ? 'Hide' : 'History'}
                          </button>
                          <button
                            onClick={() => handleDeleteRule(rule.id)}
                            className="text-xs text-risk-critical hover:underline"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                      {/* Version History Expandable Row */}
                      {expandedVersions === rule.id && (
                        <tr key={`${rule.id}-versions`}>
                          <td colSpan={8} className="px-4 py-3 bg-bg-secondary/50">
                            {loadingVersions ? (
                              <div className="text-xs text-text-muted">Loading version history...</div>
                            ) : versionHistory.length === 0 ? (
                              <div className="text-xs text-text-muted">No previous versions.</div>
                            ) : (
                              <div>
                                <div className="text-xs font-semibold text-text-secondary mb-2">
                                  Version History (v{rule.version} current)
                                </div>
                                <div className="space-y-2">
                                  {versionHistory.map((v, i) => (
                                    <div key={i} className="flex items-start justify-between text-xs border border-border-primary rounded p-2">
                                      <div className="flex-1">
                                        <div className="font-mono text-text-primary">v{v.version} — {v.reason}</div>
                                        <div className="text-text-muted mt-0.5">{v.rule}</div>
                                        <div className="text-text-muted mt-0.5">
                                          {formatTimestamp(v.createdAt)} | {v.confidenceLevel} confidence | {v.sampleSize} deals
                                        </div>
                                      </div>
                                      <button
                                        onClick={() => handleRollback(rule.id, v.version)}
                                        className="text-xs text-accent hover:underline ml-3 whitespace-nowrap"
                                      >
                                        Rollback
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ================================================================= */}
          {/* Rejected Deal Outcome Training Data                                */}
          {/* ================================================================= */}
          <div className="mt-10 border-t border-border-primary pt-6">
            <button
              onClick={() => setOutcomesExpanded(!outcomesExpanded)}
              className="flex items-center gap-2 mb-4 group"
            >
              <span className="text-sm font-semibold text-text-primary">Rejected Deal Outcome Training</span>
              <span className="text-xs text-text-muted group-hover:text-text-secondary transition-colors">
                {outcomesExpanded ? '(collapse)' : '(expand)'}
              </span>
            </button>

            {outcomesExpanded && (
              <div>
                <p className="text-xs text-text-muted mb-4">
                  Upload rejected/kicked deals to train the credit intelligence engine. The system matches rows
                  to historical underwritings, extracts quantitative rejection patterns (DSCR, LTV, vacancy thresholds),
                  and feeds them into rule generation, criteria recommendations, and credit score weighting.
                </p>

                {/* Upload Area */}
                <div className="card mb-4">
                  <div className="flex items-center gap-4">
                    <label className="flex-1">
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={(e) => {
                          setOutcomesFile(e.target.files?.[0] || null);
                          setOutcomesResult(null);
                          setOutcomesError(null);
                        }}
                        className="block w-full text-sm text-text-secondary file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-accent/10 file:text-accent hover:file:bg-accent/20 file:cursor-pointer"
                      />
                    </label>
                    <button
                      onClick={handleOutcomesUpload}
                      disabled={!outcomesFile || outcomesUploading || syncing}
                      className="btn-primary text-sm disabled:opacity-40 whitespace-nowrap"
                    >
                      {outcomesUploading ? 'Processing...' : 'Upload & Sync Outcomes'}
                    </button>
                    <button
                      onClick={async () => {
                        if (!outcomesFile) return;
                        setSyncing(true);
                        await handleOutcomesUpload();
                        setSyncing(false);
                      }}
                      disabled={!outcomesFile || outcomesUploading || syncing}
                      className="btn-secondary text-sm disabled:opacity-40 whitespace-nowrap"
                      title="Re-run matching against updated library"
                    >
                      {syncing ? 'Syncing...' : 'Sync Outcomes'}
                    </button>
                  </div>
                  {outcomesFile && !outcomesUploading && !outcomesResult && (
                    <div className="mt-2 text-xs text-text-muted">
                      Selected: {outcomesFile.name} ({(outcomesFile.size / 1024).toFixed(1)} KB)
                    </div>
                  )}
                  {outcomesUploading && (
                    <div className="mt-3 text-xs text-text-muted">
                      Processing deal outcomes — matching to library and extracting patterns...
                    </div>
                  )}
                </div>

                {/* Error */}
                {outcomesError && (
                  <div className="card mb-4 border-risk-critical/30 bg-risk-critical/5">
                    <p className="text-sm text-risk-critical">{outcomesError}</p>
                  </div>
                )}

                {/* Upload Results Summary */}
                {outcomesResult && (
                  <>
                    {/* Processing summary */}
                    <div className="grid grid-cols-5 gap-3 mb-4">
                      <StatCard label="Deals Processed" value={String(outcomesResult.totalRows)} />
                      <StatCard label="Matched to Library" value={String(outcomesResult.matched)} />
                      <StatCard label="Needs Review" value={String(outcomesResult.needsReview)} />
                      <StatCard label="Unmatched" value={String(outcomesResult.unmatched)} />
                      <StatCard label="Applied to Rules" value={String(outcomesResult.applied)} />
                    </div>

                    {outcomesResult.applied > 0 && (
                      <div className="card mb-4 bg-risk-positive/5 border-risk-positive/30">
                        <p className="text-sm text-risk-positive">
                          {outcomesResult.applied} deal outcome{outcomesResult.applied > 1 ? 's' : ''} applied to the intelligence engine.
                          {outcomesResult.affectedAssetTypes.length > 0 && (
                            <> Rules recalculating for: {outcomesResult.affectedAssetTypes.join(', ')}.</>
                          )}
                        </p>
                        <p className="text-xs text-text-muted mt-1">
                          Rejection patterns will update in the Rejection Intelligence section above.
                        </p>
                      </div>
                    )}

                    {/* Compact match table — focuses on processing status, not raw reasons */}
                    {outcomesResult.matches.filter(m => m.reviewStatus === 'needs_review').length > 0 && (
                      <div className="overflow-x-auto">
                        <div className="text-xs font-semibold text-text-secondary mb-2">Deals Requiring Manual Review</div>
                        <table className="w-full">
                          <thead>
                            <tr>
                              <th className="table-header text-left">Deal Name</th>
                              <th className="table-header text-center w-24">Asset Class</th>
                              <th className="table-header text-center w-16">Year</th>
                              <th className="table-header text-left w-36">Matched To</th>
                              <th className="table-header text-center w-24">Confidence</th>
                              <th className="table-header text-center w-28">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {outcomesResult.matches.filter(m => m.reviewStatus === 'needs_review' && !m.applied).map((match) => (
                              <tr key={match.rowIndex}>
                                <td className="table-cell">
                                  <div className="text-sm text-text-primary">{match.dealName}</div>
                                </td>
                                <td className="table-cell text-center text-xs capitalize">{match.assetClass}</td>
                                <td className="table-cell text-center text-sm font-mono">{match.year || '—'}</td>
                                <td className="table-cell text-left">
                                  <span className="text-xs text-text-secondary">{match.matchedDealName || '—'}</span>
                                </td>
                                <td className="table-cell text-center">
                                  <span className={`badge ${
                                    match.matchConfidence === 'high' ? 'badge-pass' :
                                    match.matchConfidence === 'medium' ? 'badge-unknown' :
                                    'badge-fail'
                                  }`}>
                                    {match.matchConfidence}
                                  </span>
                                  <div className="text-xs text-text-muted font-mono mt-0.5">
                                    {(match.matchScore * 100).toFixed(0)}%
                                  </div>
                                </td>
                                <td className="table-cell text-center">
                                  {!match.applied && match.matchedUWId && (
                                    <button
                                      onClick={() => handleApplyOutcome(match)}
                                      className="text-xs text-accent hover:underline"
                                    >
                                      Confirm & Apply
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}

                {/* ============================================================ */}
                {/* Unmatched Outcomes — deals from kicks file not linked to UW   */}
                {/* ============================================================ */}
                {unmatchedOutcomes.length > 0 && (
                  <div className="mt-6">
                    <div className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-wider">
                      Unmatched Outcomes ({unmatchedOutcomes.length})
                    </div>
                    <p className="text-xs text-text-muted mb-3">
                      These deal outcomes from the kicks file could not be automatically matched to a library record.
                      Manually link each to the correct underwriting record or dismiss.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr>
                            <th className="table-header text-left">Deal / Property</th>
                            <th className="table-header text-center w-24">Asset Class</th>
                            <th className="table-header text-left w-28">Location</th>
                            <th className="table-header text-center w-16">Year</th>
                            <th className="table-header text-left">Kick Reason</th>
                            <th className="table-header text-left w-28">Source</th>
                            <th className="table-header text-center w-36">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unmatchedOutcomes.map((um) => (
                            <tr key={um.id} className="hover:bg-bg-tertiary/50 transition-colors">
                              <td className="table-cell">
                                <div className="text-sm text-text-primary">{um.dealName || um.propertyName || '(unknown)'}</div>
                                {um.loanAmount && <div className="text-xs text-text-muted">${(um.loanAmount / 1e6).toFixed(1)}M</div>}
                              </td>
                              <td className="table-cell text-center text-xs capitalize">{um.assetClass || '—'}</td>
                              <td className="table-cell text-xs text-text-secondary">
                                {um.city && um.state ? `${um.city}, ${um.state}` : um.state || '—'}
                              </td>
                              <td className="table-cell text-center text-sm font-mono">{um.year || '—'}</td>
                              <td className="table-cell text-xs text-text-muted truncate max-w-[200px]">{um.kickReason || '—'}</td>
                              <td className="table-cell text-xs text-text-muted truncate max-w-[120px]" title={um.sourceFileName}>
                                Row {um.sourceRowId}
                              </td>
                              <td className="table-cell text-center">
                                {linkingId === um.id ? (
                                  <div className="space-y-1">
                                    <input
                                      type="text"
                                      className="input-field text-xs w-full"
                                      placeholder="Search deal name..."
                                      value={linkUWSearch}
                                      onChange={(e) => handleSearchUWForLink(e.target.value)}
                                      autoFocus
                                    />
                                    {uwSearchResults.length > 0 && (
                                      <div className="absolute z-50 bg-bg-secondary border border-border-secondary rounded shadow-lg max-h-40 overflow-y-auto w-64 right-0 mt-1">
                                        {uwSearchResults.map((uw) => (
                                          <button
                                            key={uw.id}
                                            onClick={() => handleLinkOutcome(um.id, uw.id)}
                                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-tertiary transition-colors"
                                          >
                                            <span className="text-text-primary">{uw.dealName}</span>
                                            <span className="text-text-muted ml-1">({uw.city}, {uw.state} — {uw.year})</span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                    <button onClick={() => { setLinkingId(null); setLinkUWSearch(''); setUwSearchResults([]); }} className="text-xs text-text-muted hover:underline">
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-center gap-2">
                                    <button onClick={() => setLinkingId(um.id)} className="text-xs text-accent hover:underline">
                                      Link to Deal
                                    </button>
                                    <button onClick={() => handleDeleteUnmatched(um.id)} className="text-xs text-risk-high hover:underline">
                                      Dismiss
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="text-xs text-text-muted mb-1">{label}</div>
      <div className="text-lg font-semibold font-mono text-text-primary">{value}</div>
      {sub && <div className="text-xs text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

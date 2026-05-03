import { v4 as uuid } from 'uuid';
import { store } from '../storage/sqlite-store.js';
import type {
  Analysis, AuditLogEntry, VersionComparison,
} from '@cre/shared';

// --- Audit Logging ---

export function recordAnalysisAudit(analysis: Analysis): void {
  const manifestoLabel = resolveManifestoLabel(analysis.manifestoVersion || '');

  const entry: AuditLogEntry = {
    id: uuid(),
    analysisId: analysis.id,
    analysisName: analysis.name,
    assetType: analysis.assetType,
    inputHash: analysis.inputHash || '',
    manifestoVersion: analysis.manifestoVersion || '',
    manifestoLabel,
    modelLogicVersion: analysis.modelLogicVersion || '',
    creditScoreOverall: analysis.creditScore?.overall ?? null,
    recommendation: analysis.creditScore?.recommendation ?? null,
    riskTier: analysis.creditScore?.riskTier ?? null,
    validationPassed: analysis.validationResult?.passed ?? false,
    timestamp: new Date().toISOString(),
  };

  store.writeAuditLog(entry);
  console.log(`[VersionControl] Audit logged: analysis ${analysis.id}, manifesto ${manifestoLabel}, model ${entry.modelLogicVersion}`);
}

// --- Manifesto Label Resolution ---

export function resolveManifestoLabel(manifestoVersionHash: string): string {
  if (!manifestoVersionHash || manifestoVersionHash === 'no-criteria') {
    return 'No Manifesto';
  }

  const manifestos = store.listManifestos();
  // The manifestoVersion hash is computed from the criteria rules, which change
  // when a manifesto is activated. Try to match by finding the active manifesto.
  const active = manifestos.find(m => m.isActive);
  if (active) {
    return `CM_v${active.version}`;
  }

  // Fallback: just use hash prefix
  return `CM_${manifestoVersionHash.substring(0, 8)}`;
}

// --- Version Comparison ---

export function compareAnalysisVersions(baseId: string, compareId: string): VersionComparison | null {
  const baseAnalysis = store.getAnalysis(baseId);
  const compareAnalysis = store.getAnalysis(compareId);

  if (!baseAnalysis || !compareAnalysis) return null;

  const baseAudit = buildAuditEntry(baseAnalysis);
  const compareAudit = buildAuditEntry(compareAnalysis);

  // Metric diffs
  const metricDiffs: VersionComparison['metricDiffs'] = [];
  const baseModel = baseAnalysis.uwModel;
  const compareModel = compareAnalysis.uwModel;

  if (baseModel && compareModel) {
    // null = metric not computable for this version; diff cannot be evaluated.
    const metrics: {
      name: string;
      baseFn: () => number | null;
      compareFn: () => number | null;
      format: (v: number) => string;
    }[] = [
      { name: 'NOI', baseFn: () => baseModel.netOperatingIncome, compareFn: () => compareModel.netOperatingIncome, format: v => `$${v.toLocaleString()}` },
      { name: 'DSCR', baseFn: () => baseModel.dscr, compareFn: () => compareModel.dscr, format: v => `${v.toFixed(2)}x` },
      { name: 'LTV', baseFn: () => baseModel.ltv, compareFn: () => compareModel.ltv, format: v => `${v.toFixed(1)}%` },
      { name: 'Debt Yield', baseFn: () => baseModel.debtYield, compareFn: () => compareModel.debtYield, format: v => `${v.toFixed(2)}%` },
      { name: 'Implied Value', baseFn: () => baseModel.impliedValue, compareFn: () => compareModel.impliedValue, format: v => `$${v.toLocaleString()}` },
      { name: 'Cap Rate', baseFn: () => baseModel.capRate, compareFn: () => compareModel.capRate, format: v => `${v.toFixed(2)}%` },
    ];

    for (const m of metrics) {
      const bv = m.baseFn();
      const cv = m.compareFn();
      // If either side is null, no diff is computable. Pass through the raw
      // values and mark delta as N/A — never coerce null to 0 for arithmetic.
      if (bv === null || cv === null) {
        metricDiffs.push({ metric: m.name, base: bv, compare: cv, delta: 'N/A' });
        continue;
      }
      const diff = cv - bv;
      metricDiffs.push({
        metric: m.name,
        base: bv,
        compare: cv,
        delta: diff === 0 ? 'No change' : `${diff > 0 ? '+' : ''}${m.format(diff)}`,
      });
    }
  }

  // Score diff
  const baseScore = baseAnalysis.creditScore?.overall ?? null;
  const compareScore = compareAnalysis.creditScore?.overall ?? null;
  const scoreDiff = {
    base: baseScore,
    compare: compareScore,
    delta: (baseScore !== null && compareScore !== null) ? compareScore - baseScore : 0,
  };

  // Decision changed
  const decisionChanged = baseAnalysis.creditScore?.recommendation !== compareAnalysis.creditScore?.recommendation;

  // Rule evaluation changes
  const ruleChanges: VersionComparison['ruleChanges'] = [];
  const baseEvalMap = new Map(baseAnalysis.criteriaEvaluations.map(e => [e.ruleId, e]));
  const compareEvalMap = new Map(compareAnalysis.criteriaEvaluations.map(e => [e.ruleId, e]));

  // Check all rules in both evaluations
  const allRuleIds = new Set([
    ...baseAnalysis.criteriaEvaluations.map(e => e.ruleId),
    ...compareAnalysis.criteriaEvaluations.map(e => e.ruleId),
  ]);

  for (const ruleId of allRuleIds) {
    const baseEval = baseEvalMap.get(ruleId);
    const compareEval = compareEvalMap.get(ruleId);
    const baseResult = baseEval?.result || 'absent';
    const compareResult = compareEval?.result || 'absent';

    if (baseResult !== compareResult) {
      ruleChanges.push({
        ruleId,
        ruleName: baseEval?.ruleName || compareEval?.ruleName || ruleId,
        baseResult,
        compareResult,
      });
    }
  }

  return {
    baseAnalysis: baseAudit,
    compareAnalysis: compareAudit,
    metricDiffs,
    scoreDiff,
    decisionChanged,
    ruleChanges,
    manifestoChanged: baseAnalysis.manifestoVersion !== compareAnalysis.manifestoVersion,
    modelLogicChanged: baseAnalysis.modelLogicVersion !== compareAnalysis.modelLogicVersion,
  };
}

// --- Manifesto Comparison ---

export function compareManifestoVersions(baseId: string, compareId: string): {
  baseVersion: number;
  compareVersion: number;
  addedRules: { metric_name: string; condition: string; severity: string }[];
  removedRules: { metric_name: string; condition: string; severity: string }[];
  modifiedRules: { metric_name: string; field: string; baseValue: string; compareValue: string }[];
} | null {
  const baseManifesto = store.getManifesto(baseId);
  const compareManifesto = store.getManifesto(compareId);

  if (!baseManifesto || !compareManifesto) return null;

  const baseRules = baseManifesto.extractedRules;
  const compareRules = compareManifesto.extractedRules;

  // Index by metric_name + condition for matching
  const baseMap = new Map(baseRules.map(r => [`${r.metric_name}::${r.condition}`, r]));
  const compareMap = new Map(compareRules.map(r => [`${r.metric_name}::${r.condition}`, r]));

  const addedRules = compareRules
    .filter(r => !baseMap.has(`${r.metric_name}::${r.condition}`))
    .map(r => ({ metric_name: r.metric_name, condition: r.condition, severity: r.severity }));

  const removedRules = baseRules
    .filter(r => !compareMap.has(`${r.metric_name}::${r.condition}`))
    .map(r => ({ metric_name: r.metric_name, condition: r.condition, severity: r.severity }));

  const modifiedRules: { metric_name: string; field: string; baseValue: string; compareValue: string }[] = [];
  for (const [key, baseRule] of baseMap) {
    const compareRule = compareMap.get(key);
    if (!compareRule) continue;

    if (String(baseRule.threshold_value) !== String(compareRule.threshold_value)) {
      modifiedRules.push({ metric_name: baseRule.metric_name, field: 'threshold_value', baseValue: String(baseRule.threshold_value), compareValue: String(compareRule.threshold_value) });
    }
    if (baseRule.severity !== compareRule.severity) {
      modifiedRules.push({ metric_name: baseRule.metric_name, field: 'severity', baseValue: baseRule.severity, compareValue: compareRule.severity });
    }
    if (baseRule.weight !== compareRule.weight) {
      modifiedRules.push({ metric_name: baseRule.metric_name, field: 'weight', baseValue: String(baseRule.weight), compareValue: String(compareRule.weight) });
    }
    if (baseRule.outcome !== compareRule.outcome) {
      modifiedRules.push({ metric_name: baseRule.metric_name, field: 'outcome', baseValue: baseRule.outcome, compareValue: compareRule.outcome });
    }
  }

  return {
    baseVersion: baseManifesto.version,
    compareVersion: compareManifesto.version,
    addedRules,
    removedRules,
    modifiedRules,
  };
}

// --- Helpers ---

function buildAuditEntry(analysis: Analysis): AuditLogEntry {
  return {
    id: '',
    analysisId: analysis.id,
    analysisName: analysis.name,
    assetType: analysis.assetType,
    inputHash: analysis.inputHash || '',
    manifestoVersion: analysis.manifestoVersion || '',
    manifestoLabel: resolveManifestoLabel(analysis.manifestoVersion || ''),
    modelLogicVersion: analysis.modelLogicVersion || '',
    creditScoreOverall: analysis.creditScore?.overall ?? null,
    recommendation: analysis.creditScore?.recommendation ?? null,
    riskTier: analysis.creditScore?.riskTier ?? null,
    validationPassed: analysis.validationResult?.passed ?? false,
    timestamp: analysis.updatedAt,
  };
}

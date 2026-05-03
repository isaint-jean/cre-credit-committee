import {
  Analysis, AnalysisSummary, Comment, AssetType, CriteriaEvaluation,
  FindingCategory
} from '@cre/shared';
import { CriteriaRuleSet } from '@cre/shared';
import { DEFAULT_SCORING_WEIGHTS } from '@cre/shared';
import { getDefaultCriteria } from '../services/default-criteria.js';

class MemoryStore {
  private analyses = new Map<string, Analysis>();
  private criteria = new Map<string, CriteriaRuleSet>();

  constructor() {
    // Initialize default criteria for each asset type
    const assetTypes: AssetType[] = ['office', 'multifamily', 'retail', 'industrial', 'hotel', 'self_storage', 'mixed_use', 'manufactured_housing'];
    for (const type of assetTypes) {
      this.criteria.set(type, getDefaultCriteria(type));
    }
  }

  // --- Analyses ---
  createAnalysis(analysis: Analysis): Analysis {
    this.analyses.set(analysis.id, analysis);
    return analysis;
  }

  getAnalysis(id: string): Analysis | null {
    return this.analyses.get(id) || null;
  }

  listAnalyses(): AnalysisSummary[] {
    return Array.from(this.analyses.values()).map((a) => ({
      id: a.id,
      name: a.name,
      assetType: a.assetType,
      status: a.status,
      creditScore: a.creditScore?.overall ?? null,
      riskTier: a.creditScore?.riskTier ?? null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  }

  updateAnalysis(id: string, updates: Partial<Analysis>): Analysis | null {
    const existing = this.analyses.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    this.analyses.set(id, updated);
    return updated;
  }

  deleteAnalysis(id: string): boolean {
    return this.analyses.delete(id);
  }

  // --- Comments ---
  addComment(analysisId: string, comment: Comment): Comment | null {
    const analysis = this.analyses.get(analysisId);
    if (!analysis) return null;
    analysis.comments.push(comment);
    analysis.updatedAt = new Date().toISOString();
    return comment;
  }

  getComments(analysisId: string): Comment[] {
    const analysis = this.analyses.get(analysisId);
    return analysis?.comments || [];
  }

  updateComment(analysisId: string, commentId: string, updates: Partial<Comment>): Comment | null {
    const analysis = this.analyses.get(analysisId);
    if (!analysis) return null;
    const idx = analysis.comments.findIndex((c) => c.id === commentId);
    if (idx === -1) return null;
    analysis.comments[idx] = {
      ...analysis.comments[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    return analysis.comments[idx];
  }

  deleteComment(analysisId: string, commentId: string): boolean {
    const analysis = this.analyses.get(analysisId);
    if (!analysis) return false;
    const idx = analysis.comments.findIndex((c) => c.id === commentId);
    if (idx === -1) return false;
    analysis.comments.splice(idx, 1);
    return true;
  }

  // --- Criteria ---
  getCriteria(assetType: AssetType): CriteriaRuleSet | null {
    return this.criteria.get(assetType) || null;
  }

  updateCriteria(assetType: AssetType, ruleSet: CriteriaRuleSet): CriteriaRuleSet {
    this.criteria.set(assetType, ruleSet);
    return ruleSet;
  }
}

export const store = new MemoryStore();

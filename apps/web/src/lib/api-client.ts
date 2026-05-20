import type {
  CommitteeActionEvent,
  CommitteeActionPayload,
  CommitteeSnapshotId,
  CommitteeTimeline,
  DealWorkflowState,
  DoctrineEvaluationId,
  OverlayId,
  RenderedAnalysis,
  RenderedAnalysisId,
} from '@cre/contracts';
import { isRenderedAnalysis } from './rendered-analysis-guard';

// Phase 4 (productization layer) - workflow API request/response shapes.
// The client transports payloads opaquely; the server validates kind/payload
// alignment. CommitteeActionPayload is exported by @cre/contracts.
export interface PostCommitteeActionRequest {
  readonly rootId: DoctrineEvaluationId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly snapshotId?: CommitteeSnapshotId;
  readonly kind: CommitteeActionPayload['kind'];
  readonly payload: CommitteeActionPayload;
  readonly occurredAt?: string;
}
export interface PostCommitteeActionResponse {
  readonly action: CommitteeActionEvent;
}
export interface AuditReplayResponse {
  readonly rootId: string;
  readonly chains: { readonly [overlayId: string]: ReadonlyArray<unknown> };
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// Discriminated union for GET /api/analyses/:id (post-6.8 unified read endpoint).
//
// The endpoint returns one of two shapes depending on the id format dispatched on
// the server side via dispatchByIdFormat. This client does NOT introspect the id
// format itself; classification belongs only at the server-side dispatch boundary.
// Instead the client detects the response shape after the response arrives:
//   - 'rendered': the server's RenderedAnalysis (graph-backed analyses; post-6.8)
//   - 'legacy':   the historical { analysis: Analysis } envelope (uuid analyses)
export type GetAnalysisResponse =
  | { readonly kind: 'rendered'; readonly body: RenderedAnalysis }
  | { readonly kind: 'legacy'; readonly body: { readonly analysis: any } };

function classifyAnalysisResponse(raw: unknown): GetAnalysisResponse {
  if (isRenderedAnalysis(raw)) {
    return { kind: 'rendered', body: raw };
  }
  return { kind: 'legacy', body: raw as { analysis: any } };
}

function getAuthHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('cre_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
      ...options?.headers,
    },
  });

  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem('cre_token');
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

export const api = {
  // Analyses
  uploadAnalysis: async (
    asrFile: File,
    assetType: string,
    name?: string,
    sellerUwFile?: File,
    supportingDocs?: File[],
    templateFile?: File,
    templateType?: string,
    // Batch 1A — dedicated rent-roll xlsx/xlsm slot. Highest precedence input
    // for tenant-level data. Optional; absence is fine, just degrades downstream
    // Year-1 fields to null+missingSupport (Batch 1C+).
    rentRollFile?: File,
  ) => {
    const formData = new FormData();
    formData.append('asr', asrFile);
    if (sellerUwFile) formData.append('seller_uw', sellerUwFile);
    if (rentRollFile) formData.append('rent_roll', rentRollFile);
    if (supportingDocs) {
      for (const doc of supportingDocs) {
        formData.append('supporting_docs', doc);
      }
    }
    if (templateFile) formData.append('template', templateFile);
    if (templateType) formData.append('templateType', templateType);
    formData.append('assetType', assetType);
    if (name) formData.append('name', name);

    const res = await fetch(`${API_BASE}/analyses`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Upload failed');
    }
    return res.json();
  },

  listAnalyses: () => request<any>('/analyses'),
  // Post-6.8 unified read endpoint. Returns a discriminated union so consumers can
  // branch on response shape (rendered | legacy) without inspecting id format.
  getAnalysis: async (id: string): Promise<GetAnalysisResponse> => {
    const raw = await request<unknown>(`/analyses/${id}`);
    return classifyAnalysisResponse(raw);
  },
  getAnalysisStatus: (id: string) => request<any>(`/analyses/${id}/status`),
  deleteAnalysis: (id: string) => request<any>(`/analyses/${id}`, { method: 'DELETE' }),

  // Populated Template
  getPopulatedTemplateInfo: (id: string) => request<any>(`/analyses/${id}/populated-template/info`),
  // Coverage report only (no mappedFields). Useful for quick UI dashboards.
  getPopulatedTemplateCoverage: (id: string) => request<any>(`/analyses/${id}/populated-template/coverage`),
  getPopulatedTemplateDownloadUrl: (id: string) => `${API_BASE}/analyses/${id}/populated-template`,
  downloadPopulatedTemplate: async (id: string, fileName?: string) => {
    const res = await fetch(`${API_BASE}/analyses/${id}/populated-template`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'Populated_Underwriting.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Batch 6.3 — UW model edits create a NEW analysis revision (immutable lineage). The
  // legacy PATCH /uw-model endpoint has been removed. The response is the new revision's
  // analysis object; the caller is expected to navigate to it (e.g., refresh the analysis
  // page with the new id).
  createUwModelRevision: (id: string, updates: { path: string; value: number }[]) =>
    request<any>(`/analyses/${id}/revisions`, {
      method: 'POST',
      body: JSON.stringify({ type: 'uw-model-cells', updates }),
    }),

  // Batch 6.3 — Loan-terms edits also create a new revision.
  createLoanTermsRevision: (id: string, updates: {
    interestRate?: number;
    ioMonths?: number;
    amortizationMonths?: number;
    termMonths?: number;
    rateType?: string;
    paymentFrequency?: string;
    prepaymentTerms?: string;
    loanAmount?: number;
  }) =>
    request<any>(`/analyses/${id}/revisions`, {
      method: 'POST',
      body: JSON.stringify({ type: 'loan-terms', updates }),
    }),

  // Batch 6.3 — Lineage chain for an analysis (every revision sharing the same root,
  // ordered by ordinal).
  getLineage: (id: string) => request<any>(`/analyses/${id}/lineage`),

  // Stress Tests
  runStressTest: (id: string, scenarios?: any[]) =>
    request<any>(`/analyses/${id}/stress-test`, {
      method: 'POST',
      body: JSON.stringify({ scenarios }),
    }),

  // Comments
  getComments: (id: string) => request<any>(`/analyses/${id}/comments`),
  addComment: (id: string, data: { sectionId: string; findingId?: string; stance: string; text: string }) =>
    request<any>(`/analyses/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteComment: (id: string, commentId: string) =>
    request<any>(`/analyses/${id}/comments/${commentId}`, { method: 'DELETE' }),

  // Research
  searchSponsor: (query: string) =>
    request<any>('/research/sponsor', { method: 'POST', body: JSON.stringify({ query }) }),
  searchMarket: (address: string, city: string) =>
    request<any>('/research/market', { method: 'POST', body: JSON.stringify({ address, city }) }),
  searchNews: (propertyName: string, sponsorName: string) =>
    request<any>('/research/news', { method: 'POST', body: JSON.stringify({ propertyName, sponsorName }) }),

  // Criteria
  getCriteria: (assetType: string) => request<any>(`/criteria/${assetType}`),
  addCriteriaRule: (assetType: string, rule: any) =>
    request<any>(`/criteria/${assetType}`, { method: 'POST', body: JSON.stringify(rule) }),
  updateCriteriaRule: (assetType: string, ruleId: string, updates: any) =>
    request<any>(`/criteria/${assetType}/${ruleId}`, { method: 'PUT', body: JSON.stringify(updates) }),
  deleteCriteriaRule: (assetType: string, ruleId: string) =>
    request<any>(`/criteria/${assetType}/${ruleId}`, { method: 'DELETE' }),

  // UW Intelligence
  uploadHistoricalUW: async (file: File, assetType: string, outcome: string, dealName: string, date: string, notes?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('assetType', assetType);
    formData.append('outcome', outcome);
    formData.append('dealName', dealName);
    formData.append('date', date);
    if (notes) formData.append('notes', notes);

    const res = await fetch(`${API_BASE}/uw-intelligence/upload`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Upload failed');
    }
    return res.json();
  },
  batchUploadHistoricalUWs: async (files: File[]) => {
    const formData = new FormData();
    for (const file of files) formData.append('files', file);

    const res = await fetch(`${API_BASE}/uw-intelligence/batch-upload`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Batch upload failed');
    }
    return res.json();
  },
  listHistoricalUWs: () => request<any>('/uw-intelligence/library'),
  getHistoricalUW: (id: string) => request<any>(`/uw-intelligence/library/${id}`),
  updateHistoricalUW: (id: string, updates: Record<string, any>) =>
    request<any>(`/uw-intelligence/library/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
  deleteHistoricalUW: (id: string) => request<any>(`/uw-intelligence/library/${id}`, { method: 'DELETE' }),
  getUWDownloadUrl: (id: string) => `${API_BASE}/uw-intelligence/library/${id}/download`,

  getInsights: (assetType?: string) =>
    request<any>(`/uw-intelligence/insights${assetType ? `?assetType=${assetType}` : ''}`),
  getDataSufficiency: (assetType?: string) =>
    request<any>(`/uw-intelligence/sufficiency${assetType ? `?assetType=${assetType}` : ''}`),

  listLearnedRules: (assetType?: string) =>
    request<any>(`/uw-intelligence/rules${assetType ? `?assetType=${assetType}` : ''}`),
  getRuleMetadata: () =>
    request<any>('/uw-intelligence/rules/metadata'),
  generateRules: (assetType?: string) =>
    request<any>('/uw-intelligence/rules/generate', { method: 'POST', body: JSON.stringify({ assetType }) }),
  updateLearnedRule: (id: string, updates: any) =>
    request<any>(`/uw-intelligence/rules/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
  deleteLearnedRule: (id: string) =>
    request<any>(`/uw-intelligence/rules/${id}`, { method: 'DELETE' }),
  getRuleVersions: (ruleId: string) =>
    request<any>(`/uw-intelligence/rules/${ruleId}/versions`),
  rollbackRule: (ruleId: string, version: number) =>
    request<any>(`/uw-intelligence/rules/${ruleId}/rollback`, { method: 'POST', body: JSON.stringify({ version }) }),

  // Batch async upload
  batchUploadAsync: async (files: File[]) => {
    const formData = new FormData();
    for (const file of files) formData.append('files', file);

    const res = await fetch(`${API_BASE}/uw-intelligence/batch-upload-async`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Batch upload failed');
    }
    return res.json();
  },
  getBatchJobStatus: (jobId: string) =>
    request<any>(`/uw-intelligence/batch-jobs/${jobId}`),

  // Portfolio children
  getPortfolioChildren: (parentId: string) =>
    request<any>(`/uw-intelligence/library/${parentId}/children`),

  applyIntelligence: (assetType: string, dealInputs: any) =>
    request<any>('/uw-intelligence/apply', { method: 'POST', body: JSON.stringify({ assetType, dealInputs }) }),

  // Rejected Deals Upload
  uploadDealOutcomes: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${API_BASE}/uw-intelligence/outcomes-upload`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Outcomes upload failed');
    }
    return res.json();
  },
  applyOutcomeMatch: (uwId: string, outcome: string, kickReason?: string, notes?: string, sourceFileName?: string, sourceRowId?: number, matchScore?: number) =>
    request<any>('/uw-intelligence/outcomes-apply', {
      method: 'POST',
      body: JSON.stringify({ uwId, outcome, kickReason, notes, sourceFileName, sourceRowId, matchScore }),
    }),

  // Unmatched Outcomes
  listUnmatchedOutcomes: () => request<any>('/uw-intelligence/unmatched-outcomes'),
  getUnmatchedOutcome: (id: string) => request<any>(`/uw-intelligence/unmatched-outcomes/${id}`),
  linkUnmatchedOutcome: (unmatchedId: string, uwId: string) =>
    request<any>(`/uw-intelligence/unmatched-outcomes/${unmatchedId}/link`, {
      method: 'POST',
      body: JSON.stringify({ uwId }),
    }),
  deleteUnmatchedOutcome: (id: string) =>
    request<any>(`/uw-intelligence/unmatched-outcomes/${id}`, { method: 'DELETE' }),

  // Underwriting Template Management
  uploadTemplate: async (file: File, templateType: string, uploadedBy?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('templateType', templateType);
    if (uploadedBy) formData.append('uploadedBy', uploadedBy);

    const res = await fetch(`${API_BASE}/uw-intelligence/templates`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Template upload failed');
    }
    return res.json();
  },
  listTemplates: (templateType?: string) =>
    request<any>(`/uw-intelligence/templates${templateType ? `?templateType=${templateType}` : ''}`),
  getActiveTemplate: (templateType: string) =>
    request<any>(`/uw-intelligence/templates/active/${templateType}`),
  getTemplateVersions: (templateType: string) =>
    request<any>(`/uw-intelligence/templates/${templateType}/versions`),
  activateTemplateVersion: (id: string) =>
    request<any>(`/uw-intelligence/templates/${id}/activate`, { method: 'POST' }),
  deleteTemplate: (id: string) =>
    request<any>(`/uw-intelligence/templates/${id}`, { method: 'DELETE' }),
  getTemplateDownloadUrl: (id: string) =>
    `${API_BASE}/uw-intelligence/templates/${id}/download`,

  // Version Control & Audit
  getAnalysisAudit: (id: string) => request<any>(`/analyses/${id}/audit`),
  compareAnalyses: (baseId: string, compareId: string) =>
    request<any>(`/analyses/compare?base=${baseId}&compare=${compareId}`),
  getAuditLog: (filters?: { assetType?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.assetType) params.set('assetType', filters.assetType);
    if (filters?.limit) params.set('limit', String(filters.limit));
    const qs = params.toString();
    return request<any>(`/analyses/audit-log${qs ? `?${qs}` : ''}`);
  },
  getModelLogicVersions: () => request<any>('/analyses/model-versions'),
  compareManifestos: (baseId: string, compareId: string) =>
    request<any>(`/manifesto/compare?base=${baseId}&compare=${compareId}`),

  // Unified Underwriting Export — single canonical Excel pipeline.
  // Both Bank Underwriter and BP Spire Underwriter use this with only a
  // different `profile` param. Always returns a .xlsx derived from the
  // canonical underwriting template.
  exportUnderwriting: async (
    id: string,
    params: {
      profile: 'bank' | 'bp_spire';
      assetClass: string;
      // Required by the four-axis render contract (v5+). Caller MUST supply
      // it — the API rejects missing modes with UNDERWRITING_MODE_REQUIRED.
      underwritingMode: 'single_loan' | 'roll_up';
      structuralVariantKey?: string;
      templateType?: 'single_loan' | 'roll_up';
    },
    fileName?: string,
  ) => {
    const qs = new URLSearchParams({
      dealId: id,
      profile: params.profile,
      assetClass: params.assetClass,
      underwritingMode: params.underwritingMode,
    });
    if (params.structuralVariantKey) qs.set('structuralVariantKey', params.structuralVariantKey);
    if (params.templateType) qs.set('templateType', params.templateType);

    const res = await fetch(`${API_BASE}/underwriting/export?${qs.toString()}`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Export failed' }));
      throw new Error(error.error || 'Export failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || `${params.profile === 'bank' ? 'Bank' : 'BPSpire'}_Underwriting.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Credit Manifesto
  uploadManifesto: async (file: File, uploadedBy?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (uploadedBy) formData.append('uploadedBy', uploadedBy);

    const res = await fetch(`${API_BASE}/manifesto/upload`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: formData,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || 'Manifesto upload failed');
    }
    return res.json();
  },
  getActiveManifesto: () => request<any>('/manifesto/active'),
  getManifestoHistory: () => request<any>('/manifesto/history'),
  getManifestoStatus: (id: string) => request<any>(`/manifesto/${id}/status`),
  activateManifesto: (id: string) => request<any>(`/manifesto/${id}/activate`, { method: 'POST' }),

  // Phase 4 - workflow API (committee actions / state / timeline / audit replay).
  // Thin transport over the four endpoints in apps/api/src/routes/workflow.routes.ts.
  // The UI does not derive workflow state; every read goes through these methods.
  submitCommitteeAction: (body: PostCommitteeActionRequest) =>
    request<PostCommitteeActionResponse>('/committee-actions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // OVERRIDE_DECISION-only entry point (Phase 4 directive). Client sends a
  // minimal body; the server constructs the canonical payload after looking up
  // the overlay binding. NO summary, NO occurredAt, NO payload from the client.
  submitOverrideDecision: (args: {
    rootId: DoctrineEvaluationId;
    renderedAnalysisId: RenderedAnalysisId;
    overlayId: OverlayId;
  }) =>
    request<PostCommitteeActionResponse>('/committee-actions', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'OVERRIDE_DECISION',
        rootId: args.rootId,
        renderedAnalysisId: args.renderedAnalysisId,
        overlayId: args.overlayId,
      }),
    }),
  getWorkflowState: (rootId: DoctrineEvaluationId) =>
    request<DealWorkflowState>(`/workflow-state?rootId=${encodeURIComponent(rootId)}`),
  getCommitteeTimeline: (rootId: DoctrineEvaluationId) =>
    request<CommitteeTimeline>(`/committee-timeline?rootId=${encodeURIComponent(rootId)}`),
  getAuditReplay: (rootId: DoctrineEvaluationId) =>
    request<AuditReplayResponse>(`/audit-replay?rootId=${encodeURIComponent(rootId)}`),

  getMarketIntelligence: (filters?: { assetType?: string; state?: string; city?: string; yearMin?: number; yearMax?: number }) => {
    const params = new URLSearchParams();
    if (filters?.assetType) params.set('assetType', filters.assetType);
    if (filters?.state) params.set('state', filters.state);
    if (filters?.city) params.set('city', filters.city);
    if (filters?.yearMin) params.set('yearMin', String(filters.yearMin));
    if (filters?.yearMax) params.set('yearMax', String(filters.yearMax));
    const qs = params.toString();
    return request<any>(`/uw-intelligence/market-intelligence${qs ? `?${qs}` : ''}`);
  },
};

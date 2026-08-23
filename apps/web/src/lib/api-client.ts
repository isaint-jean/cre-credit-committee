import type {
  AdjustedInputsDiff,
  CommitteeActionEvent,
  CommitteeActionPayload,
  CommitteeSnapshotId,
  CommitteeTimeline,
  CreditManifesto,
  DealWorkflowState,
  Disposition,
  DispositionKind,
  DoctrineEvaluationId,
  LibrarySnapshot,
  LoanInPool,
  LoanInPoolId,
  LoanMembership,
  MarketBenchmarks,
  OverlayId,
  OverlayPatchId,
  HandbookEvaluation,
  Pool,
  PoolId,
  ReasonCategory,
  RenderedAnalysis,
  RenderedAnalysisId,
  Tape,
  TapeId,
  WorkingTape,
  WorkingTapeId,
} from '@cre/contracts';
import { isRenderedAnalysis } from './rendered-analysis-guard';
import type { DocTypeEntry, DocTypeCategory } from '@cre/contracts';
import type { DataRoomTree } from '@cre/contracts';
import type { NoiReconciliationDetail } from '@cre/contracts';
import type { FlagDetail } from '@cre/contracts';
import type { SitePhotoRef, ManualPortfolioDefinition, SalesCompsPayload, LeaseCompsPayload } from '@cre/contracts';
import type { AppraisalSlotExtraction, AsrSlotExtraction, PcaSlotExtraction, RentRollSlotExtraction } from '@cre/contracts';

// Re-export the taxonomy entry type so Data-Room (D4) components can pull it
// (and the local DataRoom* shapes) from ONE module — the api-client — rather
// than reaching into @cre/contracts directly for a transport-adjacent type.
export type { DocTypeEntry, DocTypeCategory };

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

// Graph-native comment read (converge phase i+). One entry per persisted comment
// patch, carrying the "re:" path + the hash-excluded negotiation `side`.
export interface OverlayCommentView {
  readonly patchId: OverlayPatchId;
  readonly path: string;
  readonly author: string;
  readonly text: string;
  readonly createdAt: string;
  readonly side: 'originator' | 'buyer' | null;
}
export interface OverlayCommentsResponse {
  readonly rootId: string;
  readonly comments: readonly OverlayCommentView[];
}

// P3b — field-level intake completeness (ADVISORY). Mirrors the API service
// shape (apps/api/src/services/intake-completeness.service.ts). The panel that
// consumes it NEVER blocks export.
export type IntakeState =
  | 'populated'
  | 'in-PDF-not-extracted'
  | 'not-in-any-doc'
  | 'decision-blank'
  | 'not-applicable';
export interface IntakeFieldResult {
  readonly id: string;
  readonly section: string;
  readonly field: string;
  readonly state: IntakeState;
  readonly feeds: string;
  readonly blocks: string;
  readonly sources: readonly string[];
  readonly criticality: string;
  readonly tier: string;
  /** 'extraction' = from the graph; 'document-search' = found by the exhaustive
   *  sourcing pass (carries the citation below). */
  readonly sourcedBy?: 'extraction' | 'document-search';
  readonly sourceQuote?: string;
  readonly sourceDoc?: string;
  /** For an UNSOURCED field: 'searched' = searched every doc, genuinely absent
   *  (earned); 'unavailable' = the search could not run (credits/error) →
   *  UNVERIFIED, not confirmed missing. */
  readonly searchStatus?: 'searched' | 'unavailable';
}
export interface AssumedInput {
  readonly path: string;
  readonly label: string;
  readonly assumedValue: number | null;
  readonly ruleId: string | null;
  readonly reason: string | null;
  readonly feedsCoverage: boolean;
  readonly note?: string;
}
export interface IntakeCompleteness {
  readonly fields: readonly IntakeFieldResult[];
  /** Verdict inputs that are ASSUMED (benchmark/default), not sourced from docs. */
  readonly assumedInputs?: readonly AssumedInput[];
  readonly summary: {
    readonly sourced: number;
    readonly total: number;
    readonly needs: readonly IntakeFieldResult[];
    readonly decisionBlanks: readonly IntakeFieldResult[];
    readonly requiredMissing: readonly IntakeFieldResult[];
    readonly notApplicable?: readonly IntakeFieldResult[];
    /** True when the document search could not run for ≥1 field — their blanks
     *  are UNVERIFIED and must NOT be shown as confirmed missing. */
    readonly searchUnavailable?: boolean;
  };
  // Route-echoed export params (the panel's always-on "Create workbook" CTA).
  readonly dealId: string;
  readonly assetClass: string;
}

// ---------------------------------------------------------------------------
// Data-Room Phase 1 (D4) — client-side mirrors of the backend service shapes
// (apps/api/src/services/data-room-store.service.ts + source-doc-store). Defined
// locally because StagingBatch lives in @cre/shared (not re-exported by
// @cre/contracts); the room UI only needs these transport shapes.
// ---------------------------------------------------------------------------

/** One dropped, unassigned file in a staging batch. */
export interface StagingFileEntry {
  readonly stagingId: string;
  readonly fileHash: string;
  readonly originalFileName: string;
  readonly size: number;
  readonly mimeType: string;
  readonly uploadedAt: string;
}
export interface StagingBatch {
  readonly batchId: string;
  readonly createdAt: string;
  readonly files: readonly StagingFileEntry[];
}

/** One assigned document, addressed by (loanInPoolId, docType) + content hash. */
export interface DataRoomDocEntry {
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly notes: string | null;
  readonly tier: 'ingesting' | 'stored' | 'room_only';
  readonly ingest: boolean;
  /** SLICE 4 — extracted effective/as-of/report date (ISO-UTC) or null. The
   *  version tiebreak signal: latest content-date wins the underwrite slot. */
  readonly docEffectiveDate?: string | null;
  /** SLICE 4 — human pin: this version wins its (loan, docType) slot for the
   *  NEXT underwrite, overriding latest-content-date. Read-only on the entry. */
  readonly pinned?: boolean;
}

/** Projection 1 — docs grouped by doc-type (server emits tier-ordered a→b→c). */
export interface DataRoomDocTypeGroup {
  readonly docType: string;
  readonly label: string;
  readonly tier: 'ingesting' | 'stored' | 'room_only';
  readonly ingest: boolean;
  readonly docs: readonly DataRoomDocEntry[];
}

/** Projection 2 — docs grouped by loanInPoolId. */
export interface DataRoomLoanGroup {
  readonly loanInPoolId: string;
  readonly docs: readonly DataRoomDocEntry[];
}

/** Piece D — the by-category SUMMARY (counts only, never the file list). One per
 *  category in CATEGORIES_IN_ORDER; unreadCount is server-computed from the
 *  user's read cursor. Zero-doc categories carry count 0 (the five-card shape is
 *  stable). */
export interface DataRoomCategorySummary {
  readonly category: DocTypeCategory;
  readonly count: number;
  readonly unreadCount: number;
}

/** SLICE 3 — one durably-HELD ("needs identification") file: the accepted file's
 *  payload + whatever PARTIAL hints the routing cascade found (a null hint = the
 *  cascade refused that axis). A held file is kept, never dropped; a human
 *  identifies it (loan + docType) → it moves to the routed set. */
export interface DataRoomHeldDoc {
  readonly poolId: string;
  readonly fileHash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly hintDocType: string | null;
  readonly hintLoanInPoolId: string | null;
  readonly hintCategory: DocTypeCategory | null;
}

/** One assignment the tray posts (the Phase-2 seam input). */
export interface DataRoomAssignmentInput {
  readonly stagingId: string;
  readonly loanInPoolId: string;
  readonly docType: string;
  readonly notes?: string;
}

/** Per-file outcome the assign endpoint returns. */
export interface DataRoomAssignmentResult {
  readonly stagingId: string;
  readonly status: 'assigned' | 'error';
  readonly loanInPoolId?: string;
  readonly docType?: string;
  readonly fileHash?: string;
  readonly error?: string;
}

// ── Data-Room Phase 2 — classify-on-stage routing hints ─────────────────────
/** Per-file verdict the staging endpoint returns for each confirm-needed file.
 *  `prefill` carries whatever axis WAS confident so the tray opens pre-filled. */
export interface DataRoomRoutingHint {
  readonly stagingId: string;
  readonly auto: boolean; // always false in `routing` (auto files are excluded)
  readonly prefill: { readonly docType?: string; readonly loanInPoolId?: string };
}

/** Full staging response: the (confirm-only) batch + per-file hints + summary.
 *  Data Room v2 Piece B (Phase 3) widened `summary` with `unpackedCount` (staged
 *  inputs = loose files + validated zip entries) and `rejectedCount` (zip entries
 *  refused by security validation — routed NOWHERE). Both are always present so
 *  the drop UI can surface honest "Unpacked N · … · R rejected" counts. */
export interface DataRoomStageResponse {
  readonly batch: StagingBatch;
  readonly routing: readonly DataRoomRoutingHint[];
  readonly autoRouted: readonly DataRoomAssignmentResult[];
  readonly summary: {
    readonly unpackedCount: number;
    readonly autoRoutedCount: number;
    readonly needConfirmCount: number;
    readonly rejectedCount: number;
    // SLICE 3 — how many non-auto files were durably HELD (needs-identification).
    // ★ accepted (unpackedCount) == autoRoutedCount + heldCount; rejectedCount is
    // separate (refused at the gate, never admitted).
    readonly heldCount: number;
  };
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
  // graphLineageRootId (converge phase i): the 64-hex graph-spine lineage root the page
  // uses to redirect a uuid URL onto RenderedAnalysisView. null when no graph spine.
  | { readonly kind: 'legacy'; readonly body: { readonly analysis: any; readonly graphLineageRootId?: string | null } };

function classifyAnalysisResponse(raw: unknown): GetAnalysisResponse {
  if (isRenderedAnalysis(raw)) {
    return { kind: 'rendered', body: raw };
  }
  return { kind: 'legacy', body: raw as { analysis: any; graphLineageRootId?: string | null } };
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

export interface BuyerDiffSuggestionDTO {
  readonly findingId: string;
  readonly label: string;
  readonly issuer: number | null;
  readonly buyer: number | null;
  readonly deltaPct: number | null;
  readonly format: 'pct' | 'usd';
  readonly why: ReadonlyArray<{ ruleId: string; reason: string }>;
  readonly question: string;
  readonly decision: 'accepted' | 'rejected' | 'pending';
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

  // P3b — field-level intake completeness (ADVISORY read-only). Returns the
  // 4-state ceiling per intake field + a summary. NEVER gates export; the panel
  // that consumes this always keeps "Create workbook" enabled.
  getIntakeCompleteness: (id: string) =>
    request<IntakeCompleteness>(`/analyses/${id}/intake-completeness`),

  /**
   * Funnel PR — GET /api/analyses/lookup?dealRef=X
   * Resolves a pool-layer dealRef to an existing engine analysis (or signals
   * "not analyzed yet"). The pool rail's loan rows use this to branch between
   * "Open underwriting" (found) and "New analysis" (not found). Backend
   * endpoint is content-addressed via the extraction_results.deal_ref column
   * joined through the graph chain — see apps/api/src/routes/analysis.routes.ts.
   *
   * Response shape:
   *   { found: true,  analysisId: string, status: string | null,
   *                   workflowState: null, multipleFound?: boolean, count?: number }
   *   { found: false }
   *
   * Errors:
   *   - 400 POOL_BAD_REQUEST  if dealRef is missing/empty (the request wrapper throws).
   */
  lookupAnalysisByDealRef: (dealRef: string) =>
    request<
      | { found: true; analysisId: string; status: string | null;
          workflowState: string | null; multipleFound?: boolean; count?: number }
      | { found: false }
    >(`/analyses/lookup?dealRef=${encodeURIComponent(dealRef)}`),

  // Populated Template
  getPopulatedTemplateInfo: (id: string) => request<any>(`/analyses/${id}/populated-template/info`),
  // Coverage report only (no mappedFields). Useful for quick UI dashboards.
  getPopulatedTemplateCoverage: (id: string) => request<any>(`/analyses/${id}/populated-template/coverage`),
  getPopulatedTemplateDownloadUrl: (id: string) => `${API_BASE}/analyses/${id}/populated-template`,

  // ── Buyer-diff decisions (accept/reject) — air-gapped; never touches the score. ──
  getBuyerDiffDecisions: (id: string) =>
    request<{ id: string; dealRef: string; findings: BuyerDiffSuggestionDTO[] }>(`/analyses/${id}/buyer-diff/decisions`),
  putBuyerDiffDecision: (id: string, findingId: string, decision: 'accepted' | 'rejected' | 'pending') =>
    request<{ id: string; findingId: string; decision: string; findings: BuyerDiffSuggestionDTO[] }>(
      `/analyses/${id}/buyer-diff/decisions/${encodeURIComponent(findingId)}`,
      { method: 'PUT', body: JSON.stringify({ decision }) },
    ),
  downloadBuyerDiffWorkbook: async (id: string, fileName?: string) => {
    const res = await fetch(`${API_BASE}/analyses/${id}/buyer-diff/export`, { headers: { ...getAuthHeader() } });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName || 'Buyer-Adjusted-UW.xlsx';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  },
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

  // Option C / issue #20 step 8.6 — graph-backed revision via the new spine.
  // `lineageRootId` is the AnalysisId (= rootId from the GET response); the server
  // resolves the current latest revision internally and creates a child.
  // `overrides[].value` is in BACKEND units (caller converts via uw-edit-utils).
  // Response includes the structured inputDiff so the UI can render "what changed"
  // immediately without a follow-up lookup.
  //
  // Custom error flow (not the generic `request()`): server returns 400 INVALID_DELTA
  // with structured `code` + `path` fields the UI needs for analyst-readable messages.
  // The generic helper would collapse those into a plain Error.message. This thin
  // wrapper preserves them by parsing the error JSON and attaching the fields to the
  // thrown Error as own properties (`err.code`, `err.path`).
  createGraphRevision: async (
    lineageRootId: string,
    overrides: ReadonlyArray<{ path: string; value: number }>,
  ): Promise<{
    rootId: string;
    revisionId: string;
    evaluationId: string;
    revisionOrdinal: number;
    inputDiff: AdjustedInputsDiff;
  }> => {
    const res = await fetch(`${API_BASE}/analyses/${lineageRootId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({
        delta: { kind: 'adjusted-input-overrides', overrides },
        triggerSource: 'USER_EDIT',
      }),
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText, message: res.statusText }));
      const err = new Error(body.message ?? body.error ?? `Request failed: ${res.status}`) as
        Error & { code?: string; path?: string; status?: number };
      if (typeof body.code === 'string') err.code = body.code;
      if (typeof body.path === 'string') err.path = body.path;
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

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

  // Credit Committee Memorandum — server-rendered HTML from the persisted
  // graph chain (no LLM re-spend). Returns the HTML and triggers a download.
  downloadMemo: async (id: string, fileName?: string) => {
    const res = await fetch(`${API_BASE}/analyses/${id}/memo`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Memo download failed' }));
      throw new Error(error.error || 'Memo download failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'Credit_Committee_Memo.html';
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
  // Converge phase i — mint (or fetch) the deterministic overlay-created anchor that
  // OVERRIDE_DECISION requires. Server derives a stable overlayId per (rootId,
  // renderedAnalysisId, overlayKey); idempotent, append-only. See POST /overlays.
  createOverlay: (args: {
    rootId: DoctrineEvaluationId;
    renderedAnalysisId: RenderedAnalysisId;
    overlayKey?: string;
  }) =>
    request<{ overlayId: OverlayId; inserted: boolean }>('/overlays', {
      method: 'POST',
      body: JSON.stringify({
        rootId: args.rootId,
        renderedAnalysisId: args.renderedAnalysisId,
        ...(args.overlayKey !== undefined ? { overlayKey: args.overlayKey } : {}),
      }),
    }),
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
  // Graph-native comment composer (converge phase i+). Post a comment patch onto an
  // overlay: server builds the OverlayCommentPatch body (kind:'comment', path, author,
  // text, createdAt), content-hashes the id, persists it, and mints a comment-added
  // audit event. `side` is a hash-EXCLUDED attribution tag (originator/buyer) stored on
  // a denormalized column — it never enters the patch identity. Mirrors POST /overlays.
  postOverlayComment: (args: {
    overlayId: OverlayId;
    path: string;
    text: string;
    side?: 'originator' | 'buyer' | null;
  }) =>
    request<{ patchId: OverlayPatchId; inserted: boolean }>('/overlay-comments', {
      method: 'POST',
      body: JSON.stringify({
        overlayId: args.overlayId,
        path: args.path,
        text: args.text,
        ...(args.side ? { side: args.side } : {}),
      }),
    }),
  // Read the persisted comment patches for a root, WITH their hash-excluded `side`.
  getOverlayComments: (rootId: DoctrineEvaluationId) =>
    request<OverlayCommentsResponse>(
      `/overlay-comments?rootId=${encodeURIComponent(rootId)}`,
    ),
  getAuditReplay: (rootId: DoctrineEvaluationId) =>
    request<AuditReplayResponse>(`/audit-replay?rootId=${encodeURIComponent(rootId)}`),

  // Handbook engine output (#31, Commit 3). Sibling endpoint — returns null
  // when the analysis exists but no eval has been produced (pre-Commit-2 deals).
  getHandbookEvaluation: (rootId: string) =>
    request<HandbookEvaluation | null>(`/analyses/${encodeURIComponent(rootId)}/handbook-evaluation`),

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

  // Registry — content-addressed admin CRUD for the three pinned upstream inputs.
  // Reads gated by requireAuth; writes additionally gated by registry:write
  // permission on the server side (admin role only).
  listLibrarySnapshots: () =>
    request<{ items: LibrarySnapshot[] }>('/registry/library-snapshots'),
  getLibrarySnapshot: (id: string) =>
    request<{ record: LibrarySnapshot }>(`/registry/library-snapshots/${id}`),
  postLibrarySnapshot: (body: unknown) =>
    request<{ id: string; inserted: boolean }>('/registry/library-snapshots', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  buildLibrarySnapshot: (args: { asOfDate: string }) =>
    request<{ snapshot: LibrarySnapshot }>('/registry/library-snapshots/build', {
      method: 'POST',
      body: JSON.stringify(args),
    }),

  listMarketBenchmarks: () =>
    request<{ items: MarketBenchmarks[] }>('/registry/market-benchmarks'),
  getMarketBenchmarks: (id: string) =>
    request<{ record: MarketBenchmarks }>(`/registry/market-benchmarks/${id}`),
  postMarketBenchmarks: (body: unknown) =>
    request<{ id: string; inserted: boolean }>('/registry/market-benchmarks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listCreditManifestos: () =>
    request<{ items: CreditManifesto[] }>('/registry/credit-manifestos'),
  getCreditManifesto: (id: string) =>
    request<{ record: CreditManifesto }>(`/registry/credit-manifestos/${id}`),
  postCreditManifesto: (body: unknown) =>
    request<{ id: string; inserted: boolean }>('/registry/credit-manifestos', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Build-and-Ingest — new-spine upload entry point. Multipart body with text
  // form fields + optional file slots. Returns the rendered-analysis root id
  // for navigation to /analysis/[rootId] (which then dispatches through the
  // unified-read endpoint to the RenderedAnalysisView component).
  //
  // Form fields per build-and-ingest.routes.ts header: required dealRef,
  // analysisAsOfDate, propertyType, librarySnapshotId; XOR (marketBenchmarks
  // inline | marketBenchmarksId reference); XOR (creditManifesto inline |
  // creditManifestoId reference); optional loanTerms (JSON-stringified),
  // marketLiquidityHint, propertyHint. Files: optional asr/rent_roll/seller_cf.
  buildAndIngest: async (args: {
    files: {
      asr?: File;
      rentRoll?: File;
      sellerCf?: File;
    };
    formFields: {
      analysisAsOfDate: string;
      dealRef: string;
      propertyType: string;
      librarySnapshotId: string;
      marketBenchmarksId?: string;
      marketBenchmarks?: unknown;
      creditManifestoId?: string;
      creditManifesto?: unknown;
      loanTerms?: unknown;
      marketLiquidityHint?: string;
      propertyHint?: string;
    };
  }): Promise<{
    rootId: string;
    extractionResultId: string;
    propertyMetadataId: string | null;
    buildReport: unknown;
    evaluation: unknown;
    propertyMetadataError?: { name: string; message: string };
  }> => {
    const fd = new FormData();
    const f = args.formFields;
    fd.append('analysisAsOfDate', f.analysisAsOfDate);
    fd.append('dealRef', f.dealRef);
    fd.append('propertyType', f.propertyType);
    fd.append('librarySnapshotId', f.librarySnapshotId);
    if (f.marketBenchmarksId !== undefined) fd.append('marketBenchmarksId', f.marketBenchmarksId);
    if (f.marketBenchmarks !== undefined) fd.append('marketBenchmarks', JSON.stringify(f.marketBenchmarks));
    if (f.creditManifestoId !== undefined) fd.append('creditManifestoId', f.creditManifestoId);
    if (f.creditManifesto !== undefined) fd.append('creditManifesto', JSON.stringify(f.creditManifesto));
    if (f.loanTerms !== undefined) fd.append('loanTerms', JSON.stringify(f.loanTerms));
    if (f.marketLiquidityHint !== undefined) fd.append('marketLiquidityHint', f.marketLiquidityHint);
    if (f.propertyHint !== undefined) fd.append('propertyHint', f.propertyHint);
    if (args.files.asr) fd.append('asr', args.files.asr);
    if (args.files.rentRoll) fd.append('rent_roll', args.files.rentRoll);
    if (args.files.sellerCf) fd.append('seller_cf', args.files.sellerCf);

    const res = await fetch(`${API_BASE}/build-and-ingest`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: fd,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || error.message || 'Upload failed');
    }
    return res.json();
  },

  // Append a source document to an existing deal → re-ingest as a CHILD revision.
  // Mirrors buildAndIngest's multipart (file field "document" + body "slot"; no
  // Content-Type so the browser sets the boundary). Returns a result UNION so the
  // UI can branch on the structured error (e.g. 422 no_eval_context) without
  // string-parsing a thrown Error.
  appendDocument: async (
    id: string,
    slot: string,
    file: File,
  ): Promise<
    | {
        ok: true;
        childRevisionId: string;
        revisionOrdinal: number;
        overlayDivergences: Array<{ overlay: string; detail: string }>;
        newDocPersist: { slot: string; status: 'ok' | 'error'; fileHash?: string; message?: string };
      }
    | { ok: false; status: number; error: string; message: string }
  > => {
    const fd = new FormData();
    fd.append('document', file);
    fd.append('slot', slot);
    const res = await fetch(`${API_BASE}/analyses/${id}/append-document`, {
      method: 'POST',
      headers: { ...getAuthHeader() },
      body: fd,
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText, message: res.statusText }));
      return { ok: false, status: res.status, error: body.error ?? 'append_failed', message: body.message ?? body.error ?? 'Upload failed' };
    }
    const body = await res.json();
    return { ok: true, ...body };
  },

  // ---------------------------------------------------------------------------
  // Kicks registry (#34 follow-up) — institutional memory of rejected deals.
  // ---------------------------------------------------------------------------

  listKicks: (params: {
    assetTypes?: readonly string[];
    state?: string;
    msa?: string;
    sponsor?: string;
    vintage?: number;
    singleTenant?: boolean;
    search?: string;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.assetTypes && params.assetTypes.length > 0) {
      for (const t of params.assetTypes) qs.append('assetType', t);
    }
    if (params.state) qs.set('state', params.state);
    if (params.msa) qs.set('msa', params.msa);
    if (params.sponsor) qs.set('sponsor', params.sponsor);
    if (params.vintage !== undefined) qs.set('vintage', String(params.vintage));
    if (params.singleTenant !== undefined) qs.set('singleTenant', params.singleTenant ? 'true' : 'false');
    if (params.search) qs.set('search', params.search);
    if (params.sortBy) qs.set('sortBy', params.sortBy);
    if (params.sortDir) qs.set('sortDir', params.sortDir);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    const q = qs.toString();
    return request<any>(`/kicks${q ? `?${q}` : ''}`);
  },

  getKicksFacets: () => request<any>('/kicks/facets'),

  // ---------------------------------------------------------------------------
  // Source-doc intake (commit 1d48478). Upload-and-organize layer for the
  // historical-UW library: bulk upload supporting documents (ASR, CF, rent
  // roll, PCA, seller UW, T-12, appraisal) and route them per-slot to a deal
  // or stage them for later assignment. NO extraction wired here.
  // ---------------------------------------------------------------------------
  uploadSourceDoc: async (
    historicalUwId: string,
    slot: string,
    files: File[],
    notes?: string,
  ) => {
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    if (notes !== undefined) formData.append('notes', notes);
    const res = await fetch(`${API_BASE}/source-docs/${historicalUwId}/${slot}`, {
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
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Source-doc upload failed');
    }
    return res.json();
  },

  uploadSourceDocStaging: async (files: File[]) => {
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    const res = await fetch(`${API_BASE}/source-docs/staging`, {
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
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Staging upload failed');
    }
    return res.json();
  },

  assignStagedFiles: (
    batchId: string,
    assignments: ReadonlyArray<{
      stagingId: string;
      historicalUwId: string;
      slot: string;
      notes?: string;
    }>,
  ) =>
    request<any>(`/source-docs/staging/${batchId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ assignments }),
    }),

  discardStagingBatch: (batchId: string) =>
    request<any>(`/source-docs/staging/${batchId}`, { method: 'DELETE' }),

  listSourceDocCompleteness: (historicalUwId?: string) =>
    request<any>(
      `/source-docs/completeness${historicalUwId ? `?historicalUwId=${historicalUwId}` : ''}`,
    ),

  listSourceDocSlots: () => request<any>('/source-docs/slots'),

  /* ------------------------------------------------------------------ */
  /* Pool layer (PR 5 UI slice 1 — READ-ONLY).                          */
  /* All mutations (advance-tape Phase A / Phase B) are intentionally   */
  /* absent this slice. The backend write endpoints exist but the UI    */
  /* surfaces them only as disabled affordances until the next slice.   */
  /* ------------------------------------------------------------------ */
  listPools: (filter?: { vintage?: number; seller?: string }) => {
    const q: string[] = [];
    if (filter?.vintage !== undefined) q.push(`vintage=${filter.vintage}`);
    if (filter?.seller) q.push(`seller=${encodeURIComponent(filter.seller)}`);
    const qs = q.length > 0 ? `?${q.join('&')}` : '';
    return request<{ pools: Pool[] }>(`/pools${qs}`);
  },
  /* Data Room v2 Piece A — MINT a pool (the pool IS the deal). POST /pools with
   * { shelfName, vintage, seller? } → 201 { pool }. The server mints id via
   * mintPoolId(). The data room keys on the returned pool.id from birth
   * (data_room_doc.pool_id), so no separate room-attach is required — the room
   * auto-creates on the first drop and /pools/[poolId]/data-room is reachable by
   * poolId the moment the pool exists. */
  createPool: (body: {
    shelfName: string;
    vintage: number;
    seller?: string | null;
    /* FIX 2 — OPTIONAL. When a non-empty single-property name is supplied, the
     * server seeds ONE matchable loan into the new pool so the data room can route
     * this deal's docs (e.g. "640 5th Avenue") to it. Absent ⇒ a CMBS shell whose
     * loans arrive on a tape upload (unchanged). */
    propertyName?: string | null;
  }) =>
    request<{ pool: Pool; seededLoan?: LoanInPool }>(`/pools`, {
      method: 'POST',
      body: JSON.stringify({
        shelfName: body.shelfName,
        vintage: body.vintage,
        ...(body.seller !== undefined && body.seller !== null && body.seller !== ''
          ? { seller: body.seller }
          : {}),
        ...(body.propertyName !== undefined && body.propertyName !== null && body.propertyName !== ''
          ? { propertyName: body.propertyName }
          : {}),
      }),
    }),
  getPoolDetail: (poolId: PoolId | string) =>
    request<{ pool: Pool; currentWorkingTapeId: WorkingTapeId | null }>(`/pools/${poolId}`),
  getCurrentWorkingTape: (poolId: PoolId | string) =>
    request<{ workingTape: WorkingTape }>(`/pools/${poolId}/working-tape`),
  getTape: (poolId: PoolId | string, tapeId: TapeId | string) =>
    request<{ tape: Tape }>(`/pools/${poolId}/tapes/${tapeId}`),
  getMembership: (poolId: PoolId | string, tapeId: TapeId | string) =>
    request<{ membership: LoanMembership[] }>(`/pools/${poolId}/tapes/${tapeId}/membership`),
  getLoanInPool: (poolId: PoolId | string, loanInPoolId: LoanInPoolId | string) =>
    request<{ loan: LoanInPool }>(`/pools/${poolId}/loans/${loanInPoolId}`),
  getLoanHistory: (poolId: PoolId | string, loanInPoolId: LoanInPoolId | string) =>
    request<{ history: LoanMembership[] }>(`/pools/${poolId}/loans/${loanInPoolId}/history`),
  getDispositions: (poolId: PoolId | string) =>
    request<{ dispositions: Disposition[] }>(`/pools/${poolId}/dispositions`),
  getOverrides: (poolId: PoolId | string) =>
    request<{ overrides: Disposition[] }>(`/pools/${poolId}/overrides`),

  /* ------------------------------------------------------------------ */
  /* P4c — pool-lifecycle Closed status (write) + final tape (read).     */
  /* Wires the committed backend (d88dcf4). closeLoan returns the REAL   */
  /* outcome as a discriminated union so the UI can distinguish the two  */
  /* honest failure reasons — 422 NOT_CLEARED (server re-derived Cleared */
  /* = false) and 409 LOAN_ALREADY_DEPARTED (loan has a disposition) —   */
  /* WITHOUT collapsing them into a generic throw. Success carries the   */
  /* updated loan (now lifecycleStatus:'closed'). Auth flows through the */
  /* same getAuthHeader() + 401→login handling as every other write.     */
  /* ------------------------------------------------------------------ */
  closeLoan: async (
    poolId: PoolId | string,
    loanInPoolId: LoanInPoolId | string,
  ): Promise<CloseLoanResult> => {
    const res = await fetch(`${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({}),
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (res.ok) {
      return { ok: true, loan: (body as { loan: LoanInPool }).loan };
    }
    // Honest, code-distinguished failures. The two the UI reasons over are
    // NOT_CLEARED (422) and LOAN_ALREADY_DEPARTED (409); CLEARED_UNRESOLVABLE
    // (422) and NOT_FOUND (404) surface as themselves — never a fake pass.
    const code = typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP_${res.status}`;
    const message = typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : `Close failed (${res.status})`;
    return { ok: false, status: res.status, code, message };
  },

  // GET /api/pools/:poolId/final-tape → the per-loan CLOSED loans
  // (lifecycleStatus === 'closed'), decoupled from pool.closed_at.
  getFinalTape: (poolId: PoolId | string) =>
    request<{ loans: LoanInPool[] }>(`/pools/${poolId}/final-tape`),

  // GET /api/pools/:poolId/coverage → per-loan DOC-COVERAGE (Data-Room P0).
  // READ-ONLY, K-gated: state ∈ complete | partial | none derived from the intake
  // ledger (analyzed loans) or data-room doc presence (un-analyzed loans).
  // `missing` = tier-(a) doc-type labels not yet populated. ORTHOGONAL to the
  // Status/score verdict — a document signal, never a credit signal.
  getPoolCoverage: (poolId: PoolId | string) =>
    request<{
      coverage: Array<{
        loanInPoolId: string;
        state: 'complete' | 'partial' | 'none';
        missing: string[];
        analyzed: boolean;
      }>;
    }>(`/pools/${poolId}/coverage`),

  // GET /api/pools/:poolId/underwrite-jobs → per-loan ASYNC underwrite job state
  // (Data-Room Phase 3, P3). Latest job per loan; state ∈ pending | running | done
  // | partial | failed | interrupted. The chip polls this: pending|running →
  // "Underwriting…" (inert); done → resolves to /coverage; partial → "Scored ·
  // memo pending" (the score stands, the narrative deferred — e.g. credits out);
  // failed|interrupted → the REAL reason.
  getPoolUnderwriteJobs: (poolId: PoolId | string) =>
    request<{
      jobs: Array<{
        loanInPoolId: string;
        jobId: string;
        state: 'pending' | 'running' | 'done' | 'partial' | 'failed' | 'interrupted';
        reason: string | null;
        updatedAt: string;
      }>;
    }>(`/pools/${poolId}/underwrite-jobs`),

  // Phase 2 — servicer human inputs (site visit, etc.). Display-only, mint-safe.
  // GET is a deal-access read; PUT is SERVICER-gated (analysis:revise) server-side.
  getServicerInputs: (poolId: PoolId | string, loanInPoolId: string) =>
    request<{ inputs: Array<{ fieldType: string; value: string; author: string; updatedAt: string }> }>(
      `/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs`),
  putServicerInput: (poolId: PoolId | string, loanInPoolId: string, fieldType: string, value: string) =>
    request<{ input: { fieldType: string; value: string; author: string; updatedAt: string } }>(
      `/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/${fieldType}`,
      { method: 'PUT', body: JSON.stringify({ value }) }),
  // Resolve a graph root (the deal-room only has data.rootId) → its pool coordinates
  // + display deal name, so the deal-room can mount the servicer inputs and title itself.
  resolveLoanForRoot: (rootId: string) =>
    request<{ resolved: boolean; poolId?: string; loanInPoolId?: string; assetType?: string | null; dealName?: string | null; reason?: string }>(
      `/pools/loan-for-root/${rootId}`),
  // NOI-reconciliation receipts for the deal-room's red NOI banner — the SAME builder the
  // memo uses (byte-identical rows). Render-time/display-only; { detail: null } when absent.
  getNoiReconciliation: (rootId: string) =>
    request<{ detail: NoiReconciliationDetail | null }>(`/pools/loan-for-root/${rootId}/noi-reconciliation`),
  // "How I determined this" flag details, keyed by dimensionId / ruleId (shared with the memo).
  getFlagDetails: (rootId: string) =>
    request<{ details: Record<string, FlagDetail> }>(`/pools/loan-for-root/${rootId}/flag-details`),
  // Site photos (Chunk 1) — multi-file upload / delete / serve-url. Servicer-gated on write.
  uploadSitePhotos: async (poolId: string, loanInPoolId: string, files: readonly File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('photos', f);
    const res = await fetch(`${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/site-photos/upload`, {
      method: 'POST', headers: { ...getAuthHeader() }, body: fd,
    });
    if (!res.ok) {
      // Surface the server's real reason (e.g. multer's "Unsupported image type …")
      // so the widget can show it instead of an opaque "something went wrong".
      const body = await res.text().catch(() => '');
      let detail = body;
      try { const j = JSON.parse(body) as { error?: string; message?: string }; detail = j.message ?? j.error ?? body; } catch { /* plain text */ }
      throw new Error(detail && detail.trim().length > 0 ? `Upload failed (${res.status}): ${detail.trim()}` : `Upload failed (${res.status})`);
    }
    return res.json() as Promise<{ photos: SitePhotoRef[] }>;
  },
  deleteSitePhoto: (poolId: string, loanInPoolId: string, hash: string) =>
    request<{ photos: SitePhotoRef[] }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/site-photos/${hash}`, { method: 'DELETE' }),
  sitePhotoUrl: (poolId: string, loanInPoolId: string, hash: string) =>
    `${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/site-photos/${hash}`,

  // Sales comps (servicer input) — up to 4 sale comps (fields + a photo each) that fill
  // the workbook's Sales Comps tab at export. Servicer-gated on write.
  getSalesComps: (poolId: string, loanInPoolId: string) =>
    request<{ salesComps: SalesCompsPayload }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/sales-comps`),
  putSalesComps: (poolId: string, loanInPoolId: string, salesComps: SalesCompsPayload) =>
    request<{ salesComps: SalesCompsPayload }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/sales-comps`, {
      method: 'PUT', body: JSON.stringify({ salesComps }),
    }),
  uploadSalesCompPhoto: async (poolId: string, loanInPoolId: string, file: File) => {
    const fd = new FormData();
    fd.append('photo', file);
    const res = await fetch(`${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/sales-comps/photo`, {
      method: 'POST', headers: { ...getAuthHeader() }, body: fd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = body;
      try { const j = JSON.parse(body) as { error?: string; message?: string }; detail = j.message ?? j.error ?? body; } catch { /* plain */ }
      throw new Error(detail && detail.trim().length > 0 ? `Upload failed (${res.status}): ${detail.trim()}` : `Upload failed (${res.status})`);
    }
    return res.json() as Promise<{ hash: string; fileName: string }>;
  },
  salesCompPhotoUrl: (poolId: string, loanInPoolId: string, hash: string) =>
    `${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/sales-comps/photo/${hash}`,

  // Lease comps (servicer input) — up to 4 lease comps (shared fields + asset-type rate
  // metrics + a photo each) that fill the workbook's Lease Comps tab at export.
  getLeaseComps: (poolId: string, loanInPoolId: string) =>
    request<{ leaseComps: LeaseCompsPayload }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/lease-comps`),
  putLeaseComps: (poolId: string, loanInPoolId: string, leaseComps: LeaseCompsPayload) =>
    request<{ leaseComps: LeaseCompsPayload }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/lease-comps`, {
      method: 'PUT', body: JSON.stringify({ leaseComps }),
    }),
  uploadLeaseCompPhoto: async (poolId: string, loanInPoolId: string, file: File) => {
    const fd = new FormData();
    fd.append('photo', file);
    const res = await fetch(`${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/lease-comps/photo`, {
      method: 'POST', headers: { ...getAuthHeader() }, body: fd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = body;
      try { const j = JSON.parse(body) as { error?: string; message?: string }; detail = j.message ?? j.error ?? body; } catch { /* plain */ }
      throw new Error(detail && detail.trim().length > 0 ? `Upload failed (${res.status}): ${detail.trim()}` : `Upload failed (${res.status})`);
    }
    return res.json() as Promise<{ hash: string; fileName: string }>;
  },
  leaseCompPhotoUrl: (poolId: string, loanInPoolId: string, hash: string) =>
    `${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/lease-comps/photo/${hash}`,

  // Portfolio structure (Phase A) — the servicer's MANUAL N-property definition +
  // allocated loan amounts. Servicer-gated on write; drives the rollup export.
  getPortfolioStructure: (poolId: string, loanInPoolId: string) =>
    request<{ definition: ManualPortfolioDefinition }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/portfolio-structure`),
  putPortfolioStructure: (poolId: string, loanInPoolId: string, definition: ManualPortfolioDefinition) =>
    request<{ definition: ManualPortfolioDefinition }>(`/pools/${poolId}/loans/${loanInPoolId}/servicer-inputs/portfolio-structure`, {
      method: 'PUT', body: JSON.stringify({ definition }),
    }),

  // POST /api/pools/:poolId/loans/:loanInPoolId/underwrite → Data-Room Phase 3.
  // "Underwrite now". ★ ASYNC (was sync): ENQUEUES one durable underwrite_job
  // (the same dedup'd queue the settle fan-out uses) and returns FAST (202) — no
  // socket-timeout on a heavy 60 MB extraction. The worker drains it off-request;
  // the caller then POLLS getPoolUnderwriteJobs for the result (pending|running →
  // "Underwriting…"; done → coverage resolves; failed|interrupted → real reason).
  // alreadyActive:true ⇒ dedup returned an in-flight job (no second run).
  underwriteLoan: (poolId: PoolId | string, loanInPoolId: string) =>
    request<{
      enqueued: true;
      jobId: string;
      alreadyActive: boolean;
      state: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
      loanInPoolId: string;
    }>(`/pools/${poolId}/loans/${loanInPoolId}/underwrite`, { method: 'POST' }),

  /* ------------------------------------------------------------------ */
  /* Phase B — forward `root → loan` resolver (read-only). Turns a graph */
  /* lineage ROOT into the single pool loan it belongs to so the graph-  */
  /* native NegotiationSurface DispositionBar / Approve-&-close can go    */
  /* LIVE for a DETERMINATE loan. Wires the committed Phase-A backend     */
  /* (2d4dd54): GET /api/pools/loan-for-root?rootId=<64-hex>, requireAuth,*/
  /* always 200 — determinate vs ambiguous is carried in the body, NOT   */
  /* the HTTP status. Returns the discriminated resolution so the surface */
  /* can branch (LIVE for resolved, honest preview for ambiguous) WITHOUT */
  /* a generic throw. A missing/blank rootId is the ONLY 400 (client shape*/
  /* error) — surfaced as ambiguous ROOT_NOT_FOUND so the caller degrades */
  /* to preview rather than crashing.                                     */
  /* ------------------------------------------------------------------ */
  getLoanForRoot: async (rootId: string): Promise<LoanForRootResolution> => {
    const res = await fetch(
      `${API_BASE}/pools/loan-for-root?rootId=${encodeURIComponent(rootId)}`,
      { headers: { 'Content-Type': 'application/json', ...getAuthHeader() } },
    );
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    // The route answers 200 for BOTH determinate and ambiguous. Any non-200
    // (e.g. 400 blank rootId, or a transport error) degrades to an honest
    // ambiguous ROOT_NOT_FOUND so the surface never treats it as a live target.
    if (res.ok && (body as { resolved?: unknown }).resolved === true) {
      const b = body as { poolId: string; loanInPoolId: string; matchedBy: 'exact-deal-ref' | 'normalized-name-bridge' };
      return { resolved: true, poolId: b.poolId, loanInPoolId: b.loanInPoolId, matchedBy: b.matchedBy };
    }
    if (res.ok && (body as { resolved?: unknown }).resolved === false) {
      const b = body as { reason: 'NONE' | 'MULTIPLE' | 'ROOT_NOT_FOUND'; matchCount?: number };
      return { resolved: false, ambiguous: true, reason: b.reason, matchCount: typeof b.matchCount === 'number' ? b.matchCount : 0 };
    }
    return { resolved: false, ambiguous: true, reason: 'ROOT_NOT_FOUND', matchCount: 0 };
  },

  /* ------------------------------------------------------------------ */
  /* Phase 4 — standalone disposition (write). The NEGATIVE TERMINAL:    */
  /* reject (kicked) / withdraw (dropped) recorded directly, no tape     */
  /* freeze. Wires the committed backend (Phases 1–3). Like closeLoan,   */
  /* returns the REAL outcome as a discriminated union so the UI can     */
  /* distinguish the honest failures — 409 LOAN_ALREADY_CLOSED, 409      */
  /* LOAN_ALREADY_DISPOSED, 422 NO_CURRENT_TAPE, 404 NOT_FOUND — WITHOUT */
  /* collapsing them into a generic throw. Success carries { disposition,*/
  /* loan } (the now-disposed loan, currentDispositionId set). Actor is   */
  /* stamped SERVER-SIDE from req.user; the client never sends it. Auth   */
  /* flows through getAuthHeader() + 401→login like every other write.    */
  /* ------------------------------------------------------------------ */
  dispositionLoan: async (
    poolId: PoolId | string,
    loanInPoolId: LoanInPoolId | string,
    input: { outcome: DispositionKind; reasonCategory?: ReasonCategory | null; note?: string | null },
  ): Promise<DispositionLoanResult> => {
    const res = await fetch(`${API_BASE}/pools/${poolId}/loans/${loanInPoolId}/disposition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({
        outcome: input.outcome,
        ...(input.reasonCategory ? { reasonCategory: input.reasonCategory } : {}),
        ...(input.note ? { note: input.note } : {}),
      }),
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (res.ok) {
      const b = body as { disposition: Disposition; loan: LoanInPool };
      return { ok: true, disposition: b.disposition, loan: b.loan };
    }
    // Honest, code-distinguished failures. The three the UI reasons over are
    // LOAN_ALREADY_CLOSED (409), LOAN_ALREADY_DISPOSED (409) and NO_CURRENT_TAPE
    // (422); NOT_FOUND (404) surfaces as itself — never a fake success.
    const code = typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP_${res.status}`;
    const message = typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : `Disposition failed (${res.status})`;
    return { ok: false, status: res.status, code, message };
  },

  /* ================================================================== */
  /* Data-Room Phase 1 (Deliverable 4) — the per-pool document room.    */
  /* FRONTEND-ONLY over the shipped /api/data-room endpoints (D2 + D3).  */
  /* Upload-and-organize + browse + per-user read/unread + download-    */
  /* what's-new. No backend touched. Auth flows through getAuthHeader(). */
  /* ================================================================== */

  // GET /data-room/doc-types → the ONE authoritative taxonomy (3 tiers).
  // Used for the doc-type folder list AND the assign picker.
  dataRoomDocTypes: () =>
    request<{ docTypes: readonly DocTypeEntry[] }>(`/data-room/doc-types`),

  // POST /data-room/:poolId/staging (multipart) → a StagingBatch (staged,
  // unassigned). This is the bulk-drop primitive; assign is the next step.
  dataRoomStageFiles: async (poolId: string, files: File[]): Promise<DataRoomStageResponse> => {
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    const res = await fetch(`${API_BASE}/data-room/${poolId}/staging`, {
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
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.message || err.error || 'Data-room staging upload failed');
    }
    return res.json();
  },

  // POST /data-room/:poolId/assign → files staged blobs into the manifest at
  // (loanInPoolId, docType). THIS is the Phase-2 seam (manual assign now, auto
  // later). Each assignment is processed independently server-side.
  dataRoomAssign: (
    poolId: string,
    batchId: string,
    assignments: ReadonlyArray<DataRoomAssignmentInput>,
  ) =>
    request<{ results: readonly DataRoomAssignmentResult[] }>(`/data-room/${poolId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ batchId, assignments }),
    }),

  // GET /data-room/:poolId/by-doc-type → projection 1 (folders = doc-types,
  // tier-ordered a→b→c by the server).
  dataRoomByDocType: (poolId: string) =>
    request<{ poolId: string; groups: readonly DataRoomDocTypeGroup[] }>(
      `/data-room/${poolId}/by-doc-type`,
    ),

  // GET /data-room/:poolId/by-loan → projection 2 (grouped by loanInPoolId).
  dataRoomByLoan: (poolId: string) =>
    request<{ poolId: string; groups: readonly DataRoomLoanGroup[] }>(
      `/data-room/${poolId}/by-loan`,
    ),

  // GET /data-room/:poolId/tree → the read-only nested tree (Chunk 1):
  // Deal → Loan → Category → docType → file, on-demand folders, version/pin
  // badges. One call; server owns the nesting + ordering. Pure read.
  dataRoomTree: (poolId: string) =>
    request<DataRoomTree>(`/data-room/${poolId}/tree`),

  // GET /analyses/:id/slot-extraction/:docType → Tier 2(c): the slot's extraction as
  // a display DTO (rent_roll built). Credit-free. ?offset paginates (page size 50).
  getSlotExtraction: (analysisId: string, docType: string, offset = 0) =>
    request<{ status: 'present' | 'not_extracted'; extraction: RentRollSlotExtraction | null }>(
      `/analyses/${analysisId}/slot-extraction/${docType}?offset=${offset}`,
    ),

  // Tier 2(c) pca variant — property-condition detail (repairs + capex schedule + narratives).
  getPcaExtraction: (analysisId: string) =>
    request<{ status: 'present' | 'not_extracted'; extraction: PcaSlotExtraction | null }>(
      `/analyses/${analysisId}/slot-extraction/pca`,
    ),

  // Tier 2(c) asr variant — valuation + sources & uses + multi-year cash flows.
  getAsrExtraction: (analysisId: string) =>
    request<{ status: 'present' | 'not_extracted'; extraction: AsrSlotExtraction | null }>(
      `/analyses/${analysisId}/slot-extraction/asr`,
    ),

  // Tier 2(c) appraisal variant — value card; often not machine-extracted (template-dependent).
  getAppraisalExtraction: (analysisId: string) =>
    request<{ status: 'present' | 'not_extracted'; extraction: AppraisalSlotExtraction | null; reason?: string }>(
      `/analyses/${analysisId}/slot-extraction/appraisal`,
    ),

  // GET /pools/:poolId/loans/:loanInPoolId/missing-docs → Tier 2 (a): empty ingest
  // slots (set-difference) with a humanized label + "blocks what".
  getMissingDocs: (poolId: string, loanInPoolId: string) =>
    request<{ missing: Array<{ slot: string; label: string; blocks: string }> }>(
      `/pools/${poolId}/loans/${loanInPoolId}/missing-docs`,
    ),

  // ── Chunk 3c — confidentiality gate ─────────────────────────────────────────
  // GET /pools/:poolId/confidentiality/status → { required, accepted, agreementVersion }.
  confiStatus: (poolId: string) =>
    request<{ required: boolean; accepted: boolean; agreementVersion: string }>(
      `/pools/${poolId}/confidentiality/status`,
    ),
  // POST /pools/:poolId/confidentiality/accept → records + unlocks (sets accepted_at).
  acceptConfidentiality: (poolId: string) =>
    request<{ accepted: boolean; acceptedAt: string; agreementVersion: string }>(
      `/pools/${poolId}/confidentiality/accept`,
      { method: 'POST' },
    ),

  // ── Chunk 3d — buyer invite / accept ────────────────────────────────────────
  // POST /invites → mint a single-use buyer invite (owner/admin only).
  createInvite: (body: { resourceType: 'deal' | 'pool'; resourceKey: string; invitedEmail?: string; expiresInDays?: number }) =>
    request<{ token: string; acceptUrl: string; resourceType: string; resourceKey: string; invitedEmail: string | null; expiresAt: string }>(
      `/invites`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // GET /invites/:token → preview for the accept page (throws on invalid/expired).
  getInvite: (token: string) =>
    request<{ valid: boolean; resourceType: 'deal' | 'pool'; resourceKey: string; invitedEmail: string | null; expiresAt: string }>(
      `/invites/${token}`,
    ),
  // POST /invites/:token/accept → consume it → creates the explicit buyer grant.
  acceptInvite: (token: string) =>
    request<{ accepted: boolean; resourceType: 'deal' | 'pool'; resourceKey: string }>(
      `/invites/${token}/accept`,
      { method: 'POST' },
    ),

  // POST /data-room/:poolId/doc/:fileHash/reclassify → the manual MOVE control
  // (Chunk 2c): re-file a routed doc to a different doc-type (→ re-derives its
  // category) and/or loan. Guarded server-side (analysis:revise).
  dataRoomReclassify: (
    poolId: string,
    fileHash: string,
    target: { loanInPoolId: string; docType: string },
  ) =>
    request<{ poolId: string; fileHash: string; moved: boolean }>(
      `/data-room/${poolId}/doc/${fileHash}/reclassify`,
      { method: 'POST', body: JSON.stringify(target) },
    ),

  // GET /data-room/:poolId/by-category → the SUMMARY control surface for the
  // room (Piece D). Returns per-category { category, count, unreadCount } — NOT
  // the file list (anti-bombardment: counts, never thousands of rows). count is
  // read off the indexed data_room_doc table (projectByCategory); unreadCount is
  // computed server-side from the user's read cursor. Every category in
  // CATEGORIES_IN_ORDER is present (zero-doc categories carry count 0).
  getPoolByCategory: (poolId: string) =>
    request<{ poolId: string; categories: readonly DataRoomCategorySummary[] }>(
      `/data-room/${poolId}/by-category`,
    ),

  // ── SLICE 3 — the DURABLE HELD ("needs identification") set + resolution ─────
  // GET /data-room/:poolId/held → every durably-held (unidentified) file + count.
  // These are accepted-but-unroutable files kept in cre.db (never dropped); each
  // carries the partial cascade hints so the human resolves it pre-filled.
  dataRoomHeld: (poolId: string) =>
    request<{ poolId: string; held: readonly DataRoomHeldDoc[]; count: number }>(
      `/data-room/${poolId}/held`,
    ),

  // POST /data-room/:poolId/held/:fileHash/identify → assign (loan, docType) to a
  // held file → MOVES it from the held set into the routed set (data_room_doc),
  // where it underwrites on settle. A clean move (persist-to-doc then delete-held).
  dataRoomIdentifyHeld: (
    poolId: string,
    fileHash: string,
    loanInPoolId: string,
    docType: string,
    notes?: string,
  ) =>
    request<{ result: DataRoomAssignmentResult }>(
      `/data-room/${poolId}/held/${fileHash}/identify`,
      { method: 'POST', body: JSON.stringify({ loanInPoolId, docType, ...(notes ? { notes } : {}) }) },
    ),

  // POST /data-room/:poolId/held/:fileHash/retry → re-run a held BLOB through the
  // now-magic-byte-aware gate: iff it's a folder zip it unpacks → routes each doc
  // (some auto, some newly-held per-file) → DELETES the opaque held row (resolved).
  // If it's not a folder zip the server refuses with 409 `not_a_folder_zip` and the
  // blob stays held (the caller falls back to the manual loan/doc-type assign).
  //
  // Response summary mirrors the staging summary shape (unpacked / auto-routed /
  // newly-held / rejected). `resolved` is false when nothing came of the retry (a
  // non-resolving folder zip whose every entry was rejected/empty — original held
  // row kept). The custom error flow surfaces the server's structured `error` code
  // (so the UI can special-case 409 `not_a_folder_zip`) alongside `message`.
  dataRoomRetryHeld: async (
    poolId: string,
    fileHash: string,
  ): Promise<{
    retried: string;
    resolved: boolean;
    summary: {
      unpackedCount: number;
      autoRoutedCount: number;
      heldCount: number;
      rejectedCount: number;
    };
    autoRouted?: readonly DataRoomAssignmentResult[];
    underwriting?: {
      settled: boolean;
      affectedLoans: readonly string[];
      enqueuedCount: number;
      jobs: unknown;
    };
  }> => {
    const res = await fetch(`${API_BASE}/data-room/${poolId}/held/${fileHash}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => ({ error: res.statusText, message: res.statusText }));
      const err = new Error(body.message ?? body.error ?? `Retry failed: ${res.status}`) as Error & {
        code?: string;
        status?: number;
      };
      if (typeof body.error === 'string') err.code = body.error;
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  // ── SLICE 4 — the manual VERSION PIN override (optional, never required) ─────
  // POST /data-room/:poolId/loans/:loanInPoolId/pin → pin a specific version
  // (fileHash) of a (loan, docType) slot as the underwrite winner, overriding the
  // latest-content-date tiebreak. ★ This ONLY changes WHICH version the NEXT
  // underwrite reads — it does NOT trigger a re-underwrite (no LLM run). Refetch
  // the doc view after success so the selected marker + reason update.
  dataRoomPinDoc: (poolId: string, loanInPoolId: string, docType: string, fileHash: string) =>
    request<{ result: { status: 'pinned' | 'error'; loanInPoolId: string; docType: string; fileHash: string; error?: string } }>(
      `/data-room/${poolId}/loans/${loanInPoolId}/pin`,
      { method: 'POST', body: JSON.stringify({ docType, fileHash }) },
    ),

  // POST /data-room/:poolId/loans/:loanInPoolId/unpin → clear the pin for a
  // (loan, docType) slot → the NEXT underwrite reverts to latest-content-date.
  dataRoomUnpinDoc: (poolId: string, loanInPoolId: string, docType: string) =>
    request<{ result: { status: 'unpinned' | 'error'; loanInPoolId: string; docType: string; error?: string } }>(
      `/data-room/${poolId}/loans/${loanInPoolId}/unpin`,
      { method: 'POST', body: JSON.stringify({ docType }) },
    ),

  // GET /data-room/:poolId/unread → per-user unread fileHashes + count.
  dataRoomUnread: (poolId: string) =>
    request<{ poolId: string; unread: readonly string[]; count: number }>(
      `/data-room/${poolId}/unread`,
    ),

  // POST /data-room/:poolId/read → mark one doc read (clears its unread dot).
  dataRoomMarkRead: (poolId: string, fileHash: string) =>
    request<{ ok: true; fileHash: string; read: true }>(`/data-room/${poolId}/read`, {
      method: 'POST',
      body: JSON.stringify({ fileHash }),
    }),

  // GET /data-room/:poolId/doc/:fileHash → stream one doc's bytes (opens the
  // doc inline). Returned as a blob; the caller opens it in a new tab. Marking
  // read is a SEPARATE call (dataRoomMarkRead) so read-state is explicit.
  dataRoomOpenDoc: async (poolId: string, fileHash: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/data-room/${poolId}/doc/${fileHash}`, {
      headers: { ...getAuthHeader() },
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`Doc download failed (${res.status})`);
    return res.blob();
  },

  // GET /data-room/:poolId/download → zip of new-since-cursor (advances the
  // per-user cursor server-side on a successful, non-empty pull). Triggers a
  // browser download; returns the X-Data-Room-New-Count header the server sets.
  dataRoomDownloadNew: async (poolId: string): Promise<{ newCount: number }> => {
    const res = await fetch(`${API_BASE}/data-room/${poolId}/download`, {
      headers: { ...getAuthHeader() },
    });
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`Download-what's-new failed (${res.status})`);
    const newCount = Number(res.headers.get('X-Data-Room-New-Count') ?? '0');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `data-room-${poolId}-new.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { newCount };
  },

  // GET /data-room/:poolId/download?category={category} → the category-structured
  // download (Piece E's ?category= filter): a zip whose entries land under a
  // {Category}/loan/docType/ folder tree. Same auth'd blob path as
  // dataRoomDownloadNew (the token rides via getAuthHeader — a plain <a href>
  // would drop it), and it advances the same per-user cursor server-side. Returns
  // the X-Data-Room-New-Count the server sets.
  dataRoomDownloadCategory: async (
    poolId: string,
    category: DocTypeCategory,
  ): Promise<{ newCount: number }> => {
    const res = await fetch(
      `${API_BASE}/data-room/${poolId}/download?category=${encodeURIComponent(category)}`,
      { headers: { ...getAuthHeader() } },
    );
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('cre_token');
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`Category download failed (${res.status})`);
    const newCount = Number(res.headers.get('X-Data-Room-New-Count') ?? '0');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `data-room-${poolId}-${category}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { newCount };
  },
};

/**
 * P4c — the honest close outcome. `ok:true` carries the updated loan; `ok:false`
 * carries the server `code` (NOT_CLEARED | LOAN_ALREADY_DEPARTED | CLEARED_UNRESOLVABLE
 * | NOT_FOUND | HTTP_*) + human `message` so the UI can show the SPECIFIC reason
 * (no green on a red result). Deliberately a union, not a throw, so the two
 * expected reasons never collapse into a generic Error.
 */
export type CloseLoanResult =
  | { readonly ok: true; readonly loan: LoanInPool }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/**
 * Phase 4 — the honest standalone-disposition outcome. `ok:true` carries the
 * recorded `disposition` + the updated `loan` (now `currentDispositionId` set);
 * `ok:false` carries the server `code` (LOAN_ALREADY_CLOSED | LOAN_ALREADY_DISPOSED
 * | NO_CURRENT_TAPE | NOT_FOUND | HTTP_*) + human `message` so the UI shows the
 * SPECIFIC reason (no green on a red result). A union, not a throw, so the three
 * expected reasons never collapse into a generic Error.
 */
export type DispositionLoanResult =
  | { readonly ok: true; readonly disposition: Disposition; readonly loan: LoanInPool }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/**
 * Phase B — the forward `root → loan` resolution. Mirrors the Phase-A backend
 * `LoanForRootResolution` (resolve-loan-for-root.ts). `resolved:true` carries the
 * single pool identity (poolId / loanInPoolId) the graph-native DispositionBar +
 * Approve-&-close write against; `resolved:false` (ambiguous) carries the reason
 * (NONE = un-pooled / name-less root · MULTIPLE = deal in >1 pool · ROOT_NOT_FOUND
 * = unknown root) so the surface degrades to an honest preview/deep-link and NEVER
 * guesses a target. A discriminated union, not a throw — the ambiguous case is a
 * normal 200, not an error.
 */
export type LoanForRootResolution =
  | {
      readonly resolved: true;
      readonly poolId: string;
      readonly loanInPoolId: string;
      readonly matchedBy: 'exact-deal-ref' | 'normalized-name-bridge';
    }
  | {
      readonly resolved: false;
      readonly ambiguous: true;
      readonly reason: 'NONE' | 'MULTIPLE' | 'ROOT_NOT_FOUND';
      readonly matchCount: number;
    };

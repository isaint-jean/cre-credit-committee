'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import type { Analysis } from '@cre/shared';
import type { CommitteeTimeline, DealWorkflowState, HandbookEvaluation, RenderedAnalysis } from '@cre/contracts';
import { RenderedAnalysisView } from '@/components/RenderedAnalysisView';
import { DealRoom } from '@/components/DealRoom';

/**
 * Analysis route. ONE renderer per response shape:
 *   - rendered (graph-backed, 64-hex ids) → RenderedAnalysisView (+ committee surface)
 *   - legacy   (uuid ids)                 → the DealRoom (negotiation view)
 * The legacy dashboard was retired in Pass 4b; DealRoom self-fetches the analysis.
 */
export default function AnalysisDashboard() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [rendered, setRendered] = useState<RenderedAnalysis | null>(null);
  const [workflow, setWorkflow] = useState<DealWorkflowState | null>(null);
  const [timeline, setTimeline] = useState<CommitteeTimeline | null>(null);
  const [handbookEvaluation, setHandbookEvaluation] = useState<HandbookEvaluation | null>(null);
  const [loading, setLoading] = useState(true);
  // Converge phase i — set true while redirecting a uuid URL onto its graph id, so we
  // render a spinner instead of momentarily flashing the dormant DealRoom.
  const [redirecting, setRedirecting] = useState(false);

  // Poll for status while processing. Rendered (content-hashed) roots are immutable —
  // we stop polling once seen. Legacy analyses poll until complete/error.
  useEffect(() => {
    let interval: NodeJS.Timeout;
    const fetchAnalysis = async () => {
      try {
        const response = await api.getAnalysis(id);
        setLoading(false);
        if (response.kind === 'rendered') {
          setRendered(response.body);
          clearInterval(interval);
          const rootId = response.body.rootId;
          try { setWorkflow(await api.getWorkflowState(rootId)); } catch {}
          try { setTimeline(await api.getCommitteeTimeline(rootId)); } catch {}
          try { setHandbookEvaluation(await api.getHandbookEvaluation(rootId)); } catch {}
          return;
        }
        // Converge phase i — a uuid URL that has a graph spine redirects onto its
        // graph id so it lands on RenderedAnalysisView (the negotiation surface + the
        // committee write path). The DealRoom branch below stays a DORMANT fallback for
        // a pure-legacy row with no graph spine (none exist today, but the branch is
        // honest). `?side` is preserved across the redirect.
        const graphRoot = response.body.graphLineageRootId;
        if (typeof graphRoot === 'string' && graphRoot.length > 0 && graphRoot !== id) {
          clearInterval(interval);
          setRedirecting(true);
          const qs = searchParams.toString();
          router.replace(`/analysis/${graphRoot}${qs ? `?${qs}` : ''}`);
          return;
        }
        const legacy = response.body.analysis as Analysis;
        setAnalysis(legacy);
        if (legacy.status === 'complete' || legacy.status === 'error') clearInterval(interval);
      } catch {
        setLoading(false);
      }
    };
    fetchAnalysis();
    interval = setInterval(fetchAnalysis, 2000);
    return () => clearInterval(interval);
  }, [id, router, searchParams]);

  // Committee actions on the rendered surface refetch the workflow/timeline projections.
  const refetchWorkflow = useCallback(async () => {
    if (rendered === null) return;
    const rootId = rendered.rootId;
    try { setWorkflow(await api.getWorkflowState(rootId)); } catch {}
    try { setTimeline(await api.getCommitteeTimeline(rootId)); } catch {}
  }, [rendered]);

  // Rendered (graph-backed) analyses keep their own materialized view + committee surface.
  if (rendered !== null) {
    return (
      <RenderedAnalysisView
        data={rendered}
        analysisId={id}
        workflow={workflow ?? undefined}
        timeline={timeline ?? undefined}
        handbookEvaluation={handbookEvaluation}
        onWorkflowChanged={() => { void refetchWorkflow(); }}
        onRevisionSaved={async () => {
          try {
            const response = await api.getAnalysis(id);
            if (response.kind === 'rendered') {
              setRendered(response.body);
              const rootId = response.body.rootId;
              try { setWorkflow(await api.getWorkflowState(rootId)); } catch {}
              try { setTimeline(await api.getCommitteeTimeline(rootId)); } catch {}
              try { setHandbookEvaluation(await api.getHandbookEvaluation(rootId)); } catch {}
            }
          } catch {}
        }}
      />
    );
  }

  if (loading || redirecting) {
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

  // Legacy analysis still processing — show progress before mounting the deal room.
  if (analysis.status !== 'complete' && analysis.status !== 'error') {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <div className="text-center max-w-md">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-lg font-semibold text-text-primary mb-2">Analyzing {analysis.name}</h2>
          <p className="text-sm text-text-secondary mb-4">{analysis.currentStep}</p>
          <div className="w-full bg-bg-tertiary rounded-full h-2 mb-2">
            <div className="bg-accent h-2 rounded-full transition-all duration-500" style={{ width: `${analysis.progress}%` }} />
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

  return <DealRoom id={id} />;
}

// Overlay-scoped action surface (Phase 4 - OVERRIDE_DECISION entry point).
//
// This is the ONLY UI route from which OVERRIDE_DECISION can be triggered. The
// deal-level dashboard's CommitteeActionButtons explicitly excludes the override
// kind (see ACTIONS array in CommitteeActionButtons.tsx). The route here:
//
//   1. Loads the RenderedAnalysis for the analysis id and confirms it is the
//      graph-backed (post-6.8) form. Legacy uuid analyses do not participate
//      in the overlay surface.
//   2. Loads the deal-level workflow projection.
//   3. Confirms the overlayId in the URL exists by checking the audit-replay
//      chains for the deal (existing GET /audit-replay endpoint). No new
//      overlay-fetch endpoint is introduced; existence is derived.
//   4. Renders the dedicated OverlayActionPanel.
//
// DISCIPLINE:
//   - No client-side workflow logic. Terminal-state gating delegates to
//     OverlayActionPanel which consumes the projection verbatim.
//   - Server enforces overlay-binding; if the renderedAnalysisId does not match
//     the overlay, POST /committee-actions returns 400 OVERLAY_BINDING_MISMATCH.

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import type {
  CommitteeTimeline,
  DealWorkflowState,
  RenderedAnalysis,
} from '@cre/contracts';
import { api, type AuditReplayResponse } from '@/lib/api-client';
import { CommitteeStatusHeader } from '@/components/CommitteeStatusHeader';
import { CommitteeTimelinePanel } from '@/components/CommitteeTimelinePanel';
import { OverlayActionPanel } from '@/components/OverlayActionPanel';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-rendered' }                  // legacy uuid id — no overlay surface
  | { kind: 'overlay-missing'; rootId: string }
  | { kind: 'ready';
      rendered: RenderedAnalysis;
      workflow: DealWorkflowState;
      timeline: CommitteeTimeline | null;
    }
  | { kind: 'error'; message: string };

export default function OverlayActionPage(): React.ReactElement {
  const { id, overlayId } = useParams<{ id: string; overlayId: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const response = await api.getAnalysis(id);
      if (response.kind !== 'rendered') {
        setState({ kind: 'not-rendered' });
        return;
      }
      const rendered = response.body;
      const rootId = rendered.rootId;

      const [workflow, timeline, replay] = await Promise.all([
        api.getWorkflowState(rootId),
        api.getCommitteeTimeline(rootId).catch(() => null),
        api.getAuditReplay(rootId).catch<AuditReplayResponse | null>(() => null),
      ]);

      const overlayExists = replay !== null
        && Object.prototype.hasOwnProperty.call(replay.chains, overlayId);
      if (!overlayExists) {
        setState({ kind: 'overlay-missing', rootId });
        return;
      }

      setState({ kind: 'ready', rendered, workflow, timeline });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  }, [id, overlayId]);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === 'loading') {
    return <div className="p-6 text-sm text-gray-600">Loading overlay action surface...</div>;
  }
  if (state.kind === 'not-rendered') {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-2">
        <h1 className="text-xl font-bold text-gray-900">Overlay actions unavailable</h1>
        <p className="text-sm text-gray-700">
          This analysis is in the legacy format. Overlay-scoped actions require the
          graph-backed analysis surface.
        </p>
      </div>
    );
  }
  if (state.kind === 'overlay-missing') {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-2">
        <h1 className="text-xl font-bold text-gray-900">Overlay not found</h1>
        <p className="text-sm text-gray-700">
          No overlay with id <span className="font-mono">{overlayId}</span> exists for this deal.
        </p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-2">
        <h1 className="text-xl font-bold text-red-800">Failed to load</h1>
        <p className="text-sm text-red-700 font-mono">{state.message}</p>
      </div>
    );
  }

  const { rendered, workflow, timeline } = state;
  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <header className="space-y-1">
        <p className="text-xs font-mono text-gray-500">
          analysis: {id} . overlay: {overlayId}
        </p>
        <h1 className="text-2xl font-bold text-gray-900">Overlay Action Surface</h1>
        <p className="text-sm text-gray-600">
          The Submit Override Decision action below is the only entry point for
          OVERRIDE_DECISION events. Server validates overlay binding before any
          committee action is appended.
        </p>
      </header>

      <CommitteeStatusHeader workflow={workflow} />

      <OverlayActionPanel
        rootId={rendered.rootId}
        renderedAnalysisId={rendered.id}
        overlayId={overlayId as never}
        workflow={workflow}
        onSubmitted={() => { void load(); }}
      />

      {timeline !== null ? <CommitteeTimelinePanel timeline={timeline} /> : null}
    </div>
  );
}

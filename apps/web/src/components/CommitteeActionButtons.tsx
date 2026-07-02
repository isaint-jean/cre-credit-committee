// CommitteeActionButtons (Phase 4 - operational workflow UX).
//
// Display-only buttons that submit committee actions to the API. EVERY click
// is a thin POST /committee-actions call followed by a workflow refresh. The
// UI does NOT decide whether a button is allowed - the server's permission
// matrix + state projection is the truth source. If the click is denied, the
// server returns 401/403/400 and we surface the error message verbatim.
//
// DISCIPLINE (mirrors consumer-migration v1):
//   - No business logic. No state machine. No "allowed transitions" table.
//   - The button list is the full COMMITTEE_ACTION_KINDS surface.
//   - Each click calls the API. The API response (or refetched workflow state)
//     is the source of truth for what happened.
//   - Author is server-side from req.user; we never send author in the body.

'use client';

import React, { useState } from 'react';
import type {
  CommitteeActionKind,
  CommitteeActionPayload,
  DealWorkflowState,
  DoctrineEvaluationId,
  RenderedAnalysisId,
} from '@cre/contracts';
import { api } from '@/lib/api-client';

// ── P1 design-system tokens (same palette RenderedAnalysisView uses: teal platform
//    primary, ink/paper light ramp, restrained red outline for destructive). Kept
//    local so this component carries no Tailwind default-color rainbow. ─────────────
const C = {
  surface: '#FFFFFF', border: '#E2E8EA', borderStrong: '#CCD6D9',
  ink: '#15262C', ink2: '#4A5C62', ink3: '#8A979C',
  teal: '#0C6E78', tealDeep: '#0A555D',
  red: '#AE3A33', redSoft: '#FBECEB',
} as const;

interface Props {
  readonly rootId: DoctrineEvaluationId;
  readonly renderedAnalysisId: RenderedAnalysisId;
  readonly workflow: DealWorkflowState;
  readonly onActionSubmitted: () => void;
}

// Weight of a button in the P1 hierarchy:
//   primary   — one solid teal block (the main forward action)
//   secondary — teal outline (alternate committee actions)
//   tertiary  — ghost / low-emphasis text button
//   danger    — restrained red OUTLINE (never a solid destructive block)
type ActionWeight = 'primary' | 'secondary' | 'tertiary' | 'danger';

interface ActionDef {
  readonly kind: CommitteeActionKind;
  readonly label: string;
  readonly weight: ActionWeight;
}

// APPROVE_DEAL is the single PRIMARY (the main affirmative committee action);
// Submit is secondary (a forward step but not the decision), Request More Info /
// Postpone are tertiary ghost buttons, Reject is a restrained red outline.
const ACTIONS: readonly ActionDef[] = [
  { kind: 'APPROVE_DEAL',        label: 'Approve',             weight: 'primary'   },
  { kind: 'SUBMIT_TO_COMMITTEE', label: 'Submit to Committee', weight: 'secondary' },
  { kind: 'REQUEST_MORE_INFO',   label: 'Request More Info',   weight: 'tertiary'  },
  { kind: 'POSTPONE_DEAL',       label: 'Postpone',            weight: 'tertiary'  },
  { kind: 'REJECT_DEAL',         label: 'Reject',              weight: 'danger'    },
];

// Consistent height / spacing / weight per tier — no default-color blocks.
function buttonStyle(weight: ActionWeight): React.CSSProperties {
  const base: React.CSSProperties = {
    height: 34, padding: '0 16px', fontSize: 13, borderRadius: 7,
    cursor: 'pointer', lineHeight: 1, transition: 'background 120ms, border-color 120ms',
  };
  switch (weight) {
    case 'primary':
      return { ...base, fontWeight: 600, border: 'none', background: C.teal, color: '#fff' };
    case 'secondary':
      return { ...base, fontWeight: 600, border: `1px solid ${C.teal}`, background: C.surface, color: C.tealDeep };
    case 'tertiary':
      return { ...base, fontWeight: 500, border: `1px solid transparent`, background: 'transparent', color: C.ink2 };
    case 'danger':
      return { ...base, fontWeight: 600, border: `1px solid ${C.red}`, background: C.surface, color: C.red };
  }
}

function buildDefaultPayload(kind: CommitteeActionKind): CommitteeActionPayload {
  switch (kind) {
    case 'SUBMIT_TO_COMMITTEE':
      return { kind, committeeName: 'CRE-Committee', summary: 'Submitted via dashboard' };
    case 'REQUEST_MORE_INFO':
      return { kind, questions: ['Please clarify.'] };
    case 'APPROVE_DEAL':
      return { kind, conditions: [] };
    case 'REJECT_DEAL':
      return { kind, reasons: ['See committee notes.'] };
    case 'POSTPONE_DEAL':
      return { kind, reason: 'Deferred to next session', until: null };
    case 'OVERRIDE_DECISION':
      // OVERRIDE_DECISION requires an overlayId; this default surface does not
      // expose it. Override flows are launched from the overlay view, not here.
      throw new Error('OVERRIDE_DECISION must be triggered from the overlay context');
  }
}

export function CommitteeActionButtons({
  rootId,
  renderedAnalysisId,
  workflow,
  onActionSubmitted,
}: Props): React.ReactElement {
  const [pending, setPending] = useState<CommitteeActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(kind: CommitteeActionKind): Promise<void> {
    if (pending !== null) return;
    setPending(kind);
    setError(null);
    try {
      const payload = buildDefaultPayload(kind);
      await api.submitCommitteeAction({
        rootId,
        renderedAnalysisId,
        kind,
        payload,
      });
      onActionSubmitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  return (
    <section style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, background: C.surface }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', fontWeight: 600, color: C.ink3 }}>
          Committee Actions
        </h2>
        <span style={{ fontSize: 11, fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: C.ink3 }}>
          state: {workflow.state}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            type="button"
            disabled={busy}
            onClick={() => { void trigger(a.kind); }}
            style={{ ...buttonStyle(a.weight), opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            {pending === a.kind ? '…' : a.label}
          </button>
        ))}
      </div>
      {error !== null ? (
        <p style={{ marginTop: 10, fontSize: 12, fontFamily: '"IBM Plex Mono", ui-monospace, monospace', color: C.red, background: C.redSoft, borderRadius: 6, padding: '6px 10px' }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

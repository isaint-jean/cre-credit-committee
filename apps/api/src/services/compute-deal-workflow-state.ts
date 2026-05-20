// Deal workflow state projection (Phase 3).
//
// Pure derivation. Reads the immutable event streams (committee actions + audit
// events) and computes the current DealWorkflowState. NEVER mutates any store.
// Output is deterministic: same store state -> same output.
//
// ============================================================================
// Workflow-projection discipline (LOCKED). Mirrors RP1-RP5 from replay engine.
// ============================================================================
//
//   WP1 - Pure read. Never INSERT/UPDATE/DELETE.
//   WP2 - Deterministic. Same input -> same output.
//   WP3 - No synthesis. State is derived strictly from events. If the chain is
//         malformed (orphan, multi-root), we return what's reachable from the
//         single canonical chain root and surface no fabricated state.
//   WP4 - Chain ordering canonical. previousActionId drives state transitions;
//         occurred_at is a hint, not the truth source.
//   WP5 - No render reach-back. Projection imports only contract types and the
//         two stores it needs. NEVER touches producers, render, or cache.
//
// Lifecycle derivation rules:
//   1. If no committee actions exist for the deal:
//      - If at least one overlay-created event exists in the audit log -> IN_REVIEW
//      - Otherwise -> DRAFT
//   2. If committee actions exist, walk the chain to find the LAST action:
//      - APPROVE_DEAL    -> APPROVED
//      - REJECT_DEAL     -> REJECTED
//      - POSTPONE_DEAL   -> POSTPONED
//      - SUBMIT_TO_COMMITTEE -> IN_COMMITTEE
//      - REQUEST_MORE_INFO   -> IN_REVIEW (deal sent back from committee)
//      - OVERRIDE_DECISION   -> walk back through chain to find the most recent
//                                state-changing action; default IN_COMMITTEE if none
// ============================================================================

import type {
  CommitteeActionEvent,
  CommitteeActionId,
  CommitteeActionKind,
  CommitteeSnapshotId,
  DealState,
  DealWorkflowState,
  DoctrineEvaluationId,
} from '@cre/contracts';
import type { AuditEventsStore } from '../storage/audit-events-store.js';
import type { CommitteeActionsStore } from '../storage/committee-actions-store.js';

export interface ComputeDealWorkflowStateInput {
  readonly rootId: DoctrineEvaluationId;
  readonly committeeActionsStore: CommitteeActionsStore;
  readonly auditEventsStore: AuditEventsStore;
}

// Map of action kind -> derived state. OVERRIDE_DECISION is special-cased
// because it doesn't change lifecycle by itself; the chain is walked backward.
const STATE_CHANGING_KINDS: { readonly [K in CommitteeActionKind]?: DealState } = {
  APPROVE_DEAL: 'APPROVED',
  REJECT_DEAL: 'REJECTED',
  POSTPONE_DEAL: 'POSTPONED',
  SUBMIT_TO_COMMITTEE: 'IN_COMMITTEE',
  REQUEST_MORE_INFO: 'IN_REVIEW',
};

function sortActionChain(
  actions: readonly CommitteeActionEvent[],
): readonly CommitteeActionEvent[] {
  // Walk from chain root (previousActionId === null) forward. Returns events in
  // chain order; orphans dropped (WP3 fragment policy).
  const byId = new Map<CommitteeActionId, CommitteeActionEvent>();
  const byPrev = new Map<CommitteeActionId, CommitteeActionEvent>();
  let root: CommitteeActionEvent | undefined;
  for (const a of actions) {
    byId.set(a.id, a);
    if (a.previousActionId === null) {
      if (root === undefined) root = a;
    } else {
      if (!byPrev.has(a.previousActionId)) byPrev.set(a.previousActionId, a);
    }
  }
  if (root === undefined) return [];

  const ordered: CommitteeActionEvent[] = [root];
  let cursor: CommitteeActionEvent = root;
  while (true) {
    const next = byPrev.get(cursor.id);
    if (next === undefined) break;
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

function deriveStateFromChain(
  chain: readonly CommitteeActionEvent[],
  hasOverlay: boolean,
): DealState {
  if (chain.length === 0) {
    return hasOverlay ? 'IN_REVIEW' : 'DRAFT';
  }

  // Walk the chain backward to find the most recent state-changing action.
  // OVERRIDE_DECISION is non-state-changing per spec; skip those when looking
  // for the canonical lifecycle event.
  for (let i = chain.length - 1; i >= 0; i--) {
    const action = chain[i];
    if (action === undefined) continue;
    const mapped = STATE_CHANGING_KINDS[action.kind];
    if (mapped !== undefined) return mapped;
    // OVERRIDE_DECISION: skip, look further back.
  }

  // Chain consists entirely of OVERRIDE_DECISIONs (unusual). Treat as IN_COMMITTEE
  // since overrides happen during committee review.
  return 'IN_COMMITTEE';
}

function computeActiveParticipants(
  chain: readonly CommitteeActionEvent[],
): readonly string[] {
  const seen = new Set<string>();
  for (const a of chain) seen.add(a.author);
  // Sorted alphabetically for deterministic output (WP2).
  return Array.from(seen).sort();
}

function findLastSnapshotId(
  chain: readonly CommitteeActionEvent[],
): CommitteeSnapshotId | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i];
    if (a !== undefined && a.snapshotId !== null) return a.snapshotId;
  }
  return null;
}

export function computeDealWorkflowState(
  input: ComputeDealWorkflowStateInput,
): DealWorkflowState {
  const { rootId, committeeActionsStore, auditEventsStore } = input;

  const allActions = committeeActionsStore.getByRoot(rootId);
  const chain = sortActionChain(allActions);

  // Has any overlay been created for this deal? Look in audit events for any
  // 'overlay-created' kind anchored to rootId.
  const auditEvents = auditEventsStore.getByRoot(rootId);
  const hasOverlay = auditEvents.some((e) => e.kind === 'overlay-created');

  const state = deriveStateFromChain(chain, hasOverlay);
  const activeParticipants = computeActiveParticipants(chain);

  const lastAction = chain.length > 0 ? chain[chain.length - 1] : undefined;
  const lastActionAt = lastAction !== undefined ? lastAction.occurredAt : null;
  const lastActionId = lastAction !== undefined ? lastAction.id : null;
  const lastSnapshotId = findLastSnapshotId(chain);

  return {
    rootId,
    state,
    activeParticipants,
    lastActionAt,
    lastActionId,
    lastSnapshotId,
  };
}

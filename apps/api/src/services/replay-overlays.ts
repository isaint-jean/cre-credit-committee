// Replay engine (Phase 2 v2 - post-7.2). Pure derivation.
//
// Reconstructs effective overlay state from the audit log + patches store. The audit
// log is the source of truth for ordering and history; patches are the immutable
// content. An overlay's current state is the sum of all 'comment-added' /
// 'override-added' / 'tag-added' events MINUS all '*-removed' events, applied in
// chain order.
//
// ============================================================================
// Replay-engine discipline (LOCKED). Mirrors HY/PJ/RD/SX patterns.
// ============================================================================
//
//   RP1 - Pure read. Never mutates stored data. No INSERT, UPDATE, DELETE issued
//         against the audit-events or overlay-patches tables.
//
//   RP2 - Deterministic. Same store state -> same output. No clock reads, no random,
//         no env. Chain order is canonical (see RP4).
//
//   RP3 - No interpretation. Replay applies events mechanically: overlay-created
//         seeds metadata; *-added appends a patch reference; *-removed removes a
//         patch reference. There is NO field-level merging, NO conflict resolution,
//         NO synthesis. If the audit log says "comment-removed" for an unknown
//         patch, the removal is a no-op (defensive; doesn't fabricate state).
//
//   RP4 - Chain ordering. Events are sequenced by walking previousEventId pointers
//         from the chain root (where previousEventId === null) forward. Storage's
//         occurred_at index is a hint, not the canonical order; a malformed audit
//         log (broken chain) returns whatever fragment is reachable from root,
//         leaves the rest unprocessed, and surfaces a diagnostic.
//
//   RP5 - No render reach-back. This module imports ONLY @cre/contracts types and
//         the two stores. It does NOT import producers, render, or the cache.

import type {
  AuditEvent,
  AuditEventId,
  DoctrineEvaluationId,
  EditableOverlay,
  OverlayCommentPatch,
  OverlayId,
  OverlayOverridePatch,
  OverlayPatch,
  OverlayPatchId,
  OverlayTagPatch,
  RenderVersion,
  RenderedAnalysisId,
} from '@cre/contracts';
import type { AuditEventsStore } from '../storage/audit-events-store.js';
import type { OverlayPatchesStore } from '../storage/overlay-patches-store.js';

// ------------------------------ Public API ------------------------------

// rebuildAuditChain(rootId, store) - returns the audit events for every overlay
// anchored to the analysis root, organized by overlay and ordered by chain.
// Each value array is sequenced from the chain root (overlay-created) forward.
export function rebuildAuditChain(
  rootId: DoctrineEvaluationId,
  auditStore: AuditEventsStore,
): ReadonlyMap<OverlayId, readonly AuditEvent[]> {
  const eventsForRoot = auditStore.getByRoot(rootId);
  return groupAndSortByChain(eventsForRoot);
}

// replayOverlays(rootId, renderVersion, ...) - reconstructs every overlay's
// effective state at the (rootId, renderVersion) anchor. Uses the audit log to
// determine current membership; resolves patch bodies from the patches store.
// Returns one EditableOverlay per overlay anchored to the (root, version) pair.
export function replayOverlays(
  rootId: DoctrineEvaluationId,
  renderVersion: RenderVersion,
  auditStore: AuditEventsStore,
  patchesStore: OverlayPatchesStore,
): readonly EditableOverlay[] {
  const eventsForVersion = auditStore.getByRootAndVersion(rootId, renderVersion);
  const chainsByOverlay = groupAndSortByChain(eventsForVersion);

  const overlays: EditableOverlay[] = [];
  for (const [overlayId, chain] of chainsByOverlay.entries()) {
    const reconstructed = reconstructOverlay(overlayId, chain, patchesStore);
    if (reconstructed !== null) overlays.push(reconstructed);
  }
  // Stable ordering across replays: sort by overlay's createdAt, ties broken by
  // overlayId. Deterministic (RP2).
  return overlays.slice().sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

// ----------------------------- Internals ------------------------------

// Group events by overlayId and sequence each group by previousEventId chain.
// The chain root has previousEventId === null. Walks forward from each root.
// Events orphaned by a broken chain are NOT included (RP4 fragment policy).
function groupAndSortByChain(
  events: readonly AuditEvent[],
): Map<OverlayId, readonly AuditEvent[]> {
  // First, partition by overlayId
  const byOverlay = new Map<OverlayId, AuditEvent[]>();
  for (const e of events) {
    let bucket = byOverlay.get(e.overlayId);
    if (bucket === undefined) {
      bucket = [];
      byOverlay.set(e.overlayId, bucket);
    }
    bucket.push(e);
  }

  // Then, for each overlay, walk the chain forward from previousEventId === null.
  const out = new Map<OverlayId, readonly AuditEvent[]>();
  for (const [overlayId, bucket] of byOverlay.entries()) {
    out.set(overlayId, sortChain(bucket));
  }
  return out;
}

// Sort a per-overlay event bucket by walking the previousEventId chain forward
// from the root (event with previousEventId === null). Returns events in chain
// order; events unreachable from the root are dropped (RP4).
function sortChain(events: readonly AuditEvent[]): readonly AuditEvent[] {
  // Index events by id and by previousEventId for O(N) traversal.
  const byId = new Map<AuditEventId, AuditEvent>();
  const byPrev = new Map<AuditEventId | 'ROOT', AuditEvent>();
  let root: AuditEvent | undefined;
  for (const e of events) {
    byId.set(e.id, e);
    if (e.previousEventId === null) {
      // Multiple roots are pathological; first wins, others orphaned.
      if (root === undefined) root = e;
    } else {
      // If multiple events share the same previous, this is also pathological;
      // first wins (deterministic given storage ordering).
      const key = e.previousEventId;
      if (!byPrev.has(key)) byPrev.set(key, e);
    }
  }
  if (root === undefined) return [];

  const ordered: AuditEvent[] = [root];
  let cursor: AuditEvent = root;
  while (true) {
    const next = byPrev.get(cursor.id);
    if (next === undefined) break;
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

// Reconstruct an EditableOverlay by applying events in chain order. Resolves patch
// bodies from the patches store on-demand.
function reconstructOverlay(
  overlayId: OverlayId,
  chain: readonly AuditEvent[],
  patchesStore: OverlayPatchesStore,
): EditableOverlay | null {
  if (chain.length === 0) return null;

  const root = chain[0];
  if (root === undefined || root.kind !== 'overlay-created') return null;
  if (root.payload.kind !== 'overlay-created') return null;

  let renderedAnalysisId: RenderedAnalysisId | null = null;
  let renderVersion: RenderVersion | null = null;
  let createdAt: string | null = null;

  // Capture overlay metadata from the create event.
  renderedAnalysisId = root.payload.renderedAnalysisId;
  renderVersion = root.payload.renderVersion;
  createdAt = root.occurredAt;

  // Track active patch ids per kind. Maps preserve insertion order in JS, so
  // iteration is deterministic.
  const activeComments = new Map<OverlayPatchId, true>();
  const activeOverrides = new Map<OverlayPatchId, true>();
  const activeTags = new Map<OverlayPatchId, true>();

  for (let i = 1; i < chain.length; i++) {
    const e = chain[i];
    if (e === undefined) continue;
    if (e.payload.kind === 'comment-added') activeComments.set(e.payload.patchId, true);
    else if (e.payload.kind === 'override-added') activeOverrides.set(e.payload.patchId, true);
    else if (e.payload.kind === 'tag-added') activeTags.set(e.payload.patchId, true);
    else if (e.payload.kind === 'comment-removed') activeComments.delete(e.payload.patchId);
    else if (e.payload.kind === 'override-removed') activeOverrides.delete(e.payload.patchId);
    else if (e.payload.kind === 'tag-removed') activeTags.delete(e.payload.patchId);
    // 'overlay-created' beyond index 0 is ignored (chain corruption); RP3 says
    // we never fabricate state.
  }

  // Resolve patches. RP3: if a patch id is missing from the store, it is silently
  // dropped from the reconstructed state; we never synthesize content.
  const comments: OverlayCommentPatch[] = [];
  for (const id of activeComments.keys()) {
    const patch = patchesStore.getById(id);
    if (patch !== null && patch.kind === 'comment') comments.push(patch);
  }
  const overrides: OverlayOverridePatch[] = [];
  for (const id of activeOverrides.keys()) {
    const patch = patchesStore.getById(id);
    if (patch !== null && patch.kind === 'override') overrides.push(patch);
  }
  const tags: OverlayTagPatch[] = [];
  for (const id of activeTags.keys()) {
    const patch = patchesStore.getById(id);
    if (patch !== null && patch.kind === 'tag') tags.push(patch);
  }

  return {
    id: overlayId,
    renderedAnalysisId,
    renderVersion,
    createdAt,
    comments,
    overrides,
    tags,
  };
}

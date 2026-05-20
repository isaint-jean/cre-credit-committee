// Tests for the replay engine (Phase 2 v2 - post-7.2).
//
//   npm run test:replay-overlays
//
// Verifies:
//   - rebuildAuditChain reconstructs chain order from previousEventId links
//   - replayOverlays produces correct effective state from add/remove events
//   - RP1 pure read: stores are not mutated by replay
//   - RP2 deterministic: identical store state -> identical replay output
//   - RP3 no synthesis: missing patches drop silently; broken chains return
//     reachable fragment only
//   - RP4 chain ordering: previousEventId is canonical (not occurred_at)
//   - Multi-overlay replay: separate overlays produce separate EditableOverlay results

import {
  RENDER_VERSION,
} from '@cre/contracts';
import type {
  AuditEvent,
  AuditEventId,
  AuditPatchAddedPayload,
  AuditPatchRemovedPayload,
  DoctrineEvaluationId,
  OverlayCommentPatch,
  OverlayId,
  OverlayPatchId,
  OverlayTagPatch,
  RenderedAnalysisId,
} from '@cre/contracts';
import {
  computeAuditEventId,
  computeOverlayPatchId,
} from '../util/content-hash.js';
import { OverlayPatchesStore } from '../storage/overlay-patches-store.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import {
  rebuildAuditChain,
  replayOverlays,
} from '../services/replay-overlays.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

const ROOT_ID = 'a'.repeat(64) as DoctrineEvaluationId;
const RENDERED_ID = 'b'.repeat(64) as RenderedAnalysisId;
const OVERLAY_A = 'overlay-A' as OverlayId;
const OVERLAY_B = 'overlay-B' as OverlayId;

/* --------------------------- helper builders ------------------------------ */

function makeOverlayCreated(
  overlayId: OverlayId,
  occurredAt: string,
  author = 'analyst-1',
): AuditEvent {
  const body = {
    previousEventId: null,
    overlayId,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: RENDERED_ID,
      renderVersion: RENDER_VERSION,
    },
    author,
    occurredAt,
  };
  return { id: computeAuditEventId(body), ...body };
}

function makeAddEvent(
  overlayId: OverlayId,
  prev: AuditEvent,
  patchId: OverlayPatchId,
  kind: 'comment-added' | 'override-added' | 'tag-added',
  occurredAt: string,
  summary = 'added',
): AuditEvent {
  const payload: AuditPatchAddedPayload = { kind, patchId, summary };
  const body = {
    previousEventId: prev.id,
    overlayId,
    kind,
    payload,
    author: 'analyst-1',
    occurredAt,
  };
  return { id: computeAuditEventId(body), ...body };
}

function makeRemoveEvent(
  overlayId: OverlayId,
  prev: AuditEvent,
  patchId: OverlayPatchId,
  kind: 'comment-removed' | 'override-removed' | 'tag-removed',
  occurredAt: string,
): AuditEvent {
  const payload: AuditPatchRemovedPayload = { kind, patchId, summary: 'removed' };
  const body = {
    previousEventId: prev.id,
    overlayId,
    kind,
    payload,
    author: 'analyst-1',
    occurredAt,
  };
  return { id: computeAuditEventId(body), ...body };
}

function makeCommentPatch(text: string): OverlayCommentPatch {
  const body = {
    kind: 'comment' as const,
    path: 'metrics.dscr',
    text,
    author: 'analyst-1',
    createdAt: '2026-05-08T00:00:00Z',
  };
  return { id: computeOverlayPatchId(body), ...body };
}

function makeTagPatch(tag: string): OverlayTagPatch {
  const body = {
    kind: 'tag' as const,
    path: '',
    tag,
    author: 'analyst-1',
    createdAt: '2026-05-08T00:00:00Z',
  };
  return { id: computeOverlayPatchId(body), ...body };
}

/* ----------------------- rebuildAuditChain ------------------------------- */

console.log('rebuildAuditChain: chain reconstruction from previousEventId links');
{
  const audit = new AuditEventsStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  // Build a 3-event chain
  const e1 = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const p1 = makeCommentPatch('first');
  const e2 = makeAddEvent(OVERLAY_A, e1, p1.id, 'comment-added', '2026-05-08T01:00:00Z');
  const p2 = makeCommentPatch('second');
  const e3 = makeAddEvent(OVERLAY_A, e2, p2.id, 'comment-added', '2026-05-08T02:00:00Z');

  // Insert in random order to verify chain (not insert order) drives result
  audit.insert(e3, ctx);
  audit.insert(e1, ctx);
  audit.insert(e2, ctx);

  const chains = rebuildAuditChain(ROOT_ID, audit);
  assertEqual(chains.size, 1, 'one overlay reconstructed');
  const chain = chains.get(OVERLAY_A);
  assert(chain !== undefined, 'chain for OVERLAY_A present');
  if (chain) {
    assertEqual(chain.length, 3, 'chain has 3 events');
    assertEqual(chain[0]?.id, e1.id, 'chain[0] === e1 (root)');
    assertEqual(chain[1]?.id, e2.id, 'chain[1] === e2');
    assertEqual(chain[2]?.id, e3.id, 'chain[2] === e3');
  }

  audit.close();
}

console.log('\nrebuildAuditChain: separate chains per overlay');
{
  const audit = new AuditEventsStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const a1 = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const b1 = makeOverlayCreated(OVERLAY_B, '2026-05-08T00:00:01Z');
  audit.insert(a1, ctx);
  audit.insert(b1, ctx);

  const chains = rebuildAuditChain(ROOT_ID, audit);
  assertEqual(chains.size, 2, 'two overlays reconstructed');
  assert(chains.get(OVERLAY_A)?.length === 1, 'OVERLAY_A chain length 1');
  assert(chains.get(OVERLAY_B)?.length === 1, 'OVERLAY_B chain length 1');

  audit.close();
}

console.log('\nrebuildAuditChain: broken chain returns reachable fragment only (RP4)');
{
  const audit = new AuditEventsStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  // e1 is root. e2 chains from e1. e3 chains from a phantom non-existent event.
  // Reachable fragment = [e1, e2]; e3 is orphaned (not in chain).
  const e1 = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const p1 = makeCommentPatch('first');
  const e2 = makeAddEvent(OVERLAY_A, e1, p1.id, 'comment-added', '2026-05-08T01:00:00Z');

  // Build e3 with a previousEventId that doesn't exist
  const phantom = computeAuditEventId({ phantom: true }) as AuditEventId;
  const p2 = makeCommentPatch('orphan');
  const e3body = {
    previousEventId: phantom,
    overlayId: OVERLAY_A,
    kind: 'comment-added' as const,
    payload: { kind: 'comment-added' as const, patchId: p2.id, summary: 'orphan' } satisfies AuditPatchAddedPayload,
    author: 'analyst-1',
    occurredAt: '2026-05-08T02:00:00Z',
  };
  const e3: AuditEvent = { id: computeAuditEventId(e3body), ...e3body };

  audit.insert(e1, ctx);
  audit.insert(e2, ctx);
  audit.insert(e3, ctx);

  const chains = rebuildAuditChain(ROOT_ID, audit);
  const chain = chains.get(OVERLAY_A);
  assert(chain !== undefined, 'chain present');
  if (chain) {
    assertEqual(chain.length, 2, 'reachable fragment is [e1, e2]; e3 dropped');
    assertEqual(chain[0]?.id, e1.id, 'fragment[0] === e1');
    assertEqual(chain[1]?.id, e2.id, 'fragment[1] === e2');
  }

  audit.close();
}

/* ------------------------- replayOverlays -------------------------------- */

console.log('\nreplayOverlays: simple chain (created + 1 comment-added)');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };
  const patchCtx = { overlayId: OVERLAY_A, rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const created = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const p1 = makeCommentPatch('hello');
  const e2 = makeAddEvent(OVERLAY_A, created, p1.id, 'comment-added', '2026-05-08T01:00:00Z');

  audit.insert(created, ctx);
  audit.insert(e2, ctx);
  patches.insert(p1, patchCtx);

  const overlays = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  assertEqual(overlays.length, 1, 'one overlay replayed');
  const o = overlays[0];
  assert(o !== undefined, 'overlay present');
  if (o) {
    assertEqual(o.id, OVERLAY_A, 'overlay.id matches');
    assertEqual(o.renderedAnalysisId, RENDERED_ID, 'renderedAnalysisId from create event');
    assertEqual(o.renderVersion, RENDER_VERSION, 'renderVersion from create event');
    assertEqual(o.createdAt, '2026-05-08T00:00:00Z', 'createdAt from create event occurredAt');
    assertEqual(o.comments.length, 1, '1 comment in effective state');
    assertEqual(o.overrides.length, 0, '0 overrides');
    assertEqual(o.tags.length, 0, '0 tags');
    if (o.comments[0]) {
      assertEqual(o.comments[0].id, p1.id, 'comment id matches');
      assertEqual(o.comments[0].text, 'hello', 'comment text from patch store');
    }
  }

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: add then remove returns empty effective state');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };
  const patchCtx = { overlayId: OVERLAY_A, rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const created = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const p1 = makeCommentPatch('to-be-removed');
  const e2 = makeAddEvent(OVERLAY_A, created, p1.id, 'comment-added', '2026-05-08T01:00:00Z');
  const e3 = makeRemoveEvent(OVERLAY_A, e2, p1.id, 'comment-removed', '2026-05-08T02:00:00Z');

  audit.insert(created, ctx);
  audit.insert(e2, ctx);
  audit.insert(e3, ctx);
  patches.insert(p1, patchCtx);

  const overlays = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  const o = overlays[0];
  if (o) {
    assertEqual(o.comments.length, 0, 'comment removed -> empty effective state');
  }

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: mixed add/remove across kinds');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };
  const patchCtx = { overlayId: OVERLAY_A, rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const created = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const c1 = makeCommentPatch('alpha');
  const c2 = makeCommentPatch('beta');
  const t1 = makeTagPatch('reviewed');
  const t2 = makeTagPatch('to-remove');

  let prev: AuditEvent = created;
  const e1 = makeAddEvent(OVERLAY_A, prev, c1.id, 'comment-added', '2026-05-08T01:00:00Z'); prev = e1;
  const e2 = makeAddEvent(OVERLAY_A, prev, c2.id, 'comment-added', '2026-05-08T02:00:00Z'); prev = e2;
  const e3 = makeAddEvent(OVERLAY_A, prev, t1.id, 'tag-added',     '2026-05-08T03:00:00Z'); prev = e3;
  const e4 = makeAddEvent(OVERLAY_A, prev, t2.id, 'tag-added',     '2026-05-08T04:00:00Z'); prev = e4;
  const e5 = makeRemoveEvent(OVERLAY_A, prev, t2.id, 'tag-removed','2026-05-08T05:00:00Z'); prev = e5;

  for (const e of [created, e1, e2, e3, e4, e5]) audit.insert(e, ctx);
  for (const p of [c1, c2, t1, t2]) patches.insert(p, patchCtx);

  const overlays = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  const o = overlays[0];
  if (o) {
    assertEqual(o.comments.length, 2, '2 comments in effective state');
    assertEqual(o.tags.length, 1, '1 tag (one was added then removed)');
    if (o.tags[0]) assertEqual(o.tags[0].tag, 'reviewed', 'remaining tag is "reviewed"');
  }

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: missing patch drops silently (RP3 no synthesis)');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  // Audit log says a patch was added, but the patch is not in the store
  const created = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const orphanPatchId = computeOverlayPatchId({ orphan: true });
  const e2 = makeAddEvent(OVERLAY_A, created, orphanPatchId, 'comment-added', '2026-05-08T01:00:00Z');

  audit.insert(created, ctx);
  audit.insert(e2, ctx);

  const overlays = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  const o = overlays[0];
  if (o) {
    // The audit log claims a patch was added, but the patch is not in the store.
    // Per RP3, replay does not synthesize. The effective state has 0 comments.
    assertEqual(o.comments.length, 0, 'orphaned patch reference drops silently');
  }

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: deterministic across runs (RP2)');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };
  const patchCtx = { overlayId: OVERLAY_A, rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const created = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const p1 = makeCommentPatch('det-1');
  const e2 = makeAddEvent(OVERLAY_A, created, p1.id, 'comment-added', '2026-05-08T01:00:00Z');
  audit.insert(created, ctx);
  audit.insert(e2, ctx);
  patches.insert(p1, patchCtx);

  const a = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  const b = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'replay is deterministic across runs');

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: multi-overlay scenario');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  // Two overlays anchored to the same (rootId, renderVersion)
  const aCreated = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const bCreated = makeOverlayCreated(OVERLAY_B, '2026-05-08T00:00:01Z');

  const cA = makeCommentPatch('A-comment');
  const cB = makeTagPatch('B-tag');

  const eA = makeAddEvent(OVERLAY_A, aCreated, cA.id, 'comment-added', '2026-05-08T01:00:00Z');
  const eB = makeAddEvent(OVERLAY_B, bCreated, cB.id, 'tag-added',     '2026-05-08T02:00:00Z');

  audit.insert(aCreated, ctx);
  audit.insert(bCreated, ctx);
  audit.insert(eA, ctx);
  audit.insert(eB, ctx);
  patches.insert(cA, { overlayId: OVERLAY_A, rootId: ROOT_ID, renderVersion: RENDER_VERSION });
  patches.insert(cB, { overlayId: OVERLAY_B, rootId: ROOT_ID, renderVersion: RENDER_VERSION });

  const overlays = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  assertEqual(overlays.length, 2, '2 overlays replayed');

  const oA = overlays.find((o) => o.id === OVERLAY_A);
  const oB = overlays.find((o) => o.id === OVERLAY_B);
  if (oA) assertEqual(oA.comments.length, 1, 'OVERLAY_A has 1 comment');
  if (oA) assertEqual(oA.tags.length, 0, 'OVERLAY_A has 0 tags');
  if (oB) assertEqual(oB.comments.length, 0, 'OVERLAY_B has 0 comments');
  if (oB) assertEqual(oB.tags.length, 1, 'OVERLAY_B has 1 tag');

  // Stable ordering: by createdAt then id
  assertEqual(overlays[0]?.id, OVERLAY_A, 'overlays[0] is OVERLAY_A (earlier createdAt)');

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: pure read - stores are not mutated (RP1)');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };
  const patchCtx = { overlayId: OVERLAY_A, rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const created = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const p1 = makeCommentPatch('rp1-test');
  const e2 = makeAddEvent(OVERLAY_A, created, p1.id, 'comment-added', '2026-05-08T01:00:00Z');
  audit.insert(created, ctx);
  audit.insert(e2, ctx);
  patches.insert(p1, patchCtx);

  // Snapshot row counts before replay
  const eventsBefore = audit.getByRoot(ROOT_ID).length;
  const patchesBefore = patches.getByRoot(ROOT_ID).length;

  // Run replay multiple times
  for (let i = 0; i < 5; i++) {
    replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
    rebuildAuditChain(ROOT_ID, audit);
  }

  // Row counts must not have changed
  assertEqual(audit.getByRoot(ROOT_ID).length, eventsBefore, 'audit store unchanged after replay');
  assertEqual(patches.getByRoot(ROOT_ID).length, patchesBefore, 'patches store unchanged after replay');

  audit.close();
  patches.close();
}

console.log('\nreplayOverlays: filter by render version');
{
  const audit = new AuditEventsStore(':memory:');
  const patches = new OverlayPatchesStore(':memory:');

  // Two overlays at different render versions
  const created1 = makeOverlayCreated(OVERLAY_A, '2026-05-08T00:00:00Z');
  const created2body = {
    previousEventId: null,
    overlayId: OVERLAY_B,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: 'c'.repeat(64) as RenderedAnalysisId,
      renderVersion: '99.99' as never,
    },
    author: 'analyst-1',
    occurredAt: '2026-05-08T00:00:01Z',
  };
  const created2: AuditEvent = { id: computeAuditEventId(created2body), ...created2body };

  audit.insert(created1, { rootId: ROOT_ID, renderVersion: RENDER_VERSION });
  audit.insert(created2, { rootId: ROOT_ID, renderVersion: '99.99' as never });

  const atCurrent = replayOverlays(ROOT_ID, RENDER_VERSION, audit, patches);
  const atOther = replayOverlays(ROOT_ID, '99.99' as never, audit, patches);
  assertEqual(atCurrent.length, 1, 'only OVERLAY_A at current render version');
  assertEqual(atCurrent[0]?.id, OVERLAY_A, 'returns OVERLAY_A');
  assertEqual(atOther.length, 1, 'only OVERLAY_B at version 99.99');
  assertEqual(atOther[0]?.id, OVERLAY_B, 'returns OVERLAY_B');

  audit.close();
  patches.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

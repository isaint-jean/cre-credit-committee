// Tests for the three edit-surface append-only stores (Phase 2 v2).
//
//   npm run test:edit-surface-stores
//
// Verifies:
//   - Append-only insert / get round-trip for each store
//   - Idempotent insert (same id -> no-op on conflict)
//   - Content-hash mismatch detection (RecordIdMismatchError on tampered body)
//   - Indexed retrieval by id, by overlay/root, by render version (where applicable)
//   - Pure I/O: no business logic introduced - storage stores what it's given,
//     returns what was stored
//   - No update or delete methods exposed (structural append-only)

import {
  RENDER_VERSION,
} from '@cre/contracts';
import type {
  AuditEvent,
  AuditPatchAddedPayload,
  CommitteeSnapshot,
  CommitteeSnapshotId,
  DoctrineEvaluationId,
  EditableOverlay,
  ExportContext,
  OverlayCommentPatch,
  OverlayId,
  OverlayPatchId,
  RenderedAnalysis,
  RenderedAnalysisId,
} from '@cre/contracts';
import {
  computeAuditEventId,
  computeOverlayPatchId,
  computeRenderedAnalysisId,
} from '../util/content-hash.js';
import { OverlayPatchesStore } from '../storage/overlay-patches-store.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { CommitteeSnapshotsStore } from '../storage/committee-snapshots-store.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import { buildCommitteeSnapshot } from '../services/build-committee-snapshot.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}
function assertThrowsInstance<E extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => E,
  m: string,
): void {
  try { fn(); fail(m + ' (did not throw)'); }
  catch (e) {
    if (e instanceof ctor) ok(m);
    else fail(m + ' (threw ' + (e as Error)?.name + ')');
  }
}

const NOW = '2026-05-08T00:00:00Z';
const ROOT_ID = 'a'.repeat(64) as DoctrineEvaluationId;
const RENDERED_ID = 'b'.repeat(64) as RenderedAnalysisId;
const OVERLAY_ID = 'overlay-1' as OverlayId;
const OTHER_OVERLAY = 'overlay-2' as OverlayId;

/* ----------------------------- patch fixtures ----------------------------- */

function makeCommentPatch(text: string, author: string = 'analyst-1'): OverlayCommentPatch {
  const body = {
    kind: 'comment' as const,
    path: 'metrics.dscr',
    text,
    author,
    createdAt: NOW,
  };
  return { id: computeOverlayPatchId(body), ...body };
}

/* ----------------------------- audit fixtures ----------------------------- */

function makePatchAddedEvent(
  overlayId: OverlayId,
  patchId: OverlayPatchId,
  prev: AuditEvent | null,
  occurredAt: string = NOW,
): AuditEvent {
  const payload: AuditPatchAddedPayload = {
    kind: 'comment-added',
    patchId,
    summary: 'comment added',
  };
  const body = {
    previousEventId: prev === null ? null : prev.id,
    overlayId,
    kind: 'comment-added' as const,
    payload,
    author: 'analyst-1',
    occurredAt,
  };
  return { id: computeAuditEventId(body), ...body };
}

/* --------------------------- snapshot fixtures ---------------------------- */

function makeMinimalRendered(): RenderedAnalysis {
  // We don't run the real pipeline here - the stores accept any contract-shaped
  // record. Construct a minimal-but-valid RenderedAnalysis. Identity is computed
  // from body so the store's verify check passes.
  const body: Omit<RenderedAnalysis, 'id'> = {
    rootId: ROOT_ID,
    summary: {
      ratingBand: { value: 'Acceptable' as const, displayValue: 'Acceptable' },
      finalScore: { value: 50, displayValue: '50' },
    },
    metrics: {
      dscr: { value: null, displayValue: '-' },
      ltv: { value: null, displayValue: '-' },
      debtYield: { value: null, displayValue: '-' },
      noi: { value: null, displayValue: '-' },
    },
    valuation: {
      finalValue: { value: null, displayValue: '-' },
      anchorUsed: { value: 'none' as const, displayValue: 'none' },
    },
    doctrine: {
      mechanicalScore: { value: 50, displayValue: '50' },
      weightedAggregate: { value: 50, displayValue: '50' },
      flags: [],
      components: [],
    },
    dataQuality: { flags: [] },
    incomeLines: [],
    expenseLines: [],
    loan: {
      loanAmount: {
        name: 'loanAmount',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      interestRate: {
        name: 'interestRate',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      termMonths: {
        name: 'termMonths',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      amortizationMonths: {
        name: 'amortizationMonths',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      ioPeriodMonths: {
        name: 'ioPeriodMonths',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      maturityBalance: {
        name: 'maturityBalance',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      debtServiceAnnual: {
        name: 'debtServiceAnnual',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
    },
    assumptions: {
      capRate: {
        name: 'capRate',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      terminalCapRate: {
        name: 'terminalCapRate',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      rentGrowthPct: {
        name: 'rentGrowthPct',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
      expenseGrowthPct: {
        name: 'expenseGrowthPct',
        raw: { value: null, displayValue: '-' },
        adjusted: { value: 0, displayValue: '0' },
        source: 'BANK',
        adjustments: [],
      },
    },
    stress: { method: 'DEFAULT', scenarios: [] },
    findings: [],
    metadata: { hashedAt: NOW, renderVersion: RENDER_VERSION },
  };
  // The contract requires id; recompute it from body via the same content-hash
  // pathway the renderer uses. Since this fixture is for storage testing, we
  // synthesize the id directly.
  return { id: computeRenderedAnalysisId(body), ...body } as RenderedAnalysis;
}

function makeMinimalOverlay(): EditableOverlay {
  return {
    id: OVERLAY_ID,
    renderedAnalysisId: RENDERED_ID,
    renderVersion: RENDER_VERSION,
    createdAt: NOW,
    comments: [],
    overrides: [],
    tags: [],
  };
}

function makeExportContext(purpose: string = 'committee-test'): ExportContext {
  return { exportedBy: 'analyst-1', exportedAt: NOW, purpose };
}

function makeSnapshot(rendered: RenderedAnalysis, overlay: EditableOverlay | null, ctx: ExportContext): CommitteeSnapshot {
  return buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay, exportContext: ctx });
}

/* ------------------------------ OverlayPatchesStore ----------------------- */

console.log('OverlayPatchesStore: round-trip and indexed retrieval');
{
  const store = new OverlayPatchesStore(':memory:');
  const ctx = { overlayId: OVERLAY_ID, rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  const p1 = makeCommentPatch('first comment');
  const r1 = store.insert(p1, ctx);
  ok('insert returns inserted=true on first insert');
  assert(r1.inserted, 'first insert reports inserted=true');

  // Idempotent re-insert
  const r2 = store.insert(p1, ctx);
  assert(!r2.inserted, 'second insert of same id reports inserted=false');

  // get by id
  const fetched = store.getById(p1.id);
  assert(fetched !== null, 'getById returns row for known id');
  assertEqual(fetched?.id, p1.id, 'fetched.id matches');
  if (fetched && fetched.kind === 'comment') {
    assertEqual(fetched.text, 'first comment', 'fetched text matches');
  }

  const missing = store.getById('z'.repeat(64) as never);
  assertEqual(missing, null, 'getById returns null for unknown id');

  // get by overlay
  const p2 = makeCommentPatch('second comment');
  store.insert(p2, ctx);
  const byOverlay = store.getByOverlay(OVERLAY_ID);
  assertEqual(byOverlay.length, 2, 'getByOverlay returns 2 patches for OVERLAY_ID');

  // Patch under a different overlay
  const p3 = makeCommentPatch('third comment');
  store.insert(p3, { ...ctx, overlayId: OTHER_OVERLAY });
  const byOther = store.getByOverlay(OTHER_OVERLAY);
  assertEqual(byOther.length, 1, 'getByOverlay scopes to the correct overlay');
  assertEqual(store.getByOverlay(OVERLAY_ID).length, 2, 'OVERLAY_ID still has 2 (no cross-bleed)');

  // get by root
  assertEqual(store.getByRoot(ROOT_ID).length, 3, 'getByRoot returns all 3 across overlays');
  // get by root + version
  assertEqual(store.getByRootAndVersion(ROOT_ID, RENDER_VERSION).length, 3,
    'getByRootAndVersion returns all 3');
  assertEqual(store.getByRootAndVersion(ROOT_ID, '99.99' as never).length, 0,
    'getByRootAndVersion filters by version');

  store.close();
}

console.log('\nOverlayPatchesStore: content-hash mismatch detection');
{
  const store = new OverlayPatchesStore(':memory:');
  const p = makeCommentPatch('original');
  // Tamper with text without recomputing id
  const tampered = { ...p, text: 'tampered' } as OverlayCommentPatch;
  assertThrowsInstance(
    () => store.insert(tampered, { overlayId: OVERLAY_ID, rootId: ROOT_ID, renderVersion: RENDER_VERSION }),
    RecordIdMismatchError,
    'insert with tampered patch body throws RecordIdMismatchError',
  );
  store.close();
}

console.log('\nOverlayPatchesStore: append-only API surface (no update/delete methods)');
{
  const store = new OverlayPatchesStore(':memory:');
  const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
  const methods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  assert(!methods.includes('update'), 'no update method on store');
  assert(!methods.includes('delete'), 'no delete method on store');
  assert(!methods.includes('remove'), 'no remove method on store');
  assert(methods.includes('insert'), 'insert method exists');
  assert(methods.includes('getById'), 'getById method exists');
  store.close();
}

/* ------------------------------ AuditEventsStore -------------------------- */

console.log('\nAuditEventsStore: round-trip and chain retrieval');
{
  const store = new AuditEventsStore(':memory:');
  const ctx = { rootId: ROOT_ID, renderVersion: RENDER_VERSION };

  // Build a 3-event chain: created -> patch-added -> patch-added
  const createdBody = {
    previousEventId: null,
    overlayId: OVERLAY_ID,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: RENDERED_ID,
      renderVersion: RENDER_VERSION,
    },
    author: 'analyst-1',
    occurredAt: NOW,
  };
  const created: AuditEvent = { id: computeAuditEventId(createdBody), ...createdBody };
  store.insert(created, ctx);

  const patchId1 = computeOverlayPatchId({ k: 1 });
  const e2 = makePatchAddedEvent(OVERLAY_ID, patchId1, created, '2026-05-08T01:00:00Z');
  store.insert(e2, ctx);

  const patchId2 = computeOverlayPatchId({ k: 2 });
  const e3 = makePatchAddedEvent(OVERLAY_ID, patchId2, e2, '2026-05-08T02:00:00Z');
  store.insert(e3, ctx);

  // get by id
  const fetched = store.getById(e3.id);
  assert(fetched !== null, 'getById returns row');
  assertEqual(fetched?.previousEventId, e2.id, 'fetched.previousEventId chain link');

  // get by overlay
  assertEqual(store.getByOverlay(OVERLAY_ID).length, 3, 'getByOverlay returns 3 events');

  // get by root + version
  assertEqual(store.getByRootAndVersion(ROOT_ID, RENDER_VERSION).length, 3,
    'getByRootAndVersion returns 3');

  // get by root (across versions)
  assertEqual(store.getByRoot(ROOT_ID).length, 3, 'getByRoot returns 3');

  // distinct overlay ids
  const overlayIds = store.getOverlayIdsByRootAndVersion(ROOT_ID, RENDER_VERSION);
  assertEqual(overlayIds.length, 1, 'getOverlayIdsByRootAndVersion returns 1 unique overlay');
  assertEqual(overlayIds[0], OVERLAY_ID, 'overlay id matches');

  // Idempotent insert
  const dup = store.insert(e3, ctx);
  assert(!dup.inserted, 'duplicate insert returns inserted=false');

  store.close();
}

console.log('\nAuditEventsStore: content-hash mismatch detection');
{
  const store = new AuditEventsStore(':memory:');
  const body = {
    previousEventId: null,
    overlayId: OVERLAY_ID,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: RENDERED_ID,
      renderVersion: RENDER_VERSION,
    },
    author: 'analyst-1',
    occurredAt: NOW,
  };
  const evt: AuditEvent = { id: computeAuditEventId(body), ...body };
  // Tamper with author without recomputing id
  const tampered = { ...evt, author: 'someone-else' };
  assertThrowsInstance(
    () => store.insert(tampered as AuditEvent, { rootId: ROOT_ID, renderVersion: RENDER_VERSION }),
    RecordIdMismatchError,
    'insert with tampered audit event throws RecordIdMismatchError',
  );
  store.close();
}

console.log('\nAuditEventsStore: append-only API surface');
{
  const store = new AuditEventsStore(':memory:');
  const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
  const methods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  assert(!methods.includes('update'), 'no update method');
  assert(!methods.includes('delete'), 'no delete method');
  assert(!methods.includes('remove'), 'no remove method');
  store.close();
}

/* --------------------------- CommitteeSnapshotsStore ----------------------- */

console.log('\nCommitteeSnapshotsStore: round-trip and indexed retrieval');
{
  const store = new CommitteeSnapshotsStore(':memory:');
  const rendered = makeMinimalRendered();
  const overlay = makeMinimalOverlay();
  const snap = makeSnapshot(rendered, overlay, makeExportContext());

  const r1 = store.insert(snap);
  assert(r1.inserted, 'first insert returns inserted=true');

  const fetched = store.getById(snap.id);
  assert(fetched !== null, 'getById returns the snapshot');
  assertEqual(fetched?.id, snap.id, 'fetched.id matches');

  // get by rendered analysis
  const byRendered = store.getByRenderedAnalysis(snap.renderedAnalysisId);
  assertEqual(byRendered.length, 1, 'getByRenderedAnalysis returns 1');

  // get by overlay
  if (snap.overlayId !== null) {
    const byOverlay = store.getByOverlay(snap.overlayId);
    assertEqual(byOverlay.length, 1, 'getByOverlay returns 1');
  }

  // Idempotent insert
  const r2 = store.insert(snap);
  assert(!r2.inserted, 'duplicate insert returns inserted=false');

  // Different exportContext -> different id -> separate row
  const snap2 = makeSnapshot(rendered, overlay, makeExportContext('committee-test-2'));
  assert(snap2.id !== snap.id, 'different exportContext -> different snapshot id');
  store.insert(snap2);
  const byRenderedAfter = store.getByRenderedAnalysis(snap.renderedAnalysisId);
  assertEqual(byRenderedAfter.length, 2, 'getByRenderedAnalysis now returns 2');

  // Snapshot without overlay
  const snap3 = makeSnapshot(rendered, null, makeExportContext('no-overlay'));
  store.insert(snap3);
  assertEqual(snap3.overlayId, null, 'snap3.overlayId is null');
  const fetched3 = store.getById(snap3.id);
  assertEqual(fetched3?.overlayId, null, 'fetched snapshot preserves null overlayId');

  // Unknown id -> null
  const missing = store.getById('z'.repeat(64) as CommitteeSnapshotId);
  assertEqual(missing, null, 'getById returns null for unknown id');

  store.close();
}

console.log('\nCommitteeSnapshotsStore: content-hash mismatch detection');
{
  const store = new CommitteeSnapshotsStore(':memory:');
  const rendered = makeMinimalRendered();
  const snap = makeSnapshot(rendered, null, makeExportContext('tamper-test'));
  // Tamper with exportContext without recomputing id
  const tampered: CommitteeSnapshot = {
    ...snap,
    exportContext: { ...snap.exportContext, purpose: 'TAMPERED' },
  };
  assertThrowsInstance(
    () => store.insert(tampered),
    RecordIdMismatchError,
    'tampered snapshot throws RecordIdMismatchError',
  );
  store.close();
}

console.log('\nCommitteeSnapshotsStore: append-only API surface');
{
  const store = new CommitteeSnapshotsStore(':memory:');
  const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
  const methods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  assert(!methods.includes('update'), 'no update method');
  assert(!methods.includes('delete'), 'no delete method');
  store.close();
}

/* --------------------------------- summary -------------------------------- */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

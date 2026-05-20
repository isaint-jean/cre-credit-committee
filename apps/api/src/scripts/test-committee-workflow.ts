// Tests for Phase 3 committee workflow layer.
//
//   npm run test:committee-workflow
//
// Covers:
//   - CommitteeActionsStore: round-trip, append-only, content-hash mismatch detection,
//     indexed retrieval
//   - computeDealWorkflowState: lifecycle derivation rules across all DealStates,
//     OVERRIDE_DECISION skip-back behavior, broken-chain fragment policy,
//     activeParticipants determinism
//   - buildCommitteeTimeline: chronological merge across all 3 sources, deterministic
//     tie-breaking by refId, snapshot inclusion via renderedAnalysisId resolution
//   - Hard constraints: no store mutation by either projection function

import {
  RENDER_VERSION,
} from '@cre/contracts';
import type {
  AuditEvent,
  AuditPatchAddedPayload,
  CommitteeActionEvent,
  CommitteeActionId,
  CommitteeActionKind,
  CommitteeSnapshot,
  CommitteeSnapshotId,
  DealState,
  DoctrineEvaluationId,
  ExportContext,
  OverlayId,
  RenderedAnalysis,
  RenderedAnalysisId,
} from '@cre/contracts';
import {
  computeAuditEventId,
  computeCommitteeActionId,
  computeRenderedAnalysisId,
} from '../util/content-hash.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { CommitteeActionsStore } from '../storage/committee-actions-store.js';
import { CommitteeSnapshotsStore } from '../storage/committee-snapshots-store.js';
import { RecordIdMismatchError } from '../storage/record-graph-store.js';
import { computeDealWorkflowState } from '../services/compute-deal-workflow-state.js';
import { buildCommitteeTimeline } from '../services/build-committee-timeline.js';
import { buildCommitteeSnapshot } from '../services/build-committee-snapshot.js';

const ROOT_ID = 'a'.repeat(64) as DoctrineEvaluationId;
const RENDERED_ID = 'b'.repeat(64) as RenderedAnalysisId;
const OVERLAY_A = 'overlay-A' as OverlayId;
const T0 = '2026-05-08T00:00:00Z';
const T1 = '2026-05-08T01:00:00Z';
const T2 = '2026-05-08T02:00:00Z';
const T3 = '2026-05-08T03:00:00Z';
const T4 = '2026-05-08T04:00:00Z';

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

/* ----------------------------- builders ------------------------------- */

function buildAction(opts: {
  prev: CommitteeActionEvent | null;
  kind: CommitteeActionKind;
  payload: CommitteeActionEvent['payload'];
  author: string;
  occurredAt: string;
  snapshotId?: CommitteeSnapshotId | null;
}): CommitteeActionEvent {
  const body = {
    previousActionId: opts.prev === null ? null : opts.prev.id,
    rootId: ROOT_ID,
    renderedAnalysisId: RENDERED_ID,
    snapshotId: opts.snapshotId ?? null,
    kind: opts.kind,
    payload: opts.payload,
    author: opts.author,
    occurredAt: opts.occurredAt,
  };
  return { id: computeCommitteeActionId(body), ...body };
}

function buildOverlayCreatedEvent(occurredAt: string = T0): AuditEvent {
  const body = {
    previousEventId: null,
    overlayId: OVERLAY_A,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: RENDERED_ID,
      renderVersion: RENDER_VERSION,
    },
    author: 'analyst-1',
    occurredAt,
  };
  return { id: computeAuditEventId(body), ...body };
}

function makeMinimalRendered(): RenderedAnalysis {
  // Mirrors test-edit-surface-stores.ts; minimal valid RenderedAnalysis.
  const body = {
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
      loanAmount: { name: 'loanAmount', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
      interestRate: { name: 'interestRate', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
      termMonths: { name: 'termMonths', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
      amortizationMonths: { name: 'amortizationMonths', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
      ioPeriodMonths: { name: 'ioPeriodMonths', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
      maturityBalance: { name: 'maturityBalance', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
      debtServiceAnnual: { name: 'debtServiceAnnual', raw: { value: null, displayValue: '-' }, adjusted: { value: 0, displayValue: '0' }, source: 'BANK', adjustments: [] },
    },
    stress: { method: 'DEFAULT', scenarios: [] },
    findings: [],
    metadata: { hashedAt: T0, renderVersion: RENDER_VERSION },
  };
  return { id: computeRenderedAnalysisId(body), ...body } as RenderedAnalysis;
}

function makeSnapshot(rendered: RenderedAnalysis, exportedAt: string, purpose: string): CommitteeSnapshot {
  const exportContext: ExportContext = { exportedBy: 'analyst-1', exportedAt, purpose };
  return buildCommitteeSnapshot({ renderedAnalysis: rendered, overlay: null, exportContext });
}

/* --------------------- CommitteeActionsStore tests -------------------- */

console.log('CommitteeActionsStore: round-trip and indexed retrieval');
{
  const store = new CommitteeActionsStore(':memory:');
  const a1 = buildAction({
    prev: null,
    kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'CRE-Q2', summary: 'first submit' },
    author: 'lead-analyst',
    occurredAt: T1,
  });
  const r1 = store.insert(a1);
  assert(r1.inserted, 'first insert returns inserted=true');

  const r2 = store.insert(a1);
  assert(!r2.inserted, 'duplicate insert returns inserted=false');

  const fetched = store.getById(a1.id);
  assert(fetched !== null, 'getById returns row');
  if (fetched) assertEqual(fetched.kind, 'SUBMIT_TO_COMMITTEE', 'fetched.kind matches');

  const byRoot = store.getByRoot(ROOT_ID);
  assertEqual(byRoot.length, 1, 'getByRoot returns 1');
  const byRendered = store.getByRenderedAnalysis(RENDERED_ID);
  assertEqual(byRendered.length, 1, 'getByRenderedAnalysis returns 1');

  store.close();
}

console.log('\nCommitteeActionsStore: content-hash mismatch detection');
{
  const store = new CommitteeActionsStore(':memory:');
  const a = buildAction({
    prev: null,
    kind: 'APPROVE_DEAL',
    payload: { kind: 'APPROVE_DEAL', conditions: [] },
    author: 'cmt-chair',
    occurredAt: T1,
  });
  // Tamper with author without recomputing id
  const tampered = { ...a, author: 'someone-else' };
  assertThrowsInstance(
    () => store.insert(tampered as CommitteeActionEvent),
    RecordIdMismatchError,
    'insert with tampered action body throws RecordIdMismatchError',
  );
  store.close();
}

console.log('\nCommitteeActionsStore: append-only API surface');
{
  const store = new CommitteeActionsStore(':memory:');
  const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
  const methods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  assert(!methods.includes('update'), 'no update method');
  assert(!methods.includes('delete'), 'no delete method');
  assert(!methods.includes('remove'), 'no remove method');
  assert(methods.includes('insert'), 'insert method exists');
  store.close();
}

/* ---------------- computeDealWorkflowState - lifecycle tests --------------- */

console.log('\ncomputeDealWorkflowState: empty stores -> DRAFT');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  const result = computeDealWorkflowState({
    rootId: ROOT_ID,
    committeeActionsStore: actions,
    auditEventsStore: audit,
  });
  assertEqual(result.state, 'DRAFT', 'no events / no overlays -> DRAFT');
  assertEqual(result.activeParticipants.length, 0, 'no participants');
  assertEqual(result.lastActionAt, null, 'no last action');
  assertEqual(result.lastActionId, null, 'no last action id');
  assertEqual(result.lastSnapshotId, null, 'no last snapshot');
  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: overlay-created only -> IN_REVIEW');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  const ev = buildOverlayCreatedEvent(T1);
  audit.insert(ev, { rootId: ROOT_ID, renderVersion: RENDER_VERSION });

  const result = computeDealWorkflowState({
    rootId: ROOT_ID,
    committeeActionsStore: actions,
    auditEventsStore: audit,
  });
  assertEqual(result.state, 'IN_REVIEW', 'overlay exists but no committee action -> IN_REVIEW');
  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: each terminal state derives correctly');
{
  const matrix: ReadonlyArray<{
    kind: CommitteeActionKind;
    payload: CommitteeActionEvent['payload'];
    expected: DealState;
  }> = [
    { kind: 'SUBMIT_TO_COMMITTEE', payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'C', summary: '' }, expected: 'IN_COMMITTEE' },
    { kind: 'REQUEST_MORE_INFO',   payload: { kind: 'REQUEST_MORE_INFO', questions: [] }, expected: 'IN_REVIEW' },
    { kind: 'APPROVE_DEAL',        payload: { kind: 'APPROVE_DEAL', conditions: [] },     expected: 'APPROVED' },
    { kind: 'REJECT_DEAL',         payload: { kind: 'REJECT_DEAL', reasons: [] },         expected: 'REJECTED' },
    { kind: 'POSTPONE_DEAL',       payload: { kind: 'POSTPONE_DEAL', reason: 'r', until: null }, expected: 'POSTPONED' },
  ];
  for (const row of matrix) {
    const actions = new CommitteeActionsStore(':memory:');
    const audit = new AuditEventsStore(':memory:');
    const a = buildAction({ prev: null, kind: row.kind, payload: row.payload, author: 'x', occurredAt: T1 });
    actions.insert(a);
    const result = computeDealWorkflowState({
      rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit,
    });
    assertEqual(result.state, row.expected, row.kind + ' -> ' + row.expected);
    actions.close(); audit.close();
  }
}

console.log('\ncomputeDealWorkflowState: OVERRIDE_DECISION walks back to most recent state-changer');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');

  // SUBMIT (-> IN_COMMITTEE) then OVERRIDE -> still IN_COMMITTEE (chain walk-back)
  const a1 = buildAction({
    prev: null,
    kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'C', summary: '' },
    author: 'a',
    occurredAt: T1,
  });
  const a2 = buildAction({
    prev: a1,
    kind: 'OVERRIDE_DECISION',
    payload: { kind: 'OVERRIDE_DECISION', overlayId: OVERLAY_A, summary: 'analyst override' },
    author: 'b',
    occurredAt: T2,
  });
  actions.insert(a1);
  actions.insert(a2);

  const result = computeDealWorkflowState({
    rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit,
  });
  assertEqual(result.state, 'IN_COMMITTEE', 'OVERRIDE_DECISION after SUBMIT -> IN_COMMITTEE');
  assertEqual(result.lastActionId, a2.id, 'lastActionId is the override (chain head)');
  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: full lifecycle progression');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');

  // Walk: SUBMIT -> REQUEST_MORE_INFO -> SUBMIT -> APPROVE
  const a1 = buildAction({ prev: null, kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'C', summary: '' },
    author: 'lead', occurredAt: T1 });
  const a2 = buildAction({ prev: a1, kind: 'REQUEST_MORE_INFO',
    payload: { kind: 'REQUEST_MORE_INFO', questions: ['q'] },
    author: 'cmt-member-1', occurredAt: T2 });
  const a3 = buildAction({ prev: a2, kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'C', summary: 're-submit' },
    author: 'lead', occurredAt: T3 });
  const a4 = buildAction({ prev: a3, kind: 'APPROVE_DEAL',
    payload: { kind: 'APPROVE_DEAL', conditions: ['ltv-cap'] },
    author: 'cmt-chair', occurredAt: T4 });

  actions.insert(a1); actions.insert(a2); actions.insert(a3); actions.insert(a4);

  const result = computeDealWorkflowState({
    rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit,
  });
  assertEqual(result.state, 'APPROVED', 'final state APPROVED');
  assertEqual(result.lastActionId, a4.id, 'lastActionId is the approve action');
  assertEqual(result.lastActionAt, T4, 'lastActionAt is T4');
  // Active participants - sorted alphabetically
  assertEqual(JSON.stringify(result.activeParticipants),
    JSON.stringify(['cmt-chair', 'cmt-member-1', 'lead']),
    'activeParticipants is sorted alphabetical unique authors');

  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: lastSnapshotId picks most recent action with snapshot');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  const snap1Id = 'd'.repeat(64) as CommitteeSnapshotId;
  const snap2Id = 'e'.repeat(64) as CommitteeSnapshotId;

  const a1 = buildAction({ prev: null, kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'C', summary: '' },
    author: 'a', occurredAt: T1, snapshotId: snap1Id });
  const a2 = buildAction({ prev: a1, kind: 'REQUEST_MORE_INFO',
    payload: { kind: 'REQUEST_MORE_INFO', questions: [] },
    author: 'b', occurredAt: T2 });  // no snapshot
  const a3 = buildAction({ prev: a2, kind: 'APPROVE_DEAL',
    payload: { kind: 'APPROVE_DEAL', conditions: [] },
    author: 'c', occurredAt: T3, snapshotId: snap2Id });

  actions.insert(a1); actions.insert(a2); actions.insert(a3);

  const result = computeDealWorkflowState({
    rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit,
  });
  assertEqual(result.lastSnapshotId, snap2Id, 'lastSnapshotId is the most recent non-null snapshot ref');
  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: deterministic across runs (WP2)');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  const a = buildAction({ prev: null, kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'X', summary: '' },
    author: 'a', occurredAt: T1 });
  actions.insert(a);

  const r1 = computeDealWorkflowState({ rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit });
  const r2 = computeDealWorkflowState({ rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit });
  assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'projection is deterministic');
  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: pure read - stores not mutated (WP1)');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  const a = buildAction({ prev: null, kind: 'APPROVE_DEAL',
    payload: { kind: 'APPROVE_DEAL', conditions: [] },
    author: 'a', occurredAt: T1 });
  actions.insert(a);

  const before = actions.getByRoot(ROOT_ID).length;
  for (let i = 0; i < 5; i++) computeDealWorkflowState({
    rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit,
  });
  const after = actions.getByRoot(ROOT_ID).length;
  assertEqual(after, before, 'committee_actions row count unchanged after 5 projections');

  actions.close(); audit.close();
}

console.log('\ncomputeDealWorkflowState: broken chain returns reachable fragment (WP3)');
{
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');

  const a1 = buildAction({ prev: null, kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'C', summary: '' },
    author: 'a', occurredAt: T1 });
  // a2 references a non-existent prev -> orphan
  const phantom = computeCommitteeActionId({ phantom: true }) as CommitteeActionId;
  const orphanBody = {
    previousActionId: phantom,
    rootId: ROOT_ID,
    renderedAnalysisId: RENDERED_ID,
    snapshotId: null,
    kind: 'APPROVE_DEAL' as const,
    payload: { kind: 'APPROVE_DEAL' as const, conditions: [] } as const,
    author: 'orphan',
    occurredAt: T2,
  };
  const orphan: CommitteeActionEvent = { id: computeCommitteeActionId(orphanBody), ...orphanBody };

  actions.insert(a1);
  actions.insert(orphan);

  const result = computeDealWorkflowState({
    rootId: ROOT_ID, committeeActionsStore: actions, auditEventsStore: audit,
  });
  // Reachable fragment is just [a1]; orphan is dropped. State is IN_COMMITTEE,
  // not APPROVED (because the orphan APPROVE event is unreachable).
  assertEqual(result.state, 'IN_COMMITTEE', 'orphan action ignored; state from reachable fragment');
  assertEqual(result.lastActionId, a1.id, 'lastActionId is chain head, not orphan');

  actions.close(); audit.close();
}

/* --------------------- buildCommitteeTimeline tests ----------------------- */

console.log('\nbuildCommitteeTimeline: chronological merge across all 3 sources');
{
  const audit = new AuditEventsStore(':memory:');
  const actions = new CommitteeActionsStore(':memory:');
  const snapshots = new CommitteeSnapshotsStore(':memory:');

  // The snapshot is keyed by its embedded RenderedAnalysis.id; audit events and
  // committee actions must reference the same renderedAnalysisId for the timeline
  // builder to resolve snapshots via the renderedAnalysis indirection. Use the
  // actual rendered.id from makeMinimalRendered() throughout.
  const rendered = makeMinimalRendered();
  const renderedId = rendered.id;

  // T0 overlay-created (with the matching renderedId)
  const ev1Body = {
    previousEventId: null,
    overlayId: OVERLAY_A,
    kind: 'overlay-created' as const,
    payload: {
      kind: 'overlay-created' as const,
      renderedAnalysisId: renderedId,
      renderVersion: RENDER_VERSION,
    },
    author: 'analyst-1',
    occurredAt: T0,
  };
  const ev1: AuditEvent = { id: computeAuditEventId(ev1Body), ...ev1Body };
  audit.insert(ev1, { rootId: ROOT_ID, renderVersion: RENDER_VERSION });

  // T1 comment-added (audit event)
  const patchId = computeCommitteeActionId({ p: 1 });
  const evCommentBody = {
    previousEventId: ev1.id,
    overlayId: OVERLAY_A,
    kind: 'comment-added' as const,
    payload: { kind: 'comment-added' as const, patchId: patchId as never, summary: 'looks tight' } satisfies AuditPatchAddedPayload,
    author: 'analyst-1',
    occurredAt: T1,
  };
  const ev2: AuditEvent = { id: computeAuditEventId(evCommentBody), ...evCommentBody };
  audit.insert(ev2, { rootId: ROOT_ID, renderVersion: RENDER_VERSION });

  // T2 SUBMIT (committee action; uses the matching renderedId)
  const a1Body = {
    previousActionId: null,
    rootId: ROOT_ID,
    renderedAnalysisId: renderedId,
    snapshotId: null,
    kind: 'SUBMIT_TO_COMMITTEE' as const,
    payload: { kind: 'SUBMIT_TO_COMMITTEE' as const, committeeName: 'CRE-Q2', summary: 'submit' },
    author: 'lead',
    occurredAt: T2,
  };
  const a1: CommitteeActionEvent = { id: computeCommitteeActionId(a1Body), ...a1Body };
  actions.insert(a1);

  // T3 snapshot exported (the snapshot's embedded rendered has id === renderedId)
  const snap = makeSnapshot(rendered, T3, 'committee-q2');
  snapshots.insert(snap);

  // T4 APPROVE (also uses the matching renderedId)
  const a2Body = {
    previousActionId: a1.id,
    rootId: ROOT_ID,
    renderedAnalysisId: renderedId,
    snapshotId: null,
    kind: 'APPROVE_DEAL' as const,
    payload: { kind: 'APPROVE_DEAL' as const, conditions: ['ltv'] },
    author: 'chair',
    occurredAt: T4,
  };
  const a2: CommitteeActionEvent = { id: computeCommitteeActionId(a2Body), ...a2Body };
  actions.insert(a2);

  const timeline = buildCommitteeTimeline({
    rootId: ROOT_ID,
    auditEventsStore: audit,
    committeeActionsStore: actions,
    committeeSnapshotsStore: snapshots,
  });

  // Expected chronological order: ev1 (T0), ev2 (T1), a1 (T2), snap (T3), a2 (T4)
  assertEqual(timeline.entries.length, 5, '5 entries merged');
  assertEqual(timeline.entries[0]?.refId, ev1.id, 'entries[0] is overlay-created');
  assertEqual(timeline.entries[0]?.kind, 'overlay-event', 'entries[0].kind === overlay-event');
  assertEqual(timeline.entries[1]?.refId, ev2.id, 'entries[1] is comment-added');
  assertEqual(timeline.entries[2]?.refId, a1.id, 'entries[2] is committee action SUBMIT');
  assertEqual(timeline.entries[2]?.kind, 'committee-action', 'kind === committee-action');
  assertEqual(timeline.entries[3]?.refId, snap.id, 'entries[3] is snapshot');
  assertEqual(timeline.entries[3]?.kind, 'snapshot-created', 'kind === snapshot-created');
  assertEqual(timeline.entries[4]?.refId, a2.id, 'entries[4] is committee action APPROVE');

  audit.close(); actions.close(); snapshots.close();
}

console.log('\nbuildCommitteeTimeline: deterministic tie-breaking by refId');
{
  const audit = new AuditEventsStore(':memory:');
  const actions = new CommitteeActionsStore(':memory:');
  const snapshots = new CommitteeSnapshotsStore(':memory:');

  // Two committee actions at the same occurredAt - tie broken by refId
  const a1 = buildAction({ prev: null, kind: 'SUBMIT_TO_COMMITTEE',
    payload: { kind: 'SUBMIT_TO_COMMITTEE', committeeName: 'A', summary: '' },
    author: 'x', occurredAt: T1 });
  const a2 = buildAction({ prev: a1, kind: 'OVERRIDE_DECISION',
    payload: { kind: 'OVERRIDE_DECISION', overlayId: OVERLAY_A, summary: 'override' },
    author: 'y', occurredAt: T1 });
  actions.insert(a1); actions.insert(a2);

  const timeline1 = buildCommitteeTimeline({
    rootId: ROOT_ID,
    auditEventsStore: audit,
    committeeActionsStore: actions,
    committeeSnapshotsStore: snapshots,
  });
  const timeline2 = buildCommitteeTimeline({
    rootId: ROOT_ID,
    auditEventsStore: audit,
    committeeActionsStore: actions,
    committeeSnapshotsStore: snapshots,
  });
  assertEqual(JSON.stringify(timeline1), JSON.stringify(timeline2), 'timeline is deterministic across runs');

  // Verify ordering: same timestamp -> lex by refId
  assert(timeline1.entries.length === 2, '2 entries at the same timestamp');
  if (timeline1.entries[0] && timeline1.entries[1]) {
    assert(timeline1.entries[0].refId < timeline1.entries[1].refId,
      'tie-break: entries[0].refId < entries[1].refId');
  }

  audit.close(); actions.close(); snapshots.close();
}

console.log('\nbuildCommitteeTimeline: pure read - stores unchanged (TL1)');
{
  const audit = new AuditEventsStore(':memory:');
  const actions = new CommitteeActionsStore(':memory:');
  const snapshots = new CommitteeSnapshotsStore(':memory:');

  const a = buildAction({ prev: null, kind: 'APPROVE_DEAL',
    payload: { kind: 'APPROVE_DEAL', conditions: [] }, author: 'x', occurredAt: T1 });
  actions.insert(a);

  const beforeAudit = audit.getByRoot(ROOT_ID).length;
  const beforeActions = actions.getByRoot(ROOT_ID).length;

  for (let i = 0; i < 5; i++) {
    buildCommitteeTimeline({
      rootId: ROOT_ID,
      auditEventsStore: audit,
      committeeActionsStore: actions,
      committeeSnapshotsStore: snapshots,
    });
  }
  assertEqual(audit.getByRoot(ROOT_ID).length, beforeAudit, 'audit store unchanged after 5 builds');
  assertEqual(actions.getByRoot(ROOT_ID).length, beforeActions, 'actions store unchanged after 5 builds');

  audit.close(); actions.close(); snapshots.close();
}

console.log('\nbuildCommitteeTimeline: empty stores -> empty timeline');
{
  const audit = new AuditEventsStore(':memory:');
  const actions = new CommitteeActionsStore(':memory:');
  const snapshots = new CommitteeSnapshotsStore(':memory:');

  const tl = buildCommitteeTimeline({
    rootId: ROOT_ID,
    auditEventsStore: audit,
    committeeActionsStore: actions,
    committeeSnapshotsStore: snapshots,
  });
  assertEqual(tl.entries.length, 0, 'no events -> empty timeline');
  assertEqual(tl.rootId, ROOT_ID, 'rootId carried through');

  audit.close(); actions.close(); snapshots.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

/**
 * Chunk 7d — buyer-side visibility of the originator's 7b actions (via the committee
 * timeline labels) + the AWAITING_BUYER decision. All additive/view; no projection change.
 *   - buildCommitteeTimeline labels the 7b kinds descriptively (was the generic default):
 *     SEND_TO_BUYER / ORIGINATOR_PUSHBACK / CALL_REQUESTED. These read the same for every
 *     side, so the BUYER's timeline SEES what the originator did.
 *   - AWAITING_BUYER is NOT a DealState (it would be a dead enum member — no event produces
 *     it). SENT_TO_BUYER carries the "awaiting buyer" meaning; existing states unchanged.
 *
 *   npm run test:role-siloing-chunk7d
 */
import type { CommitteeActionEvent, CommitteeActionKind, DoctrineEvaluationId, RenderedAnalysisId } from '@cre/contracts';
import { DEAL_STATES } from '@cre/contracts';
import { computeCommitteeActionId } from '../util/content-hash.js';
import { CommitteeActionsStore } from '../storage/committee-actions-store.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { CommitteeSnapshotsStore } from '../storage/committee-snapshots-store.js';
import { buildCommitteeTimeline } from '../services/build-committee-timeline.js';

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

const ROOT = 'a'.repeat(64) as DoctrineEvaluationId;
const RENDERED = 'b'.repeat(64) as RenderedAnalysisId;

function payloadFor(kind: CommitteeActionKind): CommitteeActionEvent['payload'] {
  switch (kind) {
    case 'ORIGINATOR_PUSHBACK': return { kind, reason: 'contesting' };
    case 'CALL_REQUESTED':      return { kind, topic: null };
    case 'SEND_TO_BUYER':       return { kind, summary: 'seller uw' };
    case 'APPROVE_DEAL':        return { kind, conditions: [] };
    default: throw new Error('unused kind');
  }
}

/** Insert one committee action and return the timeline entry summary for it. */
function timelineSummary(kind: CommitteeActionKind): string {
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  const snaps = new CommitteeSnapshotsStore(':memory:');
  const body = {
    previousActionId: null, rootId: ROOT, renderedAnalysisId: RENDERED, snapshotId: null,
    kind, payload: payloadFor(kind), author: 'originator@cre.com', occurredAt: '2026-05-08T01:00:00Z',
  };
  const ev = { id: computeCommitteeActionId(body), ...body } as CommitteeActionEvent;
  actions.insert(ev);
  const tl = buildCommitteeTimeline({ rootId: ROOT, auditEventsStore: audit, committeeActionsStore: actions, committeeSnapshotsStore: snaps });
  actions.close(); audit.close(); snaps.close();
  const entry = tl.entries.find((e) => e.kind === 'committee-action');
  return entry?.summary ?? '(no committee-action entry)';
}

console.log('Timeline labels the 7b originator events descriptively (buyer sees them):');
assert(timelineSummary('SEND_TO_BUYER').includes('sent the updated seller UW'), 'SEND_TO_BUYER → "Originator sent the updated seller UW…"');
assert(timelineSummary('ORIGINATOR_PUSHBACK').includes('pushed back'), 'ORIGINATOR_PUSHBACK → "Originator pushed back…"');
assert(timelineSummary('CALL_REQUESTED').includes('requested a call'), 'CALL_REQUESTED → "Originator requested a call…"');
assert(!timelineSummary('SEND_TO_BUYER').includes('Committee action'), 'no longer the generic "Committee action" label');

console.log('\nExisting action labels unchanged (byte-identical):');
assert(timelineSummary('APPROVE_DEAL').startsWith('Deal approved'), 'APPROVE_DEAL label unchanged');

console.log('\nAWAITING_BUYER correctly DEFERRED (no dead enum member):');
assert(!(DEAL_STATES as readonly string[]).includes('AWAITING_BUYER'), 'AWAITING_BUYER is NOT a DealState (no event produces it)');
assert((DEAL_STATES as readonly string[]).includes('SENT_TO_BUYER'), 'SENT_TO_BUYER carries the "awaiting buyer" meaning');

console.log(`\n${failed === 0 ? '✓' : '✗'} role-siloing-chunk7d: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

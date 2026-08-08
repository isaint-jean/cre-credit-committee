/**
 * Chunk 7b — new originator-comms events → new lifecycle states, added ADDITIVELY.
 *   - EXISTING chains project BYTE-IDENTICAL: empty → DRAFT; SUBMIT → IN_COMMITTEE;
 *     REQUEST_MORE_INFO → IN_REVIEW; APPROVE → APPROVED; REJECT → REJECTED;
 *     POSTPONE → POSTPONED. (The 7b events NEVER appear in these chains.)
 *   - NEW events → NEW states: SEND_TO_BUYER → SENT_TO_BUYER; ORIGINATOR_PUSHBACK →
 *     PUSHED_BACK; CALL_REQUESTED → CALL_REQUESTED.
 *   - Interleaving is last-action-wins (the chain is unchanged in shape): a later
 *     committee decision supersedes an originator comms state and vice-versa.
 *
 *   npm run test:role-siloing-chunk7b
 */
import type { CommitteeActionEvent, CommitteeActionKind, DealState, DoctrineEvaluationId, RenderedAnalysisId } from '@cre/contracts';
import { DEAL_STATES } from '@cre/contracts';
import { computeCommitteeActionId } from '../util/content-hash.js';
import { CommitteeActionsStore } from '../storage/committee-actions-store.js';
import { AuditEventsStore } from '../storage/audit-events-store.js';
import { computeDealWorkflowState } from '../services/compute-deal-workflow-state.js';

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

const ROOT = 'a'.repeat(64) as DoctrineEvaluationId;
const RENDERED = 'b'.repeat(64) as RenderedAnalysisId;

function payloadFor(kind: CommitteeActionKind): CommitteeActionEvent['payload'] {
  switch (kind) {
    case 'SUBMIT_TO_COMMITTEE': return { kind, committeeName: 'c', summary: 's' };
    case 'REQUEST_MORE_INFO':   return { kind, questions: ['q'] };
    case 'APPROVE_DEAL':        return { kind, conditions: [] };
    case 'REJECT_DEAL':         return { kind, reasons: ['r'] };
    case 'POSTPONE_DEAL':       return { kind, reason: 'r', until: null };
    case 'ORIGINATOR_PUSHBACK': return { kind, reason: 'push back' };
    case 'CALL_REQUESTED':      return { kind, topic: null };
    case 'SEND_TO_BUYER':       return { kind, summary: 'seller uw' };
    case 'OVERRIDE_DECISION':   throw new Error('override not used in this test');
  }
}

/** Project the workflow state for a chain of committee-action kinds (in order). */
function projectState(kinds: readonly CommitteeActionKind[]): DealState {
  const actions = new CommitteeActionsStore(':memory:');
  const audit = new AuditEventsStore(':memory:');
  let prev: CommitteeActionEvent | null = null;
  let i = 0;
  for (const kind of kinds) {
    const body = {
      previousActionId: prev === null ? null : prev.id,
      rootId: ROOT, renderedAnalysisId: RENDERED, snapshotId: null,
      kind, payload: payloadFor(kind), author: 'actor',
      occurredAt: `2026-05-08T0${i}:00:00Z`,
    };
    const ev = { id: computeCommitteeActionId(body), ...body } as CommitteeActionEvent;
    actions.insert(ev);
    prev = ev;
    i++;
  }
  const ws = computeDealWorkflowState({ rootId: ROOT, committeeActionsStore: actions, auditEventsStore: audit });
  actions.close(); audit.close();
  return ws.state;
}
const st = (kinds: readonly CommitteeActionKind[], want: DealState, m: string) => assert(projectState(kinds) === want, `${m} → ${want}`);

console.log('New states registered in DEAL_STATES:');
for (const s of ['SENT_TO_BUYER', 'PUSHED_BACK', 'CALL_REQUESTED'] as const) {
  assert((DEAL_STATES as readonly string[]).includes(s), `DEAL_STATES includes ${s}`);
}

console.log('\nEXISTING chains BYTE-IDENTICAL (the 7b events never appear here):');
st([], 'DRAFT', 'empty chain');
st(['SUBMIT_TO_COMMITTEE'], 'IN_COMMITTEE', 'SUBMIT_TO_COMMITTEE');
st(['REQUEST_MORE_INFO'], 'IN_REVIEW', 'REQUEST_MORE_INFO');
st(['SUBMIT_TO_COMMITTEE', 'APPROVE_DEAL'], 'APPROVED', 'submit → approve');
st(['SUBMIT_TO_COMMITTEE', 'REJECT_DEAL'], 'REJECTED', 'submit → reject');
st(['SUBMIT_TO_COMMITTEE', 'POSTPONE_DEAL'], 'POSTPONED', 'submit → postpone');

console.log('\nNEW originator-comms events → NEW states:');
st(['SEND_TO_BUYER'], 'SENT_TO_BUYER', 'SEND_TO_BUYER');
st(['ORIGINATOR_PUSHBACK'], 'PUSHED_BACK', 'ORIGINATOR_PUSHBACK');
st(['CALL_REQUESTED'], 'CALL_REQUESTED', 'CALL_REQUESTED');

console.log('\nAdditive interleaving (last state-changing action wins — chain unchanged):');
st(['SUBMIT_TO_COMMITTEE', 'SEND_TO_BUYER'], 'SENT_TO_BUYER', 'committee then send-to-buyer');
st(['SEND_TO_BUYER', 'REJECT_DEAL'], 'REJECTED', 'send-to-buyer then buyer rejects');
st(['SEND_TO_BUYER', 'CALL_REQUESTED'], 'CALL_REQUESTED', 'send then request-call');

console.log(`\n${failed === 0 ? '✓' : '✗'} role-siloing-chunk7b: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

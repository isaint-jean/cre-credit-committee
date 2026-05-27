/**
 * Tests for handleHandbookEvaluationRead (#31 Commit 3).
 *
 * The route handler is thin (envelope lookup → eval lookup → status code).
 * Its store integration is exercised by record-graph-store tests; here we
 * verify the handler's branching logic in isolation with duck-typed mock
 * stores, matching the spec's reference test.
 */
import { handleHandbookEvaluationRead } from '../routes/analysis.routes.js';
import type { HandbookEvaluationReadStore } from '../storage/record-graph-store.js';
import {
  DOCTRINE_VERSION,
  STRESS_ENGINE_VERSION,
  VALUATION_ENGINE_VERSION,
} from '@cre/contracts';
import type {
  AdjustedInputsId,
  DoctrineEvaluationId,
  HandbookEngineVersion,
  HandbookEvaluation,
  HandbookEvaluationId,
  ISODateTime,
  LineageRootId,
  ParentRevisionId,
  RevisionId,
  RevisionLineageEnvelope,
} from '@cre/contracts';
import type { Request, Response } from 'express';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(m: string): void {
  passed++;
  console.log(`  ok    ${m}`);
}
function fail(m: string): void {
  failed++;
  failures.push(m);
  console.error(`  FAIL  ${m}`);
}
function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(m);
  else fail(`${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
}

// =============================================================================
// Stubs — handler only touches req.params.id, res.status().json(), and two
// store methods.
// =============================================================================

function makeReq(id: string): Request {
  return { params: { id } } as unknown as Request;
}

function makeRes(): { res: Response; captured: { status?: number; body?: unknown } } {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return {
        json(body: unknown) {
          captured.body = body;
        },
      };
    },
  } as unknown as Response;
  return { res, captured };
}

// Full-shape `RevisionLineageEnvelope` for the route-handler stub. The handler
// reads only `envelope.adjustedInputsId`; the other 9 fields are synthetic
// brand-cast defaults — they exist to satisfy the `HandbookEvaluationReadStore`
// interface's full-shape return contract, not to be inspected.
function makeEnvelope(args: { adjustedInputsId: AdjustedInputsId }): RevisionLineageEnvelope {
  return {
    revisionId: ('a'.repeat(64)) as RevisionId,
    lineageRootId: ('b'.repeat(64)) as LineageRootId,
    parentRevisionId: null as ParentRevisionId,
    revisionOrdinal: 0,
    doctrineEvaluationId: ('d'.repeat(64)) as DoctrineEvaluationId,
    adjustedInputsId: args.adjustedInputsId,
    doctrineVersion: DOCTRINE_VERSION,
    judgmentEngineVersion: '1.2',
    stressEngineVersion: STRESS_ENGINE_VERSION,
    valuationEngineVersion: VALUATION_ENGINE_VERSION,
  };
}

function makeMockStore(opts: {
  envelope?: RevisionLineageEnvelope | null;
  evaluation?: HandbookEvaluation | null;
  onLookup?: (adjustedInputsId: string) => void;
}): HandbookEvaluationReadStore {
  return {
    getLatestRevisionByLineageRoot(_rootId: RevisionId) {
      return opts.envelope ?? null;
    },
    getLatestHandbookEvaluationForAdjustedInputs(adjustedInputsId: string) {
      opts.onLookup?.(adjustedInputsId);
      return opts.evaluation ?? null;
    },
  };
}

function makeSampleEvaluation(adjustedInputsId: AdjustedInputsId): HandbookEvaluation {
  return {
    id: 'e'.repeat(64) as HandbookEvaluationId,
    analysisAsOfDate: '2026-01-01T00:00:00.000Z' as ISODateTime,
    adjustedInputsId,
    handbookVersion: '2026.1',
    engineVersion: '1.0.0' as HandbookEngineVersion,
    firedFlags: [
      {
        principleId: 'P-IV-OFF-2',
        severity: 'high',
        flag_message: 'Class B office',
        metricValue: 'B',
        groupIndex: 0,
        bandIndex: 0,
        injectionPoints: ['red_flag_assessment'],
      },
    ],
    skippedPrinciples: [],
    fieldBagSnapshot: { asset_type: 'Office' },
  } as HandbookEvaluation;
}

// =============================================================================
// Tests
// =============================================================================

console.log('\n=== Analysis not found → 404 ===');

(() => {
  const store = makeMockStore({ envelope: null });
  const { res, captured } = makeRes();
  handleHandbookEvaluationRead(makeReq('nonexistent-root-id'), res, store);
  assertEqual(captured.status, 404, 'returns 404 status');
  const body = captured.body as { error: string; message: string; lineageRootId: string };
  assertEqual(body.error, 'ANALYSIS_NOT_FOUND', 'error code matches handleGraphRead');
  assertEqual(body.lineageRootId, 'nonexistent-root-id', 'lineageRootId echoed back');
})();

console.log('\n=== Analysis exists, no handbook evaluation → 200 + null ===');

(() => {
  const adjustedInputsId = 'a'.repeat(64) as AdjustedInputsId;
  const store = makeMockStore({
    envelope: makeEnvelope({ adjustedInputsId }),
    evaluation: null,
  });
  const { res, captured } = makeRes();
  handleHandbookEvaluationRead(makeReq('found-root-id'), res, store);
  assertEqual(captured.status, 200, 'returns 200 status');
  assertEqual(captured.body, null, 'returns null body (analysis exists but no eval)');
})();

console.log('\n=== Analysis exists, handbook evaluation exists → 200 + eval ===');

(() => {
  const adjustedInputsId = 'a'.repeat(64) as AdjustedInputsId;
  const evaluation = makeSampleEvaluation(adjustedInputsId);
  const store = makeMockStore({
    envelope: makeEnvelope({ adjustedInputsId }),
    evaluation,
  });
  const { res, captured } = makeRes();
  handleHandbookEvaluationRead(makeReq('found-root-id'), res, store);
  assertEqual(captured.status, 200, 'returns 200 status');
  const body = captured.body as HandbookEvaluation;
  assertEqual(body.id, evaluation.id, 'returns the HandbookEvaluation by id');
  assertEqual(body.firedFlags.length, 1, 'fired flags preserved');
  assertEqual(body.handbookVersion, '2026.1', 'handbook version preserved');
  assertEqual(body.adjustedInputsId, adjustedInputsId, 'adjustedInputsId FK matches envelope');
})();

console.log('\n=== Handler chains envelope.adjustedInputsId → eval lookup ===');

(() => {
  // Verifies the handler correctly passes the envelope's adjustedInputsId
  // through to the eval lookup (not the request id or anything else).
  const adjustedInputsId = 'a'.repeat(64) as AdjustedInputsId;
  let capturedLookupId: string | null = null;
  const store = makeMockStore({
    envelope: makeEnvelope({ adjustedInputsId }),
    evaluation: null,
    onLookup: (id) => { capturedLookupId = id; },
  });
  const { res } = makeRes();
  handleHandbookEvaluationRead(makeReq('some-root-id'), res, store);
  assertEqual(
    capturedLookupId,
    adjustedInputsId,
    'handler passes envelope.adjustedInputsId to evaluation lookup',
  );
})();

// =============================================================================
// Summary
// =============================================================================

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

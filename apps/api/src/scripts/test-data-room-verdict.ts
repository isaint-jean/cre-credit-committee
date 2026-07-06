/**
 * Unit test — verdictFor (Data-Room Phase 2b truth table) + classifyLoanFromFilename.
 *
 *   npx tsx apps/api/src/scripts/test-data-room-verdict.ts
 *
 * Pure, no I/O, no cre.db. Proves THE PERMANENT SAFETY BAR: auto-route ONLY
 * when BOTH axes are non-null; every other cell → confirm with whatever WAS
 * confident pre-filled; tier-(c) (docType null) → always confirm.
 */

import assert from 'node:assert';
import {
  verdictFor,
  classifyLoanFromFilename,
  classifyStagedFile,
  type PoolLoanNameKey,
} from '../services/data-room-classify.service.js';

function log(m: string) {
  process.stdout.write(m + '\n');
}

// ── verdictFor — all four cells + the tier-(c) case ─────────────────────────

// Cell 1: both confident → AUTO, both pre-filled.
{
  const v = verdictFor('asr', 'loan-1');
  assert.strictEqual(v.action, 'auto', 'both-confident must be auto');
  assert.strictEqual(v.prefill.docType, 'asr');
  assert.strictEqual(v.prefill.loanInPoolId, 'loan-1');
}

// Cell 2: docType confident, loan ambiguous → CONFIRM, docType pre-filled only.
{
  const v = verdictFor('rent_roll', null);
  assert.strictEqual(v.action, 'confirm', 'single-axis (doc) must NOT auto');
  assert.strictEqual(v.prefill.docType, 'rent_roll');
  assert.strictEqual(v.prefill.loanInPoolId, undefined);
}

// Cell 3: loan confident, docType ambiguous → CONFIRM, loan pre-filled only.
{
  const v = verdictFor(null, 'loan-2');
  assert.strictEqual(v.action, 'confirm', 'single-axis (loan) must NOT auto');
  assert.strictEqual(v.prefill.docType, undefined);
  assert.strictEqual(v.prefill.loanInPoolId, 'loan-2');
}

// Cell 4: neither → CONFIRM, empty prefill (full manual).
{
  const v = verdictFor(null, null);
  assert.strictEqual(v.action, 'confirm', 'neither-confident must be manual confirm');
  assert.deepStrictEqual(v.prefill, {}, 'no prefill when nothing confident');
}

// Tier-(c) case: a legal doc's docType axis is structurally null (no pattern);
// even WITH a confident loan it can only land in confirm — never auto.
{
  const v = verdictFor(null /* legal: never inferable */, 'loan-3');
  assert.strictEqual(v.action, 'confirm', 'tier-(c) can NEVER auto-file');
  assert.strictEqual(v.prefill.loanInPoolId, 'loan-3', 'loan still pre-fills the confirm');
  assert.strictEqual(v.prefill.docType, undefined, 'tier-(c) doc-type stays blank');
}

log('✓ verdictFor: all 4 cells + tier-(c) never-auto pass');

// ── classifyLoanFromFilename — refuse-when-≠1 ───────────────────────────────

const LOANS: PoolLoanNameKey[] = [
  { loanInPoolId: 'lip-sunroad', originatorLoanRef: 'BMARK2024V8-Sunroad-Centrum', propertyName: 'Sunroad Centrum' },
  { loanInPoolId: 'lip-highlands', originatorLoanRef: 'BMARK2024V8-Highlands', propertyName: 'Highlands Corporate Center' },
];

// exactly-1 → confident (Sunroad normalizes via the same bridge).
assert.strictEqual(
  classifyLoanFromFilename('Sunroad Centrum - ASR FINAL.pdf', LOANS),
  'lip-sunroad',
  'confident property token → exactly-1 loan',
);

// 0 matches → refuse (bare slot-only name normalizes to empty core).
assert.strictEqual(
  classifyLoanFromFilename('Rent Roll FINAL.pdf', LOANS),
  null,
  'name-less filename → refuse (null)',
);

// ≥2 matches → refuse (two loans share a normalized name).
{
  const DUP: PoolLoanNameKey[] = [
    { loanInPoolId: 'a', originatorLoanRef: 'Sunroad Centrum', propertyName: null },
    { loanInPoolId: 'b', originatorLoanRef: null, propertyName: 'Sunroad Centrum' },
  ];
  assert.strictEqual(
    classifyLoanFromFilename('Sunroad Centrum ASR.pdf', DUP),
    null,
    'two loans same normalized name → refuse (null)',
  );
}

log('✓ classifyLoanFromFilename: exactly-1 confident, 0/≥2 refuse');

// ── classifyStagedFile — both axes composed ─────────────────────────────────
{
  const h = classifyStagedFile('Sunroad Centrum - ASR FINAL.pdf', LOANS);
  assert.strictEqual(h.docType, 'asr', 'doc-type axis → asr');
  assert.strictEqual(h.loanInPoolId, 'lip-sunroad', 'loan axis → sunroad');
}
log('✓ classifyStagedFile: both axes compose');

log('\nALL PASS');

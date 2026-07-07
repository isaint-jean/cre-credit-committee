/**
 * Unit test — classifyEntryFromPath (Data-Room v2 Piece B, Phase 2).
 *
 *   npx tsx apps/api/src/scripts/test-classify-entry-from-path.ts
 *
 * PURE, no I/O, no store, no cre.db — the fn opens nothing; loanNameKeys is a
 * PARAMETER supplied here. Proves:
 *   - all 3 path shapes → correct ClassifyHints
 *   - folder→loan resolves via the SAME bridge + refuses-when-≠1 (0 or ≥2)
 *   - folder-vs-docType CONTRADICTION flags → tray signal, NOT auto-file
 *   - bare/loose file → filename-only fallback (docType, no loan)
 *   - tier-(c) room-only docs stay un-inferable → human-gated (no docType hint)
 *   - unrecognized subfolder → no category hint, NO false contradiction
 *   - a leading `*.zip/` root segment is ignored
 */

import assert from 'node:assert';
import {
  classifyEntryFromPath,
  type PoolLoanNameKey,
} from '../services/data-room-classify.service.js';

function log(m: string) {
  process.stdout.write(m + '\n');
}

const LOANS: PoolLoanNameKey[] = [
  { loanInPoolId: 'lip-sunroad', originatorLoanRef: 'BMARK2024V8-Sunroad-Centrum', propertyName: 'Sunroad Centrum' },
  { loanInPoolId: 'lip-highlands', originatorLoanRef: 'BMARK2024V8-Highlands', propertyName: 'Highlands Corporate Center' },
];

// ── Shape 1 — Loan/Category/file (3 segments), category AGREES ──────────────
// NOTE: the loan folder must carry the FULL property name — the reused loan
// bridge is EXACT-match on the normalized key (a partial token like "Sunroad"
// normalizes to "sunroad" ≠ the pool key "sunroad centrum" → refuse). This is
// the same refuse-when-≠1 semantics as classifyLoanFromFilename.
{
  const h = classifyEntryFromPath('Sunroad Centrum/Third-Party Reports/appraisal.pdf', LOANS);
  assert.strictEqual(h.loanInPoolId, 'lip-sunroad', 'shape1: folder → sunroad loan');
  assert.strictEqual(h.docType, 'appraisal', 'shape1: file → appraisal docType');
  assert.strictEqual(h.categoryHint, 'Third-Party Reports', 'shape1: subfolder category hint');
  assert.strictEqual(h.contradiction, undefined, 'shape1: matching category → NO contradiction');
}
log('✓ shape 1 (Loan/Category/file): loan + docType + category, no contradiction');

// ── Shape 2 — Loan/file (2 segments), category DERIVED from docType ─────────
{
  const h = classifyEntryFromPath('Sunroad Centrum/rentroll.xlsx', LOANS);
  assert.strictEqual(h.loanInPoolId, 'lip-sunroad', 'shape2: folder → sunroad loan');
  assert.strictEqual(h.docType, 'rent_roll', 'shape2: file → rent_roll docType');
  assert.strictEqual(h.categoryHint, 'Excels', 'shape2: category DERIVED from docType (rent_roll→Excels)');
  assert.strictEqual(h.contradiction, undefined, 'shape2: no subfolder → no cross-check');
}
log('✓ shape 2 (Loan/file): loan + docType + category derived from docType');

// ── Shape 3 — bare file (1 segment): loose drop, docType only, loan UNKNOWN ─
{
  const h = classifyEntryFromPath('appraisal.pdf', LOANS);
  assert.strictEqual(h.docType, 'appraisal', 'shape3: filename → appraisal docType');
  assert.strictEqual(h.loanInPoolId, null, 'shape3: bare file → loan UNKNOWN (null → tray)');
  assert.strictEqual(h.categoryHint, 'Third-Party Reports', 'shape3: category derived from docType');
  assert.strictEqual(h.contradiction, undefined, 'shape3: no folder → no cross-check');
}
log('✓ shape 3 (bare file): filename-only fallback — docType, no loan');

// ── folder→loan resolves via the bridge + refuses-when-≠1 ───────────────────
{
  // 0 matches → refuse: an unknown property folder normalizes to no pool key.
  const h0 = classifyEntryFromPath('UnknownProperty/rentroll.xlsx', LOANS);
  assert.strictEqual(h0.loanInPoolId, null, 'folder matching 0 loans → refuse (null)');
  assert.strictEqual(h0.docType, 'rent_roll', 'docType still infers even when loan refuses');

  // ≥2 matches → refuse: two loans share a normalized name.
  const DUP: PoolLoanNameKey[] = [
    { loanInPoolId: 'a', originatorLoanRef: 'Sunroad Centrum', propertyName: null },
    { loanInPoolId: 'b', originatorLoanRef: null, propertyName: 'Sunroad Centrum' },
  ];
  const h2 = classifyEntryFromPath('Sunroad Centrum/rentroll.xlsx', DUP);
  assert.strictEqual(h2.loanInPoolId, null, 'folder matching ≥2 loans → refuse (null)');

  // A PARTIAL token that doesn't normalize to a full pool key also refuses
  // (exact-match bridge) — "Sunroad" → "sunroad" ≠ pool key "sunroad centrum".
  const hp = classifyEntryFromPath('Sunroad/rentroll.xlsx', LOANS);
  assert.strictEqual(hp.loanInPoolId, null, 'partial folder token → refuse (exact-match bridge)');
  assert.strictEqual(hp.docType, 'rent_roll', 'docType still infers on a refused loan');
}
log('✓ folder→loan: same bridge, refuses-when-≠1 (0 and ≥2 → null)');

// ── folder-vs-docType CONTRADICTION flags → tray signal, NOT auto-file ──────
{
  // folder=Legal, but file appraisal → docType appraisal → Third-Party Reports.
  const h = classifyEntryFromPath('Sunroad Centrum/Legal/appraisal.pdf', LOANS);
  assert.strictEqual(h.contradiction, true, 'contradiction: Legal folder vs Third-Party docType');
  // The best hints are STILL returned — contradiction is the tray signal, not a wipe.
  assert.strictEqual(h.docType, 'appraisal', 'contradiction: docType hint still returned (best guess)');
  assert.strictEqual(h.loanInPoolId, 'lip-sunroad', 'contradiction: loan hint still returned');
  // Category hint prefers the recognized folder label on a conflict.
  assert.strictEqual(h.categoryHint, 'Legal', 'contradiction: folder category is the hint');
}
log('✓ contradiction: Legal-folder vs appraisal-docType → contradiction:true (tray, hints intact)');

// ── tier-(c) room-only docs stay un-inferable → human-gated ─────────────────
{
  // A loose file whose name doesn't infer a slot → no docType → tray.
  const h = classifyEntryFromPath('borrower-org-chart.pdf', LOANS);
  assert.strictEqual(h.docType, null, 'tier-c/loose: un-inferable name → docType null (human-gated)');
  assert.strictEqual(h.loanInPoolId, null, 'tier-c/loose: bare file → no loan');
  assert.strictEqual(h.categoryHint, undefined, 'tier-c/loose: no docType → no derived category');
  assert.strictEqual(h.contradiction, undefined, 'tier-c/loose: nothing to cross-check');

  // Even inside a Loan/Category path, a tier-c docType (null) can't contradict —
  // no derived category to disagree with the folder → NO false flag.
  const h2 = classifyEntryFromPath('Sunroad Centrum/Legal/borrower-org-chart.pdf', LOANS);
  assert.strictEqual(h2.docType, null, 'tier-c in path: still un-inferable');
  assert.strictEqual(h2.loanInPoolId, 'lip-sunroad', 'tier-c in path: loan still resolves');
  assert.strictEqual(h2.categoryHint, 'Legal', 'tier-c in path: folder category is the hint');
  assert.strictEqual(h2.contradiction, undefined, 'tier-c in path: null docType → NO contradiction');
}
log('✓ tier-(c) room-only: un-inferable → docType null, human-gated, never auto-file');

// ── unrecognized subfolder → no category hint, NO false contradiction ───────
{
  const h = classifyEntryFromPath('Sunroad Centrum/WeirdBankFolderName/appraisal.pdf', LOANS);
  // Folder maps to no canonical category → falls back to docType-derived category.
  assert.strictEqual(h.categoryHint, 'Third-Party Reports', 'unrecognized folder → category derived from docType');
  assert.strictEqual(h.contradiction, undefined, 'unrecognized folder → NO false contradiction');
  assert.strictEqual(h.docType, 'appraisal', 'unrecognized folder: docType still infers');
  assert.strictEqual(h.loanInPoolId, 'lip-sunroad', 'unrecognized folder: loan still resolves');
}
log('✓ unrecognized subfolder: no false contradiction, category falls back to docType');

// ── leading `*.zip/` root segment is ignored ────────────────────────────────
{
  const h = classifyEntryFromPath('Bank.zip/Sunroad Centrum/Third-Party Reports/appraisal.pdf', LOANS);
  assert.strictEqual(h.loanInPoolId, 'lip-sunroad', 'zip root ignored → Sunroad is folder[0]');
  assert.strictEqual(h.docType, 'appraisal', 'zip root ignored → appraisal from file');
  assert.strictEqual(h.categoryHint, 'Third-Party Reports', 'zip root ignored → category from subfolder');
  assert.strictEqual(h.contradiction, undefined, 'zip root ignored → no contradiction');
}
log('✓ leading *.zip/ root: stripped, path shape parsed as if bare');

log('\nALL PASS');

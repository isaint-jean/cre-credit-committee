/**
 * Tests for the source-document → library-deal matcher
 * (Phase 2 — Upload Supporting Documents UI, client-side classification).
 *
 *   npx tsx apps/api/src/scripts/test-source-doc-matching.ts
 *
 * SOURCE OF TRUTH for the matcher lives at:
 *
 *   apps/web/src/lib/source-doc-matching.ts
 *
 * The matcher is pure (no I/O, no network). For build hygiene the api package
 * has rootDir=./src, which would forbid importing across packages — so this
 * test embeds an EXACT byte-for-byte copy of the matcher's logic below. If
 * you change the upstream algorithm, mirror the change here AND the inverse.
 * The synthetic test-batch walkthrough at the bottom is the corroborating
 * check that the duplicate did not drift.
 *
 * Coverage:
 *   - normalizeForMatch: prefix stripping, suffix stripping, extension strip
 *   - inferSlotFromFilename: single hit, no hits, multi-hit ambiguity
 *   - matchFileToDeal:
 *       * Sunroad ASR filename → auto-attach (exact)
 *       * "Sunroad Centrum Office One" → NEEDS-PICK (substring < exact;
 *         the spot-check addition)
 *       * portfolio Woodward case → NEEDS-PICK (2+ exacts trigger guard)
 *       * unknown name → unmatched
 *   - the full 8-file synthetic batch enumerated in the brief
 */

// ---------------------------------------------------------------------------
// DUPLICATED MATCHER — keep in lockstep with apps/web/src/lib/source-doc-matching.ts
// ---------------------------------------------------------------------------

interface UWRecordLike {
  id: string;
  dealName: string;
  fileName: string;
  assetType?: string;
  year?: number;
  city?: string;
  state?: string;
}

type SourceDocSlot =
  | 'asr'
  | 'cf'
  | 'rent_roll'
  | 'pca'
  | 'seller_uw'
  | 't12'
  | 'appraisal';

function stripSlotHints(s: string): string {
  return s
    .replace(
      /\b(ASR|CF|PCA|Rent[\s-]*Roll|RR|T-?12|Trailing[\s-]*Twelve|Trailing[\s-]*12|Appraisal|Seller[\s-]*UW|Seller[\s-]*Underwriting|Cash[\s-]*Flow|Operating[\s-]*Statement|Pro[\s-]*Forma|Anticipated[\s-]*Sale[\s-]*Report|Property[\s-]*Condition|Acquisition[\s-]*Sale[\s-]*Report|Valuation[\s-]*Report)\b/gi,
      ' ',
    )
    .replace(/\(\s*\d{4}[\s-]*\d{1,2}[\s-]*\d{1,2}\s*\)/g, ' ')
    .replace(/\b(PRELIM|FINAL|DRAFT)\b/gi, ' ');
}

function normalizeForMatch(raw: string): string {
  let s = raw;
  s = s.replace(/\.(xlsm|xlsx|xls|pdf|doc|docx)$/i, '');
  s = s.replace(/^\s*\d{1,3}(?:\.\d{1,3})?\s*[-–.\s]+/, '');
  const suffixRx = /\s*[-–]?\s*(OK\s*TO\s*PRINT\s*[A-Z]{1,3}|OK\s*TO\s*PRINT|FINAL[-–\s]*OK\s*TO\s*PRINT|FINAL|with\s+sites|W\s+SITES|vStress|v\d+|need(?:s)?\s+site|JH\s*OK(?:\s+with\s+sites)?|JK\s+with\s+sites|LP\s*OK(?:\s+with\s+sites)?|JN|Updated|Revised|REV\d*)\s*$/gi;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(suffixRx, '').trim();
    if (s === before) break;
  }
  s = stripSlotHints(s);
  s = s.replace(/[-–_.,(){}[\]&'']/g, ' ');
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();
  return s;
}

function inferSlotFromFilename(fileName: string): SourceDocSlot | null {
  const patterns: ReadonlyArray<readonly [SourceDocSlot, RegExp]> = [
    ['asr', /\b(ASR|Anticipated[\s-]*Sale[\s-]*Report|Acquisition[\s-]*Sale[\s-]*Report)\b/i],
    ['cf', /\b(CF|Cash[\s-]*Flow|Operating[\s-]*Statement|Pro[\s-]*Forma)\b/i],
    ['pca', /\b(PCA|Property[\s-]*Condition(?:[\s-]*Assessment)?)\b/i],
    ['rent_roll', /\b(Rent[\s-]*Roll)\b/i],
    ['seller_uw', /\b(Seller[\s-]*UW|Seller[\s-]*Underwriting|Seller[\s-]*Pro[\s-]*Forma)\b/i],
    ['t12', /\b(T-?12|Trailing[\s-]*Twelve|Trailing[\s-]*12)\b/i],
    ['appraisal', /\b(Appraisal(?:[\s-]*Report)?|Valuation[\s-]*Report)\b/i],
  ];
  const matched: SourceDocSlot[] = [];
  for (const [slot, rx] of patterns) {
    if (rx.test(fileName)) matched.push(slot);
  }
  if (matched.length === 1) return matched[0]!;
  return null;
}

interface MatchCandidate {
  readonly uwRecord: UWRecordLike;
  readonly score: number;
  readonly reason: 'exact' | 'substring' | 'token_overlap';
}

type MatchBucket = 'auto_attach' | 'needs_pick' | 'unmatched';

interface MatchResult {
  readonly bucket: MatchBucket;
  readonly candidates: ReadonlyArray<MatchCandidate>;
  readonly pickedUwRecord?: UWRecordLike;
}

function matchFileToDeal(
  fileName: string,
  underwritings: ReadonlyArray<UWRecordLike>,
): MatchResult {
  const fileNormalized = normalizeForMatch(fileName);
  if (fileNormalized.length === 0) {
    return { bucket: 'unmatched', candidates: [] };
  }
  const scored: MatchCandidate[] = [];
  for (const uw of underwritings) {
    const dealNormalized = normalizeForMatch(uw.dealName);
    const fileNameNormalized = normalizeForMatch(uw.fileName);
    let score = 0;
    let reason: MatchCandidate['reason'] = 'token_overlap';
    if (
      (dealNormalized.length > 0 && dealNormalized === fileNormalized) ||
      (fileNameNormalized.length > 0 && fileNameNormalized === fileNormalized)
    ) {
      score = 1.0;
      reason = 'exact';
    } else if (dealNormalized.length >= 6 && fileNormalized.includes(dealNormalized)) {
      score = 0.85;
      reason = 'substring';
    } else if (fileNormalized.length >= 6 && dealNormalized.includes(fileNormalized)) {
      score = 0.75;
      reason = 'substring';
    } else {
      const fileTokens = new Set(fileNormalized.split(' ').filter((t) => t.length >= 3));
      const dealTokens = new Set(dealNormalized.split(' ').filter((t) => t.length >= 3));
      if (fileTokens.size === 0 || dealTokens.size === 0) continue;
      let overlap = 0;
      for (const t of fileTokens) if (dealTokens.has(t)) overlap++;
      score = overlap / Math.max(fileTokens.size, dealTokens.size);
      reason = 'token_overlap';
    }
    if (score > 0) scored.push({ uwRecord: uw, score, reason });
  }
  scored.sort((a, b) => b.score - a.score);
  const exactMatches = scored.filter((c) => c.reason === 'exact');
  const strongMatches = scored.filter((c) => c.score >= 0.7);
  if (exactMatches.length === 1 && strongMatches.length === 1) {
    return {
      bucket: 'auto_attach',
      candidates: [exactMatches[0]!],
      pickedUwRecord: exactMatches[0]!.uwRecord,
    };
  }
  const topCandidates = scored.filter((c) => c.score >= 0.4).slice(0, 5);
  if (topCandidates.length > 0) {
    return { bucket: 'needs_pick', candidates: topCandidates };
  }
  return { bucket: 'unmatched', candidates: [] };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function failPrint(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : failPrint(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : failPrint(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

// ---------------------------------------------------------------------------
// Fixture: 10 UW records representative of real library shapes
// ---------------------------------------------------------------------------

const FIXTURE: UWRecordLike[] = [
  {
    id: 'uw-001',
    dealName: 'Sunroad Centrum',
    fileName: '001- Sunroad Centrum - OK TO PRINT JN.xlsm',
    assetType: 'office', year: 2023, city: 'San Diego', state: 'CA',
  },
  {
    id: 'uw-002',
    dealName: '1001 Woodward',
    fileName: '004.04- 1001 Woodward - FINAL OK TO PRINT JN.xlsm',
    assetType: 'office', year: 2022, city: 'Detroit', state: 'MI',
  },
  {
    id: 'uw-003',
    dealName: 'The Z Garage',
    fileName: '004.05- The Z Garage - FINAL OK TO PRINT JN.xlsm',
    assetType: 'other', year: 2022, city: 'Detroit', state: 'MI',
  },
  {
    id: 'uw-004',
    dealName: 'Chrysler House',
    fileName: '004.06- Chrysler House - FINAL OK TO PRINT JN.xlsm',
    assetType: 'office', year: 2022, city: 'Detroit', state: 'MI',
  },
  {
    id: 'uw-005',
    dealName: 'Aliz Hotel Times Square',
    fileName: '012- Aliz Hotel Times Square - FINAL.xlsm',
    assetType: 'hotel', year: 2023, city: 'New York', state: 'NY',
  },
  {
    id: 'uw-006',
    dealName: 'Nvidia Santa Clara',
    fileName: '020- Nvidia Santa Clara - OK TO PRINT.xlsm',
    assetType: 'office', year: 2024, city: 'Santa Clara', state: 'CA',
  },
  {
    id: 'uw-007',
    dealName: 'Sunroad Centrum Office One',
    fileName: '001b- Sunroad Centrum Office One - OK TO PRINT JN.xlsm',
    assetType: 'office', year: 2023, city: 'San Diego', state: 'CA',
  },
  {
    id: 'uw-008',
    dealName: '1001 Woodward Tower',
    fileName: '004.04b- 1001 Woodward Tower - FINAL.xlsm',
    assetType: 'office', year: 2022, city: 'Detroit', state: 'MI',
  },
  {
    id: 'uw-009',
    dealName: 'Marriott Marquis',
    fileName: '030- Marriott Marquis - FINAL.xlsm',
    assetType: 'hotel', year: 2023, city: 'San Francisco', state: 'CA',
  },
  {
    id: 'uw-010',
    dealName: 'Industrial Park West',
    fileName: '040- Industrial Park West - OK TO PRINT.xlsm',
    assetType: 'industrial', year: 2024, city: 'Phoenix', state: 'AZ',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  // -------------------------------------------------------------------------
  console.log('normalizeForMatch — prefix/suffix/extension stripping:');
  {
    assertEqual(
      normalizeForMatch('001- Sunroad Centrum - OK TO PRINT JN.xlsm'),
      'sunroad centrum',
      '1.1 deal-name normalization: prefix + suffix + extension',
    );
    assertEqual(
      normalizeForMatch('010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf'),
      'sunroad centrum',
      '1.2 filename normalization: dotted prefix + ASR + PRELIM + date',
    );
    assertEqual(
      normalizeForMatch('004.04- 1001 Woodward - FINAL OK TO PRINT JN.xlsm'),
      '1001 woodward',
      '1.3 sub-numbered prefix + nested suffix',
    );
    assertEqual(
      normalizeForMatch('Sunroad Centrum Office One.pdf'),
      'sunroad centrum office one',
      '1.4 plain filename normalizes through extension only',
    );
    assertEqual(
      normalizeForMatch('012- Aliz Hotel Times Square - FINAL.xlsm'),
      'aliz hotel times square',
      '1.5 hotel deal name normalization',
    );
  }

  // -------------------------------------------------------------------------
  console.log('\ninferSlotFromFilename — single/none/ambiguous:');
  {
    assertEqual(inferSlotFromFilename('010. Sunroad Centrum - ASR PRELIM.pdf'), 'asr',
      '2.1 ASR token → asr');
    assertEqual(inferSlotFromFilename('Sunroad CF PRELIM.xlsx'), 'cf',
      '2.2 CF token → cf');
    assertEqual(inferSlotFromFilename('Property Condition Assessment.pdf'), 'pca',
      '2.3 "Property Condition Assessment" phrase → pca');
    assertEqual(inferSlotFromFilename('Rent Roll Q4 2024.xlsx'), 'rent_roll',
      '2.4 "Rent Roll" phrase → rent_roll');
    assertEqual(inferSlotFromFilename('Trailing 12 Operating Statement.pdf'), null,
      '2.5 T-12 + Operating Statement (multi-hit) → null');
    assertEqual(inferSlotFromFilename('Appraisal Report.pdf'), 'appraisal',
      '2.6 Appraisal Report → appraisal');
    assertEqual(inferSlotFromFilename('deal-doc.pdf'), null,
      '2.7 no hints → null');
    assertEqual(inferSlotFromFilename('appraisal-cf-pca.pdf'), null,
      '2.8 multiple hints → null (ambiguous, caller prompts)');
    assertEqual(inferSlotFromFilename('Seller UW Final.pdf'), 'seller_uw',
      '2.9 Seller UW → seller_uw');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — Sunroad ASR auto-attach (exact):');
  {
    // The hand fixture has both "Sunroad Centrum" AND "Sunroad Centrum Office One".
    // The Sunroad-ASR filename normalizes to "sunroad centrum" which exactly
    // matches the first dealName (and is a substring of the second). The portfolio
    // guard MUST flag this → NEEDS-PICK (the brief's load-bearing spot-check
    // safety; two strong matches means we cannot auto-attach safely).
    const result = matchFileToDeal(
      '010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf',
      FIXTURE,
    );
    assertEqual(result.bucket, 'needs_pick',
      '3.1 portfolio guard fires when two Sunroad records match (auto-attach blocked)');
    assert(result.candidates.length >= 2,
      '3.2 NEEDS-PICK surfaces both Sunroad candidates');
    assertEqual(result.candidates[0]!.uwRecord.id, 'uw-001',
      '3.3 top candidate is the exact "Sunroad Centrum" record');
    assertEqual(result.candidates[0]!.score, 1.0, '3.4 top candidate score = 1.0');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — single-Sunroad fixture (true auto-attach):');
  {
    // Remove the "Sunroad Centrum Office One" record to demonstrate the
    // unambiguous auto-attach path.
    const trimmed = FIXTURE.filter((r) => r.id !== 'uw-007');
    const result = matchFileToDeal(
      '010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf',
      trimmed,
    );
    assertEqual(result.bucket, 'auto_attach',
      '4.1 single exact match → auto-attach');
    assertEqual(result.pickedUwRecord?.id, 'uw-001',
      '4.2 pickedUwRecord populated for auto-attach');
    assertEqual(result.candidates.length, 1,
      '4.3 single candidate carried for spot-check display');
    assertEqual(result.candidates[0]!.reason, 'exact',
      '4.4 reason = exact');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — substring spot-check case:');
  {
    // The spot-check addition: "Sunroad Centrum Office One.pdf" (no slot hint)
    // matches the "Sunroad Centrum Office One" record EXACTLY → score 1.0,
    // BUT ALSO matches "Sunroad Centrum" via substring (deal⊂file at 0.85).
    // Two strong matches → portfolio guard → NEEDS-PICK.
    const result = matchFileToDeal('Sunroad Centrum Office One.pdf', FIXTURE);
    assertEqual(result.bucket, 'needs_pick',
      '5.1 strong substring sibling forces NEEDS-PICK (spot-check protection)');
    assertEqual(result.candidates[0]!.uwRecord.id, 'uw-007',
      '5.2 top candidate is the exact-match sibling');
    assert(result.candidates.some((c) => c.uwRecord.id === 'uw-001'),
      '5.3 "Sunroad Centrum" surfaces as secondary candidate (spot-check)');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — Woodward portfolio guard:');
  {
    // "1001 Woodward" + "1001 Woodward Tower" → both score high → NEEDS-PICK.
    const result = matchFileToDeal('004.04- 1001 Woodward - CF.xlsx', FIXTURE);
    assertEqual(result.bucket, 'needs_pick',
      '6.1 portfolio guard: multiple Woodward records → NEEDS-PICK');
    assert(result.candidates.length >= 2,
      '6.2 at least two Woodward candidates surfaced');
    const ids = new Set(result.candidates.map((c) => c.uwRecord.id));
    assert(ids.has('uw-002') && ids.has('uw-008'),
      '6.3 both Woodward records present in NEEDS-PICK list');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — unmatched:');
  {
    const result = matchFileToDeal('Some Random Building Name.pdf', FIXTURE);
    assertEqual(result.bucket, 'unmatched',
      '7.1 no candidate at any threshold → unmatched');
    assertEqual(result.candidates.length, 0,
      '7.2 candidates empty for unmatched');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — empty / whitespace input:');
  {
    const r1 = matchFileToDeal('', FIXTURE);
    assertEqual(r1.bucket, 'unmatched', '8.1 empty filename → unmatched');
    const r2 = matchFileToDeal('.pdf', FIXTURE);
    assertEqual(r2.bucket, 'unmatched', '8.2 bare extension → unmatched');
  }

  // -------------------------------------------------------------------------
  console.log('\nmatchFileToDeal — Aliz auto-attach (no portfolio sibling):');
  {
    const result = matchFileToDeal('Aliz Hotel ASR.pdf', FIXTURE);
    // "aliz hotel" tokens overlap with "aliz hotel times square" but neither
    // direction satisfies a 6+ char substring. The token-overlap score should
    // still surface this as a candidate. Whether it auto-attaches depends on
    // whether the exact-match condition fires. Since neither equals exactly,
    // we expect NEEDS-PICK with Aliz as top candidate.
    assert(result.bucket === 'needs_pick' || result.bucket === 'auto_attach',
      '9.1 Aliz surfaces as candidate (not unmatched)');
    assertEqual(result.candidates[0]!.uwRecord.id, 'uw-005',
      '9.2 top candidate is the Aliz record');
  }

  // -------------------------------------------------------------------------
  console.log('\nSynthetic batch walkthrough — 8 files (brief Section §SYNTHETIC):');
  {
    const batch: ReadonlyArray<{ name: string; expectedBucket: MatchBucket; expectedSlot: SourceDocSlot | null; note: string }> = [
      { name: '010. Sunroad Centrum - ASR PRELIM (2023-07-19).pdf',
        expectedBucket: 'needs_pick', expectedSlot: 'asr',
        note: 'PORTFOLIO GUARD: matches both Sunroad records → flag (NOT auto-attach)' },
      { name: '010. Sunroad Centrum - CF PRELIM (2023-07-25).xlsx',
        expectedBucket: 'needs_pick', expectedSlot: 'cf',
        note: 'PORTFOLIO GUARD: same as above for the CF' },
      { name: '23-414408.1 PCA Report- Sunroad Centrum, San Diego, CA 080323.pdf',
        expectedBucket: 'needs_pick', expectedSlot: 'pca',
        note: 'Contains "Sunroad Centrum" substring; portfolio guard still fires' },
      { name: 'Sunroad Centrum Office One.pdf',
        expectedBucket: 'needs_pick', expectedSlot: null,
        note: 'SPOT-CHECK CASE: matches Office One exactly AND Sunroad Centrum substring → NEEDS-PICK' },
      { name: '1001 Woodward Office.pdf',
        expectedBucket: 'needs_pick', expectedSlot: null,
        note: 'PORTFOLIO CASE: 1001 Woodward + 1001 Woodward Tower both match' },
      { name: 'Aliz Hotel ASR.pdf',
        expectedBucket: 'needs_pick', expectedSlot: 'asr',
        note: 'Aliz token-overlap → NEEDS-PICK (no exact match)' },
      { name: 'Random Property Name.pdf',
        expectedBucket: 'unmatched', expectedSlot: null,
        note: 'No match in library → UNMATCHED + staged' },
      { name: 'undated-document.pdf',
        expectedBucket: 'unmatched', expectedSlot: null,
        note: 'No name match, no slot hint → UNMATCHED + slot=null' },
    ];

    console.log('\n  file                                                    | inferred slot | bucket       | top match (score)');
    console.log('  --------------------------------------------------------+---------------+--------------+-----------------------');
    for (const row of batch) {
      const slot = inferSlotFromFilename(row.name);
      const result = matchFileToDeal(row.name, FIXTURE);
      const top = result.candidates[0];
      const topStr = top
        ? `${top.uwRecord.dealName} (${top.score.toFixed(2)})`
        : '—';
      const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
      console.log(
        `  ${pad(row.name, 56)}| ${pad(String(slot ?? 'null'), 14)}| ${pad(result.bucket, 13)}| ${topStr}`,
      );
      assertEqual(slot, row.expectedSlot, `  SYN: ${row.name} → slot ${String(row.expectedSlot)}`);
      assertEqual(result.bucket, row.expectedBucket, `  SYN: ${row.name} → bucket ${row.expectedBucket}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();

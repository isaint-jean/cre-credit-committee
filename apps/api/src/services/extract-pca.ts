/**
 * extractPca — AI-tier extractor for Property Condition Assessment (PCA) reports.
 *
 * ASTM E2018-style PCA reports are typically 100-200-page PDFs combining:
 *  - Table 1: Immediate Repair + Short-Term Cost line items with column totals.
 *  - Table 2: Long-Term Cost Opinion — year-by-year capex schedule over an
 *             N-year evaluation period (typically 10-12 years), with both
 *             inflated and uninflated dollar columns.
 *  - Structural narratives: condition + remaining-useful-life prose for each
 *             building system (roof, HVAC, plumbing, electrical, etc.).
 *
 * HYBRID TWO-CALL ARCHITECTURE — empirically derived during Step 0 of the PCA
 * producer ticket (against `apps/api/fixtures/sunroad-centrum-pca.pdf`, commit
 * 431102d):
 *
 *   Call A — scalars + structural narratives. Single AI call against full PCA
 *            text; returns 6 scalars + 4 narrative strings. Step 0 empirical
 *            result: 6/6 scalars anchor-exact on first run; narratives
 *            extracted at appropriate length and content.
 *
 *   Call B — capex schedule arrays. Separate AI call with B-explicit prompting
 *            (includes a few-shot example demonstrating year-by-year mapping
 *            for a fictional sparse schedule). Step 0 found single-call
 *            extraction produced positional-packing failures on Table 2: the
 *            AI collapsed non-zero entries to consecutive years 1, 2, 3, …
 *            losing the actual year assignment. B-explicit prompting targets
 *            that specific failure mode by forbidding compression of zero
 *            years and showing the right-vs-wrong patterns inline.
 *
 * Failure handling: Promise.allSettled. Either call may succeed or fail
 * independently; the merged PCAExtraction carries whichever subset of fields
 * was extracted. Both calls failing → return null. One call failing → partial
 * record with that call's fields all null.
 *
 * Pure parsers (parseAiPcaCallAResponse / parseAiPcaCallBResponse) are exported
 * separately for test discipline — tests can exercise normalization + coercion
 * without invoking the live AI.
 *
 * Discipline:
 *  - Best-effort. AI extraction can miss; missing scalar → null. The pure
 *    parser never fabricates.
 *  - "Absent column" vs "$0 total" distinction: standard ASTM E2018 reports
 *    carry both Immediate Repair AND Short-Term Cost columns. When a column
 *    is structurally present with a $0 total row, return 0. When the column
 *    is structurally absent, return null. The Step 0 reproducibility check
 *    found AI variance on this distinction — the prompt addresses it
 *    explicitly.
 *  - Consistency enforcement (per recon Item 6c, v8 §14.1): trust the array,
 *    override the field. If `capexScheduleInflated.length !== evaluationPeriodYears`,
 *    set `evaluationPeriodYears = capexScheduleInflated.length`. If inflated
 *    and uninflated arrays disagree in length, return null (the schedules
 *    are internally inconsistent — refuse to ship a corrupt record).
 *  - Malformed array entry → reject the whole record. Schedule arrays are
 *    load-bearing for P-IV-RET-6's sum_over_term formula; one malformed
 *    entry corrupts the entire sum. Stricter than silent filtering; mirrors
 *    `extract-rent-roll-from-document.ts`'s discipline for malformed rows.
 *
 * KNOWN LIMITATION — schedule-array year-by-year accuracy is approximately
 * 50-60% on the Sunroad fixture. The AI reliably captures the sum AND the
 * SET of non-zero entries, but year placements are often off-by-one or
 * off-by-two for individual non-zero entries. Root cause: PDF text
 * extraction (`unpdf` / pdf.js) strips column positions from Table 2 cells.
 * The extracted text shows row data + dollar amounts as a linear stream
 * (e.g., "5.2 HVAC boiler, Replace/Refurbish 20 15 5 3 3 EA $10,000
 * $30,000 $30,000") with NO positional cue indicating which year column
 * each $30,000 belongs to. The AI must infer year placement from row
 * metadata (RUL, EUL) and/or PDF visual coordinates that aren't preserved
 * in the text. Three prompt iterations in Step 2 of the PCA producer
 * ticket confirmed this ceiling:
 *   - Iteration 0 (vanilla): positional packing (all non-zero values at
 *     years 1, 2, 3, …).
 *   - Iteration 2 (B-explicit, current): 6/12 entries exact, sum exact.
 *   - Iteration 3 (B-explicit + "read totals row"): regressed to 4/12.
 * Sum-precise consumers (P-IV-RET-6, G49 derivation) work correctly.
 * Year-precise consumers (populator E35-M35 broadcast, audit display)
 * MUST NOT rely on per-year accuracy. Future tickets that need per-year
 * precision should evaluate deterministic PDF table parsers (pdfplumber,
 * tabula, camelot) as a replacement extraction path; not this ticket's
 * scope. Tracked as #TBD (filed in Step 9 of the PCA producer ticket).
 */

import type { PCAExtraction } from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';

/* -------------------------------- prompts --------------------------------- */

const PCA_CALL_A_SYSTEM = `You extract Property Condition Assessment (PCA) report scalar fields and condition narratives. Return ONLY a JSON object matching the requested schema. Missing fields must be null. Do not invent values. Never add prose, commentary, or markdown.`;

const PCA_CALL_B_SYSTEM = `You extract the year-by-year capital expenditure schedule from a Property Condition Assessment (PCA) report's Table 2. Return ONLY a JSON object matching the requested schema. Do not invent values. Never add prose, commentary, or markdown.`;

function buildCallAPrompt(text: string): string {
  return [
    'Extract the scalar fields and condition narratives from this ASTM E2018 Property Condition Assessment (PCA) report.',
    '',
    'Return STRICT JSON of this shape (and nothing else):',
    '',
    '{',
    '  "immediateRepairs": <total dollars from Table 1 "Immediate Repair" column total row, or null>,',
    '  "shortTermRepairs": <total dollars from Table 1 "Short-Term Cost" column total row, or null>,',
    '  "evaluationPeriodYears": <integer N representing Table 2 evaluation period (e.g. 12), or null>,',
    '  "inflationRate": <decimal fraction from Table 2 inflation rate (e.g. 0.025 for 2.5%), or null>,',
    '  "replacementReservesPerSfPerYearInflated": <inflated $/SF/yr from Table 2 summary metric, or null>,',
    '  "replacementReservesPerSfPerYearUninflated": <uninflated $/SF/yr from Table 2 summary metric, or null>,',
    '  "structural": {',
    '    "roof": "<1-3 sentence condition narrative for the roof, or null>",',
    '    "hvac": "<condition narrative for HVAC systems, or null>",',
    '    "plumbing": "<condition narrative for plumbing, or null>",',
    '    "electrical": "<condition narrative for electrical, or null>"',
    '  }',
    '}',
    '',
    'CRITICAL DISTINCTION — "column absent" vs "column present with $0 total":',
    '- If a column header is STRUCTURALLY PRESENT in the report (you can see the column in the table) and the total row shows $0, return numeric 0 — NOT null.',
    '- Return null ONLY if the column header itself is missing from the report (the field is truly not measured).',
    '- Standard ASTM E2018 PCA reports include BOTH Immediate Repair AND Short-Term Cost columns; expect both to be present. A Short-Term Cost total of $0 should be returned as 0, not null.',
    '',
    'Rules:',
    '- Missing field → null. Do NOT use 0 or "" or "N/A" as placeholders for missing scalars (but see the absent-vs-zero discipline above for column totals).',
    '- Numeric fields: plain numbers only (no $ signs, no commas, no % signs).',
    '- inflationRate: convert percent to decimal fraction (2.5% → 0.025).',
    '- Structural narratives: 1-3 sentences summarizing system condition + remaining useful life. Pull from the report\'s system-by-system condition section.',
    '- DO NOT include the year-by-year capex schedule arrays here — that is a separate extraction step.',
    '',
    '--- PCA DOCUMENT TEXT ---',
    text,
  ].join('\n');
}

function buildCallBPrompt(text: string): string {
  return [
    'Extract the year-by-year capital expenditure schedule from this ASTM E2018 PCA report.',
    '',
    'The PCA contains a Table 2 (variously titled "Long-Term Cost Opinion", "Replacement Reserves Schedule", "Capital Replacement Schedule", or similar). The table shows year-by-year capital expenditures over an N-year evaluation period (typically 10-12 years).',
    '',
    'Table 2 layout: each ROW is one repair line item (e.g., "Refurbish circulation pumps", "Refinish roof"). Each COLUMN is one year (1, 2, 3, …, N). Most cells are blank or zero. The PER-YEAR TOTAL is the column-wise sum of all line items in that year.',
    '',
    'Return STRICT JSON of this shape:',
    '',
    '{',
    '  "evaluationPeriodYears": <integer N from Table 2 header>,',
    '  "capexScheduleInflated": [',
    '    {"year": 1, "amount": <column-sum of inflated dollars for year 1>},',
    '    {"year": 2, "amount": <column-sum for year 2>},',
    '    {"year": 3, "amount": <column-sum for year 3>},',
    '    ...',
    '    {"year": N, "amount": <column-sum for year N>}',
    '  ],',
    '  "capexScheduleUninflated": [',
    '    {"year": 1, "amount": <column-sum of uninflated dollars for year 1>},',
    '    ...',
    '    {"year": N, "amount": <column-sum for year N>}',
    '  ]',
    '}',
    '',
    'CRITICAL — full year coverage REQUIRED:',
    '- Return entries for EVERY year in the evaluation period (year 1 through year N inclusive).',
    '- For years where the column-sum is zero or where no repair items are scheduled, you MUST explicitly emit {"year": K, "amount": 0}.',
    '- Do NOT collapse or compress entries.',
    '- Do NOT omit zero-amount years.',
    '- The array length MUST equal evaluationPeriodYears. If N is 12, the array MUST have 12 entries.',
    '',
    'EXAMPLE — a fictional 10-year PCA with non-zero amounts only in years 3, 5, and 8:',
    '',
    'WRONG (positional packing — omits zero years, year assignments are wrong):',
    '  {"capexScheduleInflated": [',
    '    {"year": 1, "amount": 1200},',
    '    {"year": 2, "amount": 5000},',
    '    {"year": 3, "amount": 850}',
    '  ]}',
    '  (3 entries packed at the front. Years 4-10 are missing. The year-1 amount is the year-3 value mislabeled. THIS IS WRONG.)',
    '',
    'RIGHT (full schedule — all 10 years explicit, correct year assignments):',
    '  {"capexScheduleInflated": [',
    '    {"year": 1, "amount": 0},',
    '    {"year": 2, "amount": 0},',
    '    {"year": 3, "amount": 1200},',
    '    {"year": 4, "amount": 0},',
    '    {"year": 5, "amount": 5000},',
    '    {"year": 6, "amount": 0},',
    '    {"year": 7, "amount": 0},',
    '    {"year": 8, "amount": 850},',
    '    {"year": 9, "amount": 0},',
    '    {"year": 10, "amount": 0}',
    '  ]}',
    '  (10 entries, one per year. Years with zero capex are EXPLICITLY {"year": K, "amount": 0}. Year assignments match the table.)',
    '',
    'Rules:',
    '- year values are 1-indexed.',
    '- Amounts are plain numbers (no $ signs, no commas).',
    '- Both arrays (inflated + uninflated) must have equal length (both equal to N).',
    '- If the report contains only inflated values (no separate uninflated column), set capexScheduleUninflated to null.',
    '- If you cannot find Table 2 in the report, return: {"evaluationPeriodYears": null, "capexScheduleInflated": null, "capexScheduleUninflated": null}',
    '',
    '--- PCA DOCUMENT TEXT ---',
    text,
  ].join('\n');
}

/* ----------------------------- coercion helpers --------------------------- */

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (/^(n\/?a|none|null|undefined|not\s*provided|not\s*disclosed|not\s*available|tbd)$/i.test(trimmed)) return null;
  return trimmed;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = asString(v);
    if (s === null) return null;
    const cleaned = s.replace(/[$,\s%]/g, '').replace(/^\(([\d.]+)\)$/, '-$1');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asInteger(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

/**
 * Inflation rate normalization. Accepts either a decimal fraction (0.025)
 * or a percent (2.5). Values >1 are treated as percent and divided by 100.
 * Values 0..1 are treated as fractions. Mirrors `asCapRate` from extract-asr.ts.
 */
function asInflationRate(v: unknown): number | null {
  const n = asNumber(v);
  if (n === null) return null;
  if (n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

/* ------------------------------ pure parsers ------------------------------ */

/**
 * Intermediate shape from Call A's pure parser — same fields as PCAExtraction
 * minus the two array fields (capex schedules), which come from Call B.
 */
export interface CallAResult {
  readonly immediateRepairs: number | null;
  readonly shortTermRepairs: number | null;
  readonly evaluationPeriodYears: number | null;
  readonly inflationRate: number | null;
  readonly replacementReservesPerSfPerYearInflated: number | null;
  readonly replacementReservesPerSfPerYearUninflated: number | null;
  readonly structural: {
    readonly roof: string | null;
    readonly hvac: string | null;
    readonly plumbing: string | null;
    readonly electrical: string | null;
  };
}

/**
 * Intermediate shape from Call B's pure parser. evaluationPeriodYears is
 * captured here too (Call B sees the table directly); the merge logic
 * reconciles with Call A's reading via "trust the array, override the field".
 */
export interface CallBResult {
  readonly evaluationPeriodYears: number | null;
  readonly capexScheduleInflated: ReadonlyArray<{ readonly year: number; readonly amount: number; }> | null;
  readonly capexScheduleUninflated: ReadonlyArray<{ readonly year: number; readonly amount: number; }> | null;
}

/**
 * Parse Call A's AI JSON response. Returns null when:
 *   - JSON is unparseable
 *   - top-level is not an object
 *   - every scalar AND every structural narrative ends up null (no data
 *     was actually extracted)
 *
 * Note: returns the intermediate `CallAResult` rather than a partial
 * `PCAExtraction` — the merge step produces the final PCAExtraction.
 */
export function parseAiPcaCallAResponse(responseText: string | unknown): CallAResult | null {
  let parsed: unknown;
  if (typeof responseText === 'string') {
    try {
      parsed = extractJSON(responseText);
    } catch {
      return null;
    }
  } else {
    parsed = responseText;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as { [k: string]: unknown };

  const structuralRaw = (typeof r.structural === 'object' && r.structural !== null)
    ? r.structural as { [k: string]: unknown }
    : {};

  const result: CallAResult = {
    immediateRepairs: asNumber(r.immediateRepairs),
    shortTermRepairs: asNumber(r.shortTermRepairs),
    evaluationPeriodYears: asInteger(r.evaluationPeriodYears),
    inflationRate: asInflationRate(r.inflationRate),
    replacementReservesPerSfPerYearInflated: asNumber(r.replacementReservesPerSfPerYearInflated),
    replacementReservesPerSfPerYearUninflated: asNumber(r.replacementReservesPerSfPerYearUninflated),
    structural: {
      roof: asString(structuralRaw.roof),
      hvac: asString(structuralRaw.hvac),
      plumbing: asString(structuralRaw.plumbing),
      electrical: asString(structuralRaw.electrical),
    },
  };

  // Reject if literally everything came back null (matches extract-asr.ts's
  // "no fabricated empty records" discipline).
  const anyScalar =
    result.immediateRepairs !== null ||
    result.shortTermRepairs !== null ||
    result.evaluationPeriodYears !== null ||
    result.inflationRate !== null ||
    result.replacementReservesPerSfPerYearInflated !== null ||
    result.replacementReservesPerSfPerYearUninflated !== null;
  const anyNarrative =
    result.structural.roof !== null ||
    result.structural.hvac !== null ||
    result.structural.plumbing !== null ||
    result.structural.electrical !== null;
  if (!anyScalar && !anyNarrative) return null;

  return result;
}

/**
 * Parse Call B's AI JSON response. Validates each schedule entry's shape
 * ({year: integer, amount: number}); ANY malformed entry → return null
 * (the whole record is rejected; the schedule arrays are load-bearing for
 * downstream P-IV-RET-6 formula reads and one bad entry corrupts the sum).
 *
 * Returns null when:
 *   - JSON is unparseable
 *   - top-level is not an object
 *   - any schedule entry is malformed
 *   - both schedule arrays are null (Call B found no Table 2)
 */
export function parseAiPcaCallBResponse(responseText: string | unknown): CallBResult | null {
  let parsed: unknown;
  if (typeof responseText === 'string') {
    try {
      parsed = extractJSON(responseText);
    } catch {
      return null;
    }
  } else {
    parsed = responseText;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as { [k: string]: unknown };

  const inflated = parseScheduleArray(r.capexScheduleInflated);
  const uninflated = parseScheduleArray(r.capexScheduleUninflated);

  // If parseScheduleArray rejected (malformed entry mid-array), that signals a
  // structural problem. Distinguish "explicitly null" from "rejected" via the
  // sentinel: parseScheduleArray returns `undefined` on malformed-reject vs
  // `null` on explicit-null. Convert undefined → null for the result, but ALSO
  // surface the rejection via early-return null on the whole record.
  if (inflated === undefined) return null;
  if (uninflated === undefined) return null;

  // Reject if BOTH arrays are null (Call B didn't find any Table 2 data).
  if (inflated === null && uninflated === null) {
    // evaluationPeriodYears alone isn't useful — Call A also captures it.
    return null;
  }

  return {
    evaluationPeriodYears: asInteger(r.evaluationPeriodYears),
    capexScheduleInflated: inflated,
    capexScheduleUninflated: uninflated,
  };
}

/**
 * Parse a schedule array. Three return values:
 *   - `ReadonlyArray<{year, amount}>` — well-formed, returned as-is.
 *   - `null` — the field was explicitly null (PCA has no uninflated column,
 *      or the AI didn't find Table 2).
 *   - `undefined` — the field was present but at least one entry was
 *      malformed (year/amount missing or wrong type). Caller rejects whole
 *      record on undefined.
 */
function parseScheduleArray(
  v: unknown,
): ReadonlyArray<{ readonly year: number; readonly amount: number; }> | null | undefined {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return undefined;
  const out: { year: number; amount: number; }[] = [];
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const e = entry as { [k: string]: unknown };
    const year = asInteger(e.year);
    const amount = asNumber(e.amount);
    if (year === null || amount === null) return undefined;
    if (year < 1) return undefined;
    out.push({ year, amount });
  }
  return out;
}

/* --------------------------------- merge ---------------------------------- */

/**
 * Merge Call A and Call B parsed results into a single PCAExtraction.
 *
 * Partial-success policy:
 *   - Both null → return null (extractor returns null overall).
 *   - Only A null → partial PCAExtraction with scalars/narratives all null,
 *                   arrays from B. evaluationPeriodYears comes from B (or
 *                   the array length if B's field disagrees).
 *   - Only B null → partial PCAExtraction with scalars/narratives from A,
 *                   arrays null.
 *   - Both present → full PCAExtraction. evaluationPeriodYears comes from
 *                    the array length (consistency enforcement, per recon
 *                    Item 6c).
 *
 * Consistency enforcement (recon Item 6c, v8 §14.1 Decision 4):
 *   - "Trust the array, override the field." If inflated array exists, set
 *     evaluationPeriodYears = inflated.length (overrides whatever Call A or
 *     Call B reported as the metadata field).
 *   - If both arrays exist and disagree in length → return null (whole record).
 */
export function buildPcaFromAiResponses(args: {
  readonly callA: CallAResult | null;
  readonly callB: CallBResult | null;
}): PCAExtraction | null {
  const { callA, callB } = args;
  if (callA === null && callB === null) return null;

  // Array-length consistency check: if both schedules present, must agree.
  const inflated = callB?.capexScheduleInflated ?? null;
  const uninflated = callB?.capexScheduleUninflated ?? null;
  if (inflated !== null && uninflated !== null && inflated.length !== uninflated.length) {
    // Internally inconsistent — refuse to ship a corrupt record.
    return null;
  }

  // Trust the array, override the field.
  let evaluationPeriodYears: number | null;
  if (inflated !== null) {
    evaluationPeriodYears = inflated.length;
  } else if (uninflated !== null) {
    evaluationPeriodYears = uninflated.length;
  } else {
    // No array → fall back to whichever call reported the scalar.
    evaluationPeriodYears = callB?.evaluationPeriodYears ?? callA?.evaluationPeriodYears ?? null;
  }

  return {
    immediateRepairs: callA?.immediateRepairs ?? null,
    shortTermRepairs: callA?.shortTermRepairs ?? null,
    evaluationPeriodYears,
    inflationRate: callA?.inflationRate ?? null,
    replacementReservesPerSfPerYearInflated: callA?.replacementReservesPerSfPerYearInflated ?? null,
    replacementReservesPerSfPerYearUninflated: callA?.replacementReservesPerSfPerYearUninflated ?? null,
    capexScheduleInflated: inflated,
    capexScheduleUninflated: uninflated,
    structural: {
      roof: callA?.structural.roof ?? null,
      hvac: callA?.structural.hvac ?? null,
      plumbing: callA?.structural.plumbing ?? null,
      electrical: callA?.structural.electrical ?? null,
    },
  };
}

/* --------------------------------- main ----------------------------------- */

/**
 * Extract a PCAExtraction from a parsed PCA document. Returns null when both
 * AI calls fail.
 *
 * The two AI calls run in parallel via Promise.allSettled (same pattern as
 * asr.adapter.ts's three-sub-extractor fan-out). Each call's failure is
 * isolated: Call A's success + Call B's failure produces a partial record
 * with arrays null, and vice versa.
 *
 * Input cap: 250_000 chars (~62K tokens, well within Claude Sonnet 4's 200K
 * context window). The full Sunroad PCA fixture is 238K chars; this cap
 * accommodates it with headroom. Step 0 empirically confirmed full-PCA-text
 * Call A produces clean extraction.
 */
export async function extractPca(document: ParsedDocument): Promise<PCAExtraction | null> {
  const text = document.sections
    .map((s) => (s.title ? '## ' + s.title + '\n' : '') + (s.content ?? ''))
    .join('\n\n')
    .slice(0, 250_000);
  if (text.length === 0) return null;

  const callAPromise = callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: PCA_CALL_A_SYSTEM,
    messages: [{ role: 'user', content: buildCallAPrompt(text) }],
  });

  const callBPromise = callAIWithContinuation({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: PCA_CALL_B_SYSTEM,
    messages: [{ role: 'user', content: buildCallBPrompt(text) }],
  });

  const [callASettled, callBSettled] = await Promise.allSettled([callAPromise, callBPromise]);

  const callAText = callASettled.status === 'fulfilled' ? callASettled.value : null;
  const callBText = callBSettled.status === 'fulfilled' ? callBSettled.value : null;

  if (callASettled.status === 'rejected') {
    console.warn('[AI:PCA] Call A (scalars + narratives) rejected:', (callASettled.reason as Error)?.message);
  }
  if (callBSettled.status === 'rejected') {
    console.warn('[AI:PCA] Call B (capex schedules) rejected:', (callBSettled.reason as Error)?.message);
  }

  const callA = callAText !== null ? parseAiPcaCallAResponse(callAText) : null;
  const callB = callBText !== null ? parseAiPcaCallBResponse(callBText) : null;

  return buildPcaFromAiResponses({ callA, callB });
}

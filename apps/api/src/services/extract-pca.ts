/**
 * extractPca — extractor for Property Condition Assessment (PCA) reports.
 *
 * ASTM E2018-style PCA reports are typically 100-200-page PDFs combining:
 *  - Table 1: Immediate Repair + Short-Term Cost line items with column totals.
 *  - Table 2: Long-Term Cost Opinion — year-by-year capex schedule over an
 *             N-year evaluation period (typically 10-12 years), with both
 *             inflated and uninflated dollar columns.
 *  - Structural narratives: condition + remaining-useful-life prose for each
 *             building system (roof, HVAC, plumbing, electrical, etc.).
 *
 * TWO-PATH ARCHITECTURE:
 *
 *   Call A — AI extraction for scalars + structural narratives. Single AI
 *            call against full PCA text; returns 6 scalars + 4 narrative
 *            strings. The flat-text input is sufficient for these fields:
 *            scalars surface in well-anchored prose locations, narratives
 *            are bulk text by nature.
 *
 *   Deterministic — capex schedule arrays via `pdfjs-dist` positional API
 *            (see `./extract-pca-schedule.ts`). Reads Table 2's year-header
 *            row and labeled INFLATED/UNINFLATED totals rows via per-text-
 *            item x-coordinates. Replaces an earlier AI Call B whose
 *            year-alignment ceiling was structural to the flat-text-extract
 *            API choice (see #44 for the migration; resolved in v10).
 *
 * Both paths run in parallel via Promise.allSettled. The merge layer at
 * `buildPcaFromAiResponses` handles partial-success (only Call A populates,
 * only Schedule populates) per the existing discipline.
 *
 * Pure parsers (parseAiPcaCallAResponse) are exported for test discipline —
 * tests can exercise normalization + coercion without invoking the live AI
 * or PDF parsing.
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
 *  - Consistency enforcement (per v8 §14.1): trust the array, override the
 *    field. If `capexScheduleInflated.length !== evaluationPeriodYears`,
 *    set `evaluationPeriodYears = capexScheduleInflated.length`. If
 *    inflated and uninflated arrays disagree in length, return null (the
 *    schedules are internally inconsistent — refuse to ship a corrupt
 *    record).
 *  - Malformed array entry → reject the whole record. Schedule arrays are
 *    load-bearing for P-IV-RET-6's sum_over_term formula; one malformed
 *    entry corrupts the entire sum.
 */

import type { PCAExtraction } from '@cre/contracts';
import type { ParsedDocument } from '@cre/shared';
import { callAIWithContinuation, extractJSON } from './ai-analysis.service.js';
import { extractCapexScheduleFromPdf } from './extract-pca-schedule.js';

/* -------------------------------- prompts --------------------------------- */

const PCA_CALL_A_SYSTEM = `You extract Property Condition Assessment (PCA) report scalar fields and condition narratives. Return ONLY a JSON object matching the requested schema. Missing fields must be null. Do not invent values. Never add prose, commentary, or markdown.`;

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
 * Intermediate shape carrying the capex schedule arrays into the merge
 * layer. Historically produced by an AI "Call B" parser; post-v10 produced
 * by the deterministic `extractCapexScheduleFromPdf` (see
 * `./extract-pca-schedule.ts`) and wrapped to this shape inside
 * `extractPca`. The name `CallBResult` is retained for stability of the
 * merge function's interface; treat the field set as the contract, not
 * the name.
 *
 * `evaluationPeriodYears` is captured here too; the merge logic reconciles
 * with Call A's reading via "trust the array, override the field".
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
 * Extract a PCAExtraction from a parsed PCA document plus the raw PDF buffer.
 *
 * Two paths run in parallel via Promise.allSettled:
 *   - Call A (AI): scalars + structural narratives, against the flat-text
 *     `document.sections` content.
 *   - Schedule (deterministic): capex schedule arrays via pdfjs-dist's
 *     positional API, against the raw `pdfBuffer`. See
 *     `./extract-pca-schedule.ts`.
 *
 * Returns null when BOTH paths produce no usable data. Partial success
 * (only Call A populates scalars, only schedule populates arrays) is
 * handled by the merge layer at `buildPcaFromAiResponses` — that function
 * already accepts a null on either side.
 *
 * Input cap on Call A's text: 250_000 chars (~62K tokens, well within
 * Claude Sonnet 4's 200K context window). The full Sunroad PCA fixture is
 * 238K chars; this cap accommodates it with headroom.
 *
 * The `pdfBuffer` flows through from `runPcaAdapter(slot.buffer)` →
 * `runPcaAdapterOnDocument(doc, hash, deps, pdfBuffer)` → here. It's the
 * same bytes that produced `document`; just preserved alongside the parsed
 * intermediate so the deterministic schedule extractor can call pdfjs-dist
 * directly without re-loading or re-hashing.
 */
export async function extractPca(
  document: ParsedDocument,
  pdfBuffer: Buffer,
): Promise<PCAExtraction | null> {
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

  const schedulePromise = extractCapexScheduleFromPdf(pdfBuffer);

  const [callASettled, scheduleSettled] = await Promise.allSettled([callAPromise, schedulePromise]);

  const callAText = callASettled.status === 'fulfilled' ? callASettled.value : null;
  const schedule = scheduleSettled.status === 'fulfilled' ? scheduleSettled.value : null;

  if (callASettled.status === 'rejected') {
    console.warn('[AI:PCA] Call A (scalars + narratives) rejected:', (callASettled.reason as Error)?.message);
  }
  if (scheduleSettled.status === 'rejected') {
    console.warn('[PCA:schedule] Deterministic capex-schedule extraction rejected:', (scheduleSettled.reason as Error)?.message);
  }

  const callA = callAText !== null ? parseAiPcaCallAResponse(callAText) : null;
  const callB: CallBResult | null = schedule === null ? null : {
    evaluationPeriodYears: schedule.inflated?.length ?? schedule.uninflated?.length ?? null,
    capexScheduleInflated: schedule.inflated,
    capexScheduleUninflated: schedule.uninflated,
  };

  return buildPcaFromAiResponses({ callA, callB });
}

/**
 * Memo Renderer v1 validation — REAL Sunroad through evaluateAndNarrate
 * + buildCommitteeMemo end-to-end.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-memo-v1-sunroad-real.ts
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NON-DETERMINISM NOTICE (2026-06-14, structural-gate redesign)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Full-memo byte-identity is NOT a property the current architecture
 * provides. The memo HTML contains three LLM-generated narrative slots —
 * executiveSummary, redFlagAssessment, committeeRecommendation — each
 * interpolated by buildCommitteeMemo via `<p class="memo-prose...">` tags
 * (the fourth narrative slot, mitigationSuggestions, is rendered
 * deterministically from the composed package and is NOT in the prose
 * spans). The orchestrator's call path is:
 *
 *   evaluateAndNarrate → buildNarrative → callAIWithContinuation
 *
 * which unconditionally calls live Anthropic Sonnet at default
 * temperature (no temperature=0, no seed, no cache-first read of
 * RecordGraphStore.getLatestNarrativeForAdjustedInputs). Two back-to-back
 * runs produce different memo bytes (verified empirically 2026-06-14:
 * 28,251B vs 28,220B; sha256 d4c614aa… vs b0ae269d…). The previously
 * pinned baseline sha256 90c09c04…d3e615f634a2abfcf10e51defc8aef5a13577019
 * is RETIRED as a pre-v1.5 warm-cache coincidence — not a real invariant.
 *
 * Cache-first determinism (modifying evaluateAndNarrate to read a cached
 * narrative before calling the LLM) is a deferred production-semantics
 * decision; it is intentionally NOT applied here.
 *
 * What this gate verifies instead:
 *   1. STRUCTURAL surface byte-identity. Hash the rendered HTML after
 *      redacting the three LLM-prose spans. The structural sha covers
 *      the deterministic remainder: table cells, restructuring callouts,
 *      mitigation suggestions, headers, footers, CSS, attribution.
 *      Stable across runs.
 *   2. NARRATIVE CORRECTNESS (not byte-identity). The structural
 *      cross-checks (numbers + subordination prose) assert that the
 *      LLM said the right things, regardless of phrasing.
 *   3. SINGLE LTV BASIS (appraised tokens absent). Memo carries one
 *      basis: doctrine-stressed.
 *
 * Pipeline:
 *   - Loads real Sunroad bundle from data/phase4-sunroad.db (copied to scratch).
 *   - Runs evaluateAndNarrate end-to-end (live Sonnet) with operator value
 *     $126,200,362.
 *   - Calls buildCommitteeMemo with the orchestrator outputs.
 *   - Writes the HTML to /tmp/sunroad-memo-v1.html.
 *   - Cross-checks every displayed dollar/%/dscr figure against the
 *     validated harness numbers.
 *   - Computes the STRUCTURAL sha (full HTML minus narrative prose spans)
 *     for comparison against the pinned baseline.
 *
 * Output: /tmp/sunroad-memo-v1.html (open in any browser; print → PDF).
 */
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { RecordGraphStore } from '../storage/record-graph-store.js';
import { evaluateAndNarrate } from '../services/evaluate-and-narrate.js';
import { buildCommitteeMemo } from '../services/render-memo/build-committee-memo.js';
import type {
  AdjustedInputs,
  AssetProfile,
  ExtractionResultId,
  LibrarySnapshot,
  NarrativeFacts,
  PropertyMetadata,
  RentRoll,
} from '@cre/contracts';
import type { OperatorSuppliedValue } from '../doctrine-clean/index.js';

const SRC_DB = path.resolve(process.cwd(), 'data/phase4-sunroad.db');
const TMP_DB = path.resolve('/tmp/phase4-sunroad-memo-v1-validation.db');
const OUT_HTML = path.resolve('/tmp/sunroad-memo-v1.html');

/**
 * Pinned baseline for the structural-surface sha (HTML with the three
 * `<p class="memo-prose...">` LLM-prose spans redacted to a sentinel).
 * Covers the deterministic memo surface: header, attribution, stressed
 * credit profile table, restructuring callouts, deterministic mitigation
 * suggestions section, findings table, footer, CSS, version strings.
 *
 * Captured 2026-06-14 against:
 *   - mitigation engine v1.8 (commit 6743116)
 *   - doctrine v1.4         (commit 0e5a179)
 *   - narrative engine v1.7 (NARRATIVE_ENGINE_VERSION constant)
 *   - committee memo v1.0   (COMMITTEE_MEMO_VERSION constant)
 *
 * Verified stable across two independent live-Sonnet runs while full-HTML
 * sha varied (28,370 / bbb530c5… vs 28,269 / d2add740…). The three
 * redacted prose spans are the only non-deterministic content.
 *
 * Drift here means: a structural template change (new section, reworded
 * label, CSS rule, version-string change, table-row reorder, etc.). Either
 * the change is intentional — re-baseline this constant — or it's a
 * regression and the gate just caught it.
 *
 * Retired prior baselines:
 *   90c09c048d453db6ab635f50d3e615f634a2abfcf10e51defc8aef5a13577019
 *     — pre-v1.5 mitigation-engine warm-cache coincidence (full-HTML, not
 *       reproducible). See NON-DETERMINISM NOTICE in the header.
 *   f71ec7421e1076ff62b12abc44be3aebde6f4026d509540bf80852baf99aebe6
 *     — narrative engine v1.6 structural baseline. Retired 2026-06-14 on
 *       the v1.6 → v1.7 bump (committee_recommendation prompt tighten:
 *       force one paragraph; forbid trailing synthesis ¶ + unbid
 *       qualitative claims). The version footer carries "v1.7" in 3
 *       deterministic locations — that string move alone shifts the sha;
 *       the redacted prose itself is unchanged in structure.
 *   505b13f6ffe512678b06a823d22d0d621bb84e20957c389741633bdf80f7363d
 *     — narrative engine v1.7 structural baseline. Retired 2026-06-15 on
 *       removing the leaked dev annotation "[ISABELLE-TO-CALIBRATE]" from
 *       2 customer-facing render paths (build-committee-memo.ts:466
 *       Sponsor Burden aggregate-note + compose-mitigations.ts:855 burden
 *       flag prose). The annotation is a legitimate dev marker on the
 *       hand-set knob (SPONSOR_CASH_AT_RISK_FLAG_THRESHOLD = 0.45 in
 *       produce-mitigations.ts:497) but had been copy-pasted into the
 *       rendered memo template + the prose builder, surfacing as raw
 *       bracket-text to credit committee readers. The knob's own source
 *       annotation is preserved (it doesn't render); only the leaked
 *       copies in the render paths are deleted. Both deletions sit in
 *       the structural (non-redacted) region, so the sha moves.
 */
const EXPECTED_STRUCTURAL_SHA =
  '9696933e9b52542e29cb064f53961eebd4d80f2e53ce1eed5f87354271c03dd8';

function copyDb(): void {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
  fs.copyFileSync(SRC_DB, TMP_DB);
}

function loadSingleton<T>(table: string): T {
  const Database = require('better-sqlite3');
  const db = new Database(TMP_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT id, payload FROM ${table} LIMIT 1`).get() as
      | { id: string; payload: string } | undefined;
    if (!row) throw new Error(`no rows in ${table}`);
    return { id: row.id, ...JSON.parse(row.payload) } as T;
  } finally {
    db.close();
  }
}

function pickLargestExtractionId(): ExtractionResultId {
  const Database = require('better-sqlite3');
  const db = new Database(TMP_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT id FROM extraction_results ORDER BY length(payload) DESC LIMIT 1`,
    ).get() as { id: string } | undefined;
    if (!row) throw new Error('no extraction_results');
    return row.id as ExtractionResultId;
  } finally {
    db.close();
  }
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('MEMO RENDERER v1 VALIDATION — Sunroad through evaluateAndNarrate + buildCommitteeMemo');
  console.log('================================================================');
  console.log('');

  copyDb();
  console.log(`Copied  ${SRC_DB}`);
  console.log(`     -> ${TMP_DB}`);
  console.log('');

  const store = new RecordGraphStore(TMP_DB);
  const extractionResultId = pickLargestExtractionId();
  const assetProfile    = loadSingleton<AssetProfile>('asset_profiles');
  const librarySnapshot = loadSingleton<LibrarySnapshot>('library_snapshots');
  const narrativeFacts  = loadSingleton<NarrativeFacts>('narrative_facts');
  const adjustedInputs  = loadSingleton<AdjustedInputs>('adjusted_inputs');

  console.log(`Loaded Sunroad bundle (extraction ${(extractionResultId as string).slice(0,12)}…, ai ${(adjustedInputs as any).id?.slice(0,12)}…)`);
  console.log('');

  const operatorSuppliedValue: OperatorSuppliedValue = {
    value: 126_200_362,
    source: 'operator-supplied',
    asOf: '2026-04-15T00:00:00Z' as any,
    basis: 'Desk BOV anchored to Q1 ratings actions on comparable Office CBD towers',
  };

  /* ----- orchestrator end-to-end ----- */
  console.log('Running evaluateAndNarrate end-to-end (live Sonnet)...');
  const t0 = Date.now();
  const result = await evaluateAndNarrate({
    adjustedInputs,
    assetProfile,
    librarySnapshot,
    narrativeFacts,
    extractionResultId,
    extraction: store.getExtractionResult(extractionResultId)!,
    analysisAsOfDate: (adjustedInputs as any).analysisAsOfDate,
    propertyMetadata: null as PropertyMetadata | null,
    rentRoll: null as RentRoll | null,
    operatorSuppliedValue,
  }, store);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Done in ${dt}s.`);
  console.log('');

  const { narrative, dealResult, composedMitigationPackage } = result;

  /* ----- render memo ----- */
  console.log('Rendering committee memo...');
  const html = buildCommitteeMemo({
    dealName: 'Sunroad Centrum',
    memoDate: '2026-06-12',
    narrative,
    dealResult,
    composedMitigationPackage,
  });
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  console.log(`Wrote ${html.length.toLocaleString()} bytes to ${OUT_HTML}`);
  console.log('');

  /* ----- cross-check displayed figures ----- */
  console.log('================================================================');
  console.log('CROSS-CHECK — displayed HTML figures vs validated harness numbers');
  console.log('================================================================');
  // Re-baselined against current engine (mitigation v1.8 / doctrine v1.4 /
  // narrative v1.6). The previous expectations ($18.73M cut / $63.73M L′ /
  // 68% / 1.32x) were pre-v1.5 mitigation-engine artifacts and have not
  // been reachable since 79a5cf1 (v1.5 hard trap-to-target cash sweep
  // reshaped cut/reserve framing). Current truth verified against
  // calibration-funded-exit-crosscheck-sunroad.ts:
  //   original $82.46M → L′ $74.98M (cut $7.48M); stressedLtv at L′ = 80.00%;
  //   rawExit 1.12x; fundedExit (post $7.50M trap) 1.25x.
  const checks: { label: string; needle: string; ok: boolean }[] = [
    { label: 'proceeds cut            ',  needle: '$7.48M',                ok: html.includes('$7.48M') },
    { label: 'L′ (final loan amount)  ',  needle: '$74.98M',               ok: html.includes('$74.98M') },
    { label: 'original loan amount    ',  needle: '$82.46M',               ok: html.includes('$82.46M') },
    { label: 'dim-7 stressed value    ',  needle: '$93.72M',               ok: html.includes('$93.72M') },
    { label: 'stressedLtv before      ',  needle: '87.98%',                ok: html.includes('87.98%') },
    { label: 'stressedLtv at L′       ',  needle: '80.00%',                ok: html.includes('80.00%') },
    { label: 'exit DSCR baseline      ',  needle: '1.02x',                 ok: html.includes('1.02x') },
    { label: 'raw exit DSCR at L′     ',  needle: '1.12x',                 ok: html.includes('1.12x') },
    { label: 'funded exit at L′       ',  needle: '1.25x',                 ok: html.includes('1.25x') },
    { label: 'reserve target          ',  needle: '$7.50M',                ok: html.includes('$7.50M') },
    { label: 'exit-DSCR trigger       ',  needle: '1.20x',                 ok: html.includes('1.20x') },
    { label: 'rating recommendation   ',  needle: 'ApproveWithConditions', ok: html.includes('ApproveWithConditions') },
    { label: 'operator-supplied tag   ',  needle: 'operator-supplied',     ok: html.includes('operator-supplied') },
  ];
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}: "${c.needle}" ${c.ok ? 'PRESENT' : 'ABSENT'}`);
  }
  const allOk = checks.every(c => c.ok);
  console.log('');
  console.log(`  ${allOk ? '✓ ALL CROSS-CHECKS PASS' : '✗ CROSS-CHECK FAILURES'}`);
  console.log('');

  /* ----- forbidden appraised-LTV tokens ----- */
  console.log('================================================================');
  console.log('Single LTV basis — appraised tokens MUST be absent');
  console.log('================================================================');
  const forbidden = ['65.34%', '40.90%'];
  let basisClean = true;
  for (const tok of forbidden) {
    const present = html.includes(tok);
    if (present) basisClean = false;
    console.log(`  ${present ? '✗ LEAK' : '✓ absent'} "${tok}"`);
  }
  console.log('');

  /* ----- restructuring section + reconciliation ----- */
  console.log('================================================================');
  console.log('Restructuring section — reconciliation + operator-supplied disclosure');
  console.log('================================================================');
  // Re-baselined: the v1.5+ mitigation engine emits "SUBORDINATED — exit fully
  // funded by the cash trap (residual $0)" in place of the old "superseded by
  // the $X proceeds cut" phrasing. The structural reconciliation marker is the
  // proceeds-reduction figure plus the subordination prose; both must appear.
  const reconChecks = [
    { label: 'Restructuring section title    ', needle: 'Restructuring Package' },
    { label: 'Recommended restructure label  ', needle: 'Recommended restructure' },
    { label: 'Proceeds reduction figure      ', needle: 'Proceeds reduction $7.48M' },
    { label: 'Subordination reconciliation   ', needle: 'SUBORDINATED' },
    { label: 'Valuation basis disclosure     ', needle: 'Valuation basis: operator-supplied' },
    { label: 'In-place lockbox condition     ', needle: 'In-place cash management' },
    { label: 'CP condition                   ', needle: 'Conditions precedent' },
    { label: 'Engine version footer          ', needle: `narrative engine v${narrative.engineVersion}` },
  ];
  let reconOk = true;
  for (const c of reconChecks) {
    const present = html.includes(c.needle);
    if (!present) reconOk = false;
    console.log(`  ${present ? '✓' : '✗'} ${c.label}: "${c.needle}" ${present ? 'present' : 'ABSENT'}`);
  }
  console.log('');

  /* ----- structural sha ---------------------------------------------------
   * Hash a redacted copy of the HTML where the three LLM-prose spans are
   * replaced with a fixed sentinel. The redaction targets exactly:
   *
   *   <p class="memo-prose">…</p>                          (executiveSummary)
   *   <p class="memo-prose memo-prose-with-table">…</p>    (redFlagAssessment)
   *   <p class="memo-prose">…</p>                          (committeeRecommendation)
   *
   * Inserted by build-committee-memo.ts:172, :493, :501. No other element in
   * the rendered HTML carries the `memo-prose` class on a <p> tag (the CSS
   * block at build-committee-memo.ts:599-600 declares `.memo-prose` and
   * `.memo-prose-with-table` selectors; those are not <p class="…"> matches
   * and are not redacted — they stay in the structural surface).
   *
   * The structural sha covers the deterministic remainder: header / chip /
   * date / attribution / stressed-credit-profile table cells / restructuring
   * callouts (cut + L′ + reserve target figures) / mitigation_suggestions
   * (deterministic v1.5+ surface) / findings table / footer / CSS / engine
   * version footer / disclosure lines.
   * ------------------------------------------------------------------------ */
  const NARRATIVE_PROSE_SPAN = /<p class="memo-prose[^"]*">[\s\S]*?<\/p>/g;
  const structuralHtml = html.replace(NARRATIVE_PROSE_SPAN, '<p class="memo-prose">[NARRATIVE_REDACTED]</p>');
  const fullSha = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
  const structuralSha = crypto.createHash('sha256').update(structuralHtml, 'utf8').digest('hex');
  const proseSpanCount = (html.match(NARRATIVE_PROSE_SPAN) ?? []).length;

  /* ----- SUMMARY ----- */
  console.log('================================================================');
  console.log('SUMMARY');
  console.log('================================================================');
  console.log(`  Cross-checks:           ${allOk ? '✓ ALL PASS' : '✗ FAIL'}`);
  console.log(`  Single LTV basis:       ${basisClean ? '✓ 65.34% / 40.90% absent' : '✗ appraised LTV leaked'}`);
  console.log(`  Restructuring section:  ${reconOk ? '✓ centerpiece structure present' : '✗ centerpiece elements missing'}`);
  console.log(`  Memo HTML:              ${OUT_HTML}`);
  console.log(`  Bytes:                  ${html.length.toLocaleString()}`);
  console.log('');
  console.log('================================================================');
  console.log('HASHES — structural (gated) + full (informational, drifts on every run)');
  console.log('================================================================');
  console.log(`  Narrative prose spans redacted:  ${proseSpanCount} (expected 3)`);
  console.log(`  Structural sha256 (PINNED GATE): ${structuralSha}`);
  console.log(`  Full HTML sha256 (informational): ${fullSha}`);
  console.log('');
  console.log(`  To view & print:        open ${OUT_HTML}`);
  console.log(`                          (cmd-P in any browser → Save as PDF)`);
  console.log('');

  /* ----- enforced gate -----
   * Exit non-zero on any of:
   *   - structural sha drifts from the pinned baseline
   *   - prose-span count drifts from 3 (template added/removed a slot)
   *   - cross-checks / single-LTV-basis / restructuring-section checks fail
   * The gate is LOCAL-ONLY: the harness needs a live API key and is not
   * CI-runnable today. CI-gating awaits cache-first determinism, a
   * deferred production-semantics decision.
   */
  const failures: string[] = [];
  if (proseSpanCount !== 3) {
    failures.push(`prose-span count ${proseSpanCount} ≠ 3 (template drift; the gate's redaction definition may be stale)`);
  }
  if (structuralSha !== EXPECTED_STRUCTURAL_SHA) {
    failures.push(`structural sha drift\n    expected: ${EXPECTED_STRUCTURAL_SHA}\n    actual:   ${structuralSha}`);
  }
  if (!allOk)      failures.push('structural cross-checks (numbers + subordination prose) failed');
  if (!basisClean) failures.push('appraised-LTV tokens leaked into single-LTV-basis check');
  if (!reconOk)    failures.push('restructuring centerpiece elements missing');

  if (failures.length > 0) {
    console.error('================================================================');
    console.error('✗ GATE FAILED');
    console.error('================================================================');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log('✓ GATE PASSED');
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(e); process.exit(1); });

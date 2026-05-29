/**
 * Anchor-fixture builder: synthetic HandbookEvaluation literal for Piece A
 * Phase 1's empirical-verification anchor.
 *
 * Path (W) — synthetic literal — per upcoming SPEC v21 §14.4 v20 Decision 4
 * layered-note reframing. Original v17 §14.4 Decision 4 specified pipeline-run
 * against Sunroad's CF + ASR + PCA fixtures as the anchor source. Empirical
 * recon during Phase 0 surfaced that the wired pipeline produces a degenerate
 * HandbookEvaluation (0 fired flags, field-bag of 6 keys vs 31-baseline)
 * because PropertyMetadata + rent-roll-driven stress fields aren't extracted
 * from Sunroad's currently-available fixtures (minimal-ASR is too thin for
 * PropertyMetadata; no rent-roll exists). LOAN_TERMS tuning ($11M → $75M)
 * moved DSCR realistically (9.7x → 1.42x) but didn't change flag-firing —
 * confirming the root cause was field-bag thinness, not metric extremes.
 *
 * Path (W) pivot: synthetic HE literal rich-by-construction with 4 controlled
 * flag-firing patterns spanning the InjectionPoint surface. Piece A's
 * format-flags utility test surface gets the variation it needs (executive_
 * summary-targeting vs filtered-out; multiple severities; multiple trigger
 * shapes). The narrative producer's structural-assertion tests work on this
 * shape; whether the flags came from a real engine run or synthetic
 * construction is invisible at the consuming surface.
 *
 * Synthesis-vs-name divergence (honest acknowledgment): the fixture is named
 * "sunroad-centrum" because it inherits the deal-anchor label, but
 * property_sub_type is set to "Medical Office" to make P-II-8 (specialty
 * assets) fire synthetically. Asset type stays Office. Sunroad-Centrum-CMBS
 * parity is NOT a fixture goal here — the fixture's purpose is exercising
 * Piece A's format-flags utility test surface, not accurately describing
 * Sunroad. Anyone reading this anchor for substantive Sunroad-deal claims
 * should look at the actual CF/PCA fixtures, not this synthetic HE.
 *
 * 4 fired flags constructed:
 *   P-II-3       critical    cash_out_amount = 8500000           4 IPs (all)
 *   P-II-8       high        property_sub_type = "Medical Office" 3 IPs
 *   P-IV-OFF-2   high        building_class = "B"                 2 IPs
 *   P-IV-OFF-9   high        msa = "Washington DC"                2 IPs
 *
 * InjectionPoint distribution:
 *   - executive_summary: 2 flags (P-II-3 + P-II-8)
 *   - red_flag_assessment: 4 flags (all)
 *   - mitigation_suggestions: 1 flag (P-II-3 only)
 *   - committee_recommendation: 4 flags (all)
 *
 * Cadence: run-once per fixture-refresh; static JSON committed; no CI
 * ANTHROPIC_API_KEY dependency. Regeneration workflow: re-run this script +
 * commit the resulting JSON.
 *
 * Usage:
 *   tsx src/scripts/build-sunroad-handbook-anchor.ts
 */

import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDBOOK_ENGINE_VERSION } from '@cre/contracts';
import type {
  AdjustedInputsId,
  FieldBag,
  FiredFlag,
  HandbookEvaluation,
  ISODateTime,
} from '@cre/contracts';
import { handbook } from '@cre/handbook-data';
import { computeHandbookEvaluationId } from '../util/content-hash.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_FIXTURE = path.resolve(SCRIPT_DIR, '../../fixtures/sunroad-centrum-handbook-evaluation.json');

// Fixed timestamp aligned with v20 ship date for fixture determinism — re-runs
// of this script produce byte-identical output (same content-hash id) so long
// as the literal contents below stay unchanged.
const AS_OF: ISODateTime = '2026-06-13T00:00:00.000Z' as ISODateTime;

// Synthetic adjustedInputsId sentinel — visually distinct as fixture-placeholder
// per Q-W3a (p). Mirrors test-build-and-ingest-e2e.ts's pattern for synthetic
// FK content-hash slots (e.g., approvedDealsTableHash: 'a'.repeat(64)).
const SYNTHETIC_ADJUSTED_INPUTS_ID = 'a'.repeat(64) as AdjustedInputsId;

/* ---------------------------- 4 fired flags ------------------------------- */

const firedFlags: readonly FiredFlag[] = [
  // P-II-3 — universal, critical, cash-out refinance scrutiny.
  // Native IPs: 4 (all injection points).
  {
    principleId: 'P-II-3',
    severity: 'critical',
    flag_message: 'Cash-out refinance of $8.5M elevates risk; scrutiny warranted.',
    metricValue: 8_500_000,
    groupIndex: 0,
    bandIndex: 0,
    injectionPoints: [
      'executive_summary',
      'red_flag_assessment',
      'mitigation_suggestions',
      'committee_recommendation',
    ],
  },
  // P-II-8 — universal, high, specialized asset.
  // Native IPs: 3 (executive_summary + red_flag_assessment + committee_recommendation;
  // no mitigation_suggestions).
  {
    principleId: 'P-II-8',
    severity: 'high',
    flag_message: 'Medical Office subtype falls within specialty-assets category.',
    metricValue: 'Medical Office',
    groupIndex: 0,
    bandIndex: 0,
    injectionPoints: [
      'executive_summary',
      'red_flag_assessment',
      'committee_recommendation',
    ],
  },
  // P-IV-OFF-2 — Office-specific, high, Class B/C leasing-costs + liquidity.
  // Native IPs: 2 (red_flag_assessment + committee_recommendation; no
  // executive_summary — exercises format-flags filter-out for Phase 1).
  {
    principleId: 'P-IV-OFF-2',
    severity: 'high',
    flag_message: 'Class B office; elevated leasing costs and liquidity risk.',
    metricValue: 'B',
    groupIndex: 0,
    bandIndex: 0,
    injectionPoints: ['red_flag_assessment', 'committee_recommendation'],
  },
  // P-IV-OFF-9 — Office-specific, high, submarket distress.
  // Native IPs: 2 (same as P-IV-OFF-2).
  {
    principleId: 'P-IV-OFF-9',
    severity: 'high',
    flag_message: 'Washington DC submarket showing office distress signals.',
    metricValue: 'Washington DC',
    groupIndex: 0,
    bandIndex: 0,
    injectionPoints: ['red_flag_assessment', 'committee_recommendation'],
  },
];

/* ---------------------------- field-bag snapshot -------------------------- */

// Combined per Q-W3c (t): realistic Sunroad-pipeline-extracted values from
// the prior Phase 0 run (DSCR 1.42, debt-yield 0.114, loan $75M, capex
// projection 12-year array, reserves 0, asset Office) + the 4 flag-trigger
// fields each fired flag references. Total 10 keys.
const fieldBagSnapshot: FieldBag = {
  // From prior pipeline-run (Sunroad CF + minimal-ASR + Sunroad PCA, $75M loan)
  asset_type: 'Office',
  dscr: 1.4226652108976134,
  debt_yield: 0.11358032575377598,
  loan_amount: 75_000_000,
  capex_projection: [
    // 12-year capex projection extracted from Sunroad PCA in prior run. Values
    // here are placeholder (exact values not load-bearing for Piece A tests).
    100_000, 105_000, 110_000, 115_000, 120_000, 125_000,
    130_000, 135_000, 140_000, 145_000, 150_000, 155_000,
  ],
  reserves: 0,
  // From the 4 synthetic fired flags' trigger conditions
  cash_out_amount: 8_500_000,
  property_sub_type: 'Medical Office',
  building_class: 'B',
  msa: 'Washington DC',
};

/* ------------------------- HandbookEvaluation literal --------------------- */

const heBody = {
  analysisAsOfDate: AS_OF,
  adjustedInputsId: SYNTHETIC_ADJUSTED_INPUTS_ID,
  handbookVersion: handbook.version,
  engineVersion: HANDBOOK_ENGINE_VERSION,
  firedFlags,
  skippedPrinciples: [],
  fieldBagSnapshot,
};

const he: HandbookEvaluation = {
  id: computeHandbookEvaluationId(heBody),
  ...heBody,
};

/* --------------------------------- run ------------------------------------ */

console.log('=== Sunroad-Centrum synthetic HandbookEvaluation anchor build (Path W) ===\n');

console.log(`HE id:           ${he.id}`);
console.log(`handbookVersion: ${he.handbookVersion}`);
console.log(`engineVersion:   ${he.engineVersion}`);
console.log(`analysisAsOfDate: ${he.analysisAsOfDate}`);
console.log(`adjustedInputsId (synthetic sentinel): ${he.adjustedInputsId}`);

console.log(`\nFired flags: ${he.firedFlags.length}`);
for (const f of he.firedFlags) {
  console.log(`  ${f.principleId.padEnd(12)} ${f.severity.padEnd(9)} ips=[${f.injectionPoints.join(', ')}]`);
  console.log(`    metricValue: ${JSON.stringify(f.metricValue)}`);
  console.log(`    flag_message: "${f.flag_message}"`);
}

console.log(`\nInjectionPoint distribution:`);
const ipCount = new Map<string, number>();
for (const f of he.firedFlags) {
  for (const ip of f.injectionPoints) {
    ipCount.set(ip, (ipCount.get(ip) ?? 0) + 1);
  }
}
for (const [ip, count] of [...ipCount.entries()].sort()) {
  console.log(`  ${ip.padEnd(28)} ${count}`);
}

console.log(`\nField-bag snapshot keys (${Object.keys(he.fieldBagSnapshot).length}):`);
for (const k of Object.keys(he.fieldBagSnapshot).sort()) {
  const v = he.fieldBagSnapshot[k];
  const summary = Array.isArray(v) ? `[${v.length} items]` : JSON.stringify(v);
  console.log(`  ${k.padEnd(20)} ${summary}`);
}

console.log(`\nSkipped principles: ${he.skippedPrinciples.length} (empty array — Phase 1 tests don't consume)`);

console.log(`\nWriting fixture to ${OUT_FIXTURE} ...`);
writeFileSync(OUT_FIXTURE, JSON.stringify(he, null, 2) + '\n');
const written = readFileSync(OUT_FIXTURE);
console.log(`  ${written.length} bytes written`);

console.log('\n=== Done ===');

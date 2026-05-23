/**
 * End-to-end smoke test: synthetic deal → assembler → engine → fired flags.
 *
 * Proves the assembler's output is consumable by the engine for real
 * principles. Validates two scenarios chosen to exercise the populated
 * fields:
 *
 *   Scenario A: Office deal with weak metrics
 *     - Class B building, 30 years old, $30M loan, 0.85 stressed DSCR
 *     - Expect: P-IV-OFF-2 fires (Class B office), P-IV-OFF-6 fires
 *       (stressed DSCR < 1.0), various others may skip with
 *       missing_field for unimplemented data sources
 *
 *   Scenario B: Single-tenant deal with sponsor's dark value blocked
 *     - Single-Tenant tenancy, but appraised_dark_value not extracted
 *     - Expect: P-IV-ST-1 (LLM_CONTEXT only, no deterministic check;
 *       skip with 'not_deterministic'); P-IV-ST-4 (deterministic but
 *       trigger requires field_exists appraised_dark_value) skips with
 *       'trigger_inactive'
 *
 * INTEGRATION NOTE FOR CC: this smoke test runs against a private copy
 * of the engine in /home/claude/field-bag-assembler/_real-engine/. At
 * integration, swap to:
 *   import { handbook } from '@cre/handbook-data';
 *   import { evaluateHandbook } from '@cre/handbook-engine';
 */

import { buildFieldBag } from '../services/handbook/assembler.js';
import type { AssemblerInputs } from '../services/handbook/assembler.js';

import { handbook } from '@cre/handbook-data';
import { evaluateHandbook } from '@cre/handbook-engine';

// =============================================================================
// Hand-rolled test runner
// =============================================================================

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

function assertFlagFired(
  result: ReturnType<typeof evaluateHandbook>,
  principleId: string,
  m: string,
): void {
  const fired = result.firedFlags.find((f) => f.principleId === principleId);
  if (fired) {
    ok(m);
  } else {
    const skipped = result.skippedPrinciples.find(
      (s) => s.principleId === principleId,
    );
    fail(
      `${m} (principle ${principleId} did not fire; skip reason: ${skipped?.reason ?? 'unknown'})`,
    );
  }
}

function assertFlagSkippedWith(
  result: ReturnType<typeof evaluateHandbook>,
  principleId: string,
  expectedReason: string,
  m: string,
): void {
  const skipped = result.skippedPrinciples.find(
    (s) => s.principleId === principleId,
  );
  const fired = result.firedFlags.find((f) => f.principleId === principleId);
  if (fired) {
    fail(`${m} (principle ${principleId} unexpectedly fired)`);
  } else if (skipped && skipped.reason === expectedReason) {
    ok(m);
  } else {
    fail(
      `${m} (expected skip reason '${expectedReason}', got '${skipped?.reason ?? 'NOT_FOUND'}')`,
    );
  }
}

// =============================================================================
// Scenario A: Office deal with weak metrics
// =============================================================================

console.log('\n=== Scenario A: Office deal with weak metrics ===');

(() => {
  const inputs = ({
    graph: {
      adjustedInputs: {
        loan: {
          loanAmount: { raw: 30_000_000, adjusted: 30_000_000 },
        },
        metrics: { dscr: 1.20, debtYield: 0.085 },
      },
      assetProfile: { propertyType: 'Office' },
      narrativeFacts: {
        isSingleTenant: false,
        pipBudgetPerKey: null,
        parkOwnedHomesPct: null,
      },
      stressOutputs: {
        method: 'TENANT_REMOVAL',
        scenarios: [
          { name: 'Remove T1', dscr: 1.10 },
          { name: 'Remove T1+T2', dscr: 0.95 },
          { name: 'Remove T1+T2+T3', dscr: 0.85 }, // < 1.0 should fire P-IV-OFF-6
        ],
      },
    },
    propertyMetadata: {
      propertySubtype: 'Suburban Office',
      buildingClass: 'B',
      msa: 'Atlanta-Sandy Springs-Alpharetta, GA MSA',
      yearBuilt: 1996,
      yearRenovated: null,
    },
    asOfDate: new Date('2026-01-01'),
  }) as unknown as AssemblerInputs;

  const bag = buildFieldBag(inputs);
  const result = evaluateHandbook(handbook, bag);

  console.log(
    `  info  ${result.firedFlags.length} flags fired, ${result.skippedPrinciples.length} principles skipped`,
  );

  // P-IV-OFF-2: Class B office assets
  assertFlagFired(result, 'P-IV-OFF-2', 'P-IV-OFF-2 fires for Class B office');

  // P-IV-OFF-6: stressed DSCR < 1.0
  assertFlagFired(
    result,
    'P-IV-OFF-6',
    'P-IV-OFF-6 fires when stressed_dscr_top_3_removed < 1.0',
  );

  // Sanity: P-IV-ST-4 (single-tenant dark value) should not fire because
  // tenancy is multi-tenant
  assertFlagSkippedWith(
    result,
    'P-IV-ST-4',
    'trigger_inactive',
    'P-IV-ST-4 trigger inactive for multi-tenant deal',
  );
})();

// =============================================================================
// Scenario B: Single-tenant deal with blocked dark value
// =============================================================================

console.log('\n=== Scenario B: Single-tenant deal with blocked dark value ===');

(() => {
  const inputs = ({
    graph: {
      adjustedInputs: {
        loan: {
          loanAmount: { raw: 15_000_000, adjusted: 15_000_000 },
        },
        metrics: { dscr: 1.45, debtYield: 0.11 },
      },
      assetProfile: { propertyType: 'Industrial' },
      narrativeFacts: {
        isSingleTenant: true,
        pipBudgetPerKey: null,
        parkOwnedHomesPct: null,
      },
      stressOutputs: {
        method: 'DEFAULT', // fallback because single-tenant industrial lacks rent roll
        scenarios: [],
      },
    },
    propertyMetadata: {
      propertySubtype: 'Distribution',
      buildingClass: null,
      msa: 'Dallas-Fort Worth-Arlington, TX MSA',
      yearBuilt: 2018,
      yearRenovated: null,
    },
    asOfDate: new Date('2026-01-01'),
  }) as unknown as AssemblerInputs;

  const bag = buildFieldBag(inputs);
  const result = evaluateHandbook(handbook, bag);

  console.log(
    `  info  ${result.firedFlags.length} flags fired, ${result.skippedPrinciples.length} principles skipped`,
  );

  // P-IV-ST-4 trigger requires both tenancy_type=Single-Tenant AND
  // appraised_dark_value to exist. Tenancy is Single-Tenant, but
  // appraised_dark_value is not populated → trigger fails.
  assertFlagSkippedWith(
    result,
    'P-IV-ST-4',
    'trigger_inactive',
    'P-IV-ST-4 trigger inactive when dark value missing',
  );

  // P-IV-ST-1 has no deterministic check (LLM_CONTEXT only) → not_deterministic
  assertFlagSkippedWith(
    result,
    'P-IV-ST-1',
    'not_deterministic',
    'P-IV-ST-1 (LLM_CONTEXT only) skips as not_deterministic',
  );

  // Top-3 removed DSCR was not produced (DEFAULT stress method),
  // so P-IV-OFF-6 should skip with missing_field. But P-IV-OFF-6 trigger
  // is field_equals(asset_type, 'Office'), and this deal is Industrial,
  // so it actually skips at trigger.
  assertFlagSkippedWith(
    result,
    'P-IV-OFF-6',
    'trigger_inactive',
    'P-IV-OFF-6 trigger inactive for non-Office deal',
  );
})();

// =============================================================================
// Scenario C: PropertyMetadata absent
// =============================================================================

console.log('\n=== Scenario C: PropertyMetadata absent ===');

(() => {
  const inputs = ({
    graph: {
      adjustedInputs: {
        loan: { loanAmount: { raw: 5_000_000, adjusted: 5_000_000 } },
        metrics: { dscr: 1.50, debtYield: 0.12 },
      },
      assetProfile: { propertyType: 'SelfStorage' },
      narrativeFacts: {
        isSingleTenant: false,
        pipBudgetPerKey: null,
        parkOwnedHomesPct: null,
      },
      stressOutputs: {
        method: 'OCC_RENT_CONCESSION',
        scenarios: [{ name: 'Occ_down_10', dscr: 1.30 }],
      },
    },
    propertyMetadata: null, // ← critical: PropertyMetadata absent
    asOfDate: new Date('2026-01-01'),
  }) as unknown as AssemblerInputs;

  const bag = buildFieldBag(inputs);
  const result = evaluateHandbook(handbook, bag);

  console.log(
    `  info  ${result.firedFlags.length} flags fired, ${result.skippedPrinciples.length} principles skipped (PropertyMetadata=null)`,
  );

  // We can still evaluate principles that don't depend on metadata.
  // dscr is in the bag (from adjusted inputs), so trigger-based skips
  // tied to asset_type='SelfStorage' should evaluate fine.
  // P-IV-SS-4 checks dscr < 1.30 — our dscr is 1.50, so doesn't fire,
  // but it should skip with 'no_band_matched', not 'missing_field'.
  assertFlagSkippedWith(
    result,
    'P-IV-SS-4',
    'no_band_matched',
    'P-IV-SS-4: bag-populated dscr=1.50 does not fire (correct), confirms metadata absence does not break non-metadata principles',
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
}
process.exit(failed > 0 ? 1 : 0);

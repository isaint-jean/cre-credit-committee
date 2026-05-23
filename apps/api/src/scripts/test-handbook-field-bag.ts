/**
 * Field-bag assembler tests.
 *
 * Hand-rolled assertEqual/ok pattern matching the rest of the workspace
 * (apps/api/src/scripts/test-ingest-pipeline.ts, etc.). Each test builds
 * minimal inline fixtures.
 *
 * Coverage:
 *   - One test per populated field path: trivially correct projection
 *     or derivation
 *   - PropertyMetadata null-tolerance: full set of metadata-derived
 *     fields returns undefined when metadata is null
 *   - Boolean → categorical mapping for tenancy_type (all three cases)
 *   - Defensive numeric edge cases (negative ages, non-finite years)
 *   - StressOutputs scenario lookup (present, present-but-null, absent)
 *   - Partition invariant: KNOWN_FIELDS = POPULATED ∪ INTENTIONALLY_UNDEFINED
 *   - Bag surface invariant: bag keys equal KNOWN_FIELDS
 *
 * The build-time lint test (assertNoUnknownFields against the real
 * handbook) lives in a SEPARATE test file so CI can run them
 * independently — see test-handbook-field-bag-known-fields.ts.
 */

import { buildFieldBag } from '../services/handbook/assembler.js';
import {
  KNOWN_FIELDS,
  POPULATED_FIELDS,
  INTENTIONALLY_UNDEFINED_FIELDS,
} from '../services/handbook/assembler.js';
import type { AssemblerInputs } from '../services/handbook/assembler.js';
import type {
  HydratedRecordGraph,
  PropertyMetadata,
  StressScenarioOutput,
} from '@cre/contracts';

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

function assertEqual<T>(actual: T, expected: T, m: string): void {
  if (actual === expected) {
    ok(m);
  } else {
    fail(
      `${m} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`,
    );
  }
}

function assertSetEqual<T>(
  actual: ReadonlySet<T>,
  expected: ReadonlySet<T>,
  m: string,
): void {
  if (actual.size !== expected.size) {
    fail(`${m} (size mismatch: actual=${actual.size}, expected=${expected.size})`);
    return;
  }
  for (const v of expected) {
    if (!actual.has(v)) {
      fail(`${m} (expected element missing: ${JSON.stringify(v)})`);
      return;
    }
  }
  ok(m);
}

// =============================================================================
// Fixture builders
// =============================================================================

// Fixture builders construct minimal partial shapes that satisfy the
// assembler's actual reads. Full structural conformance to the real
// @cre/contracts types is unnecessary — the assembler only touches a
// handful of fields. Cast at the boundary, matching the workspace
// convention from test-ingest-pipeline.ts (`as ExtractionResult`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMinimalGraph(overrides: any = {}): HydratedRecordGraph {
  return {
    adjustedInputs: {
      loan: {
        loanAmount: { raw: 10_000_000, adjusted: 10_000_000 },
      },
      metrics: {
        dscr: 1.35,
        debtYield: 0.10,
      },
    },
    assetProfile: {
      propertyType: 'Office',
    },
    narrativeFacts: {
      isSingleTenant: false,
      pipBudgetPerKey: null,
      parkOwnedHomesPct: null,
    },
    stressOutputs: {
      method: 'TENANT_REMOVAL',
      scenarios: [],
    },
    ...overrides,
  } as unknown as HydratedRecordGraph;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMinimalMetadata(overrides: any = {}): PropertyMetadata {
  return {
    propertySubtype: 'CBD Office',
    buildingClass: 'A',
    msa: 'New York-Newark-Jersey City, NY-NJ-PA MSA',
    yearBuilt: 1995,
    yearRenovated: 2018,
    ...overrides,
  } as unknown as PropertyMetadata;
}

function makeInputs(
  overrides: Partial<AssemblerInputs> = {},
): AssemblerInputs {
  return {
    graph: makeMinimalGraph(),
    propertyMetadata: makeMinimalMetadata(),
    asOfDate: new Date('2026-01-01'),
    ...overrides,
  };
}

// =============================================================================
// Tests — direct projections
// =============================================================================

console.log('\n=== Direct projections from typed records ===');

(() => {
  const bag = buildFieldBag(makeInputs());
  assertEqual(bag['asset_type'], 'Office', 'asset_type from assetProfile.propertyType');
  assertEqual(bag['debt_yield'], 0.10, 'debt_yield from adjustedInputs.metrics');
  assertEqual(bag['dscr'], 1.35, 'dscr from adjustedInputs.metrics');
  assertEqual(bag['loan_amount'], 10_000_000, 'loan_amount from adjustedInputs.loan');
  assertEqual(
    bag['msa'],
    'New York-Newark-Jersey City, NY-NJ-PA MSA',
    'msa from propertyMetadata',
  );
  assertEqual(bag['building_class'], 'A', 'building_class from propertyMetadata');
  assertEqual(
    bag['property_sub_type'],
    'CBD Office',
    'property_sub_type renamed from propertyMetadata.propertySubtype',
  );
})();

// =============================================================================
// Tests — derivations
// =============================================================================

console.log('\n=== Derivations ===');

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ yearBuilt: 2000 }),
      asOfDate: new Date('2026-06-15'),
    }),
  );
  assertEqual(bag['building_age'], 26, 'building_age = asOf.year - yearBuilt');
})();

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ yearRenovated: 2020 }),
      asOfDate: new Date('2026-06-15'),
    }),
  );
  assertEqual(
    bag['years_since_last_renovation'],
    6,
    'years_since_last_renovation = asOf.year - yearRenovated',
  );
})();

// =============================================================================
// Tests — tenancy_type categorical mapping (all three cases)
// =============================================================================

console.log('\n=== tenancy_type boolean → categorical mapping ===');

(() => {
  const graph = makeMinimalGraph({
    narrativeFacts: {
      isSingleTenant: true,
      pipBudgetPerKey: null,
      parkOwnedHomesPct: null,
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(bag['tenancy_type'], 'Single-Tenant', 'isSingleTenant=true → Single-Tenant');
})();

(() => {
  const graph = makeMinimalGraph({
    narrativeFacts: {
      isSingleTenant: false,
      pipBudgetPerKey: null,
      parkOwnedHomesPct: null,
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(bag['tenancy_type'], 'Multi-Tenant', 'isSingleTenant=false → Multi-Tenant');
})();

(() => {
  const graph = makeMinimalGraph({
    narrativeFacts: {
      isSingleTenant: null,
      pipBudgetPerKey: null,
      parkOwnedHomesPct: null,
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(bag['tenancy_type'], undefined, 'isSingleTenant=null → undefined');
})();

// =============================================================================
// Tests — PropertyMetadata null-tolerance
// =============================================================================

console.log('\n=== PropertyMetadata null-tolerance ===');

(() => {
  const bag = buildFieldBag(makeInputs({ propertyMetadata: null }));
  // All five metadata-derived fields collapse to undefined
  assertEqual(bag['msa'], undefined, 'msa undefined when propertyMetadata=null');
  assertEqual(
    bag['building_class'],
    undefined,
    'building_class undefined when propertyMetadata=null',
  );
  assertEqual(
    bag['property_sub_type'],
    undefined,
    'property_sub_type undefined when propertyMetadata=null',
  );
  assertEqual(
    bag['building_age'],
    undefined,
    'building_age undefined when propertyMetadata=null',
  );
  assertEqual(
    bag['years_since_last_renovation'],
    undefined,
    'years_since_last_renovation undefined when propertyMetadata=null',
  );
  // Direct-projection fields from the graph still populate
  assertEqual(
    bag['asset_type'],
    'Office',
    'asset_type still populated when propertyMetadata=null',
  );
  assertEqual(bag['dscr'], 1.35, 'dscr still populated when propertyMetadata=null');
})();

// =============================================================================
// Tests — partial PropertyMetadata
// =============================================================================

console.log('\n=== Partial PropertyMetadata (individual null fields) ===');

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ yearBuilt: null }),
    }),
  );
  assertEqual(
    bag['building_age'],
    undefined,
    'building_age undefined when yearBuilt is null',
  );
  // Other metadata fields still populate
  assertEqual(bag['msa'], 'New York-Newark-Jersey City, NY-NJ-PA MSA', 'msa unaffected');
})();

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ msa: null, buildingClass: null }),
    }),
  );
  assertEqual(bag['msa'], undefined, 'msa undefined when individually null');
  assertEqual(
    bag['building_class'],
    undefined,
    'building_class undefined when individually null',
  );
})();

// =============================================================================
// Tests — defensive numeric edge cases
// =============================================================================

console.log('\n=== Defensive numeric edge cases ===');

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ yearBuilt: 2030 }),
      asOfDate: new Date('2026-01-01'),
    }),
  );
  assertEqual(
    bag['building_age'],
    undefined,
    'building_age undefined when yearBuilt is in the future (negative result)',
  );
})();

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ yearBuilt: Number.NaN }),
    }),
  );
  assertEqual(
    bag['building_age'],
    undefined,
    'building_age undefined when yearBuilt is NaN',
  );
})();

(() => {
  const bag = buildFieldBag(
    makeInputs({
      propertyMetadata: makeMinimalMetadata({ yearRenovated: 2030 }),
      asOfDate: new Date('2026-01-01'),
    }),
  );
  assertEqual(
    bag['years_since_last_renovation'],
    undefined,
    'years_since_last_renovation undefined when yearRenovated is in the future',
  );
})();

// =============================================================================
// Tests — StressOutputs scenario lookup
// =============================================================================

console.log('\n=== stressed_dscr_top_3_removed lookup ===');

const top3Scenario = {
  name: 'Remove T1+T2+T3',
  dscr: 0.85,
} as unknown as StressScenarioOutput;

(() => {
  const graph = makeMinimalGraph({
    stressOutputs: {
      method: 'TENANT_REMOVAL',
      scenarios: [
        { name: 'Remove T1', dscr: 1.15 },
        { name: 'Remove T1+T2', dscr: 1.00 },
        top3Scenario,
      ],
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(
    bag['stressed_dscr_top_3_removed'],
    0.85,
    'top-3 scenario present with numeric dscr → projected',
  );
})();

(() => {
  const graph = makeMinimalGraph({
    stressOutputs: {
      method: 'TENANT_REMOVAL',
      scenarios: [
        { name: 'Remove T1+T2+T3', dscr: null }, // measurement failed
      ],
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(
    bag['stressed_dscr_top_3_removed'],
    undefined,
    'top-3 scenario present but dscr null → undefined',
  );
})();

(() => {
  const graph = makeMinimalGraph({
    stressOutputs: {
      method: 'OCC_RENT_CONCESSION',
      scenarios: [
        { name: 'Occ_down_10', dscr: 1.05 },
      ],
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(
    bag['stressed_dscr_top_3_removed'],
    undefined,
    'top-3 scenario absent (wrong stress method) → undefined',
  );
})();

// =============================================================================
// Tests — pip_reserve_per_key remapping (handbook name ≠ NarrativeFacts name)
// =============================================================================

console.log('\n=== pip_reserve_per_key remapping ===');

(() => {
  const graph = makeMinimalGraph({
    narrativeFacts: {
      isSingleTenant: false,
      pipBudgetPerKey: 12500,
      parkOwnedHomesPct: null,
    },
  });
  const bag = buildFieldBag(makeInputs({ graph }));
  assertEqual(
    bag['pip_reserve_per_key'],
    12500,
    'pip_reserve_per_key projected from pipBudgetPerKey',
  );
})();

// =============================================================================
// Tests — intentionally-undefined fields
// =============================================================================

console.log('\n=== Intentionally-undefined fields ===');

(() => {
  const bag = buildFieldBag(makeInputs());
  // Spot-check several intentionally-undefined fields. We can't enumerate all 17
  // here without duplicating the set definition; the partition test below covers
  // the full surface.
  for (const path of [
    'appraised_dark_value',
    'cash_out_amount',
    'hotel_service_level',
    'mall_class',
    'noi_projection',
    'tenant_categories',
    'utility_infrastructure_type',
  ]) {
    assertEqual(
      bag[path],
      undefined,
      `${path} returns undefined (intentionally not implemented in v1)`,
    );
  }
})();

// =============================================================================
// Tests — partition and surface invariants
// =============================================================================

console.log('\n=== Partition and surface invariants ===');

(() => {
  // POPULATED ∪ INTENTIONALLY_UNDEFINED = KNOWN_FIELDS
  const union = new Set<string>();
  for (const f of POPULATED_FIELDS) union.add(f);
  for (const f of INTENTIONALLY_UNDEFINED_FIELDS) union.add(f);
  assertSetEqual(union, KNOWN_FIELDS, 'POPULATED ∪ INTENTIONALLY_UNDEFINED = KNOWN_FIELDS');
})();

(() => {
  // POPULATED ∩ INTENTIONALLY_UNDEFINED = ∅
  let overlap = 0;
  for (const f of POPULATED_FIELDS) {
    if (INTENTIONALLY_UNDEFINED_FIELDS.has(f)) overlap++;
  }
  assertEqual(overlap, 0, 'POPULATED and INTENTIONALLY_UNDEFINED are disjoint');
})();

(() => {
  // Bag surface = KNOWN_FIELDS
  const bag = buildFieldBag(makeInputs());
  const bagKeys = new Set(Object.keys(bag));
  assertSetEqual(bagKeys, KNOWN_FIELDS, 'bag keys equal KNOWN_FIELDS');
})();

(() => {
  // Tally — assert exact counts so accidental changes show up in CI
  assertEqual(KNOWN_FIELDS.size, 31, 'KNOWN_FIELDS has 31 entries');
  assertEqual(POPULATED_FIELDS.size, 13, 'POPULATED_FIELDS has 13 entries');
  assertEqual(
    INTENTIONALLY_UNDEFINED_FIELDS.size,
    18,
    'INTENTIONALLY_UNDEFINED_FIELDS has 18 entries',
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

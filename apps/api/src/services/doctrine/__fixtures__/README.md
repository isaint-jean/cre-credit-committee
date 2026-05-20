# Lint policy fixtures (negative tests)

These files **deliberately violate** the architectural-boundary policies
defined in `.dependency-cruiser.cjs` and `eslint.config.mjs`. They exist as
permanent regression-test infrastructure to verify that those policies still
fire on forbidden imports.

## Why under `services/doctrine/`?

The dependency-cruiser rule `no-extraction-in-non-judgment-producers` matches
files whose path starts with `apps/api/src/services/doctrine/`. To verify the
rule fires, the fixture must live at a path the rule scans. Fixtures live in
mirror locations under each producer dir whose rules they exercise.

## How they're isolated from normal runs

- **`.dependency-cruiser.cjs`** excludes `/__fixtures__/` from the default scan.
- **`eslint.config.mjs`** excludes `**/__fixtures__/**` from the default scan.
- **`apps/api/tsconfig.json`** excludes `**/__fixtures__/**` from the build.

This means `npm run lint:boundaries`, `npm run build`, and `tsc` all ignore
these files. The negative test (`apps/api/src/scripts/test-extraction-isolation.ts`)
explicitly invokes the lint tools against the fixture directory with the
exclude removed and asserts the expected violations.

## Fixtures

| File | Forbidden because |
|---|---|
| `forbidden-extraction-import.fixture.ts` | imports `ExtractionResult` from `@cre/contracts` inside a doctrine producer (architecture §2.3) |
| `forbidden-adapter-import.fixture.ts` | imports `analysis-to-adjusted-inputs.adapter.ts` from a new-spine module (architecture §D7 HARD INVARIANT) |

## Rule of thumb for new fixtures

When a new architectural boundary is enforced (later sub-batches will add
render-layer rules, resolver-purity rules, etc.), add a corresponding fixture
here that exercises the rule. The negative test should grow accordingly.

A boundary policy without a negative test rots silently — when the rule
syntax changes or the policy is accidentally weakened, only the negative test
catches it.

/**
 * ESLint flat config — Batch 6 sub-batch 6.0
 *
 * Scope: ARCHITECTURAL BOUNDARY ENFORCEMENT ONLY.
 *
 * This config does NOT do general code-style linting. Its sole job is to
 * mechanically enforce the import-symbol restrictions from the architecture
 * doctrine (docs/architecture/batch6-record-graph-and-resolution.md rev 2).
 *
 * Why ESLint in addition to dependency-cruiser:
 *   dep-cruiser matches whole modules. ESLint's no-restricted-imports with
 *   `importNames` matches NAMED SYMBOLS — needed because @cre/contracts
 *   re-exports many types from one entry point. We want to forbid
 *   `import type { ExtractionResult } from '@cre/contracts'` in producers
 *   downstream of judgment, while still permitting `import type
 *   { AdjustedInputs } from '@cre/contracts'` in the same files.
 *
 * Rule status convention matches .dependency-cruiser.cjs: active rules are
 * exported; future-state rules are commented with their activation sub-batch.
 *
 * The `__fixtures__` directories are excluded from normal runs. The negative
 * test programmatically invokes ESLint with the fixtures included to verify
 * that the rules fire on deliberate violations.
 */

import tsParser from '@typescript-eslint/parser';

/** Symbols downstream of Stage 4 (judgment) MUST NOT import. */
const FORBIDDEN_EXTRACTION_SYMBOLS = [
  'ExtractionResult',
  'computeExtractionResultId',
];

const EXTRACTION_SYMBOL_RESTRICTION = {
  paths: [
    {
      name: '@cre/contracts',
      importNames: FORBIDDEN_EXTRACTION_SYMBOLS,
      message:
        '[architecture §2.3] ExtractionResult is read by Stage 1 (extraction), ' +
        'Stage 4 (judgment), Stage 11 (hydration), and the audit-tab render path only. ' +
        'Producers downstream of judgment must consume AdjustedInputs / NarrativeFacts / ' +
        'AssetProfile, not raw ExtractionResult. Move the derived value upstream into a ' +
        'judgment-engine rule with an explicit reason code.',
    },
  ],
};

/**
 * Glob set: every "downstream-of-judgment producer" — these consume the
 * outputs of Stage 4 onward, never the raw ExtractionResult.
 *
 * Judgment itself (apps/api/src/services/judgment/**) is INTENTIONALLY
 * EXCLUDED — it's the legitimate Stage 4 consumer.
 */
const DOWNSTREAM_PRODUCER_GLOBS = [
  'apps/api/src/services/doctrine/**/*.ts',
  'apps/api/src/services/valuation.service.ts',
  'apps/api/src/services/stress-test.service.ts',
  'apps/api/src/services/stress-test-contracts.service.ts',
  'apps/api/src/services/cross-check.service.ts',
  'apps/api/src/services/cross-check-contracts.service.ts',
  'apps/api/src/services/resolve-underwriting-context.ts',
  'apps/api/src/services/resolve-structural-variant.ts',
];

/** Globs that are excluded from normal runs entirely. */
const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/__fixtures__/**',
  '**/*.test.ts',
  '**/*.spec.ts',
  'apps/api/src/scripts/test-**',
  'apps/api/src/scripts/seed-**',
  'apps/api/src/scripts/check-**',
  'apps/api/src/scripts/print-**',
];

export default [
  {
    ignores: IGNORE_GLOBS,
  },
  {
    files: DOWNSTREAM_PRODUCER_GLOBS,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-restricted-imports': ['error', EXTRACTION_SYMBOL_RESTRICTION],
    },
  },
];

/*
 * FUTURE_RULES — promote when the corresponding sub-batch lands.
 *
 * sub-batch 6.7 — render layer cutover (after Audit 2 V1–V10 remediated):
 *   {
 *     files: [
 *       'apps/api/src/services/render.service.ts',
 *       'apps/api/src/services/render-schema.ts',
 *       'apps/api/src/services/render-migrations.ts',
 *       'apps/api/src/services/render-output-scrubber.ts',
 *       'apps/api/src/services/template-engine.service.ts',
 *       'apps/api/src/routes/render.routes.ts',
 *     ],
 *     rules: {
 *       'no-restricted-imports': ['error', {
 *         patterns: [
 *           { group: ['../services/judgment/**', '../services/doctrine/**',
 *                     '../services/valuation.service*', '../services/stress-test*',
 *                     '../services/cross-check*', '../services/extraction*',
 *                     '../services/data-extraction*', '../services/hydrate-*',
 *                     '../services/resolve-*', '../storage/**'],
 *             message: '[architecture §4.1 D1] Render imports nothing computational.' },
 *         ],
 *       }],
 *     },
 *   }
 */

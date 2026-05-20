/**
 * dependency-cruiser config — Batch 6 sub-batch 6.0
 *
 * Centralized architectural-boundary enforcement for the apps/api package.
 *
 * Source of truth for the rules: docs/architecture/batch6-record-graph-and-resolution.md
 * (revision 2). Each rule below cites the §-reference it operationalizes.
 *
 * Rule status convention:
 *   - active rules are exported in `forbidden`
 *   - future-state rules (will activate in a later sub-batch) are commented in
 *     the FUTURE_RULES block at the bottom with the activation sub-batch ID.
 *
 * Why some doctrine rules are NOT yet in `forbidden`:
 *   sub-batch 6.0 is config-only. Rules whose violations exist in current code
 *   (per audits 2 and 6) cannot be activated without behavior changes — those
 *   land in their respective remediation sub-batches (6.1, 6.2, 6.7, 6.8).
 *
 * The `__fixtures__` directories under apps/api/src are excluded from normal
 * runs (so `npm run lint:boundaries` is green on main) and explicitly scanned
 * by the negative test (apps/api/src/scripts/test-extraction-isolation.ts) via
 * the programmatic API to verify rules fire on deliberate violations.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-extraction-in-non-judgment-producers',
      severity: 'error',
      comment:
        '[architecture §2.3] ExtractionResult is read by Stage 1 (extraction), Stage 4 (judgment), Stage 11 (hydration), and the audit-tab render path only. Producers downstream of judgment (doctrine, valuation, stress, cross-check, resolver) MUST NOT depend on ExtractionResult or extraction services. Move the extraction-derived value upstream into AdjustedInputs, NarrativeFacts, AssetProfile, or a new judgment-engine rule with an explicit reason code.',
      from: {
        path:
          '^apps/api/src/services/(' +
          'doctrine/' +
          '|valuation\\.service' +
          '|stress-test\\.service' +
          '|stress-test-contracts\\.service' +
          '|cross-check\\.service' +
          '|cross-check-contracts\\.service' +
          '|resolve-underwriting-context' +
          '|resolve-structural-variant' +
          ')',
      },
      to: {
        path:
          '^apps/api/src/services/(' +
          'data-extraction\\.service' +
          '|document-parser\\.service' +
          '|excel-parser\\.service' +
          '|pdf-parser\\.service' +
          '|word-parser\\.service' +
          ')',
      },
    },
    {
      name: 'no-legacy-adapter-in-new-spine',
      severity: 'error',
      comment:
        '[architecture §D7 HARD INVARIANT] analysis-to-adjusted-inputs.adapter.ts is legacy-compatibility only. Its silent coercions (adjusted=0 defaults, confidenceReduction=0, rate-type defaults, IO-month defaults, line-item synthesis) MUST NOT pollute the graph-backed ingestion path. New-spine modules consume ExtractionResult directly via the judgment engine, preserving null fidelity and degraded-state signaling.',
      from: {
        path:
          '^apps/api/src/services/(' +
          'hydrate-underwriting-context' +
          '|doctrine/' +
          '|judgment/' +
          '|valuation\\.service' +
          '|stress-test\\.service' +
          '|stress-test-contracts\\.service' +
          '|cross-check\\.service' +
          '|cross-check-contracts\\.service' +
          ')',
      },
      to: {
        path: '^apps/api/src/services/analysis-to-adjusted-inputs\\.adapter',
      },
    },
    // `no-circular` is an obvious next guardrail but the current codebase has
    // one pre-existing cycle (field-migration-state.ts <-> render-schema.ts).
    // Adding the rule as `error` would fail green main; activating it is a
    // separate cleanup PR (tracked for sub-batch 6.7 alongside the render
    // boundary work, since one of the cycle modules is a render module).
    {
      name: 'render-no-producers',
      severity: 'error',
      comment:
        '[architecture §4.1 D1 + Batch 6.7 RD1] New-spine render modules consume only the typed UnderwritingContext (via @cre/contracts) plus formatting utilities. They MUST NOT import producers (judgment, doctrine, valuation, stress, cross-check, extraction, asset-profiler, library-snapshot, narrative-facts), stores, calculators, projection internals, hydration internals, the legacy adapter, or the legacy resolver. Route handlers are allowed to call hydrate + project (glue layer); the render service itself is strict.',
      from: {
        path:
          '^apps/api/src/services/(' +
          'render-(underwriting-context|sentinels)' +
          '|__fixtures__/render-forbidden-' +
          ')',
      },
      to: {
        path:
          '^apps/api/src/(' +
          'services/(' +
          'judgment/' +
          '|doctrine/' +
          '|valuation\\.service' +
          '|stress-test\\.service' +
          '|stress-test-contracts\\.service' +
          '|cross-check\\.service' +
          '|cross-check-contracts\\.service' +
          '|asset-profiler\\.service' +
          '|library-snapshot-producer\\.service' +
          '|narrative-facts\\.service' +
          '|ingest-extraction-result' +
          '|hydrate-record-graph' +
          '|hydrate-underwriting-context' +
          '|build-underwriting-context-projection' +
          '|resolve-underwriting-context' +
          '|resolve-structural-variant' +
          '|analysis-to-adjusted-inputs\\.adapter' +
          '|data-extraction\\.service' +
          '|document-parser\\.service' +
          '|excel-parser\\.service' +
          '|pdf-parser\\.service' +
          '|word-parser\\.service' +
          ')' +
          '|storage/' +
          ')',
      },
    },
    {
      name: 'render-no-clock-or-side-channels',
      severity: 'error',
      comment:
        '[architecture §B5 idempotency + Batch 6.7 RD4] New-spine render modules must be deterministic. No filesystem, no network, no OS reads. Same input -> byte-identical output, always.',
      from: {
        path:
          '^apps/api/src/services/(' +
          'render-(underwriting-context|sentinels)' +
          '|__fixtures__/render-forbidden-' +
          ')',
      },
      // dep-cruiser strips the `node:` prefix; `to.path` matches the resolved bare
      // core-module name. User TS files have directory-prefixed paths so this regex
      // (anchored at start AND end) cannot collide with anything outside Node core.
      to: {
        path: '^(fs|net|http|https|os|child_process|dgram|tls)$',
      },
    },
  ],

  options: {
    // tsConfig intentionally omitted — apps/api/tsconfig.json doesn't define
    // module aliases, so node-style resolution suffices. Including the
    // tsconfig caused TS18003 from the wrong CWD because the tsconfig's
    // relative includes resolve from the file location, but dep-cruiser
    // re-evaluates them from the invocation CWD (repo root).
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path:
        '(^|/)node_modules/' +
        '|/__fixtures__/' +
        '|/dist/' +
        '|\\.test\\.ts$' +
        '|\\.spec\\.ts$' +
        '|/scripts/test-' +
        '|/scripts/seed-' +
        '|/scripts/check-' +
        '|/scripts/print-',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};

/*
 * FUTURE_RULES — promote to `forbidden` in the indicated sub-batch.
 *
 * These rules are correct per the architecture doctrine but their violations
 * exist in current code (see Audit 2 + Audit 6). They activate when the
 * corresponding remediation lands.
 *
 * sub-batch 6.7 — render layer cutover (Audit 2 violations remediated):
 *   {
 *     name: 'render-no-producers',
 *     severity: 'error',
 *     comment: '[architecture §4.1 D1] Render layer cannot import producers, stores, or calculators.',
 *     from: { path: '^apps/api/src/(services/render|routes/render)' },
 *     to: {
 *       path: '^apps/api/src/(services/(judgment|doctrine|valuation\\.service|stress-test|cross-check|extraction|data-extraction|hydrate-|resolve-)|storage/)'
 *     },
 *   },
 *   {
 *     name: 'render-no-clock-or-side-channels',
 *     severity: 'error',
 *     comment: '[architecture §B5 idempotency] Render output must be deterministic; no clock reads, no I/O.',
 *     from: { path: '^apps/api/src/services/render' },
 *     to: { path: '^node:fs|^node:net|^node:http' },
 *   },
 *
 * sub-batch 6.6 — new resolver:
 *   {
 *     name: 'resolver-no-side-effects',
 *     severity: 'error',
 *     comment: '[architecture §3.2 R5] Resolver is a pure function; no disk, network, env reads.',
 *     from: { path: '^apps/api/src/services/resolve-underwriting-context' },
 *     to: { path: '^node:(fs|net|http|os)' },
 *   },
 */

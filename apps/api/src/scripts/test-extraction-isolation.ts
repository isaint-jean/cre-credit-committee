/**
 * Negative test for architectural-boundary policy (Batch 6 sub-batch 6.0).
 *
 *   npm run test:extraction-isolation
 *
 * Verifies that the `.dependency-cruiser.cjs` and `eslint.config.mjs` rules
 * actually fire on deliberate-violation fixtures under
 * `apps/api/src/services/doctrine/__fixtures__/`.
 *
 * Why this exists:
 *   A boundary policy without a negative test rots silently. If a future
 *   change weakens or breaks the rules (e.g., a regex typo, a config-key
 *   rename, a tool-version upgrade), this test catches it before merge.
 *
 * Mechanism:
 *   - Invokes the dep-cruiser CLI against the fixtures dir, with `--exclude`
 *     narrowed to skip only `node_modules`/`dist` (the config's default
 *     `__fixtures__` exclude is overridden via CLI). Output is parsed as JSON.
 *   - Asserts each expected rule fires at least once with severity=error.
 *   - Invokes the ESLint API against the fixtures with `ignore: false` to
 *     scan the otherwise-ignored `__fixtures__/` files.
 *   - Smoke-test: clean producer module produces zero error-severity
 *     violations under the production config.
 *
 * Determinism: no clock reads, no env reads, no network. Same code +
 * fixtures → same result.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const FIXTURES_DIR = 'apps/api/src/services/doctrine/__fixtures__';
const CLEAN_FILE = 'apps/api/src/services/doctrine/build-doctrine-evaluation.ts';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }

interface DepCruiserViolation {
  readonly rule: { readonly name: string; readonly severity: string };
  readonly from: string;
  readonly to: string;
}

interface DepCruiserJsonOutput {
  readonly violations?: readonly DepCruiserViolation[];
  readonly summary?: {
    readonly violations?: readonly DepCruiserViolation[];
    readonly error?: number;
    readonly warn?: number;
  };
}

/**
 * Run depcruise CLI; parse JSON output. Non-zero exit codes from the CLI on
 * violations are EXPECTED (not an error condition for our test).
 */
function runDepCruiseCli(targetDir: string, args: readonly string[] = []): DepCruiserJsonOutput {
  const result = spawnSync(
    'npx',
    [
      'depcruise',
      '--config', '.dependency-cruiser.cjs',
      '--output-type', 'json',
      '--no-progress',
      ...args,
      targetDir,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  // CLI prints JSON to stdout regardless of exit code (when violations exist).
  const out = result.stdout ?? '';
  if (!out) {
    throw new Error(`depcruise produced no stdout. stderr: ${result.stderr}`);
  }
  return JSON.parse(out) as DepCruiserJsonOutput;
}

function extractViolations(output: DepCruiserJsonOutput): readonly DepCruiserViolation[] {
  return output?.summary?.violations ?? output?.violations ?? [];
}

interface EslintMessage {
  readonly ruleId: string | null;
  readonly message: string;
  readonly filePath: string;
}

async function runEslintOnFixtures(): Promise<readonly EslintMessage[]> {
  const { ESLint } = await import('eslint');
  const cli = new ESLint({
    overrideConfigFile: resolve(REPO_ROOT, 'eslint.config.mjs'),
    cwd: REPO_ROOT,
    ignore: false,
  });
  const results = await cli.lintFiles([resolve(REPO_ROOT, FIXTURES_DIR, '*.ts')]);
  const messages: EslintMessage[] = [];
  for (const r of results) {
    for (const m of r.messages) {
      messages.push({ ruleId: m.ruleId, message: m.message, filePath: r.filePath });
    }
  }
  return messages;
}

console.log('Negative tests — boundary policy MUST fire on deliberate-violation fixtures:');
console.log(`Fixtures dir: ${FIXTURES_DIR}\n`);

(async () => {
  // --------------------------------------------------------------------- //
  // Section 1 — dependency-cruiser CLI
  // --------------------------------------------------------------------- //
  console.log('Section 1 — dependency-cruiser');
  // Override the default exclude (which skips __fixtures__) with a narrow
  // exclude that skips only node_modules. CLI flag replaces the config value.
  const dcOutput = runDepCruiseCli(FIXTURES_DIR, ['--exclude', '(^|/)node_modules/']);
  const violations = extractViolations(dcOutput);
  console.log(`  scanned fixtures, found ${violations.length} violation(s):`);
  for (const v of violations) {
    console.log(`    [${v.rule.severity}] ${v.rule.name}: ${v.from} → ${v.to}`);
  }
  console.log();

  assert(violations.length >= 2, 'dep-cruiser reported ≥2 violations on fixtures');

  const ruleNamesFired = new Set(violations.map(v => v.rule.name));
  assert(
    ruleNamesFired.has('no-extraction-in-non-judgment-producers'),
    'rule `no-extraction-in-non-judgment-producers` fired',
  );
  assert(
    ruleNamesFired.has('no-legacy-adapter-in-new-spine'),
    'rule `no-legacy-adapter-in-new-spine` fired',
  );

  const errorViolations = violations.filter(v => v.rule.severity === 'error');
  assert(
    errorViolations.length >= 2,
    `at least 2 error-severity violations (got ${errorViolations.length})`,
  );

  // --------------------------------------------------------------------- //
  // Section 2 — ESLint symbol-level enforcement
  // --------------------------------------------------------------------- //
  console.log('Section 2 — ESLint symbol restriction');
  const messages = await runEslintOnFixtures();
  console.log(`  scanned fixtures, found ${messages.length} ESLint message(s):`);
  for (const m of messages) {
    console.log(`    [${m.ruleId}] ${m.filePath.split('/').slice(-1)[0]}: ${m.message.slice(0, 80)}`);
  }
  console.log();

  const restrictedImportMsgs = messages.filter(
    m => m.ruleId === 'no-restricted-imports'
      && m.message.includes('ExtractionResult'),
  );
  assert(
    restrictedImportMsgs.length >= 1,
    'ESLint `no-restricted-imports` fired on `ExtractionResult` symbol',
  );

  // --------------------------------------------------------------------- //
  // Section 3 — sanity: clean module produces no violations
  // --------------------------------------------------------------------- //
  console.log('Section 3 — sanity: clean producer module');
  // Use the production config (default exclude in effect; clean module
  // shouldn't have violations regardless).
  const cleanOutput = runDepCruiseCli(CLEAN_FILE);
  const cleanViolations = extractViolations(cleanOutput);
  const cleanErrors = cleanViolations.filter(v => v.rule.severity === 'error');
  assert(
    cleanErrors.length === 0,
    `clean module produced 0 error-severity violations (got ${cleanErrors.length})`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(2);
});

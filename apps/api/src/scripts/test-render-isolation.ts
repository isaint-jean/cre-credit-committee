// Negative test for render-side architectural-boundary policy (Batch 6.8).
//
//   npm run test:render-isolation
//
// Verifies that the dependency-cruiser rules `render-no-producers` and
// `render-no-clock-or-side-channels` actually fire on deliberate-violation
// fixtures under apps/api/src/services/__fixtures__/.
//
// Why this exists: a boundary policy without a negative test rots silently.
// If a future change weakens or breaks the rules (regex typo, config rename,
// tool version upgrade), this catches it before merge. Mirrors the pattern
// established for extraction isolation in Batch 6.0.

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const FIXTURES_DIR = 'apps/api/src/services/__fixtures__';
const RENDER_PRODUCER_FIXTURE = 'render-forbidden-producer-import.fixture.ts';
const RENDER_CLOCK_FIXTURE = 'render-forbidden-clock-read.fixture.ts';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assert(c: boolean, m: string): void { if (c) ok(m); else fail(m); }

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
  };
}

// Run depcruise CLI with the standard config but with the __fixtures__ exclusion
// overridden so the negative-test fixtures are scanned. CLI exit code is non-zero
// when violations exist; that is EXPECTED here, not an error.
function runDepCruiseCli(targetDir: string): DepCruiserJsonOutput {
  const result = spawnSync(
    'npx',
    [
      'depcruise',
      '--config', '.dependency-cruiser.cjs',
      '--output-type', 'json',
      '--no-progress',
      // narrow exclude to skip only node_modules / dist; otherwise __fixtures__
      // would be excluded by the config's default and the test would scan nothing.
      '--exclude', '(^|/)node_modules/|/dist/',
      targetDir,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  const out = result.stdout ?? '';
  if (!out) {
    throw new Error('depcruise produced no stdout. stderr: ' + (result.stderr ?? ''));
  }
  return JSON.parse(out) as DepCruiserJsonOutput;
}

function extractViolations(output: DepCruiserJsonOutput): readonly DepCruiserViolation[] {
  const fromSummary = output?.summary?.violations;
  if (fromSummary !== undefined) return fromSummary;
  const fromTop = output?.violations;
  if (fromTop !== undefined) return fromTop;
  return [];
}

console.log('Scanning render-side fixtures for deliberate violations:');
{
  const output = runDepCruiseCli(FIXTURES_DIR);
  const violations = extractViolations(output);
  ok('depcruise scan completed (' + violations.length + ' violations)');

  // 1. render-no-producers fires on the producer-import fixture
  const producerHits = violations.filter(
    (v) =>
      v.rule.name === 'render-no-producers' &&
      v.from.indexOf(RENDER_PRODUCER_FIXTURE) >= 0,
  );
  assert(
    producerHits.length > 0,
    'render-no-producers fires on render-forbidden-producer-import.fixture.ts',
  );
  for (const hit of producerHits) {
    assert(hit.rule.severity === 'error', 'severity for render-no-producers is error');
  }

  // 2. render-no-clock-or-side-channels fires on the clock-read fixture
  const clockHits = violations.filter(
    (v) =>
      v.rule.name === 'render-no-clock-or-side-channels' &&
      v.from.indexOf(RENDER_CLOCK_FIXTURE) >= 0,
  );
  assert(
    clockHits.length > 0,
    'render-no-clock-or-side-channels fires on render-forbidden-clock-read.fixture.ts',
  );
  for (const hit of clockHits) {
    assert(hit.rule.severity === 'error', 'severity for render-no-clock-or-side-channels is error');
  }
}

console.log('\nClean render module produces zero render-rule violations under prod config:');
{
  const output = runDepCruiseCli('apps/api/src/services/render-underwriting-context.ts');
  const violations = extractViolations(output);
  const renderRuleHits = violations.filter(
    (v) =>
      v.rule.severity === 'error' &&
      (v.rule.name === 'render-no-producers' ||
        v.rule.name === 'render-no-clock-or-side-channels'),
  );
  assert(
    renderRuleHits.length === 0,
    'clean render-underwriting-context.ts produced 0 render-rule errors (got ' + renderRuleHits.length + ')',
  );
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

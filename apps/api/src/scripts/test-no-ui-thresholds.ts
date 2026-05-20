/**
 * Regression test for "no UW credit-policy thresholds in the web client"
 * (Batch 6 sub-batch 6.1, decision D6).
 *
 *   npm run test:no-ui-thresholds
 *
 * Walks `apps/web/src/` (TS / TSX only) and applies a set of regular
 * expressions matching credit-threshold patterns. Fails the build if any
 * occurrence is found.
 *
 * The threshold values themselves are sourced from
 * `apps/api/src/services/doctrine/credit-policy-bands.ts` — the single
 * authority. The web client consumes server-emitted band labels.
 *
 * Targeting strategy:
 *   - Numeric literals are still permitted in the web layer for non-policy
 *     purposes (chart axis bounds, font sizes, animation delays, SVG paths).
 *   - The patterns below detect *value comparisons* on known metric expressions
 *     (e.g. `uw.dscr < 1.25`, `score.overall >= 85`) — narrower than a
 *     blanket numeric ban, more targeted than a generic grep.
 *
 * Implemented in pure Node (no ripgrep dependency) so CI runs without
 * environment-tool surprises.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const TARGET_DIR = resolve(REPO_ROOT, 'apps/web/src');

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build']);
const ALLOWED_EXT = new Set(['.ts', '.tsx']);

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }

interface Pattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly why: string;
}

const FORBIDDEN_PATTERNS: readonly Pattern[] = [
  {
    name: 'DSCR threshold',
    regex: /(\.|\b)dscr\b\s*[<>]=?\s*[0-9]/i,
    why: 'DSCR thresholds (1.25, 1.50) belong in services/doctrine/credit-policy-bands.ts. Read uw.dscrBand instead.',
  },
  {
    name: 'LTV threshold',
    regex: /(\.|\b)ltv\b\s*[<>]=?\s*[0-9]/i,
    why: 'LTV thresholds (0.65, 0.75) belong in services/doctrine/credit-policy-bands.ts. Read uw.ltvBand instead.',
  },
  {
    name: 'debt-yield threshold',
    regex: /(\.|\b)debt[Yy]ield\b\s*[<>]=?\s*[0-9]/,
    why: 'Debt-yield thresholds (0.08, 0.10) belong in services/doctrine/credit-policy-bands.ts. Read uw.debtYieldBand instead.',
  },
  {
    name: 'minDSCR / monthlyDSCR threshold',
    regex: /(\.|\b)(monthlyDSCR|minDSCR)\b\s*[<>]=?\s*[0-9]/,
    why: 'Min/monthly DSCR thresholds (1.15, 1.25) belong in services/doctrine/credit-policy-bands.ts. Read minDscrBand / monthlyDscrBand instead.',
  },
  {
    name: 'balloon-vs-loan multiplier',
    regex: /loanAmount\s*\*\s*0\.[79]/,
    why: 'Balloon thresholds (loan * 0.7, loan * 0.9) belong in services/doctrine/credit-policy-bands.ts. Read balloonBand instead.',
  },
  {
    name: 'overall-score tier ladder',
    regex: /(score\.overall|creditScore)\s*>=?\s*(85|70|50)\b/,
    why: 'Score-tier classification (85/70/50) is server-emitted as score.riskTier. Use the riskTier field directly.',
  },
  {
    name: 'category-tier ladder',
    regex: /(cat\.score|category\.score)\s*>=?\s*(80|60|40)\b/,
    why: 'Category-tier classification (80/60/40) is server-emitted as cat.tier. Use the tier field directly.',
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walk(fullPath);
    } else if (stat.isFile()) {
      const dot = entry.lastIndexOf('.');
      if (dot >= 0 && ALLOWED_EXT.has(entry.slice(dot))) {
        yield fullPath;
      }
    }
  }
}

interface Hit {
  readonly file: string;
  readonly lineNum: number;
  readonly line: string;
}

function findHits(regex: RegExp): readonly Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(TARGET_DIR)) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] ?? '')) {
        hits.push({
          file: file.replace(REPO_ROOT + '/', ''),
          lineNum: i + 1,
          line: (lines[i] ?? '').trim(),
        });
      }
    }
  }
  return hits;
}

console.log('Verifying zero credit-policy thresholds in web client (apps/web/src):\n');

let totalFiles = 0;
for (const _ of walk(TARGET_DIR)) totalFiles++;
console.log(`  scanning ${totalFiles} TS/TSX files\n`);

for (const { name, regex, why } of FORBIDDEN_PATTERNS) {
  const hits = findHits(regex);
  if (hits.length === 0) {
    ok(`no occurrences of "${name}" pattern`);
  } else {
    fail(`pattern "${name}" found — ${why}`);
    for (const h of hits) {
      console.error(`      ${h.file}:${h.lineNum}: ${h.line}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

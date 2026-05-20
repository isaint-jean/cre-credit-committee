// Render discipline guard (Batch 6.7 - RD2/RD3/RD4 enforcement).
//
//   npm run test:render-discipline
//
// Greps the new-spine render service + sentinel module for forbidden patterns. The
// dependency-cruiser policy ('render-no-producers' + 'render-no-clock-or-side-channels')
// is the heavyweight import-level guard; this test catches in-file patterns that
// dep-cruiser cannot see.
//
// Forbidden patterns:
//   - Math.random / Date.now / Date.parse / Date.UTC / new Date  (RD4 wall-clock)
//   - process.env                                                (RD4 env)
//   - readFileSync / writeFileSync                               (RD4 filesystem)
//   - Re-derivation: arithmetic on metrics.*, loan.*, valuation.* fields (RD2)
//   - .push( on input-record arrays (RD3 mutation; passing - we don't mutate inputs)
//
// Comment lines stripped before scanning so the locked invariant block can document
// what's forbidden without tripping the guard.

import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TARGET_FILES = [
  resolve(__dirname, '..', 'services', 'render-underwriting-context.ts'),
  resolve(__dirname, '..', 'services', 'render-sentinels.ts'),
];

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }

interface ForbiddenPattern {
  readonly label: string;
  readonly regex: RegExp;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  { label: 'Math.random',                            regex: new RegExp('\\bMath\\.random\\b') },
  { label: 'Date.now / Date.parse / Date.UTC',       regex: new RegExp('\\bDate\\.(now|parse|UTC)\\b') },
  { label: 'new Date (wall-clock construction)',     regex: new RegExp('\\bnew Date\\b') },
  { label: 'process.env',                            regex: new RegExp('\\bprocess\\.env\\b') },
  { label: 'readFileSync',                           regex: new RegExp('\\breadFileSync\\b') },
  { label: 'writeFileSync',                          regex: new RegExp('\\bwriteFileSync\\b') },
  // Re-derivation: arithmetic operators applied to producer-output fields. Catches
  // cases like `metrics.noi / loan.debtServiceAnnual` (recomputed DSCR) or
  // `loan.loanAmount / valuation.finalValue` (recomputed LTV). The patterns are
  // intentionally specific so they don't false-positive on innocuous uses.
  { label: 're-derivation on metrics.*',             regex: new RegExp('\\bmetrics\\.\\w+\\s*[\\/\\*\\+\\-]') },
  { label: 're-derivation on loan.*',                regex: new RegExp('\\bloan\\.\\w+\\s*[\\/\\*\\+\\-]') },
  { label: 're-derivation on valuation.*',           regex: new RegExp('\\bvaluation\\.\\w+\\s*[\\/\\*\\+\\-]') },
  // Mutation: render must never push into / sort / splice arrays from input records.
  { label: 'mutation: .push(',                       regex: new RegExp('\\.push\\(') },
  { label: 'mutation: .splice(',                     regex: new RegExp('\\.splice\\(') },
  { label: 'mutation: .sort(',                       regex: new RegExp('\\.sort\\(') },
];

function stripCommentLines(source: string): string {
  const lines = source.split('\n');
  const code: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.indexOf('*/') >= 0) inBlock = false;
      continue;
    }
    if (trimmed.indexOf('/**') === 0 || trimmed.indexOf('/*') === 0) {
      if (trimmed.indexOf('*/') < 0) inBlock = true;
      continue;
    }
    if (trimmed.indexOf('//') === 0) continue;
    if (trimmed.indexOf('*') === 0) continue;
    code.push(raw);
  }
  return code.join('\n');
}

for (const filePath of TARGET_FILES) {
  const fileExists = fs.existsSync(filePath);
  if (fileExists) {
    ok('render module found at ' + filePath);
  } else {
    fail('render module MISSING at ' + filePath);
    continue;
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const codeOnly = stripCommentLines(source);

  for (const pattern of FORBIDDEN) {
    if (pattern.regex.test(codeOnly)) {
      const codeLines = codeOnly.split('\n');
      let lineIdx = -1;
      for (let i = 0; i < codeLines.length; i++) {
        const ln = codeLines[i];
        if (ln !== undefined && pattern.regex.test(ln)) { lineIdx = i; break; }
      }
      const offendingLine = lineIdx >= 0 ? (codeLines[lineIdx] ?? '').trim() : '?';
      fail(filePath.split('/').slice(-1)[0] + ': FORBIDDEN ' + pattern.label + ' - line: ' + offendingLine);
    } else {
      ok(filePath.split('/').slice(-1)[0] + ': free of ' + pattern.label);
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

// Snapshot-builder discipline guard (Phase 2 - SX2/SX3/SX4 enforcement).
//
//   npm run test:snapshot-discipline
//
// Greps build-committee-snapshot.ts for forbidden patterns. The snapshot builder is
// a read-only structural-passthrough; any of the patterns below would convert it
// into an analyst engine that synthesizes meaning. Comment lines are stripped before
// scanning so the locked invariant block at the top of the builder can describe
// what is forbidden without tripping the guard.

import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(__dirname, '..', 'services', 'build-committee-snapshot.ts');

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }

interface ForbiddenPattern {
  readonly label: string;
  readonly regex: RegExp;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  { label: 'nullish coalescing (??)',               regex: new RegExp('\\?\\?') },
  { label: 'logical-OR default ( || )',             regex: new RegExp(' \\|\\| ') },
  { label: 'Math.max',                              regex: new RegExp('Math\\.max\\b') },
  { label: 'Math.min',                              regex: new RegExp('Math\\.min\\b') },
  { label: 'Math.random',                           regex: new RegExp('\\bMath\\.random\\b') },
  { label: 'new Date (wall-clock construction)',    regex: new RegExp('\\bnew Date\\b') },
  { label: 'Date.now / Date.parse / Date.UTC',      regex: new RegExp('\\bDate\\.(now|parse|UTC)\\b') },
  { label: 'process.env',                           regex: new RegExp('\\bprocess\\.env\\b') },
  { label: 'readFileSync',                          regex: new RegExp('\\breadFileSync\\b') },
  { label: 'writeFileSync',                         regex: new RegExp('\\bwriteFileSync\\b') },
  { label: 'Object.keys (iteration-order leak)',    regex: new RegExp('\\bObject\\.keys\\b') },
  { label: 'Object.values (iteration-order leak)',  regex: new RegExp('\\bObject\\.values\\b') },
  // Re-derivation: arithmetic on the rendered/overlay surfaces. Any mutation of the
  // rendered fields would be a SX3 violation.
  { label: 're-derivation on metrics.*',            regex: new RegExp('\\bmetrics\\.\\w+\\.value\\s*[\\/\\*\\+\\-]') },
  { label: 're-derivation on doctrine.*',           regex: new RegExp('\\bdoctrine\\.\\w+\\.value\\s*[\\/\\*\\+\\-]') },
  // Mutation: snapshot builder must never push/splice/sort input arrays.
  { label: 'mutation: .push(',                      regex: new RegExp('\\.push\\(') },
  { label: 'mutation: .splice(',                    regex: new RegExp('\\.splice\\(') },
  { label: 'mutation: .sort(',                      regex: new RegExp('\\.sort\\(') },
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

const fileExists = fs.existsSync(TARGET);
if (fileExists) {
  ok('snapshot-builder source found at ' + TARGET);
} else {
  fail('snapshot-builder source MISSING at ' + TARGET);
}

if (fileExists) {
  const source = fs.readFileSync(TARGET, 'utf8');
  const codeOnly = stripCommentLines(source);

  for (const pattern of FORBIDDEN) {
    if (pattern.regex.test(codeOnly)) {
      const codeLines = codeOnly.split('\n');
      let lineIdx = -1;
      for (let i = 0; i < codeLines.length; i++) {
        const ln = codeLines[i];
        if (ln !== undefined && pattern.regex.test(ln)) { lineIdx = i; break; }
      }
      const offending = lineIdx >= 0 ? (codeLines[lineIdx] ?? '').trim() : '?';
      fail('snapshot builder contains FORBIDDEN ' + pattern.label + ' - line: ' + offending);
    } else {
      ok('snapshot builder is free of: ' + pattern.label);
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

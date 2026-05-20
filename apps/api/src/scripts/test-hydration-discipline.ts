// Hydration discipline guard (Batch 6.5 - HY2 enforcement).
//
//   npm run test:hydration-discipline
//
// Greps the hydrator source for forbidden patterns. The hydrator is a strict reader;
// any of the patterns below would convert it into a second ingestion layer that quietly
// synthesizes records. This test fails the moment such a pattern appears in code.
// Comment lines are stripped before scanning so the docblock at the top of the hydrator
// can still describe what is forbidden.

import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HYDRATOR_PATH = resolve(__dirname, '..', 'services', 'hydrate-record-graph.ts');

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
  { label: 'asset-class branching (propertyType)',  regex: new RegExp('if\\s*\\([^)]*\\bpropertyType\\b') },
  { label: 'asset-class branching (assetClass)',    regex: new RegExp('if\\s*\\([^)]*\\bassetClass\\b') },
  { label: 'Object.keys (iteration-order leak)',    regex: new RegExp('\\bObject\\.keys\\b') },
  { label: 'Object.values (iteration-order leak)',  regex: new RegExp('\\bObject\\.values\\b') },
  { label: 'Date or new Date (wall-clock read)',    regex: new RegExp('\\bDate\\.|\\bnew Date\\b') },
  { label: 'Math.random',                           regex: new RegExp('\\bMath\\.random\\b') },
  { label: 'process.env',                           regex: new RegExp('\\bprocess\\.env\\b') },
  { label: 'readFileSync',                          regex: new RegExp('\\breadFileSync\\b') },
  { label: 'writeFileSync',                         regex: new RegExp('\\bwriteFileSync\\b') },
];

// Strip comment lines so the discipline doc at the top of the hydrator can mention
// forbidden patterns without tripping the guard. Heuristics:
//  - lines starting with whitespace + slash-slash (single-line comment)
//  - lines whose first non-whitespace char is asterisk or slash (block-comment body)
//  - lines containing only a closing star-slash
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

const fileExists = fs.existsSync(HYDRATOR_PATH);
if (fileExists) {
  ok('hydrator source found at ' + HYDRATOR_PATH);
} else {
  fail('hydrator source MISSING at ' + HYDRATOR_PATH);
}

if (fileExists) {
  const source = fs.readFileSync(HYDRATOR_PATH, 'utf8');
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
      fail('hydrator contains FORBIDDEN pattern: ' + pattern.label + ' - line: ' + offendingLine);
    } else {
      ok('hydrator code is free of: ' + pattern.label);
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

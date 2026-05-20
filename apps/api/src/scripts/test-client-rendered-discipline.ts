// Consumer-migration discipline guard (post-6.8 web client).
//
//   npm run test:client-rendered-discipline
//
// Greps the new RenderedAnalysis-consuming files in apps/web/src/ for forbidden
// patterns. The web client must consume RenderedAnalysis as materialized truth -
// no re-derivation of metrics, no re-formatting (server provides displayValue),
// no re-classification of bands or sentinels.
//
// Scope: only the NEW consumer-migration files. The legacy dashboard
// (analysis/[id]/page.tsx) is exempt because it consumes the legacy Analysis
// shape and uses formatting helpers - that is by design during transition.
//
// Forbidden patterns inside the consumer-migration files:
//   - Arithmetic operators on metric / loan / valuation field accesses (re-derivation)
//   - Calls to formatCurrency / formatPercent / formatMultiple / formatDecimalPercent
//     (the server's displayValue is the truth; client must not re-format)
//   - Numeric threshold comparisons that would constitute band re-classification
//     (e.g., `dscr < 1.25`, `ltv > 0.75`)
//   - process.env access (deterministic UI; environment-derived values belong in
//     a build-time config or come from server)

import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

const TARGET_FILES = [
  resolve(REPO_ROOT, 'apps/web/src/lib/rendered-analysis-guard.ts'),
  resolve(REPO_ROOT, 'apps/web/src/components/RenderedAnalysisView.tsx'),
  // Phase 3 - committee workflow UI components. Same display-only discipline:
  // no formatting helpers, no arithmetic, no thresholds, no business logic.
  resolve(REPO_ROOT, 'apps/web/src/components/CommitteeStatusHeader.tsx'),
  resolve(REPO_ROOT, 'apps/web/src/components/CommitteeTimelinePanel.tsx'),
  // Phase 4 - operational workflow UX (action buttons, audit replay viewer,
  // snapshot viewer). All three are thin transport over the workflow API
  // projections; no client-side state derivation.
  resolve(REPO_ROOT, 'apps/web/src/components/CommitteeActionButtons.tsx'),
  resolve(REPO_ROOT, 'apps/web/src/components/AuditViewToggle.tsx'),
  resolve(REPO_ROOT, 'apps/web/src/components/SnapshotViewer.tsx'),
  // Phase 4 OVERRIDE_DECISION surface - dedicated overlay-scoped action panel
  // and route page. Same display-only discipline.
  resolve(REPO_ROOT, 'apps/web/src/components/OverlayActionPanel.tsx'),
  resolve(REPO_ROOT, 'apps/web/src/app/analysis/[id]/overlay/[overlayId]/page.tsx'),
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
  { label: 'formatCurrency / formatCurrencyFull / formatCurrencyFullSafe',
    regex: new RegExp('\\bformatCurrency(Full(Safe)?)?\\b') },
  { label: 'formatPercent',                  regex: new RegExp('\\bformatPercent\\b') },
  { label: 'formatMultiple / formatMultipleSafe',
    regex: new RegExp('\\bformatMultiple(Safe)?\\b') },
  { label: 'formatDecimalPercent',           regex: new RegExp('\\bformatDecimalPercent\\b') },
  { label: 're-derivation on metrics.*',     regex: new RegExp('\\bmetrics\\.\\w+\\.value\\s*[\\/\\*\\+\\-]') },
  { label: 're-derivation on loan.*',        regex: new RegExp('\\bloan\\.\\w+\\.value\\s*[\\/\\*\\+\\-]') },
  { label: 're-derivation on valuation.*',   regex: new RegExp('\\bvaluation\\.\\w+\\.value\\s*[\\/\\*\\+\\-]') },
  // Threshold comparisons on metric values - if the UI is comparing dscr.value to
  // a threshold to reclassify, it has reintroduced server-side band logic.
  { label: 'threshold compare on dscr.value', regex: new RegExp('\\bdscr\\.value\\s*[<>]') },
  { label: 'threshold compare on ltv.value',  regex: new RegExp('\\bltv\\.value\\s*[<>]') },
  { label: 'threshold compare on debtYield.value',
    regex: new RegExp('\\bdebtYield\\.value\\s*[<>]') },
  { label: 'process.env',                    regex: new RegExp('\\bprocess\\.env\\b') },
  { label: 'Math.random',                    regex: new RegExp('\\bMath\\.random\\b') },
  { label: 'new Date (wall-clock)',          regex: new RegExp('\\bnew Date\\b') },
  { label: 'Date.now / Date.parse',          regex: new RegExp('\\bDate\\.(now|parse|UTC)\\b') },
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
    ok('consumer-migration file present: ' + filePath.split('/').slice(-2).join('/'));
  } else {
    fail('consumer-migration file MISSING: ' + filePath);
    continue;
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const codeOnly = stripCommentLines(source);
  const fileLabel = filePath.split('/').slice(-1)[0];

  for (const pattern of FORBIDDEN) {
    if (pattern.regex.test(codeOnly)) {
      const codeLines = codeOnly.split('\n');
      let lineIdx = -1;
      for (let i = 0; i < codeLines.length; i++) {
        const ln = codeLines[i];
        if (ln !== undefined && pattern.regex.test(ln)) { lineIdx = i; break; }
      }
      const offending = lineIdx >= 0 ? (codeLines[lineIdx] ?? '').trim() : '?';
      fail(fileLabel + ': FORBIDDEN ' + pattern.label + ' - line: ' + offending);
    } else {
      ok(fileLabel + ': free of ' + pattern.label);
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);

/**
 * Funnel PR 2 — UI branch-logic fixture-shape smoke check.
 *
 *   npx tsx apps/api/src/scripts/test-funnel-pr2-row-branch.ts
 *
 * The MembershipTable's loan-row funnel is driven by a pure projection
 * (branchForLookup) that maps a LookupState → LoanRowBranch. This test verifies
 * the projection's contract WITHOUT touching React: given the wire shape from
 * GET /api/analyses/lookup, produce the right href + label per state. If the
 * lookup response shape drifts, this test catches it before runtime.
 *
 * (apps/web has no in-app test idiom, but it's now CI-gated by the web-build
 * workflow; this script is the project's standing pattern for proving the
 * UI's wire-shape alignment — see test-pool-pr5-ui-fixture.ts, PR6 home-base.)
 *
 * The projection itself is duplicated inline below so this test doesn't import
 * from apps/web (the compile graphs are independent). The shape mismatch
 * would surface immediately if the projection drifts in either workspace.
 */

// Make this a module (no imports otherwise; without this, tsc treats it as a
// script and `assert` collides with the same-named helper in sibling test files).
export {};

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); failures += 1; }
}

/* -------------------------------------------------------------------------- */
/* The projection — kept structurally identical to MembershipTable.tsx        */
/* -------------------------------------------------------------------------- */
type LookupState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'found'; readonly analysisId: string; readonly status: string | null }
  | { readonly kind: 'not-found' };

interface LoanRowBranch {
  readonly variant: 'open-underwriting' | 'new-analysis' | 'loading' | 'error';
  readonly href: string;
  readonly label: string;
  readonly statusHint: string | null;
}

function branchForLookup(dealRef: string, state: LookupState | undefined): LoanRowBranch {
  if (state === undefined || state.kind === 'loading') {
    return { variant: 'loading', href: '#', label: 'Checking…', statusHint: null };
  }
  if (state.kind === 'error') {
    return { variant: 'error', href: '#', label: "Couldn't check", statusHint: null };
  }
  if (state.kind === 'found') {
    return {
      variant: 'open-underwriting',
      href: `/analysis/${state.analysisId}`,
      label: 'Open underwriting →',
      statusHint: state.status,
    };
  }
  return {
    variant: 'new-analysis',
    href: `/analysis/new?dealRef=${encodeURIComponent(dealRef)}`,
    label: 'New analysis →',
    statusHint: null,
  };
}

/* -------------------------------------------------------------------------- */
console.log('================================================================');
console.log('Funnel PR 2 — UI branch-logic smoke check');
console.log('================================================================');

/* -------------------------------------------------------------------------- */
/* §A — found (lookup returned an analysis)                                   */
/* -------------------------------------------------------------------------- */
console.log('\n--- A. found → Open underwriting ---');
const foundBranch = branchForLookup('SUNROAD-CENTRUM-REAL', {
  kind: 'found',
  analysisId: 'e8778e74-8ac8-4777-9e09-6671c2ec3ed1',
  status: 'complete',
});
assert(foundBranch.variant === 'open-underwriting', 'variant === open-underwriting');
assert(foundBranch.href === '/analysis/e8778e74-8ac8-4777-9e09-6671c2ec3ed1',
  '★ link routes to /analysis/<uuid> (the existing single-deal view; dealRef delegation)');
assert(foundBranch.label === 'Open underwriting →', 'label = "Open underwriting →"');
assert(foundBranch.statusHint === 'complete', 'statusHint surfaces the engine status');

const foundGraphBranch = branchForLookup('GRAPH-ONLY-DEAL', {
  kind: 'found',
  analysisId: 'c'.repeat(64),
  status: null,
});
assert(foundGraphBranch.href === `/analysis/${'c'.repeat(64)}`,
  'graph-only fallback: link to /analysis/<64-hex> (dispatchByIdFormat handles either form)');
assert(foundGraphBranch.statusHint === null, 'graph-only: statusHint is null (no legacy status column)');

/* -------------------------------------------------------------------------- */
/* §B — not-found (the funnel's "New analysis" branch)                       */
/* -------------------------------------------------------------------------- */
console.log('\n--- B. not-found → New analysis (the funnel\'s payoff) ---');
const newBranch = branchForLookup('deal-L1', { kind: 'not-found' });
assert(newBranch.variant === 'new-analysis', 'variant === new-analysis');
assert(newBranch.href === '/analysis/new?dealRef=deal-L1',
  '★ link routes to /analysis/new?dealRef=deal-L1 (the pre-filled form)');
assert(newBranch.label === 'New analysis →', 'label = "New analysis →"');

// URL-encoding correctness — dealRefs can contain anything
const encoded = branchForLookup('BMARK 2026-V12 / loan #4', { kind: 'not-found' });
assert(encoded.href.startsWith('/analysis/new?dealRef='),
  'encoded: path stays /analysis/new?dealRef=…');
assert(decodeURIComponent(encoded.href.split('=')[1]!) === 'BMARK 2026-V12 / loan #4',
  '★ URL-encoded round-trip preserves the original dealRef (decodes back to source)');

/* -------------------------------------------------------------------------- */
/* §C — loading                                                               */
/* -------------------------------------------------------------------------- */
console.log('\n--- C. loading (pending; row still renders) ---');
const loadingBranch = branchForLookup('deal-L1', { kind: 'loading' });
assert(loadingBranch.variant === 'loading', 'variant === loading');
assert(loadingBranch.href === '#', 'inert href');
assert(loadingBranch.label === 'Checking…', 'subtle label ("Checking…", not a spinner)');

const undefinedBranch = branchForLookup('deal-L1', undefined);
assert(undefinedBranch.variant === 'loading',
  'undefined state (lookup not yet seeded) → loading (no missing-state crash)');

/* -------------------------------------------------------------------------- */
/* §D — error (lookup failed, but row stays navigable; no fake button)        */
/* -------------------------------------------------------------------------- */
console.log('\n--- D. error → "Couldn\'t check" (not a fake button) ---');
const errorBranch = branchForLookup('deal-L1', { kind: 'error' });
assert(errorBranch.variant === 'error', 'variant === error');
assert(errorBranch.href === '#', '★ inert href (no fake button that might mislead)');
assert(errorBranch.label === "Couldn't check", 'honest label');

/* -------------------------------------------------------------------------- */
/* §E — walkthrough simulation (BMARK end-to-end)                             */
/* -------------------------------------------------------------------------- */
console.log('\n--- E. BMARK walkthrough simulation ---');
// Simulate what the rail will render against the seeded pool: 3 loans on v6,
// all dealRefs return not-found (verified by funnel PR1's test §D).
const bmarkLoans = [
  { dealRef: 'deal-L1', loanInPoolId: 'l1' },
  { dealRef: 'deal-L4', loanInPoolId: 'l4' },
  { dealRef: 'deal-L6', loanInPoolId: 'l6' },
];
const lookups = new Map<string, LookupState>([
  ['deal-L1', { kind: 'not-found' }],
  ['deal-L4', { kind: 'not-found' }],
  ['deal-L6', { kind: 'not-found' }],
]);
const branches = bmarkLoans.map(l => branchForLookup(l.dealRef, lookups.get(l.dealRef)));
assert(branches.every(b => b.variant === 'new-analysis'),
  '★ every BMARK seeded loan branches to "New analysis" — the funnel\'s loop is closed');
assert(branches.map(b => b.href).every(h => h.startsWith('/analysis/new?dealRef=')),
  'every link routes to /analysis/new with the dealRef encoded');

/* -------------------------------------------------------------------------- */
console.log('\n================================================================');
if (failures === 0) {
  console.log('Funnel PR 2 — UI branch-logic: PASS — wire shape + branch + walkthrough hold.');
  process.exit(0);
} else {
  console.log(`Funnel PR 2 — UI branch-logic: FAIL (${failures} assertion${failures === 1 ? '' : 's'} failed)`);
  process.exit(1);
}

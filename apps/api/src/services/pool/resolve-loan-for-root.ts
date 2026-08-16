/**
 * Forward `root → loan` resolver (Phase A) — the FORWARD sibling of
 * `deriveClearedForDealRef` (derive-cleared.ts).
 *
 * DOCTRINE: the graph surface (`NegotiationSurface`) holds only `data.rootId`.
 * To let its DispositionBar go live IN the deal room (close / reject / withdraw
 * against a specific pool loan) it must turn that root into a single
 * `{poolId, loanInPoolId}` — WITHOUT a stored column and WITHOUT ever GUESSING.
 * The root is the INPUT, not a choice: if it does not resolve to exactly ONE
 * pool loan, we REFUSE (`ambiguous`) so the surface degrades to today's honest
 * preview/deep-link rather than writing a wrong target.
 *
 * This is a two-hop composition, both hops reusing existing machinery:
 *
 *   1. root → (deal_ref, analysis.name)
 *        `SqliteStore.getRootRefAndName(rootId)` — the SAME
 *        `extraction_results → doctrine_evaluations → revision_lineage_envelopes`
 *        join `lookupAnalysisByDealRef` PASS-1 walks (sqlite-store.ts:400-411),
 *        run FORWARD (root is the input). `root → deal_ref` is 1:1 (a root came
 *        from exactly one extraction with one deal_ref), so this hop never
 *        chooses among roots — the reverse `dealRef → root` 1:N ambiguity that
 *        `/close` handles with "latest wins" does NOT bite the forward direction.
 *
 *   2. (deal_ref, name) → single pool loan, via TWO passes that MIRROR
 *      `lookupAnalysisByDealRef`'s own 2-pass (sqlite-store.ts:399-491), run
 *      forward (root-side → pool-side instead of pool-side → root-side):
 *
 *        PASS 1 (exact): `loan_in_pool WHERE deal_ref = ?`. The DEMO path —
 *          root deal_ref `DEMO-CLEARED-MF-001` exact-matches the pool loan.
 *
 *        PASS 2 (normalized-name bridge): the SAME `/close` mechanism as
 *          `lookupAnalysisByDealRef` PASS-2 (sqlite-store.ts:427-491), NOT a
 *          net-new fuzzy match — it reuses the EXACT normalizers
 *          `normalizeAnalysisNameForMatch` + `normalizePropertyName`
 *          (parse-bmark-tape-xlsx.ts:65-96) that PASS-2 already pairs. There the
 *          pool loan's `originator_loan_ref` is normalized and compared to the
 *          engine `analyses.name`; here we run it forward — normalize the root's
 *          `analyses.name` and compare it to each pool loan's normalized
 *          `originator_loan_ref` (and `property_name` as a secondary key). The
 *          Sunroad path — root deal_ref `SUNROAD-CENTRUM-REAL` / `Sunroad Centrum
 *          (…)` does NOT exact-match the pool key `bmark2024v8-sunroad-centrum`,
 *          but every Sunroad root's name normalizes to `sunroad centrum`, which
 *          equals the pool loan's normalized `originator_loan_ref`.
 *
 *   REFUSE-WHEN-≠1: the union of PASS-1 and PASS-2 matches is reduced to the set
 *   of DISTINCT `loanInPoolId`. If that set is not exactly 1 (0 = un-pooled /
 *   name-less pure-graph root; >1 = a deal legitimately in multiple pools) we
 *   return `{ ambiguous: true, reason }` and NEVER pick a winner.
 *
 * READ-ONLY. No stored column, no migration, no DB write. Re-derived fresh at
 * render — nothing to go stale.
 */

import {
  normalizePropertyName,
  normalizeAnalysisNameForMatch,
} from '../parse-bmark-tape-xlsx.js';
import { store as defaultSqliteStore, SqliteStore } from '../../storage/sqlite-store.js';
import { PoolStore } from '../../storage/pool-store.js';

/* -------------------------------------------------------------------------- */
/* Store handles — default to the app singletons; overridable for tests so the */
/* temp-DB gate can point every read at a throwaway copy (mirrors             */
/* derive-cleared.ts's `_setClearedDeriveStoresForTests`).                    */
/* -------------------------------------------------------------------------- */

export interface ResolveLoanForRootStores {
  readonly sqliteStore: Pick<SqliteStore, 'getRootRefAndName' | 'getLineageRootForEvaluation'>;
  readonly poolStore: Pick<PoolStore, 'findLoansByExactDealRef' | 'listLoanNameKeys'>;
}

let _testStores: ResolveLoanForRootStores | null = null;
let _defaultPoolStore: PoolStore | null = null;

/** Test hook: point the forward resolver at a temp-DB set of stores. */
export function _setResolveLoanForRootStoresForTests(stores: ResolveLoanForRootStores | null): void {
  _testStores = stores;
}

function stores(): ResolveLoanForRootStores {
  if (_testStores !== null) return _testStores;
  if (_defaultPoolStore === null) _defaultPoolStore = new PoolStore();
  return {
    sqliteStore: defaultSqliteStore,
    poolStore: _defaultPoolStore,
  };
}

/* -------------------------------------------------------------------------- */
/* Result shape.                                                              */
/* -------------------------------------------------------------------------- */

export type LoanForRootResolution =
  | {
      readonly resolved: true;
      readonly poolId: string;
      readonly loanInPoolId: string;
      /** Which pass produced the single match — for debuggability, not identity. */
      readonly matchedBy: 'exact-deal-ref' | 'normalized-name-bridge';
    }
  | {
      readonly resolved: false;
      readonly ambiguous: true;
      /**
       * NONE           — no pool loan matched (un-pooled deal, or a name-less
       *                   pure-graph root the name bridge cannot key on).
       * MULTIPLE       — >1 distinct pool loan matched (a deal legitimately in
       *                   more than one pool). The surface cannot pick → degrade.
       * ROOT_NOT_FOUND — `rootId` is not a known lineage root.
       */
      readonly reason: 'NONE' | 'MULTIPLE' | 'ROOT_NOT_FOUND';
      readonly matchCount: number;
    };

/**
 * Resolve a graph id to the single pool loan it belongs to. Accepts EITHER a
 * `lineage_root_id` OR a `doctrine_evaluation_id` (what `RenderedAnalysis.rootId`
 * holds — the id the deal-room + the NegotiationSurface DispositionBar pass):
 *
 *   1. Try the id AS a lineage_root_id (preserves all existing behavior + tests;
 *      a valid-but-un-pooled/multi-pool lineage root returns its honest NONE/MULTIPLE).
 *   2. ONLY on ROOT_NOT_FOUND — the id was not a known lineage root — translate it as
 *      a doctrine_evaluation_id → its lineage_root_id and retry once.
 *   3. If neither resolves → genuine ROOT_NOT_FOUND (honest un-pooled fallback).
 *
 * Refuses (never guesses) when the resolution is not exactly one pool loan.
 */
export function resolveLoanForRoot(rootId: string): LoanForRootResolution {
  const byLineage = resolveByLineageRoot(rootId);
  // A real resolution (true) or a determinate refusal on a KNOWN root (NONE/MULTIPLE)
  // stands as-is. Only ROOT_NOT_FOUND means "this wasn't a lineage root" → try eval-id.
  if (byLineage.resolved || byLineage.reason !== 'ROOT_NOT_FOUND') return byLineage;
  const lineageRoot = stores().sqliteStore.getLineageRootForEvaluation(rootId);
  if (lineageRoot === null || lineageRoot === rootId) return byLineage; // not an eval id → honest ROOT_NOT_FOUND
  return resolveByLineageRoot(lineageRoot);
}

/**
 * The core resolver — keys strictly on `lineage_root_id` (unchanged from the
 * original resolveLoanForRoot body). Not exported: callers go through
 * resolveLoanForRoot, which also accepts a doctrine_evaluation_id.
 */
function resolveByLineageRoot(rootId: string): LoanForRootResolution {
  const s = stores();

  // ── Hop 1: root → (deal_ref, analysis.name). 1:1; the input is the root. ──
  const rootRef = s.sqliteStore.getRootRefAndName(rootId);
  if (rootRef === null) {
    return { resolved: false, ambiguous: true, reason: 'ROOT_NOT_FOUND', matchCount: 0 };
  }

  // Collect DISTINCT loanInPoolId → its poolId + the pass that found it, so the
  // union across both passes is deduplicated before the refuse-when-≠1 check.
  const found = new Map<string, { poolId: string; matchedBy: 'exact-deal-ref' | 'normalized-name-bridge' }>();

  // ── Hop 2, PASS 1 (exact): loan_in_pool WHERE deal_ref = root's deal_ref. ──
  for (const loan of s.poolStore.findLoansByExactDealRef(rootRef.dealRef)) {
    if (!found.has(loan.loanInPoolId)) {
      found.set(loan.loanInPoolId, { poolId: loan.poolId, matchedBy: 'exact-deal-ref' });
    }
  }

  // ── Hop 2, PASS 2 (normalized-name bridge — the SAME `/close` mechanism as ──
  //    lookupAnalysisByDealRef PASS-2, run forward; NOT net-new fuzzy risk).
  //    Only consulted when there IS a name to key on; the target key is the
  //    root's analysis name normalized through normalizeAnalysisNameForMatch,
  //    compared to each pool loan's normalizePropertyName(originator_loan_ref)
  //    (and property_name as a secondary key) — the identical normalizer pair
  //    PASS-2 already uses (parse-bmark-tape-xlsx.ts:65-96).
  const targetKey = normalizeAnalysisNameForMatch(rootRef.name);
  if (targetKey !== null) {
    for (const loan of s.poolStore.listLoanNameKeys()) {
      const originatorKey = normalizePropertyName(loan.originatorLoanRef);
      const propertyKey = normalizePropertyName(loan.propertyName);
      if (originatorKey === targetKey || propertyKey === targetKey) {
        if (!found.has(loan.loanInPoolId)) {
          found.set(loan.loanInPoolId, { poolId: loan.poolId, matchedBy: 'normalized-name-bridge' });
        }
      }
    }
  }

  // ── Refuse-when-≠1: the union must resolve to exactly ONE distinct loan. ──
  if (found.size === 0) {
    return { resolved: false, ambiguous: true, reason: 'NONE', matchCount: 0 };
  }
  if (found.size > 1) {
    return { resolved: false, ambiguous: true, reason: 'MULTIPLE', matchCount: found.size };
  }

  const [loanInPoolId, hit] = [...found.entries()][0]!;
  return {
    resolved: true,
    poolId: hit.poolId,
    loanInPoolId,
    matchedBy: hit.matchedBy,
  };
}

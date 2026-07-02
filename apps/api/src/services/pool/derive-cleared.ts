/**
 * Server-side re-derivation of the "Cleared" predicate (P4c-status).
 *
 * DOCTRINE: Cleared is a DERIVED read, never a stored flag and never trusted from
 * the client. The frontend computes it on the negotiation surface
 * (`apps/web/src/components/NegotiationSurface.tsx:294-322`); this module mirrors
 * that computation EXACTLY, but over persisted server state, so the `/close`
 * write path can gate on a server-re-derived Cleared = true.
 *
 * The mirrored frontend predicate:
 * ```
 * hasFatalFlag          = doctrine.flags.some(f => f.severity === 'critical')
 *                          || summary.coverage.insufficientCoverageGate.value === true
 * band                  = summary.ratingBand.value (lowercased)
 * bandOk                = band non-empty && !includes('decline') && !includes('high risk')
 * structuralAllRatified = convergenceTotal > 0 && ratifiedCount === convergenceTotal
 * derivedCleared        = !hasFatalFlag && bandOk && (convergenceTotal === 0 || structuralAllRatified)
 * ```
 * where `convergenceTotal` = count of BACKED structural (non-proceeds) mitigant
 * levers, and `ratifiedCount` = how many of those carry a persisted
 * OVERRIDE_DECISION committee action for the graph root.
 *
 * Server sources (all persisted, no client trust, no cross-layer wiring beyond
 * three existing read surfaces):
 *   - doctrine flags + rating band + insufficientCoverageGate:
 *       materializeRenderedAnalysis(rootId, recordGraphStore)  →  RenderedAnalysis
 *   - backed structural mitigant levers:
 *       bindLevers(rendered.mitigations)  (LEVERS table lifted verbatim below)
 *   - ratified lever ids:
 *       committeeActionsStore.getByRoot(rootId), OVERRIDE_DECISION events,
 *       structured `payload.overlayId` ('ov-lever-<id>-<hash>') — the SAME marker
 *       the frontend substring-matches, read here from the typed field.
 *   - dealRef → rootId:
 *       sqliteStore.lookupAnalysisByDealRef(dealRef) → graphId (lineage_root_id).
 */

import type {
  DoctrineEvaluationId,
  RenderedAnalysis,
  RenderedMitigationProposal,
  RevisionId,
} from '@cre/contracts';
import { materializeRenderedAnalysis } from '../materialize-rendered-analysis.js';
import { recordGraphStore as defaultRecordGraphStore, RecordGraphStore } from '../../storage/record-graph-store.js';
import { CommitteeActionsStore } from '../../storage/committee-actions-store.js';
import { store as defaultSqliteStore, SqliteStore } from '../../storage/sqlite-store.js';

/* -------------------------------------------------------------------------- */
/* Store handles — default to the app singletons; overridable for tests so the */
/* temp-DB gate can point every read at a throwaway copy.                      */
/* -------------------------------------------------------------------------- */

export interface ClearedDeriveStores {
  readonly recordGraphStore: RecordGraphStore;
  readonly committeeActionsStore: CommitteeActionsStore;
  readonly sqliteStore: Pick<SqliteStore, 'lookupAnalysisByDealRef'>;
}

let _testStores: ClearedDeriveStores | null = null;
let _defaultCommitteeActionsStore: CommitteeActionsStore | null = null;

/** Test hook: point the Cleared re-derivation at a temp-DB set of stores. */
export function _setClearedDeriveStoresForTests(stores: ClearedDeriveStores | null): void {
  _testStores = stores;
}

function stores(): ClearedDeriveStores {
  if (_testStores !== null) return _testStores;
  if (_defaultCommitteeActionsStore === null) _defaultCommitteeActionsStore = new CommitteeActionsStore();
  return {
    recordGraphStore: defaultRecordGraphStore,
    committeeActionsStore: _defaultCommitteeActionsStore,
    sqliteStore: defaultSqliteStore,
  };
}

/* -------------------------------------------------------------------------- */
/* LEVERS table — lifted VERBATIM from NegotiationSurface.tsx:134-160 so the   */
/* server and client share one definition of "structural lever." The only     */
/* fields the predicate reads are `id`, `levers` (bind key) and `lastResort`.  */
/* Presentation-only fields (name/orig/buyer/buyerWhy) are dropped here.       */
/* -------------------------------------------------------------------------- */

interface LeverDef {
  readonly id: string;
  /** Exact RenderedMitigationProposal.lever values that bind this ledger row. */
  readonly levers: readonly string[];
  /** proceeds is the last-resort economic lever — excluded from structural. */
  readonly lastResort?: boolean;
}

const LEVERS: readonly LeverDef[] = [
  { id: 'reserve',  levers: ['fund_reserve', 'cash_sweep_refi_reserve'] },
  { id: 'cash',     levers: ['springing_cash_management', 'in_place_cash_management'] },
  { id: 'guaranty', levers: ['require_guaranty', 'leverage_band_recourse', 'springing_dscr_recourse'] },
  { id: 'amort',    levers: ['require_amortization'] },
  { id: 'cp',       levers: ['condition_precedent'] },
  { id: 'proceeds', levers: ['reduce_proceeds'], lastResort: true },
];

interface LeverBinding {
  readonly def: LeverDef;
  readonly mitigant: RenderedMitigationProposal | null;
}

/** Mirror of NegotiationSurface.tsx:153-160. First-come one-to-one bind of a
 *  ledger row to a rendered mitigation proposal by exact `lever` enum match. */
function bindLevers(mitigations: readonly RenderedMitigationProposal[]): LeverBinding[] {
  const used = new Set<string>();
  return LEVERS.map((def) => {
    const mitigant = mitigations.find((m) => !used.has(m.id) && def.levers.includes(m.lever)) ?? null;
    if (mitigant) used.add(mitigant.id);
    return { def, mitigant };
  });
}

/** Ratified lever ids for a root, read from persisted OVERRIDE_DECISION committee
 *  actions. The frontend substring-matches `ov-lever-<id>-` in the action summary
 *  (NegotiationSurface.tsx:203-218); server-side we read the SAME marker from the
 *  structured `payload.overlayId` (`ov-lever-<id>-<hash>`), which the summary is
 *  built from — a sounder read of the same append-only state, no hash recompute. */
function ratifiedLeverIds(rootId: DoctrineEvaluationId): Set<string> {
  const out = new Set<string>();
  const actions = stores().committeeActionsStore.getByRoot(rootId);
  for (const a of actions) {
    if (a.kind !== 'OVERRIDE_DECISION') continue;
    const payload = a.payload as { readonly overlayId?: unknown; readonly summary?: unknown };
    const overlayId = typeof payload.overlayId === 'string' ? payload.overlayId : '';
    // Belt-and-suspenders: also fall back to the summary marker the frontend uses,
    // so a legacy action lacking a structured overlayId still reads correctly.
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    for (const def of LEVERS) {
      const marker = `ov-lever-${def.id}-`;
      if (overlayId.includes(marker) || summary.includes(marker)) out.add(def.id);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Result shape — carries the sub-terms so the route can surface a precise     */
/* rejection reason (which half of the predicate failed).                      */
/* -------------------------------------------------------------------------- */

export type ClearedResolution =
  | {
      readonly resolved: true;
      readonly cleared: boolean;
      readonly rootId: DoctrineEvaluationId;
      readonly hasFatalFlag: boolean;
      readonly band: string;
      readonly bandOk: boolean;
      readonly convergenceTotal: number;
      readonly ratifiedCount: number;
      readonly structuralAllRatified: boolean;
    }
  | {
      /** The dealRef could not be resolved to a single graph root, so Cleared
       *  cannot be re-derived. The route maps this to a 4xx (not a fake pass). */
      readonly resolved: false;
      readonly reason: 'DEAL_REF_NOT_FOUND' | 'DEAL_REF_AMBIGUOUS';
      readonly dealRef: string;
      readonly matches: number;
    };

/**
 * Re-derive Cleared for a loan's `dealRef` from persisted server state. Returns
 * the boolean plus its sub-terms, or a `resolved:false` outcome when the dealRef
 * does not map to exactly one graph root (never faked, never client-trusted).
 */
export function deriveClearedForDealRef(dealRef: string): ClearedResolution {
  const s = stores();
  const matches = s.sqliteStore.lookupAnalysisByDealRef(dealRef);
  if (matches.length === 0) {
    return { resolved: false, reason: 'DEAL_REF_NOT_FOUND', dealRef, matches: 0 };
  }
  // Option-A canonicalization (GENERAL policy — NOT a Sunroad hardcode): a dealRef
  // can span MULTIPLE independent re-ingest roots — each a full re-ingest of ONE deal,
  // with NO supersede-link between them. The lookup orders matches created_at DESC, so
  // `matches[0]` is the LATEST ingest → "latest ingest = current deal state". Resolve to
  // it rather than refusing on multi-root ambiguity (which blocked every re-ingested deal
  // from ever closing). `graphId` is a lineage-root RevisionId (lineage_root_id), NOT a
  // DoctrineEvaluationId — deriveClearedForLineageRoot resolves it like handleGraphRead.
  //
  // ★ OPEN DATA-MODEL ITEM (NOT a footnote): re-ingesting a deal creates independent
  //   lineage roots with no supersede-link / no shared root. "latest wins" is a POLICY
  //   over that gap, not a fix — real correctness risk if ingests race or an OLDER root is
  //   the intended canonical. Backlog: supersede-link on re-ingest, or reuse the lineage
  //   root on re-ingest so a deal has ONE evolving root. `DEAL_REF_AMBIGUOUS` is retained
  //   in the resolution type but is no longer returned from this path.
  const rootCount = new Set(matches.map((m) => m.graphId)).size;
  void rootCount; // informational — the canonical is always the latest ingest
  const lineageRootId = matches[0]!.graphId as RevisionId;
  return deriveClearedForLineageRoot(lineageRootId);
}

/**
 * Re-derive Cleared for a lineage-root RevisionId (the 64-hex graph root, e.g.
 * `lookupAnalysisByDealRef(...).graphId`). Resolves lineageRootId → latest
 * revision envelope → `doctrineEvaluationId` → materialize, mirroring
 * `handleGraphRead` (analysis.routes.ts:731-742), then runs the predicate.
 * Split out so the dealRef→root join and the predicate arithmetic are testable
 * independently.
 */
export function deriveClearedForLineageRoot(lineageRootId: RevisionId): ClearedResolution {
  const s = stores();
  const envelope = s.recordGraphStore.getLatestRevisionByLineageRoot(lineageRootId);
  if (envelope === null) {
    return { resolved: false, reason: 'DEAL_REF_NOT_FOUND', dealRef: lineageRootId, matches: 0 };
  }
  const rootId: DoctrineEvaluationId = envelope.doctrineEvaluationId;
  const rendered: RenderedAnalysis = materializeRenderedAnalysis(rootId, s.recordGraphStore);

  // ── Structural mitigant levers (backed, non-proceeds) ────────────────────
  const leverBindings = bindLevers(rendered.mitigations);
  const structuralBound = leverBindings.filter((b) => !b.def.lastResort && b.mitigant !== null);
  const convergenceTotal = structuralBound.length;
  const ratified = ratifiedLeverIds(rootId);
  const ratifiedCount = structuralBound.filter((b) => ratified.has(b.def.id)).length;
  const structuralAllRatified = convergenceTotal > 0 && ratifiedCount === convergenceTotal;

  // ── Doctrine flags + band + coverage gate ────────────────────────────────
  const hasFatalFlag =
    rendered.doctrine.flags.some((f) => f.severity === 'critical') ||
    rendered.summary.coverage.insufficientCoverageGate.value === true;
  const band = String(rendered.summary.ratingBand.value ?? '').toLowerCase();
  const bandOk = band.length > 0 && !band.includes('decline') && !band.includes('high risk');

  const cleared = !hasFatalFlag && bandOk && (convergenceTotal === 0 || structuralAllRatified);

  return {
    resolved: true,
    cleared,
    rootId,
    hasFatalFlag,
    band,
    bandOk,
    convergenceTotal,
    ratifiedCount,
    structuralAllRatified,
  };
}

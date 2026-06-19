/**
 * Snapshot-reader helpers for the memo render path (PR ii).
 *
 * The renderer prefers the persisted DoctrineRenderSnapshot over recomputing
 * dealResult + composedMitigationPackage on HEAD's doctrine. These helpers
 * translate snapshot data into the structured shapes buildCommitteeMemo
 * expects (AuthoritativeNumbers + CleanDoctrineFinding[] + ComposedMitigationPackage),
 * so the renderer doesn't reach into snapshot internals at the section level.
 *
 * Honesty constraints:
 *   - Headlines use the same `headlineFor`-style logic the recompute path
 *     uses, so a snapshot-rendered memo's findings table reads identically
 *     to a recompute-rendered one at the same render state.
 *   - When the snapshot's producer version is unknown to this reader (a
 *     future bump), `loadRenderSnapshot` returns null and the renderer falls
 *     back to recompute — degrades gracefully.
 */

import type {
  DoctrineEvaluationId,
  DoctrineRenderSnapshot,
  SnapshotDimOutput,
} from '@cre/contracts';
import { SNAPSHOT_PRODUCER_VERSION } from '@cre/contracts';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import type {
  AuthoritativeNumbers,
  CleanDoctrineFinding,
} from '../narrative/prompt-templates.js';
import type { ComposedMitigationPackage } from '../mitigation/compose-mitigations.js';

/**
 * Load a snapshot keyed by doctrineEvaluationId. Returns null when the
 * snapshot is absent (forward-only deals; pre-PR-i evals) OR when the
 * snapshot's producer version is unknown to this reader (the writer's at a
 * version we don't speak; safer to fall back than to misread).
 *
 * Two-step contract: present + supported-version, or null. No exceptions.
 */
export function loadRenderSnapshot(
  doctrineEvaluationId: DoctrineEvaluationId,
  store: RecordGraphStore,
): DoctrineRenderSnapshot | null {
  const snap = store.getDoctrineRenderSnapshot(doctrineEvaluationId);
  if (snap === null) return null;
  // Reader rejects future / unknown producer versions and falls back.
  if (snap.snapshotProducerVersion !== SNAPSHOT_PRODUCER_VERSION) return null;
  return snap;
}

/**
 * Reconstruct a `CleanDoctrineFinding[]` from snapshot.dimOutputs. Filters
 * to applicable dims whose tier is above 'baseline'/'low'/'n/a'/''. Headlines
 * are derived from each dim's `derivedOutputs` using the same per-dim
 * formatting the recompute path uses (mirrors `headlineFor` in
 * `build-narrative.ts`). Pure.
 */
export function cleanDoctrineFindingsFromSnapshot(
  snapshot: DoctrineRenderSnapshot,
): readonly CleanDoctrineFinding[] {
  const findings: CleanDoctrineFinding[] = [];
  for (const [dimensionId, dim] of Object.entries(snapshot.dimOutputs)) {
    if (dim.applicability !== 'applicable') continue;
    const tier = (dim.tier ?? '').toLowerCase();
    if (tier === 'baseline' || tier === 'low' || tier === 'n/a' || tier === '') continue;
    findings.push({
      dimNumber: DIM_NUMBER_BY_ID[dimensionId] ?? 0,
      dimensionId,
      tier: dim.tier ?? 'unknown',
      headline: headlineFor(dimensionId, dim),
    });
  }
  findings.sort((a, b) => a.dimNumber - b.dimNumber);
  return findings;
}

/**
 * Type-cast the snapshot's preserved `composedMitigationPackage` back to the
 * structured `ComposedMitigationPackage` shape. The snapshot stored opaque
 * sub-shapes (Reconciliation, SponsorBurdenProfile, FundedExitProjection,
 * finalState) verbatim — they're structurally the in-memory shapes; we
 * declare the cast at the contract seam.
 */
export function composedFromSnapshot(
  snapshot: DoctrineRenderSnapshot,
): ComposedMitigationPackage {
  return snapshot.composedMitigationPackage as unknown as ComposedMitigationPackage;
}

/**
 * Canonical dim numbering used for the v1.6 red-flag-assessment headline.
 * Mirrors `DIM_NUMBER_BY_ID` in build-narrative.ts. Duplicated here to keep
 * snapshot-readers free of build-narrative dependency; bump both in sync if
 * a new dim lands.
 */
const DIM_NUMBER_BY_ID: Readonly<Record<string, number>> = {
  'leverage-ltv':                1,
  'coverage-dscr':               2,
  'debt-yield':                  3,
  'refinance-feasibility':       4,
  'income-concentration':        5,
  'rollover':                    6,
  'cap-rate-valuation-stress':   7,
  'asset-class':                 8,
  'sponsor-borrower-quality':    9,
};

/**
 * Per-dim headline derived from `derivedOutputs`. Mirrors `headlineFor` in
 * `apps/api/src/services/narrative/build-narrative.ts` — any new dim
 * formatting must be added here in lockstep.
 */
function headlineFor(dimensionId: string, dim: SnapshotDimOutput): string {
  const num = (k: string): number | null => {
    const v = dim.derivedOutputs[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  switch (dimensionId) {
    case 'cap-rate-valuation-stress': {
      const va = num('valuationAggressiveness');
      return va !== null ? `valuation aggressiveness ${(va * 100).toFixed(1)}%` : 'cap-rate stress applied';
    }
    case 'leverage-ltv': {
      const sl = num('stressedLtv');
      return sl !== null ? `stressed LTV ${(sl * 100).toFixed(2)}%` : 'stressed-LTV finding';
    }
    case 'coverage-dscr': {
      const x = num('coverage');
      return x !== null ? `sustainable DSCR ${x.toFixed(2)}x` : 'coverage finding';
    }
    case 'debt-yield': {
      const x = num('debtYield');
      return x !== null ? `debt yield ${(x * 100).toFixed(2)}%` : 'debt-yield finding';
    }
    case 'refinance-feasibility': {
      const x = num('exitDscr');
      return x !== null ? `exit DSCR ${x.toFixed(2)}x` : 'refinance feasibility finding';
    }
    default:
      return `${dim.tier ?? 'finding'} tier`;
  }
}

/**
 * Re-export so renderer call sites have a single import surface.
 */
export type { AuthoritativeNumbers } from '../narrative/prompt-templates.js';

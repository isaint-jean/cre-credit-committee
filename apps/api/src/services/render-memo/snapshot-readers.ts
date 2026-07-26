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
import { dimensionRiskSentence } from '../narrative/committee-voice.js';

/**
 * Versions this reader recognizes. 1.0 + 1.1 + 1.2 — load all; 1.1's noiBasis
 * and 1.2's externalDD are optional on older snapshots (each falls back to its
 * own honest default when absent). Future versions extend this set in lockstep.
 */
const SUPPORTED_PRODUCER_VERSIONS: readonly string[] = ['1.0', '1.1', '1.2'];

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
  // Reader accepts the known-version set; rejects unknown (future) versions
  // and falls back. Different from PR (i)'s strict equality — we now carry
  // historical version support per the v1.1 bump policy.
  if (!SUPPORTED_PRODUCER_VERSIONS.includes(snap.snapshotProducerVersion)) return null;
  return snap;
}

// Reference SNAPSHOT_PRODUCER_VERSION so TS doesn't complain about the
// unused import (the version constant is the single source of truth that
// the producer + boot check pin against; keep the import to anchor the
// "this file is the authoritative reader" relationship).
void SNAPSHOT_PRODUCER_VERSION;

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
 * Per-dim committee-voice risk headline. Delegates to the committee-voice
 * mapping layer (identical to `headlineFor` in build-narrative.ts) so the
 * snapshot render path emits the same plain-English risk sentence — no
 * dimension id, tier enum, or raw metric.
 */
function headlineFor(dimensionId: string, dim: SnapshotDimOutput): string {
  return dimensionRiskSentence(dimensionId, dim.tier ?? '');
}

/**
 * Re-export so renderer call sites have a single import surface.
 */
export type { AuthoritativeNumbers } from '../narrative/prompt-templates.js';

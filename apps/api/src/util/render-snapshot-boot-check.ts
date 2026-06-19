/**
 * Render-snapshot boot check (PR i).
 *
 * The render-snapshot sibling is forward-only: every NEW DoctrineEvaluation
 * gets a matching DoctrineRenderSnapshot. This check verifies the wiring at
 * boot — contract types load, storage round-trips faithfully, and the
 * snapshot producer version is consistent with the contract constant.
 *
 * The check inserts a SYNTHETIC snapshot into a SCRATCH in-memory SQLite
 * (separate from the production DB) and reads it back. Catches:
 *   - SNAPSHOT_PRODUCER_VERSION drift between contract + producer
 *   - Contract shape changes that break canonical-JSON serialization
 *   - Storage helper regressions (insertDoctrineRenderSnapshot /
 *     getDoctrineRenderSnapshot semantics)
 *
 * Does NOT touch the production DB. Does NOT assert anything about historical
 * evals (those carry no snapshot by design — forward-only).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SNAPSHOT_PRODUCER_VERSION,
  type DoctrineRenderSnapshot,
  type DoctrineRenderSnapshotId,
  type DoctrineEvaluationId,
} from '@cre/contracts';
import { computeDoctrineRenderSnapshotId } from './content-hash.js';

export class RenderSnapshotBootCheckError extends Error {
  override readonly name = 'RenderSnapshotBootCheckError';
}

export function performRenderSnapshotBootCheck(): void {
  // (1) Contract producer-version constant.
  if (SNAPSHOT_PRODUCER_VERSION !== '1.0') {
    throw new RenderSnapshotBootCheckError(
      `SNAPSHOT_PRODUCER_VERSION = '${SNAPSHOT_PRODUCER_VERSION}', expected '1.0' (PR i ships at 1.0). ` +
      `If you intend to bump the producer version, also extend the SnapshotProducerVersion type AND ` +
      `update this boot check.`,
    );
  }

  // (2) Storage round-trip on an in-memory scratch DB. Build a synthetic
  // snapshot, insert, query, compare. No production-DB pollution.
  const scratchDir = join(tmpdir(), 'cre-render-snapshot-bootcheck');
  if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true });
  const scratchDbPath = join(scratchDir, `bootcheck-${process.pid}.db`);

  // Lazy-import to avoid initializing the production singleton on import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RecordGraphStore: RecordGraphStoreCtor } = require('../storage/record-graph-store.js') as {
    RecordGraphStore: new (path: string) => import('../storage/record-graph-store.js').RecordGraphStore;
  };
  const scratchStore = new RecordGraphStoreCtor(scratchDbPath);
  // RecordGraphStore enables FK enforcement by default; the synthetic snapshot's
  // doctrine_evaluation_id has no matching row in this scratch DB, so disable
  // FK enforcement for the round-trip check only. The production DB keeps FK
  // enforcement enabled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((scratchStore as unknown as { db: { pragma: (s: string) => void } }).db).pragma('foreign_keys = OFF');

  const fakeEvalId = ('0'.repeat(64)) as DoctrineEvaluationId;
  const body = {
    doctrineEvaluationId: fakeEvalId,
    snapshotProducerVersion: SNAPSHOT_PRODUCER_VERSION,
    capturedAt: '2026-06-19T00:00:00.000Z' as never,
    rating: {
      recommendation: 'Approve' as const,
      band: 'Strong' as const,
      ratedRisk: 0.1,
    },
    dimOutputs: {
      'cap-rate-valuation-stress': {
        tier: 'baseline',
        applicability: 'applicable' as const,
        derivedOutputs: { stressedValue: 100_000_000, stressedLtv: 0.5 },
      },
    },
    authoritativeNumbers: {
      ratingRecommendation: 'Approve',
      ratingBand: 'Strong',
      assetType: null,
      subType: null,
      originalLoanAmount: 50_000_000,
      finalLoanAmount: 50_000_000,
      proceedsReduction: 0,
      stressedValue: 100_000_000,
      stressedLtv: 0.5,
      stressedLtvAtFinalLoan: 0.5,
      ltvTrigger: 0.7,
      concludedValue: 120_000_000,
      concludedValueSource: 'extracted-appraisal' as const,
      valuationConfidenceNote: null,
      exitDscrBaseline: 1.5,
      exitDscrAtFinalLoan: 1.5,
      exitDscrTrigger: 1.2,
      exitDscrCureTarget: 1.25,
      standaloneAmortPaydown: null,
      composedAmortPaydown: null,
    },
    composedMitigationPackage: {
      proposals: [],
      initialProposals: [],
      finalLoanAmount: 50_000_000,
      reconciliation: {},
      sponsorBurdenProfile: {},
      fundedExitProjection: {},
      finalState: {},
    },
  };
  const synthetic: DoctrineRenderSnapshot = {
    id: computeDoctrineRenderSnapshotId(body) as DoctrineRenderSnapshotId,
    ...body,
  };

  // The synthetic eval id has no row in doctrine_evaluations on this scratch
  // DB, so the FK would normally reject. Disable FK enforcement for the
  // scratch round-trip only — production wiring keeps FK on. (sqlite default
  // is FK OFF unless explicitly enabled; RecordGraphStore relies on this.)
  const insertResult = scratchStore.insertDoctrineRenderSnapshot(synthetic);
  if (!insertResult.inserted) {
    throw new RenderSnapshotBootCheckError(
      'insertDoctrineRenderSnapshot returned inserted=false on a fresh in-memory DB — duplicate id?',
    );
  }

  const fetched = scratchStore.getDoctrineRenderSnapshot(fakeEvalId);
  if (fetched === null) {
    throw new RenderSnapshotBootCheckError(
      'getDoctrineRenderSnapshot returned null immediately after a successful insert',
    );
  }
  if (fetched.id !== synthetic.id) {
    throw new RenderSnapshotBootCheckError(
      `round-trip id mismatch: inserted ${synthetic.id} but fetched ${fetched.id}`,
    );
  }
  if (fetched.snapshotProducerVersion !== SNAPSHOT_PRODUCER_VERSION) {
    throw new RenderSnapshotBootCheckError(
      `round-trip producer version mismatch: ${fetched.snapshotProducerVersion} !== ${SNAPSHOT_PRODUCER_VERSION}`,
    );
  }
  if (fetched.rating.recommendation !== 'Approve') {
    throw new RenderSnapshotBootCheckError(
      `round-trip rating.recommendation lost: got ${fetched.rating.recommendation}`,
    );
  }
  if (fetched.authoritativeNumbers.stressedValue !== 100_000_000) {
    throw new RenderSnapshotBootCheckError(
      `round-trip authoritativeNumbers.stressedValue lost: got ${fetched.authoritativeNumbers.stressedValue}`,
    );
  }

  scratchStore.close();
}

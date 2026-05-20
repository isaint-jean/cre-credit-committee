// Integration adapter interfaces (Phase 4 - productization layer).
//
// Type-only contracts for two boundary integrations:
//   1. CreditInputsIngestionAdapter - receives external credit inputs (from data
//      vendors, internal warehouses, customer uploads, etc.) and produces an
//      ExtractionResult for the new-spine ingestion pipeline.
//   2. ExportSink - receives a CommitteeSnapshot (or other read-pole artifacts)
//      for downstream reporting / warehousing / archival.
//
// This module declares INTERFACES ONLY. No implementations. Implementations land
// in subsequent phases / integration partner deliveries; the contracts here let
// us verify boundary discipline and integration-readiness without committing to
// any specific upstream/downstream system.
//
// CRITICAL DISCIPLINE:
//   - Adapters are external boundaries. They MUST NOT be invoked from inside the
//     deterministic spine (producers, render, projections). They are top-level
//     concerns invoked at orchestration points (route handlers, scheduled jobs).
//   - Adapter inputs/outputs are TYPED CONTRACTS from this package. Adapters do
//     NOT introduce parallel data shapes that compete with @cre/contracts truth.
//   - Adapter implementations may have I/O, retries, side effects. The interface
//     surface MUST type those explicitly (Promise<T>, error variants).

import type { CommitteeSnapshot } from './committee-snapshot.js';
import type { ExtractionResult } from './extraction.js';
import type { ISODateTime } from './versioning.js';

/* ----------------------- Credit inputs ingestion ----------------------- */

// Identifies the source system the inputs came from. Free-form on the contract
// surface; consumers may impose stricter conventions (e.g., a known vendor list).
export interface CreditInputsSource {
  readonly system: string;        // 'salesforce', 'snowflake', 'manual-upload', etc.
  readonly identifier: string;    // a stable id within the source system
  readonly receivedAt: ISODateTime;
}

// Ingestion adapter contract. Implementations turn raw upstream data into a typed
// ExtractionResult that the new spine can consume via the existing ingestion path.
export interface CreditInputsIngestionAdapter {
  readonly name: string;          // adapter identifier for observability / auditing
  // Pull or receive inputs from the upstream source, normalize into the typed
  // ExtractionResult shape. Implementations MAY perform I/O (HTTP, file read, etc.).
  readonly ingest: (
    source: CreditInputsSource,
  ) => Promise<IngestionResult>;
}

export type IngestionResult =
  | { readonly ok: true; readonly extractionResult: ExtractionResult }
  | { readonly ok: false; readonly error: IngestionError };

export interface IngestionError {
  readonly code: string;          // 'SOURCE_UNREACHABLE' / 'SHAPE_MISMATCH' / etc.
  readonly message: string;
  readonly detail?: string;
}

/* --------------------------- Export sink ----------------------------- */

export const EXPORT_SINK_KINDS = [
  'committee-snapshot',
] as const;
export type ExportSinkKind = (typeof EXPORT_SINK_KINDS)[number];

// Export sink contract. Implementations forward read-pole artifacts to downstream
// systems (data warehouses, BI tools, archival storage, etc.). Sinks are
// fire-and-forget from the spine's perspective; failures are logged but never
// affect the immutable source-of-truth records.
export interface ExportSink {
  readonly name: string;
  readonly accepts: readonly ExportSinkKind[];
  // Forward a CommitteeSnapshot to the downstream sink. Implementations MAY
  // perform I/O; failures should be reported via ExportResult, not thrown.
  readonly emitSnapshot: (
    snapshot: CommitteeSnapshot,
  ) => Promise<ExportResult>;
}

export type ExportResult =
  | { readonly ok: true; readonly externalRef?: string }   // optional ref returned by the downstream system
  | { readonly ok: false; readonly error: ExportError };

export interface ExportError {
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
}

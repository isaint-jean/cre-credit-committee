/**
 * @cre/contracts — source-of-truth contracts for the underwriting + doctrine pipeline.
 *
 * This package defines TYPES and CONSTANTS only. No behavior. No services. No I/O.
 * Every consumer service in apps/api compiles against these contracts; the contracts package
 * imports nothing from any service.
 *
 * Five regions:
 *   1. Identity     — content-hash PKs, branded record ids, ContentHashFn signature
 *   2. Versioning   — DOCTRINE / JUDGMENT_ENGINE / STRESS_ENGINE / VALUATION_ENGINE / RENDER_CONTRACT
 *   3. Stage outputs — AdjustedInputs, NarrativeFacts, CrossCheckResult, StressOutputs,
 *                      ValuationConclusion, LibrarySnapshot
 *   4. Doctrine     — rules / flags / reason-codes / components / adjustments / evaluation
 *   5. Replay key   — the canonical tuple for replay verification
 *
 * Plus typed-error payloads (errors.ts) and asset classification (asset.ts, source-tier.ts).
 */

// Foundations
export * from './versioning.js';
export * from './identity.js';
export * from './replay-key.js';
export * from './revision-lineage.js';

// Domain primitives
export * from './asset.js';
export * from './source-tier.js';

// Stage output records
export * from './narrative-facts.js';
export * from './adjusted-inputs.js';
export * from './library-snapshot.js';
export * from './cross-check.js';
export * from './stress.js';
export * from './valuation.js';
export * from './extraction.js';
export * from './market-benchmarks.js';
export * from './manifesto.js';

// Judgment-engine rule registry + manifest
export * from './judgment-engine-rules.js';
export * from './judgment-engine-manifest.js';

// Doctrine subdomain
export * from './doctrine/index.js';

// Stage 11 hydration output (typed bundle of all 9 records)
export * from './hydrated-record-graph.js';

// Stage 12 projection output (bijective structural projection over the bundle)
export * from './underwriting-context.js';

// Stage 13 read-pole render output (content-hashed; sentinel-applied)
export * from './rendered-analysis.js';

// Phase 2 (post-7.2) - controlled write-back layer. Sibling contracts that overlay
// RenderedAnalysis with human-authored annotations, audit events, and exportable
// snapshots. NONE of these participate in the underwriting deterministic spine.
export * from './editable-overlay.js';
export * from './audit-log.js';
export * from './committee-snapshot.js';

// Phase 3 - committee workflow layer. Deal-level lifecycle, committee action events,
// and chronological timeline. Parallel to the overlay/audit/snapshot system; never
// participates in underwriting computation. Lifecycle state is ALWAYS derived by
// projection from the immutable event streams, never stored.
export * from './deal-lifecycle.js';
export * from './committee-action.js';
export * from './committee-timeline.js';

// Phase 4 - productization layer. Roles + integration adapter interfaces. Both are
// API-boundary concerns; the core domain does NOT branch on roles or invoke adapters
// directly.
export * from './roles.js';
export * from './integration-adapters.js';

// Batch 1A (post-Phase 4) - rent-roll input record + lease-type / tenant-status enums.
// Drives Year 1 rent-roll-based underwriting via the Batch 1 evidence-gated build.
export * from './rent-roll.js';

// Batch 1H - property-metadata record. Property identity + physical specs
// for Property & Loan Summary header + Property Detail tabs.
export * from './property-metadata.js';

// Institutional-memory layer - rejected-deal corpus (CRE Credit Handbook §III).
// Imported from the Master Kick List xlsx into kicks_registry. Today: storage
// only (queryable via the store). Engine consultation is deferred to a later
// ticket that depends on the handbook framework (#31).
export * from './kick.js';

// Typed error payloads
export * from './errors.js';

/**
 * Versioning spine.
 *
 * Five INDEPENDENT version axes. Each persisted record stamps every axis it depends on so the
 * replay tuple is fully realized. Bumping any axis requires a coordinated migration step in the
 * owning module — see render-migrations.ts for the existing pattern; analogous registries land in
 * judgment / stress / valuation / doctrine over time.
 *
 * No inline "1.0" literals are permitted in pipeline code. Every producer reads from these
 * constants. The corresponding `*Version` types are derived from the constants so that bumping
 * the constant automatically updates the type.
 */

export const DOCTRINE_VERSION = '1.0' as const;
export const JUDGMENT_ENGINE_VERSION = '1.1' as const;
export const STRESS_ENGINE_VERSION = '1.0' as const;
export const VALUATION_ENGINE_VERSION = '1.0' as const;
export const RENDER_CONTRACT_VERSION = '1.0' as const;
export const EXTRACTION_ENGINE_VERSION = '1.3' as const;
export const MANIFESTO_CONTRACT_VERSION = '1.0' as const;
/**
 * Handbook-engine semantic version. Stamped onto every HandbookEvaluation record
 * (#31, Commit 1) so historical evaluations stay anchored to the engine semantics
 * they were produced under. Bump rules:
 *   PATCH (1.0.0 → 1.0.1): bug fixes that don't change firing behavior.
 *   MINOR (1.0.0 → 1.1.0): bug fixes that change firing behavior in edge cases,
 *     or new operators / formula ops that don't affect existing principles.
 *   MAJOR (1.0.0 → 2.0.0): semantic changes to existing operators or condition
 *     evaluation order. Re-evaluation recommended for historical deals.
 */
export const HANDBOOK_ENGINE_VERSION = '1.0.0' as const;

export type DoctrineVersion = typeof DOCTRINE_VERSION;
/**
 * Historical-replay union: includes every JUDGMENT_ENGINE_VERSION ever shipped so
 * JUDGMENT_ENGINE_MANIFEST can carry an append-only history of state hashes. Bump the
 * `JUDGMENT_ENGINE_VERSION` constant and EXTEND this union (do not replace) when adding
 * a new judgment-engine revision.
 */
export type JudgmentEngineVersion = '1.0' | '1.1';
export type StressEngineVersion = typeof STRESS_ENGINE_VERSION;
export type ValuationEngineVersion = typeof VALUATION_ENGINE_VERSION;
export type RenderContractVersion = typeof RENDER_CONTRACT_VERSION;
export type ExtractionEngineVersion = typeof EXTRACTION_ENGINE_VERSION;
export type ManifestoContractVersion = typeof MANIFESTO_CONTRACT_VERSION;
export type HandbookEngineVersion = typeof HANDBOOK_ENGINE_VERSION;

/**
 * ISO 8601 UTC timestamp, frozen at extraction time. Used as `analysisAsOfDate` everywhere a
 * timestamp would otherwise need `new Date()`. Must never be derived from wall-clock at any
 * downstream stage — replay determinism depends on it.
 */
export type ISODateTime = string;

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
export const JUDGMENT_ENGINE_VERSION = '1.2' as const;
export const STRESS_ENGINE_VERSION = '1.0' as const;
export const VALUATION_ENGINE_VERSION = '1.0' as const;
export const RENDER_CONTRACT_VERSION = '1.0' as const;
export const EXTRACTION_ENGINE_VERSION = '1.5' as const;
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
 *
 * Version history:
 *   1.0.0 — initial release.
 *   1.1.0 — LLM_CONTEXT dispatch (async engine, llmEvaluator dep).
 *   1.2.0 — per-principle LLM context bundle gains curated rentRoll (top-10 tenants
 *           by in-place income + "other" aggregate when applicable). The per-tenant
 *           block flows through computeContextHash so identical rent rolls cache-hit
 *           and changed rent rolls (e.g., one tenant's rent changes) cache-miss into
 *           a fresh evaluation. Bump invalidates ALL 1.1.0 llm_principle_eval_cache
 *           rows; expected — different context shape → different hash → fresh eval.
 *   1.3.0 — per-principle context bundle gains computedFacts.refinancingRisk (per-tenant
 *           lease vs maturity+N-month refi window, with deterministic verdict). SYSTEM_PROMPT
 *           extended with the Authoritative-Derived-Facts precedence rule (LLM treats
 *           computed facts as ground truth; chooses needs_manual_input rather than
 *           guessing from priors when data is genuinely absent). Invalidates ALL 1.2.0
 *           llm_principle_eval_cache rows; expected — different context shape +
 *           different system message → different hash → fresh eval. Companion
 *           contract change: AdjustedInputs.loan gains an explicit `maturityDate`
 *           field threaded from LoanTermsExtraction.maturityDate so the gate can
 *           compare per-tenant lease expirations against maturity + refi window.
 *   1.4.0 — computedFacts gains reserveSchedule (9-field) + terminationOptions
 *           (extraction-gap marker). Invalidates 1.3.0 llm_principle_eval_cache rows.
 *           reserveSchedule surfaces the FULL AdjustedInputs.capitalReserves (monthly
 *           replacement reserves, capex, TI/LC, tenant improvements, leasing commissions,
 *           upfront figures, PCA immediate repairs, and the capex schedule) plus three
 *           derived roll-ups (totalMonthlyReservesDollars, totalUpfrontReservesDollars,
 *           anyMonthlyReservePopulated) so reserves-related principles (P-III-3, P-III-4,
 *           P-IV-OFF-3) can read the whole concluded reserve picture instead of firing
 *           CRITICAL on a single null/zero field. terminationOptions is always an
 *           extraction-gap marker in Phase 2 (extracted=false; rent-roll footnotes are
 *           not parsed today) so principles requiring termination-option data return
 *           needs_manual_input with kind='termination_option_extraction_gap' rather
 *           than silently missing the data. SYSTEM_PROMPT extends with two tightened
 *           bullets near the Authoritative-Derived-Facts rule (one for reserves, one
 *           for terminationOptions). Spec-clean (§2.3): the new builders read
 *           AdjustedInputs only (no ExtractionResult import).
 */
export const HANDBOOK_ENGINE_VERSION = '1.4.0' as const;

/**
 * Narrative-engine simple version. Stamped onto every NarrativeEvaluation record
 * (Piece A Phase 1, batch 1) so historical narratives stay anchored to the engine
 * semantics they were composed under. Simple-version family (matches
 * JUDGMENT_ENGINE_VERSION cadence, NOT HANDBOOK_ENGINE_VERSION's semver) per
 * SPEC §14.4 v23 Decision 6. Bump rules:
 *   MINOR (1.0 → 1.1): new injection-point producer slots, prompt-template
 *     updates that materially change LLM output, format-flags filter
 *     semantics changes.
 *   MAJOR (1.0 → 2.0): semantic restructure (e.g., FK shape change, switch
 *     from per-piece records to a unified record, consumer-contract break).
 * Historical-replay union extends as new versions ship — see
 * `NARRATIVE_ENGINE_MANIFEST` (mirror of the judgment-engine manifest pattern).
 */
export const NARRATIVE_ENGINE_VERSION = '1.3' as const;

export type DoctrineVersion = typeof DOCTRINE_VERSION;
/**
 * Historical-replay union: includes every JUDGMENT_ENGINE_VERSION ever shipped so
 * JUDGMENT_ENGINE_MANIFEST can carry an append-only history of state hashes. Bump the
 * `JUDGMENT_ENGINE_VERSION` constant and EXTEND this union (do not replace) when adding
 * a new judgment-engine revision.
 */
export type JudgmentEngineVersion = '1.0' | '1.1' | '1.2';
export type StressEngineVersion = typeof STRESS_ENGINE_VERSION;
export type ValuationEngineVersion = typeof VALUATION_ENGINE_VERSION;
export type RenderContractVersion = typeof RENDER_CONTRACT_VERSION;
export type ExtractionEngineVersion = typeof EXTRACTION_ENGINE_VERSION;
export type ManifestoContractVersion = typeof MANIFESTO_CONTRACT_VERSION;
export type HandbookEngineVersion = typeof HANDBOOK_ENGINE_VERSION;
/**
 * Historical-replay union: includes every NARRATIVE_ENGINE_VERSION ever shipped so
 * NARRATIVE_ENGINE_MANIFEST can carry an append-only history of state hashes. Bump
 * the `NARRATIVE_ENGINE_VERSION` constant and EXTEND this union (do not replace)
 * when adding a new narrative-engine revision.
 */
export type NarrativeEngineVersion = '1.0' | '1.1' | '1.2' | '1.3';

/**
 * ISO 8601 UTC timestamp, frozen at extraction time. Used as `analysisAsOfDate` everywhere a
 * timestamp would otherwise need `new Date()`. Must never be derived from wall-clock at any
 * downstream stage — replay determinism depends on it.
 */
export type ISODateTime = string;

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

export const DOCTRINE_VERSION = '1.3' as const;
export const JUDGMENT_ENGINE_VERSION = '1.10' as const;
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
 *   1.5.0 — computedFacts gains noiReconciliation; trailingActualNoi + issuerStatedNoi*
 *           threaded onto AdjustedInputs.metrics. Invalidates 1.4.0 cache. AdjustedInputs
 *           body grew → AnalysisId cascade (third in series, documented schema evolution).
 *           noiReconciliation compares the system's underwritten NOI
 *           (`AdjustedInputs.metrics.noi`) against the trailing-actual NOI
 *           (`AdjustedInputs.metrics.trailingActualNoi`, threaded from
 *           ExtractionResult.t12.noi at Stage 4). When the system UW NOI exceeds the
 *           trailing actual NOI, the rule fires (verdict=noi_uplift_present) AND
 *           requires the excess to be backed by durable documented drivers (signed/
 *           executed leases + contractual rent steps). Today the rent-roll extractor
 *           does NOT pull signed-lease execution status, so `signedLeaseBackingAvailable`
 *           is ALWAYS false in this engine version and the resolution path returns
 *           needs_manual_input with kind='signed_lease_status_extraction_gap'. This is
 *           the HONEST behavior — the engine does NOT fabricate signed-lease backing,
 *           accept the uplift on asset-class priors, or reject it on stereotype.
 *           Companion handbook bump: P-III-15 added in universal_framework cluster as
 *           the per-deal NOI reconciliation rule; handbook version 2026.3-gate →
 *           2026.4-noi-recon. SYSTEM_PROMPT extends with the NOI-recon precedence rule.
 *           Spec-clean (§2.3): buildNoiReconciliationFacts reads AdjustedInputs only;
 *           judgment is the legitimate Stage-4 consumer of ExtractionResult.
 *   1.6.0 — extraction.t12 renamed to inPlace (regex collision + dedup made the
 *           t12 slot unreachable; the field has always actually held In-Place data).
 *           New t12Actual slot added next to inPlace — always null today, will be
 *           populated when a separate class-(b) trailing-actuals ingest slot lands.
 *           Class-(a) builders (reserves, taxes, reimbursements, vacancyLoss,
 *           totalOpEx) now cascade `t12Actual → sellerUwOperatingStatement → inPlace`
 *           so the issuer's UW-column adjustments (Prop 13 taxes, market-rent
 *           reimbursements, etc.) flow through to AdjustedInputs instead of being
 *           silently overridden by In-Place values. This is THE fix that flipped
 *           Sunroad's $0 monthly replacement reserves to the issuer's stated
 *           $4,579/mo. Source tier IN_PLACE added between T12_ACTUAL and RENT_ROLL.
 *           JE_T12_MISSING renamed JE_TRAILING_ACTUALS_MISSING (now fires on every
 *           deal today since no source CF carries a separate strict-T-12 column);
 *           new JE_IN_PLACE_MISSING and JE_PERIOD_LABEL_MISMATCH (informational —
 *           delta=0; surfaces in audit but does NOT dock data_confidence).
 *           AdjustedInputs.metrics gains issuerCfUwNoi (from CF's GS U/W column)
 *           and inPlaceNoi (from CF's In-Place column) as cross-references next to
 *           the unchanged trailingActualNoi/issuerStatedNoi* fields. trailingActualNoi
 *           now sources from t12Actual.noi — honestly null today rather than
 *           silently borrowing In-Place data. AdjustedInputs body grew →
 *           AnalysisId cascade (4th in series). Invalidates 1.5.0 cache.
 *           Companion handbook bump: 2026.4-noi-recon → 2026.5-period-fix. JUDGMENT_ENGINE
 *           bumped 1.2 → 1.3 (rule registry change). Cleanup ticket logged:
 *           trailing-actuals ingest slot (class-b).
 */
export const HANDBOOK_ENGINE_VERSION = '1.6.0' as const;

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
export const NARRATIVE_ENGINE_VERSION = '1.6' as const;

/**
 * Mitigation-engine semantic version. Stamped onto every MitigationProposalSet
 * record so the content-hash id changes when the engine's desk constants,
 * lever set, or sizing doctrine change — replay determinism + idempotent
 * re-evaluation on bump. Bump rules:
 *   MINOR (1.0 → 1.1): add a lever; widen the principle-enrichment table;
 *     adjust a desk constant.
 *   MAJOR (1.0 → 2.0): change a sizing formula or restructure the proposal
 *     contract semantics.
 *
 * Workflow when changing engine state:
 *   1. Edit the engine (apps/api/src/services/mitigation/produce-mitigations.ts).
 *   2. Bump MITIGATION_ENGINE_VERSION here.
 *   3. Run `npm run mitigation-engine:print-hash` and append to
 *      MITIGATION_ENGINE_MANIFEST.
 *   4. Run `npm run check:mitigation-engine` to verify boot check passes.
 *
 * Coupling with RENDER_VERSION (rendered-analysis.ts): the rendered-analysis
 * cache is keyed by (rootId, renderVersion, narrativeId). On any engine bump
 * that materially changes proposal output, ALSO bump RENDER_VERSION — old
 * cache rows otherwise continue to return the prior proposal projection for
 * the same root/narrative pair. This is the existing manual-invalidation
 * convention; the render layer does not key its cache on the mitigation set
 * id directly.
 *
 * Prose / copy-template changes ALSO require a version bump. The manifest
 * hash covers the engine-state snapshot (desk constants + reserve cap +
 * principle-enrichment tables) but NOT the prose templates (title,
 * description, structuralChanges, coverageStatement) — copy drift won't be
 * caught by the boot check. Treat copy changes the same way as constant
 * changes: bump MITIGATION_ENGINE_VERSION (and RENDER_VERSION) by convention.
 */
export const MITIGATION_ENGINE_VERSION = '1.3' as const;

export type DoctrineVersion = '1.0' | '1.1' | '1.2' | '1.3';
/**
 * Historical-replay union: includes every JUDGMENT_ENGINE_VERSION ever shipped so
 * JUDGMENT_ENGINE_MANIFEST can carry an append-only history of state hashes. Bump the
 * `JUDGMENT_ENGINE_VERSION` constant and EXTEND this union (do not replace) when adding
 * a new judgment-engine revision.
 */
export type JudgmentEngineVersion = '1.0' | '1.1' | '1.2' | '1.3' | '1.4' | '1.5' | '1.6' | '1.7' | '1.8' | '1.9' | '1.10';
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
export type NarrativeEngineVersion = '1.0' | '1.1' | '1.2' | '1.3' | '1.4' | '1.5' | '1.6';

/**
 * Historical-replay union: includes every MITIGATION_ENGINE_VERSION ever shipped so
 * MITIGATION_ENGINE_MANIFEST can carry an append-only history of state hashes.
 * Bump the `MITIGATION_ENGINE_VERSION` constant and EXTEND this union (do not
 * replace) when adding a new mitigation-engine revision.
 */
export type MitigationEngineVersion = '1.0' | '1.1' | '1.2' | '1.3';

/**
 * ISO 8601 UTC timestamp, frozen at extraction time. Used as `analysisAsOfDate` everywhere a
 * timestamp would otherwise need `new Date()`. Must never be derived from wall-clock at any
 * downstream stage — replay determinism depends on it.
 */
export type ISODateTime = string;

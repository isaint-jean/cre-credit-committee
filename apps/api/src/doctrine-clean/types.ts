/**
 * doctrine-clean — shared types
 *
 * Self-contained. NO imports from old doctrine / manifesto modules.
 */

/**
 * The canonical asset classes the clean doctrine recognizes. These match
 * the buckets the extractor's `normalizeAssetType` produces. Mall is a
 * SUB-CLASS of Retail surfaced as a separate top-level class here because
 * spec v2 / KBRA / Moody's treat mall structurally differently from
 * Anchored or Unanchored Retail (anchor-tenant concentration risk).
 *
 * "Unknown" is the conservative fallback when the extractor couldn't
 * classify the loan — treated as elevated risk (see dimensions/asset-class.ts).
 */
export type AssetClass =
  | 'Multifamily'
  | 'MHC'                  // Manufactured Housing Community
  | 'Industrial'
  | 'AnchoredRetail'
  | 'SelfStorage'
  | 'UnanchoredRetail'
  | 'MixedUse'
  | 'Office'
  | 'Hotel'                // Hospitality / lodging
  | 'Mall'                 // Regional / super-regional malls (sub-class of Retail)
  | 'SpecialtyAtypical'    // Data centers, trade marts, etc. — atypical CMBS collateral
  | 'Unknown';

/**
 * Risk tier for a given asset class. Tier I = lowest risk; Tier IV =
 * highest. Spec v2 § dimension 8 organizes the asset-class adjustment
 * around a 4-tier discretization grounded in Moody's stability ranking
 * + KBRA/DBRS per-property-type treatment.
 *
 * `Tier` is the SEMANTIC tier (what the agencies / spec v2 say). The
 * numeric `riskContribution` translates the tier into a normalized
 * [0.0, 1.0] risk weight for the scoring architecture (build-order step
 * later). A score of 0.0 is "asset-class brings no additional risk"; 1.0
 * is the maximum asset-class-driven risk contribution.
 */
export type AssetClassTier = 'I' | 'II' | 'III' | 'IV';

/**
 * The shape every clean doctrine dimension emits. A dimension is a pure
 * function of an input shape → a `DimensionContribution`. The scoring
 * architecture (later) composes these into a final rating.
 */
export interface DimensionContribution {
  /** Stable identifier of the dimension (e.g., 'asset-class', 'rollover'). */
  readonly dimensionId: string;
  /**
   * Normalized risk weight in [0.0, 1.0], OR null when the dimension does
   * not contribute a risk score (N/A by asset type, or HITL needed).
   * The scoring architecture must treat null as "skip this dimension";
   * NEVER substitute a conservative default at the contribution layer —
   * provenance must remain honest.
   */
  readonly riskContribution: number | null;
  /**
   * Semantic tier label. Each dimension defines its own tiers (e.g., 'I'
   * to 'IV' for asset-class; 'low' / 'moderate' / 'elevated' / 'high' for
   * rollover). Reserved literal 'N/A' = no tier assigned (applicability
   * = not-applicable OR hitl-needed).
   */
  readonly tier: string;
  /** Human-readable rationale; cites spec v2 + public sources. */
  readonly rationale: string;
  /** Provenance trace — every contribution carries its derivation source. */
  readonly provenance: readonly string[];
  /**
   * Applicability of the dimension to THIS loan:
   *   'applicable'                  → dimension evaluated; riskContribution non-null
   *   'not-applicable-by-asset-type'→ dimension legitimately doesn't apply (e.g.,
   *                                   rollover on a hotel — no tenant leases);
   *                                   scoring architecture reweights remaining dims
   *   'hitl-needed'                 → input absent / parse-failed; route to human review
   * NEVER overload these to mean "default to conservative" — that hid HITL
   * cases inside Tier IV's loss-rate on the dim-8 validation run.
   */
  readonly applicability: 'applicable' | 'not-applicable-by-asset-type' | 'hitl-needed';
  /** True iff dimension evaluated successfully (applicability === 'applicable'). */
  readonly evaluated: boolean;
  /**
   * Optional named numeric outputs the dimension derives as a byproduct
   * and publishes for downstream dimensions. Example: the cap-rate /
   * valuation-stress dimension publishes the stressed value + stressed
   * LTV + stressed cap rate so the LTV / DSCR / DY dimensions compute
   * against the same haircut value the agencies do.
   *
   * Most dimensions leave this undefined. When present, downstream
   * dimensions should treat missing keys as "value not derived" — never
   * substitute a default.
   */
  /**
   * Values are numbers (the dominant case — stressed metrics) or strings
   * (provenance tags — e.g. dim 7's concludedValueSource). Consumers that
   * read specific numeric keys narrow via `typeof v === 'number'` before
   * using the value. String values are for audit / provenance only and
   * must NOT be folded into scoring math.
   */
  readonly derivedOutputs?: Readonly<Record<string, number | string | null>>;
  /**
   * Optional BOUNDED SIGNED MODIFIER on the 0..1 risk scale, used by
   * dimensions that are qualitative ADJUSTMENTS to the peer-tier stack
   * rather than peer risk tiers themselves (today: dim 9 sponsor /
   * borrower quality). When set:
   *   - `riskContribution` MUST be null (the dimension is not a peer)
   *   - `riskModifier` is in the closed interval [-cap, +cap] where
   *     `cap` is documented by the dimension (e.g., dim 9 uses ±0.20
   *     grounded in DBRS's "~2 notches" comparative-review bound)
   *   - Negative = risk REDUCTION (strong sponsor); positive = risk
   *     INCREASE (weak/troubled sponsor). The cap stops the modifier
   *     from swinging a deal alone.
   * Most dimensions leave this undefined.
   */
  readonly riskModifier?: number | null;
}

/**
 * Input shape for the asset-class dimension. A subset of the
 * AnswerKeyRecord fields the corpus carries; the dimension itself is
 * pure (doesn't read the corpus or any global state).
 */
export interface AssetClassDimensionInput {
  /**
   * Asset type as the extractor / Annex A walker emitted it. Normalized
   * to one of the canonical buckets the extractor produces. May be null
   * when the source didn't expose Property Type — handled explicitly.
   */
  readonly assetType: string | null;
  /**
   * Sub-type as the extractor produced it (e.g., "Office CBD", "Retail
   * Anchored", "Hospitality Limited Service"). Used to disambiguate
   * Mall (sub-class of Retail) from Anchored / Unanchored Retail.
   */
  readonly subType: string | null;
  /**
   * Property name (e.g., "Anderson Mall", "Concord Mills"). Used ONLY as
   * a tie-breaker for sub-class detection when subType is silent — a
   * property named "X Mall" is structurally a mall regardless of what
   * the extractor parsed into subType. The primary classification source
   * remains the labeled Property Type / Specific Property Type fields.
   */
  readonly propertyName: string | null;
}

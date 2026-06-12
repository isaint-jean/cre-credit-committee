/**
 * doctrine-clean / dimensions / asset-class.ts
 *
 * Dimension 8 — Asset class.
 *
 * PROVENANCE (rewrite-in-own-words per spec v2 method note):
 *
 *   PRIMARY: Moody's CMBS asset-class stability ranking. The published
 *   ordering (most-stable → least-stable) groups property types by
 *   long-run NCF volatility, default frequency, and severity of loss
 *   given default. Moody's stability ordering as cited in spec v2 § 8:
 *     multifamily → anchored retail → industrial → unanchored retail → …
 *   The "…" continues with elevated-risk types (mixed-use, office,
 *   hospitality, mall) per the agency's published methodology.
 *
 *   SECONDARY: KBRA CMBS property-type treatments. KBRA's per-type
 *   default-frequency / loss-severity adjustments place office in a
 *   structurally pressured bucket (post-2020 work-from-home dislocation,
 *   long-lease re-leasing risk, sublease overhang). Hotel sits in the
 *   high-volatility bucket (daily-rate exposure, macro-cycle sensitivity,
 *   FF&E CapEx intensity).
 *
 *   SECONDARY: DBRS Morningstar CMBS rating methodology. Concurs with
 *   KBRA's office-structurally-pressured framing and Moody's stability
 *   ranking. DBRS also flags mall sub-class as elevated due to
 *   anchor-tenant concentration and retail bankruptcy contagion.
 *
 *   CORPUS CONFIRMATION (directional only — NOT the primary fit):
 *     Clean backbone corpus structural test v3 (n=176, LOSS n=12):
 *       Retail 17.2%, Hotel 16.0%, MixedUse 12.5% (over overall 8.0%)
 *       Office 2.9%, Multifamily 7.7%, Industrial 0%, MHC ~ 0%, Other 0%
 *     The corpus direction MATCHES the agency ranking on every category
 *     EXCEPT office.
 *
 * OFFICE DIVERGENCE (flagged):
 *   This corpus's loans were originated 2013-2016 — before the COVID-era
 *   structural shift in office demand. The corpus shows office at 0.4×
 *   the overall loss-rate (1 loss / 34 records). Current agency framing
 *   says office is structurally pressured. The DIMENSION TRUSTS THE
 *   STANDARD: office is placed in Tier IV (Elevated). The corpus's
 *   "safe office" reading is treated as a VINTAGE ARTIFACT — office
 *   stability in 2013-2016 doesn't generalize to 2026 originations.
 *
 *   Spec v2 § 8 method convergence: "Where the corpus contradicts the
 *   published agency tiering on a known-structural-shift property type,
 *   trust the standard."
 *
 * NO IMPORTS FROM OLD DOCTRINE.
 */
import type {
  AssetClass,
  AssetClassTier,
  DimensionContribution,
  AssetClassDimensionInput,
} from '../types.js';

/**
 * Tier definitions. Each tier carries:
 *   - A normalized risk contribution in [0.0, 1.0]
 *   - The asset classes it covers
 *   - A list of provenance citations
 *
 * The tier-to-contribution mapping IS the dimension's risk model. The
 * scoring layer (later build-order step) consumes the contribution.
 *
 * Tier numbers grounded in Moody's stability ranking + KBRA/DBRS
 * per-type treatment. Discretization to FOUR tiers is the spec v2
 * convention (§ "Method / convergence" — "tier the public standards
 * into four risk bands; finer than that overfits agency framings
 * that don't agree to that precision").
 */
const TIER_DEFINITIONS: readonly {
  tier: AssetClassTier;
  riskContribution: number;
  classes: readonly AssetClass[];
  rationale: string;
  provenance: readonly string[];
}[] = [
  /* Tier I — Lowest risk. Most-stable cash flow profile per Moody's
   * stability ranking; recurring-demand drivers (housing, logistics)
   * insulated from macro / discretionary cycles. */
  {
    tier: 'I',
    riskContribution: 0.10,
    classes: ['Multifamily', 'MHC', 'Industrial', 'AnchoredRetail', 'SelfStorage'],
    rationale:
      'Most-stable asset classes per Moody\'s CMBS stability ranking. ' +
      'Multifamily/MHC: structural housing demand → low NCF volatility. ' +
      'Industrial: secular logistics tailwind, short-form lease repricing. ' +
      'Anchored Retail: necessity-driven anchor (grocery, pharmacy) ' +
      'dampens discretionary-spending cycles. Self Storage: low-CapEx, ' +
      'fragmented-tenant base, recession-resilient demand.',
    provenance: [
      'spec v2 § 8 (Asset-class adjustments): Moody\'s stability ranking — multifamily → anchored retail → industrial → unanchored retail → …',
      'Moody\'s CMBS published methodology — per-asset-class default-frequency / severity tables',
      'KBRA CMBS methodology — multifamily / industrial baseline risk loadings',
      'corpus confirmation (directional): Multifamily 7.7% loss-rate, Industrial 0%, MHC 0% on n=176',
    ],
  },
  /* Tier II — Moderate risk. Above-baseline NCF volatility relative
   * to Tier I but no structural pressure flagged by KBRA/DBRS. */
  {
    tier: 'II',
    riskContribution: 0.30,
    classes: ['UnanchoredRetail', 'MixedUse'],
    rationale:
      'Above-baseline volatility per Moody\'s stability ranking. ' +
      'Unanchored Retail: discretionary-spending sensitivity, anchor-less ' +
      'tenant churn risk. Mixed Use: composite cash flow — exposure ' +
      'across components (often retail + residential or retail + office); ' +
      'component-level risk concentration usually correlated.',
    provenance: [
      'spec v2 § 8: unanchored retail elevated vs anchored within Moody\'s ranking',
      'KBRA CMBS methodology — unanchored retail per-type loadings vs anchored',
      'DBRS Morningstar CMBS methodology — mixed-use composite-risk framing',
      'corpus confirmation (directional): MixedUse 12.5% loss-rate on n=8 (small-n)',
    ],
  },
  /* Tier III — Elevated risk. Structural pressure flagged by KBRA / DBRS
   * (office) OR intrinsic high-volatility cash flow (hotel). */
  {
    tier: 'III',
    riskContribution: 0.55,
    classes: ['Office', 'Hotel'],
    rationale:
      'Office: KBRA / DBRS flag as structurally pressured — post-2020 ' +
      'work-from-home dislocation, long-lease re-leasing risk, sublease ' +
      'overhang, secular tenant downsizing. Hotel: intrinsic high-volatility ' +
      'cash flow — daily-rate dependence on macro / travel, FF&E CapEx ' +
      'intensity, brand-flag covenant risk.',
    provenance: [
      'spec v2 § 8 (office structurally pressured)',
      'KBRA CMBS methodology — office per-type loadings reflect post-2020 structural shift',
      'DBRS Morningstar CMBS methodology — office structural-pressure flag',
      'KBRA / Moody\'s — hotel volatility loadings (RevPAR cyclicality, CapEx intensity)',
      'corpus confirmation (directional): Hotel 16.0% on n=25 — matches agency framing',
      'corpus DIVERGENCE on Office (2.9% on n=34, 2013-2016 vintage): TRUST STANDARD per spec v2 § 8 method convergence. The corpus\'s low-office-loss-rate is a VINTAGE ARTIFACT (pre-COVID origination); does not generalize to 2026 originations.',
    ],
  },
  /* Tier IV — Highest risk. Two distinct sub-cases share the tier:
   *  - Mall: anchor-concentration + retail bankruptcy contagion (the
   *    canonical agency Tier IV).
   *  - SpecialtyAtypical: data centers, trade marts, and other atypical
   *    CMBS collateral — agencies treat as elevated due to illiquidity
   *    of the resale market and limited comparable sales.
   *  - Unknown: kept in the class union for completeness, but the
   *    dimension now ROUTES Unknown to HITL (coverage gap, not risk).
   *    A class that the canonicalizer cannot resolve is a data problem;
   *    it should not be silently scored as elevated risk. */
  {
    tier: 'IV',
    riskContribution: 0.80,
    classes: ['Mall', 'SpecialtyAtypical', 'Unknown'],
    rationale:
      'Mall: structural anchor-tenant concentration + retail bankruptcy ' +
      'contagion (anchor failure triggers co-tenancy clauses + accelerated ' +
      'in-line tenant departures); Moody\'s / DBRS flag as least-stable ' +
      'retail sub-class. SpecialtyAtypical: atypical CMBS collateral ' +
      '(data centers, trade marts, etc.) — agencies treat as elevated ' +
      'due to thin resale market, limited comparable transactions, and ' +
      'specialized tenant / operator dependence.',
    provenance: [
      'spec v2 § 8: mall sub-class as least-stable retail',
      'DBRS Morningstar CMBS methodology — mall structural-pressure flag, co-tenancy + bankruptcy contagion',
      'Moody\'s CMBS methodology — regional mall stability ranking',
      'KBRA / DBRS — specialty / atypical collateral treatment (data centers, trade marts): illiquid resale market + specialized-operator dependence',
      'corpus confirmation (directional, small-n): Mall sub-type 20% loss-rate on n=5 (v1 sub-type cut)',
      'Unknown is NO LONGER auto-Tier-IV: the dimension routes truly-unclassifiable records to HITL (coverage gap, not risk) — fixes coverage-into-risk conflation',
    ],
  },
];

/* Pre-built class-to-tier lookup. Built at module load time. */
const CLASS_TO_TIER: ReadonlyMap<AssetClass, typeof TIER_DEFINITIONS[number]> = (() => {
  const m = new Map<AssetClass, typeof TIER_DEFINITIONS[number]>();
  for (const td of TIER_DEFINITIONS) {
    for (const c of td.classes) m.set(c, td);
  }
  return m;
})();

/**
 * Result of canonicalization. The `classificationSource` makes the
 * derivation path explicit so the rationale can cite the actual signal
 * (direct, subType-derived, mall-by-name, etc.), and so truly-
 * unclassifiable records route to HITL instead of silently bucketing
 * into Tier IV.
 */
type CanonicalizeResult =
  | {
      readonly canonicalClass: AssetClass;
      readonly classificationSource:
        | 'direct'                  // rawAssetType matched a canonical bucket
        | 'subtype-derived'         // rawAssetType not recognized; subType named a class
        | 'mall-name-detected'      // propertyName contains mall / mills / outlets / galleria
        | 'mall-subtype-detected'   // Retail + subType signals Mall
        | 'specialty-collateral'    // data center / trade mart / similar
        | 'retail-conservative-default';  // Retail with no sub-class signal → UnanchoredRetail
      readonly explanation: string;
    }
  | {
      readonly canonicalClass: null;       // → HITL (coverage gap)
      readonly classificationSource: 'no-recognizable-signal';
      readonly explanation: string;
    };

/**
 * Property-name pattern that signals a mall regardless of rawAssetType.
 * "Mills" is the Simon-branded regional-mall format; "Galleria" is a
 * common mall trade-name; "Premium Outlets" is a Simon outlet center.
 */
const MALL_NAME_REGEX = /\bmall\b|\bmills\b|\boutlets?\b|\bgalleria\b|premium\s*outlets/i;

/**
 * Map the corpus / extractor's raw assetType string + subType + property
 * name to a canonical AssetClass.
 *
 * Three-layer priority:
 *   1. MALL-NAME DETECTION (highest priority, asset-type-agnostic). A
 *      property literally named with a mall trade-name is structurally
 *      a mall whether or not the extractor labeled assetType "Retail"
 *      or "Other". Fixes the prior gating bug that missed Carolina
 *      Premium Outlets / Northway Mall (both labeled assetType "Other").
 *   2. DIRECT BUCKET — rawAssetType matches a canonical class name.
 *   3. SUBTYPE-DERIVED — when rawAssetType is "Other" or unrecognized,
 *      read subType as a secondary signal. The extractor commonly emits
 *      assetType="Other" with the actual class encoded in subType
 *      ("Manufactured", "Self", "CBD", "Full", "Anchored", "Student").
 *      This is what was previously mislabeled as Unknown → Tier IV
 *      (coverage-into-risk conflation).
 *   4. SPECIALTY/ATYPICAL — data centers, trade marts, and similar
 *      atypical CMBS collateral get a Tier IV via the SpecialtyAtypical
 *      class (different provenance than Mall — illiquidity, not anchor
 *      concentration).
 *   5. TRULY UNCLASSIFIABLE → return null (HITL). Coverage gap, not risk.
 */
function canonicalize(
  rawAssetType: string | null,
  rawSubType: string | null,
  rawPropertyName: string | null,
): CanonicalizeResult {
  if (rawAssetType === null) {
    return {
      canonicalClass: null,
      classificationSource: 'no-recognizable-signal',
      explanation: 'rawAssetType is null — no canonical-class signal available',
    };
  }
  const at = rawAssetType.trim();
  const st = (rawSubType ?? '').trim();
  const stLower = st.toLowerCase();
  const name = (rawPropertyName ?? '').toLowerCase();

  // (1) MALL-NAME DETECTION — runs regardless of rawAssetType.
  if (MALL_NAME_REGEX.test(name)) {
    return {
      canonicalClass: 'Mall',
      classificationSource: 'mall-name-detected',
      explanation: `propertyName "${rawPropertyName}" matches mall trade-name pattern`,
    };
  }

  // (2) DIRECT BUCKETS for canonical extractor labels.
  if (at === 'Multifamily') return { canonicalClass: 'Multifamily', classificationSource: 'direct', explanation: 'rawAssetType=Multifamily' };
  if (at === 'MHC')         return { canonicalClass: 'MHC',         classificationSource: 'direct', explanation: 'rawAssetType=MHC' };
  if (at === 'Industrial')  return { canonicalClass: 'Industrial',  classificationSource: 'direct', explanation: 'rawAssetType=Industrial' };
  if (at === 'SelfStorage') return { canonicalClass: 'SelfStorage', classificationSource: 'direct', explanation: 'rawAssetType=SelfStorage' };
  if (at === 'MixedUse')    return { canonicalClass: 'MixedUse',    classificationSource: 'direct', explanation: 'rawAssetType=MixedUse' };
  if (at === 'Office')      return { canonicalClass: 'Office',      classificationSource: 'direct', explanation: 'rawAssetType=Office' };
  if (at === 'Hotel')       return { canonicalClass: 'Hotel',       classificationSource: 'direct', explanation: 'rawAssetType=Hotel' };

  // (3) RETAIL — disambiguate.
  if (at === 'Retail') {
    // Mall via subType when propertyName didn't already trigger.
    if (/\bmall\b|regional|super.?regional|lifestyle.center/i.test(stLower)) {
      return { canonicalClass: 'Mall', classificationSource: 'mall-subtype-detected', explanation: `Retail subType "${st}" signals Mall sub-class` };
    }
    if (/\bunanchored\b|shadow.?anchored|strip/i.test(stLower)) {
      return { canonicalClass: 'UnanchoredRetail', classificationSource: 'direct', explanation: `Retail subType "${st}" signals Unanchored` };
    }
    if (/\banchored\b|grocery|drugstore|big.?box|necessity|essential/i.test(stLower)) {
      return { canonicalClass: 'AnchoredRetail', classificationSource: 'direct', explanation: `Retail subType "${st}" signals Anchored` };
    }
    return {
      canonicalClass: 'UnanchoredRetail',
      classificationSource: 'retail-conservative-default',
      explanation: 'Retail with no anchor signal — conservative default (Unanchored Tier II)',
    };
  }

  // (4) "Other" / unrecognized rawAssetType — read subType.
  // Most of the corpus's "extraction gap" mislabels live here. The extractor
  // emits assetType="Other" with a descriptive subType that names the actual
  // class. Resolve via subType signal.
  if (stLower) {
    // Specialty / atypical collateral — Tier IV via a different rationale than Mall.
    if (/^data\b|data\s*center|\bdata\s*centre/i.test(st))
      return { canonicalClass: 'SpecialtyAtypical', classificationSource: 'specialty-collateral', explanation: `subType "${st}" signals data center (specialty / atypical collateral)` };
    if (/^trade\b|trade\s*mart|merchandise\s*mart/i.test(st))
      return { canonicalClass: 'SpecialtyAtypical', classificationSource: 'specialty-collateral', explanation: `subType "${st}" signals trade-mart / merchandise mart (specialty / atypical collateral)` };

    // MHC — manufactured housing community.
    if (/^manufactured\b/i.test(st))
      return { canonicalClass: 'MHC', classificationSource: 'subtype-derived', explanation: `subType "${st}" → MHC (manufactured housing)` };

    // Self storage.
    if (/^self\b/i.test(st))
      return { canonicalClass: 'SelfStorage', classificationSource: 'subtype-derived', explanation: `subType "${st}" → SelfStorage` };

    // Office sub-types.
    if (/^cbd\b|central\s*business/i.test(st) || /^suburban\b/i.test(st) || /^medical\b/i.test(st))
      return { canonicalClass: 'Office', classificationSource: 'subtype-derived', explanation: `subType "${st}" → Office` };

    // Hotel sub-types.
    if (/^full\b|full\s*service|^limited\b|limited\s*service|^select\b|select\s*service|^extended\b|^resort\b|boutique/i.test(st))
      return { canonicalClass: 'Hotel', classificationSource: 'subtype-derived', explanation: `subType "${st}" → Hotel` };

    // Student housing — a multifamily subtype.
    if (/^student\b|student\s*housing/i.test(st))
      return { canonicalClass: 'Multifamily', classificationSource: 'subtype-derived', explanation: `subType "${st}" → Multifamily (student housing)` };

    // Anchored retail (when not caught by Mall name check).
    if (/^anchored\b/i.test(st))
      return { canonicalClass: 'AnchoredRetail', classificationSource: 'subtype-derived', explanation: `subType "${st}" → AnchoredRetail` };

    // Industrial.
    if (/^industrial\b|warehouse|distribution/i.test(st))
      return { canonicalClass: 'Industrial', classificationSource: 'subtype-derived', explanation: `subType "${st}" → Industrial` };
  }

  // (5) Truly unclassifiable — bare "Various", empty, or no recognizable
  //     signal anywhere. Route to HITL (coverage gap, not Tier IV risk).
  return {
    canonicalClass: null,
    classificationSource: 'no-recognizable-signal',
    explanation: `rawAssetType="${at}", subType="${st}", propertyName="${rawPropertyName ?? ''}" — no canonical-class signal available`,
  };
}

/**
 * Evaluate the asset-class dimension on one input.
 *
 * Pure function; no global state, no I/O. The scoring architecture
 * (later build-order step) composes contributions from all nine clean
 * dimensions; this is one of them.
 */
export function evaluateAssetClass(
  input: AssetClassDimensionInput,
): DimensionContribution {
  const result = canonicalize(input.assetType, input.subType, input.propertyName);

  // (1) Truly-unclassifiable → HITL. Includes the old "rawAssetType=null"
  // case AND the new "rawAssetType='Other' / 'Various' with no recognizable
  // subType signal" case. Both are coverage gaps, not risk signals.
  if (result.canonicalClass === null) {
    return {
      dimensionId: 'asset-class',
      riskContribution: null,
      tier: 'N/A',
      rationale: `[HITL — no canonical-class signal] ${result.explanation}. Route to human review; NEVER bucket into a risk tier without provenance.`,
      provenance: [
        'no canonical-class signal — coverage gap, not a risk signal',
        'fixes prior coverage-into-risk conflation where rawAssetType="Other" was scored Tier IV',
      ],
      applicability: 'hitl-needed',
      evaluated: false,
    };
  }

  // (2) Resolved → tier rationale with classification source path baked in.
  const klass = result.canonicalClass;
  const td = CLASS_TO_TIER.get(klass)!;
  const pathTag = `[classification: ${result.classificationSource}] ${result.explanation}`;
  return {
    dimensionId: 'asset-class',
    riskContribution: td.riskContribution,
    tier: td.tier,
    rationale: `${pathTag} → ${klass} → Tier ${td.tier}. ${td.rationale}`,
    provenance: td.provenance,
    applicability: 'applicable',
    evaluated: true,
    // Additive: emit the canonical class as a structured derivedOutput so
    // downstream consumers (mitigant lever 4 — in-place lockbox by asset
    // type) can tailor reserves without parsing the rationale text.
    // DimensionContribution.derivedOutputs is Readonly<Record<string, number | null>>
    // — emit a numeric index into a small enumeration table that consumers
    // map back to the class via ASSET_CLASS_ENUM.
    derivedOutputs: {
      canonicalAssetClassIndex: ASSET_CLASS_ENUM.indexOf(klass),
    },
  };
}

/**
 * Stable ordered enumeration of canonical asset classes — used so dim 8
 * can emit the canonical class as a numeric index in `derivedOutputs`
 * (which is typed Readonly<Record<string, number | null>>). Consumers
 * (mitigant lever 4 etc.) map the index back to the class via this
 * exported array. Append-only — adding a new class at the end keeps
 * existing indices stable.
 */
export const ASSET_CLASS_ENUM: readonly AssetClass[] = [
  'Multifamily',
  'MHC',
  'Industrial',
  'AnchoredRetail',
  'SelfStorage',
  'UnanchoredRetail',
  'MixedUse',
  'Office',
  'Hotel',
  'Mall',
  'SpecialtyAtypical',
  'Unknown',
] as const;

/**
 * Export the tier table so the validation harness can introspect it
 * (and so spec v2's tier ↔ class mapping is visible without reading
 * function source). Read-only by convention.
 */
export const ASSET_CLASS_TIER_DEFINITIONS = TIER_DEFINITIONS;

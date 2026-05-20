/**
 * Deterministic resolver: (assetClass, adjustedInputs, analysisMeta)
 *   → structuralVariantKey
 *
 * Rules (memory/architecture_render_versioning.md):
 *   - Pure function. No randomness, no clock reads, no I/O.
 *   - Same inputs MUST always return the same key.
 *   - Returned key MUST be registered in the schema for the asset class
 *     (verified by getVariantsForAssetClass). If no key resolves, throws —
 *     callers MUST treat this as a hard failure, NEVER apply a fallback.
 *
 * The resolver is one of two permitted sources for structuralVariantKey
 * (the other is the explicit request parameter on /render). The render
 * service does not call this — only the route does.
 */
import { RenderSchemaError, getModesForVariant, getVariantsForAssetClass } from './render-schema.js';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type {
  AdjustedInputs,
  AssetType,
  StructuralVariantKey,
  UnderwritingMode,
} from '@cre/shared';

/**
 * Minimal subset of analysis state the resolver inspects. Kept narrow so the
 * resolver remains pure-deterministic over its declared inputs and so callers
 * cannot drift unrelated fields into the structural decision.
 */
export interface AnalysisMetaForVariant {
  /** Optional caller-asserted variant. If present, MUST equal what the
   *  resolver would compute; mismatch is a hard error. (Not a fallback —
   *  this is for sanity-checking pinned routes.) */
  pinnedVariantKey?: StructuralVariantKey;
}

// Per-asset-class deterministic baseline. The resolver currently maps every
// asset class to its `_core` variant; richer signals (loan size, vintage,
// occupancy, tenancy mix) get added here as the registry diverges. Any
// addition MUST stay deterministic over (adjustedInputs, analysisMeta).
const CORE_VARIANT: Record<AssetType, StructuralVariantKey> = {
  office:               'office_core',
  multifamily:          'mf_core',
  industrial:           'ind_core',
  retail:               'retail_core',
  hotel:                'hotel_core',
  self_storage:         'self_storage_core',
  mixed_use:            'mixed_use_core',
  manufactured_housing: 'manufactured_housing_core',
};

export function resolveStructuralVariant(
  assetClass: AssetType,
  _adjustedInputs: AdjustedInputs,
  analysisMeta: AnalysisMetaForVariant,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): StructuralVariantKey {
  const computed = CORE_VARIANT[assetClass];
  if (!computed) {
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_RESOLUTION_FAILED',
      `resolveStructuralVariant has no rule for assetClass=${assetClass}.`,
      { assetClass },
    );
  }

  const validKeys = getVariantsForAssetClass(assetClass, contractVersion);
  if (!validKeys.includes(computed)) {
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_UNKNOWN',
      `resolveStructuralVariant produced ${computed} for assetClass=${assetClass}, but it is not registered in contractVersion=${contractVersion}.`,
      { contractVersion, assetClass, computed, validVariantKeys: validKeys },
    );
  }

  if (analysisMeta.pinnedVariantKey && analysisMeta.pinnedVariantKey !== computed) {
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_PIN_MISMATCH',
      `Pinned structuralVariantKey=${analysisMeta.pinnedVariantKey} disagrees with resolver output=${computed} for assetClass=${assetClass}.`,
      { assetClass, pinned: analysisMeta.pinnedVariantKey, computed },
    );
  }

  return computed;
}

/** Validate that a request-supplied variant key is registered for the asset class at a contract version. */
export function assertVariantRegistered(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): void {
  const validKeys = getVariantsForAssetClass(assetClass, contractVersion);
  if (!validKeys.includes(variantKey)) {
    throw new RenderSchemaError(
      'STRUCTURAL_VARIANT_UNKNOWN',
      `structuralVariantKey=${variantKey} is not registered for assetClass=${assetClass} at contractVersion=${contractVersion}.`,
      { contractVersion, assetClass, structuralVariantKey: variantKey, validVariantKeys: validKeys },
    );
  }
}

/**
 * Validate that an underwriting mode is registered for an (assetClass,
 * variantKey) pair at a contract version. There is NO resolver for
 * underwriting mode — it MUST be supplied by the caller. The architecture
 * rule is explicit: no implicit defaults, no fallback.
 */
export function assertUnderwritingModeRegistered(
  assetClass: AssetType,
  variantKey: StructuralVariantKey,
  underwritingMode: UnderwritingMode,
  contractVersion: number = RENDER_CONTRACT_VERSION,
): void {
  const validModes = getModesForVariant(assetClass, variantKey, contractVersion);
  if (!validModes.includes(underwritingMode)) {
    throw new RenderSchemaError(
      'UNDERWRITING_MODE_UNKNOWN',
      `underwritingMode=${underwritingMode} is not registered for (assetClass=${assetClass}, structuralVariantKey=${variantKey}) at contractVersion=${contractVersion}.`,
      {
        contractVersion,
        assetClass,
        structuralVariantKey: variantKey,
        underwritingMode,
        validUnderwritingModes: validModes,
      },
    );
  }
}

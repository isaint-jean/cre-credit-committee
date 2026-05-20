/**
 * Property-type classification (Batch 1F foundation).
 *
 * Maps an `assetType` string (either the legacy lowercase enum from
 * `@cre/shared` or the Title-case enum from `@cre/contracts`) onto the four
 * BP Spiral template axes the populator needs to dispatch:
 *
 *   - unitOfMeasure: SF / Units / Rooms / Pads — drives PSF↔$ conversions
 *   - factor:        1 / 12 / 365 — multiplier for unit-rate-to-annual math
 *   - isRentRollProperty (RRP): true for property types whose Operating History
 *     is rent-roll-driven (Office, Retail, Industrial, Mixed Use). False for
 *     Multifamily, Self-Storage, MHC, Hotel where unit-level / room-level
 *     economics drive the model.
 *   - detailTab:     which Property Detail tab to populate
 *                    ('Property Detail - Comm' / '- MF SS MHP' / '- Hotel')
 *   - proFormaTab:   which Operating History tab to populate
 *                    ('Operating History and Pro Forma' / 'Hotel Op History and Pro Forma')
 *
 * Source of truth: the BP Spiral 'Controls' worksheet rows 2-17. This module
 * encodes that lookup table in TypeScript so the populator doesn't have to
 * read the workbook at runtime.
 *
 * Discipline:
 *   - Pure function. No I/O.
 *   - Unknown asset types fall back to a safe default ('Other' / SF / factor=1 /
 *     RRP=false / Comm detail tab). Caller can detect via the
 *     `classification.assetType === 'Other'` check if the fallback fired.
 *   - Both lowercase and Title-case variants are recognized so legacy uploads
 *     and new-spine flows both work without re-normalization at the boundary.
 */

import type { AssetType as LegacyAssetType } from '@cre/shared';
import type { AssetType as SpineAssetType } from '@cre/contracts';

export type UnitOfMeasure = 'SF' | 'Units' | 'Rooms' | 'Pads';
export type DetailTabName =
  | 'Property Detail - Comm'
  | 'Property Detail - MF SS MHP'
  | 'Property Detail - Hotel';
export type ProFormaTabName =
  | 'Operating History and Pro Forma'
  | 'Hotel Op History and Pro Forma';

export interface PropertyTypeClassification {
  // Echo of the normalized asset type ('office', 'multifamily', etc — always
  // legacy lowercase form for downstream consistency). 'other' is the unknown
  // fallback.
  readonly normalizedAssetType:
    | 'office' | 'retail' | 'industrial' | 'multifamily'
    | 'self_storage' | 'manufactured_housing' | 'hotel'
    | 'mixed_use' | 'other';
  readonly unitOfMeasure: UnitOfMeasure;
  readonly factor: number;                      // 1 / 12 / 365 from Controls!D
  readonly isRentRollProperty: boolean;         // RRP marker in Controls!E
  readonly detailTab: DetailTabName;
  readonly proFormaTab: ProFormaTabName;
}

// Normalize any incoming asset-type string to the canonical lowercase legacy
// form. Handles known Title-case spine values, common synonyms, and
// punctuation/case variations.
function normalize(input: string): PropertyTypeClassification['normalizedAssetType'] {
  const s = input.toLowerCase().replace(/[\s\-]+/g, '_');
  switch (s) {
    case 'office':           return 'office';
    case 'retail':           return 'retail';
    case 'industrial':       return 'industrial';
    case 'multifamily':
    case 'multi_family':     return 'multifamily';
    case 'self_storage':
    case 'selfstorage':      return 'self_storage';
    case 'manufactured_housing':
    case 'manufactured_housing_community':
    case 'mhc':
    case 'mobile_home_park':
    case 'mhp':              return 'manufactured_housing';
    case 'hotel':
    case 'hospitality':      return 'hotel';
    case 'mixed_use':
    case 'mixeduse':         return 'mixed_use';
    default:                 return 'other';
  }
}

export function classifyPropertyType(
  assetType: LegacyAssetType | SpineAssetType | string,
): PropertyTypeClassification {
  const normalizedAssetType = normalize(assetType);

  // Lookup table mirrors Controls sheet rows 2-17 of the BP Spiral template.
  switch (normalizedAssetType) {
    case 'office':
    case 'retail':
    case 'industrial':
      return {
        normalizedAssetType,
        unitOfMeasure: 'SF',
        factor: 1,                              // SF rents are already annual PSF
        isRentRollProperty: true,
        detailTab: 'Property Detail - Comm',
        proFormaTab: 'Operating History and Pro Forma',
      };

    case 'multifamily':
      return {
        normalizedAssetType,
        unitOfMeasure: 'Units',
        factor: 12,                             // monthly rent × 12 = annual
        isRentRollProperty: false,
        detailTab: 'Property Detail - MF SS MHP',
        proFormaTab: 'Operating History and Pro Forma',
      };

    case 'self_storage':
      return {
        normalizedAssetType,
        unitOfMeasure: 'SF',
        factor: 12,                             // monthly PSF × 12 = annual PSF
        isRentRollProperty: false,
        detailTab: 'Property Detail - MF SS MHP',
        proFormaTab: 'Operating History and Pro Forma',
      };

    case 'manufactured_housing':
      return {
        normalizedAssetType,
        unitOfMeasure: 'Pads',
        factor: 12,                             // monthly pad rent × 12
        isRentRollProperty: false,
        detailTab: 'Property Detail - MF SS MHP',
        proFormaTab: 'Operating History and Pro Forma',
      };

    case 'hotel':
      return {
        normalizedAssetType,
        unitOfMeasure: 'Rooms',
        factor: 365,                            // ADR × 365 occupied days = annual
        isRentRollProperty: false,
        detailTab: 'Property Detail - Hotel',
        proFormaTab: 'Hotel Op History and Pro Forma',
      };

    case 'mixed_use':
      return {
        normalizedAssetType,
        unitOfMeasure: 'SF',
        factor: 1,
        isRentRollProperty: true,               // Mixed Use is RRP per Controls
        detailTab: 'Property Detail - Comm',
        proFormaTab: 'Operating History and Pro Forma',
      };

    case 'other':
    default:
      // Conservative fallback: SF / factor 1 / non-RRP / commercial detail tab.
      return {
        normalizedAssetType: 'other',
        unitOfMeasure: 'SF',
        factor: 1,
        isRentRollProperty: false,
        detailTab: 'Property Detail - Comm',
        proFormaTab: 'Operating History and Pro Forma',
      };
  }
}

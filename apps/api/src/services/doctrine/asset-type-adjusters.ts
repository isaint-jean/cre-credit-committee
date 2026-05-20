/**
 * Asset-type adjusters (Batch 5b).
 *
 * 9 adjusters dispatched by `AssetProfile.propertyType`. Each is a pure boolean predicate
 * over upstream values (NarrativeFacts + AdjustedInputs.metrics) producing a
 * `DoctrineAssetTypeAdjustment` record with a FIXED penalty value from architecture §11.
 *
 * Constraint (per Batch 5b spec): NO new scoring logic. NO threshold-based scoring tables (those
 * live in 5a component scorers). Each adjuster is interpretive — read fact → if predicate
 * matches, emit flag + fixed penalty points (negative; deductions).
 *
 * Audit rule (§F #12): always combine `propertyType === 'X'` dispatch with the predicate.
 * The dispatch switch enforces this — the office predicates only run for Office deals etc.
 *
 * Industrial / Multifamily / MixedUse / Other have no asset-type adjusters in v1.0.
 */

import {
  DoctrineFlags,
  DoctrineReasonCodes,
  DoctrineRules,
  type AdjustedInputs,
  type AssetProfile,
  type DoctrineAssetTypeAdjustment,
  type NarrativeFacts,
} from '@cre/contracts';

/* ------------------ architecture §11 fixed penalty points ------------------ */

const PENALTIES = {
  OFFICE_LOW_QUALITY_CLASS:               -8,
  OFFICE_SHADOW_VACANCY:                  -6,
  MALL_DY_BELOW_MIN:                     -10,
  HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM: -10,
  HOTEL_PIP_UNDERSIZED:                   -8,
  STORAGE_DY_BELOW_FLOOR:                -12,
  STORAGE_DSCR_BELOW_TARGET:              -6,
  MHC_PRIVATE_WASTEWATER_RISK:           -10,
  MHC_HIGH_PARK_OWNED_HOMES:              -6,
} as const;

/* ----------------------- architecture §11 thresholds ---------------------- */

const MALL_DY_MIN = 0.13 as const;
const HOTEL_PIP_MIN_PER_KEY = 15_000 as const;
const STORAGE_DY_FLOOR = 0.08 as const;
const STORAGE_DSCR_TARGET = 1.30 as const;
const MHC_PARK_OWNED_MAX = 0.20 as const;

/* ------------------------------- Office ----------------------------------- */

function evaluateOfficeLowQualityClass(narrativeFacts: NarrativeFacts): DoctrineAssetTypeAdjustment | null {
  const cls = narrativeFacts.propertyClass;
  if (cls !== 'B' && cls !== 'C') return null;
  return {
    ruleId: DoctrineRules.OFFICE_LOW_QUALITY_CLASS,
    flag: DoctrineFlags.OFFICE_LOW_QUALITY_CLASS,
    fired: true,
    points: PENALTIES.OFFICE_LOW_QUALITY_CLASS,
    reasonCode: DoctrineReasonCodes.OFFICE_LOW_QUALITY_CLASS,
  };
}

function evaluateOfficeShadowVacancy(narrativeFacts: NarrativeFacts): DoctrineAssetTypeAdjustment | null {
  if (narrativeFacts.shadowVacancyFlag !== true) return null;
  return {
    ruleId: DoctrineRules.OFFICE_SHADOW_VACANCY,
    flag: DoctrineFlags.OFFICE_SHADOW_VACANCY,
    fired: true,
    points: PENALTIES.OFFICE_SHADOW_VACANCY,
    reasonCode: DoctrineReasonCodes.OFFICE_SHADOW_VACANCY,
  };
}

/* ------------------------------- Retail ----------------------------------- */

function evaluateMallDyBelowMin(
  narrativeFacts: NarrativeFacts,
  adjustedInputs: AdjustedInputs,
): DoctrineAssetTypeAdjustment | null {
  if (narrativeFacts.isMall !== true) return null;
  const dy = adjustedInputs.metrics.debtYield;
  if (dy === null || dy >= MALL_DY_MIN) return null;
  return {
    ruleId: DoctrineRules.MALL_DY_BELOW_MIN,
    flag: DoctrineFlags.MALL_DY_BELOW_MIN,
    fired: true,
    points: PENALTIES.MALL_DY_BELOW_MIN,
    reasonCode: DoctrineReasonCodes.MALL_DY_BELOW_MIN,
  };
}

/* -------------------------------- Hotel ----------------------------------- */

function evaluateHotelFranchiseExpiration(narrativeFacts: NarrativeFacts): DoctrineAssetTypeAdjustment | null {
  if (narrativeFacts.franchiseExpirationWithinTerm !== true) return null;
  return {
    ruleId: DoctrineRules.HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM,
    flag: DoctrineFlags.HOTEL_FLAG_EXPIRATION_TERM,
    fired: true,
    points: PENALTIES.HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM,
    reasonCode: DoctrineReasonCodes.HOTEL_FRANCHISE_EXPIRATION_WITHIN_TERM,
  };
}

function evaluateHotelPipUndersized(narrativeFacts: NarrativeFacts): DoctrineAssetTypeAdjustment | null {
  if (narrativeFacts.pipRequired !== true) return null;
  const budgetPerKey = narrativeFacts.pipBudgetPerKey;
  if (budgetPerKey === null || budgetPerKey >= HOTEL_PIP_MIN_PER_KEY) return null;
  return {
    ruleId: DoctrineRules.HOTEL_PIP_UNDERSIZED,
    flag: DoctrineFlags.HOTEL_PIP_UNDERSIZED,
    fired: true,
    points: PENALTIES.HOTEL_PIP_UNDERSIZED,
    reasonCode: DoctrineReasonCodes.HOTEL_PIP_UNDERSIZED,
  };
}

/* ----------------------------- SelfStorage -------------------------------- */

function evaluateStorageDyBelowFloor(adjustedInputs: AdjustedInputs): DoctrineAssetTypeAdjustment | null {
  const dy = adjustedInputs.metrics.debtYield;
  if (dy === null || dy >= STORAGE_DY_FLOOR) return null;
  return {
    ruleId: DoctrineRules.STORAGE_DY_BELOW_FLOOR,
    flag: DoctrineFlags.STORAGE_DY_BELOW_FLOOR,
    fired: true,
    points: PENALTIES.STORAGE_DY_BELOW_FLOOR,
    reasonCode: DoctrineReasonCodes.STORAGE_DY_BELOW_FLOOR,
  };
}

function evaluateStorageDscrBelowTarget(adjustedInputs: AdjustedInputs): DoctrineAssetTypeAdjustment | null {
  const dscr = adjustedInputs.metrics.dscr;
  if (dscr === null || dscr >= STORAGE_DSCR_TARGET) return null;
  return {
    ruleId: DoctrineRules.STORAGE_DSCR_BELOW_TARGET,
    flag: DoctrineFlags.STORAGE_DSCR_BELOW_TARGET,
    fired: true,
    points: PENALTIES.STORAGE_DSCR_BELOW_TARGET,
    reasonCode: DoctrineReasonCodes.STORAGE_DSCR_BELOW_TARGET,
  };
}

/* --------------------------------- MHC ------------------------------------ */

function evaluateMhcPrivateWastewater(narrativeFacts: NarrativeFacts): DoctrineAssetTypeAdjustment | null {
  if (narrativeFacts.privateWastewater !== true) return null;
  return {
    ruleId: DoctrineRules.MHC_PRIVATE_WASTEWATER_RISK,
    flag: DoctrineFlags.MHC_PRIVATE_WASTEWATER_RISK,
    fired: true,
    points: PENALTIES.MHC_PRIVATE_WASTEWATER_RISK,
    reasonCode: DoctrineReasonCodes.MHC_PRIVATE_WASTEWATER_RISK,
  };
}

function evaluateMhcHighParkOwnedHomes(narrativeFacts: NarrativeFacts): DoctrineAssetTypeAdjustment | null {
  const pct = narrativeFacts.parkOwnedHomesPct;
  if (pct === null || pct <= MHC_PARK_OWNED_MAX) return null;
  return {
    ruleId: DoctrineRules.MHC_HIGH_PARK_OWNED_HOMES,
    flag: DoctrineFlags.MHC_HIGH_PARK_OWNED_HOMES,
    fired: true,
    points: PENALTIES.MHC_HIGH_PARK_OWNED_HOMES,
    reasonCode: DoctrineReasonCodes.MHC_HIGH_PARK_OWNED_HOMES,
  };
}

/* ------------------------------ dispatch ---------------------------------- */

function pushIfFired(
  out: DoctrineAssetTypeAdjustment[],
  result: DoctrineAssetTypeAdjustment | null,
): void {
  if (result !== null) out.push(result);
}

export function evaluateAssetTypeAdjusters(args: {
  readonly assetProfile: AssetProfile;
  readonly adjustedInputs: AdjustedInputs;
  readonly narrativeFacts: NarrativeFacts;
}): readonly DoctrineAssetTypeAdjustment[] {
  const out: DoctrineAssetTypeAdjustment[] = [];
  const { assetProfile, adjustedInputs, narrativeFacts } = args;

  switch (assetProfile.propertyType) {
    case 'Office':
      pushIfFired(out, evaluateOfficeLowQualityClass(narrativeFacts));
      pushIfFired(out, evaluateOfficeShadowVacancy(narrativeFacts));
      break;
    case 'Retail':
      pushIfFired(out, evaluateMallDyBelowMin(narrativeFacts, adjustedInputs));
      break;
    case 'Hotel':
      pushIfFired(out, evaluateHotelFranchiseExpiration(narrativeFacts));
      pushIfFired(out, evaluateHotelPipUndersized(narrativeFacts));
      break;
    case 'SelfStorage':
      pushIfFired(out, evaluateStorageDyBelowFloor(adjustedInputs));
      pushIfFired(out, evaluateStorageDscrBelowTarget(adjustedInputs));
      break;
    case 'MHC':
      pushIfFired(out, evaluateMhcPrivateWastewater(narrativeFacts));
      pushIfFired(out, evaluateMhcHighParkOwnedHomes(narrativeFacts));
      break;
    // Industrial, Multifamily, MixedUse, Other — no v1.0 adjusters
    case 'Industrial':
    case 'Multifamily':
    case 'MixedUse':
    case 'Other':
      break;
  }

  return out;
}

/** Exported for transparency / tests. */
export const ASSET_TYPE_ADJUSTER_PENALTIES = PENALTIES;

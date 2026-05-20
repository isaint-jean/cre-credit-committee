/**
 * Dumps the full render schema (every cell address the workbook can display)
 * to stdout as JSON. Run via `tsx apps/api/src/scripts/dump-render-schema.ts`.
 *
 * Use this to regenerate `excel/config/render-schema.json` whenever
 * render-schema.ts changes. The Excel build step reads that JSON to verify
 * every named range exists in the workbook.
 *
 * Output shape (v5 four-axis):
 *   - Top-level fields (assetClassVariantModeTabs,
 *     bindingsByAssetClassVariantMode, structuralFingerprints) describe the
 *     CURRENT RENDER_CONTRACT_VERSION.
 *   - `versions[N]` carries the same data for every registered contract
 *     version, letting older-template builds verify against their own
 *     pinned slice.
 */
import {
  getAssetClassVariantModeTabs,
  getCanonicalFingerprints,
  getModesForVariant,
  getRegisteredContractVersions,
  getSchemaAddresses,
  getVariantsForAssetClass,
} from '../services/render-schema.js';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type { AssetType, StructuralVariantKey, UnderwritingMode } from '@cre/shared';

function dumpForVersion(cv: number): {
  assetClassVariantModeTabs: ReturnType<typeof getAssetClassVariantModeTabs>;
  bindingsByAssetClassVariantMode: Record<
    AssetType,
    Record<StructuralVariantKey, Record<UnderwritingMode, string[]>>
  >;
} {
  const tabs = getAssetClassVariantModeTabs(cv);
  const bindingsByAssetClassVariantMode = {} as Record<
    AssetType,
    Record<StructuralVariantKey, Record<UnderwritingMode, string[]>>
  >;
  for (const ac of Object.keys(tabs) as AssetType[]) {
    const variantKeys = getVariantsForAssetClass(ac, cv);
    bindingsByAssetClassVariantMode[ac] =
      {} as Record<StructuralVariantKey, Record<UnderwritingMode, string[]>>;
    for (const vk of variantKeys) {
      bindingsByAssetClassVariantMode[ac][vk] =
        {} as Record<UnderwritingMode, string[]>;
      for (const mode of getModesForVariant(ac, vk, cv)) {
        bindingsByAssetClassVariantMode[ac][vk][mode] = getSchemaAddresses(ac, vk, mode, cv);
      }
    }
  }
  return { assetClassVariantModeTabs: tabs, bindingsByAssetClassVariantMode };
}

const current = dumpForVersion(RENDER_CONTRACT_VERSION);

// Per-version slice (keyed by contractVersion) for older-template verification.
const versions: Record<number, ReturnType<typeof dumpForVersion>> = {};
for (const cv of getRegisteredContractVersions()) {
  versions[cv] = dumpForVersion(cv);
}

// Canonical structural-identity fingerprints. Current-version slice keyed by
// "${assetClass}|${variantKey}|${underwritingMode}"; `byVersion` carries the
// full keyed-by-version map for tooling that needs per-version verification.
const allFingerprints = getCanonicalFingerprints();
const currentFingerprints: Record<string, string> = {};
for (const [k, v] of Object.entries(allFingerprints)) {
  const [cvStr, ac, vk, mode] = k.split('|');
  if (Number(cvStr) === RENDER_CONTRACT_VERSION) {
    currentFingerprints[`${ac}|${vk}|${mode}`] = v;
  }
}

const out: Record<string, unknown> = {
  contractVersion: RENDER_CONTRACT_VERSION,
  registeredContractVersions: getRegisteredContractVersions(),
  assetClassVariantModeTabs: current.assetClassVariantModeTabs,
  bindingsByAssetClassVariantMode: current.bindingsByAssetClassVariantMode,
  structuralFingerprints: currentFingerprints,
  versions,
  structuralFingerprintsByVersion: allFingerprints,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');

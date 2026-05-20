/**
 * Template Registry — code-declared compatibility envelope per template artifact.
 *
 * Why this exists:
 *   Storage knows a template's `version` (an integer per uploaded artifact),
 *   but it cannot attest to which render contract / asset classes / variants
 *   that artifact was built against. Registering the envelope in code prevents
 *   an admin from silently widening support by re-uploading a file.
 *
 * Hard rules (memory/architecture_render_versioning.md):
 *   - Every (templateType, templateVersion) MUST appear in REGISTRY exactly
 *     once. Lookups are exact-match — no fallback, no implicit "latest".
 *   - supportedAssetClasses + supportedVariants MUST be a SUBSET of the
 *     schema's coverage for compatibleContractVersion. Subset (not equality)
 *     means adding a new asset class to the live schema does not invalidate
 *     older template entries — they simply do not render the new class. The
 *     boot assertion catches a template that *claims* support the schema
 *     does not provide; the export pipeline catches a payload that falls
 *     outside what the template *does* support.
 *   - To extend support, add a new (templateType, templateVersion) row whose
 *     compatibleContractVersion matches the schema. Never mutate existing rows.
 */
import type {
  AssetType,
  StructuralVariantKey,
  TemplateMetadata,
  TemplateType,
  UnderwritingMode,
} from '@cre/shared';
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import {
  getAssetClassesForContractVersion,
  getModesForVariant,
  getRegisteredContractVersions,
  getVariantsForAssetClass,
  RenderSchemaError,
} from './render-schema.js';

const ALL_ASSET_CLASSES: AssetType[] = [
  'office',
  'multifamily',
  'retail',
  'industrial',
  'hotel',
  'self_storage',
  'mixed_use',
  'manufactured_housing',
];

function allRegisteredVariants(contractVersion: number): StructuralVariantKey[] {
  const out = new Set<StructuralVariantKey>();
  for (const ac of getAssetClassesForContractVersion(contractVersion)) {
    for (const v of getVariantsForAssetClass(ac, contractVersion)) out.add(v);
  }
  return [...out].sort();
}

function allRegisteredUnderwritingModes(contractVersion: number): UnderwritingMode[] {
  const out = new Set<UnderwritingMode>();
  for (const ac of getAssetClassesForContractVersion(contractVersion)) {
    for (const v of getVariantsForAssetClass(ac, contractVersion)) {
      for (const m of getModesForVariant(ac, v, contractVersion)) out.add(m);
    }
  }
  return [...out].sort();
}

/**
 * The single source of truth for which uploaded template artifacts are
 * permitted to render which (assetClass, structuralVariantKey) pair.
 *
 * Add a new entry — never edit an existing one — when shipping a new template
 * artifact (e.g. one that adds tabs for a new variant or bumps schema).
 */
const REGISTRY: TemplateMetadata[] = [
  {
    templateType: 'single_loan',
    templateVersion: 1,
    compatibleContractVersion: RENDER_CONTRACT_VERSION,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(RENDER_CONTRACT_VERSION),
    // The single_loan template artifact is a 10-tab workbook bound to the
    // single_loan underwriting mode. Roll-up exports use the roll_up
    // template artifact below.
    supportedUnderwritingModes: ['single_loan'],
  },
  {
    // Matches the active uw_templates row currently in production:
    //   template_type='single_loan', version=2, is_active=1.
    // Same compatibility envelope as v1 — the artifact change was a workbook
    // refresh, not a schema bump. Older v1 row remains for replayability of
    // any artifacts pinned against it.
    templateType: 'single_loan',
    templateVersion: 2,
    compatibleContractVersion: RENDER_CONTRACT_VERSION,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(RENDER_CONTRACT_VERSION),
    supportedUnderwritingModes: ['single_loan'],
  },
  {
    templateType: 'roll_up',
    templateVersion: 1,
    compatibleContractVersion: RENDER_CONTRACT_VERSION,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(RENDER_CONTRACT_VERSION),
    supportedUnderwritingModes: ['roll_up'],
  },
];

function key(t: TemplateType, v: number): string {
  return `${t}|${v}`;
}

const REGISTRY_INDEX: ReadonlyMap<string, TemplateMetadata> = (() => {
  const m = new Map<string, TemplateMetadata>();
  for (const e of REGISTRY) {
    const k = key(e.templateType, e.templateVersion);
    if (m.has(k)) {
      throw new RenderSchemaError(
        'TEMPLATE_REGISTRY_DUPLICATE',
        `Duplicate template registry entry for (${e.templateType}, v${e.templateVersion}).`,
        { templateType: e.templateType, templateVersion: e.templateVersion },
      );
    }
    m.set(k, e);
  }
  return m;
})();

// Boot-time invariant: every entry's declared coverage must be a subset of
// the schema slice for its compatibleContractVersion. Catches a template that
// claims support the schema cannot provide. Subset (not equality) lets the
// schema add new asset classes / variants without invalidating older
// template rows.
(function assertRegistryCoverageWithinSchema() {
  const registeredVersions = new Set(getRegisteredContractVersions());
  for (const e of REGISTRY) {
    if (!registeredVersions.has(e.compatibleContractVersion)) {
      throw new RenderSchemaError(
        'TEMPLATE_REGISTRY_UNKNOWN_CONTRACT_VERSION',
        `Registry entry (${e.templateType}, v${e.templateVersion}) declares compatibleContractVersion=${e.compatibleContractVersion}, which is not registered in the schema.`,
        {
          templateType: e.templateType,
          templateVersion: e.templateVersion,
          compatibleContractVersion: e.compatibleContractVersion,
          registeredContractVersions: [...registeredVersions].sort((a, b) => a - b),
        },
      );
    }
    const schemaAssetClasses = new Set<string>(
      getAssetClassesForContractVersion(e.compatibleContractVersion),
    );
    const declaredAssetClassesNotInSchema = e.supportedAssetClasses.filter(
      (ac) => !schemaAssetClasses.has(ac),
    );
    if (declaredAssetClassesNotInSchema.length) {
      throw new RenderSchemaError(
        'TEMPLATE_REGISTRY_SCHEMA_DRIFT',
        `Registry entry (${e.templateType}, v${e.templateVersion}) declares supportedAssetClasses outside its compatibleContractVersion's schema.`,
        {
          templateType: e.templateType,
          templateVersion: e.templateVersion,
          compatibleContractVersion: e.compatibleContractVersion,
          unknown: declaredAssetClassesNotInSchema,
          schemaAssetClasses: [...schemaAssetClasses].sort(),
        },
      );
    }
    const schemaVariants = new Set<string>(
      allRegisteredVariants(e.compatibleContractVersion),
    );
    const declaredVariantsNotInSchema = e.supportedVariants.filter(
      (v) => !schemaVariants.has(v),
    );
    if (declaredVariantsNotInSchema.length) {
      throw new RenderSchemaError(
        'TEMPLATE_REGISTRY_SCHEMA_DRIFT',
        `Registry entry (${e.templateType}, v${e.templateVersion}) declares supportedVariants outside its compatibleContractVersion's schema.`,
        {
          templateType: e.templateType,
          templateVersion: e.templateVersion,
          compatibleContractVersion: e.compatibleContractVersion,
          unknown: declaredVariantsNotInSchema,
          schemaVariants: [...schemaVariants].sort(),
        },
      );
    }
    const schemaModes = new Set<string>(
      allRegisteredUnderwritingModes(e.compatibleContractVersion),
    );
    if (!e.supportedUnderwritingModes.length) {
      throw new RenderSchemaError(
        'TEMPLATE_REGISTRY_MODES_EMPTY',
        `Registry entry (${e.templateType}, v${e.templateVersion}) declares no supportedUnderwritingModes.`,
        {
          templateType: e.templateType,
          templateVersion: e.templateVersion,
          schemaUnderwritingModes: [...schemaModes].sort(),
        },
      );
    }
    const declaredModesNotInSchema = e.supportedUnderwritingModes.filter(
      (m) => !schemaModes.has(m),
    );
    if (declaredModesNotInSchema.length) {
      throw new RenderSchemaError(
        'TEMPLATE_REGISTRY_SCHEMA_DRIFT',
        `Registry entry (${e.templateType}, v${e.templateVersion}) declares supportedUnderwritingModes outside its compatibleContractVersion's schema.`,
        {
          templateType: e.templateType,
          templateVersion: e.templateVersion,
          compatibleContractVersion: e.compatibleContractVersion,
          unknown: declaredModesNotInSchema,
          schemaUnderwritingModes: [...schemaModes].sort(),
        },
      );
    }
  }
})();

/**
 * Look up the compatibility envelope for a stored template by exact
 * (templateType, templateVersion). Returns null if the artifact's version
 * has not been registered in code — callers MUST treat that as a hard
 * incompatibility, never apply a fallback.
 */
export function getTemplateMetadata(
  templateType: TemplateType,
  templateVersion: number,
): TemplateMetadata | null {
  const e = REGISTRY_INDEX.get(key(templateType, templateVersion));
  if (!e) return null;
  return {
    templateType: e.templateType,
    templateVersion: e.templateVersion,
    compatibleContractVersion: e.compatibleContractVersion,
    supportedAssetClasses: [...e.supportedAssetClasses],
    supportedVariants: [...e.supportedVariants],
    supportedUnderwritingModes: [...e.supportedUnderwritingModes],
  };
}

/** Diagnostic — list every registered (templateType, templateVersion). */
export function listRegisteredTemplates(): TemplateMetadata[] {
  return REGISTRY.map((e) => ({
    templateType: e.templateType,
    templateVersion: e.templateVersion,
    compatibleContractVersion: e.compatibleContractVersion,
    supportedAssetClasses: [...e.supportedAssetClasses],
    supportedVariants: [...e.supportedVariants],
    supportedUnderwritingModes: [...e.supportedUnderwritingModes],
  }));
}

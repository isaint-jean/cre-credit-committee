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
  // NOTE on contract-version pinning: registry entries are PINNED to the
  // contract version they shipped against, not to the current
  // RENDER_CONTRACT_VERSION constant. v1/v2/v6 were all registered when
  // RENDER_CONTRACT_VERSION was 9; bumping the constant to 10 (Rent Roll
  // render) MUST NOT retroactively rebind older templates to the new schema
  // — that would silently change what historical templates render. v10 is
  // the only entry that references the constant directly.
  {
    templateType: 'single_loan',
    templateVersion: 1,
    compatibleContractVersion: 9,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(9),
    // The single_loan template artifact is a 10-tab workbook bound to the
    // single_loan underwriting mode. Roll-up exports use the roll_up
    // template artifact below.
    supportedUnderwritingModes: ['single_loan'],
  },
  {
    // Same compatibility envelope as v1 — the artifact change was a workbook
    // refresh, not a schema bump. Older v1 row remains for replayability of
    // any artifacts pinned against it.
    templateType: 'single_loan',
    templateVersion: 2,
    compatibleContractVersion: 9,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(9),
    supportedUnderwritingModes: ['single_loan'],
  },
  {
    // single_loan v6 — P-column subtotal fix applied to the v2 artifact.
    // Same compatibility envelope as v1/v2 (workbook-content fix, not a schema
    // bump). The artifact is produced by apps/api/src/scripts/patch-template-p-column.ts
    // (detaches 7 shared-formula references in column P, rewrites them as
    // standalone formulas with correct P-column refs). Versions 3/4/5 are
    // skipped — they were silent re-uploads of v2 with no registry entry and
    // were removed as part of the v6 remediation
    // (apps/api/src/scripts/remediate-template-registry-v6.ts).
    //
    // NOTE: v6 was registered at compatibleContractVersion=9 (the value of
    // RENDER_CONTRACT_VERSION at the time v6 shipped). Today's
    // RENDER_CONTRACT_VERSION is 10 — but historical registrations stay
    // pinned to the version they were issued against. Reading the constant
    // here would re-bind v6 to v10 retroactively, which would silently
    // change what historical templates render. Pin to 9 explicitly.
    templateType: 'single_loan',
    templateVersion: 6,
    compatibleContractVersion: 9,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(9),
    supportedUnderwritingModes: ['single_loan'],
  },
  {
    // single_loan v10 — Rent Roll render. Same xlsm artifact as v6 (no
    // workbook-content change); the v-bump exists because the schema's
    // structural surface widened: 'Rent Roll' came out of excludedSheets,
    // 240 per-tenant cell-addresses were added under contract version 10,
    // and the RRP toggle on Property & Loan Summary!AA3 became a managed
    // cell. Versions 7/8/9 are intentionally skipped — there is no v7/v8/v9
    // template artifact, and aligning template version with contract
    // version makes the registry self-documenting. Uploaded into uw_templates
    // as version=10 via apps/api/src/scripts/remediate-template-registry-v10.ts
    // (direct INSERT bypassing uploadTemplate's MAX+1 — same idempotent
    // pattern as the v6 remediation, but with an explicit version number
    // rather than auto-increment).
    templateType: 'single_loan',
    templateVersion: 10,
    compatibleContractVersion: RENDER_CONTRACT_VERSION,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(RENDER_CONTRACT_VERSION),
    supportedUnderwritingModes: ['single_loan'],
  },
  {
    // roll_up v1 — pinned to v9 (the schema state at the time of original
    // registration). The roll_up template does not exercise the Rent Roll
    // tab; v10's structural additions do not apply. Rebind to v10 only when
    // a roll_up artifact is reshipped against the v10 schema.
    templateType: 'roll_up',
    templateVersion: 1,
    compatibleContractVersion: 9,
    supportedAssetClasses: ALL_ASSET_CLASSES,
    supportedVariants: allRegisteredVariants(9),
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

/** All registered template versions for a given templateType, ascending. */
export function getRegisteredVersionsForType(templateType: TemplateType): number[] {
  return REGISTRY
    .filter((e) => e.templateType === templateType)
    .map((e) => e.templateVersion)
    .sort((a, b) => a - b);
}

/**
 * Storage-boundary gate (root-cause fix for the v3/v4/v5 / v6 / v10 pollution
 * pattern). Thrown by `store.uploadTemplate` when the to-be-assigned version
 * (MAX+1) has no entry in this code registry. Surfaces to the production
 * admin route as a 409 with the structured body so the operator sees a clear
 * "register first" message rather than a silent polluter row that breaks
 * future exports.
 */
export class TemplateRegistryGateError extends Error {
  readonly code: 'TEMPLATE_VERSION_NOT_REGISTERED';
  readonly templateType: TemplateType;
  readonly targetVersion: number;
  readonly registeredVersions: number[];
  constructor(args: {
    templateType: TemplateType;
    targetVersion: number;
    registeredVersions: number[];
  }) {
    const message =
      `Upload would create ${args.templateType} v${args.targetVersion}, ` +
      `which is not registered in apps/api/src/services/template-registry.ts. ` +
      `Add an entry for (${args.templateType}, v${args.targetVersion}) — the boot-time ` +
      `invariant will verify schema coverage — then re-run. ` +
      `Currently registered versions for ${args.templateType}: ` +
      `[${args.registeredVersions.join(', ')}].`;
    super(message);
    this.name = 'TemplateRegistryGateError';
    this.code = 'TEMPLATE_VERSION_NOT_REGISTERED';
    this.templateType = args.templateType;
    this.targetVersion = args.targetVersion;
    this.registeredVersions = args.registeredVersions;
  }
}

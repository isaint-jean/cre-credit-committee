/**
 * Render Contract Migration Registry
 *
 * Single source of truth for what changed between versions of the render
 * contract. Every bump of RENDER_CONTRACT_VERSION must add a step here.
 * The chain from v1 to current is validated at module import — a missing
 * step fails server startup.
 *
 * Adding a new version (vN+1):
 *   1. Modify `render-schema.ts` (or `render.ts`) with the change.
 *   2. Bump RENDER_CONTRACT_VERSION to N+1.
 *   3. Append a `RenderContractMigration` to MIGRATIONS describing the diff.
 *   4. Run the dump-render-schema script to refresh the canonical JSON.
 *   5. Document in commit message; consumers are notified via /render-migrations.
 *
 * Forbidden:
 *   - Removing or renaming a managed-namespace entry, table, address, or
 *     visibility rule WITHOUT a corresponding entry in MIGRATIONS.
 *   - Bumping RENDER_CONTRACT_VERSION without a migration step.
 *   - Editing an existing migration step (history is append-only).
 */
import { RENDER_CONTRACT_VERSION } from '@cre/shared';
import type {
  MigrationManifest,
  RenderContractMigration,
} from '@cre/shared';
import { RenderSchemaError } from './render-schema.js';

// --- Append-only migration history ------------------------------------------
// Entry indices correspond to the step from (toVersion-1) to toVersion.
const MIGRATIONS: RenderContractMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description:
      'Schema authority moved fully to backend. Workbook becomes a pure ' +
      'derivative consumer of policy + table layouts shipped in payload.',
    autoApplicable: false,
    addresses: [],
    tables: [
      { kind: 'table-added', name: 'drivers' },
    ],
    managedNamespace: [
      // The policy was implicit/duplicated in VBA at v1; v2 makes it explicit
      // on the wire. No semantic change to the prefixes/literals themselves.
    ],
    visibility: [],
    wire: [
      { kind: 'payload-field-removed', field: 'drivers', reason: 'Replaced by structured `tables` payload with backend-declared layout.' },
      { kind: 'payload-field-added',   field: 'tables' },
      { kind: 'payload-field-added',   field: 'managedNamespace' },
    ],
    notes:
      'Workbooks built against v1 must be rebuilt to consume the new ' +
      '`tables` and `managedNamespace` fields. The set of named ranges in ' +
      'the workbook is unchanged, but VBA modules require updates ' +
      '(modBindings: WriteTables; modValidate: policy parameter).',
  },
  {
    fromVersion: 2,
    toVersion: 3,
    description:
      'Added structuralIdentity { assetClass, contractVersion, fingerprint } ' +
      'to RenderPayload. Backend now hard-fails any render whose ' +
      '(visibleTabs | schemaAddresses | managedNamespace | tableLayouts) ' +
      'diverges from the canonical snapshot for (assetClass, contractVersion).',
    autoApplicable: true,
    addresses: [],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [
      { kind: 'payload-field-added', field: 'structuralIdentity' },
    ],
    notes:
      'Purely additive on the wire — workbooks at v2 ignore the new field ' +
      'and continue rendering. Verifying the fingerprint client-side is ' +
      'optional but recommended for archival/replay use cases.',
  },
  {
    fromVersion: 3,
    toVersion: 4,
    description:
      'Added structuralVariantKey as a third deterministic dimension of ' +
      'StructuralIdentity. Each (assetClass, contractVersion, ' +
      'structuralVariantKey) triple selects exactly one schema definition ' +
      '(visibleTabs, schemaAddresses, cellBindings, tableLayouts, ' +
      'managedNamespace). The fingerprint formula now incorporates ' +
      'structuralVariantKey: hash(assetClass + contractVersion + ' +
      'structuralVariantKey + canonicalSchemaSnapshot). Workbooks MUST send ' +
      'structuralVariantKey to /render OR the backend resolves it ' +
      'deterministically — there is no implicit default variant. ' +
      '/render-config response shape changed: addressesByAssetClass → ' +
      'addressesByAssetClassVariant (keyed by variant), and adds ' +
      'variantsByAssetClass + assetClassVariantTabs.',
    autoApplicable: false,
    addresses: [],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [
      { kind: 'payload-field-added',   field: 'structuralVariantKey' },
      { kind: 'payload-field-added',   field: 'structuralIdentity.structuralVariantKey' },
      { kind: 'payload-field-removed', field: 'render-config.addressesByAssetClass', reason: 'Replaced by render-config.addressesByAssetClassVariant.' },
      { kind: 'payload-field-added',   field: 'render-config.addressesByAssetClassVariant' },
      { kind: 'payload-field-removed', field: 'render-config.assetClassTabs', reason: 'Replaced by render-config.assetClassVariantTabs.' },
      { kind: 'payload-field-added',   field: 'render-config.assetClassVariantTabs' },
      { kind: 'payload-field-added',   field: 'render-config.variantsByAssetClass' },
      { kind: 'payload-field-added',   field: 'render-config.assetClassVariantDefaults' },
      { kind: 'payload-field-added',   field: 'render-config.managedNamespaceByAssetClassVariant' },
    ],
    notes:
      'Workbooks built against v3 must be rebuilt to send ' +
      'structuralVariantKey on /render and to consume the variant-keyed ' +
      'render-config shape. v3 fingerprints will not match v4 fingerprints ' +
      'even when (assetClass, schemaAddresses) are unchanged, because the ' +
      'variant key is now folded into the hash.',
  },
  {
    fromVersion: 4,
    toVersion: 5,
    description:
      'Added underwritingMode (\'single_loan\' | \'roll_up\') as a fourth ' +
      'deterministic dimension of StructuralIdentity. The schema is now ' +
      'indexed by (contractVersion, assetClass, structuralVariantKey, ' +
      'underwritingMode); each tuple selects exactly one SchemaDefinition. ' +
      'underwritingMode is REQUIRED on /render and /export — there is NO ' +
      'implicit default. The fingerprint formula now incorporates ' +
      'underwritingMode: ' +
      'hash(assetClass + contractVersion + structuralVariantKey + ' +
      'underwritingMode + canonicalSchemaSnapshot). ' +
      'The single_loan mode replaces v4\'s uniform 6-tab layout (Cover, ' +
      'Inputs, *_Cashflow, *_DebtSchedule, *_Output, CrossCheck) with the ' +
      'BP Spire 10-tab layout (Property_Loan_Summary, Conclusion_Escrows, ' +
      'Property_Detail, Operating_ProForma, Stress_Scenario, ' +
      'Third_Party_Reports, Borrower, Market, Site_Inspection, ' +
      'Comparables). Tab names are no longer asset-class-prefixed. ' +
      'roll_up reuses the same 10-tab structural surface; the RU_* ' +
      'aggregation cells on Property_Loan_Summary are present in BOTH modes ' +
      '(structural surface is identical) — in single_loan they render the ' +
      'DATA_NOT_PROVIDED sentinel because rollUpAggregation is null. ' +
      'A SchemaDefinition declares its supported underwritingModes, and ' +
      'multi-mode definitions are the default to avoid duplication. ' +
      'RenderInput now requires underwritingContext: UnderwritingContext, ' +
      'which carries narrative + portfolio + aggregation metadata. ' +
      'AdjustedInputs remains strictly numeric — sentinels (' +
      'DATA_NOT_PROVIDED, NOT_AVAILABLE, REQUIRES_EXTERNAL_DATA) are ' +
      'permitted ONLY in narrative cells fed by underwritingContext. ' +
      'TemplateMetadata gains supportedUnderwritingModes; the export ' +
      'pipeline rejects any (template, payload) pair whose mode is not ' +
      'declared. /render-config response shape changes: ' +
      'addressesByAssetClassVariant → addressesByAssetClassVariantMode, ' +
      'managedNamespaceByAssetClassVariant → ' +
      'managedNamespaceByAssetClassVariantMode, assetClassVariantTabs → ' +
      'assetClassVariantModeTabs, plus modesByAssetClassVariant.',
    autoApplicable: false,
    addresses: [
      // v4 universal addresses (asset-class-prefixed) — removed.
      { kind: 'address-removed', address: 'Cover!Deal_Name',                  reason: 'Cover sheet replaced by Property_Loan_Summary.' },
      { kind: 'address-removed', address: 'Cover!Asset_Class',                reason: 'Cover sheet replaced by Property_Loan_Summary.' },
      { kind: 'address-removed', address: 'Cover!Generated_At',               reason: 'Cover sheet replaced by Property_Loan_Summary.' },
      { kind: 'address-removed', address: 'Cover!Cover_Conservatism_Status',  reason: 'Conservatism moved to Conclusion_Escrows tab.' },
      { kind: 'address-removed', address: 'Cover!Cover_Conservatism_Flags',   reason: 'Conservatism moved to Conclusion_Escrows tab.' },
      { kind: 'address-removed', address: 'Cover!Cover_Confidence_Reduction', reason: 'Moved to Operating_ProForma tab.' },
      { kind: 'address-removed', address: 'Cover!Cover_Library_Sample_Size',  reason: 'Moved to Operating_ProForma tab.' },
      { kind: 'address-removed', address: 'Cover!Cover_Library_Degraded',     reason: 'Moved to Operating_ProForma tab.' },
      // The full set of v4 *_Cashflow / *_DebtSchedule / *_Output addresses
      // is removed by virtue of those sheets being removed (see visibility).
      // We do not enumerate every prefix-permuted address here — the
      // visibility removals carry the structural change. New addresses are
      // declared in code (see render-schema.ts SCHEMA_V5).
      { kind: 'address-added', address: 'Property_Loan_Summary!Underwriting_Mode' },
    ],
    tables: [
      { kind: 'table-sheet-changed', name: 'drivers', from: 'CrossCheck', to: 'Conclusion_Escrows' },
    ],
    managedNamespace: [
      { kind: 'namespace-prefix-added',  prefix: 'PL_' },
      { kind: 'namespace-prefix-added',  prefix: 'CE_' },
      { kind: 'namespace-prefix-added',  prefix: 'PD_' },
      { kind: 'namespace-prefix-added',  prefix: 'OPF_' },
      { kind: 'namespace-prefix-added',  prefix: 'SS_' },
      { kind: 'namespace-prefix-added',  prefix: 'TPR_' },
      { kind: 'namespace-prefix-added',  prefix: 'BR_' },
      { kind: 'namespace-prefix-added',  prefix: 'MK_' },
      { kind: 'namespace-prefix-added',  prefix: 'SI_' },
      { kind: 'namespace-prefix-added',  prefix: 'CMP_' },
      { kind: 'namespace-prefix-added',  prefix: 'RU_' },
      { kind: 'namespace-prefix-removed', prefix: 'Cover_',    reason: 'Cover sheet removed; values relocated to PL_/CE_/OPF_.' },
      { kind: 'namespace-prefix-removed', prefix: 'Cashflow_', reason: '*_Cashflow sheets removed; metrics relocated to OPF_.' },
      { kind: 'namespace-literal-added',   literal: 'Underwriting_Mode' },
    ],
    visibility: [
      // Per-asset-class tab transitions. v4: Cover/Inputs/*_Cashflow/
      // *_DebtSchedule/*_Output/CrossCheck. v5: ten BP Spire tabs.
      ...(['multifamily', 'office', 'retail', 'industrial', 'hotel', 'self_storage', 'mixed_use', 'manufactured_housing']
        .flatMap((ac) => [
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Cover',        reason: 'Replaced by Property_Loan_Summary.' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Inputs',       reason: 'No longer in managed namespace; user-owned content collapsed into Property_Loan_Summary.' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'CrossCheck',   reason: 'Drivers table relocated to Conclusion_Escrows.' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Property_Loan_Summary' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Conclusion_Escrows' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Property_Detail' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Operating_ProForma' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Stress_Scenario' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Third_Party_Reports' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Borrower' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Market' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Site_Inspection' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Comparables' },
        ])),
    ],
    wire: [
      { kind: 'payload-field-added',   field: 'underwritingMode' },
      { kind: 'payload-field-added',   field: 'structuralIdentity.underwritingMode' },
      { kind: 'payload-field-added',   field: 'RenderInput.underwritingContext' },
      { kind: 'payload-field-added',   field: 'TemplateMetadata.supportedUnderwritingModes' },
      { kind: 'payload-field-removed', field: 'render-config.assetClassVariantTabs',                  reason: 'Replaced by render-config.assetClassVariantModeTabs.' },
      { kind: 'payload-field-added',   field: 'render-config.assetClassVariantModeTabs' },
      { kind: 'payload-field-removed', field: 'render-config.addressesByAssetClassVariant',           reason: 'Replaced by render-config.addressesByAssetClassVariantMode.' },
      { kind: 'payload-field-added',   field: 'render-config.addressesByAssetClassVariantMode' },
      { kind: 'payload-field-removed', field: 'render-config.managedNamespaceByAssetClassVariant',    reason: 'Replaced by render-config.managedNamespaceByAssetClassVariantMode.' },
      { kind: 'payload-field-added',   field: 'render-config.managedNamespaceByAssetClassVariantMode' },
      { kind: 'payload-field-added',   field: 'render-config.modesByAssetClassVariant' },
      { kind: 'payload-field-added',   field: 'response-header.X-Underwriting-Mode' },
    ],
    notes:
      'v4 templates do not render at v5 — the tab list, named-range ' +
      'namespace, and table location all changed. Rebuild template ' +
      'artifacts against v5 and register supportedUnderwritingModes in ' +
      'template-registry.ts. The v4 schema slice has been retired from ' +
      'SCHEMA_BY_CONTRACT_VERSION; restore it explicitly if v4 artifacts ' +
      'must keep rendering.',
  },
  {
    fromVersion: 5,
    toVersion: 6,
    description:
      'Schema realigned to conform to the canonical artifact ' +
      '(Blank UW Template.xlsm). v5 declared synthetic sheet names ' +
      '(Property_Loan_Summary, Conclusion_Escrows, etc.) and prefixed ' +
      'named ranges (PL_*, CE_*, OPF_*, etc.) that did not exist in any ' +
      'shipped artifact. v6 uses the artifact\'s real sheet names ' +
      '("Property & Loan Summary", "Conclusions & Escrows", ' +
      '"Stress Scenario", "Site Inspection", "Lease Comps", ' +
      '"Sales Comps", "CMBS Comps", etc.) and the artifact\'s real ' +
      'defined names verbatim (Property_Name, Current_Balance, Coupon, ' +
      'Annual_Debt_Service, Concluded_Cap_Rate, Concluded_Value, etc.). ' +
      'Per-asset-class sheet divergence (Property Detail - Comm vs ' +
      '- MF SS MHP vs - Hotel; Operating History and Pro Forma vs ' +
      'Hotel Op History and Pro Forma) is resolved by a SHEET_MAPPING ' +
      'boundary layer; the schema entries themselves remain unified ' +
      'across asset classes. Comparables splits into 3 logical slots ' +
      '(Lease/Sales/CMBS) matching the artifact. The schema is ' +
      'intentionally CONSERVATIVE at v6: only fields with confident ' +
      'artifact-side matches are registered (~9 entries). Fields the ' +
      'artifact does not expose as named ranges are out of v6 — adding ' +
      'them is additive future work and does not require breaking ' +
      'changes. The drivers cross-check table is dropped at v6 because ' +
      'the artifact has no reserved row range for it; reintroducing it ' +
      'requires identifying a target range without overwriting existing ' +
      'workbook content.',
    autoApplicable: false,
    addresses: [
      // v5's synthetic addresses are removed wholesale by retiring the v5
      // schema slice. We do not enumerate every PL_*/CE_*/OPF_*/etc. — the
      // visibility removals carry the structural change. v6 addresses are
      // declared in code (see render-schema.ts SCHEMA_V6).
      { kind: 'address-added', address: 'Property & Loan Summary!Property_Name' },
      { kind: 'address-added', address: 'Property & Loan Summary!Current_Balance' },
      { kind: 'address-added', address: 'Property & Loan Summary!Original_Balance' },
      { kind: 'address-added', address: 'Property & Loan Summary!Coupon' },
      { kind: 'address-added', address: 'Property & Loan Summary!Amortization_Term' },
      { kind: 'address-added', address: 'Property & Loan Summary!Interest_Only_Period' },
      { kind: 'address-added', address: 'Property & Loan Summary!Annual_Debt_Service' },
      { kind: 'address-added', address: 'Conclusions & Escrows!Concluded_Cap_Rate' },
      { kind: 'address-added', address: 'Conclusions & Escrows!Concluded_Value' },
    ],
    tables: [
      { kind: 'table-removed', name: 'drivers', reason: 'No canonical row range exists in the artifact for the drivers cross-check table; reintroducing it requires identifying a non-overlapping target.' },
    ],
    managedNamespace: [
      { kind: 'namespace-prefix-removed', prefix: 'Income_',    reason: 'Artifact uses unprefixed defined names.' },
      { kind: 'namespace-prefix-removed', prefix: 'Expense_',   reason: 'Artifact uses unprefixed defined names.' },
      { kind: 'namespace-prefix-removed', prefix: 'Loan_',      reason: 'Artifact uses unprefixed defined names.' },
      { kind: 'namespace-prefix-removed', prefix: 'Metric_',    reason: 'Artifact uses unprefixed defined names.' },
      { kind: 'namespace-prefix-removed', prefix: 'PL_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'CE_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'PD_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'OPF_',       reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'SS_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'TPR_',       reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'BR_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'MK_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'SI_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'CMP_',       reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-prefix-removed', prefix: 'RU_',        reason: 'Synthetic prefix; no presence in artifact.' },
      { kind: 'namespace-literal-removed', literal: 'Deal_Name',         reason: 'Replaced by artifact-existing Property_Name.' },
      { kind: 'namespace-literal-removed', literal: 'Asset_Class',       reason: 'Not present in artifact as a named range.' },
      { kind: 'namespace-literal-removed', literal: 'Underwriting_Mode', reason: 'Not present in artifact as a named range.' },
      { kind: 'namespace-literal-removed', literal: 'Generated_At',      reason: 'Not present in artifact as a named range.' },
      { kind: 'namespace-literal-added',   literal: 'Property_Name' },
      { kind: 'namespace-literal-added',   literal: 'Current_Balance' },
      { kind: 'namespace-literal-added',   literal: 'Original_Balance' },
      { kind: 'namespace-literal-added',   literal: 'Coupon' },
      { kind: 'namespace-literal-added',   literal: 'Amortization_Term' },
      { kind: 'namespace-literal-added',   literal: 'Interest_Only_Period' },
      { kind: 'namespace-literal-added',   literal: 'Annual_Debt_Service' },
      { kind: 'namespace-literal-added',   literal: 'Concluded_Cap_Rate' },
      { kind: 'namespace-literal-added',   literal: 'Concluded_Value' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Start Page' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Cover Page' },
      { kind: 'namespace-excluded-sheet-added', sheet: '10 Yr Pro Forma' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Rent Roll' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Presentation Rent Roll' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Rent Roll Summary' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Rent Roll Footnotes' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Broker Interview' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Pictures' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Maps' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Addendum' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Detailed Rollover' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Amortization Schedule' },
      { kind: 'namespace-excluded-sheet-added', sheet: 'Controls' },
      { kind: 'namespace-excluded-sheet-removed', sheet: 'Inputs', reason: 'No such sheet in artifact.' },
      { kind: 'namespace-excluded-sheet-removed', sheet: '_Config', reason: 'No such sheet in artifact.' },
    ],
    visibility: [
      // Per-asset-class tab transitions. v5 visibleTabs were synthetic
      // 10-tab single_loan layout; v6 is the artifact's actual sheet names.
      // Asset-class divergence in Property Detail / Operating ProForma is
      // listed per asset class.
      ...(['multifamily', 'office', 'retail', 'industrial', 'hotel', 'self_storage', 'mixed_use', 'manufactured_housing']
        .flatMap((ac) => [
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Property_Loan_Summary',  reason: 'Synthetic name; replaced by artifact sheet "Property & Loan Summary".' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Conclusion_Escrows',     reason: 'Synthetic name; replaced by "Conclusions & Escrows".' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Property_Detail',        reason: 'Synthetic name; mapped per asset class via SHEET_MAPPING.' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Operating_ProForma',     reason: 'Synthetic name; mapped per asset class via SHEET_MAPPING.' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Stress_Scenario',        reason: 'Synthetic name; replaced by "Stress Scenario".' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Third_Party_Reports',    reason: 'Synthetic name; replaced by "Third Party Reports Summary".' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Site_Inspection',        reason: 'Synthetic name; replaced by "Site Inspection".' },
          { kind: 'visible-tab-removed' as const, assetClass: ac, tab: 'Comparables',            reason: 'Replaced by three artifact comp sheets (Lease/Sales/CMBS Comps).' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Property & Loan Summary' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Conclusions & Escrows' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Stress Scenario' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Third Party Reports Summary' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Site Inspection' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Lease Comps' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'Sales Comps' },
          { kind: 'visible-tab-added' as const,   assetClass: ac, tab: 'CMBS Comps' },
        ])),
      // Property Detail per asset class.
      { kind: 'visible-tab-added' as const, assetClass: 'office',               tab: 'Property Detail - Comm' },
      { kind: 'visible-tab-added' as const, assetClass: 'retail',               tab: 'Property Detail - Comm' },
      { kind: 'visible-tab-added' as const, assetClass: 'industrial',           tab: 'Property Detail - Comm' },
      { kind: 'visible-tab-added' as const, assetClass: 'mixed_use',            tab: 'Property Detail - Comm' },
      { kind: 'visible-tab-added' as const, assetClass: 'multifamily',          tab: 'Property Detail - MF SS MHP' },
      { kind: 'visible-tab-added' as const, assetClass: 'self_storage',         tab: 'Property Detail - MF SS MHP' },
      { kind: 'visible-tab-added' as const, assetClass: 'manufactured_housing', tab: 'Property Detail - MF SS MHP' },
      { kind: 'visible-tab-added' as const, assetClass: 'hotel',                tab: 'Property Detail - Hotel' },
      // Operating ProForma per asset class.
      { kind: 'visible-tab-added' as const, assetClass: 'office',               tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'retail',               tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'industrial',           tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'mixed_use',            tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'multifamily',          tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'self_storage',         tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'manufactured_housing', tab: 'Operating History and Pro Forma' },
      { kind: 'visible-tab-added' as const, assetClass: 'hotel',                tab: 'Hotel Op History and Pro Forma' },
    ],
    wire: [],
    notes:
      'v5 templates do not render at v6 — every visibleTab and most ' +
      'schema addresses changed. Rebuild any v5-pinned templates against ' +
      'v6 (template-registry.ts auto-updates because rows reference ' +
      'RENDER_CONTRACT_VERSION). The v5 schema slice has been retired ' +
      'from SCHEMA_BY_CONTRACT_VERSION; restore it explicitly if v5 ' +
      'artifacts must keep rendering. Future v6+ bumps that ADD entries ' +
      'are non-breaking when no addresses are removed.',
  },
  {
    fromVersion: 6,
    toVersion: 7,
    description:
      'v7 introduces field-level dual-source authority. Each cell still ' +
      'declares EXACTLY ONE source surface (single-sourced); the migration ' +
      'shifts authority for property descriptors, party names, and most ' +
      'loan-structure fields from AdjustedInputs to resolvedContext. ' +
      'AdjustedInputs remains authoritative for the financial core — ' +
      'Loan_Amount (Current_Balance / Original_Balance), Interest_Rate ' +
      '(Coupon), Annual_Debt_Service, Concluded_Cap_Rate, Concluded_Value ' +
      '— and continues to drive every v6 cell unchanged. ' +
      'New cells: Property_Name, Address (street), City, State, ZIP, ' +
      'Property_Type, Year_Built, Occupancy (PL); Borrower, Sponsor ' +
      '(Borrower sheet); Balloon_Term (loan term in years from ' +
      'resolvedContext.loan.termMonths). Cells changing source surface ' +
      'while keeping the same artifact range: Amortization_Term and ' +
      'Interest_Only_Period now read from resolvedContext.loan.* (was ' +
      'AdjustedInputs.loan.*). Per-cell precedence policy (when ' +
      'resolvedContext is null): property + party cells render the ' +
      'DATA_NOT_PROVIDED sentinel without falling back to AdjustedInputs; ' +
      'loan term DOES fall back to AdjustedInputs (in the hydration layer ' +
      'only); amortization and IO MUST NOT fall back. v6 is NOT retired — ' +
      'the v6 slice and its AdjustedInputs-only authority remain ' +
      'registered, so artifacts pinned to v6 keep rendering identically. ' +
      'ALLOWED_SOURCES_BY_VERSION[7] permits {adjustedInputs, ' +
      'resolvedContext, meta}; mixed-source cells are still forbidden — ' +
      'each selector tag carries exactly one surface. Cells deferred from ' +
      'v7 because the artifact has no matching named ranges: ' +
      'Total_Square_Feet, Units, CMBS_Comps_Refs.',
    autoApplicable: false,
    addresses: [
      // Property block (8 new cells, all on PL).
      { kind: 'address-added', address: 'Property & Loan Summary!Property_Name' },
      { kind: 'address-added', address: 'Property & Loan Summary!Address' },
      { kind: 'address-added', address: 'Property & Loan Summary!City' },
      { kind: 'address-added', address: 'Property & Loan Summary!State' },
      { kind: 'address-added', address: 'Property & Loan Summary!ZIP' },
      { kind: 'address-added', address: 'Property & Loan Summary!Property_Type' },
      { kind: 'address-added', address: 'Property & Loan Summary!Year_Built' },
      { kind: 'address-added', address: 'Property & Loan Summary!Occupancy' },
      // Loan block — Balloon_Term is new at v7; Amortization_Term and
      // Interest_Only_Period keep their addresses but switch source surface
      // (recorded as a structural note rather than an address-removed/added
      // pair, since the cell address is identical).
      { kind: 'address-added', address: 'Property & Loan Summary!Balloon_Term' },
      // Party block (Borrower sheet).
      { kind: 'address-added', address: 'Borrower!Borrower' },
      { kind: 'address-added', address: 'Borrower!Sponsor' },
    ],
    tables: [],
    managedNamespace: [
      { kind: 'namespace-literal-added', literal: 'Property_Name' },
      { kind: 'namespace-literal-added', literal: 'Address' },
      { kind: 'namespace-literal-added', literal: 'City' },
      { kind: 'namespace-literal-added', literal: 'State' },
      { kind: 'namespace-literal-added', literal: 'ZIP' },
      { kind: 'namespace-literal-added', literal: 'Property_Type' },
      { kind: 'namespace-literal-added', literal: 'Year_Built' },
      { kind: 'namespace-literal-added', literal: 'Occupancy' },
      { kind: 'namespace-literal-added', literal: 'Balloon_Term' },
      { kind: 'namespace-literal-added', literal: 'Borrower' },
      { kind: 'namespace-literal-added', literal: 'Sponsor' },
    ],
    visibility: [],
    wire: [
      { kind: 'payload-field-added', field: 'ResolvedUnderwritingContext.property' },
      { kind: 'payload-field-added', field: 'ResolvedUnderwritingContext.loan' },
      { kind: 'payload-field-added', field: 'ResolvedUnderwritingContext.parties' },
      { kind: 'payload-field-added', field: 'ResolvedUnderwritingContext.comparablesLinkageRefs' },
    ],
    notes:
      'v6 stays registered alongside v7. Templates pinned to v6 keep ' +
      'rendering against the AdjustedInputs-only authority surface. v7 ' +
      'becomes the default for new exports. The hydration layer\'s ' +
      'loan-atom builder now implements the spec\'s asymmetric fallback ' +
      'policy (term: extraction → AdjustedInputs fallback; amort/IO: ' +
      'extraction-only). Adding the deferred Total_Square_Feet / Units / ' +
      'CMBS_Comps_Refs cells requires (a) artifact-side named-range ' +
      'additions and (b) a v8 bump that only ADDs entries.',
  },
  {
    fromVersion: 7,
    toVersion: 8,
    description:
      'Phase B of the populated-workbook initiative — payload shape bump, ' +
      'NO new cells. RenderPayload gains two parallel address-keyed maps: ' +
      '`cellStates` (every address declared by the schema → CellState; ' +
      'one of \'concluded\' | \'hitl\' | \'awaiting_input\') and ' +
      '`cellComments` (sparse map of hitl + awaiting_input addresses → ' +
      '{ state, text }). RenderConservatismStatus gains a `floorBindings: ' +
      'ReadonlyArray<FloorBinding>` field surfacing line items whose ' +
      'adjusted value was raised by a library or bank floor rule ' +
      '(JE_*_RAISED_TO_(LIBRARY|BANK), JE_*_SUBSTITUTED_FROM_LIBRARY, ' +
      'JE_*_FLOOR, JE_*_CAPPED_TO_BANK). The populated workbook\'s ' +
      'Conclusions tab uses floorBindings as a visible disclosure so ' +
      'floor-driven metrics aren\'t read as source-derived. The schema ' +
      'surface is identical to v7 — every entry carries forward with ' +
      'cellState=\'concluded\'. Template engine\'s writeCellValue now ' +
      'takes (cell, value, state, comment) and applies a GRAY fill ' +
      '(FFD9D9D9) for hitl + RED fill (FFFFC7CE, preserved from v7) for ' +
      'awaiting_input. concluded cells take no fill and no comment — ' +
      'template formatting wins, byte-identical to v7.',
    autoApplicable: true,
    addresses: [],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [
      { kind: 'payload-field-added', field: 'cellStates' },
      { kind: 'payload-field-added', field: 'cellComments' },
      { kind: 'payload-field-added', field: 'conservatismStatus.floorBindings' },
    ],
    notes:
      'Purely additive on the wire for clients that ignore the new ' +
      'fields. v7-pinned workbooks continue to render identically — every ' +
      'v8 cell is cellState=\'concluded\', so the visual surface is the ' +
      'same as v7 even when v8 is used. New cells with hitl / ' +
      'awaiting_input semantics are gated on the parent\'s Sunroad diff ' +
      'GATE and land in a separate phase.',
  },
  {
    fromVersion: 8,
    toVersion: 9,
    description:
      'Phase A of the populated-workbook initiative — operating-proforma ' +
      'cell fills, DSCR / Debt Yield closures, and AWAITING_INPUT entries ' +
      'for the cells the Sunroad GATE diff flagged as dangerous (expense ' +
      'markup pending, cap-rate calibration pending, extraction gaps). ' +
      'v9 ADDS schema entries; the payload contract shape is unchanged ' +
      'from v8 (cellStates + cellComments + floorBindings already shipped). ' +
      'No upstream contract changes: AdjustedInputs, HE, AnalysisId all ' +
      'stable; §2.3 lint policy untouched. ' +
      'CONCLUDED additions (sheet \'Operating History and Pro Forma\'): ' +
      'P9 (Income_Gross_Potential_Rental), P6 (Vacancy %), P10 (Vacancy ' +
      'Loss), P14 (Other Income), P30 (Management Fee), P31 (Real Estate ' +
      'Taxes), P38 (Replacement Reserves). CONCLUDED additions (sheet ' +
      '\'Conclusions & Escrows\'): J16 (NOI_Debt_Yield). Debt Yield ships ' +
      'CONCLUDED because the loan-terms placeholder ($80M @ 7% / 30-yr ' +
      'amort) was corrected to the real Sunroad loan ($82.46M @ 7.9% ' +
      'IO-only, 60mo IO over 60mo) and the engine value then diffs clean ' +
      '(engine 0.1033 vs answer 0.106, -2.54% conservative, within ±50bps). ' +
      'AWAITING_INPUT additions: P25 (Utilities), P22 (G&A), P32 ' +
      '(Insurance), P39 (TI), P40 (LC), P15 (Reimbursements), P49 ' +
      '(NCF_DSCR), Property & Loan Summary!E41 (LTV_Appraisal), K5 ' +
      '(Net_Rentable_Area), K6 (Property_Building_Class), Conclusions & ' +
      'Escrows!I16 (NOI_DSCR — see ticket #8 below). ' +
      'NOI_DSCR was originally classified CONCLUDED in the brief\'s ' +
      'cell-by-cell map under the gate "IF DSCR diffs clean post the ' +
      'loan-terms fix." The phase13 re-run reveals the engine\'s metrics. ' +
      'dscr is null today: the legacy adapter (analysis-to-adjusted-inputs) ' +
      'does NOT propagate LoanTermsExtraction into the loan-detail fields ' +
      'that feed debtServiceAnnual, so dscr = noi / 0 = null. Per the ' +
      'gate condition ("IF they then diff clean and non-optimistic") and ' +
      'the brief\'s discipline ("after the loan-terms fix + re-run: DSCR ' +
      'and Debt Yield IF they then diff clean and non-optimistic"), DSCR ' +
      'flips to AWAITING_INPUT pending the adapter wiring fix (ticket #8). ' +
      'Concluded_Cap_Rate and Concluded_Value FLIP from cellState=' +
      '\'concluded\' (v8) to cellState=\'awaiting_input\' (v9) — the ' +
      'library-median cap rate is optimistic on Sunroad (7.5% vs ' +
      'analyst-concluded 8.5%) and the value chain inherits the optimism ' +
      '($113.58M vs analyst $103.1M). Source-surface authority is ' +
      'unchanged (still LEGACY / adjustedInputs); only the cellState ' +
      'classification flips. HELD intentionally (NOT in schema): NOI ' +
      '(OPF row 35), NCF (row 44), EGI / Total Revenues (row 17), Total ' +
      'Operating Expenses (row 33). These rollups match the answer key ' +
      'on Sunroad only by coincidental cancellation of unresolved errors ' +
      '(vacancy floor binding up + expense markup down). Adding them as ' +
      'awaiting_input would suggest the engine knows it should be here; ' +
      'silent omission is the correct posture until both calibration ' +
      'tickets resolve. ' +
      'Operating-proforma cell addresses use explicit A1 references ' +
      '(P-column = "Eightfold Concluded") because the Blank UW Template ' +
      'has no defined names on this sheet. A1 addresses are brittle vs ' +
      'sheet-row reflow but acceptable per the brief; each is documented ' +
      'inline in render-schema.ts.',
    autoApplicable: true,
    addresses: [
      { kind: 'address-added', address: 'Operating History and Pro Forma!P9'  },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P6'  },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P10' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P14' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P30' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P31' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P38' },
      { kind: 'address-added', address: 'Conclusions & Escrows!I16'           },
      { kind: 'address-added', address: 'Conclusions & Escrows!J16'           },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P25' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P22' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P32' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P39' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P40' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P15' },
      { kind: 'address-added', address: 'Operating History and Pro Forma!P49' },
      { kind: 'address-added', address: 'Property & Loan Summary!E41'         },
      { kind: 'address-added', address: 'Property & Loan Summary!K5'          },
      { kind: 'address-added', address: 'Property & Loan Summary!K6'          },
    ],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v9 is additive on the schema surface (new addresses, no payload-' +
      'shape changes). v8-pinned templates keep rendering identically; ' +
      'v9 becomes the default for new exports. Cleanup tickets carried ' +
      'forward + extended:\n' +
      '  1. Id-cascade migration plan (4 record-shape bumps to date; ' +
      'no growth in v9).\n' +
      '  2. handbook.ts / handbook.json dual-source-of-truth.\n' +
      '  3. Signed-lease-status extraction gap.\n' +
      '  4. Trailing-actuals ingest slot (class-b).\n' +
      '  5. NEW: Expense-markup value-add rule. Model-A: issuer expense ' +
      'lines on the CF are a FLOOR; restate up where a line reads ' +
      'understated vs market (Utilities/G&A/Insurance pattern on ' +
      'Sunroad). Consumes a market-norm signal (library benchmark? a ' +
      'manualInputs expense-comp layer parallel to marketRentComps?) and ' +
      'produces an upward markup with disclosure. PRIORITY — five ' +
      'Phase-A cells are AWAITING_INPUT until this lands.\n' +
      '  6. NEW: Cap-rate calibration. Library-median cap rate is ' +
      'optimistic on most B-piece deals (analyst typically applies a ' +
      'spread over comps + conservatism widening). Either source from a ' +
      'manualInputs cap-rate-comp layer OR apply a calibrated spread + ' +
      'conservatism. Concluded_Cap_Rate + Concluded_Value AWAITING_INPUT ' +
      'until this lands.\n' +
      '  7. NEW: Loan terms as a real ingest input. The form-field ' +
      'already exists (build-and-ingest accepts `loanTerms`); the ' +
      'cleanup is doc/path for how the analyst supplies real loan terms ' +
      'in production. The phase scripts hardcoded a placeholder; the ' +
      'placeholder is now fixed to match Sunroad reality.\n' +
      '  8. NEW: Adapter wiring — LoanTermsExtraction → uwModel.' +
      'loanDetails. The legacy adapter (analysis-to-adjusted-inputs.' +
      'adapter.ts) does NOT propagate LoanTermsExtraction values through ' +
      'the synthesized uwModel into AdjustedInputs.loan.debtServiceAnnual, ' +
      'so dscr = noi / 0 = null on the phase13 re-run despite the ' +
      'corrected loan terms. NOI_DSCR (Conclusions & Escrows!I16) ships ' +
      'as AWAITING_INPUT until this wiring lands; Debt Yield is unaffected ' +
      'because it does not divide by debtServiceAnnual.',
  },
  {
    fromVersion: 9,
    toVersion: 10,
    description:
      'Rent Roll render. The Rent Roll sheet comes OUT of excludedSheets ' +
      '(the 3 formula-only derivatives — Presentation Rent Roll, Rent Roll ' +
      'Summary, Rent Roll Footnotes — stay excluded; they compute off Rent ' +
      'Roll and have no inputs to receive). v10 ADDS 240 per-tenant cell ' +
      'addresses on the Rent Roll tab (rows 14–43, 30-tenant capacity, ' +
      'columns B/C/D/E/F/G/I/N = suite, tenant name, square feet, status ' +
      'code, lease start, lease end, in-place rent PSF, lease type). Plus ' +
      'one RRP-toggle override at Property & Loan Summary!AA3 (literal ' +
      '"TRUE") so the dependent IF($S$8, …) chains on the Pro Forma ' +
      'resolve to a clean FALSE (since C8=525, not "Mark to Market") and ' +
      'pick the in-place INDEX branch, which reads from Operating-History ' +
      'column P (engine-populated, clean). NEW INPUT SURFACE: ' +
      'RenderInput.rentRoll — bundle.rentRoll passthrough. NEW SourceSurface ' +
      'tag \'rentRoll\' in ALLOWED_SOURCES_BY_VERSION[10]. NEW ' +
      'FieldMigrationState RENT_ROLL_SOURCED (REQUIRED_SOURCE_BY_STATE = ' +
      '\'rentRoll\'). Honest-blank preserved: any tenant field that\'s ' +
      'null (squareFeet, leaseStart, etc.) writes blank, never 0; leaseType ' +
      '"UNKNOWN" renders verbatim to surface the data gap. xlsm artifact ' +
      'unchanged from v6 — the v-bump records a schema-surface widening, ' +
      'not a workbook content change.',
    autoApplicable: true,
    addresses: (() => {
      const out: Array<{ kind: 'address-added'; address: string }> = [];
      const cols = ['B', 'C', 'D', 'E', 'F', 'G', 'I', 'N'];
      for (let row = 14; row <= 43; row++) {
        for (const col of cols) {
          out.push({ kind: 'address-added', address: `Rent Roll!${col}${row}` });
        }
      }
      out.push({ kind: 'address-added', address: 'Property & Loan Summary!AA3' });
      return out;
    })(),
    tables: [],
    managedNamespace: [
      { kind: 'namespace-excluded-sheet-removed', sheet: 'Rent Roll', reason: 'v10 writes per-tenant rows into Rent Roll inputs B/C/D/E/F/G/I/N rows 14–43.' },
    ],
    visibility: [],
    wire: [],
    notes:
      'v10 is additive on the schema surface (new addresses + one sheet ' +
      'unexcluded). v9-pinned templates keep rendering identically; v10 ' +
      'becomes the default for new exports. Cleanup tickets carried ' +
      'forward + extended:\n' +
      '  1-8: as in v9.\n' +
      '  9. NEW: AI rent-roll extractor returns leaseType=\'UNKNOWN\' and ' +
      'suite=null for every Sunroad tenant — data-quality gap, not render ' +
      'gap. v10 surfaces the UNKNOWN visibly in column N rather than ' +
      'silently defaulting (honest gap disclosure).\n' +
      '  10. NEW: bp-spire / operator-facing uploadTemplate callers still ' +
      'create new template versions without registry enforcement. Captured ' +
      'in remediate-template-registry-v10.ts; gating uploadTemplate on a ' +
      'registry lookup is the durable fix.',
  },
  {
    fromVersion: 10,
    toVersion: 11,
    description:
      'Tier-1 safe render wires. Two pure selectors against data already ' +
      'computed elsewhere in the pipeline — meta.dealId and ' +
      'adjustedInputs.assumptions.terminalCapRate.adjusted — surface on the ' +
      'Cover Page and 10 Yr Pro Forma sheets respectively. v11 ADDS two ' +
      'SheetSlots (Cover_Page, Ten_Year_Pro_Forma), two cell addresses ' +
      '(Cover Page!Deal_Control_Number, 10 Yr Pro Forma!Terminal_Cap_Rate), ' +
      'and unexcludes both sheets from managedNamespace.excludedSheets. No ' +
      'new source surface, no payload-shape change, no extraction or ' +
      'contract changes downstream of the schema — both selectors tag ' +
      'surfaces v10 already permits (\'meta\' since v7, \'adjustedInputs\' ' +
      'since v6). Carry-forward entries from v10 unchanged. xlsm artifact ' +
      'unchanged. Pinned core (eval / envelope / snapshot / column-P NOI) ' +
      'unaffected — Terminal_Cap_Rate already enters the verdict path via ' +
      'judgment/apply-judgment-adjustments.ts (buildTerminalCapRate); this ' +
      'change only closes the render gap so the value also displays in ' +
      'its cell.',
    autoApplicable: true,
    addresses: [
      { kind: 'address-added', address: 'Cover Page!Deal_Control_Number' },
      { kind: 'address-added', address: '10 Yr Pro Forma!Terminal_Cap_Rate' },
    ],
    tables: [],
    managedNamespace: [
      { kind: 'namespace-excluded-sheet-removed', sheet: 'Cover Page', reason: 'v11 writes Deal_Control_Number (H2) on Cover Page.' },
      { kind: 'namespace-excluded-sheet-removed', sheet: '10 Yr Pro Forma', reason: 'v11 writes Terminal_Cap_Rate (P36) on 10 Yr Pro Forma.' },
    ],
    visibility: [],
    wire: [],
    notes:
      'v11 is additive on the schema surface (two new addresses, two sheets ' +
      'unexcluded). v10-pinned templates keep rendering identically; v11 ' +
      'becomes the default for new exports. Cleanup tickets carried ' +
      'forward + extended:\n' +
      '  1-10: as in v10.\n' +
      '  11. NEW: Loan_Balance (Property & Loan Summary!W7:W97) was ' +
      'scoped for v11 but HELD — recon confirmed no engine-side ' +
      'amortization-balance series exists. Engine surfaces scalars only ' +
      '(annualDebtService + maturityBalance via judgment/amortization.ts); ' +
      'the workbook\'s own Amortization Schedule sheet projects the series ' +
      'via its existing formula chain (column I "Ending Balance"). Wiring ' +
      'W7:W97 would need either a formula-emitting selector (selectors ' +
      'return CellValue today, not formulas) or an engine extension to ' +
      'compute the series. Either is a separate scope; v11 keeps W7:W97 ' +
      'honest-blank.',
  },
  {
    fromVersion: 11,
    toVersion: 12,
    description:
      'Loan Purpose render wire. One pure selector against data already ' +
      'hydrated on the UnderwritingContext — c.property.loanPurpose ' +
      '(propertyMetadata.loanPurpose) — surfaces on Property & Loan Summary!K27, ' +
      'mirroring the buildingClass binding pattern. v12 ADDS exactly one cell ' +
      'address (Property & Loan Summary!K27); no new SheetSlot, no source ' +
      'surface (\'resolvedContext\' permitted since v7), no payload-shape ' +
      'change, no namespace change. Carry-forward entries from v11 unchanged. ' +
      'xlsm artifact unchanged. Pinned core (eval / envelope / snapshot / ' +
      'column-P NOI) unaffected — loan purpose is display-only metadata.',
    autoApplicable: true,
    addresses: [
      { kind: 'address-added', address: 'Property & Loan Summary!K27' },
    ],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v12 is additive on the schema surface (one new address). v11-pinned ' +
      'templates keep rendering identically; v12 becomes the default for new ' +
      'exports. Threads loanPurpose into the context property atoms ' +
      '(hydrate-underwriting-context.ts buildPropertyAtoms, analogous to ' +
      'buildingClass) + the UnderwritingPropertyAtoms raw and resolved types.',
  },
  {
    fromVersion: 12,
    toVersion: 13,
    description:
      'Rent Roll Rank column wire. Binds Rent Roll!A14:A43 to the income-sorted ' +
      'rent-roll line index (rank = i+1; A14=1 … A43=30), reusing the existing ' +
      'rrField guard (null for rows beyond the tenant count). This is the join ' +
      'key the Stress Scenario tab keys on (SUMIF/MATCH on \'Rent Roll\'!$A$14:' +
      '$A$323) — the column was previously unbound (V10_RENT_ROLL_ENTRIES binds ' +
      'B,C,D,E,F,G,I,N but never A), so the tenant-loss stress columns returned ' +
      'N/A despite the tenant data being present. v13 ADDS exactly 30 cell ' +
      'addresses (Rent Roll!A14 … A43); no new SheetSlot, no source surface ' +
      '(\'rentRoll\' permitted since v10), no payload-shape change, no namespace ' +
      'change. Carry-forward entries from v12 unchanged. xlsm artifact unchanged. ' +
      'Pinned core (eval / envelope / snapshot / column-P NOI) unaffected.',
    autoApplicable: true,
    addresses: Array.from({ length: 30 }, (_, i) => ({
      kind: 'address-added' as const,
      address: `Rent Roll!A${14 + i}`,
    })),
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v13 is additive on the schema surface (30 new Rank addresses). v12-pinned ' +
      'templates keep rendering identically; v13 becomes the default for new ' +
      'exports. No new source surface — the Rank cells read the same \'rentRoll\' ' +
      'bundle the v10 per-tenant rows already use. Side effect: the Stress ' +
      'Scenario tenant-loss columns now resolve on recompute (their join key is ' +
      'populated).',
  },
  {
    fromVersion: 13,
    toVersion: 14,
    description:
      'Sources & Uses render wire. Binds the Property & Loan Summary S&U block ' +
      'from the ASR\'s deterministically-parsed S&U table (no LLM), routed via ' +
      'resolvedContext.sourcesUses.* (resolvedContext permitted since v7). Six ' +
      'new input cells: F27 (Previous Debt payoff), F28 (Cash to Borrower / ' +
      'return of equity), F29 (Escrow / Reserves), F30 (Closing Costs), F31 ' +
      '(Other / capex), K30 (Total Cost Basis). The totals (F32, B32, K31, K32) ' +
      'and the sources side (B27 = Original_Balance) are formula-wired and NOT ' +
      'bound; Purchase Price (K29) stays honest-blank (Sunroad is a refinance). ' +
      'v14 ADDS exactly 6 cell addresses; no new SheetSlot, no source surface, ' +
      'no payload-shape change, no namespace change. Carry-forward entries from ' +
      'v13 unchanged. xlsm artifact unchanged. Pinned core unaffected — S&U is ' +
      'display-only metadata.',
    autoApplicable: true,
    addresses: ['F27', 'F28', 'F29', 'F30', 'F31', 'K30'].map((cell) => ({
      kind: 'address-added' as const,
      address: `Property & Loan Summary!${cell}`,
    })),
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v14 is additive on the schema surface (6 new S&U addresses). v13-pinned ' +
      'templates keep rendering identically; v14 becomes the default for new ' +
      'exports. Threads the ASR S&U table through analysis.sourcesAndUses → the ' +
      'c.sourcesUses.* context atoms (hydrate buildSourcesUsesAtoms + resolver ' +
      'passthrough), analogous to the appraisal / parties seams.',
  },
  {
    fromVersion: 14,
    toVersion: 15,
    description:
      'Note Date render wire. Binds Property & Loan Summary!C13 (the Note_Date ' +
      'named range cell) to the loan Note Date — derived credit-free from ' +
      'maturityDate − termMonths and emitted as an Excel date serial, routed via ' +
      'resolvedContext.property.noteDate (permitted since v7). Anchors the ' +
      'period-date headers (YEAR(Note_Date)-1 …), which rendered 1899 while C13 ' +
      'was empty (YEAR of the Excel epoch). v15 ADDS exactly one cell address ' +
      '(Property & Loan Summary!C13); no new SheetSlot, no source surface, no ' +
      'payload-shape change, no namespace change. Carry-forward entries from v14 ' +
      'unchanged. Companion template-artifact edit (OH!H3 / Hotel!K3: ' +
      'YEAR(TODAY()) → YEAR(Note_Date)) kills the separate 2026 TODAY()-leak. ' +
      'Pinned core unaffected — date labels are display-only.',
    autoApplicable: true,
    addresses: [
      { kind: 'address-added', address: 'Property & Loan Summary!C13' },
    ],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v15 is additive on the schema surface (one new address). v14-pinned ' +
      'templates keep rendering identically; v15 becomes the default for new ' +
      'exports. Threads noteDate into the context property atoms ' +
      '(hydrate-underwriting-context.ts buildPropertyAtoms, analogous to ' +
      'loanPurpose).',
  },
  {
    fromVersion: 15,
    toVersion: 16,
    description:
      'Balloon_Term corrective override. Re-points an EXISTING bound cell ' +
      '(Property & Loan Summary!Balloon_Term) from ctxLoanMonthsToYears(' +
      'termMonths) to c.loan.ioMonths. The old binding emitted round(27/12)=2 — ' +
      'wrong SOURCE (termMonths = remaining term from the as-of, not the ' +
      'original) and wrong UNIT (years; the template consumes Balloon_Term in ' +
      'MONTHS). That made the amortization balloon fire at month 2 and forced ' +
      'Annual_Debt_Service onto the degenerate amortizing PMT branch (since ' +
      'IO=60 ≠ 2) — the −$86M 10-Yr Pro Forma cash flow. v16 emits ioMonths ' +
      '(60, in months), matching Interest_Only_Period, so the balloon fires at ' +
      'month 60 and Annual_Debt_Service takes the IO branch (≈$6.09M). v16 ADDS ' +
      'NO cell address (selector re-point on an existing cell) and no source ' +
      'surface (resolvedContext permitted since v7); the schema address set is ' +
      'identical to v15. Carry-forward entries from v15 unchanged. xlsm artifact ' +
      'unchanged.',
    autoApplicable: true,
    addresses: [],
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v16 is a value-correcting selector override on an existing address — no ' +
      'new addresses, no structural-fingerprint change. v15-pinned templates ' +
      'keep rendering identically; v16 becomes the default for new exports. ' +
      'ioMonths is the original term only for full-term-IO loans (amort=0); for ' +
      'amortizing loans the true original term is not reachable (no origination ' +
      'date / term field in the extraction), but ioMonths is strictly better ' +
      'than the prior remaining-term and exact for full-term-IO deals.',
  },
  {
    fromVersion: 16,
    toVersion: 17,
    description:
      'T12 historical column render wire. Binds the 16 Operating History ' +
      'column-H input cells (H6/H9/H11/H13/H14/H15/H22/H24/H25/H26/H30/H31/H32/' +
      'H38/H39/H40) from resolvedContext.t12.* (analysis.t12Extraction — the ' +
      'normalized borrower 12-month operating statement), mirroring the issuer-' +
      'UW column L cell-for-cell. The H10/H12/H17/H27/H33/H35 subtotals are ' +
      'formulas and are NOT bound. Display-only historical column — doctrine ' +
      'stays frozen. v17 ADDS exactly 16 cell addresses; no new SheetSlot, no ' +
      'source surface (resolvedContext permitted since v7), no payload-shape ' +
      'change, no namespace change. Carry-forward entries from v16 unchanged.',
    autoApplicable: true,
    addresses: ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'].flatMap((sh) =>
      ['H6', 'H9', 'H11', 'H13', 'H14', 'H15', 'H22', 'H24', 'H25', 'H26', 'H30', 'H31', 'H32', 'H38', 'H39', 'H40'].map((cell) => ({
        kind: 'address-added' as const,
        address: `${sh}!${cell}`,
      })),
    ),
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v17 is additive on the schema surface (16 new T12 addresses). v16-pinned ' +
      'templates keep rendering identically; v17 becomes the default for new ' +
      'exports. Threads the normalized T12 actuals through analysis.t12Extraction ' +
      '→ the c.t12.* context atoms (hydrate buildT12Atoms + resolver passthrough), ' +
      'analogous to the issuer-UW seam. Vintage asymmetry (T12 FINAL vs loan ' +
      'PRELIM) + the lease-termination red flag carried on the H9 cell comment.',
  },
  {
    fromVersion: 17,
    toVersion: 18,
    description:
      'T12 must-carry surfacing. Binds two VISIBLE Operating History cells from ' +
      'resolvedContext.t12.{vintage,creditSignal} (analysis.t12Notes), both in ' +
      'the Operating History "Comments:" section: A53 = the vintage label (T12 ' +
      'FINAL vs loan PRELIM); A54 = the lease-termination credit signal + ' +
      'adjustment trail. Schema cell comments do not survive to Excel (the ' +
      'criterion-3 lesson) — these are real cell VALUES inside the print area ' +
      '(A1:R78), so a reviewer of the B-piece workbook actually sees them. v18 ' +
      'ADDS exactly 2 cell addresses; no new SheetSlot, no source surface ' +
      '(resolvedContext permitted since v7), no payload-shape change. ' +
      'Carry-forward entries from v17 unchanged.',
    autoApplicable: true,
    addresses: ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'].flatMap((sh) =>
      ['A53', 'A54'].map((cell) => ({ kind: 'address-added' as const, address: `${sh}!${cell}` })),
    ),
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v18 is additive (2 new note addresses). Threads analysis.t12Notes → the ' +
      'c.t12.{vintage,creditSignal} atoms (hydrate buildT12Atoms + resolver ' +
      'passthrough). The dormant analyses.data.comments stamp is superseded by ' +
      'this consumed location and removed in the same re-stamp (single home).',
  },
  {
    fromVersion: 18,
    toVersion: 19,
    description:
      'Document-Completeness Ledger. Declares 3 Operating History "Comments:"-area ' +
      'cells (A55 present / A56 missing / A57 coverage) across both Operating_ProForma ' +
      'sheets. The schema selector emits a null sentinel; the text is filled by a ' +
      'downstream render-time DISPLAY layer (applyDocumentCompletenessDisplay) because ' +
      'the ledger\'s actually-blank-in-render sanity gate reads OTHER cells\' rendered ' +
      'values — unknowable to a pure pre-projection selector. Pure derived display: no ' +
      'projection feedback, no underwriting-value mutation. v19 ADDS exactly 6 addresses ' +
      '(3 cells × 2 sheets); no new SheetSlot, no source surface, no payload-shape ' +
      'change. Carry-forward entries from v18 unchanged.',
    autoApplicable: true,
    addresses: ['Operating History and Pro Forma', 'Hotel Op History and Pro Forma'].flatMap((sh) =>
      ['A55', 'A56', 'A57'].map((cell) => ({ kind: 'address-added' as const, address: `${sh}!${cell}` })),
    ),
    tables: [],
    managedNamespace: [],
    visibility: [],
    wire: [],
    notes:
      'v19 is additive (6 new ledger addresses). Values computed by ' +
      'computeDocumentCompleteness(sourceDocuments ∪ overlays vs the field-authority ' +
      'registry) and written post-projection — declared-in-schema, filled-by-display.',
  },
];

// --- Boot-time chain validation ---------------------------------------------
// Throws RenderSchemaError if the migration history is broken or out of sync
// with RENDER_CONTRACT_VERSION. Runs at module import.
function assertChainComplete(): void {
  if (RENDER_CONTRACT_VERSION < 1) {
    throw new RenderSchemaError(
      'MIGRATION_CHAIN_BROKEN',
      `RENDER_CONTRACT_VERSION must be >= 1 (got ${RENDER_CONTRACT_VERSION}).`,
    );
  }
  for (let v = 2; v <= RENDER_CONTRACT_VERSION; v++) {
    const step = MIGRATIONS.find((m) => m.fromVersion === v - 1 && m.toVersion === v);
    if (!step) {
      throw new RenderSchemaError(
        'MIGRATION_CHAIN_BROKEN',
        `Missing migration step from v${v - 1} → v${v}. Every RENDER_CONTRACT_VERSION bump must add an entry to MIGRATIONS.`,
        { expectedFromVersion: v - 1, expectedToVersion: v },
      );
    }
  }
  // Detect orphan migrations beyond the current version.
  const orphan = MIGRATIONS.find((m) => m.toVersion > RENDER_CONTRACT_VERSION);
  if (orphan) {
    throw new RenderSchemaError(
      'MIGRATION_CHAIN_BROKEN',
      `Migration step ${orphan.fromVersion}→${orphan.toVersion} exists but RENDER_CONTRACT_VERSION is ${RENDER_CONTRACT_VERSION}. Bump the constant or remove the step.`,
      { orphan },
    );
  }
  // Detect duplicates / non-monotonic / non-contiguous steps.
  const seen = new Set<string>();
  for (const m of MIGRATIONS) {
    if (m.toVersion !== m.fromVersion + 1) {
      throw new RenderSchemaError(
        'MIGRATION_CHAIN_BROKEN',
        `Migration must move exactly one version forward (got ${m.fromVersion}→${m.toVersion}).`,
        { migration: m },
      );
    }
    const key = `${m.fromVersion}->${m.toVersion}`;
    if (seen.has(key)) {
      throw new RenderSchemaError(
        'MIGRATION_CHAIN_BROKEN',
        `Duplicate migration step ${key}.`,
        { migration: m },
      );
    }
    seen.add(key);
  }
}
assertChainComplete();

// --- Public API -------------------------------------------------------------
export function getMigrationManifest(
  fromVersion: number,
  toVersion: number = RENDER_CONTRACT_VERSION,
): MigrationManifest {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new RenderSchemaError(
      'MIGRATION_INVALID_FROM_VERSION',
      `fromVersion must be an integer >= 1 (got ${fromVersion}).`,
      { fromVersion },
    );
  }
  if (!Number.isInteger(toVersion) || toVersion < 1) {
    throw new RenderSchemaError(
      'MIGRATION_INVALID_TO_VERSION',
      `toVersion must be an integer >= 1 (got ${toVersion}).`,
      { toVersion },
    );
  }
  if (toVersion > RENDER_CONTRACT_VERSION) {
    throw new RenderSchemaError(
      'MIGRATION_TO_AHEAD_OF_BACKEND',
      `toVersion=${toVersion} exceeds backend RENDER_CONTRACT_VERSION=${RENDER_CONTRACT_VERSION}.`,
      { toVersion, backendVersion: RENDER_CONTRACT_VERSION },
    );
  }
  if (fromVersion > toVersion) {
    throw new RenderSchemaError(
      'MIGRATION_FROM_AHEAD_OF_TO',
      `Workbook reports fromVersion=${fromVersion} but render target is v${toVersion}.`,
      { fromVersion, toVersion },
    );
  }
  const steps = MIGRATIONS.filter(
    (m) => m.fromVersion >= fromVersion && m.toVersion <= toVersion,
  ).sort((a, b) => a.fromVersion - b.fromVersion);
  return {
    fromVersion,
    toVersion,
    steps,
    autoApplicable: steps.length > 0 && steps.every((s) => s.autoApplicable),
  };
}

export function getAllMigrations(): RenderContractMigration[] {
  return MIGRATIONS.slice();
}

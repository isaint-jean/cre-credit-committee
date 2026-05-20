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

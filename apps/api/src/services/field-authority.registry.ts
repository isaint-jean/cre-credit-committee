/**
 * Property & Loan Summary — Field Authority Registry (v7+)
 *
 * Pure data. No runtime logic. Boot-time freeze at module load.
 *
 * Coverage: ~80 cells across the seven sections of the original spec —
 *   1. Property identification + physical
 *   2. Debt stack
 *   3. Debt provisions (recourse, ARD, sub-debt, etc.)
 *   4. Sources & Uses
 *   5. Loan purpose / cost basis / equity
 *   6. Pro-forma derived metrics + scenario columns
 *   7. Cap rates (perspective × valuation context) + NOI per context
 *   8. Prior sale / history
 *
 * Plus three EntityCollections:
 *   - Tenant         (domain: tenancy, keyField: tenantId)
 *   - LeaseRollover  (domain: tenancy, keyField: yearEnding)
 *   - DebtTranche    (domain: loan,    keyField: trancheId)
 *
 * Resolution state initialization rule:
 *   - 16 cells already in render-schema v7 → 'mapped' or 'derived'
 *   - All other ~64 cells                 → 'unmapped'
 *
 * The 'unmapped' entries declare the TARGET extraction path against the
 * eventual UnderwritingContext shape. Until that shape lands, the resolver
 * emits AWAITING_CONTEXT_SHAPE for these cells and they render blank.
 */
import type {
  EntityCollectionDefinition,
  FieldAuthorityRegistry,
  FieldRef,
} from './field-authority.types.js';

// --------------------------------------------------------------------------
// Helpers — keep entries readable. NOT runtime logic; just data construction.
// --------------------------------------------------------------------------

const PRESERVE_PRECEDENCE = { kind: 'preserveAllCandidates' as const };

const blank = { kind: 'blank' as const };
const blankWarn = (code: string) =>
  ({ kind: 'blankWithWarning' as const, warningCode: code });
const blankRed = (code: string) =>
  ({ kind: 'blankWithRedFlag' as const, redFlagCode: code });
const excludeFromDerivation = (downstreamFields: readonly string[]) =>
  ({ kind: 'excludeFromDerivation' as const, downstreamFields });

// --------------------------------------------------------------------------
// 1. PROPERTY IDENTIFICATION + PHYSICAL  (12 cells)
// --------------------------------------------------------------------------

const PROPERTY_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Property_Name',
    meaning: 'Official property/deal name',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.name' },
    fallbacks: [
      { document: 'uwMemo', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.officialName' },
    ],
    missingBehavior: blankWarn('PROPERTY_NAME_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'propertyName.noFilenameDerivation',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'never derive from filename or path' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Address',
    meaning: 'Street address',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.street' },
    fallbacks: [
      { document: 'loanDocs', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.streetAddress' },
    ],
    missingBehavior: blankRed('ADDRESS_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'address.structuredOnly',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'no geocode inference' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'City',
    meaning: 'Property city',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.city' },
    fallbacks: [
      { document: 'loanDocs', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.city' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'State',
    meaning: 'Property state',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.state' },
    fallbacks: [
      { document: 'loanDocs', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.state' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'ZIP',
    meaning: 'Property ZIP',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.zip' },
    fallbacks: [
      { document: 'loanDocs', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.zip' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'County',
    meaning: 'County jurisdiction',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'propertyLoanSummary.county' },
    fallbacks: [
      { document: 'publicRecordExtract', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.countyPublicRecord' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'county.noLookupInference',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'no inferred county lookup' }],
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Submarket_MSA',
    meaning: 'Market classification (submarket / MSA)',
    domain: 'market',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'market.submarketMSA' },
    fallbacks: [
      { document: 'externalCompsDb', surface: 'resolvedContext',
        extractionPath: 'market.externalCompsSubmarket' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'submarket.requiresExplicitAttachment',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'externalCompsDb only when explicitly attached' }],
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Property_Type',
    meaning: 'Asset type / subtype',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.type' },
    fallbacks: [
      { document: 'uwMemo', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.propertyType' },
    ],
    missingBehavior: blankWarn('PROPERTY_TYPE_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'propertyType.noAIClassification',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'no AI classification' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Occupancy',
    meaning: 'Physical occupancy snapshot (decimal fraction)',
    domain: 'property',
    primary: { document: 'rentRoll', surface: 'resolvedContext',
               extractionPath: 'property.occupancy' },
    fallbacks: [
      { document: 'asr', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.asrOccupancy' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'percent', preserveOriginal: true },
    validation: [{ id: 'occupancy.requiresEffectiveDate',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustHaveEffectiveDate' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Net_Rentable_Area',
    meaning: 'NRA (square feet)',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.totalSquareFeet' },
    fallbacks: [
      { document: 'survey', surface: 'resolvedContext',
        extractionPath: 'propertyDetail.surveyNRA' },
    ],
    missingBehavior: blankRed('NRA_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'nra.noRentRollSummation',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'no rent-roll summation unless explicitly defined' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Building_Class',
    meaning: 'Building class (A/B/C/etc.)',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'propertyDetail.buildingClass' },
    fallbacks: [
      { document: 'uwMemo', surface: 'resolvedContext',
        extractionPath: 'propertyDetail.uwMemoBuildingClass' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Year_Built',
    meaning: 'Year built',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.yearBuilt' },
    fallbacks: [
      { document: 'pca', surface: 'resolvedContext',
        extractionPath: 'thirdPartyReports.pcaYearBuilt' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'dualYear', preserveOriginal: true },
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Year_Renovated',
    meaning: 'Last renovation year',
    domain: 'property',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'property.yearRenovated' },
    fallbacks: [
      { document: 'pca', surface: 'resolvedContext',
        extractionPath: 'thirdPartyReports.pcaYearRenovated' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'dualYear', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Ownership_Interest',
    meaning: 'Ownership percentage / entity',
    domain: 'property',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'propertyLoanSummary.ownershipInterest' },
    fallbacks: [
      { document: 'organizationalDocs', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.orgDocsOwnership' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// 2. DEBT STACK  (11 cells)
// --------------------------------------------------------------------------

const DEBT_STACK_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Current_Balance',
    meaning: 'Outstanding debt balance',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'adjustedInputs',
               extractionPath: 'loan.currentBalance' },
    fallbacks: [
      { document: 'servicerStatement', surface: 'adjustedInputs',
        extractionPath: 'loan.servicerCurrentBalance' },
    ],
    missingBehavior: blankRed('CURRENT_BALANCE_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Original_Balance',
    meaning: 'Original committed balance',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'adjustedInputs',
               extractionPath: 'loan.originalBalance' },
    fallbacks: [
      { document: 'closingStatement', surface: 'adjustedInputs',
        extractionPath: 'loan.closingOriginalBalance' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Balloon_Term',
    meaning: 'Loan term (months)',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.termMonths' },
    fallbacks: [
      { document: 'commitment', surface: 'adjustedInputs',
        extractionPath: 'loan.termMonths' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Amortization_Term',
    meaning: 'Amortization schedule (years)',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.amortizationMonths' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'amort.zeroOnlyIfIO',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'zero only if explicitly IO' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Interest_Only_Period',
    meaning: 'IO duration (months)',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.ioMonths' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'io.noInferenceFromAmort',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'never infer from amortization' }],
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Coupon',
    meaning: 'Interest rate',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'adjustedInputs',
               extractionPath: 'loan.couponRate' },
    fallbacks: [
      { document: 'rateCapNote', surface: 'adjustedInputs',
        extractionPath: 'loan.rateCapCoupon' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'rateSpread', preserveOriginal: true },
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Annual_Debt_Service',
    meaning: 'Annualized required debt payment',
    domain: 'loan',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.annualDebtService' },
    fallbacks: [],
    missingBehavior: excludeFromDerivation([
      'NOI_DSCR', 'NCF_DSCR', 'Maturity_Balance',
    ]),
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'ads.v1', formulaVersion: 1,
      requiredInputs: ['Current_Balance', 'Coupon',
                       'Amortization_Term', 'Interest_Only_Period'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'derived',
  },
  {
    cellAddress: 'Maturity_Date',
    meaning: 'Loan maturity date',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.maturityDate' },
    fallbacks: [
      { document: 'commitment', surface: 'resolvedContext',
        extractionPath: 'loan.commitmentMaturityDate' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'date', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Maturity_Balance',
    meaning: 'Balloon balance at maturity',
    domain: 'loan',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.maturityBalance' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'maturityBalance.v1', formulaVersion: 1,
      requiredInputs: ['Current_Balance', 'Coupon',
                       'Amortization_Term', 'Interest_Only_Period',
                       'Balloon_Term'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Control_Pari_Balance',
    meaning: 'Pari-passu controlling balance',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.pariPassu.controlBalance' },
    fallbacks: [
      { document: 'intercreditor', surface: 'resolvedContext',
        extractionPath: 'loan.intercreditorPariBalance' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Controlling_Party',
    meaning: 'Controlling lender entity',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.controllingParty' },
    fallbacks: [
      { document: 'intercreditor', surface: 'resolvedContext',
        extractionPath: 'loan.intercreditorControllingParty' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// 3. DEBT PROVISIONS  (10 cells)  — recourse, ARD, sub-debt summary, etc.
// --------------------------------------------------------------------------

const DEBT_PROVISIONS_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Release_Provisions',
    meaning: 'Release mechanics',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.releaseProvisions' },
    fallbacks: [
      { document: 'psa', surface: 'resolvedContext',
        extractionPath: 'loan.psaReleaseProvisions' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'release.binaryRequiresExplicitEvidence',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'binary fields require explicit evidence' }],
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Recourse',
    meaning: 'Recourse status',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.recourse' },
    fallbacks: [
      { document: 'commitment', surface: 'resolvedContext',
        extractionPath: 'loan.commitmentRecourse' },
    ],
    missingBehavior: blankRed('RECOURSE_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'recourse.boolean',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustBeBoolean',
                   notes: 'never infer nonrecourse from absence' }],
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Cross_Collateralized_Default',
    meaning: 'Cross-default / cross-collateralization structure',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.crossCollateralized' },
    fallbacks: [
      { document: 'intercreditor', surface: 'resolvedContext',
        extractionPath: 'loan.intercreditorCrossDefault' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Cash_Management',
    meaning: 'Cash management / lockbox / triggers',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.cashManagement' },
    fallbacks: [
      { document: 'servicerStatement', surface: 'resolvedContext',
        extractionPath: 'loan.servicerCashManagement' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Hyper_Amortized',
    meaning: 'Hyper-amortization feature flag',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.hyperAmortized' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'hyperAmort.boolean',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustBeBoolean' }],
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Anticipated_Repayment_Date',
    meaning: 'ARD / firm term',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.ard.date' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'date', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'ARD_Interest_Rate_Step',
    meaning: 'ARD step-up mechanics',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.ard.rateStep' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'rateSpread', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Total_Swept_Per_Measure',
    meaning: 'Total swept reserves',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.totalSwept' },
    fallbacks: [
      { document: 'servicerStatement', surface: 'resolvedContext',
        extractionPath: 'loan.servicerSweptBalance' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Sub_Debt_Holder',
    meaning: 'Subordinate debt holder',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.subDebtSummary.holder' },
    fallbacks: [
      { document: 'intercreditor', surface: 'resolvedContext',
        extractionPath: 'loan.intercreditorSubDebtHolder' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Sub_Debt_Terms_Finalized',
    meaning: 'Sub debt finalized status flag',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.subDebtSummary.termsFinalized' },
    fallbacks: [
      { document: 'uwMemo', surface: 'resolvedContext',
        extractionPath: 'loan.uwMemoSubDebtFinalized' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'subDebtFinalized.boolean',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustBeBoolean' }],
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// 4. SOURCES & USES  (5 cells)
// --------------------------------------------------------------------------

const SOURCES_AND_USES_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Senior_Loan',
    meaning: 'Senior loan proceeds',
    domain: 'sourcesAndUses',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'sourcesAndUses.sources.seniorLoan' },
    fallbacks: [
      { document: 'closingStatement', surface: 'resolvedContext',
        extractionPath: 'sourcesAndUses.sources.closingSeniorLoan' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Subordinate_Financing',
    meaning: 'Subordinate / mezz / pref proceeds',
    domain: 'sourcesAndUses',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'sourcesAndUses.sources.subordinateFinancing' },
    fallbacks: [
      { document: 'capitalStackSchedule', surface: 'resolvedContext',
        extractionPath: 'sourcesAndUses.sources.capitalStackSubordinate' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Cash_from_Borrower',
    meaning: 'Sponsor equity contribution',
    domain: 'sourcesAndUses',
    primary: { document: 'closingStatement', surface: 'resolvedContext',
               extractionPath: 'sourcesAndUses.sources.cashFromBorrower' },
    fallbacks: [
      { document: 'equityContributionSchedule', surface: 'resolvedContext',
        extractionPath: 'sourcesAndUses.sources.equityContributionSchedule' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Other_Sources',
    meaning: 'Other proceeds',
    domain: 'sourcesAndUses',
    primary: { document: 'closingStatement', surface: 'resolvedContext',
               extractionPath: 'sourcesAndUses.sources.other' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Total_Sources',
    meaning: 'Sum of all funding sources',
    domain: 'sourcesAndUses',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'sourcesAndUses.totals.totalSources' },
    fallbacks: [],
    missingBehavior: excludeFromDerivation(['Loan_to_Cost']),
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'sources.sum.v1', formulaVersion: 1,
      requiredInputs: ['Senior_Loan', 'Subordinate_Financing',
                       'Cash_from_Borrower', 'Other_Sources'],
      blankIfAnyMissing: true,
    },
    validation: [{ id: 'sources.equalUses',
                   severity: 'fail', mode: 'soft',
                   kind: 'mustSumTo', partner: 'Total_Cost_Basis',
                   notes: 'sources must reconcile to total uses' }],
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// 5. LOAN PURPOSE / COST BASIS / EQUITY  (9 cells)
// --------------------------------------------------------------------------

const COST_BASIS_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Loan_Purpose',
    meaning: 'Acquisition / refinance / construction',
    domain: 'loan',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'loan.loanPurpose' },
    fallbacks: [
      { document: 'uwMemo', surface: 'resolvedContext',
        extractionPath: 'propertyLoanSummary.uwMemoLoanPurpose' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Date_Acquired',
    meaning: 'Acquisition date',
    domain: 'history',
    primary: { document: 'psa', surface: 'resolvedContext',
               extractionPath: 'history.dateAcquired' },
    fallbacks: [
      { document: 'asr', surface: 'resolvedContext',
        extractionPath: 'history.asrDateAcquired' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'date', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Purchase_Price',
    meaning: 'Historical acquisition price',
    domain: 'history',
    primary: { document: 'psa', surface: 'resolvedContext',
               extractionPath: 'history.purchasePrice' },
    fallbacks: [
      { document: 'asr', surface: 'resolvedContext',
        extractionPath: 'history.asrPurchasePrice' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Total_Cost_Basis',
    meaning: 'Total basis / total uses',
    domain: 'sourcesAndUses',
    primary: { document: 'closingStatement', surface: 'resolvedContext',
               extractionPath: 'sourcesAndUses.uses.totalCostBasis' },
    fallbacks: [
      { document: 'sponsorBudget', surface: 'resolvedContext',
        extractionPath: 'sourcesAndUses.uses.sponsorBudgetTotalBasis' },
    ],
    missingBehavior: excludeFromDerivation([
      'Loan_to_Cost', 'Total_Cost_Basis_PSF',
    ]),
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Loan_to_Cost',
    meaning: 'LTC ratio',
    domain: 'sourcesAndUses',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.loanToCost' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'ltc.v1', formulaVersion: 1,
      requiredInputs: ['Senior_Loan', 'Total_Cost_Basis'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'percent', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Total_Cost_Basis_PSF',
    meaning: 'Basis per square foot',
    domain: 'sourcesAndUses',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.totalCostBasisPSF' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'costBasisPSF.v1', formulaVersion: 1,
      requiredInputs: ['Total_Cost_Basis', 'Net_Rentable_Area'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Cash_Flow_Returned_in_IO_above_PI',
    meaning: 'Incremental IO savings vs amortizing P&I',
    domain: 'loan',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.cashFlowIOAboveAmortizing' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'ioPickup.v1', formulaVersion: 1,
      requiredInputs: ['Coupon', 'Current_Balance',
                       'Amortization_Term', 'Interest_Only_Period'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Cash_on_Cash_Equity',
    meaning: 'Cash-on-cash equity yield',
    domain: 'sourcesAndUses',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.cashOnCashEquity' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'coc.v1', formulaVersion: 1,
      requiredInputs: ['Cash_from_Borrower', 'Annual_Debt_Service',
                       'NOI_AsIs'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'percent', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Remaining_Equity_at_Maturity',
    meaning: 'Equity residual estimate at maturity',
    domain: 'sourcesAndUses',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.remainingEquityAtMaturity' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'remainingEquity.v1', formulaVersion: 1,
      requiredInputs: ['Value_at_Cap_Underwritten_Exit', 'Maturity_Balance'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// 6. CAP RATES (perspective × valuation context = 8 cells) + NOI per context (4)
// --------------------------------------------------------------------------

function appraiserCap(context: 'AsIs' | 'Stabilized' | 'Exit' | 'Market'): FieldRef {
  const lcContext = context.charAt(0).toLowerCase() + context.slice(1);
  return {
    cellAddress: `Cap_Rate_Appraiser_${context}`,
    meaning: `Appraiser ${context.toLowerCase()} cap rate`,
    domain: 'market',
    valuationContext: lcContext === 'asIs' ? 'asIs'
                    : lcContext === 'stabilized' ? 'stabilized'
                    : lcContext === 'exit' ? 'exit'
                    : 'market',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: `valuation.capRates.appraiser.${lcContext}` },
    fallbacks: [],
    missingBehavior: blankRed(`APPRAISER_${context.toUpperCase()}_CAP_MISSING`),
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'percent', preserveOriginal: true },
    resolutionState: 'unmapped',
  };
}

function underwrittenCap(context: 'AsIs' | 'Stabilized' | 'Exit' | 'Market'): FieldRef {
  const lcContext = context.charAt(0).toLowerCase() + context.slice(1);
  return {
    cellAddress: `Cap_Rate_Underwritten_${context}`,
    meaning: `Underwritten ${context.toLowerCase()} cap rate`,
    domain: 'market',
    valuationContext: lcContext === 'asIs' ? 'asIs'
                    : lcContext === 'stabilized' ? 'stabilized'
                    : lcContext === 'exit' ? 'exit'
                    : 'market',
    primary: { document: 'manualInput', surface: 'resolvedContext',
               extractionPath: `valuation.capRates.underwritten.${lcContext}` },
    fallbacks: [
      { document: 'derived', surface: 'adjustedInputs',
        extractionPath: 'metrics.capRate' },
    ],
    missingBehavior: blankRed(`UNDERWRITTEN_${context.toUpperCase()}_CAP_MISSING`),
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'percent', preserveOriginal: true },
    resolutionState: 'unmapped',
  };
}

const CAP_RATE_FIELDS: readonly FieldRef[] = [
  appraiserCap('AsIs'),
  appraiserCap('Stabilized'),
  appraiserCap('Exit'),
  appraiserCap('Market'),
  underwrittenCap('AsIs'),
  underwrittenCap('Stabilized'),
  underwrittenCap('Exit'),
  underwrittenCap('Market'),
];

function noiByContext(context: 'AsIs' | 'Stabilized' | 'Exit' | 'Market'): FieldRef {
  const lcContext = context.charAt(0).toLowerCase() + context.slice(1);
  const isDerived = context === 'Exit';
  return {
    cellAddress: `NOI_${context}`,
    meaning: `NOI (${context.toLowerCase()})`,
    domain: 'valuation',
    valuationContext: lcContext === 'asIs' ? 'asIs'
                    : lcContext === 'stabilized' ? 'stabilized'
                    : lcContext === 'exit' ? 'exit'
                    : 'market',
    primary: isDerived
      ? { document: 'derived', surface: 'adjustedInputs',
          extractionPath: 'valuation.noi.exit' }
      : context === 'AsIs'
        ? { document: 't12', surface: 'resolvedContext',
            extractionPath: 'valuation.noi.asIs' }
        : context === 'Stabilized'
          ? { document: 'derived', surface: 'adjustedInputs',
              extractionPath: 'metrics.netOperatingIncome' }
          : { document: 'externalCompsDb', surface: 'resolvedContext',
              extractionPath: 'valuation.noi.market' },
    fallbacks: context === 'Stabilized'
      ? [{ document: 'manualInput', surface: 'resolvedContext',
           extractionPath: 'valuation.noi.stabilizedManual' }]
      : [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: isDerived
      ? { formulaId: 'noi.exit.v1', formulaVersion: 1,
          requiredInputs: ['NOI_Stabilized'],
          blankIfAnyMissing: true }
      : undefined,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: isDerived ? 'unmapped' : 'unmapped',
  };
}

const NOI_FIELDS: readonly FieldRef[] = [
  noiByContext('AsIs'),
  noiByContext('Stabilized'),
  noiByContext('Exit'),
  noiByContext('Market'),
];

// --------------------------------------------------------------------------
// 7. PRO-FORMA DERIVED METRICS (8 cells) + Value_at_Cap (8 cells per perspective×context)
// --------------------------------------------------------------------------

function valueAtCap(perspective: 'Appraiser' | 'Underwritten',
                    context: 'AsIs' | 'Stabilized' | 'Exit' | 'Market'): FieldRef {
  const lcContext = context.charAt(0).toLowerCase() + context.slice(1);
  return {
    cellAddress: `Value_at_Cap_${perspective}_${context}`,
    meaning: `Implied value: ${context.toLowerCase()} NOI / ${perspective.toLowerCase()} ${context.toLowerCase()} cap`,
    domain: 'valuation',
    valuationContext: lcContext === 'asIs' ? 'asIs'
                    : lcContext === 'stabilized' ? 'stabilized'
                    : lcContext === 'exit' ? 'exit'
                    : 'market',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: `valuation.values.${perspective.toLowerCase()}.${lcContext}` },
    fallbacks: [],
    missingBehavior: excludeFromDerivation([
      `LTV_${perspective}_${context}`,
    ]),
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'value.directCap.v1', formulaVersion: 1,
      requiredInputs: [`NOI_${context}`,
                       `Cap_Rate_${perspective}_${context}`],
      blankIfAnyMissing: true,
    },
    validation: [{ id: 'value.positive', severity: 'warn', mode: 'soft',
                   kind: 'mustBeWithinRange', rangeBound: { min: 0 } }],
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  };
}

const VALUE_AT_CAP_FIELDS: readonly FieldRef[] = [
  valueAtCap('Appraiser', 'AsIs'),
  valueAtCap('Appraiser', 'Stabilized'),
  valueAtCap('Appraiser', 'Exit'),
  valueAtCap('Appraiser', 'Market'),
  valueAtCap('Underwritten', 'AsIs'),
  valueAtCap('Underwritten', 'Stabilized'),
  valueAtCap('Underwritten', 'Exit'),
  valueAtCap('Underwritten', 'Market'),
];

const PRO_FORMA_DERIVED_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Effective_Gross_Income',
    meaning: 'Revenue after vacancy / credit loss',
    domain: 'valuation',
    primary: { document: 't12', surface: 'adjustedInputs',
               extractionPath: 'income.effectiveGrossIncome' },
    fallbacks: [
      { document: 'rentRoll', surface: 'adjustedInputs',
        extractionPath: 'income.rentRollEGI' },
    ],
    missingBehavior: excludeFromDerivation(['Net_Operating_Income']),
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Operating_Expenses',
    meaning: 'Historical OpEx',
    domain: 'valuation',
    primary: { document: 't12', surface: 'adjustedInputs',
               extractionPath: 'expenses.operatingExpenses' },
    fallbacks: [],
    missingBehavior: excludeFromDerivation(['Net_Operating_Income']),
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Net_Operating_Income',
    meaning: 'NOI = EGI - OpEx',
    domain: 'valuation',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.netOperatingIncome' },
    fallbacks: [],
    missingBehavior: excludeFromDerivation([
      'NOI_DSCR', 'NOI_DY', 'Net_Cash_Flow',
    ]),
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'noi.v1', formulaVersion: 1,
      requiredInputs: ['Effective_Gross_Income', 'Operating_Expenses'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'TI_LC_CapEx',
    meaning: 'Tenant improvements / leasing commissions / CapEx reserves',
    domain: 'valuation',
    primary: { document: 'manualInput', surface: 'resolvedContext',
               extractionPath: 'valuation.reserves.tiLcCapex' },
    fallbacks: [],
    missingBehavior: excludeFromDerivation(['Net_Cash_Flow']),
    conflictPolicy: PRESERVE_PRECEDENCE,
    validation: [{ id: 'tiLcCapex.noInference',
                   severity: 'warn', mode: 'soft',
                   kind: 'mustPreserveStructure',
                   notes: 'never infer reserve values' }],
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Net_Cash_Flow',
    meaning: 'NOI less reserves',
    domain: 'valuation',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.netCashFlow' },
    fallbacks: [],
    missingBehavior: excludeFromDerivation([
      'NCF_DSCR', 'Free_CF_after_Senior_Debt_Service',
    ]),
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'ncf.v1', formulaVersion: 1,
      requiredInputs: ['Net_Operating_Income', 'TI_LC_CapEx'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Free_CF_after_Senior_Debt_Service',
    meaning: 'Cash flow after senior debt',
    domain: 'valuation',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.freeCFAfterSeniorDebtService' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'freeCFAfterSeniorDebt.v1', formulaVersion: 1,
      requiredInputs: ['Net_Cash_Flow', 'Annual_Debt_Service'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'NOI_DSCR',
    meaning: 'Debt service coverage on NOI',
    domain: 'loan',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.dscr' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'dscr.noi.v1', formulaVersion: 1,
      requiredInputs: ['Net_Operating_Income', 'Annual_Debt_Service'],
      blankIfAnyMissing: true,
    },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'NCF_DSCR',
    meaning: 'Debt service coverage on NCF',
    domain: 'loan',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.ncfDscr' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'dscr.ncf.v1', formulaVersion: 1,
      requiredInputs: ['Net_Cash_Flow', 'Annual_Debt_Service'],
      blankIfAnyMissing: true,
    },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'NOI_DY',
    meaning: 'Debt yield on NOI',
    domain: 'loan',
    primary: { document: 'derived', surface: 'adjustedInputs',
               extractionPath: 'metrics.debtYield' },
    fallbacks: [],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    derivation: {
      formulaId: 'dy.noi.v1', formulaVersion: 1,
      requiredInputs: ['Net_Operating_Income', 'Current_Balance'],
      blankIfAnyMissing: true,
    },
    formatPolicy: { type: 'percent', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// 8. PARTIES + HISTORY (5 cells)
// --------------------------------------------------------------------------

const PARTY_AND_HISTORY_FIELDS: readonly FieldRef[] = [
  {
    cellAddress: 'Borrower',
    meaning: 'Borrower entity',
    domain: 'property',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'parties.borrowerName' },
    fallbacks: [
      { document: 'organizationalDocs', surface: 'resolvedContext',
        extractionPath: 'parties.orgDocsBorrower' },
    ],
    missingBehavior: blankWarn('BORROWER_MISSING'),
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Sponsor',
    meaning: 'Sponsor entity',
    domain: 'property',
    primary: { document: 'loanDocs', surface: 'resolvedContext',
               extractionPath: 'parties.sponsorName' },
    fallbacks: [
      { document: 'organizationalDocs', surface: 'resolvedContext',
        extractionPath: 'parties.orgDocsSponsor' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'mapped',
  },
  {
    cellAddress: 'Prior_Sale_Date',
    meaning: 'Prior transaction date',
    domain: 'history',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'history.priorSale.date' },
    fallbacks: [
      { document: 'publicRecordExtract', surface: 'resolvedContext',
        extractionPath: 'history.priorSale.publicRecordDate' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'date', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Prior_Sale_Price',
    meaning: 'Prior transaction price',
    domain: 'history',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'history.priorSale.price' },
    fallbacks: [
      { document: 'publicRecordExtract', surface: 'resolvedContext',
        extractionPath: 'history.priorSale.publicRecordPrice' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    formatPolicy: { type: 'currency', preserveOriginal: true },
    resolutionState: 'unmapped',
  },
  {
    cellAddress: 'Prior_Sale_Owner',
    meaning: 'Prior owner / occupancy',
    domain: 'history',
    primary: { document: 'asr', surface: 'resolvedContext',
               extractionPath: 'history.priorSale.owner' },
    fallbacks: [
      { document: 'publicRecordExtract', surface: 'resolvedContext',
        extractionPath: 'history.priorSale.publicRecordOwner' },
    ],
    missingBehavior: blank,
    conflictPolicy: PRESERVE_PRECEDENCE,
    resolutionState: 'unmapped',
  },
];

// --------------------------------------------------------------------------
// ENTITY COLLECTIONS — Tenant, LeaseRollover, DebtTranche
// All keyed (no ordinal indexing). All scalar columns inside.
// --------------------------------------------------------------------------

const TENANT_COLLECTION: EntityCollectionDefinition = {
  id: 'Tenant',
  domain: 'tenancy',
  keyField: 'tenantId',
  primarySource: { document: 'rentRoll', surface: 'resolvedContext',
                   extractionPath: 'tenancy.tenants' },
  fallbacks: [
    { document: 'leaseAbstract', surface: 'resolvedContext',
      extractionPath: 'tenancy.leases' },
  ],
  sortKey: { field: 'sqft', direction: 'desc' },
  maxItems: 10,
  missingBehavior: blank,
  fields: {
    name: {
      cellAddress: 'name',
      meaning: 'Tenant entity',
      domain: 'tenancy',
      primary: { document: 'rentRoll', surface: 'resolvedContext',
                 extractionPath: 'name' },
      fallbacks: [
        { document: 'leaseAbstract', surface: 'resolvedContext',
          extractionPath: 'tenantName' },
      ],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      resolutionState: 'unmapped',
    },
    sqft: {
      cellAddress: 'sqft',
      meaning: 'Tenant area (square feet)',
      domain: 'tenancy',
      primary: { document: 'rentRoll', surface: 'resolvedContext',
                 extractionPath: 'sqft' },
      fallbacks: [
        { document: 'leaseAbstract', surface: 'resolvedContext',
          extractionPath: 'leaseSquareFeet' },
      ],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      resolutionState: 'unmapped',
    },
    baseRentPSF: {
      cellAddress: 'baseRentPSF',
      meaning: 'Underwritten base rent PSF',
      domain: 'tenancy',
      primary: { document: 'rentRoll', surface: 'resolvedContext',
                 extractionPath: 'baseRentPSF' },
      fallbacks: [
        { document: 'manualInput', surface: 'resolvedContext',
          extractionPath: 'underwrittenRentPSF' },
      ],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      formatPolicy: { type: 'currency', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    aboveBelowMarketRent: {
      cellAddress: 'aboveBelowMarketRent',
      meaning: 'Mark-to-market rent delta',
      domain: 'tenancy',
      primary: { document: 'derived', surface: 'adjustedInputs',
                 extractionPath: 'mtmDelta' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      derivation: {
        formulaId: 'mtm.v1', formulaVersion: 1,
        requiredInputs: ['__rowSelf.baseRentPSF',
                         '__contextScalar.Market_Rent_PSF'],
        blankIfAnyMissing: true,
      },
      formatPolicy: { type: 'percent', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    pctUWGrossIncome: {
      cellAddress: 'pctUWGrossIncome',
      meaning: 'Tenant share of gross income',
      domain: 'tenancy',
      primary: { document: 'derived', surface: 'adjustedInputs',
                 extractionPath: 'pctUWGrossIncome' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      derivation: {
        formulaId: 'tenant.shareOfRevenue.v1', formulaVersion: 1,
        requiredInputs: ['__rowSelf.sqft', '__rowSelf.baseRentPSF',
                         '__contextScalar.Effective_Gross_Income'],
        blankIfAnyMissing: true,
      },
      formatPolicy: { type: 'percent', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    expirationDate: {
      cellAddress: 'expirationDate',
      meaning: 'Lease expiration',
      domain: 'tenancy',
      primary: { document: 'rentRoll', surface: 'resolvedContext',
                 extractionPath: 'expirationDate' },
      fallbacks: [
        { document: 'leaseAbstract', surface: 'resolvedContext',
          extractionPath: 'leaseExpirationDate' },
      ],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      formatPolicy: { type: 'date', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    upbPerSfAtExpiration: {
      cellAddress: 'upbPerSfAtExpiration',
      meaning: 'Debt per SF at lease expiration',
      domain: 'tenancy',
      primary: { document: 'derived', surface: 'adjustedInputs',
                 extractionPath: 'upbPerSfAtExp' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      derivation: {
        formulaId: 'tenant.upbPerSfAtExp.v1', formulaVersion: 1,
        requiredInputs: ['__rowSelf.sqft', '__rowSelf.expirationDate',
                         '__contextScalar.Maturity_Balance'],
        blankIfAnyMissing: true,
      },
      formatPolicy: { type: 'currency', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
  },
  suppressedFor: ['multifamily', 'hotel'],
  resolutionState: 'unmapped',
};

const LEASE_ROLLOVER_COLLECTION: EntityCollectionDefinition = {
  id: 'LeaseRollover',
  domain: 'tenancy',
  keyField: 'yearEnding',
  primarySource: { document: 'rentRoll', surface: 'resolvedContext',
                   extractionPath: 'tenancy.rolloverByYear' },
  fallbacks: [],
  sortKey: { field: 'yearEnding', direction: 'asc' },
  missingBehavior: blank,
  fields: {
    sfPercent: {
      cellAddress: 'sfPercent',
      meaning: 'Percent of NRA rolling',
      domain: 'tenancy',
      primary: { document: 'derived', surface: 'adjustedInputs',
                 extractionPath: 'sfPercent' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      derivation: {
        formulaId: 'rollover.sfPercent.v1', formulaVersion: 1,
        requiredInputs: ['__rowSelf.expiringSqft',
                         '__contextScalar.Net_Rentable_Area'],
        blankIfAnyMissing: true,
      },
      formatPolicy: { type: 'percent', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    grossIncome: {
      cellAddress: 'grossIncome',
      meaning: 'Revenue rolling in this year',
      domain: 'tenancy',
      primary: { document: 'rentRoll', surface: 'resolvedContext',
                 extractionPath: 'grossIncome' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      formatPolicy: { type: 'currency', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    expiringSqft: {
      cellAddress: 'expiringSqft',
      meaning: 'Sq ft expiring',
      domain: 'tenancy',
      primary: { document: 'rentRoll', surface: 'resolvedContext',
                 extractionPath: 'expiringSqft' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      resolutionState: 'unmapped',
    },
  },
  suppressedFor: ['multifamily', 'hotel'],
  resolutionState: 'unmapped',
};

const DEBT_TRANCHE_COLLECTION: EntityCollectionDefinition = {
  id: 'DebtTranche',
  domain: 'loan',
  keyField: 'trancheId',
  primarySource: { document: 'loanDocs', surface: 'resolvedContext',
                   extractionPath: 'loan.subDebtTranches' },
  fallbacks: [
    { document: 'capitalStackSchedule', surface: 'resolvedContext',
      extractionPath: 'loan.capitalStackTranches' },
  ],
  sortKey: { field: 'seniority', direction: 'asc' },
  missingBehavior: blank,
  fields: {
    type: {
      cellAddress: 'type',
      meaning: 'Tranche type (mezz / pref / B-note)',
      domain: 'loan',
      primary: { document: 'loanDocs', surface: 'resolvedContext',
                 extractionPath: 'type' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      resolutionState: 'unmapped',
    },
    amount: {
      cellAddress: 'amount',
      meaning: 'Tranche amount',
      domain: 'loan',
      primary: { document: 'loanDocs', surface: 'resolvedContext',
                 extractionPath: 'amount' },
      fallbacks: [
        { document: 'mezzNote', surface: 'resolvedContext',
          extractionPath: 'mezzNoteAmount' },
      ],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      formatPolicy: { type: 'currency', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    coupon: {
      cellAddress: 'coupon',
      meaning: 'Tranche coupon',
      domain: 'loan',
      primary: { document: 'loanDocs', surface: 'resolvedContext',
                 extractionPath: 'coupon' },
      fallbacks: [
        { document: 'mezzNote', surface: 'resolvedContext',
          extractionPath: 'mezzNoteCoupon' },
      ],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      formatPolicy: { type: 'rateSpread', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    debtService: {
      cellAddress: 'debtService',
      meaning: 'Tranche debt service',
      domain: 'loan',
      primary: { document: 'derived', surface: 'adjustedInputs',
                 extractionPath: 'debtService' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      derivation: {
        formulaId: 'tranche.debtService.v1', formulaVersion: 1,
        requiredInputs: ['__rowSelf.amount', '__rowSelf.coupon'],
        blankIfAnyMissing: true,
      },
      formatPolicy: { type: 'currency', preserveOriginal: true },
      resolutionState: 'unmapped',
    },
    ioPeriod: {
      cellAddress: 'ioPeriod',
      meaning: 'Tranche IO period',
      domain: 'loan',
      primary: { document: 'loanDocs', surface: 'resolvedContext',
                 extractionPath: 'ioPeriod' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      resolutionState: 'unmapped',
    },
    term: {
      cellAddress: 'term',
      meaning: 'Tranche term',
      domain: 'loan',
      primary: { document: 'loanDocs', surface: 'resolvedContext',
                 extractionPath: 'term' },
      fallbacks: [],
      missingBehavior: blank,
      conflictPolicy: PRESERVE_PRECEDENCE,
      resolutionState: 'unmapped',
    },
  },
  resolutionState: 'unmapped',
};

// --------------------------------------------------------------------------
// REGISTRY ASSEMBLY
// --------------------------------------------------------------------------

function indexFields(refs: readonly FieldRef[]): Record<string, FieldRef> {
  const out: Record<string, FieldRef> = {};
  for (const ref of refs) {
    if (out[ref.cellAddress]) {
      throw new Error(
        `[field-authority.registry] duplicate cellAddress: ${ref.cellAddress}`,
      );
    }
    out[ref.cellAddress] = ref;
  }
  return out;
}

const ALL_FIELDS: readonly FieldRef[] = [
  ...PROPERTY_FIELDS,
  ...DEBT_STACK_FIELDS,
  ...DEBT_PROVISIONS_FIELDS,
  ...SOURCES_AND_USES_FIELDS,
  ...COST_BASIS_FIELDS,
  ...CAP_RATE_FIELDS,
  ...NOI_FIELDS,
  ...VALUE_AT_CAP_FIELDS,
  ...PRO_FORMA_DERIVED_FIELDS,
  ...PARTY_AND_HISTORY_FIELDS,
];

export const PROPERTY_AND_LOAN_SUMMARY_REGISTRY: FieldAuthorityRegistry =
  Object.freeze({
    contractVersion: 7,
    fields: Object.freeze(indexFields(ALL_FIELDS)),
    collections: Object.freeze({
      Tenant:        TENANT_COLLECTION,
      LeaseRollover: LEASE_ROLLOVER_COLLECTION,
      DebtTranche:   DEBT_TRANCHE_COLLECTION,
    }),
  }) as FieldAuthorityRegistry;

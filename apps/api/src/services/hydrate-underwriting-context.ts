/**
 * Hydration layer: ExtractionResult + AdjustedInputs → UnderwritingContext.
 *
 * Single canonical mapping that unifies the legacy numeric pipeline
 * (AdjustedInputs, derived from analysis.uwModel) with the new structured
 * extraction surface (analysis.extractionResult.descriptors / structural /
 * comparablesLinkageRefs).
 *
 * Hard rules:
 *   - Pure deterministic transformation. No I/O, no clock reads, no
 *     randomness, no inference, no library / example matching.
 *   - Same (analysis, adjustedInputs, mode) → same output, byte-for-byte.
 *   - Precedence policy is EXPLICIT (see PRECEDENCE below). Never silent.
 *   - Schema and render are NOT touched by this module. Atomic blocks land
 *     on UnderwritingContext as optional state that v7+ schemas can
 *     consume; the v6 schema does not read them.
 *
 * PRECEDENCE between AdjustedInputs and extractionResult.structural:
 *   For any logical field both surfaces could carry, AdjustedInputs WINS
 *   when its value is a finite number. extractionResult.structural is the
 *   fallback when AdjustedInputs has null / undefined / NaN. Rationale:
 *   AdjustedInputs is the established judgment-engine output that already
 *   incorporates missing-data penalties and overrides; the new extraction
 *   surface is raw and unjudged. The fallback path lets fields the legacy
 *   pipeline does not carry (yearBuilt, units, etc.) come through from
 *   extraction without contaminating the canonical numeric values.
 *
 *   For fields with no AdjustedInputs equivalent (propertyName, address,
 *   yearBuilt, occupancy, borrowerName, sponsorName, comparablesLinkageRefs),
 *   the property atoms layer prefers analysis.propertyMetadata (Batch 1H
 *   AI extractor) as PRIMARY and falls back to extractionResult.descriptors
 *   / structural. See buildPropertyAtoms below. Borrower/sponsor and the
 *   comparables refs are extractionResult-only (no Batch 1H equivalent).
 *
 *   AdjustedInputs is NOT BYPASSED — the route still composes it and feeds
 *   it to the schema layer separately. The hydrator only reads
 *   AdjustedInputs as a precedence input for the loan atoms; it does not
 *   modify or replace it.
 */
import type {
  AdjustedInputs,
  Analysis,
  AssetType,
  PropertyLoanSummary,
  ConclusionAndEscrows,
  PropertyDetailNarrative,
  OperatingProFormaNarrative,
  StressScenarioNarrative,
  ThirdPartyReports,
  BorrowerProfile,
  MarketNarrative,
  SiteInspection,
  ComparablesNarrative,
  RollUpAggregation,
  UnderwritingContext,
  UnderwritingLoanAtoms,
  UnderwritingMode,
  UnderwritingPartyAtoms,
  UnderwritingPropertyAtoms,
} from '@cre/shared';
import type {
  FieldAuthorityRegistry,
  ResolvedRegistry,
} from './field-authority.types.js';
import {
  resolveFieldAuthorityRegistry,
  type ResolverSources,
} from './field-authority.resolver.js';

export interface HydrationSources {
  analysis: Analysis;
  adjustedInputs: AdjustedInputs;
  mode: UnderwritingMode;
  /**
   * Optional field-authority registry. When supplied, the hydrator runs the
   * registry resolver alongside the existing atomic-block flow and surfaces
   * its events on the returned HydrationOutcome. Existing context shape is
   * preserved — registry output does NOT overwrite atomic blocks today;
   * promotion happens cell-by-cell as render-schema entries land.
   */
  registry?: FieldAuthorityRegistry;
  /** Asset class for asset-aware overrides. Required when `registry` is set. */
  assetClass?: AssetType;
}

export interface HydrationOutcome {
  context: UnderwritingContext;
  /** Present iff a registry was supplied. Caller forwards events to the
   *  observability service; the hydrator never logs. */
  resolvedRegistry?: ResolvedRegistry;
}

/**
 * Returns the first finite number from the candidate list. Skips null,
 * undefined, NaN. Does NOT skip 0 (a legitimate value, e.g. ioMonths=0).
 */
function pickFirstFiniteNumber(candidates: Array<number | null | undefined>): number | null {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Returns the first non-null/non-empty string from the candidate list.
 */
function pickFirstString(candidates: Array<string | null | undefined>): string | null {
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Returns the first finite number from the candidate list.
 */
function pickFirstNumber(candidates: Array<number | null | undefined>): number | null {
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

// --- Atomic block builders -------------------------------------------------

// Property atoms precedence (Batch 1H integration):
//   analysis.propertyMetadata  (PRIMARY — clean ASR-AI extractor, Batch 1H)
//   extractionResult.descriptors / structural  (FALLBACK — older extractor
//     that can return template-resident placeholder text like "Management"
//     from the BP Spiral E3 cell; only trustworthy when no Batch 1H value)
// Rationale: propertyMetadata is sourced via a dedicated AI call against
// the source ASR text. The descriptors extractor occasionally captures
// values that originate from the template artifact itself rather than the
// source document — making it strictly weaker. Prefer the new source when
// present; fall back to descriptors so analyses created before Batch 1H
// continue to populate.
function buildPropertyAtoms(analysis: Analysis): UnderwritingPropertyAtoms {
  const pm   = analysis.propertyMetadata;
  const desc = analysis.extractionResult?.descriptors;
  const stru = analysis.extractionResult?.structural;
  return {
    name:              pickFirstString([pm?.propertyName,     desc?.propertyName.value]),
    street:            pickFirstString([pm?.address,          desc?.street.value]),
    city:              pickFirstString([pm?.city,             desc?.city.value]),
    state:             pickFirstString([pm?.state,            desc?.state.value]),
    zip:               pickFirstString([pm?.zip,              desc?.zip.value]),
    // county and ownershipInterest have no descriptor / structural source;
    // propertyMetadata is the only origin today.
    county:            pickFirstString([pm?.county]),
    type:              pickFirstString([pm?.propertySubtype,  desc?.propertyType.value]),
    yearBuilt:         pickFirstNumber([pm?.yearBuilt,        stru?.yearBuilt.value]),
    totalSquareFeet:   pickFirstNumber([pm?.totalSquareFeet,  stru?.totalSquareFeet.value]),
    units:             stru?.units.value ?? null,
    occupancy:         pickFirstNumber([pm?.occupancyPhysical, stru?.occupancy.value]),
    ownershipInterest: pickFirstString([pm?.ownershipInterest]),
  };
}

function buildLoanAtoms(
  analysis: Analysis,
  adjustedInputs: AdjustedInputs,
): UnderwritingLoanAtoms {
  const stru = analysis.extractionResult?.structural;
  // Per the v7 field-authority migration policy:
  //   termMonths         — extraction PRIMARY, AdjustedInputs FALLBACK ALLOWED
  //   amortizationMonths — extraction ONLY, NO fallback
  //   ioMonths           — extraction ONLY, NO fallback
  // The schema layer reads these single-source values without any fallback
  // logic of its own — the precedence chain (or its absence) lives here.
  return {
    termMonths: pickFirstFiniteNumber([
      stru?.loanTermMonths.value,        // resolvedContext-derived primary
      adjustedInputs.loan.termMonths,    // explicit fallback (term only)
    ]),
    amortizationMonths: pickFirstFiniteNumber([
      stru?.amortizationMonths.value,    // extraction-only, no fallback
    ]),
    ioMonths: pickFirstFiniteNumber([
      stru?.ioMonths.value,              // extraction-only, no fallback
    ]),
  };
}

function buildPartyAtoms(analysis: Analysis): UnderwritingPartyAtoms {
  const desc = analysis.extractionResult?.descriptors;
  return {
    borrowerName: pickFirstString([desc?.borrowerName.value]),
    sponsorName:  pickFirstString([desc?.sponsorName.value]),
  };
}

function buildComparablesLinkageRefs(analysis: Analysis): string[] {
  return [...(analysis.extractionResult?.comparablesLinkageRefs ?? [])];
}

// --- Narrative section defaults --------------------------------------------
// All narrative sections are shipped null at this stage. The resolver
// translates null → DATA_NOT_PROVIDED. A future producer (or the next
// hydration phase) may compose narrative strings from the atomic blocks.

function emptyPropertyLoanSummary(): PropertyLoanSummary {
  return {
    propertyDescription:        null,
    loanTermsSummary:           null,
    sourcesAndUses:             null,
    ownershipSummary:           null,
    equityAndCashFlowAnalysis:  null,
    historicalOwnership:        null,
    annualCashFlowsCommentary:  null,
    generalAssetComments:       null,
    tenancySummaryCommentary:   null,
  };
}
function emptyConclusionAndEscrows(): ConclusionAndEscrows {
  return {
    loanSummary:             null,
    strengths:               [],
    weaknesses:              [],
    mitigants:               [],
    escrowSummary:           null,
    loanStructureCommentary: null,
  };
}
function emptyPropertyDetail(): PropertyDetailNarrative {
  return { propertyInformation: null, propertyRights: null, management: null, demographics: null, comments: null };
}
function emptyOperatingProForma(): OperatingProFormaNarrative {
  return { historicalOperatingCommentary: null, year1ProFormaCommentary: null, tenYearProFormaCommentary: null };
}
function emptyStress(): StressScenarioNarrative {
  return { stressMethodology: null, revenueDownsideCommentary: null, expenseUpsideCommentary: null, noiAndDscrCommentary: null };
}
function emptyTPR(): ThirdPartyReports {
  return { appraisalSummary: null, environmentalSummary: null, propertyConditionSummary: null };
}
function emptyBorrower(): BorrowerProfile {
  return { borrowerProfile: null, sponsorshipStrength: null };
}
function emptyMarket(): MarketNarrative {
  return { marketOverview: null, submarketTrends: null };
}
function defaultSiteInspection(): SiteInspection {
  // Per BP Spire spec, this tab is structurally inapplicable today.
  return { inspectionNotes: 'NOT_AVAILABLE', photos: 'NOT_AVAILABLE', maps: 'NOT_AVAILABLE' };
}
function defaultComparables(): ComparablesNarrative {
  return { leaseComps: 'REQUIRES_EXTERNAL_DATA', salesComps: 'REQUIRES_EXTERNAL_DATA', cmbsComps: 'REQUIRES_EXTERNAL_DATA' };
}

function buildRollUpStub(): RollUpAggregation {
  // Single-loan deals export with rollUpAggregation === null. Roll-up mode
  // requires a populated block; until a portfolio aggregator service lands,
  // ship a deterministic placeholder so the render-service invariant
  // (rollUpAggregation iff mode === 'roll_up') holds.
  return {
    loanCount: 1,
    aggregationMethodology: 'DATA_NOT_PROVIDED',
    normalizationCommentary: 'DATA_NOT_PROVIDED',
    constituentLoanIds: [],
  };
}

// --- Public entry point ----------------------------------------------------

/**
 * Produce the canonical UnderwritingContext for a deal. Pure deterministic
 * transformation over the three input surfaces (analysis, adjustedInputs,
 * mode). No I/O. No library lookups. No inference.
 */
export function hydrateUnderwritingContext(
  s: HydrationSources,
): UnderwritingContext {
  return {
    underwritingMode: s.mode,

    // Existing narrative sections — resolver translates null → sentinel.
    propertyLoanSummary:  emptyPropertyLoanSummary(),
    conclusionAndEscrows: emptyConclusionAndEscrows(),
    propertyDetail:       emptyPropertyDetail(),
    operatingProForma:    emptyOperatingProForma(),
    stressScenario:       emptyStress(),
    thirdPartyReports:    emptyTPR(),
    borrower:             emptyBorrower(),
    market:               emptyMarket(),
    siteInspection:       defaultSiteInspection(),
    comparables:          defaultComparables(),

    rollUpAggregation: s.mode === 'roll_up' ? buildRollUpStub() : null,

    // NEW atomic blocks — populated from extractionResult + AdjustedInputs.
    property:               buildPropertyAtoms(s.analysis),
    loan:                   buildLoanAtoms(s.analysis, s.adjustedInputs),
    parties:                buildPartyAtoms(s.analysis),
    comparablesLinkageRefs: buildComparablesLinkageRefs(s.analysis),
  };
}

/**
 * Combined entry point: runs the existing atomic-block hydration AND, when
 * a field-authority registry is supplied, runs the two-phase registry
 * resolver. Registry output is returned alongside the context — caller
 * decides what to do with the events (typically: forward to the
 * observability service).
 *
 * The registry path is purely additive: existing UnderwritingContext shape
 * is unchanged. Cells with resolutionState === 'mapped' or 'derived'
 * produce real values in `resolvedRegistry.fields`; 'unmapped' cells are
 * blank with AWAITING_CONTEXT_SHAPE events.
 */
export function hydrateWithRegistry(
  s: HydrationSources,
): HydrationOutcome {
  const context = hydrateUnderwritingContext(s);
  if (!s.registry) return { context };

  if (!s.assetClass) {
    // Caller gave us a registry but no asset class — without an assetClass
    // we cannot apply suppressedFor / assetOverrides correctly. Return the
    // context without resolving rather than guessing.
    return { context };
  }

  // Build the registry resolver's source bag. The 'context' surface mirrors
  // the eventual UnderwritingContext shape — most paths declared on FieldRef
  // bindings remain `unmapped` today, so the source bag is sparsely populated
  // from the existing atomic blocks.
  const resolverSources: ResolverSources = {
    context: contextSourceBag(context),
    adjustedInputs: s.adjustedInputs,
    assetClass: s.assetClass,
    mode: s.mode,
  };

  const { resolved } = resolveFieldAuthorityRegistry(s.registry, resolverSources);
  return { context, resolvedRegistry: resolved };
}

/**
 * Adapter from the existing UnderwritingContext shape (3 atomic blocks +
 * narratives) into the flat dotted-path bag the registry resolver reads.
 *
 * Only the paths that the registry's currently-`mapped` entries reference
 * are populated. All other extraction paths declared by `unmapped` entries
 * resolve to undefined → no candidate → AWAITING_CONTEXT_SHAPE event.
 */
function contextSourceBag(ctx: UnderwritingContext): Record<string, unknown> {
  const bag: Record<string, unknown> = {};

  if (ctx.property) {
    bag.property = {
      name:              ctx.property.name,
      street:            ctx.property.street,
      city:              ctx.property.city,
      state:             ctx.property.state,
      zip:               ctx.property.zip,
      county:            ctx.property.county,
      type:              ctx.property.type,
      yearBuilt:         ctx.property.yearBuilt,
      totalSquareFeet:   ctx.property.totalSquareFeet,
      occupancy:         ctx.property.occupancy,
      ownershipInterest: ctx.property.ownershipInterest,
    };
  }
  if (ctx.loan) {
    bag.loan = {
      termMonths:         ctx.loan.termMonths,
      amortizationMonths: ctx.loan.amortizationMonths,
      ioMonths:           ctx.loan.ioMonths,
    };
  }
  if (ctx.parties) {
    bag.parties = {
      borrowerName: ctx.parties.borrowerName,
      sponsorName:  ctx.parties.sponsorName,
    };
  }
  return bag;
}

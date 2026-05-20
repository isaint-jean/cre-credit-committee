/**
 * Field Authority — Type Definitions
 *
 * Pure type module. NO logic, NO runtime values except:
 *   - DOMAIN_TO_CONTEXT_GROUP (locked spec table)
 *   - RESOLUTION_POLICY        (locked spec behavior table)
 *   - PRECEDENCE_ORDER         (locked spec attribution-only ranking)
 *
 * ARCHITECTURAL INVARIANTS (locked spec):
 *   - FieldAuthority is a SCALAR materialized value: { value, provenance, valuationContext? }.
 *     It carries no list semantics, no indexing, no collection awareness.
 *   - Lists are EntityCollections in the registry layer ONLY. They never appear
 *     on FieldAuthority or on UnderwritingContext.
 *   - Resolution state and behavior are SEPARATED:
 *       ResolutionState   = pure truth tag.
 *       RESOLUTION_POLICY = behavior table consulted by the resolver.
 *     The resolver never branches on a state literal; it looks up policy.
 *   - FieldCandidate.source is determined by FieldRef.document (never by surface):
 *       'asr'                  → 'ASR'
 *       'manualInput'          → 'manual'
 *       (adjustedInputs origin)→ 'adjustedInput'
 *       (Phase 2 derivation)   → 'derived'
 *       anything else          → 'fallback'
 *   - Conflict (≥2 distinct non-null candidate values) ALWAYS yields blank +
 *     SOURCE_CONFLICT, irrespective of conflictPolicy. PRECEDENCE_ORDER is
 *     attribution-only (which source to credit when candidates agree).
 */
import type { AssetType, UnderwritingMode } from '@cre/shared';
import type { SourceSurface } from './render-schema.js';

// --------------------------------------------------------------------------
// 1. PRIMITIVES
// --------------------------------------------------------------------------

/** Scalar value materialized into context. Mirrors render contract CellValue. */
export type ResolvedCellValue = number | string | boolean | null;

/** Asset class enum used by registry overrides. Matches existing AssetType. */
export type AssetClass = AssetType;

/** Locked enumeration of source documents that may appear on a SourceBinding. */
export type SourceDocument =
  | 'asr'
  | 'rentRoll'
  | 't12'
  | 'historicalOps'
  | 'loanDocs'
  | 'commitment'
  | 'servicerStatement'
  | 'closingStatement'
  | 'psa'
  | 'intercreditor'
  | 'mezzNote'
  | 'capitalStackSchedule'
  | 'rateCapNote'
  | 'organizationalDocs'
  | 'pca'
  | 'survey'
  | 'leaseAbstract'
  | 'externalCompsDb'
  | 'publicRecordExtract'
  | 'sponsorBudget'
  | 'equityContributionSchedule'
  | 'uwMemo'
  | 'manualInput'
  | 'derived';

/** Locked valuation context discriminator for cap-rate / NOI / value cells. */
export type ValuationContext = 'asIs' | 'stabilized' | 'exit' | 'market';

/** Locked registry semantic-grouping enumeration. NOT context shape. */
export type RegistryDomain =
  | 'property'
  | 'loan'
  | 'market'
  | 'valuation'
  | 'tenancy'
  | 'sourcesAndUses'
  | 'history';

/** UnderwritingContext top-level groups. Locked at three. */
export type ContextGroup = 'property' | 'loan' | 'market';

/**
 * Locked domain → context-group mapping. Resolver consults this table when
 * placing materialized FieldAuthorities; FieldRef may override per-cell via
 * `targetContextGroup`.
 */
export const DOMAIN_TO_CONTEXT_GROUP = {
  property:       'property',
  tenancy:        'property',
  history:        'property',
  loan:           'loan',
  sourcesAndUses: 'loan',
  market:         'market',
  valuation:      'property',
} as const satisfies Record<RegistryDomain, ContextGroup>;

// --------------------------------------------------------------------------
// 2. RESOLUTION STATE + POLICY (FIX 1: state vs behavior)
// --------------------------------------------------------------------------

/**
 * Pure truth tag describing where a registry entry stands in the
 * extraction → context migration. Carries NO behavior. The resolver consults
 * RESOLUTION_POLICY (below) to decide what to do.
 */
export type ResolutionState =
  | 'unmapped'    // no extraction path on UnderwritingContext yet
  | 'mapped'     // primary/fallback paths exist; hydration active
  | 'derived'    // derivation rule active
  | 'deprecated';// scheduled for removal

/**
 * Behavior table. The resolver looks up the policy by ResolutionState — it
 * MUST NOT branch on state literals. Adding a new state requires adding an
 * entry here.
 */
export const RESOLUTION_POLICY = {
  unmapped: {
    emitEvent: 'AWAITING_CONTEXT_SHAPE',
    writeBehavior: 'blank',
  },
  mapped: {
    emitEvent: null,
    writeBehavior: 'value',
  },
  derived: {
    emitEvent: null,
    writeBehavior: 'value',
  },
  deprecated: {
    emitEvent: 'DEPRECATED_FIELD_USED',
    writeBehavior: 'value',
  },
} as const satisfies Record<
  ResolutionState,
  { emitEvent: string | null; writeBehavior: 'blank' | 'value' }
>;

// --------------------------------------------------------------------------
// 3. FIELD CANDIDATE (FIX 2: explicit provenance source on every candidate)
// --------------------------------------------------------------------------

/**
 * Adjudication tier for a candidate value. Distinct from SourceDocument:
 * SourceDocument names WHICH document; FieldCandidateSource names the TIER
 * used for adjudication and provenance attribution.
 */
export type FieldCandidateSource =
  | 'ASR'
  | 'adjustedInput'
  | 'manual'
  | 'fallback'
  | 'derived';

/** Coarse candidate produced during Phase 1 expansion; not yet adjudicated. */
export interface FieldCandidate {
  value: unknown;
  source: FieldCandidateSource;
  timestamp?: string;
}

/**
 * Locked attribution-only precedence ranking. Used to pick which source to
 * credit on Provenance when candidates agree (no conflict). NEVER used to
 * resolve conflicts — those always blank under both conflict policies.
 *
 * Note: 'derived' is intentionally absent from this list — derived values
 * never compete with sourced candidates; Phase 2 produces them after
 * adjudication.
 */
export const PRECEDENCE_ORDER: readonly FieldCandidateSource[] = [
  'ASR',
  'manual',
  'adjustedInput',
  'fallback',
] as const;

// --------------------------------------------------------------------------
// 4. PROVENANCE + MATERIALIZED FIELD AUTHORITY
// --------------------------------------------------------------------------

export interface Provenance {
  document: SourceDocument;
  surface: SourceSurface;
  extractionPath: string;
  confidence?: number;
  isFallback: boolean;
  /** Attribution tier credited for this value (per PRECEDENCE_ORDER). */
  candidateSource: FieldCandidateSource;
  /** Sources read but rejected (e.g. below confidence floor, or lower tier). */
  rejectedCandidates?: readonly FieldCandidateSource[];
}

/**
 * Materialized scalar value placed into UnderwritingContext.
 *
 * INVARIANT: scalar only. No arrays, no objects beyond Provenance, no
 * indexing semantics. Lists are flattened by the resolver into individually
 * keyed FieldAuthority entries before they reach context.
 */
export interface FieldAuthority {
  value: ResolvedCellValue;
  provenance: Provenance;
  valuationContext?: ValuationContext | null;
}

// --------------------------------------------------------------------------
// 5. SOURCE BINDINGS + REGISTRY DECLARATIONS
// --------------------------------------------------------------------------

export interface SourceBinding {
  document: SourceDocument;
  surface: SourceSurface;
  /**
   * Dotted path into the eventual UnderwritingContext (or AdjustedInputs)
   * shape. For `unmapped` entries this declares the TARGET path that does
   * not yet exist on the context.
   */
  extractionPath: string;
  /** Below-floor candidates are dropped during Phase 1, not adjudicated. */
  confidenceFloor?: number;
}

export type MissingBehavior =
  | { kind: 'blank' }
  | { kind: 'blankWithWarning'; warningCode: string }
  | { kind: 'blankWithRedFlag'; redFlagCode: string }
  | { kind: 'excludeFromDerivation'; downstreamFields: readonly string[] };

export type ConflictPolicy =
  | { kind: 'preserveAllCandidates' }
  | { kind: 'documentPrecedence' }
  | { kind: 'requireManualResolution'; resolutionUiKey: string };

export interface DerivationRule {
  formulaId: string;
  formulaVersion: number;
  /** Every input must resolve to a non-null FieldAuthority value. */
  requiredInputs: readonly string[];
  /**
   * Locked invariant: any missing input → derived cell is blank. No
   * optionalInputs, no defaulting, no probabilistic fill.
   */
  blankIfAnyMissing: true;
}

export type ValidationSeverity = 'info' | 'warn' | 'fail';
export type ValidationMode = 'soft' | 'hard';

export interface ValidationRule {
  id: string;
  severity: ValidationSeverity;
  /** Default 'soft'. Hard mode is opt-in per render via a runtime flag. */
  mode: ValidationMode;
  kind:
    | 'mustMatch'
    | 'mustSumTo'
    | 'mustBeWithinRange'
    | 'mustBeBoolean'
    | 'mustHaveEffectiveDate'
    | 'mustPreserveStructure';
  partner?: string;
  rangeBound?: { min?: number; max?: number };
  notes?: string;
}

export interface FormatPolicy {
  type:
    | 'percent'
    | 'date'
    | 'currency'
    | 'rateSpread'
    | 'dualYear'
    | 'debtDescription';
  preserveOriginal: boolean;
}

/**
 * Per-cell registry declaration. Pure data.
 *
 * `assetOverrides`: a per-asset replacement is a FULL FieldRef (no partial
 * merges). Suppression for an asset class is expressed via the registry's
 * `suppressedFor: AssetClass[]` field below — assetOverrides can ONLY
 * substitute a different FieldRef, never delete one.
 */
export interface FieldRef {
  cellAddress: string;
  meaning: string;
  domain: RegistryDomain;
  /** Override for default DOMAIN_TO_CONTEXT_GROUP placement. */
  targetContextGroup?: ContextGroup;
  primary: SourceBinding;
  fallbacks: readonly SourceBinding[];
  missingBehavior: MissingBehavior;
  conflictPolicy: ConflictPolicy;
  derivation?: DerivationRule;
  validation?: readonly ValidationRule[];
  formatPolicy?: FormatPolicy;
  valuationContext?: ValuationContext | null;
  modeOverrides?: Partial<Record<UnderwritingMode, Partial<FieldRef>>>;
  assetOverrides?: Partial<Record<AssetClass, FieldRef>>;
  /** Asset classes for which this entry is suppressed (no materialization). */
  suppressedFor?: readonly AssetClass[];
  resolutionState: ResolutionState;
}

export interface EntityCollectionDefinition {
  id: string;
  domain: RegistryDomain;
  targetContextGroup?: ContextGroup;
  /** REQUIRED stable identity field on each instance. Indexing key. */
  keyField: string;
  primarySource: SourceBinding;
  fallbacks: readonly SourceBinding[];
  maxItems?: number;
  minItems?: number;
  sortKey?: { field: string; direction: 'asc' | 'desc' };
  /** Each column entry's cellAddress is the SUFFIX appended after the key. */
  fields: Record<string, FieldRef>;
  missingBehavior: MissingBehavior;
  assetOverrides?: Partial<Record<AssetClass, EntityCollectionDefinition>>;
  suppressedFor?: readonly AssetClass[];
  resolutionState: ResolutionState;
}

export interface FieldAuthorityRegistry {
  contractVersion: number;
  fields: Record<string, FieldRef>;
  collections: Record<string, EntityCollectionDefinition>;
}

// --------------------------------------------------------------------------
// 6. PHASE 1 OUTPUT (ExpandedEntityGraph) + PHASE 2 OUTPUT (ResolvedRegistry)
// --------------------------------------------------------------------------

/** Pre-adjudication slot; carries every candidate read from sources. */
export interface ScalarSlot {
  fieldRef: FieldRef;
  candidates: readonly FieldCandidate[];
  domain: RegistryDomain;
  resolutionState: ResolutionState;
}

export interface ExpandedRow {
  /** Stable key drawn from definition.keyField on the row instance. */
  key: string;
  /** Composed prefix used for materialized cellAddresses, e.g. 'Tenant_T1'. */
  pathPrefix: string;
  rowFields: Record<string, ScalarSlot>;
}

export interface ExpandedCollection {
  definition: EntityCollectionDefinition;
  rows: readonly ExpandedRow[];
}

export interface ExpandedEntityGraph {
  scalars: Record<string, ScalarSlot>;
  collections: Record<string, ExpandedCollection>;
  registryHash: string;
  expansionEvents: readonly FieldAuthorityEvent[];
}

/** Phase 2 output. Resolver-owned; observability service receives via param. */
export interface ResolvedRegistry {
  /**
   * Materialized scalar entries. Keys include both top-level cell addresses
   * AND collection-expanded addresses (e.g. 'Tenant_T1_name').
   */
  fields: Record<string, FieldAuthority>;
  events: readonly FieldAuthorityEvent[];
  registryHash: string;
  collectionExpansionCount: number;
  derivationCount: number;
}

// --------------------------------------------------------------------------
// 7. EVENT TYPES (consumed by underwriting-observability.service.ts)
// --------------------------------------------------------------------------

export type FieldAuthorityEvent =
  | {
      kind: 'MISSING_SOURCE';
      cellAddress: string;
      attempted: readonly SourceDocument[];
      severity: 'blank' | 'warning' | 'redFlag';
    }
  | {
      kind: 'SOURCE_CONFLICT';
      cellAddress: string;
      candidates: ReadonlyArray<{
        source: FieldCandidateSource;
        document: SourceDocument;
        value: unknown;
        confidence?: number;
      }>;
    }
  | {
      kind: 'DEPENDENCY_BLANK';
      cellAddress: string;
      formulaId: string;
      missingInputs: readonly string[];
    }
  | {
      kind: 'FALLBACK_USED';
      cellAddress: string;
      primary: SourceDocument;
      used: SourceDocument;
      candidateTier: FieldCandidateSource;
    }
  | {
      kind: 'VALIDATION_FAIL';
      cellAddress: string;
      ruleId: string;
      severity: ValidationSeverity;
      mode: ValidationMode;
      detail: string;
    }
  | {
      kind: 'AWAITING_CONTEXT_SHAPE';
      cellAddress: string;
      declaredPath: string;
    }
  | {
      kind: 'DEPRECATED_FIELD_USED';
      cellAddress: string;
    };

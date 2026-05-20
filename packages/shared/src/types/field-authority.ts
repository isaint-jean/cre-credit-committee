/**
 * Field Authority — read-only type re-exports for cross-package consumption.
 *
 * The full type module lives in apps/api/src/services/field-authority.types.ts.
 * This file mirrors only the materialized-runtime types that the web app
 * needs to inspect (provenance UI, source-attribution badges, etc.) — never
 * the registry or resolver shapes, which are server-only.
 */

export type FieldCandidateSource =
  | 'ASR'
  | 'adjustedInput'
  | 'manual'
  | 'fallback'
  | 'derived';

export type ValuationContext = 'asIs' | 'stabilized' | 'exit' | 'market';

export type ResolutionState =
  | 'unmapped'
  | 'mapped'
  | 'derived'
  | 'deprecated';

export type RegistryDomain =
  | 'property'
  | 'loan'
  | 'market'
  | 'valuation'
  | 'tenancy'
  | 'sourcesAndUses'
  | 'history';

export type ContextGroup = 'property' | 'loan' | 'market';

export type FieldAuthorityCellValue = number | string | boolean | null;

export interface FieldAuthorityProvenance {
  document: string;
  surface: string;
  extractionPath: string;
  confidence?: number;
  isFallback: boolean;
  candidateSource: FieldCandidateSource;
  rejectedCandidates?: readonly FieldCandidateSource[];
}

export interface FieldAuthority {
  value: FieldAuthorityCellValue;
  provenance: FieldAuthorityProvenance;
  valuationContext?: ValuationContext | null;
}

export type FieldAuthorityEventKind =
  | 'MISSING_SOURCE'
  | 'SOURCE_CONFLICT'
  | 'DEPENDENCY_BLANK'
  | 'FALLBACK_USED'
  | 'VALIDATION_FAIL'
  | 'AWAITING_CONTEXT_SHAPE'
  | 'DEPRECATED_FIELD_USED';

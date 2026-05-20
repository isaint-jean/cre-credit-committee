/**
 * Underwriting Observability — pure read-only instrumentation.
 *
 * Measures per-render:
 *   - field source attribution (adjustedInputs / resolvedContext / meta)
 *   - fallback frequency (was a value sourced via the hydrator's
 *     extraction-then-AdjustedInputs precedence chain?)
 *   - extraction completeness per block
 *   - legacy-dependency ratio (how much of v7 still rides on AdjustedInputs)
 *
 * HARD GUARDRAILS:
 *   - MUST NOT mutate any input (RenderInput, AdjustedInputs,
 *     UnderwritingContext, ResolvedUnderwritingContext, RenderPayload,
 *     CellBindings).
 *   - MUST NOT block the export. Every public entry point swallows its own
 *     errors and returns null on failure. Callers wrap its invocation in
 *     try/catch as belt-and-suspenders, but the service itself never
 *     re-throws.
 *   - MUST NOT introduce inference / heuristics / library lookups. All
 *     measurements are direct projections of declared schema sources +
 *     resolvedContext / extractionResult literal values.
 *   - MUST NOT depend on schema, render, resolver, or hydration internals
 *     in a way that would couple their behavior to the metric shape. The
 *     service reads the published `__sources` tags via
 *     getSchemaSourcesByAddress(); it does not re-implement schema rules.
 */
import type {
  AdjustedInputs,
  Analysis,
  AssetType,
  CellBindings,
  ResolvedUnderwritingContext,
  StructuralVariantKey,
  UnderwritingMode,
} from '@cre/shared';
import {
  getSchemaSourcesByAddress,
  type SourceSurface,
} from './render-schema.js';
import type {
  FieldAuthorityEvent,
  ResolvedRegistry,
} from './field-authority.types.js';

// --- Public payload type ---------------------------------------------------

export interface FieldSourceAttribution {
  /** Schema cell address: "Sheet!Range". */
  field: string;
  /** Declared source surface for this cell at the active contract version. */
  source: SourceSurface;
  /**
   * True iff the value reaching this cell rode the hydrator's fallback
   * chain (extraction missing → AdjustedInputs). False otherwise — false
   * for cells whose source surface is AdjustedInputs directly, false for
   * extraction-only cells, false for resolvedContext cells whose
   * extraction value was present.
   */
  fallback: boolean;
}

export interface UnderwritingObservabilityEvent {
  analysisId: string;
  contractVersion: number;
  assetClass: AssetType;
  variantKey: StructuralVariantKey;
  mode: UnderwritingMode;
  generatedAt: string;
  metrics: {
    totalFields: number;
    /** Cells whose source surface is `'resolvedContext'`. */
    resolvedContextHits: number;
    /** Cells whose source surface is `'adjustedInputs'`. */
    adjustedInputsHits: number;
    /** Cells whose source surface is `'meta'` (route-controlled). */
    metaHits: number;
    /** Hydrator-level fallback events (currently: term loan only). */
    fallbackEventsCount: number;
    /** fallbackEventsCount / totalFields. 0..1. */
    fallbackPressureRatio: number;
    /** adjustedInputsHits / totalFields. 0..1. */
    legacyDependencyRatio: number;
    completeness: {
      property: number;
      loan:     number;
      party:    number;
      comps:    number;
    };
    /** Registry roll-ups (present iff a ResolvedRegistry was supplied). */
    registryHash?: string;
    collectionExpansionCount?: number;
    derivationCount?: number;
    /** Per-event-kind tallies from the registry resolver. */
    fieldAuthorityEventCounts?: {
      MISSING_SOURCE:          number;
      SOURCE_CONFLICT:         number;
      DEPENDENCY_BLANK:        number;
      FALLBACK_USED:           number;
      VALIDATION_FAIL:         number;
      AWAITING_CONTEXT_SHAPE:  number;
      DEPRECATED_FIELD_USED:   number;
    };
  };
  fieldMap: FieldSourceAttribution[];
  /** Raw registry events (when a ResolvedRegistry was supplied). */
  fieldAuthorityEvents?: readonly FieldAuthorityEvent[];
}

// --- Inputs to the observer (no mutation) ----------------------------------

export interface ObservabilityInputs {
  analysisId: string;
  analysis: Analysis;
  adjustedInputs: AdjustedInputs;
  resolvedContext: ResolvedUnderwritingContext;
  cellBindings: CellBindings;
  contractVersion: number;
  assetClass: AssetType;
  variantKey: StructuralVariantKey;
  mode: UnderwritingMode;
  generatedAt: string;
  /**
   * Optional output of the field-authority resolver. When supplied, the
   * observability event is enriched with registry-side roll-ups and the
   * raw event stream. The observability service NEVER computes events
   * itself — it only aggregates and emits.
   */
  resolvedRegistry?: ResolvedRegistry;
}

// --- Sentinel values (mirror render-output-scrubber, kept inline to avoid coupling) ---
const SENTINELS = new Set<string>([
  'DATA_NOT_PROVIDED',
  'NOT_AVAILABLE',
  'REQUIRES_EXTERNAL_DATA',
]);

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') {
    if (v.trim() === '') return false;
    if (SENTINELS.has(v)) return false;
    return true;
  }
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  return false;
}

// --- Per-block completeness ------------------------------------------------

function propertyCompleteness(rc: ResolvedUnderwritingContext): number {
  const fields = [
    rc.property.name, rc.property.street, rc.property.city, rc.property.state,
    rc.property.zip, rc.property.type, rc.property.yearBuilt,
    rc.property.totalSquareFeet, rc.property.units, rc.property.occupancy,
  ];
  return fields.filter(isPresent).length / fields.length;
}

function loanCompleteness(rc: ResolvedUnderwritingContext): number {
  const fields = [
    rc.loan.termMonths, rc.loan.amortizationMonths, rc.loan.ioMonths,
  ];
  return fields.filter(isPresent).length / fields.length;
}

function partyCompleteness(rc: ResolvedUnderwritingContext): number {
  const fields = [rc.parties.borrowerName, rc.parties.sponsorName];
  return fields.filter(isPresent).length / fields.length;
}

/**
 * Comps completeness: spec rule — empty array IS valid for compsLinkageRefs.
 * The resolver projects the array as joined string ('' for empty). For
 * completeness scoring we treat empty-string as "missing extraction
 * signal" since no comp refs were found in the source documents. A
 * non-empty joined string (any references at all) → 1.0.
 */
function compsCompleteness(rc: ResolvedUnderwritingContext): number {
  return isPresent(rc.comparablesLinkageRefs) ? 1 : 0;
}

// --- Fallback detection ---------------------------------------------------
// The schema layer is single-sourced — fallback events live in the
// hydrator. Only the term-loan field has a fallback chain
// (extractionResult.structural.loanTermMonths → adjustedInputs.loan.termMonths).
// We detect a fallback by: extraction structural was null/missing AND the
// resolved loan termMonths is non-null AND adjustedInputs.loan.termMonths
// is non-null. That triple uniquely identifies "hydrator filled the value
// from AdjustedInputs because extraction missed it".

const TERM_CELL_ADDRESSES: ReadonlySet<string> = new Set([
  'Property & Loan Summary!Balloon_Term',
]);

function isTermFallbackInUse(
  analysis: Analysis,
  adjustedInputs: AdjustedInputs,
  resolvedContext: ResolvedUnderwritingContext,
): boolean {
  const struExtractValue = analysis.extractionResult?.structural?.loanTermMonths?.value;
  const extractionMissing = !(typeof struExtractValue === 'number' && Number.isFinite(struExtractValue));
  const aiTerm = adjustedInputs.loan.termMonths;
  const aiPresent = typeof aiTerm === 'number' && Number.isFinite(aiTerm);
  const rcTerm = resolvedContext.loan.termMonths;
  const rcPresent = typeof rcTerm === 'number' && Number.isFinite(rcTerm);
  return extractionMissing && aiPresent && rcPresent;
}

// --- Public entry: build event --------------------------------------------

/**
 * Pure transformation. Returns null on any internal error — never throws.
 * Caller treats null as "observability skipped this render".
 */
export function buildObservabilityEvent(
  i: ObservabilityInputs,
): UnderwritingObservabilityEvent | null {
  try {
    const sourcesByAddress = getSchemaSourcesByAddress(
      i.assetClass, i.variantKey, i.mode, i.contractVersion,
    );

    const termFallback = isTermFallbackInUse(i.analysis, i.adjustedInputs, i.resolvedContext);

    const fieldMap: FieldSourceAttribution[] = [];
    let resolvedContextHits = 0;
    let adjustedInputsHits = 0;
    let metaHits = 0;
    let fallbackEventsCount = 0;

    for (const address of Object.keys(i.cellBindings).sort()) {
      const sources = sourcesByAddress.get(address);
      // Single-sourced per the schema invariant; pick the one element.
      const source: SourceSurface = sources && sources.size > 0
        ? ([...sources][0])
        : 'adjustedInputs';
      const fallback = TERM_CELL_ADDRESSES.has(address) && termFallback;

      if (source === 'resolvedContext') resolvedContextHits++;
      else if (source === 'adjustedInputs') adjustedInputsHits++;
      else if (source === 'meta') metaHits++;
      if (fallback) fallbackEventsCount++;

      fieldMap.push({ field: address, source, fallback });
    }

    const totalFields = fieldMap.length;
    const fallbackPressureRatio = totalFields ? fallbackEventsCount / totalFields : 0;
    const legacyDependencyRatio = totalFields ? adjustedInputsHits / totalFields : 0;

    const registryRollups = summarizeRegistry(i.resolvedRegistry);

    return {
      analysisId: i.analysisId,
      contractVersion: i.contractVersion,
      assetClass: i.assetClass,
      variantKey: i.variantKey,
      mode: i.mode,
      generatedAt: i.generatedAt,
      metrics: {
        totalFields,
        resolvedContextHits,
        adjustedInputsHits,
        metaHits,
        fallbackEventsCount,
        fallbackPressureRatio,
        legacyDependencyRatio,
        completeness: {
          property: propertyCompleteness(i.resolvedContext),
          loan:     loanCompleteness(i.resolvedContext),
          party:    partyCompleteness(i.resolvedContext),
          comps:    compsCompleteness(i.resolvedContext),
        },
        ...(registryRollups ?? {}),
      },
      fieldMap,
      ...(i.resolvedRegistry
        ? { fieldAuthorityEvents: i.resolvedRegistry.events }
        : {}),
    };
  } catch (err) {
    // Best-effort: failure to build a metric MUST NOT block the export.
    console.error('[observability] buildObservabilityEvent skipped:', (err as Error)?.message);
    return null;
  }
}

// --- Registry roll-up summary --------------------------------------------

function summarizeRegistry(rr: ResolvedRegistry | undefined): {
  registryHash: string;
  collectionExpansionCount: number;
  derivationCount: number;
  fieldAuthorityEventCounts: {
    MISSING_SOURCE:          number;
    SOURCE_CONFLICT:         number;
    DEPENDENCY_BLANK:        number;
    FALLBACK_USED:           number;
    VALIDATION_FAIL:         number;
    AWAITING_CONTEXT_SHAPE:  number;
    DEPRECATED_FIELD_USED:   number;
  };
} | null {
  if (!rr) return null;
  const counts = {
    MISSING_SOURCE:          0,
    SOURCE_CONFLICT:         0,
    DEPENDENCY_BLANK:        0,
    FALLBACK_USED:           0,
    VALIDATION_FAIL:         0,
    AWAITING_CONTEXT_SHAPE:  0,
    DEPRECATED_FIELD_USED:   0,
  };
  for (const ev of rr.events) {
    counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
  }
  return {
    registryHash: rr.registryHash,
    collectionExpansionCount: rr.collectionExpansionCount,
    derivationCount: rr.derivationCount,
    fieldAuthorityEventCounts: counts,
  };
}

// --- Sink (structured log + optional sqlite append) -----------------------

/**
 * Emit a single structured log line. Format: one JSON object per line, with
 * a `kind: 'UNDERWRITING_OBSERVABILITY_EVENT'` discriminator so log
 * collectors can filter without parsing the whole stream.
 */
export function emitObservabilityEvent(event: UnderwritingObservabilityEvent): void {
  try {
    process.stdout.write(JSON.stringify({
      kind: 'UNDERWRITING_OBSERVABILITY_EVENT',
      ...event,
    }) + '\n');
  } catch {
    /* never throw */
  }
}

/**
 * Best-effort persistence into `underwriting_observability_log` (created
 * on first call). Caller passes the sqlite-store's better-sqlite3 handle.
 * Returns true on success, false on any failure.
 */
export function persistObservabilityEvent(
  // Opaque better-sqlite3-shaped handle. Typed as `any` because better-sqlite3's
  // generic Statement type is too narrow for a duck-typed leaf consumer; the
  // implementation calls only `.exec(sql)` and `.prepare(sql).run(...args)`.
  db: any,
  event: UnderwritingObservabilityEvent,
): boolean {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS underwriting_observability_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO underwriting_observability_log (analysis_id, contract_version, timestamp, payload_json) VALUES (?, ?, ?, ?)`,
    ).run(event.analysisId, event.contractVersion, event.generatedAt, JSON.stringify(event));
    return true;
  } catch (err) {
    console.error('[observability] persist skipped:', (err as Error)?.message);
    return false;
  }
}

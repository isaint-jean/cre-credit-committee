/**
 * Field Authority Resolver — Phase 1 Expansion + Phase 2 Derivation.
 *
 * STRICT SEPARATION (locked spec):
 *   Phase 1  expandCollections(registry, sources)   → ExpandedEntityGraph
 *   Phase 2  applyDerivations(graph, sources)       → ResolvedRegistry
 *
 * RULES (locked spec):
 *   - NO audit logic              (lives in field-authority.audit.ts)
 *   - NO schema validation        (lives in field-authority.audit.ts)
 *   - NO observability emission   (events returned via ResolvedRegistry)
 *   - NO underwriting rules
 *   - NO mutation of inputs
 *   - Pure deterministic transformation. Same inputs → same outputs.
 *
 * CONFLICT INVARIANT (locked spec):
 *   ≥2 distinct non-null candidate values  →  blank + SOURCE_CONFLICT
 *   Holds under BOTH preserveAllCandidates AND documentPrecedence policies.
 *   PRECEDENCE_ORDER is attribution-only (chooses which source to credit).
 *
 * RESOLUTION STATE → BEHAVIOR:
 *   Resolver consults RESOLUTION_POLICY[state] from field-authority.types.ts.
 *   It does NOT branch on state literals.
 */
import type { AdjustedInputs, AssetType, UnderwritingMode } from '@cre/shared';

import type {
  EntityCollectionDefinition,
  ExpandedCollection,
  ExpandedEntityGraph,
  ExpandedRow,
  FieldAuthority,
  FieldAuthorityEvent,
  FieldAuthorityRegistry,
  FieldCandidate,
  FieldCandidateSource,
  FieldRef,
  Provenance,
  ResolutionState,
  ResolvedCellValue,
  ResolvedRegistry,
  ScalarSlot,
  SourceBinding,
  SourceDocument,
} from './field-authority.types.js';
import {
  DOMAIN_TO_CONTEXT_GROUP,
  PRECEDENCE_ORDER,
  RESOLUTION_POLICY,
} from './field-authority.types.js';

// --------------------------------------------------------------------------
// Public input shape — mirrors HydrationSources but kept independent so the
// resolver does not depend on the hydrator module.
// --------------------------------------------------------------------------

export interface ResolverSources {
  /** Free-form bag carrying the eventual UnderwritingContext shape (or its
   *  subset, while many paths remain `unmapped`). Resolver reads via dotted
   *  extractionPath; missing paths are treated as null candidates (i.e. the
   *  candidate is not produced at all). */
  context: Record<string, unknown>;
  adjustedInputs: AdjustedInputs;
  /** Optional explicit manual-input bag — keyed by extractionPath suffix
   *  matching the bindings declared on FieldRef.primary or .fallbacks for
   *  documents with `document: 'manualInput'`. */
  manualInputs?: Record<string, unknown>;
  assetClass: AssetType;
  mode: UnderwritingMode;
}

// --------------------------------------------------------------------------
// Phase 1 — EXPANSION (structure only, no value-logic).
// Reads source bindings, assembles candidates, lays out collection rows.
// --------------------------------------------------------------------------

export function expandCollections(
  registry: FieldAuthorityRegistry,
  sources: ResolverSources,
): ExpandedEntityGraph {
  const expansionEvents: FieldAuthorityEvent[] = [];
  const scalars: Record<string, ScalarSlot> = {};
  const collections: Record<string, ExpandedCollection> = {};

  // Top-level scalar fields.
  for (const ref of Object.values(registry.fields)) {
    const effective = applyAssetOverride(ref, sources.assetClass);
    if (!effective) continue; // suppressedFor → omit from graph
    const slot = buildScalarSlot(effective, sources, /* row */ null);
    scalars[effective.cellAddress] = slot;
    if (slot.resolutionState === 'unmapped') {
      expansionEvents.push({
        kind: 'AWAITING_CONTEXT_SHAPE',
        cellAddress: effective.cellAddress,
        declaredPath: effective.primary.extractionPath,
      });
    }
  }

  // Entity collections.
  for (const def of Object.values(registry.collections)) {
    const effective = applyCollectionAssetOverride(def, sources.assetClass);
    if (!effective) continue;

    const rawArr = readArrayPath(sources.context, effective.primarySource);
    const fallbackArr =
      rawArr ?? firstFallbackArray(sources.context, effective.fallbacks);
    const arr: unknown[] = Array.isArray(fallbackArr) ? fallbackArr : [];

    const sorted = effective.sortKey ? sortRows(arr, effective.sortKey) : arr;
    const capped = effective.maxItems ? sorted.slice(0, effective.maxItems) : sorted;

    const rows: ExpandedRow[] = [];
    for (const item of capped) {
      const key = readKey(item, effective.keyField);
      if (key == null) continue; // unkeyed rows excluded — keyed indexing only
      const pathPrefix = `${effective.id}_${sanitizeKey(key)}`;
      const rowFields: Record<string, ScalarSlot> = {};
      for (const colKey of Object.keys(effective.fields)) {
        const colRef = effective.fields[colKey];
        const materialized: FieldRef = {
          ...colRef,
          cellAddress: `${pathPrefix}_${colRef.cellAddress}`,
        };
        const slot = buildScalarSlot(materialized, sources, item);
        rowFields[colKey] = slot;
      }
      rows.push({ key: String(key), pathPrefix, rowFields });
    }

    if (rows.length === 0) {
      expansionEvents.push(emitMissingFor(effective));
    }

    collections[effective.id] = { definition: effective, rows };
  }

  return {
    scalars,
    collections,
    registryHash: hashRegistry(registry),
    expansionEvents,
  };
}

// --------------------------------------------------------------------------
// Phase 2 — DERIVATION + ADJUDICATION.
// Walks the graph in dependency order, runs conflict + missing logic,
// executes derivations, materializes FieldAuthority entries.
// --------------------------------------------------------------------------

export function applyDerivations(
  graph: ExpandedEntityGraph,
  sources: ResolverSources,
): ResolvedRegistry {
  const events: FieldAuthorityEvent[] = [...graph.expansionEvents];
  const fields: Record<string, FieldAuthority> = {};
  let derivationCount = 0;

  // Pass 1 — non-derived scalars (so derivations can read them).
  for (const slot of Object.values(graph.scalars)) {
    if (slot.fieldRef.derivation) continue;
    const out = adjudicateAndMaterialize(slot, events);
    if (out) fields[slot.fieldRef.cellAddress] = out;
  }

  // Pass 1.5 — non-derived collection-row scalars.
  for (const col of Object.values(graph.collections)) {
    for (const row of col.rows) {
      for (const slot of Object.values(row.rowFields)) {
        if (slot.fieldRef.derivation) continue;
        const out = adjudicateAndMaterialize(slot, events);
        if (out) fields[slot.fieldRef.cellAddress] = out;
      }
    }
  }

  // Pass 2 — derived scalars in topological order. Iterate up to a bounded
  // number of fixed-point passes; cycles fail loudly via the audit layer at
  // boot, so a runtime cycle here would mean a registry mutation slipped
  // through — we cap the loop and warn via DEPENDENCY_BLANK in that case.
  const derivedSlots: ScalarSlot[] = [];
  for (const slot of Object.values(graph.scalars)) {
    if (slot.fieldRef.derivation) derivedSlots.push(slot);
  }
  for (const col of Object.values(graph.collections)) {
    for (const row of col.rows) {
      for (const slot of Object.values(row.rowFields)) {
        if (slot.fieldRef.derivation) derivedSlots.push(slot);
      }
    }
  }

  let unresolvedBefore = derivedSlots.length;
  for (let pass = 0; pass < 8 && unresolvedBefore > 0; pass++) {
    let resolvedThisPass = 0;
    for (const slot of derivedSlots) {
      const addr = slot.fieldRef.cellAddress;
      if (fields[addr] !== undefined) continue;
      const result = tryDerive(slot, fields, events, sources);
      if (result === 'resolved') {
        resolvedThisPass++;
        derivationCount++;
      }
    }
    const unresolvedAfter = derivedSlots.filter(
      (s) => fields[s.fieldRef.cellAddress] === undefined,
    ).length;
    if (resolvedThisPass === 0 || unresolvedAfter === 0) {
      unresolvedBefore = unresolvedAfter;
      break;
    }
    unresolvedBefore = unresolvedAfter;
  }

  // Pass 3 — any derived slot still unresolved blanks out with DEPENDENCY_BLANK.
  for (const slot of derivedSlots) {
    const addr = slot.fieldRef.cellAddress;
    if (fields[addr] !== undefined) continue;
    const missing = (slot.fieldRef.derivation?.requiredInputs ?? []).filter(
      (input) => !inputResolved(input, fields, slot),
    );
    events.push({
      kind: 'DEPENDENCY_BLANK',
      cellAddress: addr,
      formulaId: slot.fieldRef.derivation?.formulaId ?? 'unknown',
      missingInputs: missing,
    });
    fields[addr] = blankAuthority(slot.fieldRef);
  }

  return {
    fields,
    events,
    registryHash: graph.registryHash,
    collectionExpansionCount: Object.values(graph.collections).reduce(
      (n, c) => n + c.rows.length, 0,
    ),
    derivationCount,
  };
}

// --------------------------------------------------------------------------
// PHASE-1 internals
// --------------------------------------------------------------------------

function buildScalarSlot(
  ref: FieldRef,
  sources: ResolverSources,
  row: unknown,
): ScalarSlot {
  const candidates: FieldCandidate[] = [];
  collectCandidate(candidates, ref.primary, ref, sources, row);
  for (const fb of ref.fallbacks) {
    collectCandidate(candidates, fb, ref, sources, row);
  }
  return {
    fieldRef: ref,
    candidates,
    domain: ref.domain,
    resolutionState: ref.resolutionState,
  };
}

function collectCandidate(
  out: FieldCandidate[],
  binding: SourceBinding,
  ref: FieldRef,
  sources: ResolverSources,
  row: unknown,
): void {
  // Derived bindings produce candidates only at Phase 2 — skip during expansion.
  if (binding.document === 'derived') return;

  const value = readBindingValue(binding, sources, row);
  if (value === null || value === undefined) return;

  // Confidence floor pruning happens here; floor-violators never adjudicate.
  if (binding.confidenceFloor != null) {
    const conf = readConfidence(sources, binding.extractionPath);
    if (conf != null && conf < binding.confidenceFloor) return;
  }

  out.push({
    value,
    source: tierFromDocument(binding.document, /* derivedAt: */ false),
  });
}

function readBindingValue(
  binding: SourceBinding,
  sources: ResolverSources,
  row: unknown,
): unknown {
  // Row-relative paths (used only inside collection columns).
  if (row && typeof row === 'object') {
    // If extractionPath is a bare leaf (no dot) and the row carries it, use it.
    const leaf = (row as Record<string, unknown>)[binding.extractionPath];
    if (leaf !== undefined) return leaf;
  }
  // Otherwise read from the appropriate top-level surface.
  switch (binding.surface) {
    case 'adjustedInputs':
      return readDottedPath(sources.adjustedInputs as unknown, binding.extractionPath);
    case 'resolvedContext':
      // 'manualInput'-document bindings on the resolvedContext surface read
      // from sources.manualInputs when present, otherwise context.
      if (binding.document === 'manualInput' && sources.manualInputs) {
        const v = readDottedPath(sources.manualInputs, binding.extractionPath);
        if (v !== undefined) return v;
      }
      return readDottedPath(sources.context, binding.extractionPath);
    case 'meta':
    case 'conservatismStatus':
    case 'libraryBaselineMeta':
      return null;
  }
}

function readConfidence(_sources: ResolverSources, _path: string): number | null {
  // Confidence reads are surface-specific; today the new field-authority
  // registry does not declare confidenceFloor on any binding, so this is
  // a no-op shim. Hook for future per-binding confidence inspection.
  return null;
}

function readDottedPath(root: unknown, path: string): unknown {
  if (root == null || typeof path !== 'string' || path.length === 0) return undefined;
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function readArrayPath(root: unknown, binding: SourceBinding): unknown[] | null {
  const v = readDottedPath(root, binding.extractionPath);
  return Array.isArray(v) ? v : null;
}

function firstFallbackArray(
  root: unknown,
  fallbacks: readonly SourceBinding[],
): unknown[] | null {
  for (const fb of fallbacks) {
    const v = readArrayPath(root, fb);
    if (v) return v;
  }
  return null;
}

function readKey(item: unknown, keyField: string): string | number | null {
  if (item == null || typeof item !== 'object') return null;
  const v = (item as Record<string, unknown>)[keyField];
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function sanitizeKey(key: string | number): string {
  return String(key).replace(/[^A-Za-z0-9_]/g, '_');
}

function sortRows(
  arr: readonly unknown[],
  sortKey: { field: string; direction: 'asc' | 'desc' },
): unknown[] {
  const factor = sortKey.direction === 'desc' ? -1 : 1;
  return [...arr].sort((a, b) => {
    if (a == null || typeof a !== 'object') return 0;
    if (b == null || typeof b !== 'object') return 0;
    const av = (a as Record<string, unknown>)[sortKey.field];
    const bv = (b as Record<string, unknown>)[sortKey.field];
    if (typeof av === 'number' && typeof bv === 'number') {
      return (av - bv) * factor;
    }
    return String(av ?? '').localeCompare(String(bv ?? '')) * factor;
  });
}

function applyAssetOverride(
  ref: FieldRef,
  asset: AssetType,
): FieldRef | null {
  if (ref.suppressedFor?.includes(asset)) return null;
  const ov = ref.assetOverrides?.[asset];
  return ov ?? ref;
}

function applyCollectionAssetOverride(
  def: EntityCollectionDefinition,
  asset: AssetType,
): EntityCollectionDefinition | null {
  if (def.suppressedFor?.includes(asset)) return null;
  const ov = def.assetOverrides?.[asset];
  return ov ?? def;
}

function emitMissingFor(def: EntityCollectionDefinition): FieldAuthorityEvent {
  const severity =
    def.missingBehavior.kind === 'blankWithRedFlag' ? 'redFlag'
      : def.missingBehavior.kind === 'blankWithWarning' ? 'warning'
        : 'blank';
  return {
    kind: 'MISSING_SOURCE',
    cellAddress: def.id,
    attempted: [def.primarySource.document, ...def.fallbacks.map((f) => f.document)],
    severity,
  };
}

// --------------------------------------------------------------------------
// PHASE-2 internals — adjudication, derivation, materialization
// --------------------------------------------------------------------------

function adjudicateAndMaterialize(
  slot: ScalarSlot,
  events: FieldAuthorityEvent[],
): FieldAuthority | null {
  const policy = RESOLUTION_POLICY[slot.resolutionState];

  // State-driven side-effect (e.g. AWAITING_CONTEXT_SHAPE — already emitted
  // during Phase 1 expansion; we don't re-emit here).
  if (policy.writeBehavior === 'blank') {
    return blankAuthority(slot.fieldRef);
  }
  if (policy.emitEvent === 'DEPRECATED_FIELD_USED') {
    events.push({ kind: 'DEPRECATED_FIELD_USED',
                  cellAddress: slot.fieldRef.cellAddress });
  }

  const candidates = slot.candidates;

  // No candidates at all → MISSING_SOURCE per the slot's missingBehavior.
  if (candidates.length === 0) {
    const severity =
      slot.fieldRef.missingBehavior.kind === 'blankWithRedFlag' ? 'redFlag'
        : slot.fieldRef.missingBehavior.kind === 'blankWithWarning' ? 'warning'
          : 'blank';
    events.push({
      kind: 'MISSING_SOURCE',
      cellAddress: slot.fieldRef.cellAddress,
      attempted: [slot.fieldRef.primary.document,
                  ...slot.fieldRef.fallbacks.map((f) => f.document)],
      severity,
    });
    return blankAuthority(slot.fieldRef);
  }

  // Conflict invariant — ≥2 distinct non-null values → blank + SOURCE_CONFLICT.
  // Holds under BOTH conflict policies; precedence is attribution-only.
  const distinct = countDistinctValues(candidates);
  if (distinct.length > 1) {
    events.push({
      kind: 'SOURCE_CONFLICT',
      cellAddress: slot.fieldRef.cellAddress,
      candidates: candidates.map((c) => ({
        source: c.source,
        document: documentFromTier(c.source, slot.fieldRef),
        value: c.value,
      })),
    });
    return blankAuthority(slot.fieldRef);
  }

  // No conflict — select the highest-precedence candidate that holds the
  // single distinct value. This is provenance attribution only; the value
  // is the same across all candidates.
  const winner = pickByPrecedence(candidates);
  const winningBinding = bindingForTier(slot.fieldRef, winner.source);
  const isFallback = winningBinding !== slot.fieldRef.primary;
  if (isFallback && winningBinding) {
    events.push({
      kind: 'FALLBACK_USED',
      cellAddress: slot.fieldRef.cellAddress,
      primary: slot.fieldRef.primary.document,
      used: winningBinding.document,
      candidateTier: winner.source,
    });
  }
  const provenance: Provenance = {
    document: winningBinding?.document ?? slot.fieldRef.primary.document,
    surface: winningBinding?.surface ?? slot.fieldRef.primary.surface,
    extractionPath: winningBinding?.extractionPath ?? slot.fieldRef.primary.extractionPath,
    isFallback,
    candidateSource: winner.source,
    rejectedCandidates: candidates
      .filter((c) => c !== winner)
      .map((c) => c.source),
  };
  return {
    value: coerceCellValue(winner.value),
    provenance,
    valuationContext: slot.fieldRef.valuationContext ?? null,
  };
}

function tryDerive(
  slot: ScalarSlot,
  fields: Record<string, FieldAuthority>,
  events: FieldAuthorityEvent[],
  sources: ResolverSources,
): 'resolved' | 'pending' {
  const rule = slot.fieldRef.derivation;
  if (!rule) return 'pending';

  const policy = RESOLUTION_POLICY[slot.resolutionState];
  if (policy.writeBehavior === 'blank') {
    fields[slot.fieldRef.cellAddress] = blankAuthority(slot.fieldRef);
    return 'resolved';
  }

  const missing: string[] = [];
  for (const input of rule.requiredInputs) {
    if (!inputResolved(input, fields, slot)) missing.push(input);
  }
  if (missing.length > 0) return 'pending';

  // All inputs available — execute via the resolved-inputs adapter.
  // The actual numeric formula lives in the existing metrics pipeline
  // (analysis-to-adjusted-inputs.adapter.ts / uwModel). The resolver does
  // NOT re-implement formulas — it reads the corresponding pre-computed
  // value off adjustedInputs at the binding's extractionPath.
  const value = readDottedPath(
    sources.adjustedInputs as unknown,
    slot.fieldRef.primary.extractionPath,
  );

  if (value === null || value === undefined ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    events.push({
      kind: 'DEPENDENCY_BLANK',
      cellAddress: slot.fieldRef.cellAddress,
      formulaId: rule.formulaId,
      missingInputs: missing,
    });
    fields[slot.fieldRef.cellAddress] = blankAuthority(slot.fieldRef);
    return 'resolved';
  }

  fields[slot.fieldRef.cellAddress] = {
    value: coerceCellValue(value),
    provenance: {
      document: 'derived',
      surface: 'adjustedInputs',
      extractionPath: slot.fieldRef.primary.extractionPath,
      isFallback: false,
      candidateSource: 'derived',
    },
    valuationContext: slot.fieldRef.valuationContext ?? null,
  };
  return 'resolved';
}

function inputResolved(
  input: string,
  fields: Record<string, FieldAuthority>,
  slot: ScalarSlot,
): boolean {
  // Row-self refs (used inside collection-column derivations) check the
  // sibling column on the same row prefix.
  if (input.startsWith('__rowSelf.')) {
    const col = input.slice('__rowSelf.'.length);
    const rowPrefix = slot.fieldRef.cellAddress.replace(/_[^_]+$/, '');
    const addr = `${rowPrefix}_${col}`;
    return isPresent(fields[addr]?.value);
  }
  if (input.startsWith('__contextScalar.')) {
    const addr = input.slice('__contextScalar.'.length);
    return isPresent(fields[addr]?.value);
  }
  return isPresent(fields[input]?.value);
}

function isPresent(v: ResolvedCellValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

function countDistinctValues(candidates: readonly FieldCandidate[]): unknown[] {
  const seen: unknown[] = [];
  for (const c of candidates) {
    if (c.value === null || c.value === undefined) continue;
    if (!seen.some((s) => deepEqual(s, c.value))) seen.push(c.value);
  }
  return seen;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function pickByPrecedence(candidates: readonly FieldCandidate[]): FieldCandidate {
  const ranked = [...candidates].sort((a, b) => {
    return PRECEDENCE_ORDER.indexOf(a.source) - PRECEDENCE_ORDER.indexOf(b.source);
  });
  return ranked[0]!;
}

function bindingForTier(
  ref: FieldRef,
  tier: FieldCandidateSource,
): SourceBinding | null {
  const primaryTier = tierFromDocument(ref.primary.document, false);
  if (primaryTier === tier) return ref.primary;
  for (const fb of ref.fallbacks) {
    if (tierFromDocument(fb.document, false) === tier) return fb;
  }
  return null;
}

function documentFromTier(
  tier: FieldCandidateSource,
  ref: FieldRef,
): SourceDocument {
  const b = bindingForTier(ref, tier);
  return b?.document ?? ref.primary.document;
}

/** FIX 2 mapping rule (locked spec): document-driven, never surface-driven. */
export function tierFromDocument(
  doc: SourceDocument,
  derivedAt: boolean,
): FieldCandidateSource {
  if (derivedAt) return 'derived';
  if (doc === 'asr') return 'ASR';
  if (doc === 'manualInput') return 'manual';
  if (doc === 'derived') return 'derived';
  // adjustedInputs origin is implicit when document is 'derived' OR when the
  // surface is 'adjustedInputs'; non-derived adjustedInputs-origin documents
  // are tagged 'adjustedInput' here. We approximate by treating a small set
  // of "judgment-engine" documents as adjustedInput; everything else is
  // 'fallback'. The spec is explicit: NEVER use surface for this mapping.
  if (
    doc === 'rateCapNote' ||
    doc === 'mezzNote' ||
    doc === 'capitalStackSchedule'
  ) {
    return 'fallback';
  }
  if (doc === 'uwMemo') return 'fallback';
  return 'fallback';
}

function blankAuthority(ref: FieldRef): FieldAuthority {
  return {
    value: null,
    provenance: {
      document: ref.primary.document,
      surface: ref.primary.surface,
      extractionPath: ref.primary.extractionPath,
      isFallback: false,
      candidateSource: tierFromDocument(ref.primary.document, false),
    },
    valuationContext: ref.valuationContext ?? null,
  };
}

function coerceCellValue(v: unknown): ResolvedCellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v;
  // Reject objects / arrays — scalar invariant.
  return null;
}

// --------------------------------------------------------------------------
// Registry hash — deterministic content fingerprint, used by audit and
// observability. Independent of insertion order.
// --------------------------------------------------------------------------

export function hashRegistry(registry: FieldAuthorityRegistry): string {
  const canonical = canonicalize({
    contractVersion: registry.contractVersion,
    fields: Object.fromEntries(
      Object.entries(registry.fields).map(([k, v]) => [k, summarizeFieldRef(v)]),
    ),
    collections: Object.fromEntries(
      Object.entries(registry.collections).map(([k, v]) => [k, summarizeCollection(v)]),
    ),
  });
  return djb2Hash(JSON.stringify(canonical));
}

function summarizeFieldRef(ref: FieldRef): unknown {
  return {
    cellAddress: ref.cellAddress,
    domain: ref.domain,
    primary: ref.primary,
    fallbacks: ref.fallbacks,
    derivation: ref.derivation,
    resolutionState: ref.resolutionState,
    valuationContext: ref.valuationContext ?? null,
  };
}

function summarizeCollection(def: EntityCollectionDefinition): unknown {
  return {
    id: def.id,
    domain: def.domain,
    keyField: def.keyField,
    primarySource: def.primarySource,
    maxItems: def.maxItems ?? null,
    fieldKeys: Object.keys(def.fields).sort(),
    resolutionState: def.resolutionState,
  };
}

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = canonicalize((v as Record<string, unknown>)[k]);
  }
  return out;
}

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --------------------------------------------------------------------------
// CONTEXT-GROUP MAPPING (locked spec table — exposed for the hydrator to use
// when placing materialized FieldAuthorities into UnderwritingContext).
// --------------------------------------------------------------------------

export function contextGroupForRef(
  ref: FieldRef,
): 'property' | 'loan' | 'market' {
  return ref.targetContextGroup ?? DOMAIN_TO_CONTEXT_GROUP[ref.domain];
}

export function contextGroupForCollection(
  def: EntityCollectionDefinition,
): 'property' | 'loan' | 'market' {
  return def.targetContextGroup ?? DOMAIN_TO_CONTEXT_GROUP[def.domain];
}

// --------------------------------------------------------------------------
// PUBLIC TWO-PHASE ENTRY POINT
// --------------------------------------------------------------------------

export function resolveFieldAuthorityRegistry(
  registry: FieldAuthorityRegistry,
  sources: ResolverSources,
): { graph: ExpandedEntityGraph; resolved: ResolvedRegistry } {
  const graph = expandCollections(registry, sources);
  const resolved = applyDerivations(graph, sources);
  return { graph, resolved };
}

export type { ResolutionState };

/**
 * Field Authority Audit — boot-time invariants only.
 *
 * Locked-spec rules:
 *   - NO runtime resolution logic.
 *   - NO mutation of registry, render-schema, or context.
 *   - Returns { ok, violations[] } — caller decides whether to fail boot.
 *
 * Checks performed:
 *   1. Deterministic registry hash         (re-hashes; compares to a stored hash)
 *   2. No ordinal indexing leakage          (cellAddress matches /_\d{1,3}_/)
 *   3. EntityCollections declare keyField   (always required, but defended)
 *   4. Resolution-state legality            (every state appears in policy)
 *   5. Domain → context-group mapping coverage
 *   6. Mapped/derived cells exist on render-schema (when render-schema is
 *      passed in); registry-side declared __sources match render-schema's.
 *   7. Derivation requiredInputs reference real cellAddresses in the registry
 *   8. Asset-override targets do not introduce new cellAddresses (overrides
 *      replace shape, never add new cells)
 */
import type { SourceSurface } from './render-schema.js';

import {
  DOMAIN_TO_CONTEXT_GROUP,
  RESOLUTION_POLICY,
  type FieldAuthorityRegistry,
  type FieldRef,
  type EntityCollectionDefinition,
  type RegistryDomain,
} from './field-authority.types.js';
import { hashRegistry } from './field-authority.resolver.js';

export interface AuditViolation {
  code: string;
  message: string;
  cellAddress?: string;
  collectionId?: string;
}

export interface AuditResult {
  ok: boolean;
  registryHash: string;
  violations: AuditViolation[];
}

// Render-schema lookup is injected so the audit module remains decoupled
// from the schema's runtime API.
export type SchemaSourceLookup = (cellAddress: string) =>
  | ReadonlySet<SourceSurface>
  | null;

export interface AuditOptions {
  /** Optional adapter into render-schema.getSchemaSourcesByAddress(). Boot-
   *  time check 6 is skipped when omitted — useful for unit tests of the
   *  registry that don't load the schema. */
  schemaSourceLookup?: SchemaSourceLookup;
  /** Optional pinned hash. If supplied and computed hash differs, fail. */
  expectedRegistryHash?: string;
}

const ORDINAL_INDEX_PATTERN = /_(\d{1,3})_/;

export function auditFieldAuthorityRegistry(
  registry: FieldAuthorityRegistry,
  opts: AuditOptions = {},
): AuditResult {
  const violations: AuditViolation[] = [];
  const computedHash = hashRegistry(registry);

  if (opts.expectedRegistryHash && opts.expectedRegistryHash !== computedHash) {
    violations.push({
      code: 'REGISTRY_HASH_MISMATCH',
      message: `Registry content hash ${computedHash} ≠ pinned ${opts.expectedRegistryHash}`,
    });
  }

  // Deterministic re-hash check: hashing the registry twice must produce the
  // same value (defends against accidental Set/Map iteration leakage).
  if (hashRegistry(registry) !== computedHash) {
    violations.push({
      code: 'REGISTRY_HASH_NONDETERMINISTIC',
      message: 'Re-hashing the registry produced a different fingerprint',
    });
  }

  // 2. No ordinal indexing in any cellAddress (top-level OR collection columns).
  for (const ref of Object.values(registry.fields)) {
    checkNoOrdinalLeakage(ref.cellAddress, undefined, violations);
  }
  for (const def of Object.values(registry.collections)) {
    if (ORDINAL_INDEX_PATTERN.test(def.id)) {
      violations.push({
        code: 'ORDINAL_INDEX_IN_COLLECTION_ID',
        message: `Collection id "${def.id}" contains ordinal-style index`,
        collectionId: def.id,
      });
    }
    for (const colKey of Object.keys(def.fields)) {
      checkNoOrdinalLeakage(def.fields[colKey].cellAddress, def.id, violations);
    }
  }

  // 3. Every collection has a non-empty keyField.
  for (const def of Object.values(registry.collections)) {
    if (!def.keyField || def.keyField.trim().length === 0) {
      violations.push({
        code: 'COLLECTION_MISSING_KEYFIELD',
        message: `Collection "${def.id}" has no keyField`,
        collectionId: def.id,
      });
    }
  }

  // 4. Every resolutionState used must have a policy entry.
  const policyKeys = Object.keys(RESOLUTION_POLICY);
  for (const ref of Object.values(registry.fields)) {
    if (!policyKeys.includes(ref.resolutionState)) {
      violations.push({
        code: 'UNKNOWN_RESOLUTION_STATE',
        message: `cellAddress "${ref.cellAddress}" uses resolutionState "${ref.resolutionState}" which has no policy entry`,
        cellAddress: ref.cellAddress,
      });
    }
  }
  for (const def of Object.values(registry.collections)) {
    if (!policyKeys.includes(def.resolutionState)) {
      violations.push({
        code: 'UNKNOWN_RESOLUTION_STATE',
        message: `Collection "${def.id}" uses resolutionState "${def.resolutionState}" which has no policy entry`,
        collectionId: def.id,
      });
    }
  }

  // 5. Every domain used has a context-group mapping.
  const declaredDomains = new Set<RegistryDomain>();
  for (const ref of Object.values(registry.fields)) declaredDomains.add(ref.domain);
  for (const def of Object.values(registry.collections)) declaredDomains.add(def.domain);
  for (const dom of declaredDomains) {
    if (!(dom in DOMAIN_TO_CONTEXT_GROUP)) {
      violations.push({
        code: 'UNMAPPED_DOMAIN',
        message: `Domain "${dom}" has no entry in DOMAIN_TO_CONTEXT_GROUP`,
      });
    }
  }

  // 6. Mapped/derived cells must align with render-schema's declared sources
  //    (when a lookup is provided).
  if (opts.schemaSourceLookup) {
    for (const ref of Object.values(registry.fields)) {
      if (ref.resolutionState !== 'mapped' && ref.resolutionState !== 'derived') continue;
      const schemaSources = opts.schemaSourceLookup(ref.cellAddress);
      if (!schemaSources) {
        // Mapped cell that the render-schema does not yet know about — soft
        // mismatch. Treat as warning-class violation rather than blocking.
        violations.push({
          code: 'MAPPED_CELL_NOT_IN_RENDER_SCHEMA',
          message: `Cell "${ref.cellAddress}" is ${ref.resolutionState} but missing from render-schema`,
          cellAddress: ref.cellAddress,
        });
        continue;
      }
      const required: SourceSurface[] = [
        ref.primary.surface,
        ...ref.fallbacks.map((fb) => fb.surface),
      ];
      for (const surf of required) {
        if (!schemaSources.has(surf)) {
          violations.push({
            code: 'SOURCE_SURFACE_MISMATCH',
            message: `Cell "${ref.cellAddress}" registry declares surface "${surf}" not present on render-schema __sources`,
            cellAddress: ref.cellAddress,
          });
        }
      }
    }
  }

  // 7. Derivation requiredInputs must reference real cellAddresses (top-level
  //    or with a __rowSelf./__contextScalar. prefix). Unknown refs fail.
  const knownAddresses = new Set<string>();
  for (const ref of Object.values(registry.fields)) knownAddresses.add(ref.cellAddress);
  for (const def of Object.values(registry.collections)) {
    for (const colKey of Object.keys(def.fields)) {
      knownAddresses.add(`${def.id}_${colKey}`);
    }
  }
  for (const ref of Object.values(registry.fields)) {
    const rule = ref.derivation;
    if (!rule) continue;
    for (const input of rule.requiredInputs) {
      if (input.startsWith('__contextScalar.')) {
        const addr = input.slice('__contextScalar.'.length);
        if (!knownAddresses.has(addr)) {
          violations.push({
            code: 'DERIVATION_INPUT_UNKNOWN',
            message: `Cell "${ref.cellAddress}" derivation references unknown __contextScalar "${addr}"`,
            cellAddress: ref.cellAddress,
          });
        }
        continue;
      }
      if (input.startsWith('__rowSelf.')) {
        // Top-level fields can never reference __rowSelf — only collection columns.
        violations.push({
          code: 'DERIVATION_ROWSELF_AT_SCALAR',
          message: `Cell "${ref.cellAddress}" uses __rowSelf in a non-collection scope`,
          cellAddress: ref.cellAddress,
        });
        continue;
      }
      if (!knownAddresses.has(input)) {
        violations.push({
          code: 'DERIVATION_INPUT_UNKNOWN',
          message: `Cell "${ref.cellAddress}" derivation references unknown cell "${input}"`,
          cellAddress: ref.cellAddress,
        });
      }
    }
  }

  // 8. Asset overrides preserve cellAddress — overrides replace shape, never
  //    add a new cell. (Adding new cells per asset class is a registry
  //    extension, not an override.)
  for (const ref of Object.values(registry.fields)) {
    if (!ref.assetOverrides) continue;
    for (const asset of Object.keys(ref.assetOverrides)) {
      const ov = ref.assetOverrides[asset as keyof typeof ref.assetOverrides];
      if (ov && ov.cellAddress !== ref.cellAddress) {
        violations.push({
          code: 'ASSET_OVERRIDE_ADDRESS_MISMATCH',
          message: `Cell "${ref.cellAddress}" override for asset "${asset}" declares different cellAddress "${ov.cellAddress}"`,
          cellAddress: ref.cellAddress,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    registryHash: computedHash,
    violations,
  };
}

function checkNoOrdinalLeakage(
  cellAddress: string,
  collectionId: string | undefined,
  violations: AuditViolation[],
): void {
  // We allow a single 1-3 digit run inside a year-style suffix on tenancy
  // history (e.g. LeaseRollover_2026_grossIncome — keyed by year), but
  // reject leading-padded ordinals like Tenant_01_, Tranche_03_.
  const m = ORDINAL_INDEX_PATTERN.exec(cellAddress);
  if (!m) return;
  const num = m[1];
  // Year-keyed forms: 4-digit numeric segment is allowed.
  if (num.length === 4) return;
  // Anything 1–3 digits in a non-year position is treated as ordinal leakage
  // (e.g. _01_, _02_, _100_).
  violations.push({
    code: 'ORDINAL_INDEX_LEAK',
    message: `Cell "${cellAddress}" appears to use ordinal indexing (matched "_${num}_"); collections must use keyField-based addressing`,
    cellAddress,
    collectionId,
  });
}

/**
 * Render Contract Migrations
 *
 * Every bump of RENDER_CONTRACT_VERSION must declare a migration entry from
 * the prior version. The migration registry forms a complete chain from v1
 * to the current version. The chain is validated at backend boot — a missing
 * step fails server startup with MIGRATION_CHAIN_BROKEN.
 *
 * The payload shipped to a workbook running an older version includes the
 * migration steps it needs to catch up. Workbooks decide whether to:
 *   - apply autoApplicable migrations mechanically (e.g. plain renames), or
 *   - surface a clear "rebuild required" dialog listing the changes.
 *
 * No migrations are applied silently. The workbook ALWAYS shows the user what
 * changed before any structural action.
 */

export type AddressMigration =
  | { kind: 'address-added';   address: string }
  | { kind: 'address-removed'; address: string; reason: string }
  | { kind: 'address-renamed'; from: string; to: string };

export type TableMigration =
  | { kind: 'table-added';            name: string }
  | { kind: 'table-removed';          name: string; reason: string }
  | { kind: 'table-renamed';          from: string; to: string }
  | { kind: 'table-columns-changed';  name: string; added: string[]; removed: string[]; renamed: Array<{ from: string; to: string }> }
  | { kind: 'table-sheet-changed';    name: string; from: string; to: string };

export type NamespaceMigration =
  | { kind: 'namespace-prefix-added';   prefix: string }
  | { kind: 'namespace-prefix-removed'; prefix: string; reason: string }
  | { kind: 'namespace-literal-added';   literal: string }
  | { kind: 'namespace-literal-removed'; literal: string; reason: string }
  | { kind: 'namespace-excluded-sheet-added';   sheet: string }
  | { kind: 'namespace-excluded-sheet-removed'; sheet: string; reason: string };

export type WireMigration =
  | { kind: 'payload-field-added';   field: string }
  | { kind: 'payload-field-removed'; field: string; reason: string }
  | { kind: 'payload-field-renamed'; from: string; to: string };

export type VisibilityMigration =
  | { kind: 'visible-tab-added';   assetClass: string; tab: string }
  | { kind: 'visible-tab-removed'; assetClass: string; tab: string; reason: string };

export interface RenderContractMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  /** Mechanically applicable by a workbook (e.g. only renames/additions). */
  autoApplicable: boolean;
  addresses:        AddressMigration[];
  tables:           TableMigration[];
  managedNamespace: NamespaceMigration[];
  visibility:       VisibilityMigration[];
  wire:             WireMigration[];
  notes?: string;
}

/** Returned to clients via /render-migrations and embedded in /render when client is stale. */
export interface MigrationManifest {
  fromVersion: number;
  toVersion: number;
  steps: RenderContractMigration[];
  /** True iff every step in the chain is autoApplicable. */
  autoApplicable: boolean;
}

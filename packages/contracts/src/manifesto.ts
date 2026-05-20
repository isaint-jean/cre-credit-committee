/**
 * CreditManifesto — migrated from `@cre/shared/types/criteria.ts` (legacy) to `@cre/contracts`.
 *
 * Decision (v2.1): keep legacy free-form `condition` strings for v1.0; structure-as-data later
 * if needed. The migration drops operational metadata (fileName, uploadedBy, isActive — those
 * are state, not contract data) and adds:
 *   - content-hash `id` (replaces legacy UUID)
 *   - `analysisAsOfDate` (replay key participation)
 *   - `manifestoContractVersion` (axis-stamped, parallel to other version axes)
 *
 * Manifestos are user-configurable (each bank uploads its own credit policy). Unlike the
 * judgment-engine rule registry, manifestos do NOT get hash-drift protection — different
 * manifestos producing different ids is the design.
 *
 * Architecture rule (§5): `applyJudgmentAdjustments` is the only place that enforces manifesto
 * principles as conditional logic. The manifesto contract surfaces the rule list; the judgment
 * engine evaluates the predicates and emits AdjustmentEntries with `ruleId: CreditManifestoRuleId`.
 */

import type { AssetType } from './asset.js';
import type { CreditManifestoId } from './identity.js';
import type {
  ISODateTime,
  ManifestoContractVersion,
} from './versioning.js';

declare const __manifestoRuleBrand: unique symbol;

/**
 * Branded id for a manifesto rule. User-configurable; not a compile-time literal union since
 * manifestos are loaded at runtime, not frozen at build time. Producers (manifesto loaders)
 * brand strings via an explicit factory; consumers receive the branded type and cannot
 * accidentally pass a `JudgmentEngineRuleId` where a `CreditManifestoRuleId` is expected.
 */
export type CreditManifestoRuleId = string & {
  readonly [__manifestoRuleBrand]: 'CreditManifestoRuleId';
};

export const MANIFESTO_COMPARISON_OPERATORS = [
  '>',
  '>=',
  '<',
  '<=',
  '==',
  '!=',
  'contains',
  'between',
  'qualitative',
] as const;
export type ManifestoComparisonOperator = (typeof MANIFESTO_COMPARISON_OPERATORS)[number];

export const MANIFESTO_OUTCOMES = ['Pass', 'Fail', 'Watchlist'] as const;
export type ManifestoOutcome = (typeof MANIFESTO_OUTCOMES)[number];

export interface ManifestoRule {
  readonly ruleId: CreditManifestoRuleId;
  readonly metricName: string;
  /** Free-form predicate (v1.0). Structure-as-data deferred. */
  readonly condition: string;
  readonly thresholdValue: string | number | null;
  readonly comparisonOperator: ManifestoComparisonOperator;
  readonly outcome: ManifestoOutcome;
  readonly weight: number;
  /** Asset types the rule applies to. Use `['all']` to mean every asset type. */
  readonly assetTypes: readonly AssetType[] | readonly ['all'];
  readonly sourceText: string;
  readonly pageReference: number | null;
}

export interface CreditManifesto {
  readonly id: CreditManifestoId;
  readonly analysisAsOfDate: ISODateTime;
  readonly manifestoContractVersion: ManifestoContractVersion;
  readonly rules: readonly ManifestoRule[];
}

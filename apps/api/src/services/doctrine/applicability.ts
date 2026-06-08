/**
 * Doctrine applicability — per-rule asset-class predicates (Stage 1 v1.1).
 *
 * Mirrors the judgment-side `apps/api/src/services/judgment/applicability.ts` pattern:
 * a per-rule predicate returning true when the rule applies to the asset class. Used by
 * doctrine v1.1's component scorers to mark `DoctrineComponentScore.status` as
 * 'not_applicable' on rules that don't apply to the deal's asset class, instead of
 * forcing a sink to 'insufficient_data' and dragging the aggregate.
 *
 * SINGLE SOURCE OF TRUTH: `TENANT_DRIVEN_TYPES` is imported from judgment's applicability
 * module (judgment owns the asset-class taxonomy for line-item gating; doctrine's
 * applicability is a read of the same partition).
 *
 * Risk-dim set: the four rules whose absence drives Stage 1's band-cap (band ≤
 * Acceptable when any of these are status='insufficient_data'). VACANCY is NOT a
 * risk dim — it's a normalization rule whose absence shouldn't downgrade the band.
 */

import type { AssetProfile, DoctrineRuleId } from '@cre/contracts';
import { DoctrineRules } from '@cre/contracts';
import { TENANT_DRIVEN_TYPES } from '../judgment/applicability.js';

/**
 * Doctrine v1.1 risk-dimension rules: the four credit-meaningful dimensions whose
 * insufficient-data status triggers the Stage 1 band cap (band ≤ Acceptable).
 *
 *   - UW_VS_T12_NOI_RECONCILIATION — trailing-actual validation of underwritten NOI.
 *   - TENANT_CONCENTRATION         — top-tenant income share (rent-roll-derived).
 *   - ROLLOVER_WITHIN_TERM         — lease-rollover concentration within loan term.
 *   - TI_LC_VS_ROLLOVER            — TI/LC reserve sized against rollover exposure.
 *
 * NOTE: VACANCY_FLOOR_VS_HISTORY is intentionally NOT a risk dim — it's a normalization
 * scorer and its sink shouldn't drive a credit-band cap.
 */
export const RISK_DIMENSION_RULES: ReadonlySet<DoctrineRuleId> = new Set<DoctrineRuleId>([
  DoctrineRules.UW_VS_T12_NOI_RECONCILIATION,
  DoctrineRules.TENANT_CONCENTRATION,
  DoctrineRules.ROLLOVER_WITHIN_TERM,
  DoctrineRules.TI_LC_VS_ROLLOVER,
]);

/**
 * True when the rule applies to the asset class. Default: true (most rules apply
 * universally). Today only the tenant-driven rules carve out non-tenant asset
 * classes (Multifamily / Hotel / SelfStorage / MHC / MixedUse / Other).
 */
export function isApplicable(ruleId: DoctrineRuleId, profile: AssetProfile): boolean {
  switch (ruleId) {
    case DoctrineRules.TENANT_CONCENTRATION:
    case DoctrineRules.ROLLOVER_WITHIN_TERM:
    case DoctrineRules.TI_LC_VS_ROLLOVER:
      return TENANT_DRIVEN_TYPES.has(profile.propertyType);
    default:
      return true;
  }
}

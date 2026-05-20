/**
 * `DOCTRINE_RULES_BY_COMPONENT` — canonical mapping from each scoring component to the rule ids
 * that drive it. Frozen for `DOCTRINE_VERSION = '1.0'`.
 *
 * The mapping is part of the doctrine spine: it is hashed into `DOCTRINE_HASH_DRIFT` and the
 * runtime engine uses it to dispatch component scoring to the correct rule handlers. A typo here
 * is caught at compile time (literal-union enforcement) AND surfaces in the boot drift check.
 *
 * `market_alignment` is intentionally empty in v1.0 — the §3 weight (10) is reserved for the
 * scoring rule that lands in v1.1. The boot check exempts this component from the
 * "every-component-has-rules" assertion.
 */

import { DoctrineRules } from './rules.js';
import type { DoctrineComponentId } from './components.js';
import type { DoctrineRuleId } from './rules.js';

export const DOCTRINE_RULES_BY_COMPONENT: { readonly [K in DoctrineComponentId]: readonly DoctrineRuleId[] } = {
  mechanical: [
    DoctrineRules.DSCR_LEVEL,
    DoctrineRules.DEBT_YIELD_LEVEL,
    DoctrineRules.LTV_LEVEL,
  ],
  durability: [
    DoctrineRules.UW_VS_T12_NOI_RECONCILIATION,
    DoctrineRules.TENANT_CONCENTRATION,
    DoctrineRules.ROLLOVER_WITHIN_TERM,
  ],
  normalization: [
    DoctrineRules.VACANCY_FLOOR_VS_HISTORY,
    DoctrineRules.EXPENSE_GROWTH_REALISM,
  ],
  capitalization: [
    DoctrineRules.PCA_IMMEDIATE_REPAIRS_COVERED,
    DoctrineRules.TI_LC_VS_ROLLOVER,
  ],
  market_alignment: [],   // intentionally empty in v1.0; rule lands in v1.1
  term_risk: [
    DoctrineRules.TERM_DSCR_BUFFER,
  ],
  maturity_risk: [
    DoctrineRules.REFI_FEASIBILITY_STRESSED,
  ],
  data_confidence: [
    DoctrineRules.RENT_ROLL_MISSING,
    DoctrineRules.T12_MISSING,
    DoctrineRules.LOAN_TERMS_MISSING,
    DoctrineRules.PCA_MISSING,
    DoctrineRules.APPRAISAL_MISSING,
    DoctrineRules.SELLER_UW_USED_WHEN_ACTUAL_EXISTS,
    DoctrineRules.ASR_USED_WHEN_PRIMARY_EXISTS,
  ],
};

/** Components allowed to have an empty rule list in `DOCTRINE_RULES_BY_COMPONENT`. */
export const DOCTRINE_COMPONENTS_WITH_DEFERRED_RULES = ['market_alignment'] as const;

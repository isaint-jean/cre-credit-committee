/**
 * sponsor-assessment-bridge — maps the CONTRACT `HumanSponsorAssessment` (a
 * provenance-tagged human record) to the doctrine scorer's `SponsorAssessment`
 * (the pure 5-factor input `evaluateDeal` consumes).
 *
 * This is the ONLY bridge between the two. It reads EXACTLY the five factor
 * fields a human entered and drops the provenance (who/when/note) — the scorer
 * has no business knowing who entered the judgment, only what it is. There is
 * no inverse: nothing constructs a `HumanSponsorAssessment` from anything the
 * scorer or a DD finding produces. The air-gap holds — the factors originate
 * only from a human, and only flow one way (human record → scorer).
 */
import type { HumanSponsorAssessment } from '@cre/contracts';
import type { SponsorAssessment } from '../doctrine-clean/index.js';

/**
 * Extract the five scoring factors from a human record. `null`/absent → `null`
 * so dim-9 stays HITL/inert (the corpus default). Never substitutes a default —
 * absence means "no human judgment", which is HITL, not a neutral score.
 */
export function toDoctrineSponsorAssessment(
  human: HumanSponsorAssessment | null | undefined,
): SponsorAssessment | null {
  if (human === null || human === undefined) return null;
  return {
    experience:        human.experience,
    financialStrength: human.financialStrength,
    alignment:         human.alignment,
    priorCreditEvents: human.priorCreditEvents,
    managementQuality: human.managementQuality,
  };
}

/**
 * ValuationConclusion — stage-9 producer output. The SOLE owner of valuation computation.
 *
 * Doctrine §9 guardrails are evaluated INSIDE this engine; the engine pre-stamps `capsApplied[]`
 * and `haircutsApplied[]` with the corresponding `DoctrineFlag`. The doctrine evaluator reads
 * those stamps and scores; it never recomputes valuation.
 *
 * Architecture rule: ValuationConclusion is downstream-only. It MUST NOT feed back into
 * `AdjustedInputs`, the metrics engine, the stress engine, or the conservatism gate. The doctrine
 * binds to it; nothing else mutates it.
 */

import type {
  AdjustedInputsId,
  NarrativeFactsId,
  StressOutputsId,
  ValuationConclusionId,
} from './identity.js';
import type {
  ISODateTime,
  ValuationEngineVersion,
} from './versioning.js';
import type { DoctrineFlag } from './doctrine/flags.js';

export const VALUATION_ANCHORS = ['appraisal', 'asr', 'market_comps', 'none'] as const;
export type ValuationAnchor = (typeof VALUATION_ANCHORS)[number];

export interface ValuationCap {
  readonly reason: DoctrineFlag;
  readonly cappedTo: number;
  readonly basis: ValuationAnchor;
}

export interface ValuationHaircut {
  readonly reason: DoctrineFlag;
  readonly pct: number;                            // 0..1
}

export interface ValuationConclusion {
  readonly id: ValuationConclusionId;
  readonly analysisAsOfDate: ISODateTime;
  readonly valuationEngineVersion: ValuationEngineVersion;

  readonly adjustedInputsId: AdjustedInputsId;
  readonly stressOutputsId: StressOutputsId;
  readonly narrativeFactsId: NarrativeFactsId;

  readonly uwValue: number | null;                 // = NOI / capRate.adjusted
  readonly marketValue: number | null;             // from comps; null if no comps
  readonly downsideValue: number | null;           // = stressNoi / exitCapStressed
  readonly finalValue: number | null;              // = min_non_null(uwValue, marketValue, downsideValue), post-caps

  readonly appraisalValue: number | null;
  readonly asrValue: number | null;

  readonly capsApplied: readonly ValuationCap[];
  readonly haircutsApplied: readonly ValuationHaircut[];

  /**
   * Advisory flags that don't cap a value or apply a haircut. Used for guardrails like
   * `EXIT_CAP_TOO_TIGHT` (architecture §9) where the valuation engine signals a concern but
   * doesn't change `finalValue`. Doctrine §11 reads these for penalty scoring.
   */
  readonly valuationFlags: readonly DoctrineFlag[];

  readonly anchorUsed: ValuationAnchor;
}

import { z } from 'zod';
import { ValidationError } from './errors';

export const SCORE_CONSISTENCY_TOLERANCE = 2;

/**
 * Final-score envelope. Only `underwriting_score` (deterministic) is permitted
 * in the final output. `ai_score` is allowed *alongside* as advisory metadata
 * but is rejected if anyone tries to use it as the final score — that check
 * lives in `assertFinalScore` below, not in the schema, because the schema
 * cannot see which field a downstream consumer reads.
 */
export const FinalScoreSchema = z
  .object({
    underwriting_score: z
      .number({ required_error: 'underwriting_score is required' })
      .finite('underwriting_score must be finite'),
    ai_score: z.number().finite().optional(),
  })
  .strict();

export type FinalScore = z.infer<typeof FinalScoreSchema>;

/**
 * Enforce the contract's score rules:
 *   1. final = underwriting_score (deterministic only).
 *   2. |final - recalculated| ≤ SCORE_CONSISTENCY_TOLERANCE.
 *
 * `recalculate` is the deterministic recomputation function — pass the same
 * function the pipeline uses upstream so any drift surfaces here.
 */
export function assertFinalScore(
  score: FinalScore,
  recalculatedScore: number,
): { final_score: number } {
  if (!Number.isFinite(recalculatedScore)) {
    throw new ValidationError('SCORE_INCONSISTENCY_ERROR', [
      {
        code: 'SCORE_INCONSISTENCY_ERROR',
        path: ['recalculated_score'],
        message: 'recalculated_score must be a finite number',
      },
    ]);
  }

  const final_score = score.underwriting_score;
  const drift = Math.abs(final_score - recalculatedScore);

  if (drift > SCORE_CONSISTENCY_TOLERANCE) {
    throw new ValidationError(
      'SCORE_INCONSISTENCY_ERROR',
      [
        {
          code: 'SCORE_INCONSISTENCY_ERROR',
          path: ['underwriting_score'],
          message: `score drift ${drift.toFixed(4)} exceeds tolerance ${SCORE_CONSISTENCY_TOLERANCE}`,
        },
      ],
      `SCORE_INCONSISTENCY_ERROR: |${final_score} - ${recalculatedScore}| = ${drift} > ${SCORE_CONSISTENCY_TOLERANCE}`,
    );
  }

  return { final_score };
}

/**
 * Reject any payload that attempts to put an AI score in the final-score slot.
 * Use this at the pipeline output boundary, after `assertFinalScore` has run.
 */
export function assertNoAiScoreInFinalOutput(output: Record<string, unknown>): void {
  const banned = ['ai_final_score', 'blended_score', 'hybrid_score', 'final_ai_score'];
  for (const key of banned) {
    if (key in output) {
      throw new ValidationError('AI_SCORE_IN_FINAL_OUTPUT_ERROR', [
        {
          code: 'AI_SCORE_IN_FINAL_OUTPUT_ERROR',
          path: [key],
          message: `field "${key}" is forbidden in final output — only underwriting_score is allowed`,
        },
      ]);
    }
  }
}

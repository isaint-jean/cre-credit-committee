import { z } from 'zod';
import { ValidationError, ValidationIssue } from './errors';

/**
 * Strict finite number — rejects NaN, ±Infinity, and silent string→number coercion.
 * `z.number()` already rejects strings; `.finite()` rejects NaN and Infinity.
 */
const StrictFiniteNumber = z
  .number({
    required_error: 'value is required',
    invalid_type_error: 'value must be a number (no string coercion)',
  })
  .finite('value must be finite (NaN and Infinity rejected)');

/** Strict positive number — required for loan_amount, cap_rate, interest_rate. */
const StrictPositiveNumber = StrictFiniteNumber.refine((n) => n > 0, {
  message: 'value must be > 0 (zero, negative, NaN are not allowed)',
});

/** ISO-8601 timestamp string. */
const IsoTimestamp = z
  .string({ required_error: 'timestamp is required', invalid_type_error: 'timestamp must be a string' })
  .min(1, 'timestamp must not be empty')
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'timestamp must be a valid ISO-8601 string' });

/**
 * Traceable numeric input: every required underwriting field carries this envelope.
 * Strips out any extra keys to prevent silent field injection.
 */
function traceableNumber(valueSchema: z.ZodType<number>) {
  return z
    .object({
      value: valueSchema,
      source: z
        .string({ required_error: 'source is required', invalid_type_error: 'source must be a string' })
        .min(1, 'source must not be empty'),
      timestamp: IsoTimestamp,
    })
    .strict();
}

export const TraceableNumberSchema = traceableNumber(StrictFiniteNumber);
export const TraceablePositiveNumberSchema = traceableNumber(StrictPositiveNumber);

/**
 * The hard input gate. NOI may be negative (a property can lose money), but the
 * other three must be strictly positive — a zero loan, zero cap rate, or zero
 * interest rate is a data error, not a valid scenario.
 */
export const UnderwritingInputSchema = z
  .object({
    loan_amount: TraceablePositiveNumberSchema,
    cap_rate: TraceablePositiveNumberSchema,
    interest_rate: TraceablePositiveNumberSchema,
    noi: TraceableNumberSchema,
    debt_service: TraceablePositiveNumberSchema.optional(),
  })
  .strict();

export type TraceableNumber = z.infer<typeof TraceableNumberSchema>;
export type UnderwritingInput = z.infer<typeof UnderwritingInputSchema>;

/**
 * Parse-or-throw entry point. Converts any Zod failure into a ValidationError
 * with the contract's error taxonomy. Missing required fields, NaN, empty
 * source, and bad timestamps are all distinguished by `code`.
 */
export function parseUnderwritingInput(raw: unknown): UnderwritingInput {
  const result = UnderwritingInputSchema.safeParse(raw);
  if (result.success) return result.data;

  const issues: ValidationIssue[] = result.error.issues.map((iss) => ({
    code: classifyIssue(iss),
    path: iss.path,
    message: iss.message,
  }));

  // Pick the most severe code as the top-level error code; precedence reflects
  // contract priority: traceability > numeric validity > completeness.
  const precedence: Record<string, number> = {
    MISSING_TRACEABILITY_ERROR: 3,
    INVALID_NUMERIC_VALUE_ERROR: 2,
    INCOMPLETE_INPUT_DATA_ERROR: 1,
  };
  const top = issues.reduce(
    (acc, i) => ((precedence[i.code] ?? 0) > (precedence[acc.code] ?? 0) ? i : acc),
    issues[0],
  );

  throw new ValidationError(top.code, issues);
}

function classifyIssue(iss: z.ZodIssue): ValidationIssue['code'] {
  const last = iss.path[iss.path.length - 1];
  if (last === 'source' || last === 'timestamp') return 'MISSING_TRACEABILITY_ERROR';
  if (last === 'value') return 'INVALID_NUMERIC_VALUE_ERROR';
  // Top-level missing fields (loan_amount, cap_rate, interest_rate, noi)
  if (iss.code === 'invalid_type' && iss.received === 'undefined') {
    return 'INCOMPLETE_INPUT_DATA_ERROR';
  }
  return 'INCOMPLETE_INPUT_DATA_ERROR';
}

/**
 * Field-bag assembler — public API.
 *
 * Lives in @cre/api/services. Consumed by the analysis pipeline inside
 * `evaluateFromAdjustedInputs` (per recon report §3) to project the
 * deal's HydratedRecordGraph into the engine's FieldBag shape, then run
 * the engine to produce FiredFlags as a parallel "handbook says"
 * annotation.
 *
 * Build-time safety:
 *   - KNOWN_FIELDS lists every field path the assembler recognizes
 *   - assertNoUnknownFields(handbook, KNOWN_FIELDS) — from
 *     @cre/handbook-engine's lint module — fails CI if the handbook
 *     introduces a new field path the assembler doesn't know about.
 *   - INTENTIONALLY_UNDEFINED_FIELDS and POPULATED_FIELDS partition
 *     KNOWN_FIELDS; a test asserts the partition holds.
 */

export { buildFieldBag } from './assembler.js';
export type { AssemblerInputs } from './assembler.js';
export {
  KNOWN_FIELDS,
  POPULATED_FIELDS,
  INTENTIONALLY_UNDEFINED_FIELDS,
} from './assembler.js';

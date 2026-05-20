/**
 * Rent-roll precedence policy for buildExtractionResult.
 *
 * XLSX wins when its outcome is `'ok'` AND its value has at least one unit.
 * The AI fallback (from the ASR adapter's rentRollFallback field) fills in
 * when the XLSX source is missing, empty, failed, or returned an `'ok'`
 * outcome with zero units. If neither source produces a non-empty rent roll,
 * returns null and downstream judgment surfaces JE_RENT_ROLL_MISSING.
 *
 * Pure function. No I/O. Deterministic over its inputs. Unit-tested across
 * a 13-row truth table in test-pick-rent-roll.ts.
 *
 * Matches the legacy analysis.routes.ts:695-710 fall-through behavior
 * (XLSX primary, AI-from-ASR secondary). The legacy third tier — AI-from-
 * Seller-UW-PDF — was dropped per the three-slot model decision (Finding 3
 * / Ticket E for production-traffic check).
 */

import type { RentRollExtraction } from '@cre/contracts';
import type { ExtractorOutcome } from './extractor-outcome.js';

export function pickRentRoll(
  xlsxOutcome: ExtractorOutcome<RentRollExtraction> | null | undefined,
  asrFallback: RentRollExtraction | null,
): RentRollExtraction | null {
  // XLSX wins when ok-with-non-empty-units.
  if (xlsxOutcome && xlsxOutcome.status === 'ok' && xlsxOutcome.value.units.length > 0) {
    return xlsxOutcome.value;
  }

  // Otherwise, AI fallback fills in when it has units.
  if (asrFallback !== null && asrFallback.units.length > 0) {
    return asrFallback;
  }

  return null;
}

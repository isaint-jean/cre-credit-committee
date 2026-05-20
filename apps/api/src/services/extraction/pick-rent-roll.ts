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
 * the 13-row truth table in test-pick-rent-roll.ts.
 *
 * Returns `{ value, source }` (Ticket D — per-extractor version metadata).
 * The `source` field carries which input won precedence so the composer can
 * stamp the right adapter version under `extractorVersions.rentRoll`:
 *   - 'xlsx'         — rent-roll-xlsx adapter's value won
 *   - 'asr_fallback' — ASR adapter's AI-extracted rentRollFallback won
 *   - null           — neither source produced a non-empty rent roll
 *
 * Matches the legacy analysis.routes.ts:695-710 fall-through behavior
 * (XLSX primary, AI-from-ASR secondary). The legacy third tier — AI-from-
 * Seller-UW-PDF — was dropped per the three-slot model decision (Finding 3
 * / Ticket E for production-traffic check).
 *
 * --- 13-row truth table (mirrors test-pick-rent-roll.ts) -------------------
 *
 *   #  xlsxOutcome             asrFallback        result.value    result.source
 *   1  absent (null/undef)     null               null            null
 *   2  absent                  populated          fallback        'asr_fallback'
 *   3  absent                  empty (units=[])   null            null
 *   4  failed                  null               null            null
 *   5  failed                  populated          fallback        'asr_fallback'
 *   6  failed                  empty              null            null
 *   7  empty                   null               null            null
 *   8  empty                   populated          fallback        'asr_fallback'
 *   9  empty                   empty              null            null
 *  10  ok, units=[]            null               null            null
 *  11  ok, units=[]            populated          fallback        'asr_fallback'
 *  12  ok, units=[…]           null               xlsx.value      'xlsx'
 *  13  ok, units=[…]           populated          xlsx.value      'xlsx'
 */

import type { RentRollExtraction } from '@cre/contracts';
import type { ExtractorOutcome } from './extractor-outcome.js';

export type PickRentRollSource = 'xlsx' | 'asr_fallback';

export interface PickRentRollResult {
  readonly value: RentRollExtraction | null;
  /** Which adapter won precedence. null when value is null (neither source
   *  produced a usable rent roll). */
  readonly source: PickRentRollSource | null;
}

export function pickRentRoll(
  xlsxOutcome: ExtractorOutcome<RentRollExtraction> | null | undefined,
  asrFallback: RentRollExtraction | null,
): PickRentRollResult {
  // XLSX wins when ok-with-non-empty-units.
  if (xlsxOutcome && xlsxOutcome.status === 'ok' && xlsxOutcome.value.units.length > 0) {
    return { value: xlsxOutcome.value, source: 'xlsx' };
  }

  // Otherwise, AI fallback fills in when it has units.
  if (asrFallback !== null && asrFallback.units.length > 0) {
    return { value: asrFallback, source: 'asr_fallback' };
  }

  return { value: null, source: null };
}

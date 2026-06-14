/**
 * Rent-roll adapter — sole call site of parseRentRollXlsx in the composer path.
 *
 * Status mapping (mirrors the parser's actual behavior at parse-rent-roll-xlsx.ts:178-247):
 *
 *   - wb.xlsx.load throws (corrupt buffer)                       → 'failed'
 *   - parser throws "no recognizable rent-roll header row found" → 'failed'
 *   - parser throws "worksheet not found" (explicit name)        → 'failed'
 *   - parser returns RentRoll with empty lines (header found,
 *     no tenant rows below — or only totals/empty rows)          → 'empty'
 *   - parser returns RentRoll with non-empty lines               → 'ok'
 *
 * Note: status mapping INVERTS the CF adapter's. parseRentRollXlsx throws where
 * extractCashFlowFromXlsx returns nulls. The adapter catches at the call-site and
 * routes throws to 'failed'.
 *
 * SourceDocumentRef emission:
 *   - ok: one ref [{ kind: 'rent_roll', contentHash }]. Single physical document,
 *     single semantic kind.
 *   - empty / failed: zero refs (same discipline as the CF adapter: don't stamp a
 *     kind we didn't actually extract — would mislead future readers of
 *     ExtractionResult.sourceDocuments).
 *
 * RentRoll → RentRollExtraction projection (Finding 1, decision 1a):
 *
 *   The adapter is the boundary between the legacy `RentRoll` shape (rich, 17 fields
 *   per line) and the new-spine `RentRollExtraction` shape (narrow, 9 fields per
 *   unit). The projection is INTENTIONALLY LOSSY — the new spine was designed with
 *   a focused field set for judgment/library/doctrine consumers, and we are NOT
 *   importing legacy fields into it. See `projectToRentRollExtraction` below for
 *   the full mapping table and the list of dropped legacy fields.
 *
 *   If a downstream consumer eventually needs squareFeet, leaseType, recoveries,
 *   TI/LC, or downtime on the new spine, widening RentRollExtraction is the right
 *   move — driven by a real consumer requirement, not by extractor-side convenience.
 *   Don't add fields to RentRollExtraction speculatively.
 *
 * Adapter version is local (RENT_ROLL_ADAPTER_VERSION). Ticket D will harvest
 * per-extractor versions into a new ExtractionResult field; until then the composer
 * projects only EXTRACTION_ENGINE_VERSION into the result.
 */

import type { RentRoll, RentRollExtraction, SourceDocumentRef } from '@cre/contracts';
import { computeBufferContentHash } from '../../../util/content-hash.js';
import { parseRentRollXlsx } from '../../parse-rent-roll-xlsx.js';
import type { ExtractorOutcome, SlotInput } from '../extractor-outcome.js';

/** Bump when this adapter's contract with downstream changes. Post-Ticket-D this
 *  becomes the per-extractor version stamped into
 *  ExtractionResult.extractorVersions['rent_roll']. */
export const RENT_ROLL_ADAPTER_VERSION = '0.1.0';

/**
 * Pure RentRoll → RentRollExtraction projection. Exported so the composer's
 * `pickRentRoll` policy helper can also consume RentRoll outputs from the ASR
 * adapter's AI fallback, and so unit tests can exercise the projection in
 * isolation.
 *
 * --- FIELD MAPPING TABLE (legacy `RentRollLine` → new `RentRollUnit`) -------
 *
 *   tenantName            → tenantName         (direct passthrough; null preserved)
 *   suite                 → unitId             (synthesis: legacy `suite` is nullable
 *                                                but new `unitId` is required-string;
 *                                                we synthesize `unit-${i+1}` when
 *                                                legacy was null. Deterministic for a
 *                                                given row order, but NOT stable across
 *                                                row-order changes between extractions.)
 *   status                → occupied           ('OCCUPIED' → true; VACANT/PRELEASED/
 *                                                HOLDOVER/UNKNOWN → false. LOSSY:
 *                                                PRELEASED units have a future tenant
 *                                                but are not currently occupied — the
 *                                                new shape collapses that distinction.)
 *   leaseStart            → leaseStart         (direct passthrough)
 *   leaseEnd              → leaseEnd           (direct passthrough)
 *   inPlaceRentAnnual     → inPlaceRentMonthly (annual / 12; null preserved when null.
 *                                                Pure unit conversion, not synthesis —
 *                                                null fidelity holds because null → null.)
 *
 * --- FIELDS WITH NO LEGACY SOURCE — always null in projection ---------------
 *
 *   baseRentMonthly       — legacy shape doesn't separate base rent from in-place rent
 *   concessions           — not captured in legacy shape
 *   securityDeposit       — not captured in legacy shape
 *
 * --- DROPPED LEGACY FIELDS (present in RentRollLine, absent in RentRollUnit) -
 *
 *   squareFeet, marketRentAnnual, leaseType, recoveriesAnnual, otherIncomeAnnual,
 *   newTiPsf, renewTiPsf, newLcPct, renewLcPct, downtimeMonths, notes
 *
 *   These are intentionally dropped — see the adapter header. If you arrived here
 *   grepping for any of these field names, the answer is: they live on the legacy
 *   `RentRoll` contract and are not carried into the new-spine `RentRollExtraction`.
 *
 * --- SUMMARY COMPUTATION ---------------------------------------------------
 *
 *   totalUnits         = lines.length                    (count of rows the parser kept)
 *   occupiedUnits      = count(line.status === 'OCCUPIED')
 *   economicOccupancy  = null                            (derived metric — would require
 *     sum(in-place rent for occupied) / sum(market rent), but marketRentAnnual is
 *     dropped here, and null-fidelity discipline forbids synthesizing aggregates
 *     from incomplete data. Contract makes the field nullable for exactly this reason.)
 */
export function projectToRentRollExtraction(rentRoll: RentRoll): RentRollExtraction {
  const lines = rentRoll.lines;

  // PR 3 batch 1 — discriminated-union honest projection. The legacy
  // projector only knew the tenant shape and lost ALL unit-side data
  // (concessions, monthly market rent, MTM semantics, bedrooms/unitType)
  // when called with multifamily lines. Now each variant maps to the
  // corresponding RentRollExtraction.units variant: tenant→TenantUnit
  // (existing behavior preserved byte-for-byte plus the kind stamp),
  // unit→ResidentialUnit (full multifamily field-set preserved).
  const units = lines.map((line, i): RentRollExtraction['units'][number] => {
    if (line.kind === 'tenant') {
      return {
        kind: 'tenant',
        unitId: line.suite === null ? `unit-${i + 1}` : line.suite,
        tenantName: line.tenantName,
        leaseStart: line.leaseStart,
        leaseEnd: line.leaseEnd,
        baseRentMonthly: null,
        inPlaceRentMonthly: line.inPlaceRentAnnual === null ? null : line.inPlaceRentAnnual / 12,
        occupied: line.status === 'OCCUPIED',
        concessions: null,
        securityDeposit: null,
      };
    }
    // line.kind === 'unit' — multifamily / MHC / student housing.
    return {
      kind: 'unit',
      unitId: line.unitId,
      bedrooms: line.bedrooms,
      bathrooms: line.bathrooms,
      unitType: line.unitType,
      leaseStart: line.leaseStart,
      leaseEndOrMTM: line.leaseEndOrMTM,            // null === MTM, semantic preserved
      baseRentMonthly: null,                         // not carried on the persisted UnitRentRollLine
      inPlaceRentMonthly: line.inPlaceRentMonthly,
      occupied: line.status === 'OCCUPIED',
      concessionsMonthly: line.concessionsMonthly,
      securityDeposit: line.securityDeposit,
    };
  });

  let occupiedCount = 0;
  for (const line of lines) {
    if (line.status === 'OCCUPIED') occupiedCount++;
  }

  return {
    units,
    summary: {
      totalUnits: lines.length,
      occupiedUnits: occupiedCount,
      economicOccupancy: null,
    },
  };
}

/**
 * Phase 1 (rent-roll-node): the 'ok' outcome's value now carries BOTH the
 * lossy `RentRollExtraction` projection (consumed today by the existing
 * downstream chain) AND the typed `RentRoll` (persisted as a first-class
 * graph node by the ingest layer; will be hydrated to the handbook
 * evaluator in Phase 2). The composer reads `typed` and exposes it as a
 * sibling output; the lossy `projection` continues to flow into
 * ExtractionResult.rentRoll unchanged.
 */
export interface RentRollAdapterValue {
  readonly projection: RentRollExtraction;
  readonly typed: RentRoll;
}

export async function runRentRollAdapter(
  slot: SlotInput,
): Promise<ExtractorOutcome<RentRollAdapterValue>> {
  const t0 = Date.now();

  let rentRoll: RentRoll;
  try {
    rentRoll = await parseRentRollXlsx(slot.buffer);
  } catch (err) {
    const e = err as Error;
    return {
      status: 'failed',
      sourceRefs: [],
      adapterVersion: RENT_ROLL_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      error: {
        name: e?.name ?? 'RentRollParseError',
        message: e?.message ?? 'rent-roll parse failed',
      },
    };
  }

  if (rentRoll.lines.length === 0) {
    return {
      status: 'empty',
      sourceRefs: [],
      adapterVersion: RENT_ROLL_ADAPTER_VERSION,
      durationMs: Date.now() - t0,
      reason: 'rent-roll header row found but no tenant rows extracted',
    };
  }

  const projection = projectToRentRollExtraction(rentRoll);
  const bufferHash = computeBufferContentHash(slot.buffer);
  const refs: SourceDocumentRef[] = [{ kind: 'rent_roll', contentHash: bufferHash }];

  return {
    status: 'ok',
    value: { projection, typed: rentRoll },
    sourceRefs: refs,
    adapterVersion: RENT_ROLL_ADAPTER_VERSION,
    durationMs: Date.now() - t0,
  };
}

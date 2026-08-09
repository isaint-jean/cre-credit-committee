/**
 * Slot-extraction projection (Data Room Tier 2c). PURE display projections of the
 * hydrated extraction nodes into the boundary-honoring DTOs — the raw
 * ExtractionResult / RentRoll node never leaves the server (§2.3 display-read rule).
 * Credit-free: extraction happened at ingest; this only surfaces it.
 */
import type { RentRoll, RentRollLine, RentRollSlotExtraction, RentRollUnitDTO } from '@cre/contracts';

export const RENT_ROLL_PAGE_SIZE = 50;

function tenantDetail(sqft: number | null): string | null {
  return sqft != null ? `${Math.round(sqft).toLocaleString('en-US')} SF` : null;
}

function lineToDTO(l: RentRollLine): RentRollUnitDTO {
  if (l.kind === 'tenant') {
    return {
      label: l.tenantName ?? l.suite ?? '(unnamed)',
      status: l.status,
      leaseStart: l.leaseStart,
      leaseEnd: l.leaseEnd,
      inPlaceRent: l.inPlaceRentAnnual,
      marketRent: l.marketRentAnnual,
      rentPeriod: 'annual',
      detail: tenantDetail(l.squareFeet),
      leaseType: l.leaseType,
    };
  }
  // residential/MHC unit line
  const bedBath = [
    l.bedrooms != null ? `${l.bedrooms}BR` : null,
    l.bathrooms != null ? `${l.bathrooms}BA` : null,
  ].filter(Boolean).join('/');
  const detail = l.unitType ?? (bedBath || tenantDetail(l.squareFeet));
  return {
    label: l.unitId,
    status: l.status,
    leaseStart: l.leaseStart,
    leaseEnd: l.leaseEndOrMTM,
    inPlaceRent: l.inPlaceRentMonthly,
    marketRent: l.marketRentMonthly,
    rentPeriod: 'monthly',
    detail,
    leaseType: null,
  };
}

/**
 * Project a hydrated RentRoll node → display DTO (summary + a bounded page of rows).
 * Summary excludes ancillary unit lines (isResidential === false), mirroring the
 * engine's own totalUnits/occupiedUnits filter convention. Page-bounded (default 50)
 * because MF rent rolls run to thousands of units.
 */
export function projectRentRoll(rentRoll: RentRoll, offset = 0, limit = RENT_ROLL_PAGE_SIZE): RentRollSlotExtraction {
  const lines = rentRoll.lines;
  const counted = lines.filter((l) => !(l.kind === 'unit' && l.isResidential === false));
  const totalUnits = counted.length;
  const occupiedUnits = counted.filter((l) => l.status === 'OCCUPIED').length;
  const occupancyPct = totalUnits > 0 ? occupiedUnits / totalUnits : null;

  const safeOffset = Math.max(0, offset);
  const page = lines.slice(safeOffset, safeOffset + limit).map(lineToDTO);

  return {
    kind: 'rent_roll',
    asOfDate: rentRoll.asOfDate,
    propertyName: rentRoll.propertyName,
    source: rentRoll.source,
    summary: { totalUnits, occupiedUnits, occupancyPct },
    units: page,
    totalCount: lines.length,
    offset: safeOffset,
    limit,
  };
}

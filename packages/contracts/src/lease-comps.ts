/**
 * Lease comparables — the servicer's manually-entered lease comps for a deal. Up to 4 comps,
 * each the shared fields + a PROPERTY-TYPE-DEPENDENT rate set + an optional photo. At export
 * they fill the workbook's "Lease Comps" tab (rows 7-10) + embed each photo into its region.
 *
 * ★ The rate columns (N/O/P) switch by asset type (the template's $X$5 toggle / X6:AA8 legend):
 *     Commercial (Office/Retail/Industrial/MixedUse/Other): Lease Type · Lease Rate · Exp. Reimb.
 *     Multifamily / SelfStorage / MHC:                       Concessions · Monthly Rent · Rent PSF
 *     Hotel:                                                 Rack Rate · ADR · RevPAR
 *   Every rate metric is modelled explicitly + optional; the fill writes the 3 that match the
 *   deal's asset type into N/O/P.
 *
 * ★ DISPLAY/EXPORT-ONLY, MINT-SAFE. Servicer input on the additive servicer_inputs TEXT column
 *   (fieldType 'lease_comps'). Never touches the mint. Honest-blank throughout. The SUBJECT row
 *   is auto-filled by the generator's named ranges — NOT part of this payload.
 */

/** One lease comp — every field optional (honest-blank when omitted). */
export interface LeaseComp {
  readonly buildingName: string | null;
  readonly address: string | null;
  readonly cityState: string | null;
  readonly distance: string | null;
  readonly direction: string | null;
  readonly totalSf: number | null;
  readonly yearBuilt: number | null;
  readonly yearRenov: number | null;
  readonly occupancy: number | null;       // 0..1 fraction

  // — Commercial rate metrics (N/O/P when Commercial) —
  readonly leaseType: string | null;
  readonly leaseRate: number | null;
  readonly expenseReimb: number | null;
  // — Multifamily / SelfStorage / MHC rate metrics —
  readonly concessions: number | null;
  readonly monthlyRent: number | null;
  readonly rentPsf: number | null;
  // — Hotel rate metrics —
  readonly rackRate: number | null;
  readonly adr: number | null;
  readonly revPar: number | null;

  readonly photoHash: string | null;
  readonly photoFileName: string | null;
}

export interface LeaseCompsPayload {
  readonly comps: readonly LeaseComp[];
}

export const EMPTY_LEASE_COMPS: LeaseCompsPayload = { comps: [] };
export const MAX_LEASE_COMPS = 4;

/** The rate-column mode driven by the template's $X$5 toggle. */
export type LeaseRateMode = 'commercial' | 'residential' | 'hotel';

/** Asset type → the rate-column mode (mirrors $X$5: Hospitality→hotel, MF/SS/MHC→residential, else→commercial). */
export function leaseRateModeForAssetType(assetType: string | null | undefined): LeaseRateMode {
  const t = (assetType ?? '').toLowerCase();
  if (/hotel|hospitality/.test(t)) return 'hotel';
  if (/multifamily|self.?storage|selfstorage|manufactured|\bmhc\b|\bmhp\b/.test(t)) return 'residential';
  return 'commercial';
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** Parse the stored JSON defensively — malformed / legacy → empty (never throws). Caps at 4. */
export function parseLeaseComps(raw: string | null | undefined): LeaseCompsPayload {
  if (!raw) return EMPTY_LEASE_COMPS;
  try {
    const o = JSON.parse(raw) as Partial<LeaseCompsPayload>;
    const comps = Array.isArray(o.comps)
      ? o.comps.slice(0, MAX_LEASE_COMPS).map((c) => {
          const q = (c ?? {}) as Partial<LeaseComp>;
          return {
            buildingName: strOrNull(q.buildingName),
            address: strOrNull(q.address),
            cityState: strOrNull(q.cityState),
            distance: strOrNull(q.distance),
            direction: strOrNull(q.direction),
            totalSf: numOrNull(q.totalSf),
            yearBuilt: numOrNull(q.yearBuilt),
            yearRenov: numOrNull(q.yearRenov),
            occupancy: numOrNull(q.occupancy),
            leaseType: strOrNull(q.leaseType),
            leaseRate: numOrNull(q.leaseRate),
            expenseReimb: numOrNull(q.expenseReimb),
            concessions: numOrNull(q.concessions),
            monthlyRent: numOrNull(q.monthlyRent),
            rentPsf: numOrNull(q.rentPsf),
            rackRate: numOrNull(q.rackRate),
            adr: numOrNull(q.adr),
            revPar: numOrNull(q.revPar),
            photoHash: strOrNull(q.photoHash),
            photoFileName: strOrNull(q.photoFileName),
          };
        })
      : [];
    return { comps };
  } catch {
    return EMPTY_LEASE_COMPS;
  }
}

/** Serialize a comps payload back to the stored JSON (caps at 4). */
export function serializeLeaseComps(payload: LeaseCompsPayload): string {
  return JSON.stringify({
    comps: payload.comps.slice(0, MAX_LEASE_COMPS).map((c) => ({
      buildingName: c.buildingName, address: c.address, cityState: c.cityState,
      distance: c.distance, direction: c.direction, totalSf: c.totalSf,
      yearBuilt: c.yearBuilt, yearRenov: c.yearRenov, occupancy: c.occupancy,
      leaseType: c.leaseType, leaseRate: c.leaseRate, expenseReimb: c.expenseReimb,
      concessions: c.concessions, monthlyRent: c.monthlyRent, rentPsf: c.rentPsf,
      rackRate: c.rackRate, adr: c.adr, revPar: c.revPar,
      photoHash: c.photoHash, photoFileName: c.photoFileName,
    })),
  });
}

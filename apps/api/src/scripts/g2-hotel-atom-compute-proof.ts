/**
 * G2 proof — the Hotel Property Detail atoms COMPUTE from available data, or
 * HONEST-BLANK where no source exists. In-memory only; touches no db.
 *
 * The seven bindable Hotel slots (J9/K9 parking, L8 land, L7 zoning, D13/D14/D17
 * #buildings/#stories/class) read resolvedContext.appraisal.{parkingSurface,
 * parkingCovered,landAreaAcres,zoningCode,numberOfBuildings,numberOfStories,
 * buildingClass} — the SAME atoms the Comm GROUP A (L3/L4/L11/H7) + GROUP B
 * (C11/C12/C15) cells use. The resolver passes them with the exact expression
 *   ALLOWED_OPS.passthrough((ctx as any).appraisal?.<field> ?? null)
 * (resolve-underwriting-context.ts). ALLOWED_OPS.passthrough is identity, so we
 * reproduce the `?? null` honest-blank semantics inline (compute vs blank),
 * exactly as the G1 proof did.
 *
 * The non-bindable cells stay honest-blank: FORMULA-DRIVEN (Total Rooms=Measure,
 * Year Built/Renovated/Date Acquired/Ownership via named ranges → P&L Summary)
 * or NO-SOURCE (Property Subtype, Clear Height, Outparcels, rentable-area
 * breakdown, STR occupancy/ADR/RevPAR, room mix, amenities, franchise terms —
 * the resolver has NO such atom). Never fabricated.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Wrapped in an IIFE so top-level identifiers (section/passthrough/withAppraisal/
// noAppraisal) don't collide with the identically-named consts in the sibling G1
// proof script under tsc's shared-scope project compilation.
(function main() {

function section(t: string) { console.log(`\n### ${t}`); }

section('Part 1 — 7 bindable Hotel slots via the resolver passthrough op (identity)');

const passthrough = <T>(v: T): T => v;
function resolveHotelAtoms(ctx: any) {
  const A = (f: string) => passthrough((ctx as any).appraisal?.[f] ?? null);
  return {
    'J9  parkingSurface':    A('parkingSurface'),
    'K9  parkingCovered':    A('parkingCovered'),
    'L8  landAreaAcres':     A('landAreaAcres'),
    'L7  zoningCode':        A('zoningCode'),
    'D13 numberOfBuildings': A('numberOfBuildings'),
    'D14 numberOfStories':   A('numberOfStories'),
    'D17 buildingClass':     A('buildingClass'),
  };
}

const withAppraisal: any = {
  property: { assetClass: 'hotel' },
  appraisal: {
    parkingSurface: 40, parkingCovered: 210, landAreaAcres: 2.9, zoningCode: 'CC-4-2',
    numberOfBuildings: 1, numberOfStories: 8, buildingClass: 'A',
  },
};
console.log('  WITH appraisal (COMPUTE):', JSON.stringify(resolveHotelAtoms(withAppraisal)));

const noAppraisal: any = { property: { assetClass: 'hotel' }, appraisal: undefined };
console.log('  NO appraisal (HONEST-BLANK):', JSON.stringify(resolveHotelAtoms(noAppraisal)));

section('Part 2 — non-bindable Hotel cells stay honest-blank (by category)');
console.log('  FORMULA-DRIVEN (self-populating via named ranges → P&L Summary; un-bindable):');
console.log('    D3=Measure (Total Rooms) · L4=Year_Built · L5=Year_Renovated · L6=Date_Acquired ·');
console.log('    L13=Ownership_Interest · D10/L9/L10=SUM/ratio · A1=Property_Name · STR index B24:D24 ·');
console.log('    room-mix % J22:L29 · franchise D38/D39 (=P&L Summary!F115/G115)');
console.log('  NO-SOURCE (honest-structural-blank; NO atom in resolver / EX-102 corpus — never fabricated):');
console.log('    L3 Property Subtype · D15 Outparcels · D16 Clear Height · D5:D9 rentable-area breakdown ·');
console.log('    STR Report B22:D23 (Subject/Comp-Set Occupancy/ADR/RevPAR) · Room Mix I22:K28 counts/sizes ·');
console.log('    Amenities A31:J35 · Franchise/Management fee & option terms → null (blank)');

})();

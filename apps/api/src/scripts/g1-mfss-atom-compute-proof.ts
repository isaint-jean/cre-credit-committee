/**
 * G1 proof — the MF/SS Property Detail atoms COMPUTE from available data, or
 * HONEST-BLANK where no source exists. In-memory only; touches no db.
 *
 * Two parts:
 *  (1) The BINDABLE slots (C16/C17 parking, G7 zoning, G9 land) read
 *      resolvedContext.appraisal.{parkingSurface,parkingCovered,zoningCode,
 *      landAreaAcres} — the SAME atoms the Comm GROUP A cells use. Prove they
 *      pass through the resolver from a synthetic appraisal ctx (compute) and
 *      go null when the appraisal is absent (honest-blank).
 *  (2) The UNIT-MIX economics (No. Units / Avg Size / UW Rent PSF / UW Rent)
 *      are template-formula-driven on the sheet (un-bindable). The ONLY
 *      derivable economic figure is revenue-per-SF = revenue / netRentableSF,
 *      computable from a corpus PropertyComponent where BOTH exist; honest-blank
 *      (null) otherwise. No unit COUNT source exists in the PropertyComponent
 *      shape → unit-mix stays honest-blank-pending-source.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

function section(t: string) { console.log(`\n### ${t}`); }

// ---- Part 1: bindable appraisal atoms (compute vs honest-blank) ----
// The resolver passes these four atoms through with the exact expression
//   ALLOWED_OPS.passthrough((ctx as any).appraisal?.<field> ?? null)
// (resolve-underwriting-context.ts lines ~446-450). ALLOWED_OPS.passthrough is
// identity (shape-only, no transform), so we reproduce it inline here to
// exercise the exact `?? null` honest-blank semantics without changing the
// resolver's export surface.
section('Part 1 — bindable MF/SS slots via the resolver passthrough op (identity)');

const passthrough = <T>(v: T): T => v;
function resolveAppraisalAtoms(ctx: any) {
  const A = (f: string) => passthrough((ctx as any).appraisal?.[f] ?? null);
  return {
    'C16 parkingSurface': A('parkingSurface'),
    'C17 parkingCovered': A('parkingCovered'),
    'G7  zoningCode':      A('zoningCode'),
    'G9  landAreaAcres':   A('landAreaAcres'),
  };
}

const withAppraisal: any = {
  property: { assetClass: 'multifamily' },
  appraisal: { parkingSurface: 0, parkingCovered: 240, zoningCode: 'RM-4-10', landAreaAcres: 5.2 },
};
console.log('  WITH appraisal (COMPUTE):', JSON.stringify(resolveAppraisalAtoms(withAppraisal)));
const noAppraisal: any = { property: { assetClass: 'self_storage' }, appraisal: undefined };
console.log('  NO appraisal (HONEST-BLANK):', JSON.stringify(resolveAppraisalAtoms(noAppraisal)));

// ---- Part 2: derivable per-SF economics from a corpus PropertyComponent ----
section('Part 2 — revenue-per-SF (derivable) vs unit-mix (honest-blank-pending-source)');

interface MiniComponent {
  propertyType: string | null;
  netRentableSF: number | null;
  revenue: number | null;
  occupancyPct: number | null;
}
// derive revenue/SF where BOTH exist; null otherwise (never substitute 0)
function revenuePerSf(c: MiniComponent): number | null {
  if (c.revenue == null || c.netRentableSF == null || c.netRentableSF === 0) return null;
  return c.revenue / c.netRentableSF;
}

// Synthetic self-storage component (mirrors the EX-102 Prime-Storage corpus shape)
const ssComp: MiniComponent = { propertyType: 'Self-Storage', netRentableSF: 78_500, revenue: 1_452_000, occupancyPct: 0.91 };
const partialComp: MiniComponent = { propertyType: 'Multifamily', netRentableSF: null, revenue: 3_100_000, occupancyPct: 0.95 };

console.log('  SS comp revenue/SF (COMPUTE):', revenuePerSf(ssComp)?.toFixed(2), '$/SF  | occupancy(present):', ssComp.occupancyPct);
console.log('  partial comp revenue/SF (HONEST-BLANK, no SF):', revenuePerSf(partialComp));
console.log('  unit COUNT / unit-mix (HONEST-BLANK-PENDING-SOURCE): null — PropertyComponent has netRentableSF/revenue/noi/occupancy but NO unit count; EX-102/corpus carries no rent roll. Unit-mix table cells are template-formula-driven (read P&L Summary rent roll) → un-bindable.');

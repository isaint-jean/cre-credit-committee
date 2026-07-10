/**
 * uncollapse-ex102-properties.ts — PORTFOLIO PHASE 1
 *
 * The UN-COLLAPSE seam, productionized. Turns a parsed EX-102 asset-data file
 * (CmbsCompExtraction, from extract-cmbs-comps.ts) into the multi-property
 * model — the N per-property children of a loan secured by N properties — so
 * `ExtractionResult.properties` can carry them instead of the pipeline
 * flattening to one property.
 *
 * ★ Provenance: this is the spike's logic (portfolio-spike1-ex102-uncollapse.ts,
 * committed 0f2cf31) lifted to a reusable function. The spike PROVED the 5
 * Prime Storage-Blue components (comps.db `19-001..005`) survive as 5 structured
 * per-property records with real NOI / value / capRate / occupancy, matched to
 * comps.db to the dollar.
 *
 * ★ THE INVARIANT: this is ADDITIVE. It produces the `PropertyComponent[]` that
 * a MULTI-property deal stores on `ExtractionResult.properties`. The
 * single-property path never calls this; its inline fields are untouched, so
 * single-property results stay byte-identical.
 *
 * FINDING (from the spike): in an EX-102 the components are ALREADY N
 * independent `<assets>` blocks (assetNumber `19-001..005`), PLUS a separate
 * aggregate roll-up block (assetNumber `19`, "Blue Portfolio"). The only
 * net-new work is the parent↔child LINK: recognize `19-001..005` as children
 * of roll-up `19` via the assetNumber prefix. No lossy collapse exists in the
 * parser — "collapse to one DealBag" was always a downstream CHOICE.
 *
 * NO doctrine, NO scoring, NO DB writes. Pure struct→struct.
 */
import type { CmbsCompExtraction, CompRecord, PropertyComponent } from '@cre/contracts';

/**
 * Split a parsed EX-102 into { parents, componentsByParent }.
 *
 * A record is a CHILD when its assetNumber matches `<parent>-NNN` (e.g.
 * `19-001`); the `<parent>` prefix (`19`) is a PARENT roll-up. Records with a
 * bare assetNumber that is NOT a parent-of-any-child are stand-alone single-
 * property loans (the common case) and are returned as their own group with an
 * empty child list.
 */
function groupByRollUp(comps: readonly CompRecord[]): {
  readonly childrenByParent: ReadonlyMap<string, CompRecord[]>;
} {
  const childrenByParent = new Map<string, CompRecord[]>();
  for (const c of comps) {
    const an = c.assetNumber ?? '';
    const m = an.match(/^(\d+)-(\d{3})$/);
    if (!m) continue;
    const parent = m[1];
    const list = childrenByParent.get(parent) ?? [];
    list.push(c);
    childrenByParent.set(parent, list);
  }
  return { childrenByParent };
}

/** One CompRecord → one PropertyComponent (the per-property surface). */
function toPropertyComponent(
  c: CompRecord,
  ordinal: number,
  parentAssetNumber: string,
): PropertyComponent {
  return {
    ordinal,
    componentId: c.assetNumber,
    parentAssetNumber,
    propertyName: c.propertyName,
    address: c.address,
    city: c.city,
    state: c.state,
    zip: c.zip,
    propertyType: c.propertyType,
    netRentableSF: c.netRentableSF,
    yearBuilt: c.yearBuilt,
    value: c.value,
    valuationDate: c.valuationDate,
    noi: c.noi,
    ncf: c.ncf,
    revenue: c.revenue,
    occupancyPct: c.occupancyPct,
    capRate: c.capRate,
  };
}

/**
 * Un-collapse the children of ONE roll-up loan into the multi-property model.
 *
 * Given a parsed EX-102 and the parent roll-up's assetNumber (e.g. `19`),
 * returns the N `PropertyComponent` children (sorted by assetNumber). Returns
 * an empty array when the parent has no `NNN`-suffixed children (a
 * single-property loan — NOT a portfolio; caller keeps the inline path).
 */
export function uncollapseRollUp(
  ext: CmbsCompExtraction,
  parentAssetNumber: string,
): readonly PropertyComponent[] {
  const { childrenByParent } = groupByRollUp(ext.comps);
  const children = (childrenByParent.get(parentAssetNumber) ?? [])
    .slice()
    .sort((a, b) => (a.assetNumber ?? '').localeCompare(b.assetNumber ?? ''));
  return children.map((c, i) => toPropertyComponent(c, i + 1, parentAssetNumber));
}

/**
 * Discover every multi-property roll-up in a parsed EX-102 and un-collapse
 * each. Returns a map parentAssetNumber → PropertyComponent[]. Single-property
 * loans (no `NNN`-suffixed children) do NOT appear — this yields ONLY the
 * loans that are genuinely secured by N > 1 properties.
 */
export function uncollapseAllRollUps(
  ext: CmbsCompExtraction,
): ReadonlyMap<string, readonly PropertyComponent[]> {
  const { childrenByParent } = groupByRollUp(ext.comps);
  const out = new Map<string, readonly PropertyComponent[]>();
  for (const parent of childrenByParent.keys()) {
    out.set(parent, uncollapseRollUp(ext, parent));
  }
  return out;
}

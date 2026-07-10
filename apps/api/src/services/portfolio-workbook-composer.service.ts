/**
 * portfolio-workbook-composer.service.ts — PORTFOLIO PHASE 4
 *
 * The portfolio workbook RENDER — turns a multi-property (roll_up, N>1) deal
 * into a real .xlsx: N per-property LEAF tabs (cloned) + roll-up tabs (built
 * once), via the PROVEN workbook-composition path (Phase-0 spike 0f2cf31).
 *
 * ★★ ADDITIVE ORCHESTRATION. This is a NEW module that sits ON TOP of the
 * existing render/export machinery. It does NOT touch:
 *   - the four-axis render schema key / fingerprints (render-schema.ts) —
 *     GUARDRAIL 2. Composition names sheets at the WORKBOOK layer; cellBindings
 *     stay flat ("SheetName!Addr"), so no ordinal axis is added anywhere.
 *   - the single-property (N=1) render/export path — GUARDRAIL (N=1). This code
 *     is NEVER called on the single-property path; that path is byte-identical.
 *
 * ★ GUARDRAIL 1 — LEAF-TABS-FIRST. Only SELF-CONTAINED per-property LEAF tabs
 *   are CLONED ×N (Property Detail — the spike's proven tab). Roll-up /
 *   aggregate tabs are built ONCE from the Phase-2 aggregation, NOT cloned.
 *
 * ★ HONEST-BLANK discipline (Phase 3). Computed cells are real (blended value,
 *   blended cap, concentration level); the honest-NULL DSCR (pari-passu,
 *   whole-loan debt service absent) renders as a LABELED BLANK, never a fake
 *   number; judgment cells (cross-collateral / release / market view) render as
 *   the visible DATA_NOT_PROVIDED sentinel, never fabricated.
 *
 * ★ CROSS-SHEET FORMULAS (the sharp edge). The roll-up tabs write VALUES
 *   computed in the Phase-2 aggregation layer — NOT live cross-sheet formulas
 *   referencing the namespaced per-property sheets. This is the safer choice the
 *   spike flagged: a live "=SUM('Prop 19-001'!…)+…" would have to be re-pointed
 *   across N namespaced sheets and round-trip through ExcelJS; a value computed
 *   upstream (Σvalue = $91.2M, already proven to the dollar in Phase 2) is
 *   deterministic and cannot drift. See CROSS_SHEET_FORMULA_DECISION below.
 *
 * NO DB writes. Reads the template from disk + a caller-supplied
 * PortfolioAggregation (Phase 2). Returns a workbook Buffer.
 */
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import type { PropertyComponent } from '@cre/contracts';
import type {
  PortfolioAggregation,
  PortfolioStructureTerms,
} from './portfolio-aggregator.service.js';
import {
  evaluatePortfolioConcentration,
  type ConcentrationLevel,
} from './portfolio-concentration.js';

/**
 * ★ CROSS-SHEET-FORMULA DECISION (reported): VALUES-FROM-AGGREGATION.
 * Every roll-up cell that would otherwise be a cross-sheet SUM/aggregate is
 * written as a VALUE computed in the Phase-2 aggregation layer. No roll-up tab
 * carries a live "=…'Prop 19-00N'!…" formula. Rationale: (1) the aggregation is
 * already proven to the dollar/bp against the PSB rollup row; (2) a live
 * cross-sheet formula would have to survive ExcelJS round-trip AND sheet-name
 * namespacing (31-char cap, spaces → quoted refs) — a fragility the spike
 * explicitly flagged; (3) a written value cannot silently drift. Per-property
 * LEAF tabs likewise get VALUES (the property's own data), preserving whatever
 * INTRA-sheet formulas the template leaf already carries.
 */
export const CROSS_SHEET_FORMULA_DECISION = 'values-from-aggregation' as const;

/** The label written into an honest-blank cell (pari-passu DSCR, judgment). */
export const HONEST_BLANK_DSCR_LABEL =
  'n/a — whole-loan debt service not provided (pari-passu)';

/* ------------------------------------------------------------------ */
/*  CF sanitizer — verbatim port of template-engine.service.ts        */
/* ------------------------------------------------------------------ */

/** ExcelJS writeBuffer crashes on CF rules with empty `formulae`; the BP Spiral
 *  .xlsm ships rules it can't round-trip. Verbatim port of the production
 *  sanitizer so the composed workbook serializes on the same terms. */
function sanitizeConditionalFormatting(workbook: ExcelJS.Workbook): number {
  const FORMULA_TYPES = new Set([
    'expression', 'cellIs', 'top10', 'aboveAverage', 'containsText', 'timePeriod',
  ]);
  let dropped = 0;
  workbook.eachSheet((ws) => {
    const cfList = (ws as unknown as { conditionalFormattings?: unknown }).conditionalFormattings;
    if (!Array.isArray(cfList)) return;
    for (const cf of cfList) {
      if (!Array.isArray(cf.rules)) continue;
      cf.rules = cf.rules.filter((r: { type?: string; formulae?: unknown[] }) => {
        const t = r?.type;
        if (t === undefined || !FORMULA_TYPES.has(t)) return true;
        if (Array.isArray(r.formulae) && r.formulae.length > 0) return true;
        dropped++;
        return false;
      });
    }
  });
  return dropped;
}

/* ------------------------------------------------------------------ */
/*  Sheet naming (31-char Excel cap)                                   */
/* ------------------------------------------------------------------ */

/** Deterministic, unique, ≤31-char per-property sheet name. Uses the ordinal to
 *  guarantee uniqueness even when two property names collide after truncation. */
export function leafSheetName(c: PropertyComponent): string {
  const base = `P${c.ordinal} ${c.propertyName ?? c.componentId ?? 'Property'}`;
  return base.slice(0, 31);
}

/* ------------------------------------------------------------------ */
/*  Options + result                                                   */
/* ------------------------------------------------------------------ */

export interface ComposePortfolioWorkbookOptions {
  /** Absolute path to the .xlsm/.xlsx template to clone the leaf tab from. */
  readonly templatePath: string;
  /** The template sheet name to CLONE ×N as the per-property leaf (Guardrail 1:
   *  a self-contained leaf tab — e.g. 'Property Detail - MF SS MHP'). */
  readonly leafTemplateSheetName: string;
  /** The Phase-1 per-property components (N>1 for a portfolio). */
  readonly components: readonly PropertyComponent[];
  /** The Phase-2 aggregation (roll-up math + honest-blank judgment cells). */
  readonly aggregation: PortfolioAggregation;
}

export interface ComposePortfolioWorkbookResult {
  readonly buffer: Buffer;
  /** All sheet names in the composed workbook (template sheets + leaves + roll-ups). */
  readonly sheetNames: readonly string[];
  /** The N cloned per-property leaf sheet names (Guardrail 1: only these are cloned). */
  readonly leafSheetNames: readonly string[];
  /** The roll-up sheet names built ONCE (Guardrail 1: not cloned). */
  readonly rollUpSheetNames: readonly string[];
  /** Count of CF rules stripped by the sanitizer (diagnostic). */
  readonly cfRulesDropped: number;
}

/* ------------------------------------------------------------------ */
/*  Leaf-tab cloning — spike model deep-copy, productionized           */
/* ------------------------------------------------------------------ */

/**
 * Clone the template leaf sheet into a new uniquely-named sheet and populate it
 * with ONE property's real data. Model deep-copy preserves the template leaf's
 * columns / merges / styles / INTRA-sheet formulas (spike-proven).
 *
 * ★ Only VALUES are written into stable header cells; the leaf's own formulas
 *   are preserved by the deep-copy and are NOT overwritten.
 */
function cloneLeafForProperty(
  wb: ExcelJS.Workbook,
  templateLeafName: string,
  c: PropertyComponent,
): string {
  const src = wb.getWorksheet(templateLeafName);
  if (!src) throw new Error(`leaf template sheet "${templateLeafName}" not found in template`);

  const newName = leafSheetName(c);
  const copy = wb.addWorksheet(newName);
  const model = JSON.parse(JSON.stringify(src.model));
  model.name = newName;
  model.id = copy.id;
  (copy as unknown as { model: unknown }).model = model;

  // Re-fetch after model assignment; write per-property VALUES into a stable
  // header block. (Real schema binding would target the leaf's declared
  // addresses; the composition proves distinct per-property data survives at the
  // workbook layer with a flat "SheetName!Addr" write.)
  const ws = wb.getWorksheet(newName)!;
  const capPct = typeof c.capRate === 'number' ? c.capRate : null;
  const occPct = typeof c.occupancyPct === 'number' ? c.occupancyPct : null;
  const rows: Array<[string, string, string | number | null]> = [
    ['A1', 'Property', c.propertyName],
    ['A2', 'Component ID', c.componentId],
    ['A3', 'Address', c.address],
    ['A4', 'City, State', c.city && c.state ? `${c.city}, ${c.state}` : c.state],
    ['A5', 'Property Type', c.propertyType],
    ['A6', 'Net Rentable SF', c.netRentableSF],
    ['A7', 'Year Built', c.yearBuilt],
    ['A8', 'Appraised Value', c.value],
    ['A9', 'NOI', c.noi],
    ['A10', 'NCF', c.ncf],
    ['A11', 'Cap Rate', capPct],
    ['A12', 'Occupancy', occPct],
  ];
  for (const [addr, label, value] of rows) {
    const row = Number(addr.slice(1));
    ws.getCell(`A${row}`).value = label;
    // Honest-blank: leave the value cell EMPTY (not 0) when the source is null.
    ws.getCell(`B${row}`).value = value === null || value === undefined ? null : value;
  }
  return newName;
}

/* ------------------------------------------------------------------ */
/*  Roll-up tabs — built ONCE from the Phase-2 aggregation (values)    */
/* ------------------------------------------------------------------ */

/** Write a label→value row pair; honest-blank value cells stay empty. */
function kv(ws: ExcelJS.Worksheet, row: number, label: string, value: string | number | null): void {
  ws.getCell(`A${row}`).value = label;
  ws.getCell(`B${row}`).value = value === null || value === undefined ? null : value;
}

function buildPortfolioSummaryTab(wb: ExcelJS.Workbook, agg: PortfolioAggregation): string {
  const name = 'Portfolio Summary';
  const ws = wb.addWorksheet(name);
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 26;
  const m = agg.math;
  let r = 1;
  ws.getCell(`A${r++}`).value = 'PORTFOLIO SUMMARY (roll-up — built once)';
  r++;
  kv(ws, r++, 'Property count', m.loanCount);
  kv(ws, r++, 'Blended value (Σ value)', m.blendedValue);
  kv(ws, r++, 'Aggregate NOI (Σ NOI)', m.aggregateNoi);
  kv(ws, r++, 'Aggregate NCF (Σ NCF)', m.aggregateNcf);
  kv(ws, r++, 'Blended cap rate (ΣNOI ÷ Σvalue)', m.blendedCapRate);
  // ★ HONEST-BLANK DSCR — pari-passu: value cell EMPTY, adjacent label states why.
  if (m.aggregateDscr === null) {
    ws.getCell(`A${r}`).value = 'Aggregate DSCR';
    ws.getCell(`B${r}`).value = null; // visibly blank — NOT a fabricated number
    ws.getCell(`C${r}`).value = HONEST_BLANK_DSCR_LABEL;
    r++;
  } else {
    kv(ws, r++, 'Aggregate DSCR', m.aggregateDscr);
  }
  r++;
  ws.getCell(`A${r++}`).value = 'Methodology';
  ws.getCell(`A${r++}`).value = agg.rollUpAggregation.aggregationMethodology;
  return name;
}

function buildConcentrationTab(wb: ExcelJS.Workbook, agg: PortfolioAggregation): string {
  const name = 'Concentration';
  const ws = wb.addWorksheet(name);
  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 24;
  const c = agg.math.concentration;
  // Re-run the Phase-3 dimension to surface the "elevated" tier + level.
  const dim = evaluatePortfolioConcentration({ loanCount: agg.math.loanCount, concentration: c });
  const level = (dim.derivedOutputs?.concentrationLevel as ConcentrationLevel | undefined) ?? null;
  let r = 1;
  ws.getCell(`A${r++}`).value = 'CONCENTRATION (roll-up — built once)';
  r++;
  kv(ws, r++, 'Top property', c.topPropertyName);
  kv(ws, r++, 'Top-property value share', c.topPropertyValueShare);
  kv(ws, r++, 'Herfindahl index', c.herfindahlIndex);
  kv(ws, r++, 'Effective properties (1/HHI)', c.effectiveProperties);
  kv(ws, r++, 'Base dispersion tier', dim.tier);
  kv(ws, r++, 'Risk contribution', dim.riskContribution);
  kv(ws, r++, 'Concentration level', level);
  r++;
  ws.getCell(`A${r++}`).value = 'Geographic mix (by state)';
  for (const s of c.geographicMixByState) kv(ws, r++, `  ${s.key}`, s.valueShare);
  r++;
  ws.getCell(`A${r++}`).value = 'Asset-class mix';
  for (const s of c.assetClassMix) kv(ws, r++, `  ${s.key}`, s.valueShare);
  return name;
}

function structureCell(v: string): string {
  // The DATA_NOT_PROVIDED sentinel is written VERBATIM so the honest blank is
  // VISIBLE in the cell (a labeled blank, never fabricated).
  return v;
}

function buildAllocationReleaseTab(wb: ExcelJS.Workbook, ps: PortfolioStructureTerms): string {
  const name = 'Allocation & Release';
  const ws = wb.addWorksheet(name);
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 60;
  let r = 1;
  ws.getCell(`A${r++}`).value = 'ALLOCATION & RELEASE — portfolio structure (built once)';
  r++;
  // ★ Judgment cells: the DATA_NOT_PROVIDED sentinel is rendered VISIBLY — never
  //   a fabricated release price / cross-collateral verdict.
  kv(ws, r++, 'Cross-collateralized', structureCell(ps.crossCollateralized));
  kv(ws, r++, 'Cross-defaulted', structureCell(ps.crossDefaulted));
  kv(ws, r++, 'Release provisions', structureCell(ps.releaseProvisions));
  kv(ws, r++, 'Release price basis', structureCell(ps.releasePriceBasis));
  kv(ws, r++, 'Substitution rights', structureCell(ps.substitutionRights));
  kv(ws, r++, 'Source', structureCell(ps.source));
  return name;
}

function buildBlendedProFormaTab(wb: ExcelJS.Workbook, agg: PortfolioAggregation): string {
  const name = 'Blended Pro-Forma';
  const ws = wb.addWorksheet(name);
  ws.getColumn(1).width = 30;
  for (let i = 2; i <= 6; i++) ws.getColumn(i).width = 18;
  // Header: one column per property + a Portfolio total (VALUE, not a live SUM).
  ws.getCell('A1').value = 'BLENDED PRO-FORMA (roll-up — built once)';
  const comps = agg.scoredComponents;
  ws.getCell('A3').value = 'Line item';
  comps.forEach((s, i) => { ws.getCell(3, 2 + i).value = s.propertyName ?? s.componentId; });
  ws.getCell(3, 2 + comps.length).value = 'Portfolio';
  const m = agg.math;
  const writeLine = (row: number, label: string, per: (i: number) => number | null, total: number | null): void => {
    ws.getCell(row, 1).value = label;
    comps.forEach((_s, i) => {
      const v = per(i);
      ws.getCell(row, 2 + i).value = v === null ? null : v;
    });
    // ★ Portfolio total is a VALUE from the aggregation (Σ proven upstream), NOT
    //   a live "=SUM(...)" across the property columns. See CROSS_SHEET decision.
    ws.getCell(row, 2 + comps.length).value = total === null ? null : total;
  };
  const compArr = agg.scoredComponents;
  writeLine(4, 'Value', (i) => compArr[i]?.dealBag.concludedValue ?? null, m.blendedValue);
  writeLine(5, 'NOI', (i) => compArr[i]?.dealBag.uwY1Noi ?? null, m.aggregateNoi);
  // NCF is not on the DealBag; pull from math aggregate only (per-property NCF
  // lives on the component, but the composer only carries the scored view here).
  ws.getCell(6, 1).value = 'Aggregate NCF';
  ws.getCell(6, 2 + comps.length).value = m.aggregateNcf;
  return name;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compose a portfolio workbook: clone the leaf tab ×N + build roll-up tabs once.
 *
 * ★ FIRES ONLY for N>1. The caller MUST gate on `components.length > 1`; a
 *   single-property deal NEVER reaches here (the existing single-property render
 *   path handles N=1 unchanged). This function throws on N≤1 to make the
 *   invariant a hard guarantee rather than a convention.
 */
export async function composePortfolioWorkbook(
  opts: ComposePortfolioWorkbookOptions,
): Promise<ComposePortfolioWorkbookResult> {
  const { templatePath, leafTemplateSheetName, components, aggregation } = opts;

  if (components.length <= 1) {
    throw new Error(
      `composePortfolioWorkbook is portfolio-only (N>1); got N=${components.length}. ` +
        'The single-property (N=1) render/export path is unchanged and must be used instead.',
    );
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(templatePath) as never);

  // ★ GUARDRAIL 1 — clone ONLY the self-contained leaf tab, ×N (one per property).
  const leafSheetNames: string[] = [];
  for (const c of components) {
    leafSheetNames.push(cloneLeafForProperty(wb, leafTemplateSheetName, c));
  }

  // Roll-up tabs — built ONCE from the Phase-2 aggregation (NOT cloned).
  const rollUpSheetNames: string[] = [
    buildPortfolioSummaryTab(wb, aggregation),
    buildConcentrationTab(wb, aggregation),
    buildAllocationReleaseTab(wb, aggregation.portfolioStructure),
    buildBlendedProFormaTab(wb, aggregation),
  ];

  const cfRulesDropped = sanitizeConditionalFormatting(wb);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());

  const sheetNames: string[] = [];
  wb.eachSheet((ws) => sheetNames.push(ws.name));

  return { buffer, sheetNames, leafSheetNames, rollUpSheetNames, cfRulesDropped };
}

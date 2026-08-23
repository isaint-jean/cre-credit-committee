/**
 * export-portfolio-dispatch.service.ts — PORTFOLIO LAST-MILE, STEP B (helper)
 *
 * The ADDITIVE `/export` dispatch decision, kept out of render.routes.ts so the
 * route change is a single, small, additive branch:
 *
 *   roll_up mode  AND  extractionResult.properties present (N>1)
 *       → composePortfolioWorkbook(...)            (the proven 38-sheet render)
 *   else
 *       → the EXISTING single-property render/export path (UNCHANGED else).
 *
 * ★ INVARIANT: this NEVER runs for the single-property path. `resolvePortfolio`
 *   returns null unless BOTH the caller's underwritingMode is 'roll_up' AND the
 *   resolved deal's ExtractionResult carries `properties` with length > 1. A
 *   single-property deal (properties absent / null / length ≤ 1) → null → the
 *   route falls through to the existing pipeline byte-identically.
 *
 * ★ Does NOT touch the four-axis render schema key / fingerprints. The portfolio
 *   workbook is composed at the WORKBOOK layer (leaf-clone + roll-up tabs), the
 *   same additive path the P4 render proof exercises.
 *
 * Reads only (graph store + sqlite store). No DB writes.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RevisionId, ExtractionResultId, PropertyComponent } from '@cre/contracts';
import type { RecordGraphStore } from '../storage/record-graph-store.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import { resolveAnalysisForRead } from './resolve-analysis-for-read.js';
import { aggregatePortfolio } from './portfolio-aggregator.service.js';
import { resolveManualPortfolioComponents } from './portfolio-structure.service.js';
import { resolveDealModeForAnalysis } from './deal-mode.service.js';
import {
  composePortfolioWorkbook,
  type ComposePortfolioWorkbookResult,
} from './portfolio-workbook-composer.service.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The on-disk template whose leaf tab is cloned per property. The portfolio
 *  render composes from this directly — it does NOT depend on a registered
 *  roll_up template artifact (there is deliberately no schema-key coupling). */
export const PORTFOLIO_TEMPLATE_PATH = resolve(
  REPO,
  'docs/specs/uw-template-populator/Blank_UW_Template_v2.xlsm',
);
/** The self-contained leaf tab cloned ×N (self_storage leaf per render-schema),
 *  identical to the P4 render proof. */
export const PORTFOLIO_LEAF_SHEET = 'Property Detail - MF SS MHP';

export interface PortfolioExport {
  readonly analysisId: string;
  readonly analysisName: string;
  readonly components: readonly PropertyComponent[];
  readonly workbook: ComposePortfolioWorkbookResult;
}

/**
 * Fetch the resolved deal's ExtractionResult.properties off the graph spine
 * (analysis → HEAD envelope → doctrine eval → extraction_result). Returns null
 * for a deal with no graph revision, no doctrine, or no `properties`.
 */
function resolvePropertiesFromGraph(
  graphRevisionId: string | null | undefined,
  recordGraphStore: RecordGraphStore,
): readonly PropertyComponent[] | null {
  if (!graphRevisionId) return null;
  const envelope = recordGraphStore.getRevisionEnvelope(graphRevisionId as RevisionId);
  if (envelope === null) return null;
  const doctrine = recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (doctrine === null) return null;
  const er = recordGraphStore.getExtractionResult(
    doctrine.extractionResultId as ExtractionResultId,
  );
  const props = er?.properties;
  return props && props.length > 0 ? props : null;
}

/**
 * Decide whether `/export` should dispatch to the portfolio composer, and if so
 * compose the workbook. Returns null (→ the existing single-property path) when:
 *   - underwritingMode is not 'roll_up', OR
 *   - the deal does not resolve, OR
 *   - the deal's ExtractionResult carries no `properties` with N>1.
 *
 * @param dealId          the /export dealId (graph 64-hex OR legacy uuid — the
 *                        SAME resolver /export already uses).
 * @param underwritingMode the /export underwritingMode query value.
 */
export async function resolvePortfolioExport(args: {
  dealId: string;
  underwritingMode: string;
  recordGraphStore: RecordGraphStore;
  store: SqliteStore;
}): Promise<PortfolioExport | null> {
  const { dealId, recordGraphStore, store } = args;

  // Resolve the deal via the SAME shared resolver /export uses (graph + legacy).
  // A malformed id throws MalformedAnalysisIdError — let the caller map it (the
  // existing /export path surfaces the same 400), so DO NOT swallow it here.
  const analysis = resolveAnalysisForRead(dealId, recordGraphStore, store);
  if (analysis === null) return null;

  // ADDITIVE GATE 1 — the deal must be marked roll_up. This reads the PERSISTED deal mode
  // (the servicer's explicit toggle), NOT the per-request query param — so ANY Create-Workbook
  // button routes correctly (fixes the buttons that hardcode 'single_loan'). A single_loan
  // deal → null → the existing single-property pipeline, byte-identical.
  if (resolveDealModeForAnalysis(analysis.graphRevisionId) !== 'roll_up') return null;

  // ADDITIVE GATE 2 — the deal must carry per-property children (N>1). Phase A adds a
  // MANUAL OVERRIDE: a servicer's hand-defined portfolio (servicer_inputs) is read FIRST;
  // it carries the human-supplied allocated loan amounts + optional whole-loan debt
  // service. Falls back to the (EX-102) graph properties when there's no manual def.
  const manual = resolveManualPortfolioComponents(analysis.graphRevisionId);
  const components = manual?.components ?? resolvePropertiesFromGraph(analysis.graphRevisionId, recordGraphStore);
  // HONEST EDGE — marked roll_up but <2 properties defined: fall back to the single-loan
  // export (never a silent empty rollup). The deal-room warns the servicer to add properties.
  if (components === null || components.length <= 1) return null;

  // Portfolio → compose the workbook (N per-property leaf tabs + 4 roll-up tabs). The
  // manual path supplies wholeLoanDebtService (→ honest aggregate DSCR); the allocated
  // loan amounts on the components drive the whole-loan balance → LTV / debt yield.
  const aggregation = aggregatePortfolio(components, {
    wholeLoanDebtService: manual?.wholeLoanDebtService ?? null,
  });
  const workbook = await composePortfolioWorkbook({
    templatePath: PORTFOLIO_TEMPLATE_PATH,
    leafTemplateSheetName: PORTFOLIO_LEAF_SHEET,
    components,
    aggregation,
  });

  return {
    analysisId: analysis.id,
    analysisName: analysis.name,
    components,
    workbook,
  };
}

/**
 * Market tab — loader + fill for the extracted submarket rent summary
 * (ExtractionResult.asr.marketRent). EXPORT-ONLY, MINT-SAFE. Real deterministic ASR content
 * ("Sub-Market Overview" parse, no LLM), captured-but-unconsumed until now.
 *
 * Binds the 2 numeric metrics into the Market tab's Annual Trends "Current" column:
 *   vacancyRate    → J4  (Vacancy / Current)   — RAW 0..1 fraction; the cell is formatted "0.0%".
 *   averageRentPsf → J7  (Submkt Rent / Current) — dollars; the cell is formatted "$#,##0".
 * submarketName has NO clean target cell in the trends grid → deliberately NOT written (never
 * jammed into a wrong cell). The auto columns (E Appraisal, G/H UW) are formulas — untouched.
 * Opt-in post-payload fill (like the sponsors / comps / site-inspection fills). Honest-blank.
 */
import type ExcelJS from 'exceljs';
import type { RevisionId, ExtractionResultId, MarketRentSummary } from '@cre/contracts';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import { recordGraphStore as defaultGraph } from '../../storage/record-graph-store.js';

export const MARKET_SHEET = 'Market';
const VACANCY_CELL = 'J4';   // Vacancy / Current — numFmt "0.0%" (write the raw fraction)
const SUBMKT_RENT_CELL = 'J7'; // Submkt Rent / Current — numFmt "$#,##0"

export interface MarketRentExportDeps {
  readonly graph?: Pick<RecordGraphStore, 'getRevisionEnvelope' | 'getDoctrineEvaluation' | 'getExtractionResult'>;
}

/**
 * Resolve the deal's extracted submarket rent (graph revision → doctrine eval → extraction
 * result → asr.marketRent), or null. Mirrors resolvePropertiesFromGraph's graph walk.
 */
export function loadMarketRentForExport(
  graphRevisionId: string | null | undefined,
  deps: MarketRentExportDeps = {},
): MarketRentSummary | null {
  if (!graphRevisionId) return null;
  const graph = deps.graph ?? defaultGraph;
  const envelope = graph.getRevisionEnvelope(graphRevisionId as RevisionId);
  if (envelope === null) return null;
  const doctrine = graph.getDoctrineEvaluation(envelope.doctrineEvaluationId);
  if (doctrine === null) return null;
  const er = graph.getExtractionResult(doctrine.extractionResultId as ExtractionResultId);
  return er?.asr?.marketRent ?? null;
}

/**
 * Fill the Market tab's J4 (vacancy) + J7 (submkt rent) from the extracted marketRent. No-op
 * when the sheet is absent or marketRent is null (opt-in → byte-unchanged). Honest-blank: a
 * null metric is skipped (cell left as-is). submarketName is intentionally not written.
 */
export function fillMarketTab(workbook: ExcelJS.Workbook, marketRent: MarketRentSummary | null): void {
  if (marketRent === null) return;
  const ws = workbook.getWorksheet(MARKET_SHEET);
  if (ws === undefined) return;
  // vacancyRate is a 0..1 fraction; J4 is formatted "0.0%" → write the raw fraction (0.079 → "7.9%").
  if (typeof marketRent.vacancyRate === 'number' && Number.isFinite(marketRent.vacancyRate)) {
    ws.getCell(VACANCY_CELL).value = marketRent.vacancyRate;
  }
  if (typeof marketRent.averageRentPsf === 'number' && Number.isFinite(marketRent.averageRentPsf)) {
    ws.getCell(SUBMKT_RENT_CELL).value = marketRent.averageRentPsf;
  }
  // submarketName: no clean target cell in the trends grid — deliberately skipped (not fabricated).
}

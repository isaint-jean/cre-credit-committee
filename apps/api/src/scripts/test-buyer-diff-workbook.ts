/**
 * Part B tests — the fresh-from-decisions markup generator.
 *   - ACCEPTED adjustment → buyer value + amber fill + comment(why) rendered.
 *   - REJECTED / PENDING → clean (issuer stands; no buyer markup).
 *   - deterministic: same decisions → byte-identical file; change a decision → file changes.
 *
 *   npm run test:buyer-diff-workbook
 */
import ExcelJS from 'exceljs';
import { buildBuyerDiffSuggestions, mergeDecisions } from '../services/buyer-diff-suggestions.service.js';
import { generateBuyerDiffWorkbook } from '../services/generate-buyer-diff-workbook.service.js';
import type { AdjustedInputs, ExtractionResult } from '@cre/contracts';

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ok    ${m}`); };
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };
const assert = (c: boolean, m: string) => (c ? ok(m) : fail(m));

const li = (raw: number | null, adjusted: number) => ({ raw, adjusted, source: 'SELLER_UW',
  adjustments: [{ ruleId: 'JE_TEST', delta: adjusted - (raw ?? 0), reason: 'raised to market' }] });
const AI = {
  metrics: { noi: 8_275_187, value: 124_438_898, dscr: 1.27, issuerStatedNoiSellerUw: 10_172_320, issuerStatedNoiAsr: null, trailingActualNoi: null, inPlaceNoi: null },
  income: { vacancyPct: li(0.034, 0.10), grossRentalIncome: li(12_997_217, 12_997_217), effectiveGrossIncome: li(null, 11_821_695) },
  expenses: { totalOperatingExpenses: li(3_455_762, 3_546_509) },
  assumptions: { capRate: li(0.0625, 0.0665) },
} as unknown as AdjustedInputs;
const EX = { dealRef: 'Sunroad Centrum', asr: { impliedValue: 133_000_000 }, appraisal: null } as unknown as ExtractionResult;

async function openSheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.getWorksheet('Buyer-Adjusted UW')!;
}
function rowFor(ws: ExcelJS.Worksheet, label: string): number {
  for (let r = 5; r <= 20; r++) if (ws.getCell(r, 1).value === label) return r;
  return -1;
}

(async () => {
  const base = buildBuyerDiffSuggestions(AI, EX);

  console.log('Accepted → buyer value + amber + comment; rejected/pending → clean:');
  {
    const merged = mergeDecisions(base, [
      { findingId: 'noi', decision: 'accepted' },
      { findingId: 'capRate', decision: 'rejected' },
      // vacancy/opex/value left pending
    ]);
    const ws = await openSheet(await generateBuyerDiffWorkbook('Sunroad Centrum', merged));

    const isAmber = (cell: ExcelJS.Cell) => {
      const f = cell.fill as { pattern?: string; fgColor?: { argb?: string } } | undefined;
      return f?.pattern === 'solid' && f?.fgColor?.argb === 'FFFFE699';
    };
    const noi = rowFor(ws, 'Net Operating Income');
    assert(String(ws.getCell(noi, 3).value).includes('8,275,187'), 'ACCEPTED noi: buyer value rendered');
    assert(isAmber(ws.getCell(noi, 3)), 'ACCEPTED noi: amber fill');
    assert(typeof ws.getCell(noi, 3).note === 'string' && String(ws.getCell(noi, 3).note).includes('Why'), 'ACCEPTED noi: comment carries the why');
    assert(String(ws.getCell(noi, 5).value).includes('JE_TEST'), 'ACCEPTED noi: why is the structured ledger reason');

    const cap = rowFor(ws, 'Cap Rate');
    assert(String(ws.getCell(cap, 3).value).includes('issuer accepted'), 'REJECTED capRate: clean, no buyer number');
    assert(!isAmber(ws.getCell(cap, 3)), 'REJECTED capRate: no amber fill (their original stands)');

    const vac = rowFor(ws, 'Vacancy (economic)');
    assert(String(ws.getCell(vac, 3).value).includes('issuer accepted'), 'PENDING vacancy: clean (only accepted renders)');
  }

  console.log('\nDeterministic — same decisions → byte-identical file:');
  {
    const merged = mergeDecisions(base, [{ findingId: 'noi', decision: 'accepted' }]);
    const a = await generateBuyerDiffWorkbook('Sunroad', merged);
    const b = await generateBuyerDiffWorkbook('Sunroad', merged);
    // xlsx zips embed no timestamps here (ExcelJS deterministic for identical content) — compare the sheet cells.
    const wa = await openSheet(a), wb2 = await openSheet(b);
    const noi = rowFor(wa, 'Net Operating Income');
    assert(String(wa.getCell(noi, 3).value) === String(wb2.getCell(noi, 3).value), 'same decisions → same rendered values');
  }

  console.log('\nChange a decision → the file changes (accept flips a line on):');
  {
    const rej = mergeDecisions(base, [{ findingId: 'value', decision: 'rejected' }]);
    const acc = mergeDecisions(base, [{ findingId: 'value', decision: 'accepted' }]);
    const wsR = await openSheet(await generateBuyerDiffWorkbook('S', rej));
    const wsA = await openSheet(await generateBuyerDiffWorkbook('S', acc));
    const vr = rowFor(wsR, 'Value (implied)'); const va = rowFor(wsA, 'Value (implied)');
    assert(String(wsR.getCell(vr, 3).value).includes('issuer accepted'), 'rejected value → clean');
    assert(String(wsA.getCell(va, 3).value).includes('124,438,898'), 'accepted value → buyer number appears (file reflects the changed decision)');
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} buyer-diff-workbook: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });

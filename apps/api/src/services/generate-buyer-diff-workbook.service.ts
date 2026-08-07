/**
 * Part B — the parameterized buyer-diff markup generator. Produces a CLEAN .xlsx
 * FRESH from (analysis suggestions + the current decision set), every download:
 *   - ACCEPTED adjustment → the buyer value renders (amber fill + a comment carrying
 *     the STRUCTURED why + Δ). "Accepted change is in."
 *   - REJECTED / PENDING   → only the issuer's value renders (clean, no markup).
 *     "Rejected/undecided is gone — their original stands."
 * The "why" is the structured ledger (AdjustmentEntry.ruleId/reason) — NO LLM,
 * deterministic: same decision set → byte-identical file.
 *
 * v1 note: this is OUR generated buyer-adjusted-underwriting artifact (fork a) —
 * a focused summary, not a markup of the full 43-tab /export template (that fuller
 * integration needs the render-schema metric→cell inverse and is a follow-up).
 */
import ExcelJS from 'exceljs';
import type { BuyerDiffSuggestion } from './buyer-diff-suggestions.service.js';

const AMBER = 'FFFFE699';
const HEADER = 'FF1F3864';

function fmt(s: BuyerDiffSuggestion, v: number | null): string {
  if (v === null) return '—';
  return s.format === 'pct' ? `${(v * 100).toFixed(2)}%` : `$${Math.round(v).toLocaleString('en-US')}`;
}
function dstr(s: BuyerDiffSuggestion): string {
  if (s.deltaPct === null) return '';
  return s.format === 'pct'
    ? `${((s.buyer ?? 0) - (s.issuer ?? 0)) * 10000 >= 0 ? '+' : ''}${Math.round(((s.buyer ?? 0) - (s.issuer ?? 0)) * 10000)} bps`
    : `${s.deltaPct >= 0 ? '+' : ''}${(s.deltaPct * 100).toFixed(1)}%`;
}

export async function generateBuyerDiffWorkbook(
  dealRef: string,
  suggestions: readonly BuyerDiffSuggestion[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Buyer-Diff';
  const ws = wb.addWorksheet('Buyer-Adjusted UW');
  ws.columns = [
    { width: 28 }, { width: 20 }, { width: 20 }, { width: 12 }, { width: 70 },
  ];

  const accepted = suggestions.filter((s) => s.decision === 'accepted');
  ws.getCell('A1').value = `Buyer-Adjusted Underwriting — ${dealRef}`;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F3864' } };
  ws.getCell('A2').value = accepted.length
    ? `Reflects the ${accepted.length} accepted buyer change${accepted.length === 1 ? '' : 's'}. Rejected / undecided lines keep the issuer's underwriting.`
    : 'No buyer changes accepted — this is the issuer\'s underwriting, unchanged.';
  ws.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF595959' } };

  const hdr = 4;
  ['Line', 'Issuer (GS U/W)', 'Buyer-Adjusted', 'Δ', 'Why (accepted only)'].forEach((h, i) => {
    const c = ws.getCell(hdr, i + 1);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });

  let r = hdr + 1;
  for (const s of suggestions) {
    const on = s.decision === 'accepted';
    ws.getCell(r, 1).value = s.label;
    ws.getCell(r, 2).value = fmt(s, s.issuer);
    // ACCEPTED → buyer value + amber + comment(why); else clean (issuer stands).
    if (on) {
      const bcell = ws.getCell(r, 3);
      bcell.value = fmt(s, s.buyer);
      bcell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
      bcell.font = { bold: s.findingId === 'noi' };
      ws.getCell(r, 4).value = dstr(s);
      const whyText = s.why.map((w) => `${w.ruleId} — ${w.reason}`).join('\n');
      ws.getCell(r, 5).value = whyText;
      bcell.note = `Issuer: ${fmt(s, s.issuer)}\nBuyer-adjusted: ${fmt(s, s.buyer)} (${dstr(s)})\n\nWhy: ${whyText}`;
    } else {
      ws.getCell(r, 3).value = '— (issuer accepted)';
      ws.getCell(r, 3).font = { color: { argb: 'FF8B93A3' } };
    }
    r += 1;
  }

  ws.getCell(r + 1, 1).value =
    'Amber = accepted buyer change (with why). Blank buyer column = the issuer\'s number stands (rejected or not accepted). Regenerated fresh on every download from the current decisions.';
  ws.getCell(r + 1, 1).font = { italic: true, size: 9, color: { argb: 'FF595959' } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

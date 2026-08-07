/**
 * render-buyer-diff-html — the VISUAL for the buyer diff. Pure function: takes the
 * projected BuyerDiffRow[] and returns a self-contained HTML page (inline CSS + a
 * tiny toggle script; no external deps, no network). Read-only presentation of
 * frozen state — no compute, no LLM.
 *
 * Three columns per row: ISSUER (their number) | BUYER-ADJUSTED (ours) | WHY.
 * Tri-state coloring + the "show changes / hide changes" toggle (ON = the full
 * redline; OFF = just the clean buyer-adjusted column to send).
 */
import type { AdjustmentBias } from '@cre/contracts';
import type { BuyerDiffRow } from './buyer-diff.service.js';

interface DealRef { readonly id: string; readonly dealRef: string }

const METRIC_LABEL: Record<string, string> = {
  noi: 'Net Operating Income', dscr: 'DSCR', capRate: 'Cap Rate', value: 'Value',
  loanAmount: 'Loan Amount', interestRate: 'Interest Rate', debtService: 'Annual Debt Service',
};
/** What to ask for when the field can't be verified (the honest "provide X"). */
const PROVIDE_HINT: Record<string, string> = {
  noi: 'operating statements / rent roll', dscr: 'issuer DSCR (prospectus / Annex A)',
  capRate: 'appraisal / issuer cap rate', value: 'appraisal / ASR implied value',
  loanAmount: 'loan terms', interestRate: 'stated coupon (loan terms)',
  debtService: 'loan terms (rate + amortization)',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function fmt(metric: string, v: number | null): string {
  if (v === null) return '—';
  if (metric === 'capRate' || metric === 'interestRate') return `${(v * 100).toFixed(2)}%`;
  if (metric === 'dscr') return `${v.toFixed(2)}x`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function rowHtml(r: BuyerDiffRow): string {
  const label = METRIC_LABEL[r.metric] ?? r.metric;
  const issuer = fmt(r.metric, r.issuer);
  const ours = fmt(r.metric, r.ours);
  const deltaPct = r.deltaPct === null ? null : `${r.deltaPct >= 0 ? '+' : '−'}${Math.abs(r.deltaPct * 100).toFixed(1)}%`;

  if (r.state === 'cant-verify') {
    return `
    <tr class="row cant-verify">
      <th class="metric">${esc(label)}<span class="state-tag tag-cv">can't verify</span></th>
      <td class="issuer">${esc(issuer)}</td>
      <td class="ours">${esc(ours)}</td>
      <td class="why"><span class="cv-note">⚠ insufficient data — the issuer didn't state this, or we couldn't source it. Provide ${esc(PROVIDE_HINT[r.metric] ?? 'the underlying document')}.</span></td>
    </tr>`;
  }

  if (r.state === 'agreement') {
    return `
    <tr class="row agreement">
      <th class="metric">${esc(label)}<span class="state-tag tag-agree">accepted</span></th>
      <td class="issuer">${esc(issuer)}</td>
      <td class="ours">${esc(ours)}</td>
      <td class="why"><span class="agree-note">buyer accepts the issuer's number as-is</span></td>
    </tr>`;
  }

  // ADJUSTMENT
  const consTag = r.conservatism === 'CONSERVATIVE' ? '<span class="cons cons-good">conservative</span>'
    : r.conservatism === 'NON_CONSERVATIVE' ? '<span class="cons cons-bad">non-conservative</span>'
    : '';
  const whyItems = r.why.length
    ? r.why.map((w) => `<li><code>${esc(w.ruleId)}</code> — ${esc(w.reason)}</li>`).join('')
    : '<li class="derived">derived (see the constituent rows for the why)</li>';
  return `
    <tr class="row adjustment">
      <th class="metric">${esc(label)}<span class="state-tag tag-adjust">adjusted</span></th>
      <td class="issuer">${esc(issuer)}</td>
      <td class="ours"><span class="ours-val">${esc(ours)}</span>${deltaPct ? `<span class="delta">${esc(deltaPct)}</span>` : ''} ${consTag}</td>
      <td class="why"><ul>${whyItems}</ul></td>
    </tr>`;
}

export function renderBuyerDiffHtml(deal: DealRef, rows: readonly BuyerDiffRow[], bias: AdjustmentBias): string {
  const counts = { agreement: 0, adjustment: 0, 'cant-verify': 0 } as Record<BuyerDiffRow['state'], number>;
  for (const r of rows) counts[r.state]++;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buyer Diff — ${esc(deal.dealRef)}</title>
<style>
  :root { --bg:#0f1116; --card:#171a21; --line:#262b36; --text:#e6e9ef; --muted:#8b93a3;
          --agree:#2f9e57; --adjust:#e0a020; --cv:#c8792e; --good:#57b972; --bad:#d9605a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 28px 20px 60px; }
  header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom: 6px; }
  h1 { font-size: 20px; margin: 0; font-weight: 650; }
  .sub { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  .legend { color: var(--muted); font-size: 12.5px; margin: 14px 0 6px; }
  .legend b { color: var(--text); font-weight: 600; }
  .toggle { display:flex; align-items:center; gap:9px; user-select:none; cursor:pointer; font-size:13px; color:var(--muted); }
  .toggle input { width:38px; height:21px; appearance:none; background:var(--line); border-radius:12px; position:relative; cursor:pointer; transition:.15s; }
  .toggle input:checked { background:#3a6df0; }
  .toggle input::after { content:""; position:absolute; top:2px; left:2px; width:17px; height:17px; border-radius:50%; background:#fff; transition:.15s; }
  .toggle input:checked::after { left:19px; }
  table { width:100%; border-collapse:separate; border-spacing:0; margin-top: 10px; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  thead th { text-align:left; font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:12px 14px; border-bottom:1px solid var(--line); background:#12151b; }
  th.metric { width: 27%; } td.issuer, td.ours { width: 17%; white-space:nowrap; } td.why { width: 39%; }
  tbody th, tbody td { padding:13px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
  tbody tr:last-child th, tbody tr:last-child td { border-bottom:none; }
  th.metric { font-weight:600; color:var(--text); }
  .state-tag { display:block; font-weight:500; font-size:11px; margin-top:4px; letter-spacing:.03em; }
  .tag-agree { color:var(--agree); } .tag-adjust { color:var(--adjust); } .tag-cv { color:var(--cv); }
  .row.adjustment { background: rgba(224,160,32,.045); }
  .row.cant-verify { background: rgba(200,121,46,.06); }
  td.issuer { color: var(--muted); }
  .ours-val { font-weight:600; }
  .row.adjustment .ours-val { color: var(--adjust); }
  .delta { margin-left:7px; font-size:12px; color:var(--adjust); font-weight:600; }
  .cons { margin-left:7px; font-size:11px; padding:1px 6px; border-radius:6px; }
  .cons-good { color:var(--good); background:rgba(87,185,114,.12); } .cons-bad { color:var(--bad); background:rgba(217,96,90,.12); }
  .why ul { margin:0; padding-left:16px; } .why li { margin:2px 0; color:var(--text); }
  .why li.derived { color:var(--muted); list-style:none; margin-left:-16px; }
  .why code { background:#0c0e13; border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:11.5px; color:#a9c2ff; }
  .agree-note { color:var(--agree); } .cv-note { color:var(--cv); }
  .counts { color:var(--muted); font-size:12.5px; margin-top:14px; }
  .counts b { color:var(--text); }
  /* HIDE-CHANGES MODE — the clean buyer-ready column only. */
  body.hide-changes td.issuer, body.hide-changes th.issuer,
  body.hide-changes td.why, body.hide-changes th.why,
  body.hide-changes .state-tag, body.hide-changes .delta, body.hide-changes .cons { display:none; }
  body.hide-changes th.metric { width: 60%; } body.hide-changes td.ours { width: 40%; }
  body.hide-changes .row.adjustment, body.hide-changes .row.cant-verify { background:transparent; }
  body.hide-changes .row.adjustment .ours-val { color: var(--text); }
</style></head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Buyer Diff — ${esc(deal.dealRef)}</h1>
        <p class="sub">Issuer underwriting vs. our buyer-adjusted underwriting · overall bias: <b>${esc(bias)}</b></p>
      </div>
      <label class="toggle"><input type="checkbox" id="tgl" checked onchange="document.body.classList.toggle('hide-changes', !this.checked)"> <span>show changes</span></label>
    </header>
    <p class="legend"><b style="color:var(--agree)">■</b> accepted as-is &nbsp; <b style="color:var(--adjust)">■</b> buyer-adjusted (with why) &nbsp; <b style="color:var(--cv)">■</b> can't verify — insufficient data</p>
    <table>
      <thead><tr>
        <th class="metric">Metric</th>
        <th class="issuer">Issuer (their UW)</th>
        <th class="ours">Buyer-adjusted (ours)</th>
        <th class="why">Why</th>
      </tr></thead>
      <tbody>
        ${rows.map(rowHtml).join('')}
      </tbody>
    </table>
    <p class="counts">states: <b>${counts.agreement}</b> accepted · <b>${counts.adjustment}</b> adjusted · <b>${counts['cant-verify']}</b> can't-verify &nbsp;—&nbsp; toggle <i>show changes</i> off for the clean buyer-ready column only.</p>
  </div>
</body></html>`;
}

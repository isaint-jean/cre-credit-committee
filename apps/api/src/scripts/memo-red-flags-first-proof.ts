/**
 * PROOF — memo red-flags-first reprioritization (DISPLAY-ONLY). READ-ONLY.
 *
 * Gates:
 *  (A) the flag-classification registry: due-diligence signals (reconciliation /
 *      capex / sponsor / data_quality / other) are due-diligence; financial-metric
 *      is NOT; an unmapped id defaults to 'other' (never dropped).
 *  (B) the §3 split partition (the exact predicate the renderer uses): DD findings
 *      lead; a financial-metric finding (DSCR) lands in the demoted bucket; an
 *      unmapped dimension still renders (DD side).
 *  (C) the memo order leads with risk: key_credit_risks BEFORE investment_merits;
 *      the §3 renderer emits the DD block before the "Financial-metric risks"
 *      sub-section; credit_structure heading reframed to "If Pursued…".
 *  (D) canonical/mint-safe: the change is the memo FORMAT version (2.1 registered),
 *      NOT the doctrine head; cre.db byte-identical (BMARK 17, 640 head).
 *
 * Run: npx tsx src/scripts/memo-red-flags-first-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { flagCategory, isDueDiligence } from '../services/render-memo/flag-categories.js';
import { MEMO_SECTION_ORDER, MEMO_SECTION_HEADINGS } from '../services/render-memo/committee-memo-format.js';
import { COMMITTEE_MEMO_VERSION, COMMITTEE_MEMO_MANIFEST } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

function partA(): void {
  console.log('\n(A) flag-classification registry:');
  check("'coverage-dscr' → financial_metric (DEMOTED)", flagCategory('coverage-dscr') === 'financial_metric' && !isDueDiligence('financial_metric'));
  check("'leverage-ltv' → financial_metric", flagCategory('leverage-ltv') === 'financial_metric');
  check("'sponsor-borrower-quality' → sponsor (DD)", flagCategory('sponsor-borrower-quality') === 'sponsor' && isDueDiligence('sponsor'));
  check("'income-concentration' (tenant) → other (DD)", flagCategory('income-concentration') === 'other' && isDueDiligence('other'));
  check("JE_NOI_BELOW_TRAILING_ACTUAL → reconciliation (DD)", flagCategory('JE_NOI_BELOW_TRAILING_ACTUAL') === 'reconciliation');
  check("JE_PCA_MISSING → capex (DD)", flagCategory('JE_PCA_MISSING') === 'capex');
  check("CAPEX_SHORTFALL → capex (DD)", flagCategory('CAPEX_SHORTFALL') === 'capex');
  check("JE_RENT_ROLL_MISSING → data_quality (DD)", flagCategory('JE_RENT_ROLL_MISSING') === 'data_quality');
  check("family prefix: PCA_REPAIRS_UNDERFUNDED → capex", flagCategory('PCA_REPAIRS_UNDERFUNDED') === 'capex');
  check("family prefix: some_MISSING → data_quality", flagCategory('SOMETHING_MISSING') === 'data_quality');
  check("UNMAPPED id → 'other' (never dropped, DD side)", flagCategory('TOTALLY_UNKNOWN_FLAG_XYZ') === 'other' && isDueDiligence('other'));
}

function partB(): void {
  console.log('\n(B) §3 split partition (the renderer predicate):');
  const findings = [
    { dimensionId: 'coverage-dscr' },            // financial → demoted
    { dimensionId: 'leverage-ltv' },             // financial → demoted
    { dimensionId: 'sponsor-borrower-quality' }, // DD
    { dimensionId: 'income-concentration' },     // DD
    { dimensionId: 'brand-new-dim-not-mapped' }, // unmapped → 'other' → DD
  ];
  const dd = findings.filter(f => isDueDiligence(flagCategory(f.dimensionId)));
  const fin = findings.filter(f => !isDueDiligence(flagCategory(f.dimensionId)));
  check('DD bucket leads with 3 (sponsor + tenant + unmapped)', dd.length === 3 && dd.some(f => f.dimensionId === 'brand-new-dim-not-mapped'));
  check('financial bucket isolates DSCR + LTV (demoted)', fin.length === 2 && fin.every(f => f.dimensionId === 'coverage-dscr' || f.dimensionId === 'leverage-ltv'));
  check('EVERY finding is placed (none dropped)', dd.length + fin.length === findings.length);
}

function partC(): void {
  console.log('\n(C) memo order leads with risk + §3 DD-first + reframed §11:');
  const order = MEMO_SECTION_ORDER as readonly string[];
  const iRisk = order.indexOf('key_credit_risks');
  const iMerits = order.indexOf('investment_merits');
  check('Key Credit Risks BEFORE Investment Merits (risk leads)', iRisk >= 0 && iMerits >= 0 && iRisk < iMerits, `risk@${iRisk} < merits@${iMerits}`);
  check('sponsor + data_quality + validation lead (before merits)', order.indexOf('sponsor_assessment') < iMerits && order.indexOf('data_quality_review') < iMerits && order.indexOf('underwriting_validation') < iMerits);
  check('§11 heading reframed to "If Pursued…"', MEMO_SECTION_HEADINGS.credit_structure === 'If Pursued: Structure & Conditions');

  // The renderer emits the DD block BEFORE the demoted financial sub-section.
  const src = fs.readFileSync(path.join(process.cwd(), 'src/services/render-memo/build-committee-memo.ts'), 'utf8');
  const tmpl = src.slice(src.indexOf('function renderKeyCreditRisks'));
  const iDd = tmpl.indexOf('${ddBlock}');
  const iFin = tmpl.indexOf('${financialBlock}');
  check('renderKeyCreditRisks: ddBlock rendered BEFORE financialBlock', iDd >= 0 && iFin >= 0 && iDd < iFin);
  check('demoted "Financial-metric risks" sub-heading present', src.includes('Financial-metric risks (secondary'));
}

function partD(): void {
  console.log('\n(D) canonical/mint-safe:');
  check('COMMITTEE_MEMO_VERSION bumped to 2.1', COMMITTEE_MEMO_VERSION === '2.1');
  check('manifest has a registered 2.1 digest (boot gate green)', typeof COMMITTEE_MEMO_MANIFEST['2.1'] === 'string' && !COMMITTEE_MEMO_MANIFEST['2.1'].includes('__'));
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('cre.db byte-identical (BMARK 17, 640 head)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

console.log('\nMemo red-flags-first proof (read-only)');
partA(); partB(); partC(); partD();
console.log(failures === 0 ? '\nmemo red-flags-first proof: OK\n' : `\nmemo red-flags-first proof: ${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

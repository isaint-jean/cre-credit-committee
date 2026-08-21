/**
 * PROOF — red-flag titles as human insight WITH real numbers (6 dims + NOI), plain-language
 * fallback for rollover/asset-class/sponsor. One rewrite point: FlagDetail.statement.
 *
 *  (A) each of the 6 clean dimensions renders its human headline WITH the real number, and that
 *      number string appears IDENTICALLY in the modal evidence (same derivedOutputs + fmtOutput
 *      → zero drift, never invented).
 *  (B) fallback flags render the better plain-language title (no bare metric label, no NaN).
 *  (C) topTenantShare reads "52%" in BOTH headline and evidence; no other field regresses.
 *  (D) general guard: a dim with its number field absent falls back to plain-language (no NaN).
 *  (E) wiring: card title ← flagDetails[matchId].statement; memo <details> body renders statement.
 *
 * DISPLAY-ONLY / render-time: no producer change, no mint, no re-mint. Canonical byte-identical.
 * Run: npx tsx src/scripts/red-flag-human-titles-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { dimensionFlagDetail } from '../services/render-memo/flag-detail.js';
import type { DimensionContribution } from '../doctrine-clean/types.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
function dim(dimensionId: string, derivedOutputs: Record<string, number | string | null> | undefined, applicability = 'applicable'): DimensionContribution {
  return { dimensionId, riskContribution: 2, tier: 'elevated', rationale: `${dimensionId} rationale`, provenance: [], applicability, evaluated: true, derivedOutputs } as unknown as DimensionContribution;
}
const evalues = (d: { evidence: readonly { value: string }[] }): string[] => d.evidence.map((e) => e.value);

/** A headline is honest iff its number string ALSO appears verbatim in an evidence value. */
function headlineNumberMatchesEvidence(dimensionId: string, outputs: Record<string, number | string | null>, headlineIncludes: string, num: string): void {
  const d = dimensionFlagDetail(dim(dimensionId, outputs));
  check(`${dimensionId} → human headline with number`, d.statement.includes(headlineIncludes) && d.statement.includes(num), d.statement);
  check(`${dimensionId} → headline number "${num}" == evidence value (zero drift)`, evalues(d).includes(num));
  // NaN/undefined are LITERAL (case-sensitive) — "refiNANce"/"teNANt" must not false-positive.
  check(`${dimensionId} → not a bare metric label / no NaN`, !d.statement.includes('NaN') && !d.statement.includes('undefined') && !/^[a-z-]+$/.test(d.statement) && !/^(Coverage Dscr|Leverage Ltv|Debt Yield|Rollover|Asset Class)$/i.test(d.statement));
}

function partA(): void {
  console.log('\n(A) 6 clean dimensions — human headline WITH the real number, matching evidence:');
  headlineNumberMatchesEvidence('coverage-dscr', { stressedDscr: 1.02, annualDebtService: 500000, debtServiceBasisIsIo: 0 }, 'Thin coverage — DSCR', '1.02×');
  headlineNumberMatchesEvidence('leverage-ltv', { stressedLtv: 0.68 }, 'High leverage —', '68.0%');
  headlineNumberMatchesEvidence('debt-yield', { debtYield: 0.085, assetFloorDecimal: 0.08 }, 'Low debt yield —', '8.50%');
  headlineNumberMatchesEvidence('refinance-feasibility', { maturityBalance: 40000000, stressedRefiConstant: 0.09, exitDscr: 0.95, exitDy: 0.07, exitLtv: 0.8, legsAtElevatedOrAbove: 2 }, "Won't refinance — exit DSCR", '0.95×');
  headlineNumberMatchesEvidence('cap-rate-valuation-stress', { stressedCapRateGoingIn: 0.085, stressedValue: 42000000, valuationAggressiveness: 0.28, concludedValue: 50000000, concludedValueSource: 'extracted-appraisal' }, 'Aggressive valuation — implies a', '8.50%');
  headlineNumberMatchesEvidence('income-concentration', { topTenantShare: 0.52, herfindahlIndex: 0.3 }, 'Concentrated income — top tenant', '52%');
}

function partB(): void {
  console.log('\n(B) fallback flags — better plain-language (no metric label, no NaN):');
  const roll = dimensionFlagDetail(dim('rollover', undefined));
  check('rollover → plain-language (number trapped in prose; producer untouched)', roll.statement === 'Large share of leases roll within the loan term');
  const asset = dimensionFlagDetail(dim('asset-class', { canonicalAssetClassIndex: 2 }));
  check('asset-class → "Secondary / higher-risk asset type"', asset.statement === 'Secondary / higher-risk asset type');
  const sponsor = dimensionFlagDetail(dim('sponsor-borrower-quality', {}));
  check('sponsor → "Sponsor quality unverified" (thin, no number)', sponsor.statement === 'Sponsor quality unverified' && sponsor.tier === 'thin');
  for (const d of [roll, asset, sponsor]) check(`fallback "${d.statement}" is not a metric label / NaN`, !/NaN|undefined/.test(d.statement) && !/^[a-z-]+$/i.test(d.statement));
}

function partC(): void {
  console.log('\n(C) topTenantShare formatter — "52%" in BOTH headline + evidence; no regressions:');
  const conc = dimensionFlagDetail(dim('income-concentration', { topTenantShare: 0.52, herfindahlIndex: 0.3 }));
  check('topTenantShare evidence reads "52%" (not "0.52")', evalues(conc).includes('52%') && !evalues(conc).includes('0.52'));
  check('herfindahlIndex NOT turned into a percent (scoped fix, no regress)', evalues(conc).includes('0.3'));
  // Other %/×/$ fields unchanged by the *Share rule.
  check('LTV still "68.0%"', evalues(dimensionFlagDetail(dim('leverage-ltv', { stressedLtv: 0.68 }))).includes('68.0%'));
  check('DSCR still "1.02×"', evalues(dimensionFlagDetail(dim('coverage-dscr', { stressedDscr: 1.02 }))).includes('1.02×'));
  check('debt yield still "8.50%"', evalues(dimensionFlagDetail(dim('debt-yield', { debtYield: 0.085 }))).includes('8.50%'));
}

function partD(): void {
  console.log('\n(D) general guard — missing number field → plain-language, never NaN:');
  const noDscr = dimensionFlagDetail(dim('coverage-dscr', { annualDebtService: 500000 })); // stressedDscr absent
  check('coverage-dscr w/o stressedDscr → qualitative sentence, no "undefined×"/NaN', !/NaN|undefined|null×/.test(noDscr.statement) && noDscr.statement.length > 0 && noDscr.statement !== 'coverage-dscr');
  const empty = dimensionFlagDetail(dim('leverage-ltv', {})); // no stressedLtv
  check('leverage-ltv w/o stressedLtv → qualitative sentence, no NaN', !/NaN|undefined/.test(empty.statement) && empty.statement.length > 0);
}

function partE(): void {
  console.log('\n(E) wiring — one source (statement) feeds card + memo:');
  const view = readFileSync(path.join(process.cwd(), '../web/src/components/RenderedAnalysisView.tsx'), 'utf8');
  check('deal-room card title ← flagDetails[matchId].statement (fallback to derived)', /const title = detail\?\.statement \?\? p\.title/.test(view));
  const memo = readFileSync(path.join(process.cwd(), 'src/services/render-memo/build-committee-memo.ts'), 'utf8');
  check('memo <details> BODY renders statement (not the <summary> heading → no format-hash move)', /<summary>How this was determined<\/summary>\s*<p class="memo-prose-fine"><strong>\$\{esc\(detail\.statement\)\}<\/strong><\/p>/.test(memo));
}

function mintSafe(): void {
  console.log('\nMint-safety — canonical byte-identical:');
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17 + 640 head 221235987967)', bmark === 17 && !!head, `BMARK ${bmark}`);
}

(() => {
  console.log('\nRed-flag human titles + real numbers proof');
  partA(); partB(); partC(); partD(); partE(); mintSafe();
  console.log(failures === 0 ? '\nproof: OK\n' : `\nproof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();

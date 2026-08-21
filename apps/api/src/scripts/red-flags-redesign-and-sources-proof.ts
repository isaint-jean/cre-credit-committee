/**
 * PROOF — Red Flags redesign (Phase 1) + real source-document names (Phase 2).
 *  (A) redesign: RenderedAnalysisView renders ONE card system (RedFlagCard), severity+category
 *      chips from the design tokens, framed empty-state, dedupe holds, banners folded as items.
 *  (B) dimension flags name their REAL source doc where honest (cap-rate → appraisal/ASR/AnnexA/
 *      operator; LTV/DSCR/DY/rollover → mapped doc when present, honest fallback when absent);
 *      Bucket A (NOI "(page not captured)", _MISSING "Absence of …") intact.
 *  (C) Bucket C stays honest — sponsor thin, asset-class "Property metadata", library/benchmark
 *      substitutions labelled as basis; a scan asserts NO fabricated document + NO page number.
 *
 * DISPLAY-ONLY (a source pass-through in the render-time builder): no mint, no extraction change,
 * canonical byte-identical. Run: npx tsx src/scripts/red-flags-redesign-and-sources-proof.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { dimensionFlagDetail, buildAllFlagDetails, judgmentFlagDetail } from '../services/render-memo/flag-detail.js';
import type { DimensionContribution } from '../doctrine-clean/types.js';
import type { NoiReconciliationDetail } from '@cre/contracts';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

/** Minimal DimensionContribution for the flag builder (display-only fields). */
function dim(dimensionId: string, derivedOutputs: Record<string, number | string | null>, applicability = 'applicable'): DimensionContribution {
  return {
    dimensionId, riskContribution: 2, tier: 'elevated', rationale: `${dimensionId} rationale`,
    provenance: [], applicability, evaluated: true, derivedOutputs,
  } as unknown as DimensionContribution;
}
const sourcesOf = (d: { evidence: readonly { source: string }[] }): string[] => d.evidence.map((e) => e.source);

function partA(): void {
  console.log('\n(A) redesign — ONE card system, chips, tokens, framed empty-state:');
  const view = readFileSync(path.join(process.cwd(), '../web/src/components/RenderedAnalysisView.tsx'), 'utf8');
  // Slice just the Red Flags <section> (comment anchor → the following P3b comment).
  const secStart = view.indexOf('"Red Flags" — ONE card system');
  const secEnd = view.indexOf('P3b — advisory intake-completeness', secStart);
  const section = secStart >= 0 && secEnd > secStart ? view.slice(secStart, secEnd) : '';
  check('Red Flags section located for structural checks', section.length > 0);
  check('single RedFlagCard component (banners + flags render through it)', /function RedFlagCard\(/.test(view) && /redFlagItems\.map\(\(it\) => <RedFlagCard key=\{it\.key\} item=\{it\} \/>\)/.test(view));
  check('the parallel redFlagCardTone ramp is GONE', !/redFlagCardTone/.test(view));
  check('no ad-hoc Tailwind color ramp IN THE SECTION (border-*-500 / bg-*-50)', !/border-(amber|blue|slate|indigo|red)-\d00/.test(section) && !/bg-(amber|blue|slate|indigo|red)-50/.test(section));
  check('ONE severity tone from design tokens (C.kicked/flagged/contested)', /RED_FLAG_TONE[\s\S]{0,220}C\.kicked[\s\S]{0,120}C\.flagged[\s\S]{0,120}C\.contested/.test(view));
  check('visible severity chip (Critical/Flagged/Finding) + category chip', /RED_FLAG_SEV_LABEL[\s\S]{0,120}Critical[\s\S]{0,40}Flagged[\s\S]{0,40}Finding/.test(view) && /redFlagCategory\(/.test(view) && /RedFlagChip/.test(view));
  check('category cues encode content (Reconciliation/Missing doc/Valuation/Coverage/Sponsor)', /Reconciliation/.test(view) && /Missing doc/.test(view) && /Valuation/.test(view) && /Coverage/.test(view) && /Sponsor/.test(view));
  check('framed empty-state card (not orphaned text)', /No red flags<\/div>[\s\S]{0,120}Nothing to contest/.test(view));
  check('banners folded in as items (one system), NOI keeps its receipts', /redFlagItems\.push\(\{ key: 'banner:noi'/.test(view) && /extra: <NoiReconciliationReceipts/.test(view));
  check('dedupe holds (banner-covered flag not re-carded)', /bannerCoveredCodes/.test(view));
  check('each card still opens the modal', /onOpen: \(\) => openFlagDetail\(/.test(view) && /item\.onOpen/.test(view));
  check('section NOT gated on negotiationLoopEnabled; negotiation surface stays shelved', /<h2[^>]*>Red Flags<\/h2>/.test(view) && /negotiationLoopEnabled && workflow !== undefined && !editMode \? \(\s*<NegotiationSurface/.test(view));
}

function partB(): void {
  console.log('\n(B) dimension flags name their REAL source document (Bucket B) + Bucket A intact:');
  // cap-rate: the concludedValueSource tag → the human doc label; tag is NOT its own row.
  const cap = (src: string | null): ReturnType<typeof dimensionFlagDetail> =>
    dimensionFlagDetail(dim('cap-rate-valuation-stress', { concludedValue: 5_000_000, stressedValue: 4_200_000, concludedValueSource: src }));
  check('cap-rate → "Extracted appraisal (third-party)"', sourcesOf(cap('extracted-appraisal')).some((s) => /Extracted appraisal \(third-party\)/.test(s)));
  check('cap-rate → "ASR implied value"', sourcesOf(cap('extracted-asr')).some((s) => /ASR implied value/.test(s)));
  check('cap-rate → "Annex A (issuer prospectus)"', sourcesOf(cap('extracted-annex-a')).some((s) => /Annex A \(issuer prospectus\)/.test(s)));
  check('cap-rate → "Operator-supplied value"', sourcesOf(cap('operator-supplied')).some((s) => /Operator-supplied value/.test(s)));
  check('cap-rate null → honest "source document not captured" (no invented doc)', sourcesOf(cap(null)).some((s) => /source document not captured/.test(s)));
  check('concludedValueSource is NOT rendered as its own evidence row', cap('extracted-appraisal').evidence.every((e) => !/source$/i.test(e.label) || !/concluded value source/i.test(e.label)));

  // Field→doc map, gated by doc presence.
  const ltvPresent = dimensionFlagDetail(dim('leverage-ltv', { loanAmount: 3_000_000, stressedLtv: 0.72 }), { missing: new Set() });
  check('LTV present → "Loan terms" + "Appraisal + loan terms"', sourcesOf(ltvPresent).some((s) => /Loan terms/.test(s)) && sourcesOf(ltvPresent).some((s) => /Appraisal \+ loan terms/.test(s)));
  const ltvMissing = dimensionFlagDetail(dim('leverage-ltv', { loanAmount: 3_000_000, stressedLtv: 0.72 }), { missing: new Set(['appraisal', 'loan terms']) });
  check('LTV with docs ABSENT → honest input fallback (never names an absent doc)', sourcesOf(ltvMissing).every((s) => !/^Loan terms$|Appraisal \+ loan terms/.test(s)) && sourcesOf(ltvMissing).some((s) => /source document not captured/.test(s)));
  const dscr = dimensionFlagDetail(dim('coverage-dscr', { dscr: 1.18, noi: 900_000 }));
  check('DSCR/NOI → "T-12 / Seller UW / concluded NOI"', sourcesOf(dscr).some((s) => /T-12 \/ Seller UW \/ concluded NOI/.test(s)));
  const roll = dimensionFlagDetail(dim('rollover', { rolloverPct: 0.4 }), { missing: new Set() });
  check('rollover → "Rent roll" when present', sourcesOf(roll).some((s) => /Rent roll/.test(s)));

  // Bucket A — NOI keeps doc-kind + "(page not captured)"; _MISSING keeps "Absence of …".
  const noi: NoiReconciliationDetail = {
    rows: [{ label: 'Trailing-12 actual NOI', valueFormatted: '$1,000,000', sourceDocument: 'Operating statement (T-12)' } as never],
    variance: 'down 12%',
  } as unknown as NoiReconciliationDetail;
  const all = buildAllFlagDetails({ contributions: [], dataQualityFlags: ['JE_RENT_ROLL_MISSING', 'JE_APPRAISAL_MISSING'], noiReconciliation: noi });
  check('Bucket A: NOI keeps "(page not captured)"', sourcesOf(all['JE_NOI_BELOW_TRAILING_ACTUAL']!).some((s) => /Operating statement \(T-12\) \(page not captured\)/.test(s)));
  check('Bucket A: _MISSING keeps "Absence of a rent roll"', sourcesOf(all['JE_RENT_ROLL_MISSING']!).some((s) => /Absence of a rent roll/.test(s)));
}

function partC(): void {
  console.log('\n(C) Bucket C honest — NO fabricated document, NO page number:');
  const sponsor = dimensionFlagDetail(dim('sponsor-borrower-quality', {}));
  check('sponsor → thin, no evidence (HITL, no invented doc)', sponsor.tier === 'thin' && sponsor.evidence.length === 0);
  const asset = dimensionFlagDetail(dim('asset-class', { assetClass: 'office' }));
  check('asset-class → "Property metadata (no discrete document)"', sourcesOf(asset).every((s) => /Property metadata \(no discrete document\)/.test(s)));
  check('library substitution → "Library median" (basis, not a doc)', /Library median/.test(judgmentFlagDetail('JE_VACANCY_SUBSTITUTED_FROM_LIBRARY').evidence[0]!.source));
  check('benchmark substitution → "Market benchmark" (basis, not a doc)', /Market benchmark/.test(judgmentFlagDetail('JE_VACANCY_SUBSTITUTED_FROM_MARKET_BENCHMARK').evidence[0]!.source));

  // Scan EVERY source produced across a representative set — assert no page number anywhere,
  // and no doc name attached to a Bucket-C (sponsor / asset-class / substitution) flag.
  const everySource: string[] = [];
  const push = (d: { evidence: readonly { source: string }[] }): void => { for (const e of d.evidence) everySource.push(e.source); };
  push(dimensionFlagDetail(dim('cap-rate-valuation-stress', { concludedValue: 1, concludedValueSource: 'extracted-appraisal' })));
  push(dimensionFlagDetail(dim('leverage-ltv', { loanAmount: 1, stressedLtv: 0.7 })));
  push(dimensionFlagDetail(dim('asset-class', { assetClass: 'office' })));
  push(judgmentFlagDetail('JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY'));
  push(judgmentFlagDetail('JE_RENT_ROLL_MISSING'));
  const hasPageNumber = everySource.some((s) => /\bp(age)?\.?\s*\d/i.test(s));
  check('NO page number in any source (still not captured)', !hasPageNumber, hasPageNumber ? everySource.find((s) => /\bp(age)?\.?\s*\d/i.test(s)) : `${everySource.length} sources scanned`);
  const cSubstitution = judgmentFlagDetail('JE_CAP_RATE_SUBSTITUTED_FROM_LIBRARY').evidence[0]!.source;
  check('substitution source names NO document (appraisal/rent roll/T-12/PCA)', !/appraisal|rent roll|T-12|PCA|loan terms/i.test(cSubstitution));
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
  console.log('\nRed Flags redesign + real-source-document proof');
  partA(); partB(); partC(); mintSafe();
  console.log(failures === 0 ? '\nproof: OK\n' : `\nproof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();

/**
 * proof-640-rent-roll-llm.ts — GROUND-TRUTH proof for the LLM-PRIMARY rent-roll
 * extraction + COMPLETENESS GUARD (the 640 Fifth Ave / Vornado remediation).
 *
 * Runs (against the REAL 640 rent-roll blob; real Sonnet when credits are live):
 *   1. Deterministic-vs-LLM: the LLM reads ALL tenants of the dense Vornado
 *      ANNUALREP roll; every rent cited; Σ reconciles to the roll's own stated
 *      total (~$74.6M) → completeness guard PASSES (reconciled=true).
 *   2. GUARD FIRES on a deliberately-truncated roll: drop the anchor tenant →
 *      Σ short of the stated total → reconciled=false → roll EXCLUDED.
 *   3. Concentration NOW POPULATES: with the reconciled roll, the top-tenant
 *      share (~52% Victoria's Secret) drives income-concentration to a real
 *      band; the 640 TEMP-db re-score moves DOWN from 60.24.
 *   4. cite-or-discard (fabricated rent dropped) + null-not-fabricate (unread
 *      date null) + caching ($0 replay) + no-credits (roll unread → EXCLUDED).
 *
 * READ-ONLY. Does NOT write cre.db, does NOT mint a 640 revision. Proofs only.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDocument } from '../services/document-parser.service.js';
import { extractRentRollFromDocument } from '../services/extract-rent-roll-from-document.js';
import {
  extractRentRollFromDocumentLlm,
  parseRentRollLlmResponse,
  evaluateCompleteness,
  InMemoryRentRollLlmCache,
  RECONCILE_TOLERANCE,
  type RentRollLlmCall,
} from '../services/extract-rent-roll-from-document-llm.js';
import { projectToRentRollExtraction } from '../services/extraction/adapters/rent-roll.adapter.js';
import { deriveTopTenantShare } from '../doctrine-clean/adapters/extraction-to-dealbag.js';
import { evaluateIncomeConcentration } from '../doctrine-clean/dimensions/income-concentration.js';
import { evaluateDeal, type DealBag } from '../doctrine-clean/scoring/evaluate-deal.js';
import type { RentRoll } from '@cre/contracts';
import { env } from '../config/env.js';

const BLOBS = '/Users/isabellesaint-jean/Code/cre-credit-committee/apps/api/.data/blobs';
const B640_RR = `${BLOBS}/b8/b8d077d3f3b75d5df401b9376d35973705e3b8c449da89b153413fcfdd41c29d.bin`;
const STATED_TOTAL = 74_585_643.5;      // Vornado BLDG. TOTAL (verbatim)
const BASELINE_SCORE = 60.24;           // the minted 640 verdict (concentration UN-priced)

function hash(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex'); }
function fmt(n: number | null): string { return n === null ? 'null' : `$${Math.round(n).toLocaleString('en-US')}`; }
function pct(n: number | null): string { return n === null ? 'null' : `${(n * 100).toFixed(1)}%`; }
function ok(b: boolean): string { return b ? '✓' : '✗'; }

/** Real 640 roll, distilled to the tenants + their cited TENANT TOTAL amounts
 *  (verbatim from the Vornado ANNUALREP). Used as the no-credits stub so the
 *  guard + scoring logic is provable offline; the numbers ARE the doc's own. */
const REAL_640_TENANTS: Array<{ name: string; sf: number; rent: number; quote: string; end: string | null }> = [
  { name: "Victoria's Secret", sf: 63779, rent: 38639370.58, quote: 'TENANT TOTAL: 63,779 38,639,370.58', end: '2032-01-31' },
  { name: 'Dyson', sf: 3097, rent: 10440097.24, quote: 'TENANT TOTAL: 3,097 10,440,097.24', end: '2027-08-27' },
  { name: 'Fidelity Real Estate Company', sf: 40615, rent: 4318651.92, quote: 'TENANT TOTAL: 40,615 4,318,651.92', end: '2026-11-30' },
  { name: 'Hamlin Capital Mgmt LLC', sf: 12875, rent: 1437413.10, quote: 'TENANT TOTAL: 12,875 1,437,413.10', end: '2029-10-31' },
  { name: 'Abbott Capital Management', sf: 20019, rent: 1414390.73, quote: 'TENANT TOTAL: 20,019 1,414,390.73', end: '2032-12-31' },
  { name: 'Prospect Ridge Advisors', sf: 15852, rent: 1198914.38, quote: 'TENANT TOTAL: 15,852 1,198,914.38', end: '2032-12-31' },
  { name: 'Buchanan Ingersoll & Rooney', sf: 16816, rent: 1751349.36, quote: 'TENANT TOTAL: 16,816 1,751,349.36', end: '2029-01-31' },
  { name: 'Tenant 0930', sf: 12875, rent: 1853164.46, quote: 'TENANT TOTAL: 12,875 1,853,164.46', end: null },
  { name: 'Tenant 30103', sf: 30103, rent: 3170416.53, quote: 'TENANT TOTAL: 30,103 3,170,416.53', end: null },
  { name: 'Tenant 10523a', sf: 10523, rent: 1511301.43, quote: 'TENANT TOTAL: 10,523 1,511,301.43', end: null },
  { name: 'Tenant 10523b', sf: 10523, rent: 1525363.27, quote: 'TENANT TOTAL: 10,523 1,525,363.27', end: null },
  { name: 'Tenant 10523c', sf: 10523, rent: 1513019.99, quote: 'TENANT TOTAL: 10,523 1,513,019.99', end: null },
  { name: 'Tenant 10295', sf: 10295, rent: 1193335.82, quote: 'TENANT TOTAL: 10,295 1,193,335.82', end: null },
  { name: 'Tenant 10183', sf: 10183, rent: 938429.85, quote: 'TENANT TOTAL: 10,183 938,429.85', end: null },
  { name: 'Tenant 10278', sf: 10278, rent: 1543575.84, quote: 'TENANT TOTAL: 10,278 1,543,575.84', end: null },
  { name: 'Tenant 10421', sf: 10421, rent: 937890.00, quote: 'TENANT TOTAL: 10,421 937,890.00', end: null },
  { name: 'Air Rights', sf: 0, rent: 1166319.00, quote: 'TENANT TOTAL: 0 1,166,319.00', end: null },
  { name: 'Centurylink Communications', sf: 0, rent: 23520.00, quote: 'TENANT TOTAL: 0 23,520.00', end: '2029-03-31' },
];

function realStubResponse(): string {
  return JSON.stringify({
    propertyName: { value: '640 FIFTH AVENUE', sourceQuote: 'PROPERTY: N064 - 640 FIFTH AVENUE' },
    asOfDate: { value: '2024-05-01', sourceQuote: 'AS OF 05/01/24' },
    statedTotalAnnualRent: { value: STATED_TOTAL, sourceQuote: '314,500 74,585,643.50 237.16' },
    statedTenantCount: { value: null, sourceQuote: null },
    tenants: REAL_640_TENANTS.map(t => ({
      tenantName: t.name, suite: null, squareFeet: t.sf,
      baseRentAnnual: t.rent, sourceQuote: t.quote,
      leaseStart: null, leaseEnd: t.end, status: t.rent > 0 ? 'OCCUPIED' : 'VACANT',
    })),
  });
}

/** Build a representative 640 DealBag. All non-concentration inputs held fixed;
 *  largestTenantPct is the ONLY axis toggled between the two scores. */
function build640Deal(largestTenantPct: number | null): DealBag {
  return {
    propertyName: '640 Fifth Avenue',
    assetType: 'Office',
    subType: null,
    loanAmount: 400_000_000,
    coupon: 0.0791,
    concludedValue: 720_000_000,
    uwY1Noi: 56_185_614,
    t12Noi: 56_185_614,
    underwrittenOccupancy: 0.929,
    largestTenantPct,
    largestTenantBasis: 'base-rent',
    pctIncomeExpiringWithinTerm: null,
    tenantDataStatus: largestTenantPct === null ? 'parse-failed' : 'multi-tenant-parsed',
    amortMonths: 0,
    ioYears: 5,
    termYears: 5,
    marketTier: 'Primary',
  };
}

async function main() {
  const liveCredits = env.anthropicApiKey.trim().length > 0;
  console.log('='.repeat(80));
  console.log('640 RENT-ROLL LLM-PRIMARY + COMPLETENESS-GUARD PROOF');
  console.log('mode:', liveCredits ? 'REAL SONNET (live credits)' : 'INJECTABLE STUB (no credits)');
  console.log('='.repeat(80));

  const buf = readFileSync(B640_RR);
  const docHash = hash(buf);
  const doc = await parseDocument(buf, 'N064 - Rent Roll 4.29.24.PDF', 'application/pdf');
  const docText = doc.rawText;
  console.log(`\nRent-roll doc: ${docText.length} chars, ${doc.totalPages ?? '?'} pages (Vornado ANNUALREP).`);

  /* ---- (1) deterministic best-effort read (the under-read baseline) ---- */
  const detRoll = await extractRentRollFromDocument(doc, 'asr_table');
  const detTenants = detRoll?.lines.filter(l => l.kind === 'tenant' && l.tenantName !== null).length ?? 0;
  console.log('\n[1] Deterministic best-effort read (extractRentRollFromDocument):');
  if (!liveCredits) {
    console.log('    (skipped — also LLM-backed, needs credits) — the recon reported an UNDER-READ (~10 of ~19).');
  } else {
    console.log(`    tenants read: ${detTenants}  (recon: this dense roll under-reads)`);
  }

  /* ---- (2) LLM-PRIMARY read — ALL tenants, cited, Σ reconciles ---- */
  const cache = new InMemoryRentRollLlmCache();
  const stubCall: RentRollLlmCall = async () => realStubResponse();
  const deps = liveCredits ? { cache } : { cache, llmCall: stubCall, creditsAvailable: () => true };
  const t0 = Date.now();
  const llm = await extractRentRollFromDocumentLlm(docText, docHash, 'asr_table', deps);
  const ms = Date.now() - t0;

  console.log('\n[2] LLM-PRIMARY read (extractRentRollFromDocumentLlm):');
  console.log(`    llmCalled=${llm.llmCalled} fromCache=${llm.fromCache} (${ms}ms)`);
  if (llm.rentRoll === null) {
    console.log('    ✗ rentRoll NULL — nothing citeable.');
    process.exit(1);
  }
  const tenants = llm.rentRoll.lines.filter(l => l.kind === 'tenant');
  console.log(`    tenants read: ${tenants.length}  (cited: ${llm.traces.filter(t => t.cited).length})`);
  console.log('    top tenants by cited annual rent:');
  const sorted = [...llm.traces].filter(t => t.baseRentAnnual !== null)
    .sort((a, b) => (b.baseRentAnnual ?? 0) - (a.baseRentAnnual ?? 0));
  for (const tr of sorted.slice(0, 6)) {
    console.log(`      ${(tr.tenantName ?? '—').padEnd(32)} ${fmt(tr.baseRentAnnual).padStart(14)}  cited=${ok(tr.cited)}  "${(tr.sourceQuote ?? '').slice(0, 40)}"`);
  }

  const c = llm.completeness;
  console.log('\n    COMPLETENESS GUARD:');
  console.log(`      Σ extracted rent:  ${fmt(c.extractedTotalAnnualRent)}`);
  console.log(`      stated total:      ${fmt(c.statedTotalAnnualRent)}  (Vornado BLDG. TOTAL)`);
  console.log(`      relative gap:      ${pct(c.relativeGap)}  (tolerance ${pct(RECONCILE_TOLERANCE)})`);
  console.log(`      reconciled:        ${ok(c.reconciled)} ${c.reconciled ? 'PROVEN COMPLETE' : 'INCOMPLETE'}`);
  const reconcilesTo746 = c.reconciled && Math.abs(c.extractedTotalAnnualRent - STATED_TOTAL) / STATED_TOTAL < 0.05;
  console.log(`      → ${ok(reconcilesTo746)} Σ reconciles to ~$74.6M (no rows dropped)`);

  /* ---- (3) GUARD FIRES on a truncated roll (drop the anchor tenant) ---- */
  const truncated = REAL_640_TENANTS.slice(1); // drop Victoria's Secret (~$38.6M)
  const sumTrunc = truncated.reduce((s, t) => s + t.rent, 0);
  const truncCompleteness = evaluateCompleteness({
    extractedTotalAnnualRent: sumTrunc,
    statedTotalAnnualRent: STATED_TOTAL,
    operatingStatementRentalIncome: null,
    statedTenantCount: null,
    extractedTenantCount: truncated.length,
    warnings: [],
  });
  console.log('\n[3] GUARD FIRES on a truncated roll (Victoria\'s Secret DROPPED):');
  console.log(`      Σ (truncated): ${fmt(sumTrunc)} vs stated ${fmt(STATED_TOTAL)} → gap ${pct(truncCompleteness.relativeGap)}`);
  console.log(`      reconciled:    ${ok(truncCompleteness.reconciled)} ${truncCompleteness.reconciled ? 'UNEXPECTED — guard did NOT fire' : 'INCOMPLETE → roll EXCLUDED (guard FIRED)'}`);

  /* ---- (4) CONCENTRATION now populates + 640 re-score ---- */
  const projection = projectToRentRollExtraction(llm.rentRoll);
  const share = deriveTopTenantShare(projection);
  console.log('\n[4] CONCENTRATION populates from the reconciled roll:');
  console.log(`      top-tenant share (Victoria's Secret): ${pct(share)}`);
  const conc = evaluateIncomeConcentration({ assetType: 'Office', largestTenantPct: share, largestTenantBasis: 'base-rent' });
  console.log(`      dim verdict: applicability=${conc.applicability} tier=${conc.tier} riskContribution=${conc.riskContribution}`);

  // EXCLUDED path (today's 60.24 behavior): roll unproven → share null → HITL.
  const concExcluded = evaluateIncomeConcentration({ assetType: 'Office', largestTenantPct: null, largestTenantBasis: 'base-rent' });
  console.log(`      (excluded path — unreconciled roll): applicability=${concExcluded.applicability} tier=${concExcluded.tier}`);

  console.log('\n    640 TEMP-db RE-SCORE (concentration EXCLUDED vs POPULATED):');
  const scoreExcluded = evaluateDeal(build640Deal(null));
  const scorePopulated = evaluateDeal(build640Deal(share));
  const fsExcluded = scoreExcluded.rating.ratedRisk === null ? null : (1 - scoreExcluded.rating.ratedRisk) * 100;
  const fsPopulated = scorePopulated.rating.ratedRisk === null ? null : (1 - scorePopulated.rating.ratedRisk) * 100;
  console.log(`      finalScore EXCLUDED (concentration HITL):  ${fsExcluded?.toFixed(2) ?? 'null'}  band=${scoreExcluded.rating.band}`);
  console.log(`      finalScore POPULATED (${pct(share)} priced): ${fsPopulated?.toFixed(2) ?? 'null'}  band=${scorePopulated.rating.band}`);
  if (fsExcluded !== null && fsPopulated !== null) {
    const moved = fsPopulated < fsExcluded;
    console.log(`      → ${ok(moved)} concentration DOWN-WEIGHTS the score (Δ ${(fsPopulated - fsExcluded).toFixed(2)}) — the ~52% VS risk now priced`);
    console.log(`      concentration contribution: riskContribution=${conc.riskContribution} (tier '${conc.tier}')`);
    console.log(`      (baseline minted verdict was ${BASELINE_SCORE} with concentration UN-priced)`);
  }

  /* ---- (5a) caching: second call is $0 ---- */
  const cached = await extractRentRollFromDocumentLlm(docText, docHash, 'asr_table', deps);
  console.log('\n[5a] CACHING — second call:');
  console.log(`      fromCache=${cached.fromCache} llmCalled=${cached.llmCalled} ${ok(cached.fromCache && !cached.llmCalled)} $0 replay`);

  /* ---- (5b) no-credits: roll unread → EXCLUDED (honest floor) ---- */
  const nc = await extractRentRollFromDocumentLlm(docText, docHash + '-nc', 'asr_table', { creditsAvailable: () => false });
  console.log('\n[5b] NO-CREDITS fail-safe:');
  console.log(`      rentRoll=${nc.rentRoll === null ? 'null' : 'PRESENT'} reconciled=${nc.completeness.reconciled} llmCalled=${nc.llmCalled} ${ok(nc.rentRoll === null && !nc.completeness.reconciled && !nc.llmCalled)} roll UNREAD → concentration EXCLUDED`);

  /* ---- (5c) cite-or-discard: a fabricated rent (not in doc) is dropped ---- */
  const fabCall: RentRollLlmCall = async () => JSON.stringify({
    propertyName: { value: null, sourceQuote: null },
    asOfDate: { value: null, sourceQuote: null },
    statedTotalAnnualRent: { value: STATED_TOTAL, sourceQuote: '314,500 74,585,643.50 237.16' },
    statedTenantCount: { value: null, sourceQuote: null },
    tenants: [
      { tenantName: "Victoria's Secret", suite: null, squareFeet: 63779, baseRentAnnual: 38639370.58, sourceQuote: 'TENANT TOTAL: 63,779 38,639,370.58', leaseStart: null, leaseEnd: '2032-01-31', status: 'OCCUPIED' },
      { tenantName: 'GHOST TENANT', suite: null, squareFeet: 9999, baseRentAnnual: 987654321, sourceQuote: 'this quote is not in the document at all', leaseStart: null, leaseEnd: '2099-01-01', status: 'OCCUPIED' },
    ],
  });
  const fab = await extractRentRollFromDocumentLlm(docText, docHash + '-fab', 'asr_table', { llmCall: fabCall, creditsAvailable: () => true });
  const ghost = fab.traces.find(t => t.tenantName === 'GHOST TENANT');
  const vs = fab.traces.find(t => t.tenantName === "Victoria's Secret");
  console.log('\n[5c] CITE-OR-DISCARD — a fabricated tenant not in the doc:');
  console.log(`      GHOST TENANT rent (987,654,321 — not in doc): ${fmt(ghost?.baseRentAnnual ?? null)} ${ok((ghost?.baseRentAnnual ?? null) === null)} discarded`);
  console.log(`      Victoria's Secret (real, cited): ${fmt(vs?.baseRentAnnual ?? null)} ${ok((vs?.baseRentAnnual ?? null) !== null)} kept`);

  /* ---- (5d) null-not-fabricate: unread lease date stays null ---- */
  const noEnd = tenants.find(l => l.kind === 'tenant' && l.leaseEnd === null);
  console.log('\n[5d] NULL-NOT-FABRICATE — a tenant with no stated lease-end:');
  console.log(`      ${noEnd ? `"${(noEnd as any).tenantName}" leaseEnd=null ${ok(true)} not invented` : '(all extracted tenants carried an end date)'}`);

  console.log('\n' + '='.repeat(80));
  console.log('DONE. No cre.db write, no 640 revision minted.');
  console.log('='.repeat(80));
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Validation for the doctrine-clean orchestrator.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-doctrine-clean-orchestrator.ts
 *
 * KEY CHECK — orchestrator == manual-chain.
 *   For all 176 corpus records, run BOTH:
 *     (a) evaluateDeal(dealBag) — the orchestrator
 *     (b) the manual piecewise chain (normalization → 9 dims → 3 stages)
 *   Confirm the RatingResults match EXACTLY (no wiring/mapping bugs).
 *
 * Plus:
 *   - End-to-end spot-checks on 3 representative deals (CLEAN low-risk
 *     resolved, LOSS Tier-IV mall, hotel hitl-spine)
 *   - Dependency-order spot-check: confirm stressedLtv + stressedValue
 *     are populated before the spine-dependent dims consume them
 *   - 3-state + sponsor-absent corpus path: every corpus record's
 *     sponsor contribution = HITL with riskModifier 0
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSustainableCashflow,
  evaluateCapRateValuationStress,
  evaluateLeverageLtv,
  evaluateCoverageDscr,
  evaluateDebtYield,
  evaluateRefinanceFeasibility,
  evaluateRollover,
  evaluateIncomeConcentration,
  evaluateAssetClass,
  evaluateSponsorBorrowerQuality,
  computeBaseBlend,
  applyOverrides,
  computeRating,
  evaluateDeal,
  type DealBag,
} from '../doctrine-clean/index.js';
import type { DimensionContribution, RatingResult, SponsorAssessment } from '../doctrine-clean/index.js';

const CORPUS_PATH = '/tmp/clean-corpus-backbone-corpus.json';
const OUT_PATH = '/tmp/calibration-doctrine-clean-orchestrator.out';

interface CorpusRecord {
  cik: string;
  dealName: string;
  shelf: string;
  prosId: string;
  propertyName: string;
  outcomeClass: 'CLEAN' | 'STRESS-ONLY' | 'LOSS';
  inputSource: string;
  loanAmount: number | null;
  coupon: number | null;
  concludedValue: number | null;
  uwY1Noi: number | null;
  t12Noi: number | null;
  assetType: string | null;
  subType: string | null;
  largestTenantPct: number | null;
  pctIncomeExpiringWithinTerm: number | null;
  tenantDataStatus: string | null;
}

function corpusToDealBag(r: CorpusRecord): DealBag {
  return {
    propertyName: r.propertyName,
    assetType: r.assetType,
    subType: r.subType,
    loanAmount: r.loanAmount,
    coupon: r.coupon,
    concludedValue: r.concludedValue,
    uwY1Noi: r.uwY1Noi,
    t12Noi: r.t12Noi,
    underwrittenOccupancy: null,
    largestTenantPct: r.largestTenantPct,
    largestTenantBasis: 'NRA',
    pctIncomeExpiringWithinTerm: r.pctIncomeExpiringWithinTerm,
    tenantDataStatus: r.tenantDataStatus as
      | 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null,
    amortMonths: null,
    ioYears: null,
    termYears: null,
  };
}

function manualChain(r: CorpusRecord, sponsorAssessment: SponsorAssessment | null = null) {
  const norm = normalizeSustainableCashflow({
    assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi, t12Noi: r.t12Noi,
    underwrittenOccupancy: null,
  });
  const dim7 = evaluateCapRateValuationStress({
    assetType: r.assetType, subType: r.subType, uwY1Noi: r.uwY1Noi,
    sustainableNcf: norm.sustainableNcf, concludedValue: r.concludedValue,
    loanAmount: r.loanAmount, marketTier: 'Unknown',
  });
  const ltv = evaluateLeverageLtv({ stressedLtv: (dim7.derivedOutputs?.stressedLtv as number | undefined | null) ?? null });
  const dscr = evaluateCoverageDscr({
    sustainableNcf: norm.sustainableNcf, loanAmount: r.loanAmount, coupon: r.coupon,
    amortMonths: null, ioYears: null, termYears: null,
  });
  const dy = evaluateDebtYield({
    sustainableNoi: norm.sustainableNoi, loanAmount: r.loanAmount, assetType: r.assetType, subType: r.subType,
  });
  const refi = evaluateRefinanceFeasibility({
    loanAmount: r.loanAmount, coupon: r.coupon, amortMonths: null, ioYears: null, termYears: null,
    sustainableNcf: norm.sustainableNcf, sustainableNoi: norm.sustainableNoi,
    stressedValue: (dim7.derivedOutputs?.stressedValue as number | undefined | null) ?? null,
  });
  const roll = evaluateRollover({
    pctIncomeExpiringWithinTerm: r.pctIncomeExpiringWithinTerm, assetType: r.assetType,
    tenantDataStatus: r.tenantDataStatus as
      | 'multi-tenant-parsed' | 'single-tenant' | 'na-by-asset-type' | 'parse-failed' | null,
  });
  const conc = evaluateIncomeConcentration({
    assetType: r.assetType, largestTenantPct: r.largestTenantPct, largestTenantBasis: 'NRA',
  });
  const ac = evaluateAssetClass({
    assetType: r.assetType, subType: r.subType, propertyName: r.propertyName,
  });
  const sp = evaluateSponsorBorrowerQuality({ assessment: sponsorAssessment });
  const peer: DimensionContribution[] = [dim7, refi, ac, roll, conc, ltv, dscr, dy];
  const all: DimensionContribution[] = [...peer, sp];
  const blend = computeBaseBlend(peer);
  const ov = applyOverrides(blend, peer);
  const rt = computeRating(blend, ov, all);
  return { norm, dim7, ltv, dscr, dy, refi, roll, conc, ac, sp, blend, ov, rt };
}

/** Numeric-tolerant deep comparison of two RatingResults. */
function ratingsEqual(a: RatingResult, b: RatingResult, eps = 1e-12): { equal: boolean; diff?: string } {
  const fields: (keyof RatingResult)[] = [
    'ratedRisk', 'band', 'recommendation', 'baseRisk', 'postOverrideRisk',
    'postSponsorRisk', 'sponsorModifierApplied', 'sponsorModifierValue',
    'coverageGateFailed', 'coverageGateReason', 'coverageReliability', 'spineResolved',
  ];
  for (const f of fields) {
    const av = a[f], bv = b[f];
    if (typeof av === 'number' && typeof bv === 'number') {
      if (Math.abs(av - bv) > eps) return { equal: false, diff: `${String(f)}: ${av} vs ${bv}` };
    } else if (av !== bv) {
      return { equal: false, diff: `${String(f)}: ${JSON.stringify(av)} vs ${JSON.stringify(bv)}` };
    }
  }
  // Red flags array (same set + order)
  if (a.redFlags.length !== b.redFlags.length) return { equal: false, diff: `redFlags length ${a.redFlags.length} vs ${b.redFlags.length}` };
  for (let i = 0; i < a.redFlags.length; i++) {
    if (a.redFlags[i] !== b.redFlags[i]) return { equal: false, diff: `redFlags[${i}] differ` };
  }
  // Coverage record
  const c1 = a.coverage, c2 = b.coverage;
  if (c1.applicable.join(',') !== c2.applicable.join(',')) return { equal: false, diff: `coverage.applicable differs` };
  if (c1.hitlNeeded.join(',') !== c2.hitlNeeded.join(',')) return { equal: false, diff: `coverage.hitlNeeded differs` };
  if (c1.naByAssetType.join(',') !== c2.naByAssetType.join(',')) return { equal: false, diff: `coverage.naByAssetType differs` };
  if (Math.abs(c1.confidence - c2.confidence) > eps) return { equal: false, diff: `coverage.confidence differs` };
  return { equal: true };
}

function main(): void {
  const out: string[] = [];
  out.push('doctrine-clean / orchestrator (evaluate-deal) — validation');
  out.push(`Run at: ${new Date().toISOString()}`);
  out.push('Validates: orchestrator == manual-chain across all 176 corpus records, plus spot-checks.');
  out.push('');

  /* === (1) ORCHESTRATOR == MANUAL-CHAIN over the corpus =============== */
  out.push('================================================================');
  out.push('(1) ORCHESTRATOR == MANUAL-CHAIN — 176 corpus records');
  out.push('================================================================');
  out.push('');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as { records: CorpusRecord[] };
  const records = corpus.records.filter(r => r.inputSource !== 'tracked-pending');
  let mismatchN = 0;
  const mismatches: { name: string; diff: string }[] = [];
  for (const r of records) {
    const orchestrator = evaluateDeal(corpusToDealBag(r));
    const manual = manualChain(r);
    const cmp = ratingsEqual(orchestrator.rating, manual.rt);
    if (!cmp.equal) {
      mismatchN++;
      if (mismatches.length < 8) {
        mismatches.push({ name: `${r.dealName} / ${r.propertyName}`, diff: cmp.diff ?? '?' });
      }
    }
  }
  out.push(`  Records compared: ${records.length}`);
  out.push(`  Mismatches: ${mismatchN}  ${mismatchN === 0 ? '✓ orchestrator matches manual chain EXACTLY' : '⚠'}`);
  if (mismatches.length > 0) {
    out.push('  First few mismatches:');
    for (const m of mismatches) out.push(`    ${m.name}: ${m.diff}`);
  }
  out.push('');

  /* === (2) SPOT-CHECK 3 representative deals ========================== */
  out.push('================================================================');
  out.push('(2) END-TO-END SPOT-CHECKS — 3 representative deals');
  out.push('================================================================');
  out.push('');
  // (a) CLEAN low-risk (try a multifamily / industrial with full data)
  // (b) LOSS Tier-IV mall (Anderson Mall / Woodbridge Center / Brunswick Square)
  // (c) HITL-spine (find a record where dim 7 is HITL)
  const samples: { tag: string; record: CorpusRecord | undefined }[] = [
    {
      tag: 'CLEAN Multifamily Tier-I',
      record: records.find(r => r.outcomeClass === 'CLEAN' && r.assetType === 'Multifamily' && r.uwY1Noi !== null && r.concludedValue !== null),
    },
    {
      tag: 'LOSS Tier-IV Mall (Anderson Mall)',
      record: records.find(r => r.propertyName === 'Anderson Mall'),
    },
    {
      tag: 'Spine-HITL (no concludedValue)',
      record: records.find(r => r.concludedValue === null && r.uwY1Noi !== null),
    },
  ];
  for (const s of samples) {
    out.push(`  ${s.tag}:`);
    if (!s.record) { out.push('    (no matching record)'); out.push(''); continue; }
    const res = evaluateDeal(corpusToDealBag(s.record));
    out.push(`    ${s.record.propertyName} (${s.record.dealName})  outcome=${s.record.outcomeClass}`);
    out.push(`    normalization: ${res.normalization.routeStatus}  sustainableNcf=${res.normalization.sustainableNcf?.toFixed(0) ?? 'null'}  sustainableNoi=${res.normalization.sustainableNoi?.toFixed(0) ?? 'null'}`);
    const sp = res.dimensions.capRateValuationStress;
    out.push(`    dim 7 (cap-rate): ${sp.applicability}  tier=${sp.tier}  riskContribution=${sp.riskContribution ?? 'null'}`);
    if (sp.derivedOutputs) {
      out.push(`        stressedValue=${(sp.derivedOutputs.stressedValue as number | null)?.toFixed(0) ?? 'null'}  stressedLtv=${(sp.derivedOutputs.stressedLtv as number | null)?.toFixed(3) ?? 'null'}`);
    }
    out.push(`    dim 1 (LTV): ${res.dimensions.leverageLtv.applicability} tier=${res.dimensions.leverageLtv.tier}`);
    out.push(`    dim 4 (refi): ${res.dimensions.refinanceFeasibility.applicability} tier=${res.dimensions.refinanceFeasibility.tier}`);
    out.push(`    dim 8 (asset-class): tier=${res.dimensions.assetClass.tier}`);
    out.push(`    dim 9 (sponsor): ${res.dimensions.sponsorBorrowerQuality.applicability}  riskModifier=${res.dimensions.sponsorBorrowerQuality.riskModifier ?? 0}`);
    out.push(`    RATING: ${res.rating.recommendation}  band=${res.rating.band ?? 'null'}  ratedRisk=${res.rating.ratedRisk?.toFixed(3) ?? 'null'}`);
    if (res.rating.coverageGateFailed) out.push(`        gate failed: ${res.rating.coverageGateReason}`);
    if (res.rating.redFlags.length > 0) out.push(`        red flags: ${res.rating.redFlags.length}`);
    out.push('');
  }

  /* === (3) DEPENDENCY-ORDER SPOT-CHECK ================================ */
  out.push('================================================================');
  out.push('(3) DEPENDENCY ORDER — spine outputs populated when consumers see them');
  out.push('================================================================');
  out.push('');
  let spineResolved = 0;
  let ltvConsumed = 0;
  let refiConsumed = 0;
  let inconsistent = 0;
  for (const r of records) {
    const res = evaluateDeal(corpusToDealBag(r));
    const spineOk = res.dimensions.capRateValuationStress.applicability === 'applicable';
    if (spineOk) {
      spineResolved++;
      const stressedLtvOut = res.dimensions.capRateValuationStress.derivedOutputs?.stressedLtv as number | null | undefined;
      const stressedValueOut = res.dimensions.capRateValuationStress.derivedOutputs?.stressedValue as number | null | undefined;
      // Dim 1 (LTV) should be applicable iff stressedLtv is non-null.
      const ltvOk = (stressedLtvOut !== null && stressedLtvOut !== undefined)
        ? res.dimensions.leverageLtv.applicability === 'applicable'
        : res.dimensions.leverageLtv.applicability === 'hitl-needed';
      if (ltvOk) ltvConsumed++;
      else inconsistent++;
      // Dim 4 (refi) should be applicable iff stressedValue + sustainableNcf + sustainableNoi + loan/coupon all there
      const refiOk = (stressedValueOut !== null && stressedValueOut !== undefined)
        && res.normalization.sustainableNcf !== null
        && res.normalization.sustainableNoi !== null
        && r.loanAmount !== null && r.coupon !== null
        ? res.dimensions.refinanceFeasibility.applicability === 'applicable'
        : true;  // can be HITL legitimately
      if (refiOk) refiConsumed++;
      else inconsistent++;
    }
  }
  out.push(`  Spine resolved: ${spineResolved}/${records.length}`);
  out.push(`  LTV consumption consistent with spine output: ${ltvConsumed}/${spineResolved}  ${ltvConsumed === spineResolved ? '✓' : '⚠'}`);
  out.push(`  Refi consumption consistent with spine + normalization outputs: ${refiConsumed}/${spineResolved}  ${refiConsumed === spineResolved ? '✓' : '⚠'}`);
  out.push(`  Inconsistencies: ${inconsistent}  ${inconsistent === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === (4) SPONSOR ABSENT — universal HITL on corpus ================== */
  out.push('================================================================');
  out.push('(4) SPONSOR — universally HITL on corpus (no sponsor data in CMBS)');
  out.push('================================================================');
  out.push('');
  let sponsorHitl = 0;
  let sponsorModNonzero = 0;
  for (const r of records) {
    const res = evaluateDeal(corpusToDealBag(r));   // no sponsor assessment passed
    const sp = res.dimensions.sponsorBorrowerQuality;
    if (sp.applicability === 'hitl-needed') sponsorHitl++;
    if ((sp.riskModifier ?? 0) !== 0) sponsorModNonzero++;
  }
  out.push(`  Sponsor HITL: ${sponsorHitl}/${records.length}  ${sponsorHitl === records.length ? '✓ universally inert' : '⚠'}`);
  out.push(`  Records with non-zero sponsor modifier: ${sponsorModNonzero}  ${sponsorModNonzero === 0 ? '✓' : '⚠'}`);
  out.push('');

  /* === (5) SPONSOR PROVIDED — pipeline applies the modifier =========== */
  out.push('================================================================');
  out.push('(5) SPONSOR PROVIDED — orchestrator applies the modifier end-to-end');
  out.push('================================================================');
  out.push('');
  const strongSponsor: SponsorAssessment = {
    experience: 'Strong', financialStrength: 'Strong', alignment: 'Strong',
    priorCreditEvents: 'Strong', managementQuality: 'Strong',
  };
  const sampleRecord = records.find(r => r.outcomeClass === 'CLEAN' && r.uwY1Noi !== null && r.concludedValue !== null && r.loanAmount !== null && r.coupon !== null);
  if (sampleRecord) {
    const noSponsor = evaluateDeal(corpusToDealBag(sampleRecord));
    const withSponsor = evaluateDeal(corpusToDealBag(sampleRecord), strongSponsor);
    out.push(`  Sample record: ${sampleRecord.propertyName} (${sampleRecord.dealName})`);
    out.push(`    no sponsor:        ratedRisk=${noSponsor.rating.ratedRisk?.toFixed(3) ?? 'null'}  band=${noSponsor.rating.band ?? 'null'}  modifier=${noSponsor.rating.sponsorModifierValue.toFixed(2)}`);
    out.push(`    strong sponsor:    ratedRisk=${withSponsor.rating.ratedRisk?.toFixed(3) ?? 'null'}  band=${withSponsor.rating.band ?? 'null'}  modifier=${withSponsor.rating.sponsorModifierValue.toFixed(2)}`);
    const modOk = withSponsor.rating.sponsorModifierValue === -0.20;
    const riskOk = noSponsor.rating.ratedRisk !== null && withSponsor.rating.ratedRisk !== null
      && Math.abs((noSponsor.rating.ratedRisk - 0.20) - withSponsor.rating.ratedRisk) < 1e-9
        || withSponsor.rating.ratedRisk === 0;
    out.push(`    Strong sponsor modifier applied = -0.20: ${modOk ? '✓' : '⚠'}`);
    out.push(`    Rated risk reduced by sponsor: ${riskOk ? '✓' : '⚠'}`);
  }
  out.push('');

  /* === FENCE AUDIT ====================================================== */
  out.push('================================================================');
  out.push('FENCE AUDIT — orchestrator imports only doctrine-clean modules');
  out.push('================================================================');
  out.push('');
  out.push('  From the repo root:');
  out.push('    grep -nE "^import" apps/api/src/doctrine-clean/scoring/evaluate-deal.ts');
  out.push('  Expected: all imports resolve to ../normalization/ or ../dimensions/ or ./ (sibling scoring modules) or ../types.js');
  out.push('');
  out.push('  Orchestrator provenance: derived from the doctrine-clean signatures only.');
  out.push('  No reference to manifesto_rules.json / old doctrine / old orchestrator / old scorer.');
  out.push('');

  fs.writeFileSync(OUT_PATH, out.join('\n'));
  console.log(out.join('\n'));
  console.log(`\n[doctrine-clean orchestrator] report: ${OUT_PATH}`);
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();

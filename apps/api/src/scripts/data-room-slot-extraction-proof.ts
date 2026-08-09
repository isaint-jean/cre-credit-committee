/**
 * PROOF — Data Room Tier 2(c): rent-roll slot extraction. READ-ONLY; NO engine/LLM.
 * (A) projectRentRoll (pure): summary excludes ancillary units; pagination bounds at
 *     50; offset works; the DTO exposes NO raw `lines` (boundary not leaked).
 * (B) real data: Sunroad / 640 resolve → hydrated RentRoll → projected DTO with units.
 * (C) not_extracted basis: getRentRoll(missing) → null (→ route returns not_extracted).
 * (D) projectPca (pure): repair totals, capex schedule (0-years kept), narratives from
 *     structural; boundary — no raw uninflated schedule/structural; null schedule → [].
 * (E) real data: Sunroad pca (ExtractionResult.pca) → capex schedule + narratives.
 * (F) projectAsr (pure): valuation triple (null cap kept), S&U split (honest-null lines
 *     dropped), cash-flow columns (empty columns dropped); boundary; null → [] [] [].
 * (G) real data: Sunroad asr (ExtractionResult.asr) → NOI/value + S&U + cash flows.
 * (H) projectAppraisal (pure): value card, legacy-alias coalesce, all-blank pro-forma →
 *     null; boundary — no raw valueConclusion/pageReferences.
 * (I) real data: Sunroad appraisal PRESENT (value card) vs 640 appraisal NULL (→ not_extracted).
 *
 * Run: npx tsx src/scripts/data-room-slot-extraction-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import type { AppraisalExtraction, ASRExtraction, PCAExtraction, RentRoll, RentRollLine } from '@cre/contracts';
import { projectAppraisal, projectAsr, projectPca, projectRentRoll } from '../services/slot-extraction.service.js';
import { store } from '../storage/sqlite-store.js';
import { recordGraphStore } from '../storage/record-graph-store.js';
import { resolveAnalysisForRead } from '../services/resolve-analysis-for-read.js';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const tenant = (name: string, status: string): RentRollLine =>
  ({ kind: 'tenant', tenantName: name, suite: null, squareFeet: 1000, status, leaseStart: null, leaseEnd: '2027-01-01T00:00:00.000Z', inPlaceRentAnnual: 120000, marketRentAnnual: 130000, leaseType: 'NNN', recoveriesAnnual: null, otherIncomeAnnual: null, newTiPsf: null, renewTiPsf: null, newLcPct: null, renewLcPct: null, downtimeMonths: null, notes: null } as unknown as RentRollLine);
const ancillary = (): RentRollLine =>
  ({ kind: 'unit', unitId: 'PARK-1', isResidential: false, status: 'OCCUPIED', squareFeet: null, bedrooms: null, bathrooms: null, unitType: 'Parking', leaseStart: null, leaseEndOrMTM: null, inPlaceRentMonthly: 100, marketRentMonthly: 100, concessionsMonthly: null, securityDeposit: null, notes: null } as unknown as RentRollLine);

function main(): void {
  console.log('\nData Room Tier 2(c) rent-roll slot extraction proof (read-only)\n');

  // (A) pure projection.
  const lines: RentRollLine[] = [];
  for (let i = 0; i < 118; i++) lines.push(tenant(`Tenant ${i}`, i % 4 === 0 ? 'VACANT' : 'OCCUPIED'));
  lines.push(ancillary()); // isResidential=false → excluded from summary counts
  const synthetic: RentRoll = { id: 'rr_test' as unknown as RentRoll['id'], asOfDate: null, propertyName: 'Test', source: 'rent_roll_file', lines };

  const p0 = projectRentRoll(synthetic, 0, 50);
  check('DTO kind is rent_roll', p0.kind === 'rent_roll');
  check('page bounded to 50 (of 119 lines)', p0.units.length === 50, `${p0.units.length}`);
  check('totalCount reflects ALL lines', p0.totalCount === 119, `${p0.totalCount}`);
  check('summary excludes ancillary (118 counted units)', p0.summary.totalUnits === 118, `${p0.summary.totalUnits}`);
  check('occupiedUnits counts OCCUPIED only', p0.summary.occupiedUnits > 0 && p0.summary.occupiedUnits < 118);
  check('occupancyPct in 0..1', p0.summary.occupancyPct !== null && p0.summary.occupancyPct > 0 && p0.summary.occupancyPct <= 1);
  const p50 = projectRentRoll(synthetic, 50, 50);
  check('offset=50 returns the next page', p50.offset === 50 && p50.units.length === 50);
  const p100 = projectRentRoll(synthetic, 100, 50);
  check('final page is the remainder (19)', p100.units.length === 19, `${p100.units.length}`);
  check('boundary — DTO has NO raw `lines` field', !('lines' in (p0 as unknown as Record<string, unknown>)));
  check('unit DTO shape (label/status/rentPeriod)', typeof p0.units[0]!.label === 'string' && typeof p0.units[0]!.status === 'string' && (p0.units[0]!.rentPeriod === 'annual' || p0.units[0]!.rentPeriod === 'monthly'));

  // (B) real data — Sunroad / 640.
  let anyReal = false;
  for (const [label, dealRef] of [['Sunroad', 'bmark2024v8-sunroad-centrum'], ['640', 'bmark2024v8-640-5th-avenue']] as const) {
    const m = store.lookupAnalysisByDealRef(dealRef);
    const analysisId = m[0] ? (m[0].graphId ?? m[0].legacyId) : null;
    if (!analysisId) { check(`${label} resolves to an analysis`, false); continue; }
    const stored = (() => { try { return resolveAnalysisForRead(analysisId, recordGraphStore, store); } catch { return null; } })();
    const envelope = stored?.graphRevisionId ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as never) : null;
    const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;
    const rr = doctrine?.rentRollId ? recordGraphStore.getRentRoll(doctrine.rentRollId) : null;
    if (rr) {
      anyReal = true;
      const dto = projectRentRoll(rr, 0, 50);
      check(`${label} rent-roll projected (units present)`, dto.summary.totalUnits > 0 && dto.units.length > 0, `${dto.summary.totalUnits} units, ${dto.source}`);
    } else {
      console.log(`  · ${label}: no rent-roll extraction (would render "not extracted")`);
    }
  }
  check('at least one demo loan has a projected rent roll', anyReal);

  // (C) not_extracted basis.
  check('getRentRoll(missing) → null (route → not_extracted)', recordGraphStore.getRentRoll('nonexistent' as never) === null);

  // (D) pca pure projection.
  const syntheticPca: PCAExtraction = {
    immediateRepairs: 25000, shortTermRepairs: 0, evaluationPeriodYears: 3, inflationRate: 0.025,
    replacementReservesPerSfPerYearInflated: 0.45, replacementReservesPerSfPerYearUninflated: 0.4,
    capexScheduleInflated: [{ year: 1, amount: 1000 }, { year: 2, amount: 0 }, { year: 3, amount: 3000 }],
    capexScheduleUninflated: [{ year: 1, amount: 950 }, { year: 2, amount: 0 }, { year: 3, amount: 2800 }],
    structural: { roof: 'EPDM, ~15yr RUL', hvac: 'RTUs, good', plumbing: null, electrical: 'adequate' },
  };
  const pd = projectPca(syntheticPca);
  check('pca DTO kind is pca', pd.kind === 'pca');
  check('pca repair totals surfaced', pd.immediateRepairs === 25000 && pd.shortTermRepairs === 0);
  check('pca capex schedule mapped (incl 0-year)', pd.capexSchedule.length === 3 && pd.capexSchedule[1]!.amount === 0);
  check('pca narratives projected from structural', pd.narratives.roof === 'EPDM, ~15yr RUL' && pd.narratives.plumbing === null);
  check('boundary — DTO has NO raw capexScheduleUninflated/structural', !('capexScheduleUninflated' in (pd as unknown as Record<string, unknown>)) && !('structural' in (pd as unknown as Record<string, unknown>)));
  const pdNull = projectPca({ ...syntheticPca, capexScheduleInflated: null } as PCAExtraction);
  check('pca null-safe — absent schedule → []', Array.isArray(pdNull.capexSchedule) && pdNull.capexSchedule.length === 0);

  // (E) real data — Sunroad pca (via ExtractionResult.pca on the doctrine chain).
  {
    const m = store.lookupAnalysisByDealRef('bmark2024v8-sunroad-centrum');
    const analysisId = m[0] ? (m[0].graphId ?? m[0].legacyId) : null;
    const stored = analysisId ? (() => { try { return resolveAnalysisForRead(analysisId, recordGraphStore, store); } catch { return null; } })() : null;
    const envelope = stored?.graphRevisionId ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as never) : null;
    const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;
    const extraction = doctrine?.extractionResultId ? recordGraphStore.getExtractionResult(doctrine.extractionResultId) : null;
    const pca = extraction?.pca ?? null;
    if (pca) {
      const dto = projectPca(pca);
      check('Sunroad pca capex schedule present', dto.capexSchedule.length > 0, `${dto.capexSchedule.length} yrs, immediate ${dto.immediateRepairs}`);
      check('Sunroad pca has at least one narrative', Object.values(dto.narratives).some((v) => !!v));
    } else {
      check('Sunroad pca extraction present', false, 'no pca on ExtractionResult');
    }
  }

  // (F) asr pure projection.
  const syntheticAsr: ASRExtraction = {
    impliedValue: 133000000, impliedCapRate: null, underwrittenNOI: 9294609, priorDebtPayoff: 63932950, sponsorEquity: null,
    sourcesAndUses: {
      loanAmount: 82460000, loanPayoff: 63932950, returnOfEquity: 10792410, unfundedObligations: null,
      capitalExpenditures: null, closingCosts: 1055507, purchasePrice: null, totalCostBasis: 103900000,
      gsaRentReserve: 2584491, llObligationsGapRent: 3581588, closingReservesCapex: 513108,
    },
    underwrittenCashFlows: {
      y2021: { baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null, otherRevenue: null, potentialGrossRevenue: null, vacancyLoss: null, effectiveGrossRevenue: 8000000, realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null, managementFee: null, generalAndAdministrative: null, totalExpenses: 3000000, netOperatingIncome: 5000000, replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: 4800000 },
      y2022: { baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null, otherRevenue: null, potentialGrossRevenue: null, vacancyLoss: null, effectiveGrossRevenue: null, realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null, managementFee: null, generalAndAdministrative: null, totalExpenses: null, netOperatingIncome: null, replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: null },
      y2023: { baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null, otherRevenue: null, potentialGrossRevenue: null, vacancyLoss: null, effectiveGrossRevenue: null, realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null, managementFee: null, generalAndAdministrative: null, totalExpenses: null, netOperatingIncome: null, replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: null },
      t12: { baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null, otherRevenue: null, potentialGrossRevenue: null, vacancyLoss: null, effectiveGrossRevenue: null, realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null, managementFee: null, generalAndAdministrative: null, totalExpenses: null, netOperatingIncome: null, replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: null },
      appraisal: { baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null, otherRevenue: null, potentialGrossRevenue: null, vacancyLoss: null, effectiveGrossRevenue: null, realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null, managementFee: null, generalAndAdministrative: null, totalExpenses: null, netOperatingIncome: null, replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: null },
      uw: { baseRentalRevenue: null, commercialReimbursementRevenue: null, parkingIncome: null, otherRevenue: null, potentialGrossRevenue: 13000000, vacancyLoss: null, effectiveGrossRevenue: 12739675, realEstateTaxes: null, insurance: null, utilities: null, repairsAndMaintenance: null, managementFee: null, generalAndAdministrative: null, totalExpenses: 3445066, netOperatingIncome: 9294609, replacementReserves: null, tenantImprovements: null, leasingCommissions: null, netCashFlow: 9000000 },
    },
  } as ASRExtraction;
  const ad = projectAsr(syntheticAsr);
  check('asr DTO kind is asr', ad.kind === 'asr');
  check('asr valuation triple surfaced (cap null → null)', ad.underwrittenNOI === 9294609 && ad.impliedValue === 133000000 && ad.impliedCapRate === null);
  check('asr sources split (loan amount present)', ad.sources.some((s) => s.label === 'Loan amount' && s.amount === 82460000));
  check('asr uses drop honest-null lines (no unfundedObligations)', ad.uses.some((u) => u.label === 'Loan payoff') && !ad.uses.some((u) => u.label === 'Unfunded obligations'));
  check('asr cash-flow columns include only present ones (2021 + U/W, not empty 2022)', ad.cashFlows.some((c) => c.label === '2021') && ad.cashFlows.some((c) => c.label === 'U/W') && !ad.cashFlows.some((c) => c.label === '2022'));
  check('boundary — DTO has NO raw sourcesAndUses/underwrittenCashFlows', !('sourcesAndUses' in (ad as unknown as Record<string, unknown>)) && !('underwrittenCashFlows' in (ad as unknown as Record<string, unknown>)));
  const adNull = projectAsr({ ...syntheticAsr, sourcesAndUses: null, underwrittenCashFlows: null } as ASRExtraction);
  check('asr null-safe — absent S&U/CF → [] []', adNull.sources.length === 0 && adNull.uses.length === 0 && adNull.cashFlows.length === 0);

  // (G) real data — Sunroad asr (via ExtractionResult.asr on the doctrine chain).
  {
    const m = store.lookupAnalysisByDealRef('bmark2024v8-sunroad-centrum');
    const analysisId = m[0] ? (m[0].graphId ?? m[0].legacyId) : null;
    const stored = analysisId ? (() => { try { return resolveAnalysisForRead(analysisId, recordGraphStore, store); } catch { return null; } })() : null;
    const envelope = stored?.graphRevisionId ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as never) : null;
    const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;
    const extraction = doctrine?.extractionResultId ? recordGraphStore.getExtractionResult(doctrine.extractionResultId) : null;
    const asr = extraction?.asr ?? null;
    if (asr) {
      const dto = projectAsr(asr);
      check('Sunroad asr NOI + implied value present', dto.underwrittenNOI != null && dto.impliedValue != null, `NOI ${dto.underwrittenNOI}, value ${dto.impliedValue}`);
      check('Sunroad asr sources & uses present', dto.sources.length > 0 && dto.uses.length > 0, `${dto.sources.length} src / ${dto.uses.length} use`);
      check('Sunroad asr cash-flow ladder present', dto.cashFlows.length > 0, `${dto.cashFlows.length} cols`);
    } else {
      check('Sunroad asr extraction present', false, 'no asr on ExtractionResult');
    }
  }

  // (H) appraisal pure projection — coalesces legacy aliases; pro-forma null when all-blank.
  const richAppraisal = {
    source: 'cbre', asIsValue: 122000000, asStabilizedValue: 133000000, overallCapRate: 0.0625, terminalCapRate: 0.065,
    stabilizedOccupancy: 0.96, currentOccupancyPhysical: 0.468, asIsValueDate: '2023-07-13T00:00:00.000Z',
    methodology: 'Income Capitalization Approach', valueConclusion: 122000000, capRate: 0.0625,
    stabilizedProForma: { effectiveGrossIncome: 12536598, totalOperatingExpenses: 3932767, netOperatingIncome: 8603831 },
    currentProForma: { effectiveGrossIncome: 1942126, totalOperatingExpenses: 2297142, netOperatingIncome: -355016 },
  } as unknown as AppraisalExtraction;
  const apRich = projectAppraisal(richAppraisal);
  check('appraisal DTO kind is appraisal', apRich.kind === 'appraisal');
  check('appraisal value card surfaced', apRich.asIsValue === 122000000 && apRich.asStabilizedValue === 133000000 && apRich.asIsCapRate === 0.0625);
  check('appraisal occupancy + date surfaced', apRich.stabilizedOccupancy === 0.96 && apRich.currentOccupancy === 0.468 && apRich.valuationDate === '2023-07-13T00:00:00.000Z');
  check('appraisal pro-formas present (stab + current)', apRich.stabilizedProForma?.noi === 8603831 && apRich.currentProForma?.noi === -355016);
  check('boundary — DTO has NO raw valueConclusion/pageReferences', !('valueConclusion' in (apRich as unknown as Record<string, unknown>)) && !('pageReferences' in (apRich as unknown as Record<string, unknown>)));

  // legacy-alias-only shape (DEMO-CLEARED-MF-001 style): rich fields undefined → coalesced.
  const sparseAppraisal = { valueConclusion: 26000000, capRate: 0.0615, methodology: 'Income' } as unknown as AppraisalExtraction;
  const apSparse = projectAppraisal(sparseAppraisal);
  check('appraisal coalesces legacy aliases (valueConclusion/capRate)', apSparse.asIsValue === 26000000 && apSparse.asIsCapRate === 0.0615);
  check('appraisal all-blank pro-forma → null (never fabricated 0s)', apSparse.stabilizedProForma === null && apSparse.currentProForma === null);

  // (I) real data — Sunroad appraisal PRESENT (value card renders); 640 appraisal NULL (not_extracted).
  const apCase = (ref: string): AppraisalExtraction | null => {
    const m = store.lookupAnalysisByDealRef(ref);
    const analysisId = m[0] ? (m[0].graphId ?? m[0].legacyId) : null;
    const stored = analysisId ? (() => { try { return resolveAnalysisForRead(analysisId, recordGraphStore, store); } catch { return null; } })() : null;
    const envelope = stored?.graphRevisionId ? recordGraphStore.getRevisionEnvelope(stored.graphRevisionId as never) : null;
    const doctrine = envelope ? recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId) : null;
    const extraction = doctrine?.extractionResultId ? recordGraphStore.getExtractionResult(doctrine.extractionResultId) : null;
    return extraction?.appraisal ?? null;
  };
  const sunroadAp = apCase('bmark2024v8-sunroad-centrum');
  if (sunroadAp) {
    const dto = projectAppraisal(sunroadAp);
    check('Sunroad appraisal PRESENT → value card renders', dto.asIsValue != null && dto.asIsCapRate != null, `asIs ${dto.asIsValue}, cap ${dto.asIsCapRate}`);
  } else {
    check('Sunroad appraisal PRESENT → value card renders', false, 'unexpectedly null');
  }
  check('640 appraisal NULL → not_extracted (route returns not_extracted signal)', apCase('bmark2024v8-640-5th-avenue') === null);

  // canonical byte-identical (read-only).
  const db = new Database(path.join(process.cwd(), 'data', 'cre.db'), { readonly: true });
  const bmark = (db.prepare(`SELECT count(*) c FROM data_room_doc WHERE pool_id='323a1d02-aa5f-4a80-b280-b861fe76f6d9'`).get() as { c: number }).c;
  const head = db.prepare(`SELECT 1 FROM revision_lineage_envelopes WHERE revision_id LIKE '221235987967%' LIMIT 1`).get();
  db.close();
  check('canonical byte-identical (BMARK 17, 640 head)', bmark === 17 && !!head, `BMARK ${bmark}`);

  console.log(failures === 0 ? '\ndata-room slot-extraction proof: OK\n' : `\ndata-room slot-extraction proof: ${failures} FAILURE(S)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

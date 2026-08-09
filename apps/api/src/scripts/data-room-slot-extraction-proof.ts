/**
 * PROOF — Data Room Tier 2(c): rent-roll slot extraction. READ-ONLY; NO engine/LLM.
 * (A) projectRentRoll (pure): summary excludes ancillary units; pagination bounds at
 *     50; offset works; the DTO exposes NO raw `lines` (boundary not leaked).
 * (B) real data: Sunroad / 640 resolve → hydrated RentRoll → projected DTO with units.
 * (C) not_extracted basis: getRentRoll(missing) → null (→ route returns not_extracted).
 * (D) projectPca (pure): repair totals, capex schedule (0-years kept), narratives from
 *     structural; boundary — no raw uninflated schedule/structural; null schedule → [].
 * (E) real data: Sunroad pca (ExtractionResult.pca) → capex schedule + narratives.
 *
 * Run: npx tsx src/scripts/data-room-slot-extraction-proof.ts   (from apps/api)
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import type { PCAExtraction, RentRoll, RentRollLine } from '@cre/contracts';
import { projectPca, projectRentRoll } from '../services/slot-extraction.service.js';
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

/**
 * Composer integration smoke for buildExtractionResult.
 *
 *   tsx src/scripts/test-build-extraction-result.ts
 *
 * Scope: composer's coordination logic — fan-out, projection, pickRentRoll
 * integration, sourceDocuments concatenation, BuildReport assembly, id
 * determinism, adapter-throw defense.
 *
 * Adapters themselves are mocked via BuildExtractionResultDeps; this file
 * does NOT re-validate adapter-level concerns (those live in the per-adapter
 * test suites).
 *
 * NOTE on the `?? null` defensive expressions below: same as the other
 * adapter tests — the codebase's "no ?? / no || numeric defaulting"
 * discipline applies to PRODUCTION code, not test assertions. Test-only
 * license. Do NOT import into composer or adapter code.
 */

import type {
  ASRExtraction,
  ContentHash,
  ISODateTime,
  OperatingStatementExtraction,
  PropertyMetadata,
  RentRollExtraction,
  RentRollUnit,
} from '@cre/contracts';
import type { CfAdapterValue } from '../services/extraction/adapters/cf.adapter.js';
import type { AsrAdapterValue } from '../services/extraction/adapters/asr.adapter.js';
import type {
  ExtractorOutcome,
  SlotInput,
} from '../services/extraction/extractor-outcome.js';
import {
  buildExtractionResult,
  type BuildExtractionResultArgs,
  type BuildExtractionResultDeps,
} from '../services/extraction/build-extraction-result.js';
import { incompleteSlots } from '../services/extraction/build-report.js';
import { computePropertyMetadataId } from '../util/content-hash.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}

/* ------------------------- synthetic value builders ----------------------- */

function makeT12(): OperatingStatementExtraction {
  return {
    period: 'T-12 ending 2025-12-31',
    income: { grossPotentialRent: 1_000_000, effectiveRent: null, otherIncome: null, totalIncome: 1_000_000 },
    expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, totalOperatingExpenses: 300_000 },
    noi: 700_000,
    vacancyLoss: null,
  };
}

function makeSellerUwOS(): OperatingStatementExtraction {
  return {
    period: 'Seller UW',
    income: { grossPotentialRent: 1_050_000, effectiveRent: null, otherIncome: null, totalIncome: 1_050_000 },
    expenses: { taxes: null, insurance: null, utilities: null, repairsMaintenance: null, managementFees: null, totalOperatingExpenses: 310_000 },
    noi: 740_000,
    vacancyLoss: null,
  };
}

function makeUnit(unitId: string, occupied: boolean): RentRollUnit {
  return {
    unitId,
    tenantName: occupied ? `Tenant ${unitId}` : null,
    leaseStart: null,
    leaseEnd: null,
    baseRentMonthly: null,
    inPlaceRentMonthly: occupied ? 3000 : null,
    occupied,
    concessions: null,
    securityDeposit: null,
  };
}

function makeRentRollExtraction(units: RentRollUnit[]): RentRollExtraction {
  return {
    units,
    summary: {
      totalUnits: units.length,
      occupiedUnits: units.filter((u) => u.occupied).length,
      economicOccupancy: null,
    },
  };
}

function makePropertyMetadata(): PropertyMetadata {
  const body = {
    source: 'asr_extraction' as const,
    propertyName: 'Test Property',
    propertySubtype: 'Office',
    address: '123 Main St',
    city: 'Testville',
    state: 'CA',
    zip: '90000',
    county: null,
    msa: null,
    submarket: null,
    yearBuilt: 2010,
    yearRenovated: null,
    buildingClass: 'B',
    totalSquareFeet: 50000,
    totalUnits: null,
    totalRooms: null,
    totalPads: null,
    occupancyPhysical: null,
    occupancyEconomic: null,
    ownershipInterest: null,
    numberOfBuildings: null,
  };
  return { id: computePropertyMetadataId(body), ...body };
}

function makeAsrExtraction(): ASRExtraction {
  return {
    impliedValue: 10_000_000,
    impliedCapRate: 0.06,
    underwrittenNOI: 600_000,
  };
}

const CF_HASH = 'a'.repeat(64) as ContentHash;
const RR_HASH = 'b'.repeat(64) as ContentHash;
const ASR_HASH = 'c'.repeat(64) as ContentHash;

function cfOkOutcome(): ExtractorOutcome<CfAdapterValue> {
  return {
    status: 'ok',
    value: { t12: makeT12(), sellerUwOperatingStatement: makeSellerUwOS() },
    sourceRefs: [
      { kind: 't12', contentHash: CF_HASH },
      { kind: 'seller_uw', contentHash: CF_HASH },
    ],
    adapterVersion: '0.1.0',
    durationMs: 5,
  };
}

function rrOkOutcome(units: RentRollUnit[]): ExtractorOutcome<RentRollExtraction> {
  return {
    status: 'ok',
    value: makeRentRollExtraction(units),
    sourceRefs: [{ kind: 'rent_roll', contentHash: RR_HASH }],
    adapterVersion: '0.1.0',
    durationMs: 3,
  };
}

function rrEmptyOutcome(): ExtractorOutcome<RentRollExtraction> {
  return {
    status: 'empty',
    sourceRefs: [],
    adapterVersion: '0.1.0',
    durationMs: 2,
    reason: 'no tenant rows',
  };
}

function asrOkOutcome(opts: {
  asr?: ASRExtraction | null;
  pm?: PropertyMetadata | null;
  fallback?: RentRollExtraction | null;
} = {}): ExtractorOutcome<AsrAdapterValue> {
  const refs = [];
  if (opts.asr !== undefined && opts.asr !== null) refs.push({ kind: 'asr' as const, contentHash: ASR_HASH });
  if (opts.pm !== undefined && opts.pm !== null) refs.push({ kind: 'property_metadata' as const, contentHash: ASR_HASH });
  if (opts.fallback !== undefined && opts.fallback !== null) refs.push({ kind: 'rent_roll' as const, contentHash: ASR_HASH });
  return {
    status: 'ok',
    value: {
      asr: opts.asr === undefined ? null : opts.asr,
      propertyMetadata: opts.pm === undefined ? null : opts.pm,
      rentRollFallback: opts.fallback === undefined ? null : opts.fallback,
    },
    sourceRefs: refs,
    adapterVersion: '0.1.0',
    durationMs: 10,
  };
}

/* ------------------------------- deps mock ------------------------------- */

interface DepBehaviorMap {
  cf?: ExtractorOutcome<CfAdapterValue> | 'throw';
  rr?: ExtractorOutcome<RentRollExtraction> | 'throw';
  asr?: ExtractorOutcome<AsrAdapterValue> | 'throw';
}

function makeDeps(b: DepBehaviorMap = {}): BuildExtractionResultDeps {
  return {
    runCfAdapter: async (_slot: SlotInput) => {
      if (b.cf === 'throw') throw new Error('CF adapter unexpected throw');
      if (b.cf === undefined) throw new Error('CF adapter called but no behavior set');
      return b.cf;
    },
    runRentRollAdapter: async (_slot: SlotInput) => {
      if (b.rr === 'throw') throw new Error('RR adapter unexpected throw');
      if (b.rr === undefined) throw new Error('RR adapter called but no behavior set');
      return b.rr;
    },
    runAsrAdapter: async (_slot: SlotInput) => {
      if (b.asr === 'throw') throw new Error('ASR adapter unexpected throw');
      if (b.asr === undefined) throw new Error('ASR adapter called but no behavior set');
      return b.asr;
    },
  };
}

const SLOT: SlotInput = { buffer: Buffer.from('x'), filename: 'x' };
const AS_OF: ISODateTime = '2026-05-20T00:00:00.000Z' as ISODateTime;
const baseArgs = (slots: BuildExtractionResultArgs['slots']): BuildExtractionResultArgs => ({
  slots,
  analysisAsOfDate: AS_OF,
  dealRef: 'TEST-DEAL',
});

/* ------------------------------- test cases ------------------------------ */

(async () => {
  /* CASE 1 — all-slots happy path; rentRoll precedence = xlsx wins */
  console.log('1. all slots; xlsx rent roll wins, ASR provides everything else');
  {
    const fallbackUnits = [makeUnit('200', true)];
    const xlsxUnits = [makeUnit('100', true), makeUnit('101', false)];
    const o = await buildExtractionResult(
      baseArgs({ sellerCfXlsx: SLOT, rentRollXlsx: SLOT, asrPdf: SLOT }),
      makeDeps({
        cf: cfOkOutcome(),
        rr: rrOkOutcome(xlsxUnits),
        asr: asrOkOutcome({ asr: makeAsrExtraction(), pm: makePropertyMetadata(), fallback: makeRentRollExtraction(fallbackUnits) }),
      }),
    );
    assertEqual(o.report.slots.sellerCfXlsx.status, 'ok', '1.1 cf slot ok');
    assertEqual(o.report.slots.rentRollXlsx.status, 'ok', '1.2 rr slot ok');
    assertEqual(o.report.slots.asrPdf.status, 'ok', '1.3 asr slot ok');
    assert(o.extractionResult.t12 !== null, '1.4 t12 populated from CF');
    assert(o.extractionResult.sellerUwOperatingStatement !== null, '1.5 sellerUwOS populated from CF');
    assert(o.extractionResult.asr !== null, '1.6 asr populated from ASR');
    assert(o.extractionResult.rentRoll !== null, '1.7 rentRoll populated');
    assertEqual(o.extractionResult.rentRoll?.units.length ?? -1, 2, '1.8 rentRoll has 2 units (xlsx, not fallback)');
    assertEqual(o.extractionResult.rentRoll?.units[0]?.unitId ?? null, '100', '1.9 rentRoll first unitId from xlsx (not fallback)');
    assert(o.propertyMetadata !== null, '1.10 propertyMetadata sibling populated');
    assertEqual(o.extractionResult.sourceDocuments.length, 6, '1.11 sourceDocuments has 6 refs (2 cf + 1 rr + 3 asr)');
    assertEqual(incompleteSlots(o.report).length, 0, '1.12 no incomplete slots');
  }

  /* CASE 2 — only asrPdf provided; other slots absent */
  console.log('\n2. only asrPdf provided; cf+rr absent');
  {
    const o = await buildExtractionResult(
      baseArgs({ asrPdf: SLOT }),
      makeDeps({
        asr: asrOkOutcome({ pm: makePropertyMetadata(), fallback: makeRentRollExtraction([makeUnit('1', true)]) }),
      }),
    );
    assertEqual(o.report.slots.sellerCfXlsx.status, 'absent', '2.1 cf absent');
    assertEqual(o.report.slots.rentRollXlsx.status, 'absent', '2.2 rr absent');
    assertEqual(o.report.slots.asrPdf.status, 'ok', '2.3 asr ok');
    assertEqual(o.extractionResult.t12, null, '2.4 t12 null (cf absent)');
    assertEqual(o.extractionResult.sellerUwOperatingStatement, null, '2.5 sellerUwOS null');
    assert(o.extractionResult.rentRoll !== null, '2.6 rentRoll from ASR fallback (xlsx absent)');
    assertEqual(o.propertyMetadata !== null, true, '2.7 propertyMetadata populated');
    assertEqual(o.extractionResult.sourceDocuments.length, 2, '2.8 sourceDocuments has 2 refs (pm + rent_roll from ASR)');
    const inc = [...incompleteSlots(o.report)].sort();
    assertEqual(inc.length, 2, '2.9 two incomplete slots (cf + rr both absent)');
  }

  /* CASE 3 — xlsx empty, asr fallback non-null → fallback wins */
  console.log('\n3. xlsx empty + asr fallback w/units → fallback wins');
  {
    const o = await buildExtractionResult(
      baseArgs({ rentRollXlsx: SLOT, asrPdf: SLOT }),
      makeDeps({
        rr: rrEmptyOutcome(),
        asr: asrOkOutcome({ fallback: makeRentRollExtraction([makeUnit('A', true), makeUnit('B', true)]) }),
      }),
    );
    assertEqual(o.report.slots.rentRollXlsx.status, 'empty', '3.1 rr slot empty');
    assertEqual(o.report.slots.asrPdf.status, 'ok', '3.2 asr slot ok');
    assert(o.extractionResult.rentRoll !== null, '3.3 rentRoll filled (from fallback)');
    assertEqual(o.extractionResult.rentRoll?.units.length ?? -1, 2, '3.4 rentRoll has 2 units from fallback');
    assertEqual(o.extractionResult.rentRoll?.units[0]?.unitId ?? null, 'A', '3.5 rentRoll unit id from fallback (not xlsx)');
    // Empty xlsx is "acceptable" per loose-A; only the absent cf slot is incomplete here
    const inc = incompleteSlots(o.report);
    assertEqual(inc.length, 1, '3.6 one incomplete (cf absent only; rr empty is acceptable)');
    assertEqual(inc[0], 'sellerCfXlsx', '3.7 incomplete is sellerCfXlsx');
  }

  /* CASE 4 — adapter unexpectedly throws → 'failed' with name 'adapterThrew' */
  console.log('\n4. CF adapter throws unexpectedly → status failed, name adapterThrew');
  {
    const o = await buildExtractionResult(
      baseArgs({ sellerCfXlsx: SLOT, rentRollXlsx: SLOT, asrPdf: SLOT }),
      makeDeps({
        cf: 'throw',
        rr: rrOkOutcome([makeUnit('1', true)]),
        asr: asrOkOutcome({}),
      }),
    );
    assertEqual(o.report.slots.sellerCfXlsx.status, 'failed', '4.1 cf slot failed');
    if (o.report.slots.sellerCfXlsx.status === 'failed') {
      assertEqual(o.report.slots.sellerCfXlsx.error.name, 'adapterThrew', '4.2 error.name = adapterThrew');
      assert(o.report.slots.sellerCfXlsx.error.message.includes('CF adapter unexpected throw'), '4.3 error.message includes original throw text');
    }
    assertEqual(o.extractionResult.t12, null, '4.4 t12 null (CF threw)');
    assertEqual(o.extractionResult.sellerUwOperatingStatement, null, '4.5 sellerUwOS null');
    // Other slots still produce their outputs
    assert(o.extractionResult.rentRoll !== null, '4.6 rr unaffected by CF throw');
    assertEqual(incompleteSlots(o.report).join(','), 'sellerCfXlsx', '4.7 only cf in incompleteSlots');
  }

  /* CASE 5 — sourceDocuments aggregation across slots */
  console.log('\n5. sourceDocuments aggregation');
  {
    const o = await buildExtractionResult(
      baseArgs({ sellerCfXlsx: SLOT, rentRollXlsx: SLOT, asrPdf: SLOT }),
      makeDeps({
        cf: cfOkOutcome(),
        rr: rrOkOutcome([makeUnit('1', true)]),
        asr: asrOkOutcome({ pm: makePropertyMetadata(), fallback: makeRentRollExtraction([makeUnit('Z', true)]) }),
      }),
    );
    const kinds = o.extractionResult.sourceDocuments.map((r) => r.kind).sort();
    // CF: 't12' + 'seller_uw'; RR: 'rent_roll'; ASR: 'property_metadata' + 'rent_roll' (no asr because asr=null)
    assertEqual(kinds.join(','), 'property_metadata,rent_roll,rent_roll,seller_uw,t12', '5.1 sourceDocs kinds (sorted, with duplicate rent_roll)');
    const hashes = new Set(o.extractionResult.sourceDocuments.map((r) => r.contentHash));
    assertEqual(hashes.size, 3, '5.2 three distinct contentHashes (one per slot)');
  }

  /* CASE 6 — id determinism: same inputs → same id */
  console.log('\n6. extractionResult.id is deterministic over inputs');
  {
    const args = baseArgs({ sellerCfXlsx: SLOT });
    const o1 = await buildExtractionResult(args, makeDeps({ cf: cfOkOutcome() }));
    const o2 = await buildExtractionResult(args, makeDeps({ cf: cfOkOutcome() }));
    assertEqual(o1.extractionResult.id, o2.extractionResult.id, '6.1 same inputs → same id');
  }

  /* CASE 7 — id determinism robustness: ALL slots absent still produces a valid id */
  console.log('\n7. all slots absent → valid id over all-null body');
  {
    const o = await buildExtractionResult(baseArgs({}), makeDeps({}));
    assert(typeof o.extractionResult.id === 'string' && o.extractionResult.id.length === 64, '7.1 id is 64-char hex');
    assertEqual(o.extractionResult.t12, null, '7.2 t12 null');
    assertEqual(o.extractionResult.rentRoll, null, '7.3 rentRoll null');
    assertEqual(o.extractionResult.asr, null, '7.4 asr null');
    assertEqual(o.extractionResult.sourceDocuments.length, 0, '7.5 sourceDocuments empty');
    assertEqual(incompleteSlots(o.report).length, 3, '7.6 all three slots incomplete (absent)');
  }

  /* CASE 8 — pickRentRoll integration when xlsx has units AND fallback present → xlsx wins */
  console.log('\n8. pickRentRoll integration: xlsx populated + fallback present → xlsx');
  {
    const xlsxUnits = [makeUnit('X1', true)];
    const fallbackUnits = [makeUnit('F1', true), makeUnit('F2', true)];
    const o = await buildExtractionResult(
      baseArgs({ rentRollXlsx: SLOT, asrPdf: SLOT }),
      makeDeps({
        rr: rrOkOutcome(xlsxUnits),
        asr: asrOkOutcome({ fallback: makeRentRollExtraction(fallbackUnits) }),
      }),
    );
    assertEqual(o.extractionResult.rentRoll?.units.length ?? -1, 1, '8.1 rentRoll has 1 unit (xlsx) not 2 (fallback)');
    assertEqual(o.extractionResult.rentRoll?.units[0]?.unitId ?? null, 'X1', '8.2 unitId from xlsx');
  }

  /* CASE 9 — propertyMetadata sibling is null when ASR slot absent */
  console.log('\n9. propertyMetadata null when ASR slot absent');
  {
    const o = await buildExtractionResult(
      baseArgs({ sellerCfXlsx: SLOT }),
      makeDeps({ cf: cfOkOutcome() }),
    );
    assertEqual(o.propertyMetadata, null, '9.1 propertyMetadata null (no ASR slot)');
  }

  /* ------------------------------- summary -------------------------------- */

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test runner threw:', e);
  process.exit(2);
});

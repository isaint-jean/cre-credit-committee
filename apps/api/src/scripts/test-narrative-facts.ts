/**
 * Tests for narrative-facts.service.ts (Batch 6.3.5).
 *
 *   npm run test:narrative-facts
 *
 * Covers:
 *   - Happy path: every sourceable field populated correctly from a full extraction
 *   - Missing rent roll → occupancyCurrent + isSingleTenant null (UNKNOWN)
 *   - Empty rent-roll units → isSingleTenant === false (structurally observable)
 *   - Missing appraisal / asr → corresponding fields null
 *   - Single-tenant detection: 1 distinct tenant → true
 *   - Multi-tenant detection: 2+ distinct tenants → false
 *   - All-vacant rent roll (units present, all tenantName null) → isSingleTenant false
 *   - Idempotency: same input → byte-identical id
 *   - Null-field enforcement: 13 unsourced fields are unconditionally null
 *   - analysisAsOfDate stamped from args, not extraction
 */

import {
  EXTRACTION_ENGINE_VERSION,
  type ExtractionResult,
  type NarrativeFacts,
  type RentRollExtraction,
  type RentRollUnit,
  type AppraisalExtraction,
  type ASRExtraction,
} from '@cre/contracts';
import { buildNarrativeFacts } from '../services/narrative-facts.service.js';
import { computeExtractionResultId } from '../util/content-hash.js';

const AS_OF = '2026-05-08T00:00:00Z';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log(`  ok    ${m}`); }
function fail(m: string): void { failed++; console.error(`  FAIL  ${m}`); }
function assertEqual<T>(a: T, b: T, m: string): void {
  a === b ? ok(m) : fail(`${m} (actual=${JSON.stringify(a)}, expected=${JSON.stringify(b)})`);
}
function assert(c: boolean, m: string): void { c ? ok(m) : fail(m); }

/* ----------------------------- fixture builders ---------------------------- */

function unit(opts: Partial<RentRollUnit> & { unitId: string }): RentRollUnit {
  return {
    tenantName: null,
    leaseStart: null,
    leaseEnd: null,
    baseRentMonthly: null,
    inPlaceRentMonthly: null,
    occupied: false,
    concessions: null,
    securityDeposit: null,
    ...opts,
  };
}

function rentRoll(opts: {
  units: readonly RentRollUnit[];
  totalUnits?: number;
  occupiedUnits?: number;
  economicOccupancy?: number | null;
}): RentRollExtraction {
  return {
    units: opts.units,
    summary: {
      totalUnits: opts.totalUnits ?? opts.units.length,
      occupiedUnits: opts.occupiedUnits ?? opts.units.filter((u) => u.occupied).length,
      economicOccupancy: opts.economicOccupancy ?? null,
    },
  };
}

function appraisal(value: number | null, cap: number | null): AppraisalExtraction {
  return { valueConclusion: value, capRate: cap, methodology: null };
}

function asr(value: number | null, cap: number | null): ASRExtraction {
  return { impliedValue: value, impliedCapRate: cap, underwrittenNOI: null };
}

function makeExtraction(opts: Partial<{
  rentRoll: RentRollExtraction | null;
  appraisal: AppraisalExtraction | null;
  asr: ASRExtraction | null;
  analysisAsOfDate: string;
  dealRef: string;
}> = {}): ExtractionResult {
  const body = {
    analysisAsOfDate: opts.analysisAsOfDate ?? AS_OF,
    extractionEngineVersion: EXTRACTION_ENGINE_VERSION,
    dealRef: opts.dealRef ?? 'NF-TEST',
    rentRoll: 'rentRoll' in opts ? opts.rentRoll! : null,
    t12: null,
    pca: null,
    appraisal: 'appraisal' in opts ? opts.appraisal! : null,
    sellerUw: null, sellerUwOperatingStatement: null, asr: 'asr' in opts ? opts.asr! : null,
    loanTerms: null,
    sourceDocuments: [],
    extractorVersions: {},
  };
  return { id: computeExtractionResultId(body), ...body } as ExtractionResult;
}

const NULL_FIELDS: ReadonlyArray<keyof NarrativeFacts> = [
  'trailingOccAvg',
  'propertyClass',
  'shadowVacancyFlag',
  'subleaseCompetition',
  'leasingVelocityDataAvailable',
  'isMall',
  'franchiseExpirationWithinTerm',
  'pipRequired',
  'pipBudgetPerKey',
  'privateWastewater',
  'parkOwnedHomesPct',
  't12NoiTrend',
  'marketValueFromComps',
  'exitCapRateBase',
  'exitCapRateStressed',
];

function assertAllNullFieldsNull(nf: NarrativeFacts, label: string): void {
  for (const k of NULL_FIELDS) {
    assertEqual(nf[k], null, `${label}: ${k} === null`);
  }
}

/* --------------------------------- tests --------------------------------- */

console.log('Happy path — full extraction:');
{
  const ext = makeExtraction({
    rentRoll: rentRoll({
      units: [
        unit({ unitId: 'A', tenantName: 'Acme Corp', occupied: true }),
        unit({ unitId: 'B', tenantName: 'Beta Ltd',  occupied: true }),
      ],
      economicOccupancy: 0.95,
    }),
    appraisal: appraisal(16_500_000, 0.06),
    asr: asr(18_000_000, 0.06),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });

  assertEqual(nf.analysisAsOfDate, AS_OF, 'analysisAsOfDate stamped from args');
  assertEqual(nf.occupancyCurrent, 0.95, 'occupancyCurrent passes through economicOccupancy');
  assertEqual(nf.appraisalValue, 16_500_000, 'appraisalValue passes through');
  assertEqual(nf.appraisalCapRate, 0.06, 'appraisalCapRate passes through');
  assertEqual(nf.asrValue, 18_000_000, 'asrValue passes through');
  assertEqual(nf.isSingleTenant, false, '2 distinct tenants → isSingleTenant false');
  assertAllNullFieldsNull(nf, 'happy path');
}

console.log('\nMissing rent roll (UNKNOWN):');
{
  const ext = makeExtraction({ rentRoll: null });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });

  assertEqual(nf.occupancyCurrent, null, 'occupancyCurrent null when rentRoll null');
  assertEqual(nf.isSingleTenant, null, 'isSingleTenant null (UNKNOWN) when rentRoll null');
}

console.log('\nEmpty rent-roll units (FALSE — structural fact, not unknown):');
{
  const ext = makeExtraction({
    rentRoll: rentRoll({ units: [], totalUnits: 0, occupiedUnits: 0, economicOccupancy: null }),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });

  assertEqual(nf.isSingleTenant, false, 'empty units array → isSingleTenant false (CRITICAL)');
  assertEqual(nf.occupancyCurrent, null, 'occupancyCurrent passes through null economicOccupancy');
}

console.log('\nSingle-tenant detection:');
{
  const ext = makeExtraction({
    rentRoll: rentRoll({
      units: [
        unit({ unitId: 'A', tenantName: 'Sole Tenant', occupied: true }),
        unit({ unitId: 'B', tenantName: 'Sole Tenant', occupied: true }),
        unit({ unitId: 'C', tenantName: 'Sole Tenant', occupied: true }),
      ],
    }),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.isSingleTenant, true, '3 units, 1 distinct name → isSingleTenant true');
}

console.log('\nMulti-tenant detection (2+ distinct):');
{
  const ext = makeExtraction({
    rentRoll: rentRoll({
      units: [
        unit({ unitId: 'A', tenantName: 'Acme', occupied: true }),
        unit({ unitId: 'B', tenantName: 'Beta', occupied: true }),
        unit({ unitId: 'C', tenantName: 'Gamma', occupied: true }),
      ],
    }),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.isSingleTenant, false, '3 distinct tenants → isSingleTenant false');
}

console.log('\nAll-vacant rent roll (units present, all tenantName null):');
{
  const ext = makeExtraction({
    rentRoll: rentRoll({
      units: [
        unit({ unitId: 'A', tenantName: null, occupied: false }),
        unit({ unitId: 'B', tenantName: null, occupied: false }),
      ],
    }),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.isSingleTenant, false, '0 distinct named tenants in non-empty array → false');
}

console.log('\nMixed null + named tenants (only named count toward distinct):');
{
  const ext = makeExtraction({
    rentRoll: rentRoll({
      units: [
        unit({ unitId: 'A', tenantName: 'Acme', occupied: true }),
        unit({ unitId: 'B', tenantName: null, occupied: false }),
        unit({ unitId: 'C', tenantName: 'Acme', occupied: true }),
      ],
    }),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.isSingleTenant, true, '1 distinct named (vacant units excluded) → true');
}

console.log('\nMissing appraisal:');
{
  const ext = makeExtraction({ appraisal: null });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.appraisalValue, null, 'appraisalValue null when appraisal null');
  assertEqual(nf.appraisalCapRate, null, 'appraisalCapRate null when appraisal null');
}

console.log('\nMissing ASR:');
{
  const ext = makeExtraction({ asr: null });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.asrValue, null, 'asrValue null when asr null');
}

console.log('\nNull-field passthrough on present-but-null inner fields:');
{
  const ext = makeExtraction({
    appraisal: appraisal(null, null),
    asr: asr(null, null),
  });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: AS_OF });
  assertEqual(nf.appraisalValue, null, 'null valueConclusion passes through');
  assertEqual(nf.appraisalCapRate, null, 'null capRate passes through');
  assertEqual(nf.asrValue, null, 'null impliedValue passes through');
}

console.log('\nIdempotency:');
{
  const ext1 = makeExtraction({
    rentRoll: rentRoll({
      units: [unit({ unitId: 'A', tenantName: 'X', occupied: true })],
      economicOccupancy: 0.92,
    }),
    appraisal: appraisal(10_000_000, 0.07),
    asr: asr(11_000_000, 0.07),
  });
  const ext2 = makeExtraction({
    rentRoll: rentRoll({
      units: [unit({ unitId: 'A', tenantName: 'X', occupied: true })],
      economicOccupancy: 0.92,
    }),
    appraisal: appraisal(10_000_000, 0.07),
    asr: asr(11_000_000, 0.07),
  });
  const a = buildNarrativeFacts({ extractionResult: ext1, analysisAsOfDate: AS_OF });
  const b = buildNarrativeFacts({ extractionResult: ext2, analysisAsOfDate: AS_OF });
  assertEqual(a.id, b.id, 'identical inputs → identical NarrativeFactsId');
}

console.log('\nDifferent inputs → different ids:');
{
  const ext1 = makeExtraction({ appraisal: appraisal(10_000_000, 0.07) });
  const ext2 = makeExtraction({ appraisal: appraisal(11_000_000, 0.07) });
  const a = buildNarrativeFacts({ extractionResult: ext1, analysisAsOfDate: AS_OF });
  const b = buildNarrativeFacts({ extractionResult: ext2, analysisAsOfDate: AS_OF });
  assert(a.id !== b.id, 'different appraisalValue → different ids');
}

console.log('\nanalysisAsOfDate stamped from args, not extraction:');
{
  const extDate = '2025-01-01T00:00:00Z';
  const argDate = '2026-12-31T00:00:00Z';
  const ext = makeExtraction({ analysisAsOfDate: extDate });
  const nf = buildNarrativeFacts({ extractionResult: ext, analysisAsOfDate: argDate });
  assertEqual(nf.analysisAsOfDate, argDate, 'NarrativeFacts stamps args.analysisAsOfDate');
}

/* ---------------------------------- summary -------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

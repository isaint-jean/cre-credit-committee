/**
 * Stage 1 validation — Annex A adapter parity + 6-shelf inventory.
 *
 *   cd apps/api && npx tsx src/scripts/calibration-annexA-stage1-validation.ts
 *
 * What this proves:
 *   1. The runAnnexAAdapter slot produces the same 22 typed fields the spike
 *      hand-decoded for WFRBS 2013-C11 / Loan #17 (parity baseline). No
 *      regression through the slot plumbing.
 *   2. The other 5 backbone shelves return null with a typed report
 *      explaining WHY — either source-missing (local cache absent) or
 *      anchors-only (anchors confirmed by the survey parser; no value-
 *      extraction generalizer yet). Honest "not yet" rather than silent
 *      empty payload.
 *
 * No engine wiring. No judgment-side reads. No registry flips. This is
 * pure adapter plumbing validation against the existing spike payload.
 */
import { fileURLToPath } from 'node:url';
import {
  runAnnexAAdapter,
  getAnnexAAdapterVersion,
  type AnnexAShelfKey,
} from '../services/extraction/adapters/annexA.adapter.js';
import type { AnnexAExtraction } from '@cre/contracts';
import { EXTRACTION_ENGINE_VERSION } from '@cre/contracts';

interface ShelfProbe {
  readonly key: AnnexAShelfKey;
  readonly displayName: string;
  readonly loanRef: string;
}

const PROBES: ShelfProbe[] = [
  { key: 'WFRBS_2013_C11',   displayName: 'WFRBS 2013-C11   (proven baseline)',     loanRef: 'loan-17' },
  { key: 'CGCMT_2013_GCJ11', displayName: 'CGCMT 2013-GCJ11',                       loanRef: 'loan-1'  },
  { key: 'MSBAM_2013',        displayName: 'MSBAM 2013',                            loanRef: 'loan-1'  },
  { key: 'JPMBB_2013_C12',    displayName: 'JPMBB 2013-C12',                         loanRef: 'loan-1'  },
  { key: 'WFCM_2015_LC20',    displayName: 'WFCM 2015-LC20',                         loanRef: 'loan-1'  },
  { key: 'CSMC_2016_NXSR',    displayName: 'CSMC 2016-NXSR',                         loanRef: 'loan-1'  },
];

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return '$' + (n / 1_000).toFixed(0)     + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}
function fmtNum(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function printExtraction(e: AnnexAExtraction): void {
  console.log(`  Loan terms:`);
  console.log(`    loanAmount               : ${fmtUsd(e.loanAmount)}`);
  console.log(`    termYears                : ${fmtNum(e.termYears, 1)}`);
  console.log(`    amortMonths              : ${fmtNum(e.amortMonths, 0)}`);
  console.log(`    ioYears                  : ${fmtNum(e.ioYears, 1)}`);
  console.log(`    coupon                   : ${fmtPct(e.coupon)}`);
  console.log(`    maturityDate             : ${e.maturityDate ?? '—'}`);
  console.log(`  Property:`);
  console.log(`    assetType                : ${e.assetType ?? '—'}`);
  console.log(`    subType                  : ${e.subType ?? '—'}`);
  console.log(`    occupancyCurrent         : ${fmtPct(e.occupancyCurrent)}`);
  console.log(`  Issuer financials (TTM / UW):`);
  console.log(`    t12Noi                   : ${fmtUsd(e.t12Noi)}`);
  console.log(`    t12Egi                   : ${fmtUsd(e.t12Egi)}`);
  console.log(`    t12OpEx                  : ${fmtUsd(e.t12OpEx)}`);
  console.log(`    priorPeriodNoi           : ${fmtUsd(e.priorPeriodNoi)}`);
  console.log(`    uwY1Noi                  : ${fmtUsd(e.uwY1Noi)}  ← issuer UW (cross-ref only; NOT metrics.noi)`);
  console.log(`    uwDscr                   : ${fmtNum(e.uwDscr, 2)}`);
  console.log(`    uwDebtYield              : ${fmtPct(e.uwDebtYield)}`);
  console.log(`  Valuation:`);
  console.log(`    concludedValue           : ${fmtUsd(e.concludedValue)}  ← appraised; cross-ref to operator value`);
  console.log(`    concludedLtv             : ${fmtPct(e.concludedLtv)}`);
  console.log(`  Reserves:`);
  console.log(`    pipOrCapexReserve        : ${fmtUsd(e.pipOrCapexReserve)}`);
  console.log(`    tiLcReserve              : ${fmtUsd(e.tiLcReserve)}`);
  console.log(`  Tenant:`);
  console.log(`    largestTenant            : ${e.largestTenant ?? '—'}`);
  console.log(`    leaseExpirationLargest   : ${e.leaseExpirationLargest ?? '—'}`);
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('ANNEX A — STAGE 1 ADAPTER VALIDATION');
  console.log(`EXTRACTION_ENGINE_VERSION = ${EXTRACTION_ENGINE_VERSION}`);
  console.log(`adapter version           = ${getAnnexAAdapterVersion()}`);
  console.log('================================================================');
  console.log('');

  let proven = 0, anchorsOnly = 0, sourceMissing = 0, notFound = 0;
  for (const probe of PROBES) {
    console.log('-'.repeat(78));
    console.log(`SHELF: ${probe.displayName}  ·  loanRef=${probe.loanRef}`);
    const result = runAnnexAAdapter({ shelfKey: probe.key, loanRef: probe.loanRef });
    console.log(`  status            : ${result.report.status}`);
    console.log(`  anchor coverage   : ${result.report.anchorCoverage ?? '—'} / 22`);
    console.log(`  rationale         : ${result.report.rationale}`);
    console.log('');
    if (result.extraction !== null) {
      console.log('  → Extraction payload (the 22 typed fields):');
      printExtraction(result.extraction);
      proven++;
    } else if (result.report.status === 'anchors-only') {
      anchorsOnly++;
    } else if (result.report.status === 'source-missing') {
      sourceMissing++;
    } else {
      notFound++;
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log('SUMMARY');
  console.log('='.repeat(78));
  console.log(`  proven (22 fields)     : ${proven}/${PROBES.length}`);
  console.log(`  anchors-only           : ${anchorsOnly}/${PROBES.length}`);
  console.log(`  source-missing         : ${sourceMissing}/${PROBES.length}`);
  console.log(`  anchors-not-found      : ${notFound}/${PROBES.length}`);
  console.log('');
  console.log('Parity check (vs the hand-decoded spike for WFRBS 2013-C11 Loan #17):');
  const ref = runAnnexAAdapter({ shelfKey: 'WFRBS_2013_C11', loanRef: 'loan-17' });
  if (ref.extraction === null) {
    console.log(`  ⚠ baseline source missing — cannot run parity check.`);
    console.log(`    Place /tmp/wfrbs-2013-c11-424B5.htm to enable the spike payload.`);
  } else {
    const e = ref.extraction;
    const expected: Array<[string, unknown, unknown]> = [
      ['loanAmount',          e.loanAmount,          15_000_000],
      ['coupon',              e.coupon,              0.04677],
      ['amortMonths',         e.amortMonths,         300],
      ['uwY1Noi',             e.uwY1Noi,             3_330_324],
      ['concludedValue',      e.concludedValue,      25_100_000],
      ['concludedLtv',        e.concludedLtv,        0.597],
      ['uwDscr',              e.uwDscr,              2.77],
      ['uwDebtYield',         e.uwDebtYield,         0.189],
      ['occupancyCurrent',    e.occupancyCurrent,    0.812],
      ['t12Noi',              e.t12Noi,              2_823_742],
      ['priorPeriodNoi',      e.priorPeriodNoi,      1_763_001],
      ['pipOrCapexReserve',   e.pipOrCapexReserve,   2_557_500],
      ['assetType',           e.assetType,           'Hotel'],
    ];
    let allPass = true;
    for (const [field, actual, expectedVal] of expected) {
      const pass = actual === expectedVal;
      if (!pass) allPass = false;
      console.log(`  ${pass ? '✓' : '✗'} ${field.padEnd(22)} adapter=${String(actual).padStart(15)}   spike=${String(expectedVal).padStart(15)}`);
    }
    console.log('');
    console.log(`  ${allPass ? '✓ PASS — all 13 sampled fields match spike-decoded values' : '✗ FAIL — adapter diverged from spike'}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

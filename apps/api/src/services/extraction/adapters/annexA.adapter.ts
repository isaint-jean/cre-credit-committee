/**
 * 424B5 Annex A adapter — plumbing for the typed `AnnexAExtraction` slot on
 * ExtractionResult (engine v1.6).
 *
 * SCOPE — Stage 1 of the Annex A productionization batch (plumbing-only):
 *
 *   • Surfaces the EXISTING parse work into the typed extraction pipeline.
 *     No new parsing logic is introduced here. The two source-of-truth files
 *     this adapter wires are:
 *
 *       (a) apps/api/src/scripts/clean-corpus-spike-annexA.ts
 *           — hand-decoded values for ONE proven deal (WFRBS 2013-C11 / Loan
 *           #17, Minot Hotel Portfolio). 22 fields confirmed against the
 *           prospectus by manual inspection. This is the only path that
 *           produces typed numeric values today.
 *
 *       (b) apps/api/src/scripts/clean-corpus-annexA-parser.ts
 *           — generalized ANCHOR-COVERAGE detector across 6 backbone shelves.
 *           Confirms per-shelf that each of the 22 field-anchor variants
 *           matches the section header. Does NOT yet pull values from the
 *           located rows — that's the next-batch productionization (Stage 2
 *           of THIS recon's recommendation; not in scope here).
 *
 * CURRENT BEHAVIOR — `runAnnexAAdapter(args)` returns:
 *
 *   • For args.shelfKey === 'WFRBS_2013_C11' AND args.loanRef === 'loan-17':
 *     a fully-populated `AnnexAExtraction` with the 22 hand-decoded values
 *     from the spike. This is "what the spike produced" — the parity baseline.
 *
 *   • For ANY other (shelf, loan): null. Honest — no value-extraction generalizer
 *     exists yet for these. The anchor-coverage detector confirms the headers
 *     are present (necessary precondition for the generalizer); the adapter's
 *     own report records that finding so Stage 2 knows where it stands.
 *
 *   • If the underlying source HTML is not locally cached at the expected
 *     path (e.g. for the 5 non-proven shelves on a fresh machine): null +
 *     an 'source-missing' status in the adapter report.
 *
 * MODEL-A BOUNDARY (consumed by the Stage 2 judgment-wiring decision):
 *
 *   The `AnnexAExtraction` shape carries issuer-stated numbers (issuer's
 *   underwritten NOI, issuer's appraised value, issuer's DSCR/DY/LTV). These
 *   are the CROSS-REFERENCE LAYER, not the answer key. The boundary report
 *   (committed alongside this adapter) maps each Annex A field to its
 *   intended AdjustedInputs destination — issuerCfUwNoi / issuerStatedNoi*
 *   for the NOI flavors; loanTerms cross-check fields for the rate/term/
 *   amort; concludedValue cross-check for the appraised value. Nothing here
 *   routes to `AdjustedInputs.metrics.noi`. That boundary is enforced by
 *   the destination map; this adapter only produces the typed payload.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnnexAExtraction, ISODateTime } from '@cre/contracts';

/** Adapter input — the (shelf, loan) coordinate identifies which prospectus
 *  + which loan row to pull. The path resolver below maps shelfKey to the
 *  cached source HTML. Stage 2 will widen this once a generalized per-loan
 *  table walker exists. */
export interface AnnexAAdapterArgs {
  readonly shelfKey: AnnexAShelfKey;
  /** Loan rank within the Annex A stratification, e.g. 'loan-17' for the
   *  17th row. Today only 'loan-17' on WFRBS_2013_C11 is decoded. */
  readonly loanRef: string;
}

export type AnnexAShelfKey =
  | 'WFRBS_2013_C11'
  | 'CGCMT_2013_GCJ11'
  | 'MSBAM_2013'
  | 'JPMBB_2013_C12'
  | 'WFCM_2015_LC20'
  | 'CSMC_2016_NXSR';

/** Per-call diagnostic record. Always emitted; the slot may be null while the
 *  report still carries useful "why" information (source-missing vs anchor-only
 *  vs values-extracted). */
export interface AnnexAAdapterReport {
  readonly shelfKey: AnnexAShelfKey;
  readonly loanRef: string;
  readonly status:
    | 'values-extracted'        // 22 typed fields populated (proven path)
    | 'anchors-only'            // headers found but generalizer not built yet
    | 'source-missing'          // local HTML not present
    | 'anchors-not-found';      // Annex A section not located in the source
  /** When status === 'anchors-only' or 'values-extracted', the count of
   *  field-anchors detected as present (max 22). Useful for tracking how
   *  generalizable each shelf will be without going re-running the survey. */
  readonly anchorCoverage: number | null;
  /** Free-form rationale — particularly useful for source-missing /
   *  anchors-not-found cases so callers see why null came back. */
  readonly rationale: string;
}

/** Result type — slot value + diagnostic report. The diagnostic is INFORMATIONAL
 *  only; the slot value is what flows into ExtractionResult.annexA. */
export interface AnnexAAdapterResult {
  readonly extraction: AnnexAExtraction | null;
  readonly report: AnnexAAdapterReport;
}

const ADAPTER_VERSION = '1.6.0-spike-bridge';

/** Per-shelf local source HTML cache locations (mirrors the parser script
 *  at clean-corpus-annexA-parser.ts:46-53). Maintained as a constant so the
 *  adapter has a single source-of-truth for where the proven inputs live. */
const SHELF_SOURCE_PATHS: Readonly<Record<AnnexAShelfKey, string>> = {
  WFRBS_2013_C11:   '/tmp/wfrbs-2013-c11-424B5.htm',
  CGCMT_2013_GCJ11: '/tmp/cgcmt-2013-gcj11-424B5.htm',
  MSBAM_2013:        '/tmp/msbam-2013-424B5.htm',
  JPMBB_2013_C12:   '/tmp/jpmbb-2013-c12-424B5.htm',
  WFCM_2015_LC20:   '/tmp/wf-2015-lc20-424B5.htm',
  CSMC_2016_NXSR:   '/tmp/csmc-2016-nxsr-424B2.htm',
};

export function getAnnexAAdapterVersion(): string {
  return ADAPTER_VERSION;
}

export function runAnnexAAdapter(args: AnnexAAdapterArgs): AnnexAAdapterResult {
  const { shelfKey, loanRef } = args;
  const sourcePath = SHELF_SOURCE_PATHS[shelfKey];
  const sourceExists = fs.existsSync(sourcePath);

  // The single proven path — WFRBS 2013-C11 / Loan #17, hand-decoded from
  // clean-corpus-spike-annexA.ts. All other (shelfKey, loanRef) tuples return
  // null with an honest report.
  if (shelfKey === 'WFRBS_2013_C11' && loanRef === 'loan-17') {
    if (!sourceExists) {
      return {
        extraction: null,
        report: {
          shelfKey, loanRef, status: 'source-missing', anchorCoverage: null,
          rationale: `Cached prospectus HTML not found at ${sourcePath}. The hand-decoded values are still proven against the original prospectus; this adapter declines to surface them without the source present so the cache is the audit anchor.`,
        },
      };
    }
    return {
      extraction: WFRBS_2013_C11_LOAN_17_VALUES,
      report: {
        shelfKey, loanRef, status: 'values-extracted', anchorCoverage: 22,
        rationale: 'Hand-decoded values from clean-corpus-spike-annexA.ts:280-322 (parity baseline for the spike). The general per-loan table walker is Stage-2 work; this adapter currently only surfaces what the spike already proved.',
      },
    };
  }

  // Anchor coverage is non-zero on the other 5 shelves (per the parser script),
  // but no value-extraction generalizer exists yet. Honest "null + reason."
  if (!sourceExists) {
    return {
      extraction: null,
      report: {
        shelfKey, loanRef, status: 'source-missing', anchorCoverage: null,
        rationale: `Cached prospectus HTML not found at ${sourcePath}. Run the SEC EDGAR fetch (see clean-corpus-annexA-parser.ts header for the 424B5 URL pattern) into the expected /tmp path before re-attempting.`,
      },
    };
  }
  return {
    extraction: null,
    report: {
      shelfKey, loanRef, status: 'anchors-only', anchorCoverage: null,
      rationale: `Annex A anchors are confirmed present for ${shelfKey} (per the parser survey), but no per-loan value-extraction generalizer exists yet. Stage 2 of the recon batch productionizes the table-walker for arbitrary (shelf, loan) pairs.`,
    },
  };
}

/* ---- proven payload: WFRBS 2013-C11 / Loan #17 (Minot Hotel Portfolio) ----
 * Source: hand-decoded from the prospectus at /tmp/wfrbs-2013-c11-424B5.htm
 * by clean-corpus-spike-annexA.ts:280-322. Cross-referenced verbatim here so
 * the adapter is the single export point for the typed payload; the spike
 * remains the audit-trail document (with row offsets, surrounding context,
 * and the 10-D realized-loss cross-reference). */
const WFRBS_2013_C11_LOAN_17_VALUES: AnnexAExtraction = {
  // T2 — Pool weights row
  loanAmount: 15_000_000,
  // T3 — Rate + amortization row
  termYears: 5,            // 60-month original term ÷ 12
  amortMonths: 300,        // T4 — 25-yr amortization
  ioYears: 0,
  coupon: 0.04677,
  maturityDate: '2018-01-01T00:00:00Z' as ISODateTime,
  // T1 — Property metadata
  assetType: 'Hotel',
  subType: 'Limited Service + Full Service (mixed)',
  // T5 — TTM financials
  occupancyCurrent: 0.812,
  t12Noi: 2_823_742,
  t12Egi: 8_785_777,
  t12OpEx: 5_962_035,
  // T7 — 2011 actual NOI
  priorPeriodNoi: 1_763_001,
  // T6 — Underwritten financials (UW NOI)
  uwY1Noi: 3_330_324,
  // T4 — Metrics (issuer's UW NCF DSCR + UW NOI DY)
  uwDscr: 2.77,
  uwDebtYield: 0.189,
  // T4 — Appraised value, cut-off LTV
  concludedValue: 25_100_000,
  concludedLtv: 0.597,
  // T12 — Reserves at closing (hospitality: PIP reserve)
  pipOrCapexReserve: 2_557_500,
  tiLcReserve: null,       // hospitality — no TI/LC line
  // T9 — Lease info (hospitality: not applicable)
  largestTenant: null,
  leaseExpirationLargest: null,
};

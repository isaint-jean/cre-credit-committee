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
 * by clean-corpus-spike-annexA.ts:280-322. The DOLLAR VALUES were always
 * correct; only the two NOI field LABELS were inverted vs the prospectus's
 * stated identities.
 *
 * ★ CORRECTION 2026-06-13 — UW NOI vs TTM NOI label inversion fixed in
 * lockstep across the stack (this file, check-model-a-boundary.ts,
 * shelf-generalizer LOAN_17_BASELINE, the boundary-proof display, and the
 * AnnexAExtraction.uwDscr docstring). The spike's hand-decode wired:
 *   - $2,823,742 (prospectus's "UW Net Operating Income" column) → t12Noi
 *   - $3,330,324 (prospectus's "Most Recent NOI" column)          → uwY1Noi
 * Inverted. Verified by TWO independent prospectus-stated identities:
 *
 *   Identity #1 — stated UW NOI DY foots only against $2.82M:
 *     stated UW NOI DY = 18.90%; loan = $15.00M
 *     ⇒ UW NOI = 0.189 × $15.00M = $2,835,000  ≈ $2,823,742 ✓
 *
 *   Identity #2 — stated UW NOI DSCR foots only against $2.82M (independent):
 *     stated UW NOI DSCR = 2.77x; annual DS = $1,019,072 (4.677% / 25y / $15M)
 *     ⇒ UW NOI = 2.77 × $1,019,072 = $2,822,861  ≈ $2,823,742 ✓
 *
 * Both independent identities pin UW NOI = $2.82M. $3.33M sits in the
 * prospectus's "Most Recent NOI" column — that's the TTM NOI. The spike
 * was a transcription slip; the inversion is shelf-wide (the v8.1
 * shelf-generalizer flagged 21 prior-CLEAN loans whose DY-via-NOI deltas
 * traced to the same inversion). Stage 1 + Stage 2 contracts inherited the
 * spike convention; this correction realigns them to prospectus truth.
 * Model-A boundary holds in both conventions (the guard tests whether
 * annexA is read by spine code, not which value sits in which field); 5
 * engine hashes unchanged. */
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
  occupancyCurrent: 0.812,  // T5 (UW header) — UW occupancy %
  // ★ CORRECTED — full T5/T6 prospectus-column-truth alignment.
  // The three t12* fields all source from the "Most Recent NOI" table (TTM
  // data per the prospectus column header) so the intra-T5 foot identity
  // (t12Noi ≈ t12Egi − t12OpEx) holds. The three uwY1* fields source from
  // the "UW Net Operating Income" table (UW data). Spike convention had ALL
  // three swapped per row — the v8.1 brief originally enumerated only the
  // NOIs but the full TTM/UW alignment requires Revenue and Expenses too,
  // else the intra-T5 foot check fires shelf-wide.
  t12Noi: 3_330_324,        // T6 "Most Recent NOI" — TTM NOI
  t12Egi: 9_432_760,        // T6 "Most Recent Revenue" — TTM Revenue
  t12OpEx: 6_102_436,       // T6 "Most Recent Expenses" — TTM Expenses
  // T7 — 2011 actual NOI
  priorPeriodNoi: 1_763_001,
  // ★ CORRECTED: uwY1Noi = Issuer UW NOI (UW Net Operating Income column)
  uwY1Noi: 2_823_742,       // T5 (UW header) — UW NOI; foots stated UW NOI DY (18.90%) and stated UW NOI DSCR (2.77x)
  // T4 — Metrics (uwDscr is UW NOI DSCR — position 1 in T4 per prospectus header order)
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
  // Pari-passu — Loan #17 (Minot Hotel Portfolio) is a single-trust loan; no
  // footnote-#4 entry exists, so the combination is null.
  pariPassuCombination: null,
};

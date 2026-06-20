/**
 * Data-integrity gate — runs at the single ingest chokepoint
 * (evaluate-from-adjusted-inputs.ts, post-extraction-load, pre-verdict).
 *
 * Three layers:
 *   1. Provenance gate (warn-only)             — flags verdict-critical
 *      AdjustedInputs line items whose .source is in STUB_SUSPECT_SOURCES.
 *      NEVER halts; provenance is observational.
 *   2. Plausibility gate (two-tier bands)      — HARD halts on
 *      physically-impossible ratios; SOFT warns on out-of-normal-range
 *      ratios. Bands in config.ts.
 *   3. Cross-consistency (HARD on contradiction)
 *        ★ refinance && loanAmount < priorDebtPayoff  → HARD halt.
 *        debtServiceAnnual vs annualDebtService(terms) off >5% → flag.
 *        impliedValue (NOI/capRate) vs appraisedValue diverge >50% → flag.
 *
 * Returns a DataIntegrityReport. Callers (the ingest pipeline) decide
 * what to do with HARD halts (set analysis.status, attach diagnostic),
 * but the gate itself never throws or short-circuits — the report is
 * the contract.
 */

import type { AdjustedInputs, ExtractionResult, PropertyMetadata } from '@cre/contracts';
import { annualDebtService } from '../judgment/amortization.js';
import {
  PLAUSIBILITY_BANDS,
  LOAN_PSF_BANDS_BY_ASSET_TYPE,
  DEBT_SERVICE_FORMULA_TOLERANCE_PCT,
  IMPLIED_VS_APPRAISED_VALUE_TOLERANCE_PCT,
  STUB_SUSPECT_SOURCES,
  VERDICT_CRITICAL_LINE_ITEMS,
} from './config.js';

export type GateSeverity = 'HARD' | 'SOFT' | 'WARN';
export type GateLayer = 'provenance' | 'plausibility' | 'cross_consistency';

export interface GateFinding {
  readonly layer: GateLayer;
  readonly severity: GateSeverity;
  readonly check: string;        // short code for programmatic dispatch (e.g. 'LTV_HARD_LO')
  readonly title: string;        // human-readable label ('LTV below 2%')
  readonly message: string;      // legible diagnostic the user sees
  readonly values?: Record<string, number | string | null>;  // offending values for the diagnostic
}

export interface DataIntegrityReport {
  readonly findings: readonly GateFinding[];
  /** True iff any finding has severity 'HARD'. Callers gate the verdict on this. */
  readonly hardHalt: boolean;
  /** Quick top-line counts for routes / logs. */
  readonly hardCount: number;
  readonly softCount: number;
  readonly warnCount: number;
}

/* --------------------------- the gate runner -------------------------------- */

export interface RunGateArgs {
  readonly adjustedInputs: AdjustedInputs;
  readonly extraction: ExtractionResult;
  readonly propertyMetadata: PropertyMetadata | null;
  /** Net rentable area for the PSF check, when available (rent-roll-derived). */
  readonly netRentableArea: number | null;
}

export function runDataIntegrityGate(args: RunGateArgs): DataIntegrityReport {
  const findings: GateFinding[] = [];
  runProvenanceGate(args, findings);
  runPlausibilityGate(args, findings);
  runCrossConsistencyGate(args, findings);

  let hardCount = 0;
  let softCount = 0;
  let warnCount = 0;
  for (const f of findings) {
    if (f.severity === 'HARD') hardCount++;
    else if (f.severity === 'SOFT') softCount++;
    else warnCount++;
  }
  return {
    findings,
    hardHalt: hardCount > 0,
    hardCount,
    softCount,
    warnCount,
  };
}

/* --------------------------- provenance gate -------------------------------- */

function runProvenanceGate(
  args: RunGateArgs,
  out: GateFinding[],
): void {
  const ai = args.adjustedInputs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiAny = ai as any;
  for (const path of VERDICT_CRITICAL_LINE_ITEMS) {
    const [block, field] = path.split('.');
    const li = aiAny?.[block]?.[field];
    if (li === undefined || li === null) continue;
    if (typeof li !== 'object' || !('source' in li)) continue;
    const source = String(li.source ?? '');
    if (!STUB_SUSPECT_SOURCES.has(source)) continue;
    out.push({
      layer: 'provenance',
      severity: 'WARN',
      check: 'STUB_SUSPECT_SOURCE',
      title: `${path} is caller-supplied (source=${source})`,
      message:
        `${path} carries source tag '${source}', which means the value was ` +
        `caller-supplied (loan-terms ingest field, engine default, or borrower self-claim) ` +
        `rather than extracted from a source document. Verdict-critical fields ` +
        `should anchor to a document-extracted value where possible — verify ` +
        `against the underlying ASR / CF / appraisal / rent roll before relying ` +
        `on this number.`,
      values: {
        path,
        source,
        adjustedValue: nullableNumber(li.adjusted),
      },
    });
  }
}

/* -------------------------- plausibility gate ------------------------------- */

function runPlausibilityGate(
  args: RunGateArgs,
  out: GateFinding[],
): void {
  const m = args.adjustedInputs.metrics;
  const loan = args.adjustedInputs.loan;
  const ltv = nullableNumber(m.ltvAppraisal);
  const dscr = nullableNumber(m.dscr);
  const dy = nullableNumber(m.debtYield);
  const rate = nullableNumber(loan.interestRate.adjusted);
  const loanAmount = nullableNumber(loan.loanAmount.adjusted);

  bandCheck(out, 'plausibility', 'LTV', ltv, PLAUSIBILITY_BANDS.ltv, {
    hardMsg: (v) =>
      `LTV of ${(v * 100).toFixed(1)}% is outside the physically-plausible ` +
      `range (${(PLAUSIBILITY_BANDS.ltv.hardLo * 100).toFixed(0)}–` +
      `${(PLAUSIBILITY_BANDS.ltv.hardHi * 100).toFixed(0)}%). A value this far ` +
      `from normal indicates either a stub loan amount, a wrong appraised ` +
      `value, or extraction error — verify both the loan amount and the ` +
      `appraised value before any verdict.`,
    softMsg: (v) =>
      `LTV of ${(v * 100).toFixed(1)}% is outside the normal CMBS range ` +
      `(${(PLAUSIBILITY_BANDS.ltv.softLo! * 100).toFixed(0)}–` +
      `${(PLAUSIBILITY_BANDS.ltv.softHi! * 100).toFixed(0)}%). Worth a second ` +
      `look at the loan amount and the appraisal date / source.`,
  });

  bandCheck(out, 'plausibility', 'DSCR', dscr, PLAUSIBILITY_BANDS.dscr, {
    hardMsg: (v) =>
      `DSCR of ${v.toFixed(2)}x is outside the physically-plausible range ` +
      `(${PLAUSIBILITY_BANDS.dscr.hardLo}–${PLAUSIBILITY_BANDS.dscr.hardHi}x). ` +
      `A DSCR this extreme indicates either NOI ≈ $0 (data error), a stub ` +
      `loan amount, or a stub debt service — verify NOI, loan amount, and ` +
      `debt service before any verdict.`,
    softMsg: (v) =>
      `DSCR of ${v.toFixed(2)}x is outside the normal CMBS range ` +
      `(${PLAUSIBILITY_BANDS.dscr.softLo}–${PLAUSIBILITY_BANDS.dscr.softHi}x). ` +
      `Verify against the issuer's underwriting.`,
  });

  bandCheck(out, 'plausibility', 'DY', dy, PLAUSIBILITY_BANDS.debtYield, {
    hardMsg: (v) =>
      `Debt yield of ${(v * 100).toFixed(1)}% is outside the physically-` +
      `plausible range (${(PLAUSIBILITY_BANDS.debtYield.hardLo * 100).toFixed(0)}–` +
      `${(PLAUSIBILITY_BANDS.debtYield.hardHi * 100).toFixed(0)}%). NOI of $${formatMoney(m.noi)} ` +
      `against loan of $${formatMoney(loanAmount)} is implausible — likely a stub loan ` +
      `amount. Verify before any verdict.`,
    softMsg: (v) =>
      `Debt yield of ${(v * 100).toFixed(1)}% is outside the normal CMBS range ` +
      `(${(PLAUSIBILITY_BANDS.debtYield.softLo! * 100).toFixed(0)}–` +
      `${(PLAUSIBILITY_BANDS.debtYield.softHi! * 100).toFixed(0)}%). Check NOI ` +
      `reconciliation and loan amount.`,
  });

  bandCheck(out, 'plausibility', 'RATE', rate, PLAUSIBILITY_BANDS.interestRate, {
    hardMsg: (v) =>
      `Coupon of ${(v * 100).toFixed(2)}% is outside the plausible range ` +
      `(${(PLAUSIBILITY_BANDS.interestRate.hardLo * 100).toFixed(0)}–` +
      `${(PLAUSIBILITY_BANDS.interestRate.hardHi * 100).toFixed(0)}%) — likely a ` +
      `stub rate. Verify against the ASR loan-terms section.`,
    softMsg: () => '',
  });

  // Loan PSF (office only for now per config)
  const assetType = nullableString(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (args.adjustedInputs as any).assetType ??
      args.propertyMetadata?.propertySubtype ??
      null,
  );
  const psfBand = assetType && LOAN_PSF_BANDS_BY_ASSET_TYPE[assetType.split(' ')[0]!];
  if (psfBand && loanAmount !== null && args.netRentableArea !== null && args.netRentableArea > 0) {
    const psf = loanAmount / args.netRentableArea;
    if (psf < psfBand.hardLo || psf > psfBand.hardHi) {
      out.push({
        layer: 'plausibility',
        severity: 'HARD',
        check: 'LOAN_PSF_HARD',
        title: `Loan PSF $${psf.toFixed(0)} outside physically-plausible range`,
        message:
          `Loan PSF of $${psf.toFixed(0)} (loan $${formatMoney(loanAmount)} ` +
          `over ${args.netRentableArea.toLocaleString()} SF) is outside the ` +
          `physically-plausible range for this asset type ($${psfBand.hardLo}–` +
          `$${psfBand.hardHi}). Likely a stub loan amount or SF extraction error.`,
        values: { psf, loanAmount, netRentableArea: args.netRentableArea },
      });
    }
  }
}

function bandCheck(
  out: GateFinding[],
  layer: GateLayer,
  label: 'LTV' | 'DSCR' | 'DY' | 'RATE',
  value: number | null,
  band: { hardLo: number; hardHi: number; softLo?: number; softHi?: number },
  msgs: { hardMsg: (v: number) => string; softMsg: (v: number) => string },
): void {
  if (value === null || !Number.isFinite(value)) return;
  if (value < band.hardLo || value > band.hardHi) {
    out.push({
      layer,
      severity: 'HARD',
      check: `${label}_HARD`,
      title: `${label} outside physically-plausible range`,
      message: msgs.hardMsg(value),
      values: { value },
    });
    return;
  }
  if (band.softLo !== undefined && band.softHi !== undefined && (value < band.softLo || value > band.softHi)) {
    out.push({
      layer,
      severity: 'SOFT',
      check: `${label}_SOFT`,
      title: `${label} outside normal CMBS range`,
      message: msgs.softMsg(value),
      values: { value },
    });
  }
}

/* ------------------------- cross-consistency gate --------------------------- */

function runCrossConsistencyGate(
  args: RunGateArgs,
  out: GateFinding[],
): void {
  const loan = args.adjustedInputs.loan;
  const loanAmount = nullableNumber(loan.loanAmount.adjusted);

  // ★ THE LOAD-BEARING CHECK
  // refinance && loanAmount < priorDebtPayoff → HARD halt.
  const loanPurpose = args.propertyMetadata?.loanPurpose ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priorDebtPayoff = (args.extraction.asr as any)?.priorDebtPayoff ?? null;
  if (
    loanPurpose === 'Refinance' &&
    typeof priorDebtPayoff === 'number' &&
    Number.isFinite(priorDebtPayoff) &&
    priorDebtPayoff > 0 &&
    typeof loanAmount === 'number' &&
    Number.isFinite(loanAmount) &&
    loanAmount < priorDebtPayoff
  ) {
    out.push({
      layer: 'cross_consistency',
      severity: 'HARD',
      check: 'REFI_BELOW_PRIOR_PAYOFF',
      title: 'Loan amount less than prior debt being refinanced',
      message:
        `Loan $${formatMoney(loanAmount)} is less than the $${formatMoney(priorDebtPayoff)} ` +
        `being refinanced — a refinance cannot underfund the payoff. Verify the ` +
        `loan amount against the ASR loan-terms section (Original Principal ` +
        `Balance / Cut-Off Balance) before any verdict.`,
      values: { loanAmount, priorDebtPayoff },
    });
  }

  // FLAG — engine debt service vs formula.
  const interestRate = nullableNumber(loan.interestRate.adjusted);
  const amortizationMonths = nullableNumber(loan.amortizationMonths.adjusted);
  const engineDs = nullableNumber(loan.debtServiceAnnual.adjusted);
  if (
    loanAmount !== null && loanAmount > 0 &&
    interestRate !== null && interestRate >= 0 &&
    amortizationMonths !== null &&
    engineDs !== null && engineDs > 0
  ) {
    const formulaDs = annualDebtService({
      loanAmount,
      interestRate,
      amortizationMonths,
    });
    if (formulaDs > 0) {
      const drift = Math.abs(engineDs - formulaDs) / formulaDs;
      if (drift > DEBT_SERVICE_FORMULA_TOLERANCE_PCT) {
        out.push({
          layer: 'cross_consistency',
          severity: 'WARN',
          check: 'DEBT_SERVICE_FORMULA_DRIFT',
          title: 'Debt service drifts from formula',
          message:
            `Engine debt service $${formatMoney(engineDs)} drifts from the ` +
            `standard formula output $${formatMoney(formulaDs)} by ${(drift * 100).toFixed(1)}% ` +
            `— check that loan amount, interest rate, and amortization months are ` +
            `extracted consistently.`,
          values: { engineDs, formulaDs, driftPct: drift },
        });
      }
    }
  }

  // FLAG — implied value vs appraised value divergence.
  const noi = nullableNumber(args.adjustedInputs.metrics.noi);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capRate = nullableNumber((args.adjustedInputs as any).assumptions?.capRate?.adjusted);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appraisedValue = nullableNumber((args.extraction.appraisal as any)?.asIsValue);
  if (
    noi !== null && noi > 0 &&
    capRate !== null && capRate > 0 &&
    appraisedValue !== null && appraisedValue > 0
  ) {
    const implied = noi / capRate;
    const divergence = Math.abs(implied - appraisedValue) / appraisedValue;
    if (divergence > IMPLIED_VS_APPRAISED_VALUE_TOLERANCE_PCT) {
      out.push({
        layer: 'cross_consistency',
        severity: 'WARN',
        check: 'IMPLIED_VS_APPRAISED_VALUE_DIVERGENCE',
        title: 'Implied value diverges from appraised value',
        message:
          `Implied value (NOI $${formatMoney(noi)} / cap rate ${(capRate * 100).toFixed(2)}% = ` +
          `$${formatMoney(implied)}) diverges from the appraised value $${formatMoney(appraisedValue)} ` +
          `by ${(divergence * 100).toFixed(0)}%. Cross-check the NOI extraction, cap rate, and appraisal date.`,
        values: { implied, appraisedValue, divergencePct: divergence },
      });
    }
  }
}

/* --------------------------------- helpers ---------------------------------- */

function nullableNumber(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}
function nullableString(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v;
}
function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

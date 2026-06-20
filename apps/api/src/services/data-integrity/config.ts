/**
 * Data-integrity gate thresholds — single source of truth.
 *
 * Tunable without touching gate logic. Calibrated against the 267 historical
 * UWs in apps/api/.data/historical-uws.json:
 *   - HARD bands tuned to physically-impossible-only (LTV <2%/>200%,
 *     DSCR <0.1x/>50x, DY <2%/>150%, rate <1%/>20%). 1 of 267 deals trips
 *     the HARD bands ("The Grove" with NOI=$0 / DSCR=0 — a true-positive
 *     data-quality catch, NOT a false positive).
 *   - SOFT bands at normal-CMBS range. 72 of 267 deals carry at least one
 *     SOFT warn — reasonable analyst-attention surface.
 *
 * The phantom Sunroad ($11M / 7% / 30yr amort) trips:
 *   - Cross-consistency refi-vs-prior-payoff HARD halt   (load-bearing catch)
 *   - 3 SOFT warns on LTV/DSCR/DY (corroborating signals)
 * The corrected Sunroad ($85M / 7.16% / IO) trips 0 HARD, 0 SOFT.
 *
 * Bumping any threshold is a deliberate calibration call — re-run the
 * corpus dry-run before changing.
 */

export interface PlausibilityBand {
  readonly hardLo: number;
  readonly hardHi: number;
  readonly softLo?: number;
  readonly softHi?: number;
}

export const PLAUSIBILITY_BANDS: {
  readonly ltv: PlausibilityBand;
  readonly dscr: PlausibilityBand;
  readonly debtYield: PlausibilityBand;
  readonly interestRate: PlausibilityBand;
} = {
  ltv: {
    hardLo: 0.02,   // <2% LTV = stub or junk; physically-impossible-only
    hardHi: 2.00,   // >200% = loan exceeds asset value by 2× = stub or junk
    softLo: 0.25,   // <25% = unusual; flag for analyst attention
    softHi: 0.85,   // >85% = aggressive leverage; flag
  },
  dscr: {
    hardLo: 0.10,   // <0.10x = NOI nearly zero or debt service massively wrong
    hardHi: 50.0,   // >50x = stub loan-amount or NOI 50× the debt service
    softLo: 1.10,   // <1.10x = thin coverage; analyst should review
    softHi: 3.00,   // >3.0x = over-collateralized or low-leverage; flag
  },
  debtYield: {
    hardLo: 0.02,   // <2% DY = NOI < 2% of loan; near-impossible without stub
    hardHi: 1.50,   // >150% DY = NOI 1.5× loan in a year; stub loan
    softLo: 0.07,   // <7% = low yield; trophy or aggressive
    softHi: 0.20,   // >20% = unusually high yield; check
  },
  interestRate: {
    hardLo: 0.01,   // <1% coupon = stub
    hardHi: 0.20,   // >20% = stub or distressed-debt anomaly
  },
} as const;

/**
 * Office-asset loan-PSF bands (other asset types add their own constants
 * when the gate widens). Used by the cross-consistency layer to catch
 * obviously-wrong loan-amount values relative to building size.
 */
export const LOAN_PSF_BANDS_BY_ASSET_TYPE: {
  readonly [k: string]: PlausibilityBand;
} = {
  Office: { hardLo: 30, hardHi: 1500 },
  // Add other asset types as the gate extends.
} as const;

/**
 * Cross-consistency tolerance — how far engine debt service can drift
 * from the textbook formula before we flag.
 */
export const DEBT_SERVICE_FORMULA_TOLERANCE_PCT = 0.05;   // 5%

/**
 * Cross-consistency tolerance — how far implied value (NOI / capRate)
 * can diverge from appraised value before we flag.
 */
export const IMPLIED_VS_APPRAISED_VALUE_TOLERANCE_PCT = 0.50; // 50%

/**
 * Provenance source tags considered "stub-suspect" — caller-supplied,
 * manual, or otherwise not document-rooted. Verdict-critical fields tagged
 * with any of these surface a provenance WARN (never a halt — per Phase
 * design, provenance is observational; only plausibility + cross-
 * consistency can halt).
 */
export const STUB_SUSPECT_SOURCES: ReadonlySet<string> = new Set([
  'BANK',
  'MANUAL',
  'CALLER_SUPPLIED',
  'SELF_REPORTED',
  'missing-data-penalty',
]);

/**
 * Verdict-critical AdjustedInputs paths. A stub-suspect source tag on any
 * of these triggers a provenance warning. Restricted to load-bearing
 * fields — the 9 defensible MANUAL defaults from the provenance audit
 * (concessionsPct, effectiveGrossIncome rollup, expenses.other,
 * expenses.payroll, monthlyCapex / monthlyTiLc / upfrontTiLc,
 * rentGrowthPct, expenseGrowthPct, terminalCapRate) are deliberately
 * excluded — they're either small line items or doctrine-policy overrides
 * for which MANUAL is the expected source.
 */
export const VERDICT_CRITICAL_LINE_ITEMS: ReadonlySet<string> = new Set([
  // Loan block — every field is verdict-critical
  'loan.loanAmount',
  'loan.interestRate',
  'loan.amortizationMonths',
  'loan.ioPeriodMonths',
  'loan.termMonths',
  // Primary income
  'income.grossRentalIncome',
  // Primary expense lines (headline categories)
  'expenses.realEstateTaxes',
  'expenses.insurance',
  'expenses.utilities',
  'expenses.maintenance',
  'expenses.managementFee',
  'expenses.generalAndAdmin',
]);

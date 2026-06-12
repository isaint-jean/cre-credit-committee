/**
 * doctrine-clean / normalization / sustainable-cashflow.ts
 *
 * SUSTAINABLE-CASHFLOW NORMALIZATION (shared pre-step, NOT a scored dimension).
 *
 * SPEC v2 PROVENANCE (verbatim):
 *   "[Convergence spine] don't trust the issuer's underwritten number —
 *   re-derive a sustainable cash flow, apply a stressed cap rate to get
 *   a value below appraisal, and size leverage and coverage off that."
 *   - KBRA: KNCF (haircut cash flow) ÷ asset-specific KBRA cap rate → KBRA Value.
 *   - DBRS: stabilized NCF + stressed cap-rate ranges → DBRS Value.
 *   - Dim 1 Leverage: loan balance against a sustainable/haircut value.
 *   - Dim 2 Coverage: coverage on stressed/sustainable cash flow.
 *
 * PURPOSE:
 *   This module produces the SUSTAINABLE NCF that dim 7 (cap-rate /
 *   valuation stress) and the future dims 1 (Leverage) + 2 (Coverage)
 *   compute against. It is intentionally NOT one of the nine scored
 *   dimensions — divergence between issuer-projected NOI and the
 *   sustainable NCF surfaces DOWNSTREAM as lower ratios (Leverage,
 *   Coverage, Debt-Yield) on the sustainable basis. Keeping it as a
 *   normalization layer avoids double-counting the same risk in a
 *   dedicated "NOI-divergence dimension" and as a haircut to value.
 *
 * FENCE (LOAD-BEARING):
 *   We do NOT open old `manifesto_rules.json` / old doctrine cashflow /
 *   NOI-divergence / income-recovery code. Every haircut MAGNITUDE in
 *   this file traces to an agency convention (KBRA KNCF, DBRS
 *   stabilized NCF) or a published CMBS-underwriting convention. We do
 *   NOT fit haircuts to the 12-loss corpus — the corpus is used only
 *   as a coarse sanity check (sensible sustainable NCF, plausible
 *   haircut distribution).
 *
 * PROVENANCE — rewrite in own words:
 *
 *   The three NRSROs converge on the same skepticism: the issuer's
 *   underwritten NOI / NCF is the seller's projection. The agencies
 *   re-derive a SUSTAINABLE cash flow that strips out unproven upside
 *   and adds back the recurring capital the property actually needs
 *   to operate.
 *
 *   We implement the convergence through three haircuts that match the
 *   public agency conventions and use the inputs the corpus carries.
 *
 *   (A) NOI-DIVERGENCE HAIRCUT — "credit only what's proven."
 *       Both KBRA (KNCF construction) and DBRS (stabilized-NCF basis)
 *       compare the issuer's underwritten Y1 NOI to the trailing-12
 *       actual. If the issuer projected materially HIGHER than recent
 *       trailing, the agencies do not credit the unproven upside. We
 *       implement: when uwY1Noi > 1.05 × t12Noi, the sustainable NOI
 *       base is t12Noi (the trailing actual). Otherwise, the sustainable
 *       NOI base is uwY1Noi (issuer trustworthy at this divergence).
 *       The 5% threshold reflects KBRA's typical "material variance"
 *       cutoff in pre-sale reports (issuer projections within ±5% of
 *       trailing are routinely accepted; above 5% they are flagged and
 *       often re-derived).
 *
 *   (B) SUSTAINABLE VACANCY HAIRCUT (DBRS stabilized-NCF basis).
 *       DBRS publishes asset-class-specific stabilized vacancy floors
 *       (e.g., multifamily 7%, office 10%, retail 7-10%). If the
 *       issuer's underwritten occupancy is ABOVE the sustainable level
 *       (i.e., vacancy below the floor), DBRS haircuts credited income
 *       to the stabilized-vacancy level. The clean corpus does NOT
 *       currently expose occupancy — every record routes through this
 *       step with status 'occupancy-not-available'; the haircut stays
 *       zero today and the corpus annotation is preserved for future
 *       extractor work.
 *
 *   (C) NCF CAPITAL DEDUCTIONS (KBRA KNCF basis).
 *       KBRA KNCF = NOI minus ongoing TI/LC + capex + replacement
 *       reserves. Each asset class has a published convention for the
 *       NCF/NOI ratio when granular line items are not available; the
 *       ratio reflects the typical recurring capital burden of the
 *       class. We use these asset-class NCF/NOI ratios from KBRA /
 *       DBRS published norms when reserve line items are absent (which
 *       is the universal case on the current corpus). The ratios are
 *       conservative central estimates that all three agencies cluster
 *       near; they are NOT fit to the corpus.
 *
 *   PROPORTIONATE FIDELITY — INTENTIONAL:
 *       We do NOT attempt a full line-item KNCF reconstruction (EGI →
 *       vacancy → operating expenses → TI/LC by lease → replacement
 *       reserves by SF). That is not the goal at this stage; we are
 *       building a defensible sustainable-NCF that respects the agency
 *       convergence using available corpus inputs. As the extractor
 *       surfaces richer line items (EGI, per-PSF reserves, occupancy),
 *       this normalization layer becomes the natural place to deepen
 *       the haircut detail without changing the dim 7 / 1 / 2 contracts.
 *
 * INPUT STATES (three, per the dim-8/6/7 doctrine):
 *   POPULATED: assetType + uwY1Noi present → compute sustainable NCF.
 *              t12Noi optional — when present, divergence haircut applies.
 *   HITL:      assetType OR uwY1Noi null/missing → null output;
 *              routeStatus = 'hitl-needed'. NEVER substitute a
 *              conservative default at the normalization layer.
 *
 * NO IMPORTS FROM OLD DOCTRINE / NOI-DIVERGENCE / INCOME-RECOVERY MODULES.
 */

/**
 * Input shape — pure function, no I/O.
 */
export interface SustainableCashflowInput {
  /** Normalized asset class from the extractor. */
  readonly assetType: string | null;
  /** Optional sub-type (e.g., 'Retail Anchored') — used for the Mall path. */
  readonly subType: string | null;
  /** Issuer-underwritten Year-1 NOI in dollars. */
  readonly uwY1Noi: number | null;
  /** Trailing-12-month actual NOI in dollars. Optional. */
  readonly t12Noi: number | null;
  /**
   * Issuer's underwritten physical occupancy as decimal in [0, 1]
   * (e.g., 0.95 for 95%). When null, the vacancy haircut step records
   * 'occupancy-not-available' and applies zero adjustment. The clean
   * corpus does not currently expose this; the field is here so future
   * extractor work plugs in without changing the API.
   */
  readonly underwrittenOccupancy: number | null;
}

/**
 * NCF/NOI ratio by asset class. KBRA / DBRS published conventions for
 * recurring capital burden (TI/LC + capex + replacement reserves) when
 * granular line items are not available. These ratios are agency norms
 * — NOT fit to the clean corpus.
 *
 * The lower the ratio, the heavier the recurring capital deduction
 * (i.e., the class needs more capital reinvested vs NOI).
 *
 * Sources (range per class; we pick a conservative central estimate):
 *   Multifamily   0.94-0.96  (5% rep-reserve + minor capex) → 0.95
 *   MHC           0.95-0.97  (very light recurring capital) → 0.96
 *   Industrial    0.96-0.98  (light TI/LC, low capex)        → 0.97
 *   AnchoredRetail 0.93-0.95 (anchored TI/LC moderate)       → 0.94
 *   SelfStorage   0.96-0.98  (very low capex)                → 0.97
 *   MixedUse      0.93-0.95  (blended; conservative)         → 0.94
 *   UnanchoredRetail 0.91-0.93 (heavy TI/LC, vacancy churn)  → 0.92
 *   Office        0.88-0.93  (heavy TI/LC + capex; locked desk knob)→ 0.89
 *   Mall          0.91-0.94  (TI/LC + anchor risk)           → 0.93
 *   Hotel         0.95-0.97  (FF&E reserve only; no TI/LC)   → 0.96
 *   Unknown       conservative central                       → 0.94
 */
const NCF_NOI_RATIO: ReadonlyMap<string, { ratio: number; source: string }> = new Map([
  ['Multifamily',      { ratio: 0.95, source: 'KBRA/DBRS multifamily NCF/NOI norm — 5% replacement reserve + minor capex' }],
  ['MHC',              { ratio: 0.96, source: 'KBRA/DBRS MHC NCF/NOI norm — very light recurring capital' }],
  ['Industrial',       { ratio: 0.97, source: 'KBRA/DBRS industrial NCF/NOI norm — light TI/LC, low capex' }],
  ['AnchoredRetail',   { ratio: 0.94, source: 'KBRA/DBRS anchored-retail NCF/NOI norm — anchored TI/LC moderate' }],
  ['SelfStorage',      { ratio: 0.97, source: 'KBRA/DBRS self-storage NCF/NOI norm — very low capex' }],
  ['MixedUse',         { ratio: 0.94, source: 'KBRA/DBRS mixed-use NCF/NOI norm — blended conservative' }],
  ['UnanchoredRetail', { ratio: 0.92, source: 'KBRA/DBRS unanchored-retail NCF/NOI norm — heavy TI/LC + vacancy churn' }],
  ['Office',           { ratio: 0.89, source: 'OPERATOR-JUDGMENT (anchored to KBRA/DBRS office NCF/NOI range 0.88-0.93 — heavy TI/LC + capex; NOT employer-derived) — locked desk knob 0.89' }],
  ['Mall',             { ratio: 0.93, source: 'KBRA/DBRS regional-mall NCF/NOI norm — TI/LC + anchor risk' }],
  ['Hotel',            { ratio: 0.96, source: 'KBRA/DBRS hotel NCF/NOI norm — FF&E reserve only; no TI/LC' }],
  ['Unknown',          { ratio: 0.94, source: 'Unknown asset class fallback — conservative central estimate' }],
]);

/**
 * DBRS stabilized vacancy floor by asset class (decimal). When occupancy
 * is unavailable, the vacancy haircut step is skipped and the unused
 * floor is preserved here for future extractor wiring.
 *
 * Hotel uses RevPAR-based stress (no vacancy floor); MHC and SelfStorage
 * use month-to-month-occupancy norms that DBRS publishes separately.
 */
const DBRS_STABILIZED_VACANCY_FLOOR: ReadonlyMap<string, number | null> = new Map([
  ['Multifamily',       0.07],
  ['MHC',               0.07],
  ['Industrial',        0.06],
  ['AnchoredRetail',    0.07],
  ['SelfStorage',       0.13],
  ['MixedUse',          0.09],
  ['UnanchoredRetail',  0.09],
  ['Office',            0.10],
  ['Mall',              0.10],
  ['Hotel',             null],            // RevPAR basis, not vacancy
  ['Unknown',           0.10],
]);

/**
 * Threshold above which uwY1Noi is considered to "materially exceed"
 * t12Noi (KBRA pre-sale variance cutoff). Above this ratio, the
 * divergence haircut routes the sustainable NOI base to t12Noi.
 */
const NOI_DIVERGENCE_MATERIAL_RATIO = 1.05;

/**
 * Output shape — published for downstream dim 7 / future dims 1 / 2.
 *
 * `routeStatus`:
 *   'applicable' → all required inputs present; sustainable NCF computed
 *   'hitl-needed' → assetType or uwY1Noi missing; output nulls
 */
export interface SustainableCashflowOutput {
  readonly routeStatus: 'applicable' | 'hitl-needed';
  readonly sustainableNoi: number | null;
  readonly sustainableNcf: number | null;
  readonly issuerNoi: number | null;
  readonly haircutTrace: {
    readonly noiDivergence: NoiDivergenceTrace;
    readonly vacancy: VacancyHaircutTrace;
    readonly ncfCapital: NcfCapitalTrace;
  };
  readonly rationale: string;
  readonly provenance: readonly string[];
}

export interface NoiDivergenceTrace {
  readonly status: 'no-t12-input' | 'within-tolerance' | 'haircut-to-t12';
  readonly ratioUwToT12: number | null;
  readonly haircutApplied: number;          // sustainableNoi / uwY1Noi, in [0, 1]
  readonly note: string;
}

export interface VacancyHaircutTrace {
  readonly status:
    | 'occupancy-not-available'
    | 'asset-not-vacancy-based'
    | 'within-stabilized-floor'
    | 'haircut-to-stabilized-floor';
  readonly underwrittenOccupancy: number | null;
  readonly stabilizedFloorVacancy: number | null;
  readonly haircutApplied: number;          // multiplicative factor on income
  readonly note: string;
}

export interface NcfCapitalTrace {
  readonly status: 'applied' | 'no-asset-resolved';
  readonly assetClassResolved: string | null;
  readonly ncfNoiRatio: number | null;
  readonly note: string;
}

function resolveAssetClassForCashflow(
  assetType: string | null,
  subType: string | null,
): string {
  if (assetType === null) return 'Unknown';
  if (assetType === 'Retail' || assetType === 'AnchoredRetail' || assetType === 'UnanchoredRetail') {
    const st = (subType ?? '').toLowerCase();
    if (st.includes('mall') || st.includes('mills') || st.includes('outlet')) return 'Mall';
    if (assetType === 'Retail') return 'UnanchoredRetail';  // conservative default
  }
  return NCF_NOI_RATIO.has(assetType) ? assetType : 'Unknown';
}

export function normalizeSustainableCashflow(
  input: SustainableCashflowInput,
): SustainableCashflowOutput {
  // (1) HITL — required inputs absent.
  if (input.assetType === null || input.uwY1Noi === null) {
    const missing: string[] = [];
    if (input.assetType === null) missing.push('assetType');
    if (input.uwY1Noi === null) missing.push('uwY1Noi');
    return {
      routeStatus: 'hitl-needed',
      sustainableNoi: null,
      sustainableNcf: null,
      issuerNoi: input.uwY1Noi,
      haircutTrace: {
        noiDivergence: { status: 'no-t12-input', ratioUwToT12: null, haircutApplied: 1.0, note: 'HITL: required inputs absent' },
        vacancy:       { status: 'occupancy-not-available', underwrittenOccupancy: null, stabilizedFloorVacancy: null, haircutApplied: 1.0, note: 'HITL: required inputs absent' },
        ncfCapital:    { status: 'no-asset-resolved', assetClassResolved: null, ncfNoiRatio: null, note: 'HITL: required inputs absent' },
      },
      rationale: `[HITL — missing input(s): ${missing.join(', ')}] Sustainable-cashflow normalization requires assetType + uwY1Noi. Route to human review.`,
      provenance: ['input absent — no provenance trace possible'],
    };
  }

  // (2) Defensive sanity gate.
  if (input.uwY1Noi <= 0) {
    return {
      routeStatus: 'hitl-needed',
      sustainableNoi: null,
      sustainableNcf: null,
      issuerNoi: input.uwY1Noi,
      haircutTrace: {
        noiDivergence: { status: 'no-t12-input', ratioUwToT12: null, haircutApplied: 1.0, note: 'HITL: non-positive uwY1Noi' },
        vacancy:       { status: 'occupancy-not-available', underwrittenOccupancy: null, stabilizedFloorVacancy: null, haircutApplied: 1.0, note: 'HITL: non-positive uwY1Noi' },
        ncfCapital:    { status: 'no-asset-resolved', assetClassResolved: null, ncfNoiRatio: null, note: 'HITL: non-positive uwY1Noi' },
      },
      rationale: `[HITL — non-positive uwY1Noi=${input.uwY1Noi}] sanity gate failed. Route to human review.`,
      provenance: ['extractor sanity gate failure — upstream issue'],
    };
  }

  // (A) NOI-divergence haircut.
  let sustainableNoi = input.uwY1Noi;
  let divergence: NoiDivergenceTrace;
  if (input.t12Noi === null) {
    divergence = {
      status: 'no-t12-input',
      ratioUwToT12: null,
      haircutApplied: 1.0,
      note: 't12Noi not extracted — divergence haircut skipped. Future extractor work may surface t12Noi for more records.',
    };
  } else if (input.t12Noi <= 0) {
    // T-12 NOI non-positive (property in distress at U/W) — KBRA does NOT
    // credit a positive projection over a negative trailing; fall to t12.
    sustainableNoi = input.t12Noi;
    divergence = {
      status: 'haircut-to-t12',
      ratioUwToT12: null,
      haircutApplied: input.t12Noi / input.uwY1Noi,
      note: 'T-12 NOI non-positive — credited the trailing-actual basis (do not credit projected upside on distressed in-place).',
    };
  } else {
    const ratio = input.uwY1Noi / input.t12Noi;
    if (ratio > NOI_DIVERGENCE_MATERIAL_RATIO) {
      sustainableNoi = input.t12Noi;
      divergence = {
        status: 'haircut-to-t12',
        ratioUwToT12: ratio,
        haircutApplied: input.t12Noi / input.uwY1Noi,
        note: `Issuer projected uwY1Noi ${(ratio * 100 - 100).toFixed(1)}% above t12Noi — above the 5% material-variance cutoff. Credit only the trailing actual.`,
      };
    } else {
      divergence = {
        status: 'within-tolerance',
        ratioUwToT12: ratio,
        haircutApplied: 1.0,
        note: `Issuer projection within ±5% of trailing (ratio ${ratio.toFixed(3)}). No divergence haircut.`,
      };
    }
  }

  // (B) Sustainable vacancy haircut — corpus does not surface occupancy today.
  const resolvedAssetClass = resolveAssetClassForCashflow(input.assetType, input.subType);
  const stabilizedFloorVacancy = DBRS_STABILIZED_VACANCY_FLOOR.get(resolvedAssetClass) ?? null;
  let vacancy: VacancyHaircutTrace;
  if (stabilizedFloorVacancy === null) {
    vacancy = {
      status: 'asset-not-vacancy-based',
      underwrittenOccupancy: input.underwrittenOccupancy,
      stabilizedFloorVacancy: null,
      haircutApplied: 1.0,
      note: `${resolvedAssetClass}: vacancy not the DBRS stress lever (RevPAR-based or not applicable).`,
    };
  } else if (input.underwrittenOccupancy === null) {
    vacancy = {
      status: 'occupancy-not-available',
      underwrittenOccupancy: null,
      stabilizedFloorVacancy,
      haircutApplied: 1.0,
      note: `${resolvedAssetClass} stabilized-vacancy floor ${(stabilizedFloorVacancy * 100).toFixed(0)}% (DBRS); underwrittenOccupancy not in extractor output — haircut skipped.`,
    };
  } else {
    const uwVacancy = 1 - input.underwrittenOccupancy;
    if (uwVacancy >= stabilizedFloorVacancy) {
      vacancy = {
        status: 'within-stabilized-floor',
        underwrittenOccupancy: input.underwrittenOccupancy,
        stabilizedFloorVacancy,
        haircutApplied: 1.0,
        note: `UW vacancy ${(uwVacancy * 100).toFixed(1)}% at or above stabilized floor ${(stabilizedFloorVacancy * 100).toFixed(0)}% — no haircut.`,
      };
    } else {
      // UW vacancy is BELOW stabilized floor (UW occupancy above stabilized).
      // DBRS haircut: credit income at stabilized occupancy.
      const ratio = (1 - stabilizedFloorVacancy) / input.underwrittenOccupancy;
      sustainableNoi *= ratio;
      vacancy = {
        status: 'haircut-to-stabilized-floor',
        underwrittenOccupancy: input.underwrittenOccupancy,
        stabilizedFloorVacancy,
        haircutApplied: ratio,
        note: `UW occupancy ${(input.underwrittenOccupancy * 100).toFixed(1)}% above stabilized ${((1-stabilizedFloorVacancy)*100).toFixed(0)}%; haircut credited income to the DBRS stabilized floor.`,
      };
    }
  }

  // (C) NCF capital deduction (KBRA KNCF).
  const ncfNoiEntry = NCF_NOI_RATIO.get(resolvedAssetClass) ?? NCF_NOI_RATIO.get('Unknown')!;
  const sustainableNcf = sustainableNoi * ncfNoiEntry.ratio;
  const ncfCapital: NcfCapitalTrace = {
    status: 'applied',
    assetClassResolved: resolvedAssetClass,
    ncfNoiRatio: ncfNoiEntry.ratio,
    note: `${resolvedAssetClass} NCF/NOI ratio ${ncfNoiEntry.ratio.toFixed(3)} — ${ncfNoiEntry.source}`,
  };

  // Build rationale + provenance.
  const overallHaircut = sustainableNcf / input.uwY1Noi;
  const rationale =
    `Issuer Y1 NOI $${Math.round(input.uwY1Noi).toLocaleString()} → ` +
    `sustainable NOI $${Math.round(sustainableNoi).toLocaleString()} ` +
    `(divergence: ${divergence.status}; vacancy: ${vacancy.status}) → ` +
    `sustainable NCF $${Math.round(sustainableNcf).toLocaleString()} ` +
    `(NCF/NOI ${ncfNoiEntry.ratio.toFixed(3)} for ${resolvedAssetClass}). ` +
    `Overall sustainable-vs-issuer haircut: ${((1 - overallHaircut) * 100).toFixed(1)}%.`;

  return {
    routeStatus: 'applicable',
    sustainableNoi,
    sustainableNcf,
    issuerNoi: input.uwY1Noi,
    haircutTrace: { noiDivergence: divergence, vacancy, ncfCapital },
    rationale,
    provenance: [
      'spec v2 convergence spine — re-derive sustainable cash flow before sizing leverage / coverage',
      'KBRA — KNCF (haircut cash flow) construction, asset-class NCF/NOI conventions',
      'DBRS Morningstar — stabilized-NCF basis, asset-class stabilized vacancy floors',
      'KBRA pre-sale variance convention — material variance flagged at ~5% uwY1Noi-vs-T12 deviation',
      ncfCapital.note,
      divergence.note,
      vacancy.note,
      'PROPORTIONATE FIDELITY: defensible haircuts from agency conventions, not a full line-item KNCF reconstruction',
      'NUMBERS NOT FIT TO CORPUS: ratios + thresholds derived from agency norms; corpus is coarse sanity check only',
    ],
  };
}

export const SUSTAINABLE_CASHFLOW_CONVENTIONS = {
  ncfNoiRatios: NCF_NOI_RATIO,
  stabilizedVacancyFloors: DBRS_STABILIZED_VACANCY_FLOOR,
  noiDivergenceMaterialRatio: NOI_DIVERGENCE_MATERIAL_RATIO,
} as const;

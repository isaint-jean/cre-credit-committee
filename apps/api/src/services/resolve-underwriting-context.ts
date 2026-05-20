/**
 * Pre-render projection layer.
 *
 * Architectural rule (memory/architecture_render_four_axis.md):
 *   The schema layer is purely declarative. Schema selectors must be
 *   simple "read this field" projections — no null→sentinel coercion,
 *   no list-joining, no mode-based branching. All of that runtime
 *   resolution lives HERE.
 *
 * Inputs:
 *   - UnderwritingContext (raw producer output, may contain nulls / lists)
 *   - UnderwritingMode (from RenderInput; already validated by route)
 *
 * Output:
 *   - ResolvedUnderwritingContext, every cell populated with a real
 *     CellValue (string sentinel or actual content). Schema selectors
 *     read this verbatim.
 *
 * SCOPE GUARDRAIL (HARD INVARIANT, ENFORCED IN CODE):
 *   This resolver is a PURE TRANSFORMATION LAYER, not a mode-specific
 *   logic engine. The guardrail is enforced by THREE static / runtime
 *   checks, all of which run at module init or per-call:
 *
 *     1. **ALLOWED_OPS registry.** Every value the resolver assigns into
 *        the output goes through one of four named pure-shape functions:
 *        passthrough, sentinelDefault, joinList, rollUpFlatten. The op
 *        registry is `Object.freeze`'d. Adding a fifth op fails the
 *        boot-time op-set assertion.
 *
 *     2. **Per-call output-domain check.** After producing the resolved
 *        context, the resolver walks every narrative leaf and asserts
 *        each value is `string` (covers MissingDataSentinel + real
 *        content). A number/boolean in a narrative cell fails — that
 *        kind of value can only come from credit / scoring logic.
 *
 *     3. **Identity brand.** Every output instance is registered in a
 *        private WeakSet. The render service calls
 *        `assertResolvedByResolver()` before projection and rejects any
 *        object not produced by this module. Hand-rolled or imported
 *        objects fail at the schema boundary with RESOLVED_CONTEXT_NOT_BRANDED.
 *
 *   The resolver MUST NOT host underwriting rules, aggregation business
 *   logic, asset-class-specific behavior, or any conditional that
 *   encodes credit-policy semantics. The three checks above turn that
 *   rule into a runtime invariant.
 *
 *   Note (Batch 6.8 - architecture decision D3): a fourth check existed in
 *   prior revisions of this file - a runtime import-graph self-audit that
 *   read this module's own source via readFileSync and parsed every
 *   `import` line against allowed/forbidden patterns. It was retired in
 *   6.8 because the same coverage is now provided statically by the
 *   `lint:boundaries` policy (dependency-cruiser + ESLint
 *   no-restricted-imports), which has been load-bearing through Batch 6
 *   sub-batches 6.0 - 6.7. Static enforcement is the end state per D3;
 *   the runtime self-audit was a transitional guardrail.
 *
 *   Architecture remains: Schema → Resolver → Render.
 *   It must NEVER become: Schema → Resolver-with-business-logic → Render.
 */
import type {
  ConclusionAndEscrows,
  MissingDataSentinel,
  NarrativeValue,
  ResolvedCellValue,
  ResolvedUnderwritingContext,
  RollUpAggregation,
  UnderwritingContext,
  UnderwritingMode,
} from '@cre/shared';

// --- Hard error type --------------------------------------------------------
export class ResolverIntegrityError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ResolverIntegrityError';
    this.code = code;
    this.details = details;
  }
}

// --- Allowed pure-shape operations (CHECK #1) -------------------------------
// Every value the resolver assigns flows through one of these four ops. Any
// transformation outside this registry is a layering violation. Adding a new
// op requires updating the EXPECTED_OP_NAMES set below — the boot-time
// assertion will reject silent additions.

const DATA_NOT_PROVIDED: MissingDataSentinel = 'DATA_NOT_PROVIDED';

interface AllowedOps {
  /** Identity. Returns the input unchanged. Used when the value is already a CellValue. */
  passthrough<T extends ResolvedCellValue>(v: T): T;
  /** Null → DATA_NOT_PROVIDED sentinel. String / sentinel pass through. */
  sentinelDefault(v: NarrativeValue): ResolvedCellValue;
  /** Empty / null list → sentinel. Otherwise newline-joined. */
  joinList(items: NarrativeValue[] | null | undefined, sep?: string): ResolvedCellValue;
  /**
   * Like joinList but empty / null array becomes EMPTY STRING (not sentinel).
   * v7 comparablesLinkageRefs: spec says "empty array is valid; null becomes
   * empty array" — the cell renders blank when nothing was found, rather
   * than carrying the DATA_NOT_PROVIDED sentinel.
   */
  joinListAllowEmpty(items: string[] | null | undefined, sep?: string): ResolvedCellValue;
  /**
   * Mode-aware roll-up shape projection. SHAPE-ONLY: produces blank fields
   * in single_loan or when rollUpAggregation is null; otherwise emits the
   * fields verbatim with sentinel defaults applied. NO aggregation math,
   * NO weighting, NO normalization — this is a structure flattening op.
   */
  rollUpFlatten(
    r: RollUpAggregation | null | undefined,
    mode: UnderwritingMode,
  ): ResolvedUnderwritingContext['rollUpView'];
}

const ALLOWED_OPS: Readonly<AllowedOps> = Object.freeze({
  passthrough<T extends ResolvedCellValue>(v: T): T {
    return v;
  },
  sentinelDefault(v: NarrativeValue): ResolvedCellValue {
    return v ?? DATA_NOT_PROVIDED;
  },
  joinList(items: NarrativeValue[] | null | undefined, sep = '\n'): ResolvedCellValue {
    if (!items || items.length === 0) return DATA_NOT_PROVIDED;
    return items.map((x) => x ?? DATA_NOT_PROVIDED).join(sep);
  },
  joinListAllowEmpty(items: string[] | null | undefined, sep = ', '): ResolvedCellValue {
    if (!items || items.length === 0) return '';
    return items.join(sep);
  },
  rollUpFlatten(
    r: RollUpAggregation | null | undefined,
    mode: UnderwritingMode,
  ): ResolvedUnderwritingContext['rollUpView'] {
    const blank = {
      loanCount:                DATA_NOT_PROVIDED,
      aggregationMethodology:   DATA_NOT_PROVIDED,
      normalizationCommentary:  DATA_NOT_PROVIDED,
      constituentLoanIds:       DATA_NOT_PROVIDED,
    };
    if (mode !== 'roll_up') return blank;
    if (!r) return blank;
    return {
      loanCount:                r.loanCount,
      aggregationMethodology:   r.aggregationMethodology ?? DATA_NOT_PROVIDED,
      normalizationCommentary:  r.normalizationCommentary ?? DATA_NOT_PROVIDED,
      constituentLoanIds:       r.constituentLoanIds.length === 0
                                  ? DATA_NOT_PROVIDED
                                  : r.constituentLoanIds.join(','),
    };
  },
});

const EXPECTED_OP_NAMES = ['passthrough', 'sentinelDefault', 'joinList', 'joinListAllowEmpty', 'rollUpFlatten'];

(function assertAllowedOpsLocked(): void {
  const actual = Object.keys(ALLOWED_OPS).sort();
  const expected = EXPECTED_OP_NAMES.slice().sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw new ResolverIntegrityError(
      'RESOLVER_OPS_MISMATCH',
      `Resolver op registry diverged from EXPECTED_OP_NAMES. Adding/removing an op requires updating EXPECTED_OP_NAMES — this is the gate that prevents silent business-logic ops.`,
      { actual, expected },
    );
  }
  if (!Object.isFrozen(ALLOWED_OPS)) {
    throw new ResolverIntegrityError(
      'RESOLVER_OPS_NOT_FROZEN',
      `ALLOWED_OPS must be Object.freeze'd. Refusing to load resolver.`,
    );
  }
})();

// --- Import-graph guard (RETIRED in Batch 6.8) ----------------------------
// The runtime import-graph self-audit was retired in 6.8 per architecture
// decision D3. Coverage is now provided statically by `lint:boundaries`
// (dependency-cruiser + ESLint no-restricted-imports), which has been
// load-bearing through Batch 6 sub-batches 6.0 - 6.7. Same boundary,
// stronger enforcement (compile-time / pre-merge instead of module-init).

// --- Identity brand (CHECK #3) ---------------------------------------------
// Every output of resolveUnderwritingContext() is recorded here. The render
// service calls assertResolvedByResolver() before projection. Hand-rolled or
// imported "resolved" objects fail with RESOLVED_CONTEXT_NOT_BRANDED.

const RESOLVER_ISSUED = new WeakSet<ResolvedUnderwritingContext>();

export function assertResolvedByResolver(
  ctx: ResolvedUnderwritingContext,
): void {
  if (!ctx || typeof ctx !== 'object') {
    throw new ResolverIntegrityError(
      'RESOLVED_CONTEXT_NOT_BRANDED',
      `Render service received a non-object as ResolvedUnderwritingContext.`,
      { typeOfCtx: typeof ctx },
    );
  }
  if (!RESOLVER_ISSUED.has(ctx)) {
    throw new ResolverIntegrityError(
      'RESOLVED_CONTEXT_NOT_BRANDED',
      `Render service received a ResolvedUnderwritingContext that was not produced by resolveUnderwritingContext(). Hand-rolled or alternately-sourced resolved contexts are not permitted at the schema boundary.`,
    );
  }
}

// --- Output-domain check (CHECK #2) ----------------------------------------
// Narrative cells must contain a string (real text or a sentinel). Numbers
// or booleans in narrative slots indicate someone smuggled credit / scoring
// logic past the resolver.

const NARRATIVE_SECTION_KEYS: ReadonlyArray<keyof ResolvedUnderwritingContext> = Object.freeze([
  'propertyLoanSummary',
  'conclusionAndEscrows',
  'propertyDetail',
  'operatingProForma',
  'stressScenario',
  'thirdPartyReports',
  'borrower',
  'market',
  'siteInspection',
  'comparables',
]);

function assertNarrativeDomain(out: ResolvedUnderwritingContext): void {
  for (const sectionKey of NARRATIVE_SECTION_KEYS) {
    const section = out[sectionKey] as Record<string, ResolvedCellValue>;
    for (const [field, value] of Object.entries(section)) {
      if (typeof value !== 'string') {
        throw new ResolverIntegrityError(
          'RESOLVED_NARRATIVE_NOT_STRING',
          `Narrative cell ${String(sectionKey)}.${field} has non-string value (got ${typeof value}). Narrative cells must be strings (sentinel or real content). Numbers / booleans in narrative slots are forbidden — they indicate credit or scoring logic leaked into the resolver.`,
          { section: String(sectionKey), field, valueType: typeof value },
        );
      }
    }
  }
  // rollUpView.loanCount is the one numeric narrative-adjacent field. It is
  // string (sentinel) in single_loan and number in roll_up — both permitted.
  // Other roll-up fields are strings.
  const rv = out.rollUpView;
  for (const f of ['aggregationMethodology', 'normalizationCommentary', 'constituentLoanIds'] as const) {
    if (typeof rv[f] !== 'string') {
      throw new ResolverIntegrityError(
        'RESOLVED_ROLLUP_FIELD_NOT_STRING',
        `Roll-up cell rollUpView.${f} has non-string value (got ${typeof rv[f]}).`,
        { field: f, valueType: typeof rv[f] },
      );
    }
  }
  if (typeof rv.loanCount !== 'number' && typeof rv.loanCount !== 'string') {
    throw new ResolverIntegrityError(
      'RESOLVED_ROLLUP_FIELD_INVALID',
      `Roll-up cell rollUpView.loanCount must be number (in roll_up mode) or string sentinel (in single_loan mode). Got ${typeof rv.loanCount}.`,
      { valueType: typeof rv.loanCount },
    );
  }
}

// --- Resolver implementation -----------------------------------------------
// Every assignment goes through ALLOWED_OPS. No inline transformations, no
// branches that encode underwriting rules, no asset-class-specific code.

function resolveConclusion(
  c: ConclusionAndEscrows,
): ResolvedUnderwritingContext['conclusionAndEscrows'] {
  return {
    loanSummary:              ALLOWED_OPS.sentinelDefault(c.loanSummary),
    strengths:                ALLOWED_OPS.joinList(c.strengths),
    weaknesses:               ALLOWED_OPS.joinList(c.weaknesses),
    mitigants:                ALLOWED_OPS.joinList(c.mitigants),
    escrowSummary:            ALLOWED_OPS.sentinelDefault(c.escrowSummary),
    loanStructureCommentary:  ALLOWED_OPS.sentinelDefault(c.loanStructureCommentary),
  };
}

/**
 * Project a producer-emitted UnderwritingContext into the fully-resolved
 * shape the schema layer consumes. Pure function. Every output cell flows
 * through ALLOWED_OPS; the result is registered in the brand WeakSet and
 * verified against the narrative-domain invariant before return.
 */
export function resolveUnderwritingContext(
  ctx: UnderwritingContext,
  mode: UnderwritingMode,
): ResolvedUnderwritingContext {
  const out: ResolvedUnderwritingContext = {
    underwritingMode: ALLOWED_OPS.passthrough(mode) as UnderwritingMode,
    propertyLoanSummary: {
      propertyDescription:        ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.propertyDescription),
      loanTermsSummary:           ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.loanTermsSummary),
      sourcesAndUses:             ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.sourcesAndUses),
      ownershipSummary:           ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.ownershipSummary),
      equityAndCashFlowAnalysis:  ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.equityAndCashFlowAnalysis),
      historicalOwnership:        ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.historicalOwnership),
      annualCashFlowsCommentary:  ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.annualCashFlowsCommentary),
      generalAssetComments:       ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.generalAssetComments),
      tenancySummaryCommentary:   ALLOWED_OPS.sentinelDefault(ctx.propertyLoanSummary.tenancySummaryCommentary),
    },
    conclusionAndEscrows: resolveConclusion(ctx.conclusionAndEscrows),
    propertyDetail: {
      propertyInformation: ALLOWED_OPS.sentinelDefault(ctx.propertyDetail.propertyInformation),
      propertyRights:      ALLOWED_OPS.sentinelDefault(ctx.propertyDetail.propertyRights),
      management:          ALLOWED_OPS.sentinelDefault(ctx.propertyDetail.management),
      demographics:        ALLOWED_OPS.sentinelDefault(ctx.propertyDetail.demographics),
      comments:            ALLOWED_OPS.sentinelDefault(ctx.propertyDetail.comments),
    },
    operatingProForma: {
      historicalOperatingCommentary: ALLOWED_OPS.sentinelDefault(ctx.operatingProForma.historicalOperatingCommentary),
      year1ProFormaCommentary:       ALLOWED_OPS.sentinelDefault(ctx.operatingProForma.year1ProFormaCommentary),
      tenYearProFormaCommentary:     ALLOWED_OPS.sentinelDefault(ctx.operatingProForma.tenYearProFormaCommentary),
    },
    stressScenario: {
      stressMethodology:          ALLOWED_OPS.sentinelDefault(ctx.stressScenario.stressMethodology),
      revenueDownsideCommentary:  ALLOWED_OPS.sentinelDefault(ctx.stressScenario.revenueDownsideCommentary),
      expenseUpsideCommentary:    ALLOWED_OPS.sentinelDefault(ctx.stressScenario.expenseUpsideCommentary),
      noiAndDscrCommentary:       ALLOWED_OPS.sentinelDefault(ctx.stressScenario.noiAndDscrCommentary),
    },
    thirdPartyReports: {
      appraisalSummary:         ALLOWED_OPS.sentinelDefault(ctx.thirdPartyReports.appraisalSummary),
      environmentalSummary:     ALLOWED_OPS.sentinelDefault(ctx.thirdPartyReports.environmentalSummary),
      propertyConditionSummary: ALLOWED_OPS.sentinelDefault(ctx.thirdPartyReports.propertyConditionSummary),
    },
    borrower: {
      borrowerProfile:     ALLOWED_OPS.sentinelDefault(ctx.borrower.borrowerProfile),
      sponsorshipStrength: ALLOWED_OPS.sentinelDefault(ctx.borrower.sponsorshipStrength),
    },
    market: {
      marketOverview:   ALLOWED_OPS.sentinelDefault(ctx.market.marketOverview),
      submarketTrends:  ALLOWED_OPS.sentinelDefault(ctx.market.submarketTrends),
    },
    siteInspection: {
      inspectionNotes: ALLOWED_OPS.sentinelDefault(ctx.siteInspection.inspectionNotes),
      photos:          ALLOWED_OPS.sentinelDefault(ctx.siteInspection.photos),
      maps:            ALLOWED_OPS.sentinelDefault(ctx.siteInspection.maps),
    },
    comparables: {
      leaseComps: ALLOWED_OPS.sentinelDefault(ctx.comparables.leaseComps),
      salesComps: ALLOWED_OPS.sentinelDefault(ctx.comparables.salesComps),
      cmbsComps:  ALLOWED_OPS.sentinelDefault(ctx.comparables.cmbsComps),
    },
    rollUpView: ALLOWED_OPS.rollUpFlatten(ctx.rollUpAggregation, mode),

    // v7 atomic-block projections. Per spec: missing values render as
    // empty cells (null), NOT sentinel strings. The render-side red-flag
    // styling fires when the rendered value is null/empty, signaling
    // missing data without fabricating a value.
    property: {
      name:              ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.name              ?? null),
      street:            ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.street            ?? null),
      city:              ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.city              ?? null),
      state:             ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.state             ?? null),
      zip:               ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.zip               ?? null),
      county:            ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.county            ?? null),
      type:              ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.type              ?? null),
      yearBuilt:         ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.yearBuilt         ?? null),
      totalSquareFeet:   ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.totalSquareFeet   ?? null),
      units:             ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.units             ?? null),
      occupancy:         ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.occupancy         ?? null),
      ownershipInterest: ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.ownershipInterest ?? null),
    },
    loan: {
      termMonths:         ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.loan?.termMonths         ?? null),
      amortizationMonths: ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.loan?.amortizationMonths ?? null),
      ioMonths:           ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.loan?.ioMonths           ?? null),
    },
    parties: {
      borrowerName: ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.parties?.borrowerName ?? null),
      sponsorName:  ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.parties?.sponsorName  ?? null),
    },
    comparablesLinkageRefs: ALLOWED_OPS.joinListAllowEmpty(ctx.comparablesLinkageRefs ?? []),
  };

  // Check #3: narrative-domain invariant. Numbers/booleans in narrative
  // cells fail — they imply credit / scoring logic leaked into the resolver.
  assertNarrativeDomain(out);

  // Check #4: stamp the brand. The render service rejects any context not
  // present in this set.
  RESOLVER_ISSUED.add(out);

  return out;
}

/**
 * runLlmContextCheck — LLM_CONTEXT evaluator for handbook principles.
 *
 * Sibling to the deterministic evaluator (`packages/handbook-engine/src/evaluator.ts`
 * runDeterministicCheck). The pure engine stays free of LLM and store deps;
 * this lives in the API layer where those deps are accessible.
 *
 * Pipeline:
 *   1. Assemble per-principle context (curated subset of AdjustedInputs,
 *      StressOutputs, AssetProfile, PropertyMetadata, NarrativeFacts) +
 *      principle metadata + deterministicFiredFlags. Stable shape per
 *      Phase 0 spike — every input is upstream-deterministic, so the
 *      JCS-canonicalized SHA-256 is byte-stable across replays.
 *   2. Cache lookup keyed by (principleId, contextHash, engineVersion,
 *      modelVersion). On hit, return the stored result → preserves
 *      HE.id content-stability across replays.
 *   3. On miss, call the LLM with a canonical structured-output prompt.
 *      Retry once on malformed JSON. On repeated failure → typed skip
 *      reason 'llm_eval_failed'.
 *   4. Build a FiredFlag from the result (principleId + injectionPoints
 *      from metadata; severity + flag_message from the LLM; metricValue
 *      null because LLM principles have no numeric metric; groupIndex
 *      and bandIndex 0).
 *
 * Idempotency: a cached miss path also writes the result to the cache
 * on success, so the next replay (or a second narrative call with the
 * same context) hits cache and produces byte-identical output.
 */

import type {
  AdjustedInputs,
  AssetProfile,
  FiredFlag,
  ISODateTime,
  ManualInputRequest,
  ManualInputs,
  NarrativeFacts,
  PropertyMetadata,
  RentRoll,
  RentRollLine,
  SkipReason,
  StressOutputs,
} from '@cre/contracts';
import type { Principle } from '@cre/contracts';
import { canonicalize } from '../../util/canonical-json.js';
import { createHash } from 'node:crypto';
import { callAIWithContinuation } from '../ai-analysis.service.js';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';
import type { RefiWindowRolloverFacts } from '../judgment/refi-window.js';

export const LLM_CONTEXT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Match the handbook-engine PrincipleEvaluationResult shape so the API-layer
 * caller can fold these results into the existing engine output. We re-declare
 * a structurally-equivalent local type instead of importing the engine's
 * (which would create a circular dep) — fields are identical.
 */
export type LlmEvalResult =
  | { readonly status: 'fired'; readonly flag: FiredFlag }
  | {
      readonly status: 'skipped';
      readonly skip: {
        readonly principleId: string;
        // Outcomes:
        //   'llm_eval_failed'      — LLM call broke (malformed output / API error)
        //   'no_band_matched'      — LLM concluded fired=false (clean negative)
        //   'needs_manual_input'   — LLM triggered + healthy but cannot conclude
        //                            without an analyst-supplied input; carries
        //                            structured manualInputRequests
        readonly reason: SkipReason;
        readonly detail?: string;
        readonly manualInputRequests?: ReadonlyArray<ManualInputRequest>;
      };
    };

/**
 * Authoritative deal-level facts computed by the handbook evaluator BEFORE per-principle
 * dispatch. The LLM is instructed via SYSTEM_PROMPT to use these as ground truth and to
 * choose `needs_manual_input` rather than guessing from asset-class priors when the data
 * is genuinely absent.
 *
 * Spec-clean (§2.3): each computed-fact entry is derived from `AdjustedInputs` +
 * `RentRoll` (the graph nodes), NEVER from `ExtractionResult`. Stage 5 (handbook
 * evaluator) does not import extraction.
 *
 * Phase 1 added `refinancingRisk` (refi-window rollover gate).
 * Phase 2 widens with:
 *   - `reserveSchedule`: full 9-field capital-reserve picture so reserves-adjacent
 *     principles (P-III-3, P-III-4, P-IV-OFF-3) stop firing CRITICAL on
 *     monthlyReplacementReserves=$0 alone when other reserves are populated.
 *   - `terminationOptions`: structured extraction-gap marker. Today rent-roll footnotes
 *     are NOT parsed, so any principle requiring termination-option data must return
 *     needs_manual_input with kind='termination_option_extraction_gap' rather than
 *     silently missing the data.
 */
export interface ComputedFacts {
  readonly refinancingRisk: RefiWindowRolloverFacts;
  readonly reserveSchedule: ReserveScheduleFacts;
  readonly terminationOptions: TerminationOptionsFacts;
}

/**
 * Full reserve-schedule snapshot surfaced into the LLM context. Mirrors
 * AdjustedInputs.capitalReserves' fields (monthly + upfront + PCA-projected schedule)
 * with three derived roll-ups. Strict null fidelity: a field that is null (the UW
 * did not conclude this kind of reserve) stays null. Zeros stay zero. No defaulting.
 *
 * Source field: `AdjustedInputs.capitalReserves` (the canonical adjusted layer).
 * NOT derived from any asset-class stereotype.
 */
export interface ReserveScheduleFacts {
  readonly source: 'adjusted_inputs.capitalReserves';
  // Monthly figures (in dollars; null = not concluded by UW)
  readonly monthlyReplacementReserves: number | null;
  readonly monthlyCapex: number | null;
  readonly monthlyTiLc: number | null;
  readonly monthlyTenantImprovements: number | null;
  readonly monthlyLeasingCommissions: number | null;
  // Upfront figures
  readonly upfrontReplacementReserves: number | null;
  readonly upfrontTiLc: number | null;
  readonly pcaImmediateRepairs: number | null;
  // Per-year schedule (PCA-projected, inflated $). null when no PCA.
  readonly capexScheduleInflated: ReadonlyArray<{ readonly year: number; readonly amount: number }> | null;
  // Derived helpers — pure roll-ups so the LLM doesn't have to math.
  // totalMonthlyReservesDollars: sum of (monthlyReplacementReserves + monthlyCapex +
  // monthlyTiLc + monthlyTenantImprovements + monthlyLeasingCommissions) where non-null;
  // null only when ALL monthly fields are null. NOT zero on all-null — strict null fidelity.
  readonly totalMonthlyReservesDollars: number | null;
  // totalUpfrontReservesDollars: same policy across the three upfront fields.
  readonly totalUpfrontReservesDollars: number | null;
  // anyMonthlyReservePopulated: true iff at least one monthly field is non-null AND > 0.
  readonly anyMonthlyReservePopulated: boolean;
}

/**
 * Termination-options facts. In Phase 2 this is ALWAYS an extraction gap:
 * rent-roll footnote annotations (kickout clauses, early-termination rights) are
 * NOT extracted today. The structured `extractionGap` block exists so the LLM
 * can return needs_manual_input naming the exact gap rather than silently
 * concluding "there are no termination options."
 *
 * Forward-compatible: when footnote extraction lands in a future ticket,
 * `extracted` flips to true, `options` carries the parsed termination-options
 * list, and `extractionGap` becomes null.
 */
export interface TerminationOptionsFacts {
  readonly source: 'rent_roll_footnotes';
  /** Always false in Phase 2 (extraction gap). Future ticket: true when footnotes are parsed. */
  readonly extracted: boolean;
  /**
   * Per-tenant termination options (kickout clauses, early-termination rights).
   * Null in Phase 2 (extracted=false). Populated when extracted=true (future).
   */
  readonly options: ReadonlyArray<{
    readonly tenantName: string | null;
    readonly description: string;
    readonly effectiveDate: ISODateTime | null;
    readonly noticePeriodMonths: number | null;
  }> | null;
  /**
   * Structured extraction-gap marker. Populated in Phase 2 (extracted=false);
   * null when extracted=true. The LLM is instructed to cite `detail` verbatim
   * and return manualInputRequests with kind=recommendedInputKind.
   */
  readonly extractionGap: {
    readonly kind: 'termination_option_extraction_gap';
    readonly detail: string;
    readonly recommendedInputKind: 'termination_option_extraction_gap';
  } | null;
}

/**
 * Pure builder — projects AdjustedInputs.capitalReserves into ReserveScheduleFacts.
 * Reads only `adjustedInputs.capitalReserves`; no other inputs. Strict null fidelity
 * preserved across all derived roll-ups.
 *
 * Spec-clean (§2.3): imports AdjustedInputs only — never ExtractionResult.
 */
export function buildReserveScheduleFacts(adjustedInputs: AdjustedInputs): ReserveScheduleFacts {
  const r = adjustedInputs.capitalReserves;
  // AdjustedLineItem.adjusted is non-null in the contract; the "null = not concluded"
  // path here is for future-proofing if the field ever widens to nullable. Today every
  // adjusted is a number; the cast preserves the null-aware roll-up math regardless.
  const monthlies: ReadonlyArray<number | null> = [
    r.monthlyReplacementReserves.adjusted,
    r.monthlyCapex.adjusted,
    r.monthlyTiLc.adjusted,
    r.monthlyTenantImprovements.adjusted,
    r.monthlyLeasingCommissions.adjusted,
  ];
  const upfronts: ReadonlyArray<number | null> = [
    r.upfrontReplacementReserves.adjusted,
    r.upfrontTiLc.adjusted,
    r.pcaImmediateRepairs.adjusted,
  ];
  const sum = (xs: ReadonlyArray<number | null>): number | null => {
    const nonNull = xs.filter((x): x is number => x !== null);
    return nonNull.length === 0 ? null : nonNull.reduce((a, b) => a + b, 0);
  };
  return {
    source: 'adjusted_inputs.capitalReserves',
    monthlyReplacementReserves: r.monthlyReplacementReserves.adjusted,
    monthlyCapex: r.monthlyCapex.adjusted,
    monthlyTiLc: r.monthlyTiLc.adjusted,
    monthlyTenantImprovements: r.monthlyTenantImprovements.adjusted,
    monthlyLeasingCommissions: r.monthlyLeasingCommissions.adjusted,
    upfrontReplacementReserves: r.upfrontReplacementReserves.adjusted,
    upfrontTiLc: r.upfrontTiLc.adjusted,
    pcaImmediateRepairs: r.pcaImmediateRepairs.adjusted,
    capexScheduleInflated: r.capexScheduleInflated ?? null,
    totalMonthlyReservesDollars: sum(monthlies),
    totalUpfrontReservesDollars: sum(upfronts),
    anyMonthlyReservePopulated: monthlies.some((x) => x !== null && x > 0),
  };
}

/**
 * Pure builder — Phase 2 always returns the extraction-gap shape because rent-roll
 * footnotes are NOT extracted today. No inputs (the function exists so the call site
 * keeps a parallel shape to buildReserveScheduleFacts, and so the future ticket that
 * lands footnote extraction has one clear edit point).
 *
 * Spec-clean (§2.3): no extraction imports.
 */
export function buildTerminationOptionsFacts(): TerminationOptionsFacts {
  return {
    source: 'rent_roll_footnotes',
    extracted: false,
    options: null,
    extractionGap: {
      kind: 'termination_option_extraction_gap',
      detail:
        "Tenant lease termination options (kickout clauses, early-termination rights) live in rent-roll footnote annotations. Today the extraction pipeline does NOT parse footnotes — only the tabular rent-roll rows reach the graph. Principles requiring termination-option data MUST return needs_manual_input with kind='termination_option_extraction_gap' rather than silently missing the data.",
      recommendedInputKind: 'termination_option_extraction_gap',
    },
  };
}

export interface LlmContextCheckArgs {
  readonly principle: Principle;
  readonly adjustedInputs: AdjustedInputs;
  readonly stressOutputs: StressOutputs;
  readonly assetProfile: AssetProfile;
  readonly propertyMetadata: PropertyMetadata | null;
  readonly narrativeFacts: NarrativeFacts;
  readonly deterministicFiredFlags: ReadonlyArray<FiredFlag>;
  readonly handbookEngineVersion: string;
  /**
   * Authoritative deal-level facts computed by the handbook evaluator BEFORE
   * per-principle dispatch. The LLM is instructed via SYSTEM_PROMPT to use
   * these as ground truth and to choose needs_manual_input rather than
   * guessing from priors when the data is absent. Spec-clean (§2.3): computed
   * from AdjustedInputs + RentRoll, never from ExtractionResult.
   *
   * Folded into computeContextHash so a different refi-window (or different
   * per-tenant schedule) produces a different cache key and a fresh eval.
   * Same canonicalization-as-null policy as `manualInputs` and `rentRoll`:
   * absent → null in the hash input → byte-stable across runs that both omit.
   */
  readonly computedFacts?: ComputedFacts;
  /**
   * Optional analyst-supplied inputs (the manual-input layer — comps,
   * sponsor research, submarket vacancy rates, etc.). When present,
   * surfaced into the LLM prompt and folded into the context hash so a
   * different comp set produces a different hash and a fresh eval.
   * When absent, principles that require this kind of input return
   * needs_manual_input.
   */
  readonly manualInputs?: ManualInputs;
  /**
   * Phase 2 (rent-roll-node): curated per-tenant rent-roll surfaced into the
   * prompt + folded into the context hash. Source: HydratedRecordGraph.rentRoll,
   * threaded through buildHandbookEvaluation. When absent, no per-tenant block
   * appears in the prompt and the hash field is null (string-canonicalized) —
   * byte-stable across runs that both omit. Different rent roll → different
   * curated bytes → different hash → fresh eval (cache invalidates correctly).
   *
   * Spec-clean (§2.3) — this file imports RentRoll-the-graph-node, NEVER
   * ExtractionResult. The handbook evaluator reads typed RentRoll directly;
   * the lossy ExtractionResult.rentRoll projection is not consulted here.
   */
  readonly rentRoll?: RentRoll;
}

export interface LlmContextCheckDeps {
  readonly llmCall?: typeof callAIWithContinuation;
  readonly modelVersion?: string;
  /** Analyst-supplied manual inputs (the manual-input layer). Folded
   *  into the per-principle context bundle by buildHandbookEvaluation's
   *  llmEvaluator closure. */
  readonly manualInputs?: ManualInputs;
}

export async function runLlmContextCheck(
  args: LlmContextCheckArgs,
  store: RecordGraphStore,
  deps: LlmContextCheckDeps = {},
): Promise<LlmEvalResult> {
  const llm = deps.llmCall ?? callAIWithContinuation;
  const modelVersion = deps.modelVersion ?? LLM_CONTEXT_MODEL;
  const contextHash = computeContextHash(args);

  // --- Cache hit path ------------------------------------------------------
  const cached = store.getLlmPrincipleEval({
    principleId: args.principle.id,
    contextHash,
    handbookEngineVersion: args.handbookEngineVersion,
    modelVersion,
  });
  if (cached !== null) {
    const parsed = tryParseLlmOutput(cached);
    if (parsed !== null) {
      return resultFromLlmOutput(args.principle, parsed);
    }
    // Cache row exists but is corrupt — fall through to a fresh LLM call.
  }

  // --- Miss path: LLM call with retry on malformed output ------------------
  const prompt = buildPrompt(args);
  let llmRaw: string;
  let parsed = null as LlmStructuredOutput | null;
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      llmRaw = await llm({
        model: modelVersion,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      parsed = tryParseLlmOutput(llmRaw);
      if (parsed !== null) break;
      lastError = `attempt ${attempt + 1} returned non-JSON or schema-invalid output`;
    } catch (e) {
      lastError = `attempt ${attempt + 1} threw: ${(e as Error).message}`;
    }
  }

  if (parsed === null) {
    return {
      status: 'skipped',
      skip: { principleId: args.principle.id, reason: 'llm_eval_failed', detail: lastError },
    };
  }

  // Write to cache for replay determinism. ON CONFLICT DO NOTHING so a
  // concurrent writer doesn't error here.
  store.insertLlmPrincipleEval({
    principleId: args.principle.id,
    contextHash,
    handbookEngineVersion: args.handbookEngineVersion,
    modelVersion,
    resultPayload: canonicalize(parsed),
  });

  return resultFromLlmOutput(args.principle, parsed);
}

// --- Structured output schema + parser --------------------------------------

/**
 * Three outcome paths in the LLM's structured output:
 *   1. fired=true    → fires; severity + flag_message + evidenceQuotes required
 *   2. fired=false   → clean negative (no_band_matched)
 *   3. outcome='needs_manual_input' → triggered, cannot conclude without an
 *      analyst-supplied input; flag_message describes the gap (also surfaces
 *      to the analyst), manualInputRequests carries structured request entries.
 *      `fired` may be omitted on this path; severity defaults to the
 *      principle's own severity (set by resultFromLlmOutput).
 */
interface LlmStructuredOutput {
  readonly outcome: 'fired' | 'not_fired' | 'needs_manual_input';
  readonly severity?: 'critical' | 'high' | 'medium' | 'advisory';
  readonly flag_message: string;
  readonly evidenceQuotes?: ReadonlyArray<string>;
  readonly manualInputRequests?: ReadonlyArray<ManualInputRequest>;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'advisory']);
const VALID_OUTCOMES = new Set(['fired', 'not_fired', 'needs_manual_input']);

function tryParseLlmOutput(raw: string): LlmStructuredOutput | null {
  // Tolerate ```json fences, surrounding prose, or trailing junk by extracting
  // the first top-level JSON object.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = raw.slice(start, end + 1);

  let parsed: unknown;
  try { parsed = JSON.parse(slice); }
  catch { return null; }

  if (parsed === null || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;

  // Back-compat: legacy `fired: boolean` shape maps to outcome 'fired' or 'not_fired'.
  let outcome: LlmStructuredOutput['outcome'];
  if (typeof o.outcome === 'string' && VALID_OUTCOMES.has(o.outcome)) {
    outcome = o.outcome as LlmStructuredOutput['outcome'];
  } else if (typeof o.fired === 'boolean') {
    outcome = o.fired ? 'fired' : 'not_fired';
  } else {
    return null;
  }

  if (typeof o.flag_message !== 'string') return null;

  let severity: LlmStructuredOutput['severity'] | undefined;
  if (typeof o.severity === 'string' && VALID_SEVERITIES.has(o.severity)) {
    severity = o.severity as LlmStructuredOutput['severity'];
  } else if (outcome === 'fired') {
    return null; // severity required for fired outcomes
  }

  const evidenceQuotes = Array.isArray(o.evidenceQuotes)
    ? (o.evidenceQuotes.every((q) => typeof q === 'string') ? o.evidenceQuotes as string[] : null)
    : [];
  if (evidenceQuotes === null) return null;

  let manualInputRequests: ManualInputRequest[] | undefined;
  if (outcome === 'needs_manual_input') {
    if (!Array.isArray(o.manualInputRequests) || o.manualInputRequests.length === 0) return null;
    const reqs: ManualInputRequest[] = [];
    for (const r of o.manualInputRequests) {
      if (r === null || typeof r !== 'object') return null;
      const ro = r as Record<string, unknown>;
      if (typeof ro.kind !== 'string' || typeof ro.detail !== 'string') return null;
      reqs.push({ kind: ro.kind, detail: ro.detail });
    }
    manualInputRequests = reqs;
  }

  return {
    outcome,
    ...(severity !== undefined ? { severity } : {}),
    flag_message: o.flag_message,
    evidenceQuotes,
    ...(manualInputRequests !== undefined ? { manualInputRequests } : {}),
  };
}

function resultFromLlmOutput(principle: Principle, parsed: LlmStructuredOutput): LlmEvalResult {
  if (parsed.outcome === 'needs_manual_input') {
    return {
      status: 'skipped',
      skip: {
        principleId: principle.id,
        reason: 'needs_manual_input',
        detail: parsed.flag_message,
        manualInputRequests: parsed.manualInputRequests,
      },
    };
  }

  if (parsed.outcome === 'not_fired') {
    // Clean "principle evaluated, no flag warranted" — mirrors deterministic
    // engine's no_band_matched semantic.
    return {
      status: 'skipped',
      skip: { principleId: principle.id, reason: 'no_band_matched' },
    };
  }

  // outcome === 'fired' — severity guaranteed present by parser.
  return {
    status: 'fired',
    flag: {
      principleId: principle.id,
      severity: parsed.severity!,
      flag_message: parsed.flag_message,
      metricValue: null,           // LLM principles have no numeric metric
      groupIndex: 0,                // deterministic-only concept; placeholder
      bandIndex: 0,                 // deterministic-only concept; placeholder
      injectionPoints: principle.injectionPoints,
    },
  };
}

// --- Rent-roll curation (Phase 2 — rent-roll-node) --------------------------
//
// Pure, deterministic projection of a typed RentRoll into a top-N + "other"
// aggregate shape suitable for the per-principle LLM context bundle. Bound to
// top-10 by in-place income so a 200-tenant roll doesn't balloon the prompt.
// The same curation drives BOTH the prompt's per-tenant block AND the context
// hash — identical roll → identical curated bytes → identical hash → cache hit.
//
// Discipline: no I/O, no Date, no Math.random, no asset-class branching, no
// nullish coalescing on numeric fields. Null fidelity preserved: a tenant with
// null squareFeet has null inPlaceRentPsf (no synthesis, no zeros). A tenant
// with null inPlaceRentAnnual sorts to the end (still surfaced in "other"
// aggregate when applicable).

const RENT_ROLL_TOP_N = 10;

interface CuratedTenantLine {
  readonly tenantName: string | null;
  readonly suite: string | null;
  readonly squareFeet: number | null;
  readonly inPlaceRentAnnual: number | null;
  readonly inPlaceRentPsf: number | null;   // derived: annual / SF, null when either is null
  readonly marketRentAnnual: number | null;
  readonly leaseType: string;
  readonly leaseEnd: string | null;
  readonly occupied: boolean;               // true iff status === 'OCCUPIED'
}

interface CuratedRentRollOtherAggregate {
  readonly tenantCount: number;
  readonly squareFeetTotal: number | null;        // sum of non-null SF; null only if EVERY remaining tenant has SF null
  readonly inPlaceRentAnnualTotal: number | null; // same null-policy
}

interface CuratedRentRoll {
  readonly asOfDate: string | null;
  readonly propertyName: string | null;
  readonly source: string;
  readonly totalTenantCount: number;
  readonly topTenants: ReadonlyArray<CuratedTenantLine>;
  readonly otherAggregate: CuratedRentRollOtherAggregate | null; // null when totalTenantCount <= TOP_N
}

function curateTenantLine(line: RentRollLine): CuratedTenantLine {
  // Derive inPlaceRentPsf strictly: both operands non-null → divide; else null.
  // No defaulting, no Math.max/min, no rounding (raw division — LLM sees full precision).
  const sf = line.squareFeet;
  const rent = line.inPlaceRentAnnual;
  const psf = sf !== null && rent !== null && sf !== 0 ? rent / sf : null;
  return {
    tenantName: line.tenantName,
    suite: line.suite,
    squareFeet: sf,
    inPlaceRentAnnual: rent,
    inPlaceRentPsf: psf,
    marketRentAnnual: line.marketRentAnnual,
    leaseType: line.leaseType,
    leaseEnd: line.leaseEnd,
    occupied: line.status === 'OCCUPIED',
  };
}

function curateRentRoll(rentRoll: RentRoll): CuratedRentRoll {
  // Stable sort by in-place income descending. Null incomes sort to the end
  // (still aggregated under "other" when they spill past TOP_N). Tie-break on
  // index so the sort is deterministic across V8 versions (Array.prototype.sort
  // is stable in modern Node, but we want the contract explicit).
  const indexed = rentRoll.lines.map((line, idx) => ({ line, idx }));
  indexed.sort((a, b) => {
    const ar = a.line.inPlaceRentAnnual;
    const br = b.line.inPlaceRentAnnual;
    if (ar === null && br === null) return a.idx - b.idx;
    if (ar === null) return 1;
    if (br === null) return -1;
    if (ar !== br) return br - ar;
    return a.idx - b.idx;
  });

  const total = indexed.length;
  const top = indexed.slice(0, RENT_ROLL_TOP_N).map((e) => curateTenantLine(e.line));
  const remaining = indexed.slice(RENT_ROLL_TOP_N).map((e) => e.line);

  let otherAggregate: CuratedRentRollOtherAggregate | null = null;
  if (remaining.length > 0) {
    let sfSum = 0;
    let sfSeen = false;
    let rentSum = 0;
    let rentSeen = false;
    for (const line of remaining) {
      if (line.squareFeet !== null) {
        sfSum += line.squareFeet;
        sfSeen = true;
      }
      if (line.inPlaceRentAnnual !== null) {
        rentSum += line.inPlaceRentAnnual;
        rentSeen = true;
      }
    }
    otherAggregate = {
      tenantCount: remaining.length,
      squareFeetTotal: sfSeen ? sfSum : null,
      inPlaceRentAnnualTotal: rentSeen ? rentSum : null,
    };
  }

  return {
    asOfDate: rentRoll.asOfDate,
    propertyName: rentRoll.propertyName,
    source: rentRoll.source,
    totalTenantCount: total,
    topTenants: top,
    otherAggregate,
  };
}

// --- Context-hash assembly --------------------------------------------------
//
// Mirrors the Phase 0 spike's curation exactly. Any change to this function
// invalidates every cached LLM eval — bump HANDBOOK_ENGINE_VERSION when changing.

function computeContextHash(args: LlmContextCheckArgs): string {
  // manualInputs canonicalized as `null` when absent — preserves hash
  // stability across runs that both omit comps. Different comp sets
  // produce different bytes → different hash → fresh eval (correct
  // per Phase 0 caching strategy). Same policy applies to rentRoll
  // (Phase 2): absent → null; present → curated top-N + other aggregate
  // → byte-stable for identical rolls, byte-different for changed rolls.
  const ctx = {
    principle: {
      id: args.principle.id,
      title: args.principle.title,
      principleText: args.principle.principleText,
      severity: args.principle.severity,
      injectionPoints: [...args.principle.injectionPoints].sort(),
    },
    deal: {
      assetType: args.assetProfile.propertyType,
      adjustedInputs: curateAdjustedInputs(args.adjustedInputs),
      stressOutputs: curateStressOutputs(args.stressOutputs),
      assetProfile: args.assetProfile,
      propertyMetadata: args.propertyMetadata,
      narrativeFacts: curateNarrativeFacts(args.narrativeFacts),
    },
    manualInputs: args.manualInputs ?? null,
    rentRoll: args.rentRoll !== undefined ? curateRentRoll(args.rentRoll) : null,
    // Phase 1 (refi-window gate): computedFacts canonicalized as null when absent,
    // verbatim when present. The refi-window verdict + per-tenant schedule + chosen
    // refiWindowMonths flow through the hash so a changed buffer → different hash →
    // fresh eval (correct: a different refi window is a different question).
    computedFacts: args.computedFacts ?? null,
    handbookEngineVersion: args.handbookEngineVersion,
    modelVersion: LLM_CONTEXT_MODEL,
    deterministicFiredFlags: args.deterministicFiredFlags,
  };
  return createHash('sha256').update(canonicalize(ctx), 'utf8').digest('hex');
}

function curateAdjustedInputs(ai: AdjustedInputs) {
  return {
    income: {
      grossRentalIncome: ai.income.grossRentalIncome,
      vacancyPct: ai.income.vacancyPct,
      concessionsPct: ai.income.concessionsPct,
      otherIncome: ai.income.otherIncome,
      effectiveGrossIncome: ai.income.effectiveGrossIncome,
    },
    expenses: { totalOperatingExpenses: ai.expenses.totalOperatingExpenses },
    capitalReserves: { monthlyReplacementReserves: ai.capitalReserves.monthlyReplacementReserves },
    loan: ai.loan,
    assumptions: ai.assumptions,
    metrics: ai.metrics,
    confidenceReduction: ai.confidenceReduction,
    topLevelAdjustments: ai.topLevelAdjustments,
    dataQualityFlags: ai.dataQualityFlags,
  };
}

function curateStressOutputs(so: StressOutputs) {
  return {
    method: so.method,
    scenarios: so.scenarios.map((s) => ({
      name: s.name, noi: s.noi, dscr: s.dscr, value: s.value,
      ltv: s.ltv, debtYield: s.debtYield, breaches: s.breaches, skipped: s.skipped,
    })),
    stressEngineVersion: so.stressEngineVersion,
  };
}

function curateNarrativeFacts(nf: NarrativeFacts) {
  const { id, ...body } = nf as NarrativeFacts & { id: string };
  void id;
  return body;
}

// --- Prompt -----------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a B-piece commercial real estate credit analyst evaluating a single underwriting principle from the Eightfold credit handbook against a specific deal.',
  '',
  'Your task: decide whether the principle warrants a fired flag for this deal, given the deal data provided.',
  '',
  'OUTPUT FORMAT (strict): return a SINGLE JSON object, no surrounding prose, no markdown fences. The schema has THREE possible shapes by the `outcome` field:',
  '',
  '  // (1) Fire — the principle\'s concern is genuinely present in this deal',
  '  {',
  '    "outcome": "fired",',
  '    "severity": "critical" | "high" | "medium" | "advisory",',
  '    "flag_message": "<one-sentence analyst-readable description of the concern, citing specific numbers from the deal>",',
  '    "evidenceQuotes": [<short evidence strings from the deal data; cite specific numeric fields and their values>]',
  '  }',
  '',
  '  // (2) Not fired — principle evaluated cleanly, no flag warranted',
  '  {',
  '    "outcome": "not_fired",',
  '    "flag_message": "<brief note on why the principle is satisfied>",',
  '    "evidenceQuotes": []',
  '  }',
  '',
  '  // (3) Needs manual input — principle TRIGGERED and is otherwise healthy,',
  '  //     but cannot conclude without an analyst-supplied input you have',
  '  //     correctly declined to fabricate (e.g., per-tenant market rent comps,',
  '  //     submarket sales comps, sponsor litigation lookups).',
  '  //     Use this when the principle\'s text explicitly says the input',
  '  //     comes from manual analyst data and that input is absent.',
  '  {',
  '    "outcome": "needs_manual_input",',
  '    "flag_message": "<short description of what input is needed and why>",',
  '    "manualInputRequests": [',
  '      {',
  '        "kind": "<short identifier, e.g. market_rent_comp / sales_comp / sponsor_litigation>",',
  '        "detail": "<specific analyst-facing description naming the exact input needed; for per-tenant comps, list the tenants by name>"',
  '      },',
  '      ...',
  '    ]',
  '  }',
  '',
  'Decision criteria:',
  '- When the user message contains an "Authoritative Derived Facts" block, treat those values as the ground truth for the quantities they cover. Asset-class priors and stereotypes are NOT a substitute for a computed value. If the underlying data needed to compute a fact is absent (the block will say verdict=insufficient_data or carry a null aggregate), you MUST return needs_manual_input naming the missing input — do NOT fire on an assumed value, and do NOT silently ignore the principle. When the block documents an absence of risk (e.g., verdict=no_rollover_in_refi_window), it is appropriate to return outcome=not_fired with flag_message describing the deal STRENGTH the data confirms.',
  '- The Authoritative Derived Facts block now carries a `reserveSchedule` with NINE reserve fields (not just monthly replacement reserves). When evaluating reserve-adequacy principles, you MUST read the full schedule before concluding. The handbook\'s "appraisal TI estimates typically too low" prior does NOT permit you to fire CRITICAL on a single null/zero field when other reserves are populated — fire only when the WHOLE schedule is inadequate to the deal\'s needs, and cite specific numbers in your flag_message.',
  '- The Authoritative Derived Facts block also carries `terminationOptions`. In Phase 2 this is ALWAYS an extraction gap (extracted=false). Treat the absence of footnote data as an open question, not as evidence of absence: a principle requiring termination-option data returns needs_manual_input with kind=\'termination_option_extraction_gap\'.',
  '- Fire (outcome=\"fired\") only when the principle\'s concern is genuinely present in this deal. Be willing to fire on universal-philosophy principles when the deal\'s structure warrants commentary even if no covenant is breached.',
  '- Use outcome=\"needs_manual_input\" when the principle\'s text identifies a required input that must come from the manual analyst layer (rent comps, sales comps, sponsor lookups, etc.) AND that input is not present in the deal data. Do NOT fabricate market PSF, comp values, or other numbers you have no basis for.',
  '- Choose severity matching the principle\'s default severity unless the deal\'s specifics warrant a different tier.',
  '- evidenceQuotes should cite numeric fields and their values when possible (e.g. "DSCR 1.05", "loan-to-value 0.66"). Empty array when not fired.',
  '',
  'Do not include text outside the JSON object.',
].join('\n');

function buildPrompt(args: LlmContextCheckArgs): string {
  const dealJson = canonicalize({
    assetType: args.assetProfile.propertyType,
    metrics: args.adjustedInputs.metrics,
    loan: {
      amount: args.adjustedInputs.loan.loanAmount.adjusted,
      interestRate: args.adjustedInputs.loan.interestRate.adjusted,
      termMonths: args.adjustedInputs.loan.termMonths.adjusted,
      amortizationMonths: args.adjustedInputs.loan.amortizationMonths.adjusted,
      ioPeriodMonths: args.adjustedInputs.loan.ioPeriodMonths.adjusted,
      debtServiceAnnual: args.adjustedInputs.loan.debtServiceAnnual.adjusted,
    },
    income: {
      grossRentalIncome: args.adjustedInputs.income.grossRentalIncome.adjusted,
      effectiveGrossIncome: args.adjustedInputs.income.effectiveGrossIncome.adjusted,
      vacancyPct: args.adjustedInputs.income.vacancyPct.adjusted,
      otherIncome: args.adjustedInputs.income.otherIncome.adjusted,
    },
    expenses: { totalOperatingExpenses: args.adjustedInputs.expenses.totalOperatingExpenses.adjusted },
    capitalReserves: { monthlyReplacementReserves: args.adjustedInputs.capitalReserves.monthlyReplacementReserves.adjusted },
    assumptions: {
      capRate: args.adjustedInputs.assumptions.capRate.adjusted,
      rentGrowthPct: args.adjustedInputs.assumptions.rentGrowthPct.adjusted,
      expenseGrowthPct: args.adjustedInputs.assumptions.expenseGrowthPct.adjusted,
    },
    stressScenarios: args.stressOutputs.scenarios.map((s) => ({
      name: s.name, noi: s.noi, dscr: s.dscr, ltv: s.ltv, debtYield: s.debtYield,
      breaches: s.breaches,
    })),
    assetProfile: {
      businessPlan: args.assetProfile.businessPlan,
      marketLiquidity: args.assetProfile.marketLiquidity,
    },
    propertyMetadata: args.propertyMetadata,
    confidenceReduction: args.adjustedInputs.confidenceReduction,
    dataQualityFlags: args.adjustedInputs.dataQualityFlags,
    deterministicFiredFlagsCount: args.deterministicFiredFlags.length,
  });

  // Authoritative Derived Facts block (Phase 1 — refi-window gate).
  // Surfaced ABOVE the deal-data block so the LLM sees it first. The
  // SYSTEM_PROMPT instructs the LLM to treat these as ground truth and
  // to choose needs_manual_input when verdicts say insufficient_data.
  // The same canonicalization drives computeContextHash so the block is
  // cache-stable for identical inputs.
  const computedFactsJson = args.computedFacts !== undefined
    ? canonicalize(args.computedFacts)
    : null;
  const computedFactsBlock = computedFactsJson !== null
    ? [
        'AUTHORITATIVE DERIVED FACTS — these are server-computed from the deal\'s typed records. Use them as ground truth. Do NOT infer the same quantities from asset-class priors or stereotypes:',
        computedFactsJson,
        '',
        'For refinancingRisk specifically: the verdict field tells you the gate\'s read.',
        '  verdict=no_rollover_in_refi_window → no leases expire before maturity + refiWindowMonths. Document this as a deal STRENGTH in your flag_message if the principle concerns rollover/re-leasing/refinancing risk; outcome=not_fired with strength-prose.',
        '  verdict=rollover_in_refi_window → real rollover exists; fire the relevant principle sized to the actual aggregate fraction and per-tenant schedule given; cite specific tenants and dates in your evidence.',
        '  verdict=insufficient_data → return needs_manual_input naming exactly what is missing (per-tenant lease expirations, loan maturity date, or both). Do NOT fall back to an assumed rollover figure.',
        '',
        'For reserveSchedule specifically: this is the FULL set of capital-reserve figures the UW concluded.',
        '  - Do NOT fire reserves-related principles (P-III-3, P-III-4, P-IV-OFF-3) on monthlyReplacementReserves=$0 alone if other reserve figures (monthlyTiLc, monthlyCapex, capexScheduleInflated, upfronts, pcaImmediateRepairs) carry non-null/non-zero values. Read the WHOLE schedule.',
        '  - totalMonthlyReservesDollars and anyMonthlyReservePopulated are convenience roll-ups; use them when the question is "is the deal reserved at all" vs "is each specific reserve sized to plan."',
        '  - The reserves come from AdjustedInputs.capitalReserves (the canonical adjusted layer), NOT from a stereotype. When firing on inadequate reserves, cite specific numbers from this block.',
        '',
        'For terminationOptions specifically: extracted=false means rent-roll footnote annotations are NOT in the graph today. If a principle requires termination-option data (e.g., early-termination/kickout rights), you MUST return needs_manual_input with kind=\'termination_option_extraction_gap\' and detail referencing extractionGap.detail. Do NOT assume there are no termination options just because the field is null — you cannot conclude anything about their existence without the footnote extraction landing in a future ticket.',
        '',
      ].join('\n')
    : '';

  // Per-tenant rent-roll block (Phase 2 — rent-roll-node). Curated to top-N
  // by in-place income with an "other" aggregate so a 200-tenant roll doesn't
  // balloon the prompt. The same curation drives computeContextHash, so this
  // block's bytes are cache-stable for identical rolls.
  const rentRollJson = args.rentRoll !== undefined
    ? canonicalize(curateRentRoll(args.rentRoll))
    : null;
  const rentRollBlock = rentRollJson !== null
    ? [
        '',
        'Per-tenant rent roll (top tenants by in-place income + "other" aggregate when applicable). All in-place rent figures are ANNUAL DOLLARS unless suffixed _psf; in-place_rent_psf is derived (annual / SF, null when either operand is null):',
        rentRollJson,
        '',
        'Use these per-tenant numbers when the principle requires tenant-level analysis (above-market rent, tenant concentration, lease expiration laddering, lease-type recovery treatment). PSF figures are derived from the same source — they are not independent data.',
      ].join('\n')
    : '';

  // Manual-input layer (analyst-supplied; NOT extracted from documents).
  // Surface only when present — absence is meaningful (drives the
  // needs_manual_input path for principles that require this kind of data).
  const manualInputsJson = args.manualInputs !== undefined
    ? canonicalize(args.manualInputs)
    : null;
  const manualInputsBlock = manualInputsJson !== null
    ? [
        '',
        'Analyst-supplied manual inputs (NOT extracted — entered by the analyst):',
        manualInputsJson,
        '',
        'When the principle requires this kind of input, treat the manual-input bundle as authoritative and reach a fired conclusion grounded in it. Only return needs_manual_input when the required input is genuinely absent from BOTH the deal data and the manual inputs.',
      ].join('\n')
    : '';

  // Order: authoritative derived facts → deal aggregates → per-tenant rent roll
  // → analyst-supplied manual inputs. Derived facts are FIRST so the LLM sees
  // them before any deal aggregates that might invite prior-based inference.
  return [
    `Principle to evaluate: ${args.principle.id} — ${args.principle.title}`,
    `Default severity: ${args.principle.severity}`,
    `Principle text:`,
    `  ${args.principle.principleText}`,
    '',
    computedFactsBlock,
    'Deal data (JCS-canonical JSON):',
    dealJson,
    rentRollBlock,
    manualInputsBlock,
    'Evaluate this principle against this deal. Return the JSON object as specified.',
  ].join('\n');
}

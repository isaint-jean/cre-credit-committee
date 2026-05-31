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
  ManualInputRequest,
  NarrativeFacts,
  PropertyMetadata,
  SkipReason,
  StressOutputs,
} from '@cre/contracts';
import type { Principle } from '@cre/contracts';
import { canonicalize } from '../../util/canonical-json.js';
import { createHash } from 'node:crypto';
import { callAIWithContinuation } from '../ai-analysis.service.js';
import type { RecordGraphStore } from '../../storage/record-graph-store.js';

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

export interface LlmContextCheckArgs {
  readonly principle: Principle;
  readonly adjustedInputs: AdjustedInputs;
  readonly stressOutputs: StressOutputs;
  readonly assetProfile: AssetProfile;
  readonly propertyMetadata: PropertyMetadata | null;
  readonly narrativeFacts: NarrativeFacts;
  readonly deterministicFiredFlags: ReadonlyArray<FiredFlag>;
  readonly handbookEngineVersion: string;
}

export interface LlmContextCheckDeps {
  readonly llmCall?: typeof callAIWithContinuation;
  readonly modelVersion?: string;
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

// --- Context-hash assembly --------------------------------------------------
//
// Mirrors the Phase 0 spike's curation exactly. Any change to this function
// invalidates every cached LLM eval — bump HANDBOOK_ENGINE_VERSION when changing.

function computeContextHash(args: LlmContextCheckArgs): string {
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

  return [
    `Principle to evaluate: ${args.principle.id} — ${args.principle.title}`,
    `Default severity: ${args.principle.severity}`,
    `Principle text:`,
    `  ${args.principle.principleText}`,
    '',
    'Deal data (JCS-canonical JSON):',
    dealJson,
    '',
    'Evaluate this principle against this deal. Return the JSON object as specified.',
  ].join('\n');
}

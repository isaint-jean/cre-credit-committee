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
        // 'llm_eval_failed' when the LLM call itself failed (malformed
        // output even after retry). 'no_band_matched' when the LLM evaluated
        // cleanly and concluded fired=false (carrying the same semantic as
        // the deterministic engine's existing 'principle checked, no flag
        // warranted' skip).
        readonly reason: SkipReason;
        readonly detail?: string;
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

interface LlmStructuredOutput {
  readonly fired: boolean;
  readonly severity: 'critical' | 'high' | 'medium' | 'advisory';
  readonly flag_message: string;
  readonly evidenceQuotes: ReadonlyArray<string>;
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'advisory']);

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
  if (typeof o.fired !== 'boolean') return null;
  if (typeof o.severity !== 'string' || !VALID_SEVERITIES.has(o.severity)) return null;
  if (typeof o.flag_message !== 'string') return null;
  if (!Array.isArray(o.evidenceQuotes) || o.evidenceQuotes.some((q) => typeof q !== 'string')) return null;

  return {
    fired: o.fired,
    severity: o.severity as LlmStructuredOutput['severity'],
    flag_message: o.flag_message,
    evidenceQuotes: o.evidenceQuotes as ReadonlyArray<string>,
  };
}

function resultFromLlmOutput(principle: Principle, parsed: LlmStructuredOutput): LlmEvalResult {
  if (!parsed.fired) {
    // Not-fired is NOT a failure — it's a clean "principle evaluated, no flag
    // warranted". Reuse the engine's existing 'no_band_matched' skip reason
    // which carries the same semantic in the deterministic path. Distinct from
    // 'llm_eval_failed' (the LLM call itself failed).
    return {
      status: 'skipped',
      skip: { principleId: principle.id, reason: 'no_band_matched' },
    };
  }

  return {
    status: 'fired',
    flag: {
      principleId: principle.id,
      severity: parsed.severity,
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
  'OUTPUT FORMAT (strict): return a SINGLE JSON object with EXACTLY these fields, no surrounding prose, no markdown fences:',
  '  {',
  '    "fired": <boolean>,',
  '    "severity": "critical" | "high" | "medium" | "advisory",',
  '    "flag_message": "<one-sentence analyst-readable description of the concern; if fired=false, briefly note why the principle is satisfied>",',
  '    "evidenceQuotes": [<short evidence strings from the deal data that support your decision; cite specific numbers and fields>]',
  '  }',
  '',
  'Decision criteria:',
  '- Fire (fired=true) only when the principle\'s concern is genuinely present in this deal. Be willing to fire on universal-philosophy principles when the deal\'s structure warrants commentary even if no covenant is breached.',
  '- Choose severity matching the principle\'s default severity unless the deal\'s specifics warrant a different tier.',
  '- evidenceQuotes should cite numeric fields and their values when possible (e.g. "DSCR 1.05", "loan-to-value 0.66"). Empty array when fired=false.',
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

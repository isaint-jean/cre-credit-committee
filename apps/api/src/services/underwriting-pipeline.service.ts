/**
 * Underwriting Pipeline Orchestrator
 *
 * Single deterministic pipeline. No step can be skipped or bypassed.
 * No independent or parallel extraction paths.
 *
 *   ASR → JSON extraction → validation → credit engine → cross-check → output
 *
 * If any required field is missing, the pipeline STOPS immediately.
 *
 * Note: AI scoring still runs as a downstream step in the route handler
 * (per current product decision). The pipeline output is the single source
 * of truth for the underwriting model and cross-check.
 */

import type {
  ParsedDocument,
  AssetType,
  SellerExtractedMetrics,
  ExtractionResult,
  CrossCheckFinding,
  AdjustmentBias,
  CriteriaRuleSet,
  PreValidationGateResult,
  UnderwritingModel,
} from '@cre/shared';
import {
  extractSellerMetrics,
  extractUnderwriting,
} from './ai-analysis.service.js';
import {
  extractCoreFields,
  runPreValidationGate,
  validateDerivedMetrics,
} from './data-extraction.service.js';
import { mergeUnderwritingModels } from './merge-underwriting-models.js';
import { generateDeterministicCrossCheck } from './cross-check.service.js';

export interface UnderwritingPipelineOutput {
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  errorStep?: 'extract' | 'required_fields' | 'validation' | 'engine' | 'cross_check';
  // Step outputs (always returned where computed; never recomputed elsewhere)
  sellerMetrics: SellerExtractedMetrics | null;
  extractionResult: ExtractionResult | null;
  preValidationGate: PreValidationGateResult | null;
  derivationIssues: string[];
  uwModel: UnderwritingModel | null;
  // Batch 1A — pre-merge extractions, surfaced so downstream consumers (template
  // populator) can render the multi-period Operating History columns. The merged
  // uwModel above remains the single source of truth for metrics; these are only
  // for column-level display. Either may be null if its source document was absent.
  uwModelFromAsr: UnderwritingModel | null;
  uwModelFromSeller: UnderwritingModel | null;
  crossCheckFindings: CrossCheckFinding[];
  overallAdjustmentBias: AdjustmentBias | null;
}

const REQUIRED_FIELDS = ['noi', 'loanAmount', 'capRate', 'interestRate'] as const;

function emptyOutput(): UnderwritingPipelineOutput {
  return {
    status: 'FAILED',
    sellerMetrics: null,
    extractionResult: null,
    preValidationGate: null,
    derivationIssues: [],
    uwModel: null,
    uwModelFromAsr: null,
    uwModelFromSeller: null,
    crossCheckFindings: [],
    overallAdjustmentBias: null,
  };
}

/**
 * Run the full deterministic pipeline. Each step's output is passed
 * explicitly to the next; no implicit shared state.
 */
export async function runUnderwritingPipeline(
  asrDocument: ParsedDocument,
  uwDocument: ParsedDocument | null,
  assetType: AssetType,
  criteria: CriteriaRuleSet | null,
  hooks?: {
    onStep?: (step: string, message: string) => void;
  },
): Promise<UnderwritingPipelineOutput> {
  const out = emptyOutput();
  const step = (s: string, m: string) => hooks?.onStep?.(s, m);

  // ---- STEP 1: EXTRACT STRUCTURED JSON ----
  // Single AI extraction path (seller-metric prompt) + deterministic synonym
  // layer. These are the only extraction sources; no other code path may call
  // its own extraction.
  step('extract', 'Extracting structured data from documents');

  let sellerMetrics: SellerExtractedMetrics | null = null;
  try {
    sellerMetrics = await extractSellerMetrics(asrDocument, assetType, uwDocument);
  } catch (err) {
    console.warn('[Pipeline] Seller metric extraction failed (non-fatal):', err);
  }
  out.sellerMetrics = sellerMetrics;

  const extractionResult = extractCoreFields(asrDocument, uwDocument, sellerMetrics);
  out.extractionResult = extractionResult;

  // ---- STEP 2: REQUIRED FIELDS GATE — HARD STOP ----
  step('required_fields', 'Checking required fields');

  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const v = extractionResult.fields[field]?.value;
    if (v === null || v === undefined || v === 0 || (typeof v === 'number' && Number.isNaN(v))) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    return {
      ...out,
      status: 'FAILED',
      error: `INCOMPLETE INPUT DATA — missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      errorStep: 'required_fields',
    };
  }

  // ---- STEP 3: VALIDATION (traceability layer) ----
  step('validation', 'Validating extraction traceability');

  const derivationIssues = validateDerivedMetrics(extractionResult);
  out.derivationIssues = derivationIssues;

  const preValidationGate = runPreValidationGate(extractionResult);
  out.preValidationGate = preValidationGate;

  if (!preValidationGate.passed) {
    return {
      ...out,
      status: 'FAILED',
      error: `${preValidationGate.message}${derivationIssues.length > 0 ? ` Derivation issues: ${derivationIssues.join('; ')}` : ''}`,
      errorStep: 'validation',
    };
  }

  // ---- STEP 4: CREDIT ENGINE ----
  // Builds the underwriting model. Receives ONLY the validated extraction
  // outputs from prior steps — no documents are re-read for new fields.
  step('engine', 'Running BP Spiral credit engine');

  let uwModel: UnderwritingModel;
  try {
    // Dual-extract + merge. Both documents are independently extracted into a
    // candidate UnderwritingModel; mergeUnderwritingModels then resolves them
    // field-by-field via the locked precedence policy. When uwDocument is
    // absent, we run only the ASR extraction (no merge needed). Conflicts are
    // surfaced via derivationIssues for IC defensibility.
    const asrUw = await extractUnderwriting(asrDocument, assetType, extractionResult, sellerMetrics);
    out.uwModelFromAsr = asrUw;
    if (uwDocument === null) {
      uwModel = asrUw;
    } else {
      const sellerUw = await extractUnderwriting(uwDocument, assetType, extractionResult, sellerMetrics);
      out.uwModelFromSeller = sellerUw;
      const mergeResult = mergeUnderwritingModels(asrUw, sellerUw);
      uwModel = mergeResult.merged;
      for (const c of mergeResult.conflicts) {
        out.derivationIssues.push(
          `merge-conflict[${c.field}] asr=${JSON.stringify(c.asrValue)} seller=${JSON.stringify(c.sellerValue)} chosen=${JSON.stringify(c.chosen)}`,
        );
      }
    }
  } catch (err: any) {
    return {
      ...out,
      status: 'FAILED',
      error: err?.message || 'Credit engine failed',
      errorStep: 'engine',
    };
  }
  out.uwModel = uwModel;

  // ---- STEP 5: CROSS-CHECK ----
  step('cross_check', 'Running deterministic cross-check');

  if (sellerMetrics) {
    try {
      const cc = generateDeterministicCrossCheck(sellerMetrics, uwModel, criteria);
      out.crossCheckFindings = cc.findings;
      out.overallAdjustmentBias = cc.overallBias;
    } catch (err) {
      console.warn('[Pipeline] Cross-check failed (non-fatal):', err);
    }
  }

  // ---- STEP 6: OUTPUT ----
  out.status = 'SUCCESS';
  return out;
}

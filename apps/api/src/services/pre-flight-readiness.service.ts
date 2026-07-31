/**
 * Pre-flight readiness — predict a deal's output BEFORE minting, by ASSEMBLING
 * existing signals at a pre-mint seam. It NEVER mints and NEVER writes canonical.
 *
 * ★ THE INVARIANT (honesty by reuse): every number the pre-flight reports is
 * BYTE-IDENTICAL to what the mint produces, because it does NOT re-implement or
 * approximate anything — it READS the real ExtractionResult and RUNS THE SAME
 * deterministic code the mint runs:
 *   - Part A (field ledger) reuses `computeIntakeCompleteness` verbatim — the K/D
 *     resolver reads the same extraction paths the mint's judgment engine reads,
 *     so "populated" is a READ of the extracted data, not a forecast.
 *   - Part B (derived verdict) runs the REAL `evaluateFromAdjustedInputs` — the
 *     mint's deterministic front-half (judgment → cross-check → stress → handbook
 *     → valuation → evaluateDeal → bridge) — against a THROWAWAY in-memory scratch
 *     store. All its writes are inserts that land in scratch and are discarded;
 *     canonical is untouched. It stops BEFORE the expensive tail (buildNarrative +
 *     external DD live only in `evaluateAndNarrate`), so no LLM/web calls fire.
 *   - Part C (reverse rollup) is derived from the same INTAKE_FIELD_BINDINGS
 *     `source_doc_types` — a doc is only claimed to unlock a field the binding
 *     says it sources.
 *
 * If a pre-flight number ever diverges from the mint, the pre-flight is wrong —
 * the fix is to REUSE more faithfully, never to patch the prediction.
 */

import type {
  AdjustedInputs,
  AssetProfile,
  ExtractionResult,
  LibrarySnapshot,
  NarrativeFacts,
  PropertyMetadata,
  RentRoll,
  SourceDocumentKind,
} from '@cre/contracts';
import {
  computeIntakeCompleteness,
  INTAKE_FIELD_BINDINGS,
  type IntakeFieldResult,
} from './intake-completeness.service.js';
import type { OverlayPresence } from './document-completeness.service.js';
import {
  evaluateFromAdjustedInputs,
  DataIntegrityHardHaltError,
  type EvaluateFromAdjustedInputsArgs,
} from './evaluate-from-adjusted-inputs.js';
import { RecordGraphStore } from '../storage/record-graph-store.js';

/* ------------------------------- result shape ----------------------------- */

/** One field's readiness line — a thin view over an IntakeFieldResult. */
export interface PreFlightField {
  readonly id: string;
  readonly section: string;
  readonly field: string;
  /** What this field feeds downstream (from the binding). */
  readonly feeds: string;
  /** What is gated if this field is missing (from the binding). */
  readonly blocks: string;
  /** The document kinds that source this field (from the binding). */
  readonly sources: readonly SourceDocumentKind[];
  readonly criticality: string;
  /**
   * Exhaustive-search verdict when an (optional, expensive) search overlay ran:
   * 'searched' = genuinely absent (earned blank); 'unavailable' = search could
   * NOT run → UNVERIFIED, never presented as confirmed-missing. Absent in the
   * cheap pre-flight (no exhaustive LLM search) — a MISSING field then means "no
   * extraction key resolved and no source doc present," NOT "exhaustively
   * confirmed absent."
   */
  readonly searchStatus?: 'searched' | 'unavailable';
}

/** The three states Isabelle asked for, plus the two non-gap buckets. */
export interface PreFlightLedger {
  /** PRODUCE — sourced; the mint will populate this. */
  readonly produce: readonly PreFlightField[];
  /** BLANK-in-a-doc — a source doc is present but the value wasn't extracted. */
  readonly blankInDoc: readonly PreFlightField[];
  /** MISSING — no extraction key resolved AND no source doc present. */
  readonly missing: readonly PreFlightField[];
  /** decision-blank — an underwriter call, NOT a gap. */
  readonly decision: readonly PreFlightField[];
  /** not-applicable to THIS deal (e.g. GSA terms on a non-GSA deal) — NOT a gap. */
  readonly notApplicable: readonly PreFlightField[];
  /** Counts for a quick read. */
  readonly counts: { produce: number; blankInDoc: number; missing: number; sourceable: number };
}

/**
 * The derived verdict — the mint's REAL deterministic outcome, computed via the
 * scratch-store re-run, flagged PROVISIONAL because it is produced pre-mint (the
 * narrative + external DD have not run; neither changes these numbers).
 */
export interface PreFlightVerdict {
  readonly provisional: true;
  /** DataConfidence off the AdjustedInputs (judgment-engine output). */
  readonly dataConfidence: AdjustedInputs['dataConfidence'];
  /** ★ Will this deal mint to InsufficientData? (coverage gate failed.) */
  readonly willMintToInsufficientData: boolean;
  /** Will the data-integrity gate HARD-halt the mint? (deal can't mint at all.) */
  readonly willHardHalt: boolean;
  /** Hard-halt reasons when willHardHalt. */
  readonly hardHaltReasons: readonly string[];
  /** The real deterministic finalScore (null when it can't score). */
  readonly finalScore: number | null;
  /** The real rating band / recommendation (byte-identical to the mint). */
  readonly band: string | null;
  readonly recommendation: string;
}

/** For each missing/blank field, which doc would unlock it + what it enables. */
export interface PreFlightUnlock {
  readonly doc: SourceDocumentKind;
  /** The fields (by name) this doc would source, that are currently missing/blank. */
  readonly unlocksFields: readonly string[];
  /** The downstream outputs those fields feed (deduped). */
  readonly unlocksOutputs: readonly string[];
}

export interface PreFlightReadiness {
  readonly ledger: PreFlightLedger;
  readonly verdict: PreFlightVerdict;
  readonly unlocks: readonly PreFlightUnlock[];
}

/* ------------------------------ input + deps ------------------------------ */

/**
 * Everything the pre-flight needs — the SAME inputs the mint consumes. For an
 * existing deal, `reconstructPreFlightArgs` reads these from the graph; at the
 * build-and-ingest seam the route provides them from its ingest front-half.
 */
export interface PreFlightArgs {
  readonly extraction: ExtractionResult;
  readonly adjustedInputs: AdjustedInputs;
  readonly assetProfile: AssetProfile;
  readonly librarySnapshot: LibrarySnapshot;
  readonly narrativeFacts: NarrativeFacts;
  readonly propertyMetadata: PropertyMetadata | null;
  readonly rentRoll: RentRoll | null;
  readonly sourceDocumentKinds: readonly SourceDocumentKind[];
  /** Legacy overlay presence (classic-ingest deals). Graph-native → all false. */
  readonly overlayPresence?: OverlayPresence;
}

export interface PreFlightDeps {
  /** Scratch store factory — the derived verdict runs the real mint front-half
   *  against this and discards it. Defaults to a fresh in-memory RecordGraphStore
   *  so NOTHING canonical is ever written. Injectable for tests. */
  readonly scratchStore?: () => RecordGraphStore;
}

const ALL_OVERLAYS_ABSENT: OverlayPresence = {
  t12Extraction: false,
  issuerUwExtraction: false,
  sourcesAndUses: false,
  pcaExtraction: false,
  partiesExtraction: false,
  appraisalExtraction: false,
};

/* --------------------------------- Part A --------------------------------- */

function toField(f: IntakeFieldResult): PreFlightField {
  return {
    id: f.id, section: f.section, field: f.field, feeds: f.feeds, blocks: f.blocks,
    sources: f.sources, criticality: f.criticality,
    ...(f.searchStatus !== undefined ? { searchStatus: f.searchStatus } : {}),
  };
}

/** Group the intake ledger into the PRODUCE / BLANK / MISSING view. Pure. */
export function buildLedger(fields: readonly IntakeFieldResult[]): PreFlightLedger {
  const produce = fields.filter(f => f.state === 'populated').map(toField);
  const blankInDoc = fields.filter(f => f.state === 'in-PDF-not-extracted').map(toField);
  const missing = fields.filter(f => f.state === 'not-in-any-doc').map(toField);
  const decision = fields.filter(f => f.state === 'decision-blank').map(toField);
  const notApplicable = fields.filter(f => f.state === 'not-applicable').map(toField);
  return {
    produce, blankInDoc, missing, decision, notApplicable,
    counts: {
      produce: produce.length,
      blankInDoc: blankInDoc.length,
      missing: missing.length,
      sourceable: produce.length + blankInDoc.length + missing.length,
    },
  };
}

/* --------------------------------- Part C --------------------------------- */

/**
 * Reverse rollup: for each MISSING/BLANK field, which document would unlock it,
 * grouped by document. Derived from the SAME binding `source_doc_types` — a doc
 * is only claimed to unlock a field the binding says it sources (honest: never
 * overpromise). A doc PRESENT-but-unreadable is a different problem (that's a
 * BLANK-in-doc field, which we still surface as "add/fix this doc's data").
 */
export function buildUnlocks(gapFields: readonly PreFlightField[]): readonly PreFlightUnlock[] {
  const byDoc = new Map<SourceDocumentKind, { fields: string[]; outputs: Set<string> }>();
  for (const f of gapFields) {
    for (const doc of f.sources) {
      const entry = byDoc.get(doc) ?? { fields: [], outputs: new Set<string>() };
      entry.fields.push(f.field);
      if (f.feeds.trim().length > 0) entry.outputs.add(f.feeds.trim());
      byDoc.set(doc, entry);
    }
  }
  return [...byDoc.entries()]
    .map(([doc, e]) => ({ doc, unlocksFields: e.fields, unlocksOutputs: [...e.outputs] }))
    // Most-unlocking docs first — the highest-leverage upload to request.
    .sort((a, b) => b.unlocksFields.length - a.unlocksFields.length);
}

/* --------------------------------- Part B --------------------------------- */

/**
 * The derived verdict — runs the mint's REAL deterministic front-half
 * (`evaluateFromAdjustedInputs`) against a throwaway scratch store. Byte-identical
 * to the mint; writes nothing canonical; no narrative/DD (those are in
 * `evaluateAndNarrate`, not called here). A data-integrity HARD-halt is caught and
 * reported as `willHardHalt` (the deal can't mint) rather than thrown.
 */
export async function computeDerivedVerdict(
  args: PreFlightArgs,
  deps: PreFlightDeps = {},
): Promise<PreFlightVerdict> {
  const scratch = (deps.scratchStore ?? (() => new RecordGraphStore(':memory:')))();
  // The scratch store is compute-only — we read the RETURNED dealResult/evaluation,
  // never query the store. evaluateFromAdjustedInputs inserts its records but does
  // NOT insert the FK targets it assumes pre-exist (librarySnapshot, benchmarks).
  // Disable FK enforcement on the throwaway so those inserts don't trip — exactly
  // the render-snapshot boot-check pattern. The verdict numbers are unaffected
  // (they come from the pure evaluateDeal, not from a store round-trip).
  try { (scratch as unknown as { db: { pragma: (s: string) => void } }).db.pragma('foreign_keys = OFF'); } catch { /* best-effort */ }
  try {
    const evalArgs: EvaluateFromAdjustedInputsArgs = {
      adjustedInputs: args.adjustedInputs,
      assetProfile: args.assetProfile,
      librarySnapshot: args.librarySnapshot,
      narrativeFacts: args.narrativeFacts,
      extractionResultId: args.extraction.id,
      extraction: args.extraction,
      analysisAsOfDate: args.extraction.analysisAsOfDate,
      propertyMetadata: args.propertyMetadata,
      rentRoll: args.rentRoll,
    };
    let result;
    try {
      result = await evaluateFromAdjustedInputs(evalArgs, scratch);
    } catch (err) {
      if (err instanceof DataIntegrityHardHaltError) {
        return {
          provisional: true,
          dataConfidence: args.adjustedInputs.dataConfidence,
          willMintToInsufficientData: false,
          willHardHalt: true,
          hardHaltReasons: (err.report.findings ?? []).filter((f: { severity?: string }) => f.severity === 'HARD').map((f: { message: string }) => f.message),
          finalScore: null,
          band: null,
          recommendation: 'HARD_HALT',
        };
      }
      throw err;
    }
    const rating = result.dealResult.rating;
    // ★ Match the memo's actual gate EXACTLY (build-committee-memo.ts memoGated):
    // the committee memo shows "Insufficient data — refer back" when the income is
    // unvalidated OR the doctrine abstained (coverage gate → recommendation
    // 'InsufficientData'). 640 is the unvalidated case: its doctrine rating is
    // ApproveWithConditions, but the memo refers it back on unvalidated income.
    const willMintToInsufficientData =
      args.adjustedInputs.dataConfidence === 'unvalidated' ||
      rating.recommendation === 'InsufficientData';
    return {
      provisional: true,
      dataConfidence: args.adjustedInputs.dataConfidence,
      willMintToInsufficientData,
      willHardHalt: false,
      hardHaltReasons: [],
      finalScore: (result.evaluation as { finalScore?: number | null }).finalScore ?? null,
      band: rating.band ?? null,
      recommendation: rating.recommendation,
    };
  } finally {
    // The scratch store is a throwaway; close it so the in-memory handle is freed.
    try { (scratch as unknown as { close?: () => void }).close?.(); } catch { /* best-effort */ }
  }
}

/* ------------------------------ orchestrator ------------------------------ */

/**
 * Compute the full pre-flight readiness — ledger (A) + derived verdict (B) +
 * reverse rollup (C). Read-only: reads the real extraction, runs the real
 * deterministic front-half against scratch, writes NOTHING canonical.
 */
export async function computePreFlightReadiness(
  args: PreFlightArgs,
  deps: PreFlightDeps = {},
): Promise<PreFlightReadiness> {
  // Part A — field ledger. Reuse computeIntakeCompleteness verbatim; feed it a
  // minimal analysis-shaped object carrying the in-memory ExtractionResult so its
  // K/D resolver reads the SAME extraction paths the mint reads.
  const intake = computeIntakeCompleteness({
    analysis: { extractionResult: args.extraction } as never,
    sourceDocumentKinds: args.sourceDocumentKinds,
    overlayPresence: args.overlayPresence ?? ALL_OVERLAYS_ABSENT,
  });
  const ledger = buildLedger(intake.fields);

  // Part B — derived verdict (byte-identical, scratch-store).
  const verdict = await computeDerivedVerdict(args, deps);

  // Part C — reverse rollup over the gap fields (missing + blank-in-doc).
  const unlocks = buildUnlocks([...ledger.missing, ...ledger.blankInDoc]);

  return { ledger, verdict, unlocks };
}

/**
 * The CHEAP preview — field ledger (A) + reverse rollup (C) ONLY, computed from
 * an in-memory ExtractionResult with NO scratch mint. This is the build-and-ingest
 * seam preview: it answers "what will this deal PRODUCE / BLANK / MISS, and which
 * doc unlocks more" from a pure read of the extraction, before any judgment/score
 * runs. The derived verdict (B) needs the judgment-produced AdjustedInputs and is
 * delivered by `computePreFlightReadiness` (CLI / post-front-half).
 */
export function computePreFlightLedgerAndUnlocks(
  extraction: ExtractionResult,
  sourceDocumentKinds: readonly SourceDocumentKind[],
  overlayPresence?: OverlayPresence,
): { ledger: PreFlightLedger; unlocks: readonly PreFlightUnlock[] } {
  const intake = computeIntakeCompleteness({
    analysis: { extractionResult: extraction } as never,
    sourceDocumentKinds,
    overlayPresence: overlayPresence ?? ALL_OVERLAYS_ABSENT,
  });
  const ledger = buildLedger(intake.fields);
  const unlocks = buildUnlocks([...ledger.missing, ...ledger.blankInDoc]);
  return { ledger, unlocks };
}

/** Exported for surfaces/tests — the binding roster is the source of truth. */
export { INTAKE_FIELD_BINDINGS };

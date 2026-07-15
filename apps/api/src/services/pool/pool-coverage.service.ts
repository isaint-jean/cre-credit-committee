/**
 * Per-loan DOC-COVERAGE projection (Data-Room Phase 3 — P0). READ-ONLY.
 *
 * DOCTRINE — coverage is ORTHOGONAL to the Status/score verdict. It answers a
 * document question, never a credit question:
 *
 *   green (complete)  = every REQUIRED tier-(a) doc-type's intake fields are
 *                       POPULATED (K = the underwriting fact is sourced). Green
 *                       requires K — never merely a doc being present.
 *   partial           = some tier-(a) fields populated, some still not-in-any-doc
 *                       (the missing doc-types are named).
 *   none (gray)       = no tier-(a) coverage at all.
 *
 * A green-coverage / High-Risk deal is HONEST: "docs complete" ≠ "good deal".
 * The palette + copy on the web side stay deliberately neutral / doc-vocabulary
 * so coverage can never be misread as a credit signal.
 *
 * ── The K-gated derivation (two paths) ──────────────────────────────────────
 *
 *   ANALYZED loan (dealRef resolves to an analysis root):
 *     Reuse `computeIntakeCompleteness` (the SAME field-level ledger the
 *     /analyses/:id/intake-completeness route runs). Group the tier-(a)
 *     doc-types by whether the intake fields sourced from them are POPULATED
 *     (K) vs `not-in-any-doc`. Only tier-(a) required doc-types gate green.
 *
 *   UN-ANALYZED loan (no analysis root):
 *     No intake ledger to run. Derive from data-room DOC-PRESENCE only
 *     (`listPoolDocs` — does the loan carry tier-(a) docs?). Docs present but
 *     un-extracted is `partial` (never green — there is no K yet); no tier-(a)
 *     docs at all is `none`.
 *
 * ── What gates green (LOCKED) ────────────────────────────────────────────────
 *   ONLY required tier-(a) doc-types (asr, cf→{in_place,t12}, rent_roll, pca,
 *   appraisal — DOC_TYPE_TAXONOMY tier === 'ingesting'). Tier-(b)
 *   seller_uw / t12 and tier-(c) room-only doc-types DO NOT gate.
 *
 * READ-ONLY: no ingest, no cre.db write, no governed / registry touch. Every
 * store handle below is read-only. Re-derived fresh at request; nothing to go
 * stale.
 */

import { DOC_TYPE_TAXONOMY, type SourceDocumentKind } from '@cre/contracts';
import type { RevisionId as GraphRevisionIdType } from '@cre/contracts';
import {
  computeIntakeCompleteness,
  INTAKE_FIELD_BINDINGS,
} from '../intake-completeness.service.js';
import { projectLegacyAnalysisFromGraph } from '../project-legacy-analysis-from-graph.js';
import { listPoolDocs } from '../data-room-store.service.js';
import { store as defaultSqliteStore, SqliteStore } from '../../storage/sqlite-store.js';
import { recordGraphStore as defaultRecordGraphStore, RecordGraphStore } from '../../storage/record-graph-store.js';

/* -------------------------------------------------------------------------- */
/* Tier-(a) doc-type model — the required, green-gating set.                    */
/* -------------------------------------------------------------------------- */

/** The tier-(a) 'ingesting' doc-type ids (asr, cf, rent_roll, pca, appraisal).
 *  Derived from the taxonomy — never a 2nd hand-kept list. */
const TIER_A_DOC_TYPES = DOC_TYPE_TAXONOMY.filter((e) => e.tier === 'ingesting');

/**
 * Each tier-(a) doc-type → the intake `SourceDocumentKind` facets that stand in
 * for it in the intake ledger. `cf` is COMPOSITE (SEAM 1): its single upload
 * slot fans out to the two intake doc-types ['in_place', 't12'], so its coverage
 * reads from whichever fields those kinds source. All other tier-(a) doc-types
 * map to their own id as a SourceDocumentKind. Human label carried for the
 * `missing` list the web column renders.
 */
interface TierADocType {
  readonly id: string;
  readonly label: string;
  /** Intake SourceDocumentKind facets that represent this doc-type. */
  readonly kinds: readonly SourceDocumentKind[];
}

const TIER_A: readonly TierADocType[] = TIER_A_DOC_TYPES.map((e) => ({
  id: e.id,
  label: e.label,
  // cf fans out to its composite intake doc-types; everything else is its own kind.
  kinds: (e.composite ?? [e.id]) as readonly SourceDocumentKind[],
}));

/* -------------------------------------------------------------------------- */
/* Result shape.                                                               */
/* -------------------------------------------------------------------------- */

export type CoverageState = 'complete' | 'partial' | 'none';

export interface LoanCoverage {
  readonly loanInPoolId: string;
  readonly state: CoverageState;
  /** Tier-(a) doc-type LABELS whose fields are not yet populated (partial/none).
   *  Empty for complete. */
  readonly missing: readonly string[];
  /** true when the state came from the intake ledger (analyzed loan), false when
   *  it fell back to data-room doc-presence (un-analyzed loan). Diagnostic only. */
  readonly analyzed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Store handles — default singletons, overridable for tests.                  */
/* -------------------------------------------------------------------------- */

export interface PoolCoverageStores {
  readonly sqliteStore: Pick<SqliteStore, 'lookupAnalysisByDealRef' | 'getAnalysis' | 'getCanonicalScoredAnalysisId'>;
  readonly recordGraphStore: RecordGraphStore;
  /** Data-room doc presence for the un-analyzed fallback path. */
  readonly listPoolDocs: typeof listPoolDocs;
}

let _testStores: PoolCoverageStores | null = null;

/** Test hook: point coverage at a temp-DB set of stores. */
export function _setPoolCoverageStoresForTests(stores: PoolCoverageStores | null): void {
  _testStores = stores;
}

function stores(): PoolCoverageStores {
  if (_testStores !== null) return _testStores;
  return {
    sqliteStore: defaultSqliteStore,
    recordGraphStore: defaultRecordGraphStore,
    listPoolDocs,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-doc-type K roll-up over the intake ledger.                              */
/* -------------------------------------------------------------------------- */

/** Which intake field ids are sourced (partly) from a given SourceDocumentKind. */
const FIELDS_BY_KIND = ((): Map<SourceDocumentKind, ReadonlySet<string>> => {
  const m = new Map<SourceDocumentKind, Set<string>>();
  for (const b of INTAKE_FIELD_BINDINGS) {
    for (const k of b.source_doc_types) {
      const set = m.get(k) ?? new Set<string>();
      set.add(b.id);
      m.set(k, set);
    }
  }
  return m;
})();

/**
 * A tier-(a) doc-type "covers" (is populated) when AT LEAST ONE intake field
 * sourced from any of its kinds is `populated` (K). It is "not covered" when it
 * has covering fields in the roster but NONE of them are populated — i.e. the
 * doc-type's facts are entirely `not-in-any-doc` / un-extracted.
 *
 * A doc-type with no covering fields at all (structurally un-sourceable in the
 * ledger) is treated as covered=null → excluded from the gate (it can neither
 * pass nor fail green). None of the 5 tier-(a) doc-types are in this bucket, but
 * the guard keeps the derivation honest if the roster changes.
 */
function docTypeCovered(
  dt: TierADocType,
  populatedFieldIds: ReadonlySet<string>,
): boolean | null {
  const covering = new Set<string>();
  for (const k of dt.kinds) {
    for (const id of FIELDS_BY_KIND.get(k) ?? []) covering.add(id);
  }
  if (covering.size === 0) return null; // no ledger field sources this doc-type
  for (const id of covering) {
    if (populatedFieldIds.has(id)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Analyzed-loan coverage — via the intake ledger.                             */
/* -------------------------------------------------------------------------- */

function coverageFromLedger(legacyAnalysisId: string): {
  state: CoverageState;
  missing: string[];
} | null {
  const s = stores();
  const stored = s.sqliteStore.getAnalysis(legacyAnalysisId);
  if (!stored) return null; // no projectable legacy analysis → caller falls back

  const analysis = projectLegacyAnalysisFromGraph(stored, s.recordGraphStore);

  // sourceDocumentKinds — SAME derivation as analysis.routes intake-completeness:
  // graphRevisionId → envelope → doctrineEvaluation → ExtractionResult.sourceDocuments.
  let sourceDocumentKinds: SourceDocumentKind[] = [];
  let graphExtractionResult: import('@cre/contracts').ExtractionResult | null = null;
  try {
    const envelope = analysis.graphRevisionId
      ? s.recordGraphStore.getRevisionEnvelope(analysis.graphRevisionId as GraphRevisionIdType)
      : null;
    const doctrine = envelope
      ? s.recordGraphStore.getDoctrineEvaluation(envelope.doctrineEvaluationId)
      : null;
    graphExtractionResult = doctrine ? s.recordGraphStore.getExtractionResult(doctrine.extractionResultId) : null;
    sourceDocumentKinds = (graphExtractionResult?.sourceDocuments ?? []).map((d) => d.kind);
  } catch {
    // best-effort — a missing graph chain leaves kinds empty; overlays still count.
  }

  // ★ DATA-AVAILABILITY, not doc-slots (identical to analysis.routes
  // intake-completeness, commit 3c7ca2a). Attach the graph ExtractionResult so the
  // K resolver resolves against the spine data the score consumed — otherwise a
  // graph-native deal's covered doc-types (ASR + its embedded rent roll) read as
  // MISSING here too, producing a false "partial" with ASR/Rent-roll falsely
  // listed. Cash-flow / T-12 stays honestly missing when there's no operating
  // statement.
  const analysisForLedger = graphExtractionResult
    ? ({ ...analysis, extractionResult: graphExtractionResult } as unknown as typeof analysis)
    : analysis;

  const ledger = computeIntakeCompleteness({
    analysis: analysisForLedger,
    sourceDocumentKinds,
    overlayPresence: {
      t12Extraction: !!analysis.t12Extraction,
      issuerUwExtraction: !!analysis.issuerUwExtraction,
      sourcesAndUses: !!analysis.sourcesAndUses,
      pcaExtraction: !!analysis.pcaExtraction,
      partiesExtraction: !!analysis.partiesExtraction,
      appraisalExtraction: !!analysis.appraisalExtraction,
    },
  });

  const populated = new Set(
    ledger.fields.filter((f) => f.state === 'populated').map((f) => f.id),
  );

  // Roll the ledger up to per-tier-(a)-doc-type K.
  let covered = 0;
  let gating = 0;
  const missing: string[] = [];
  for (const dt of TIER_A) {
    const isCovered = docTypeCovered(dt, populated);
    if (isCovered === null) continue; // structurally un-sourceable → not a gate
    gating += 1;
    if (isCovered) covered += 1;
    else missing.push(dt.label);
  }

  let state: CoverageState;
  if (gating === 0 || covered === 0) state = 'none';
  else if (covered === gating) state = 'complete';
  else state = 'partial';

  return { state, missing };
}

/* -------------------------------------------------------------------------- */
/* Un-analyzed-loan coverage — via data-room doc presence only.                */
/* -------------------------------------------------------------------------- */

function coverageFromDocPresence(poolId: string, loanInPoolId: string): {
  state: CoverageState;
  missing: string[];
} {
  const s = stores();
  const docs = s.listPoolDocs(poolId).filter((d) => d.loanInPoolId === loanInPoolId);
  // Which tier-(a) doc-type SLOTS are present as dropped docs (by taxonomy id)?
  const presentSlotIds = new Set(docs.map((d) => d.docType));
  const missing: string[] = [];
  let present = 0;
  for (const dt of TIER_A) {
    if (presentSlotIds.has(dt.id)) present += 1;
    else missing.push(dt.label);
  }
  // Un-analyzed can never be green (no K yet). Docs present but un-extracted =
  // partial; no tier-(a) docs at all = none.
  const state: CoverageState = present === 0 ? 'none' : 'partial';
  return { state, missing };
}

/* -------------------------------------------------------------------------- */
/* Public API.                                                                 */
/* -------------------------------------------------------------------------- */

/** Compute doc-coverage for one pool loan (by its dealRef + loanInPoolId). */
export function computeLoanCoverage(input: {
  readonly poolId: string;
  readonly loanInPoolId: string;
  readonly dealRef: string;
}): LoanCoverage {
  const s = stores();

  // Resolve the loan's CANONICAL scored analysis — the SAME rule the deal page
  // (resolveAnalysisForRead) uses, so coverage and the deal page never disagree on
  // which copy of a deal is canonical (640 has a duplicate `82fe3bf7` from the
  // agent-incident; the earliest/original `26027996` is canonical).
  const legacyId = s.sqliteStore.getCanonicalScoredAnalysisId(input.dealRef);

  if (legacyId !== null) {
    const fromLedger = coverageFromLedger(legacyId);
    if (fromLedger !== null) {
      return {
        loanInPoolId: input.loanInPoolId,
        state: fromLedger.state,
        missing: fromLedger.missing,
        analyzed: true,
      };
    }
  }

  // Un-analyzed (no root) OR analyzed-but-not-projectable → data-room doc presence.
  const fromDocs = coverageFromDocPresence(input.poolId, input.loanInPoolId);
  return {
    loanInPoolId: input.loanInPoolId,
    state: fromDocs.state,
    missing: fromDocs.missing,
    analyzed: false,
  };
}

/** Compute doc-coverage for a set of pool loans. */
export function computePoolCoverage(
  poolId: string,
  loans: ReadonlyArray<{ readonly loanInPoolId: string; readonly dealRef: string }>,
): readonly LoanCoverage[] {
  return loans.map((l) =>
    computeLoanCoverage({ poolId, loanInPoolId: l.loanInPoolId, dealRef: l.dealRef }),
  );
}

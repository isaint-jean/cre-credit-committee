/**
 * Data-Room classify-on-stage (Data-Room Phase 2a/2b).
 *
 * COMPOSITION of existing primitives — no new ML, no byte/header reading. Runs
 * TWO independent, deterministic-or-refuse classifiers over a staged file's NAME
 * and combines them via a pure truth-table into an auto/confirm verdict.
 *
 *   DOC-TYPE axis — `inferSlotFromFilename` (lifted to @cre/shared, filename
 *     regex only; exactly-1-hit → SourceDocSlot, 0 or ≥2 hits → null). It can
 *     ONLY emit the 7 slotted tier-(a/b) taxonomy ids, so tier-(c) room-only
 *     doc-types (legal/title/insurance/…) are structurally un-inferable → the
 *     doc-type axis is NEVER "confident" for them → they can NEVER auto-file.
 *
 *   LOAN axis — the SAME normalize bridge `resolveLoanForRoot`'s Hop-2 PASS-2
 *     uses (parse-bmark-tape-xlsx normalizers), retargeted from a graph-root name
 *     to the dropped FILENAME: run the filename through `normalizeForMatch` (to
 *     peel extension + slot hints + prefixes into a bare property core) then
 *     `normalizePropertyName` so it lands in the SAME keyspace the pool side is
 *     normalized into, and compare against each pool loan's normalized
 *     originatorLoanRef / propertyName. Exactly-1 distinct loanInPoolId →
 *     confident; 0 or ≥2 → refuse (null). No third normalizer, no new fuzzy risk.
 *
 * THE PERMANENT SAFETY BAR: auto-route ONLY when BOTH axes are exactly-1-
 * confident. Single-axis-confident NEVER auto-routes — it goes to the confirm
 * tray pre-filled with whatever WAS confident. See `verdictFor`.
 *
 * Pure over its inputs (poolLoans is passed in) — no DB, no I/O here.
 */

import { inferSlotFromFilename, normalizeForMatch } from '@cre/shared';
import {
  normalizePropertyName,
} from './parse-bmark-tape-xlsx.js';

/** The minimal loan-name shape the loan axis matches against. Mirrors
 *  PoolStore.listLoanNameKeys() rows (already pool-scoped by the caller). */
export interface PoolLoanNameKey {
  readonly loanInPoolId: string;
  readonly originatorLoanRef: string | null;
  readonly propertyName: string | null;
}

/** Two independent classifier hints for one staged file. Either axis may be
 *  null (= not confident / refused). */
export interface ClassifyHints {
  /** A DOC_TYPE_TAXONOMY id (equal to the SourceDocSlot for the 7 slotted
   *  types), or null when the doc-type axis refused (0 or ≥2 pattern hits, or a
   *  tier-(c) room-only doc which has no pattern at all). */
  readonly docType: string | null;
  /** The single pool loan the filename resolved to, or null when the loan axis
   *  refused (0 or ≥2 matches). */
  readonly loanInPoolId: string | null;
}

/**
 * Retargeted loan axis: normalize the FILENAME through the SAME bridge
 * `resolveLoanForRoot` Hop-2 PASS-2 uses, compare to each pool loan's normalized
 * originatorLoanRef / propertyName, reduce to DISTINCT loanInPoolId, and refuse
 * unless exactly one distinct loan matches.
 */
export function classifyLoanFromFilename(
  fileName: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
): string | null {
  // Filename → bare property core (strips extension + slot hints + NNN- prefix +
  // manual-status suffixes) → the pool keyspace normalizer. Two-step so the
  // filename gets the stripping it needs while the pool-side comparison stays
  // byte-identical to resolveLoanForRoot's (both sides through normalizePropertyName).
  const core = normalizeForMatch(fileName);
  const targetKey = normalizePropertyName(core);
  if (targetKey === null) return null; // name-less filename → refuse.

  const distinct = new Set<string>();
  for (const loan of poolLoans) {
    const originatorKey = normalizePropertyName(loan.originatorLoanRef);
    const propertyKey = normalizePropertyName(loan.propertyName);
    if (originatorKey === targetKey || propertyKey === targetKey) {
      distinct.add(loan.loanInPoolId);
    }
  }

  // Refuse-when-≠1: exactly one distinct loan, else null.
  if (distinct.size === 1) return [...distinct][0]!;
  return null;
}

/**
 * Run BOTH axes over one staged filename against the target pool's loans.
 * `poolLoans` MUST already be scoped to the target pool by the caller.
 */
export function classifyStagedFile(
  fileName: string,
  poolLoans: ReadonlyArray<PoolLoanNameKey>,
): ClassifyHints {
  // Doc-type axis: inferSlotFromFilename returns a SourceDocSlot which, for the
  // 7 slotted types, IS the taxonomy id 1:1 (cf is a single composite id). Cast
  // to the taxonomy-id string the store expects.
  const slot = inferSlotFromFilename(fileName);
  return {
    docType: slot === null ? null : (slot as string),
    loanInPoolId: classifyLoanFromFilename(fileName, poolLoans),
  };
}

// ---------------------------------------------------------------------------
// 2b — verdictFor (pure truth-table)
// ---------------------------------------------------------------------------

export interface Verdict {
  readonly action: 'auto' | 'confirm';
  /** Whatever WAS confident, so a confirm-needed file opens pre-filled on the
   *  confident axis. For `auto`, both are present. */
  readonly prefill: {
    readonly docType?: string;
    readonly loanInPoolId?: string;
  };
}

/**
 * THE truth table (the crux). Auto-route ONLY when BOTH axes are non-null.
 * Every other cell → confirm, pre-filled with whatever's non-null. Pure.
 *
 * | docType | loan    | action  | prefill            |
 * |---------|---------|---------|--------------------|
 * | set     | set     | auto    | {docType, loan}    |
 * | set     | null    | confirm | {docType}          |
 * | null    | set     | confirm | {loan}             |
 * | null    | null    | confirm | {}                 |
 *
 * Tier-(c) docs can never have a non-null docType (no pattern) → they land at
 * best in row 3 (confirm, loan pre-filled) and NEVER auto-file. Structural.
 */
export function verdictFor(
  docType: string | null,
  loanInPoolId: string | null,
): Verdict {
  const prefill: { docType?: string; loanInPoolId?: string } = {};
  if (docType !== null) prefill.docType = docType;
  if (loanInPoolId !== null) prefill.loanInPoolId = loanInPoolId;

  const action: Verdict['action'] =
    docType !== null && loanInPoolId !== null ? 'auto' : 'confirm';

  return { action, prefill };
}

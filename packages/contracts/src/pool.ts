/**
 * Pool layer — types only (PR 1, post-recon).
 *
 * The deal-as-collection-of-loans surface. A pool is a workspace container holding
 * an ordered sequence of dated tapes; each tape is a FULL membership snapshot of the
 * loans on that round; loans carry stable identity across tapes; departures are
 * recorded as buyer-authoritative dispositions.
 *
 * Layer boundary (locked):
 *   - This layer OWNS: pool identity, tape versioning, loan-in-pool membership,
 *     on-tape buyer status, dispositions, override audit.
 *   - This layer DELEGATES: every per-loan underwriting concern (extraction,
 *     judgment, mitigation, narrative, criteria, memo) to the existing single-deal
 *     engine surface via `LoanInPool.dealRef`. No engine file is modified by the
 *     pool layer; no engine record is read by these types.
 *
 * Carry-over model (locked): Tape = FULL membership snapshot. Departures are derived
 * as the set difference between consecutive frozen tapes. The originator sends a
 * full tape on each round (CMBS wire reality); the data model matches the wire shape
 * so ingestion is reconciliation, not translation.
 *
 * Identity discipline (locked, mirrors the Overlay pattern):
 *   - PoolId, LoanInPoolId, WorkingTapeId = uuid v4 (mutable workspace identities).
 *   - TapeId, DispositionId            = content-hash RecordId (immutable records).
 *
 * Kick naming (locked): the existing `Kick` entity in `./kick.ts` (the historical
 * rejection corpus / institutional memory) is UNTOUCHED. The pool layer's "kicked"
 * state is a string VALUE on `DispositionKind`, not an entity. Eventually a
 * connector will feed `Disposition[buyerLabel='kicked']` rows into the historical
 * `Kick` corpus when the pool closes; that connector is deferred to a later PR and
 * intentionally not modeled here.
 *
 * Reconciliation safety (HARD requirement from PR brief §5): carry-over depends on
 * matching incoming originator loan refs to existing LoanInPool rows. The types
 * MUST support representing an unmatched/pending row WITHOUT silently auto-binding.
 * See `PendingMembershipEntry` and `WorkingTape` below.
 *
 * This module is TYPES ONLY. No storage. No endpoints. No producers. Wiring lands
 * in subsequent PRs.
 */

import type { AssetType } from './asset.js';
import type {
  DispositionId,
  LoanInPoolId,
  PoolId,
  TapeId,
  WorkingTapeId,
} from './identity.js';
import type { ISODateTime } from './versioning.js';

/* -------------------------------------------------------------------------- */
/* §1. On-tape buyer-side state                                               */
/* -------------------------------------------------------------------------- */

/**
 * Per-loan status on a specific tape, BUYER-SIDE. The buyer's judgment on whether
 * this loan clears on this round. Originator-side labels live ONLY on
 * `Disposition.originatorLabel` and `TapeOriginatorSummary` — they never overwrite
 * buyer state. This separation is the buyer-authoritative rule made structural.
 *
 *   'under-review'  — present on this tape; buyer has not decisioned yet.
 *   'clean'         — buyer cleared the loan (no findings).
 *   'conditioned'   — buyer accepts subject to conditions (accept-flag-call).
 *   'kick-flagged'  — buyer is signaling intent-to-kick on this tape; the actual
 *                     disposition is recorded when the loan leaves the tape (next round).
 */
export const ON_TAPE_STATUSES = [
  'under-review',
  'clean',
  'conditioned',
  'kick-flagged',
] as const;
export type OnTapeStatus = (typeof ON_TAPE_STATUSES)[number];

/**
 * A buyer-side condition attached to an accept-flag-call. Free-form by design at
 * PR 1 (no condition catalog yet). Future PRs may tighten the shape; this PR's job
 * is to ensure the LoanMembership shape can carry conditions without forcing the
 * later catalog choice.
 */
export interface ConditionRef {
  readonly label: string;
  readonly note: string | null;
}

/* -------------------------------------------------------------------------- */
/* §2. Bound membership row — what lives on a FROZEN tape                     */
/* -------------------------------------------------------------------------- */

/**
 * A single bound loan on a sealed tape. Every entry on a frozen `Tape` is a
 * `LoanMembership` — all references to a `LoanInPool` are resolved by construction.
 * No pending / unmatched state can exist on a frozen tape.
 *
 * `dealRef` is the binding to the existing engine surface. Clients resolve per-loan
 * underwriting via the existing `GET /api/analyses/:id` (or equivalent) using
 * `dealRef`; this layer never reads engine internals.
 */
export interface LoanMembership {
  readonly loanInPoolId: LoanInPoolId;
  readonly dealRef: string;
  readonly status: OnTapeStatus;
  readonly conditions: readonly ConditionRef[];
  readonly notes: string | null;
  /** Stable display order on this tape. Originator-supplied; observability only. */
  readonly tapePosition: number;

  /* ── Reseed PR — denormalized per-tape display fields (ALL OPTIONAL) ──
   *
   * These fields ride alongside `LoanInPool`'s stable identity-time copy
   * (set on first appearance) and capture the value AS OF THIS TAPE. Audit-
   * faithful: a property's name or balance can drift across tapes (e.g. a
   * restructure that paydown the balance, a portfolio renamed mid-lineage),
   * and each tape's snapshot preserves what it actually said.
   *
   * Optional + nullable so existing synthetic fixtures and tests pass
   * through unchanged; consumers fall back to `dealRef` when null.
   *
   *   propertyName:        denormalized copy of LoanInPool.propertyName as-of-tape
   *   cutOffBalance:       per-tape securitization balance, dollars (can change)
   *   propertyType:        raw type label (display); LoanInPool.assetType is the typed form
   *   mortgageLoanSeller:  bank code, e.g. "GSMC", "CREFI", or co-seller "GSMC, BMO"
   *   city / state:        location display
   */
  readonly propertyName?:       string | null;
  readonly cutOffBalance?:      number | null;
  readonly propertyType?:       string | null;
  readonly mortgageLoanSeller?: string | null;
  readonly city?:               string | null;
  readonly state?:              string | null;
}

/* -------------------------------------------------------------------------- */
/* §3. Pending membership row — exists ONLY on a working (unfrozen) tape      */
/* -------------------------------------------------------------------------- */

/**
 * Pending-binding row. Exists ONLY during ingestion of a working tape; CANNOT
 * appear on a frozen `Tape`. Discriminated union forces every advance-tape
 * implementation to handle the three states explicitly — there is no silent
 * fallthrough to "auto-create a new LoanInPool" or "auto-bind to a guess."
 *
 *   'bound'                     — the incoming originator row matched an existing
 *                                 LoanInPool (or is a confirmed new loan with a
 *                                 minted LoanInPoolId). Ready to freeze.
 *   'unmatched-needs-confirm'   — the incoming row's `incomingOriginatorRef` does
 *                                 not deterministically map to any existing
 *                                 LoanInPool. `candidateLoanInPoolIds` carries any
 *                                 fuzzy-match hints. The advance-tape operation
 *                                 MUST NOT freeze the tape until a human resolves
 *                                 this row to either 'bound' (existing) or
 *                                 'new-loan-confirmed'.
 *   'new-loan-confirmed'        — confirmed new to the pool. A `LoanInPool` will be
 *                                 minted on freeze; the eventual `loanInPoolId` is
 *                                 not yet stamped on this entry because it is
 *                                 produced atomically with the freeze transaction.
 *
 * The frozen-tape invariant (encoded structurally): `Tape.membership` is
 * `readonly LoanMembership[]`, never `PendingMembershipEntry[]`. The advance-tape
 * operation must resolve every entry to `LoanMembership` before producing the
 * frozen `TapeId`.
 */
export type PendingMembershipEntry =
  | {
      readonly kind: 'bound';
      readonly binding: LoanMembership;
      /** Originator-supplied identifier on this incoming tape; retained for audit. */
      readonly incomingOriginatorRef: string | null;
      /** Tape-derived property count (Properties-per-Loan ∪ decimal-breakout count).
       *  Carried on the WORKING-tape entry (never hashed / never on the frozen Tape) so
       *  Phase B can derive deal_mode from the tape without re-passing IncomingTape. */
      readonly propertyCount?: number | null;
    }
  | {
      readonly kind: 'unmatched-needs-confirm';
      /** Incoming originator id that didn't deterministically resolve. May be null
       *  if the originator's tape lacks a stable per-loan ref on this round. */
      readonly incomingOriginatorRef: string | null;
      /** Engine-surface handle from the incoming originator row. Carried on the
       *  pending entry so a later 'confirm-new' resolution can mint a LoanInPool
       *  with this dealRef without re-passing the original IncomingTape input. */
      readonly dealRef: string;
      /** Suggested existing LoanInPool candidates (fuzzy match hints). Empty array
       *  means no candidates — likely a new loan, but the operation must confirm. */
      readonly candidateLoanInPoolIds: readonly LoanInPoolId[];
      readonly tapePosition: number;
      /* Reseed PR — denormalized per-tape display fields carried from the
       * incoming row so a later confirm-new resolution lands the fields on
       * the LoanMembership without re-passing IncomingTape. All optional. */
      readonly propertyName?:       string | null;
      readonly cutOffBalance?:      number | null;
      readonly propertyType?:       string | null;
      readonly mortgageLoanSeller?: string | null;
      readonly city?:               string | null;
      readonly state?:              string | null;
      /** Tape-derived property count — carried so a later confirm-new mint derives
       *  deal_mode from the tape. Working-tape only (never hashed / never on Tape). */
      readonly propertyCount?:      number | null;
    }
  | {
      readonly kind: 'new-loan-confirmed';
      readonly incomingOriginatorRef: string | null;
      readonly dealRef: string;
      readonly status: OnTapeStatus;
      readonly conditions: readonly ConditionRef[];
      readonly notes: string | null;
      readonly tapePosition: number;
    };

/* -------------------------------------------------------------------------- */
/* §4. Originator-side wire summary — for audit, not buyer state              */
/* -------------------------------------------------------------------------- */

/**
 * Counts and labels the originator's own tape carried. Recorded for audit and to
 * enable derivation of override divergences against `Disposition.buyerLabel`. NEVER
 * read by per-loan buyer state — buyer state lives on `LoanMembership.status`.
 */
export interface TapeOriginatorSummary {
  readonly originatorLoanCount: number;
  readonly originatorDroppedRefs: readonly string[];
  readonly originatorKickedRefs: readonly string[];
  /** Free-form provenance ("BMARK 2026-V12 / Round 3 / 2026-02-10 .csv"). */
  readonly sourceLabel: string | null;
}

/* -------------------------------------------------------------------------- */
/* §5. The Tape pair — WorkingTape (mutable) and Tape (frozen)                */
/* -------------------------------------------------------------------------- */

/**
 * Mutable tape during ingest and buyer review. Identity is a uuid (`WorkingTapeId`)
 * because the body shape changes between save and freeze. On freeze, every
 * `PendingMembershipEntry` must be resolved to a `LoanMembership`, and the result
 * is hashed to produce a content-addressed `TapeId`. This mirrors the
 * `OverlayId` (mutable container) → `OverlayPatchId` (immutable record) pattern.
 */
export interface WorkingTape {
  readonly id: WorkingTapeId;
  readonly poolId: PoolId;
  readonly version: number;
  readonly tapeDate: ISODateTime;
  readonly receivedAt: ISODateTime;
  readonly priorTapeId: TapeId | null;
  readonly pendingMembership: readonly PendingMembershipEntry[];
  readonly originatorSummary: TapeOriginatorSummary | null;
}

/**
 * Frozen tape — immutable, content-addressed. `TapeId` is the SHA-256 of the
 * JCS-canonical body. By type, `membership` carries only `LoanMembership` (all
 * bindings resolved). The freeze operation (later PR) is responsible for
 * upholding this invariant.
 */
export interface Tape {
  readonly id: TapeId;
  readonly poolId: PoolId;
  readonly version: number;
  readonly tapeDate: ISODateTime;
  readonly receivedAt: ISODateTime;
  readonly frozenAt: ISODateTime;
  readonly priorTapeId: TapeId | null;
  readonly membership: readonly LoanMembership[];
  readonly originatorSummary: TapeOriginatorSummary | null;
}

/* -------------------------------------------------------------------------- */
/* §6. LoanInPool — the carry-across-tapes identity                           */
/* -------------------------------------------------------------------------- */

/**
 * A loan's stable identity within a pool. Set once on first appearance; survives
 * tape rounds unchanged. Carrying this identity forward is what makes
 * "this loan has been with us since v1" UX work in the pool rail.
 *
 * `dealRef` is the bridge to the engine — the single-deal underwriting lineage
 * for this loan. The engine's revision-lineage operates entirely under `dealRef`;
 * pool-membership lineage operates entirely under `LoanInPoolId`. Two axes,
 * orthogonal, both immutable on their own terms.
 *
 * `originatorLoanRef` is the originator's own loan id (e.g. BMARK loan #). String
 * because the originator's id space is not our brand; `| null` because re-keys and
 * partial wires happen — the reconciliation seam in §3 covers the
 * unmatched-needs-confirmation case.
 */
export interface LoanInPool {
  readonly id: LoanInPoolId;
  readonly poolId: PoolId;
  readonly dealRef: string;
  readonly addedOnTape: TapeId;
  readonly originatorLoanRef: string | null;
  readonly propertyName: string | null;
  readonly assetType: AssetType | null;
  /** Null while the loan is still active in the pool; set when departed. */
  readonly currentDispositionId: DispositionId | null;
  /**
   * Pool-lifecycle positive terminal (§6b). `null`/absent = no terminal reached
   * (the default for every existing row — the backing column is a nullable ALTER
   * with no backfill). `'closed'` = the loan cleared and closed; it STAYS in the
   * pool and goes onto the final tape. Orthogonal to `OnTapeStatus` (membership /
   * per-tape review) and mutually exclusive with `currentDispositionId` (the
   * departure). Optional in the type so pre-existing records and fixtures read
   * back cleanly as `undefined`/`null`.
   */
  readonly lifecycleStatus?: LoanLifecycleStatus | null;
}

/* -------------------------------------------------------------------------- */
/* §6b. LoanLifecycleStatus — pool-lifecycle positive terminal                */
/* -------------------------------------------------------------------------- */

/**
 * Per-loan POSITIVE TERMINAL in the pool lifecycle. Orthogonal to both
 * `OnTapeStatus` (per-tape buyer review, on `LoanMembership`) and the
 * `Disposition` (departure — the loan LEAVES). A Closed loan STAYS in the pool
 * and goes onto the final tape.
 *
 * SINGLE value — `'closed'`. There is deliberately no `'funded'`: no producer
 * models a distinct fund event, and inventing one implies a funding-confirmation
 * write path that does not exist (same discipline as never minting a state
 * without a source). `null` (the default, absent column value) means "no
 * positive terminal reached yet." Extending to a second value later is purely
 * additive (append to the tuple).
 *
 * Legality (enforced in the write path, NOT structurally in this type):
 *   - `→ closed` is legal ONLY IF the server re-derives Cleared = true AND the
 *     loan has no disposition (`currentDispositionId == null`).
 *   - `closed` is terminal + idempotent (re-close is a no-op, not an error).
 *   - Symmetric mutual exclusion with the disposition: a disposed loan cannot
 *     close; a closed loan blocks a later disposition. A loan is
 *     Closed XOR departed XOR still-on-tape.
 */
export const LOAN_LIFECYCLE_STATUSES = ['closed'] as const;
export type LoanLifecycleStatus = (typeof LOAN_LIFECYCLE_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* §7. Disposition — buyer-authoritative departure record                     */
/* -------------------------------------------------------------------------- */

export const DISPOSITION_KINDS = ['dropped', 'kicked'] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/**
 * OPTIONAL refinement of the authoritative disposition outcome. Each category
 * belongs to exactly ONE parent `DispositionKind` (the `authoritative`/`buyerLabel`):
 *
 *   - `kicked`  ← `disqualifying` | `couldnt_structure`
 *   - `dropped` ← `expired`       | `withdrawn`
 *
 * This is a display/reporting refinement, NOT part of the mechanical outcome and
 * NOT part of the `DispositionId` hash boundary. See `Disposition.reasonCategory`.
 */
export const REASON_CATEGORIES = [
  'disqualifying',
  'couldnt_structure',
  'expired',
  'withdrawn',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

/**
 * Which parent `DispositionKind` each `ReasonCategory` is valid under. The write
 * path rejects any `(reasonCategory, outcome)` pair not in this map. Declared here
 * (contract layer) so producer + reader agree on the refinement taxonomy.
 */
export const REASON_CATEGORY_OUTCOME: Readonly<Record<ReasonCategory, DispositionKind>> = {
  disqualifying:     'kicked',
  couldnt_structure: 'kicked',
  expired:           'dropped',
  withdrawn:         'dropped',
} as const;

/**
 * A `reasonCategory` is valid iff it refines its parent authoritative outcome.
 * `null`/`undefined` is always valid (the field is optional). Pure, no side effects
 * — mirror in the write path to reject a mismatched pair before persistence.
 */
export function isReasonCategoryValidForOutcome(
  category: ReasonCategory | null | undefined,
  outcome: DispositionKind,
): boolean {
  if (category === null || category === undefined) return true;
  return REASON_CATEGORY_OUTCOME[category] === outcome;
}

/**
 * Append-only departure record. One per loan-leaving-the-pool event. Corrections
 * to a recorded disposition do not mutate the record; they produce a NEW record
 * with `supersedes` pointing at the prior id (chain-link pattern, same as
 * `CommitteeAction`).
 *
 * Integrity rules (encoded as invariants the producer MUST uphold):
 *   - `authoritative === buyerLabel` (always — by definition).
 *   - `override === (originatorLabel !== buyerLabel)`.
 *   - `lastSeenOnTape.version + 1 === leftOnTape.version` (departure is a
 *     consecutive-tape event).
 *
 * Audit chain: every `Disposition` records `recordedAt` (wall-clock, observability
 * only — NOT in any identity hash) and `recordedBy`. The content-hash boundary
 * for `DispositionId` is the canonical body MINUS `recordedAt` (same discipline
 * as `RevisionLineageEnvelope`: timestamps never participate in identity).
 */
export interface Disposition {
  readonly id: DispositionId;
  readonly poolId: PoolId;
  readonly loanInPoolId: LoanInPoolId;
  readonly lastSeenOnTape: TapeId;
  readonly leftOnTape: TapeId;

  readonly originatorLabel: DispositionKind;
  readonly buyerLabel: DispositionKind;
  /** Convenience: always === buyerLabel. Stored to spare callers a re-derivation. */
  readonly authoritative: DispositionKind;
  /** Convenience: always === (originatorLabel !== buyerLabel). */
  readonly override: boolean;

  readonly reasons: readonly string[];
  readonly recordedBy: ActorRef;
  /** Observability only — NOT part of DispositionId hash boundary. */
  readonly recordedAt: ISODateTime;
  /**
   * OPTIONAL refinement of the authoritative outcome (see `ReasonCategory`).
   * When present it MUST satisfy `isReasonCategoryValidForOutcome(reasonCategory,
   * authoritative)`. Body field only — like `recordedAt`, it is NOT part of the
   * `DispositionId` hash boundary (absent from `DispositionIdHashInput` and
   * `makeDispositionIdHashInput`), so setting it never changes an id. Existing
   * records that predate this field read back as `undefined`.
   */
  readonly reasonCategory?: ReasonCategory | null;
  /** Append-only correction chain. Null for the first disposition on this loan. */
  readonly supersedes: DispositionId | null;
}

/**
 * Who recorded an action. PR-1 placeholder — uses the same lightweight shape the
 * codebase uses elsewhere for `author` strings. Promoted to a richer Actor record
 * if/when the codebase grows one.
 */
export interface ActorRef {
  readonly userId: string;
  readonly displayName: string | null;
}

/* -------------------------------------------------------------------------- */
/* §8. Pool — the top-level workspace container                               */
/* -------------------------------------------------------------------------- */

/**
 * A pool is the workspace handle for a deal-as-collection-of-loans. `tapeIds` is
 * ordered append-only (round 1 → round N). `currentTapeId` is always either the
 * latest frozen tape or null (no tapes yet). `closedAt` retires the pool — no
 * further tapes can be advanced.
 *
 * The shelf label ("BMARK 2026-V12") is human-meaningful and DISPLAYED, but is not
 * an identity hash — pools persist across re-runs, re-labels, and re-organizations
 * of the same underlying analysis stream.
 */
export interface Pool {
  readonly id: PoolId;
  readonly shelfName: string;
  readonly vintage: number;
  readonly seller: string | null;
  readonly createdAt: ISODateTime;
  readonly tapeIds: readonly TapeId[];
  readonly currentTapeId: TapeId | null;
  readonly closedAt: ISODateTime | null;
}

/* -------------------------------------------------------------------------- */
/* §8b. Content-hash boundaries — TapeIdHashInput, DispositionIdHashInput     */
/* -------------------------------------------------------------------------- */

/**
 * The exact, exhaustive set of fields that participate in `TapeId` computation.
 * Mirrors the `RevisionIdHashInput` discipline (see `./revision-lineage.ts` §5):
 * two independent implementations MUST produce byte-identical `TapeId` values when
 * fed byte-identical `TapeIdHashInput`.
 *
 * **Excluded by P7** (must NEVER appear in a TapeId hash input):
 *   - `frozenAt`     — buyer wall-clock at freeze; observability only.
 *   - `receivedAt`   — buyer wall-clock at ingestion; observability only.
 *
 * **Included** (this interface): the set of fields that semantically define
 * "what this tape IS." Two tapes with byte-identical hash inputs MUST produce
 * the same `TapeId`, so freezing the same content twice at different wall-clock
 * times is idempotent. This is the whole point of P7 — replay determinism.
 */
export interface TapeIdHashInput {
  readonly poolId: PoolId;
  readonly version: number;
  readonly tapeDate: ISODateTime;
  readonly priorTapeId: TapeId | null;
  readonly membership: readonly LoanMembership[];
  readonly originatorSummary: TapeOriginatorSummary | null;
}

/**
 * The exact, exhaustive set of fields that participate in `DispositionId`
 * computation. Same discipline as `TapeIdHashInput`.
 *
 * **Excluded by P7**:
 *   - `recordedAt`   — buyer wall-clock when the disposition was entered.
 *
 * **Included**: every field that defines the disposition decision itself —
 * which loan, which tapes, what labels, the override flag, reasons, who
 * recorded it, and the supersede chain. Re-recording byte-identical decision
 * content yields the same `DispositionId`.
 */
export interface DispositionIdHashInput {
  readonly poolId: PoolId;
  readonly loanInPoolId: LoanInPoolId;
  readonly lastSeenOnTape: TapeId;
  readonly leftOnTape: TapeId;
  readonly originatorLabel: DispositionKind;
  readonly buyerLabel: DispositionKind;
  readonly authoritative: DispositionKind;
  readonly override: boolean;
  readonly reasons: readonly string[];
  readonly recordedBy: ActorRef;
  readonly supersedes: DispositionId | null;
}

/* -------------------------------------------------------------------------- */
/* §9. Invariants — declarative form (mirrors LINEAGE_INVARIANTS)             */
/* -------------------------------------------------------------------------- */

/**
 * Pool-layer invariants. Declarative so a later CI invariant check can iterate.
 * Numbering uses the P-prefix to avoid collision with the L-prefixed
 * revision-lineage invariants in `./revision-lineage.ts`.
 */
export const POOL_INVARIANTS = [
  'P1: tape membership is a FULL snapshot — departures are derived as set difference',
  'P2: LoanInPoolId is stable across tapes — never re-issued for the same loan',
  'P3: a frozen Tape.membership contains ONLY LoanMembership; no PendingMembershipEntry',
  'P4: Disposition.authoritative === Disposition.buyerLabel (always)',
  'P5: Disposition.override === (originatorLabel !== buyerLabel)',
  'P6: pool layer never mutates engine records; binding is via LoanInPool.dealRef only',
  'P7: timestamps never participate in TapeId or DispositionId hash boundaries',
] as const;
export type PoolInvariantId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

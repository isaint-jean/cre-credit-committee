# Revision Lineage Spec (Canonical)

> **Status:** Locked 2026-05-08 (pre-Batch-6.3).
> **Companion contract module:** `packages/contracts/src/revision-lineage.ts`
> **Source of truth for sub-batch 6.3:** every route handler, store implementation, and replay tool MUST conform to this document. Where this document conflicts with route-level conventions, this document wins.

This is **contract definition**, not implementation guidance. Implementation lands in sub-batch 6.3 (`POST /analyses/:id/revisions` + record-graph store wiring + dispatch).

---

## §1. Core identities

| Type | Definition | Mutability |
|---|---|---|
| `AnalysisId` | The canonical analysis identity. Equal to the root revision's `RevisionId`. | Immutable, never changes after creation. |
| `RevisionId` | Immutable identity for a single revision in an analysis lineage. SHA-256 over canonical-JSON of `RevisionIdHashInput`. | Immutable, never reused. |
| `LineageRootId` | Always equals the original `AnalysisId`. Carried by every revision in the lineage. | Immutable across the lineage (invariant L3). |
| `ParentRevisionId` | `RevisionId | null`. `null` ONLY for the root revision. | Single-parent pointer (§6). Never mutates after creation (L2). |

**Type-level relationship:** `AnalysisId = RevisionId`, `LineageRootId = AnalysisId` (semantic aliases over a single brand). Every analysis IS its root revision.

---

## §2. Revision semantics

A **Revision** is:

- An immutable node in an analysis lineage.
- Created ONLY by applying a deterministic delta to `AdjustedInputs`.
- Producing a new analysis state (a new `DoctrineEvaluation`) with a new `RevisionId`.

A **Revision** is **NOT**:

- A patch.
- An update.
- A mutation.
- An overwrite.
- A partial modification.

This distinction is enforced in:

1. **Types** — `RevisionLineageEnvelope` is `readonly` throughout; no mutator methods exist.
2. **Routes** — `POST /analyses/:id/revisions` creates new revisions; `PATCH` semantics are forbidden on record-bearing endpoints (architecture doctrine D4).
3. **Storage** — record-graph store inserts are append-only; rows are content-addressed by `revisionId`, never updated in place.

---

## §3. Lineage invariants (non-negotiable)

| ID | Invariant |
|---|---|
| **L1** | Append-only lineage graph. Once a `RevisionLineageEnvelope` is persisted, it is never modified. |
| **L2** | `parentRevisionId` never mutates after creation. |
| **L3** | `lineageRootId` never changes — every revision in a lineage carries the same root id. |
| **L4** | Identical `(parentRevisionId, AdjustedInputs delta, doctrineVersion)` → MUST produce identical `revisionId`. |
| **L5** | No timestamps participate in identity computation. (Wall-clock time is non-deterministic; `analysisAsOfDate` is a stamped input but does not enter the `RevisionIdHashInput`.) |
| **L6** | Ordering of non-semantic inputs MUST NOT affect identity. (JCS canonicalization enforces lexicographic key order; iteration-order leaks are forbidden upstream of the hash function.) |

These are reproduced in code as `LINEAGE_INVARIANTS` in `packages/contracts/src/revision-lineage.ts`.

---

## §4. Replay provenance model (observability only)

**Hard rule:** Provenance is OBSERVABLE ONLY. Provenance MUST NEVER participate in identity hash generation. Two revisions with different provenance but identical `RevisionIdHashInput` MUST produce the same `revisionId`.

```
RevisionProvenance = {
  revisionId,            // FK to envelope (not in hash)
  inputDiff,             // structured semantic diff of AdjustedInputs
  triggerSource,         // closed enum: USER_EDIT | STRESS_ENGINE | DOCTRINE_ADJUSTMENT | SYSTEM_RECALC
  appliedRuleIds[],      // judgment-engine rules that fired
  adjustmentOrigin[],    // free-text origins (display only, not parsed)
  beforeHash,            // AdjustedInputsId of the parent
  afterHash,             // AdjustedInputsId of this revision
}
```

**Storage shape:** Provenance lives as a SIBLING record to `RevisionLineageEnvelope`, keyed by `revisionId`. Two distinct tables in the record-graph store:

| Table | Identity | Content-hashed? | Mutability |
|---|---|---|---|
| `revision_lineage_envelopes` | `revisionId` (= hash of `RevisionIdHashInput`) | Yes — id IS the hash. | Append-only. |
| `revision_provenance` | `revisionId` (FK to envelope) | No — keyed-by-FK only. | Append-only. |

The split is intentional: identity (envelope) is content-addressed and load-bearing for replay; provenance (sibling) is descriptive and exists only for observability.

---

## §5. Content-hash boundary specification

Two independent implementations of the `RevisionId` hash function MUST produce byte-identical output for byte-identical input. The boundary is:

### Included in `RevisionIdHashInput`

| Field | Source | Why included |
|---|---|---|
| `parentRevisionId` | Lineage chain | Anchors the revision in its lineage; differentiates branches that share the same delta. |
| `adjustedInputsId` | Content-hash of resulting `AdjustedInputs` | Encodes the delta from parent transitively (AdjustedInputs is itself content-addressed; identical resulting state → identical id). |
| `doctrineVersion` | Pinned engine identity | Re-versioned doctrine engines produce new ids for the same inputs (architecture H6). |

### Excluded from RevisionId hash — must NEVER appear

| Excluded | Why |
|---|---|
| Timestamps (any form: `createdAt`, `updatedAt`, `analysisAsOfDate`, wall-clock reads) | Non-deterministic / observability only (L5). |
| Logs, traces, diagnostics | Observability only. |
| UI-only fields (display names, labels, color hints) | Presentation, not identity. |
| Runtime flags (feature toggles, debug switches) | Environment-dependent; would break replay across environments. |
| Ordering artifacts of non-semantic inputs | Iteration-order leaks; addressed by JCS canonicalization (L6). |
| `RevisionProvenance` and any of its fields | Observability only (§4 hard rule). |
| Ephemeral evaluation outputs (in-memory caches, validation pass-throughs) | Recomputable, not identity-bearing. |
| `revisionOrdinal` | Computable by walking parent chain; stamped on envelope but not in hash. |
| `judgmentEngineVersion`, `stressEngineVersion`, `valuationEngineVersion` | Captured transitively via `adjustedInputsId` and `doctrineEvaluationId`; stamping them on the envelope is for replay-record completeness, not identity. |

**Hard requirement (§5):** Two independent implementations MUST produce identical hashes from the same `RevisionIdHashInput`. The implementation in `apps/api/src/util/content-hash.ts` (when added in 6.3) MUST follow RFC 8785 (JCS) canonicalization + SHA-256 hex-lowercase, identical to existing record-id computation.

---

## §6. Lineage topology rule

**Single-parent lineage only.**

Rules:

- Each revision has exactly one `parentRevisionId` (except the root, which has `null`).
- No DAG merges.
- No multi-parent reconciliation.

**Rationale:** Underwriting analysis is a deterministic transformation chain, not a merge system. Multi-parent semantics would introduce reconciliation policy (which side wins on a conflict?) — that is itself underwriting policy and belongs in doctrine, not in lineage. Single-parent topology keeps lineage purely structural.

If branching is needed (e.g., two analysts each edit the same parent revision), each branch is a distinct lineage chain from the shared parent. The user-facing tool surfaces both branches; the data model treats them as separate sibling chains. No merge operation exists.

---

## §7. API semantics (pre-6.3 lock)

| Route | Behavior | Locked? |
|---|---|---|
| `POST /analyses/:id/revisions` | Creates a new revision node. Body contains the delta to apply. Returns the new `RevisionLineageEnvelope` + `RevisionProvenance`. | Yes (decision D4). |
| `PATCH /analyses/:id/uw-model` | **Forbidden** on record-bearing endpoints. Either hard-removed (Option A — preferred per user decision) or internally redirected to revision creation (Option B — only as a temporary shim during cutover). | Yes (decision D4 + 6.3 directive). |
| `PATCH /analyses/:id/loan-terms` | Same as above. Forbidden / redirected. | Yes. |
| `GET /analyses/:id` | Resolves the latest revision in the lineage (highest `revisionOrdinal`) unless `revisionId` is explicitly provided. | Yes. |
| `GET /analyses/:id?revisionId=...` | Resolves the deterministic historical node specified by `revisionId`. Identical state to when it was originally produced (per L4). | Yes. |
| `GET /analyses/:id/lineage` | Returns the lineage chain (every revision, parent → leaf), with envelopes + provenance. | Recommended; finalized in 6.3. |

**Strict-dispatch interaction:** Legacy analyses (UUID v4 ids) continue to use the legacy code path during the migration window. Graph-backed analyses (content-hash ids) flow through revision-creating semantics. The dispatch happens at the route handler entry; no internal mode-flag magic.

---

## §8. CI invariant summary

A single-line enforceable rule for tagging / hooks / PR review:

> **lineage is append-only, deterministic, single-parent, content-addressed**

The CI policy for lineage-touching PRs verifies:

1. No `update` / `patch` / `mutate` operations against `revision_lineage_envelopes` rows. (Static-check via dependency-cruiser policy or grep.)
2. No new fields added to `RevisionIdHashInput` without an explicit hash-rotation plan.
3. No fields are removed from the §5 excluded list (additive-only on the exclude list).
4. `LINEAGE_INVARIANTS` constant and this document stay in sync.
5. Provenance writes never invalidate envelope ids (envelope is hashed independently of provenance).

---

## Cross-references

- **Companion contract module:** `packages/contracts/src/revision-lineage.ts` — types + invariant constants.
- **Architecture doctrine:** `docs/architecture/batch6-record-graph-and-resolution.md` rev 2 — decisions D4 (revisions, not patches) and D5 (content-hash identity).
- **Implementation plan:** `docs/batch6-implementation-plan.md` — sub-batch 6.3 scope and DoD.
- **Audit-grounded:** Audit 5 (R9 / R10 routes requiring revision semantics) and the user's pre-6.3 directive (this spec).

*Locked 2026-05-08. Subsequent revisions append below with a dated change log.*

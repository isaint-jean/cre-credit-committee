# Batch 6 Audit 1 — Resolver Hidden UW Logic

**Date:** 2026-05-08
**Target:** `apps/api/src/services/resolve-underwriting-context.ts` (+ helpers)
**Goal:** Catalogue every conditional / fallback / coercion / branch in the legacy resolver and classify it as PURE_SHAPE, UNDERWRITING_LOGIC, or UNCLEAR. The classification determines what must be lifted upstream before the new Batch 6 resolver replaces this module.
**Doctrine reference:** `docs/architecture/batch6-record-graph-and-resolution.md` §3 (Stage 12 — Resolver), especially §3.2 R3 (expanded "no UW logic" definition).

## Scope note on helpers

The resolver imports **only** `node:fs`, `node:url`, and types from `@cre/shared` (lines 58–69). It has **no helper modules** under `apps/api/src/services/` to audit — by deliberate design the import graph is enforced shape-only by CHECK #2 (`assertImportGraphPure`, lines 226–269), which throws if any non-allowed import is present at module load.

Therefore this audit covers exclusively `apps/api/src/services/resolve-underwriting-context.ts`.

## Summary

| Classification | Count |
|---|---|
| PURE_SHAPE | 14 |
| UNDERWRITING_LOGIC | 0 |
| UNCLEAR | 4 |

## Findings

### F1 — `sentinelDefault`: null → `DATA_NOT_PROVIDED` sentinel
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:121-123`
- **Code excerpt:**
  ```ts
  sentinelDefault(v: NarrativeValue): ResolvedCellValue {
    return v ?? DATA_NOT_PROVIDED;
  },
  ```
- **Pattern:** `??` nullish-coalescing on a narrative (string-typed) value.
- **Classification:** PURE_SHAPE
- **Rationale:** R4 ("Null fidelity") forbids the resolver from converting null to a numeric default. R3 expressly forbids `noi ?? 0`. Here, the operand is a `NarrativeValue` (`string | MissingDataSentinel | null`) — a label, not a number. The doctrine explicitly assigns sentinel-display ("—", "N/A", "Insufficient data") to the render layer (R4), but the project's own architectural memo `architecture_render_four_axis.md` and the header comment of this file (lines 4–8) state that sentinel application happens here, *not* the schema layer, and that sentinels are confined to *narrative* cells. This op only operates on `NarrativeValue` — it cannot mask a numeric degraded state.
- **Notes:** The doctrine §3.2 R4 says "Sentinel display … is the render layer's job, not the resolver's." This is a tension between the new doctrine and the legacy in-code comment. Under strict R4, this would move to render. But because narrative sentinels are *string-typed*, they never collide with the "null coercion on a numeric" prohibition (which is the actual UW-logic risk R3 cares about). Marking PURE_SHAPE on the strength of: (a) operand is string-domain, (b) project memory `architecture_render_four_axis.md` explicitly locates this transform here. The new resolver may still choose to push it to render for R4 strict-fidelity.

### F2 — `joinList`: empty/null → sentinel; otherwise newline-join with per-item null backfill
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:124-127`
- **Code excerpt:**
  ```ts
  joinList(items: NarrativeValue[] | null | undefined, sep = '\n'): ResolvedCellValue {
    if (!items || items.length === 0) return DATA_NOT_PROVIDED;
    return items.map((x) => x ?? DATA_NOT_PROVIDED).join(sep);
  },
  ```
- **Pattern:** Truthy guard + `length === 0` check + per-element `??` backfill + array-join.
- **Classification:** PURE_SHAPE
- **Rationale:** The transform is a deterministic structural projection from `NarrativeValue[] | null | undefined` to a single string. It doesn't sort by severity, doesn't filter, doesn't re-rank. R3's forbidden "Semantic sorting" and "Implicit aggregation" both refer to *meaning-bearing* operations on numeric or judgment data; joining a list of strengths/weaknesses/mitigants strings into one display cell is shape-only — the producer decided what the items are and in what order.
- **Notes:** Same R4 caveat as F1 (sentinel display arguably belongs in render). The "empty list → DATA_NOT_PROVIDED" choice is *display*, not *underwriting* — an empty `weaknesses[]` is a legitimate producer output, and the cell must still render something. If the new resolver hews strictly to R4, this becomes a render-layer responsibility; the producer-side semantics (empty array vs null) remain unchanged.

### F3 — `joinListAllowEmpty`: empty/null → empty string (NOT sentinel)
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:128-131`
- **Code excerpt:**
  ```ts
  joinListAllowEmpty(items: string[] | null | undefined, sep = ', '): ResolvedCellValue {
    if (!items || items.length === 0) return '';
    return items.join(sep);
  },
  ```
- **Pattern:** Truthy guard + length check + array-join with explicit empty-string fallback (NOT sentinel).
- **Classification:** PURE_SHAPE
- **Rationale:** This op carries an explicit project decision (header comment lines 99–103): the v7 `comparablesLinkageRefs` cell renders blank when the producer found no comps, instead of carrying the `DATA_NOT_PROVIDED` sentinel. That is a display-policy choice, deterministic and structural — there's no asset-class branching, no numeric coercion, no aggregation.
- **Notes:** The empty-string-vs-sentinel distinction is the kind of thing R4 says lives in render. The new resolver could keep the contract by passing the array through and letting the render-output-scrubber decide presentation. Worth flagging but not UW logic.

### F4 — `rollUpFlatten`: mode and data-presence branching to a blank skeleton
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:132-152`
- **Code excerpt:**
  ```ts
  rollUpFlatten(r, mode) {
    const blank = { loanCount: DATA_NOT_PROVIDED, aggregationMethodology: DATA_NOT_PROVIDED, ... };
    if (mode !== 'roll_up') return blank;
    if (!r) return blank;
    return { loanCount: r.loanCount, aggregationMethodology: r.aggregationMethodology ?? DATA_NOT_PROVIDED, ... };
  }
  ```
- **Pattern:** Mode-projection branch + null-bundle short-circuit + per-field `??` sentinel backfill + array → CSV string via `.join(',')`.
- **Classification:** PURE_SHAPE
- **Rationale:** This is the canonical "mode-projection" allowed by R3's allowed-transform list ("`mode === 'UW' ? lineItem.uw : ...`"). The mode branch chooses a *projection* (blank skeleton vs the populated record) rather than picking a different record or computing different numbers. `r.loanCount` is read verbatim; nothing is summed or recomputed.
- **Notes:** The CSV join `r.constituentLoanIds.join(',')` is a deterministic structural transform on producer-ordered ids — no semantic sort. The `length === 0 → sentinel` (line 148–150) is the same display-policy pattern as F1/F2. Two sub-concerns flagged in F12 and F13 below.

### F5 — `assertAllowedOpsLocked` boot-time guard
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:157-173`
- **Code excerpt:**
  ```ts
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw new ResolverIntegrityError('RESOLVER_OPS_MISMATCH', ...);
  }
  if (!Object.isFrozen(ALLOWED_OPS)) { throw ... }
  ```
- **Pattern:** Boot-time identity assertions; pure structural (sorted-set equality, frozen-object check).
- **Classification:** PURE_SHAPE
- **Rationale:** This is a meta-guard. It enforces shape-only-ness; it doesn't perform any UW work itself. Equivalent to a lint rule expressed in code.

### F6 — `assertImportGraphPure` boot-time guard
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:226-269`
- **Code excerpt:**
  ```ts
  for (const m of stripped.matchAll(importRegex)) {
    const path = m[1] ?? m[2];
    if (!path) continue;
    const allowed = ALLOWED_IMPORT_PATTERNS.some((re) => re.test(path));
    if (!allowed) violations.push(...);
    const forbidden = FORBIDDEN_IMPORT_PATTERNS.find((re) => re.test(path));
    if (forbidden) violations.push(...);
  }
  ```
- **Pattern:** Source-self-introspection regex scan; throws if any forbidden domain import is detected.
- **Classification:** PURE_SHAPE
- **Rationale:** Self-test for the resolver scope guardrail (memory: `architecture_resolver_scope.md`). Doctrine §2.3 prefers `dependency-cruiser` / `eslint no-restricted-imports` for this kind of enforcement, so this whole block is a candidate for *removal* (replaced by lint policy) when the new resolver lands. It does not contain UW logic.
- **Notes:** Recommend retiring this block in favor of the lint policy described in §2.3 once the new resolver is in.

### F7 — `assertResolvedByResolver` brand-check
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:278-294`
- **Code excerpt:**
  ```ts
  if (!ctx || typeof ctx !== 'object') { throw ResolverIntegrityError(...); }
  if (!RESOLVER_ISSUED.has(ctx)) { throw ResolverIntegrityError(...); }
  ```
- **Pattern:** Type-guard plus WeakSet membership check.
- **Classification:** PURE_SHAPE
- **Rationale:** Identity invariant to prevent hand-rolled context objects from crossing the schema boundary. No data transformation. Carry-over candidate for the new resolver.

### F8 — `assertNarrativeDomain`: per-cell `typeof !== 'string'` guard
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:314-326`
- **Code excerpt:**
  ```ts
  for (const sectionKey of NARRATIVE_SECTION_KEYS) {
    for (const [field, value] of Object.entries(section)) {
      if (typeof value !== 'string') { throw ResolverIntegrityError('RESOLVED_NARRATIVE_NOT_STRING', ...); }
    }
  }
  ```
- **Pattern:** Output-domain runtime invariant.
- **Classification:** PURE_SHAPE
- **Rationale:** Anti-leak guard ensuring narrative cells never carry numbers (which would imply scoring logic leaked in). Deterministic, no UW decisions, no fallbacks that change numbers. Carry-over candidate.

### F9 — `assertNarrativeDomain` rollUpView field-type check (string-typed roll-up fields)
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:330-339`
- **Code excerpt:**
  ```ts
  for (const f of ['aggregationMethodology', 'normalizationCommentary', 'constituentLoanIds'] as const) {
    if (typeof rv[f] !== 'string') { throw ResolverIntegrityError('RESOLVED_ROLLUP_FIELD_NOT_STRING', ...); }
  }
  ```
- **Pattern:** Type guard.
- **Classification:** PURE_SHAPE
- **Rationale:** Same as F8 — output-shape invariant on string-typed cells. Carry-over candidate.

### F10 — `assertNarrativeDomain` `loanCount` mixed-type guard
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:340-346`
- **Code excerpt:**
  ```ts
  if (typeof rv.loanCount !== 'number' && typeof rv.loanCount !== 'string') {
    throw ResolverIntegrityError('RESOLVED_ROLLUP_FIELD_INVALID', ...);
  }
  ```
- **Pattern:** Disjunctive type guard reflecting the documented contract: number in roll_up mode, sentinel string in single_loan mode.
- **Classification:** PURE_SHAPE
- **Rationale:** Encodes the type contract, not a UW decision. Mode-projection of a count field is the canonical R3 allowed transform.

### F11 — `resolveConclusion` per-field assignment via ALLOWED_OPS
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:353-364`
- **Code excerpt:**
  ```ts
  return {
    loanSummary:              ALLOWED_OPS.sentinelDefault(c.loanSummary),
    strengths:                ALLOWED_OPS.joinList(c.strengths),
    weaknesses:               ALLOWED_OPS.joinList(c.weaknesses),
    mitigants:                ALLOWED_OPS.joinList(c.mitigants),
    escrowSummary:            ALLOWED_OPS.sentinelDefault(c.escrowSummary),
    loanStructureCommentary:  ALLOWED_OPS.sentinelDefault(c.loanStructureCommentary),
  };
  ```
- **Pattern:** Pick + rename, no conditionals.
- **Classification:** PURE_SHAPE
- **Rationale:** Canonical "Pick" transform per R3. No filtering of strengths/weaknesses/mitigants, no severity sort, no aggregation.

### F12 — Top-level body: per-section pick/rename via ALLOWED_OPS
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:376-431`
- **Code excerpt:**
  ```ts
  const out: ResolvedUnderwritingContext = {
    underwritingMode: ALLOWED_OPS.passthrough(mode) as UnderwritingMode,
    propertyLoanSummary: { propertyDescription: ALLOWED_OPS.sentinelDefault(...), ... },
    conclusionAndEscrows: resolveConclusion(ctx.conclusionAndEscrows),
    ...
    rollUpView: ALLOWED_OPS.rollUpFlatten(ctx.rollUpAggregation, mode),
  ```
- **Pattern:** Bulk pick + rename via fixed ops; no inline conditionals.
- **Classification:** PURE_SHAPE
- **Rationale:** Every cell is either passthrough or a sentinel-default. No asset-class branching, no numeric coercion, no recomputation. This is exactly the "Pick" transform described under R3 allowed transforms.

### F13 — Atomic `property` block: optional-chaining + `?? null`
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:437-448`
- **Code excerpt:**
  ```ts
  property: {
    name:            ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.name            ?? null),
    street:          ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.street          ?? null),
    ...
    occupancy:       ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.property?.occupancy       ?? null),
  },
  ```
- **Pattern:** Optional-chaining + nullish-coalescing on potentially-undefined optional block + numeric / string fields.
- **Classification:** UNCLEAR
- **Rationale:** The `?? null` here is normalizing `undefined → null` because the producer-side block is *optional* on the `UnderwritingContext` type (`property?: UnderwritingPropertyAtoms`). It is **not** masking a numeric degraded state — `null` flows through unchanged per R4. However: doctrine R3 explicitly forbids `value ?? 0` and similar coercions on numeric fields, and this code applies `??` to `yearBuilt`, `totalSquareFeet`, `units`, `occupancy`, all of which are numeric. The values being normalized are `undefined → null` (R4 says null flows through), not `null → 0` (which would be the forbidden coercion), so on the letter of R3 this is allowed. The ambiguity is whether converting `undefined` to `null` counts as "null fidelity" — it changes one absent-value sentinel to another. The cleaner shape under the new doctrine: producer always emits the block (no `?` on the type), so `?? null` becomes unnecessary.
- **Recommended destination (if UW_LOGIC):** Hydration / producer stage — make `UnderwritingPropertyAtoms` non-optional on `UnderwritingContext` so the producer always supplies `null`-valued fields; the resolver then becomes pure passthrough.
- **Notes:** Same shape repeats for `loan` (lines 449–453) and `parties` (lines 454–457). Marked UNCLEAR because: (a) R3's letter forbids `value ?? 0`, but here the right-hand side is `null`, not `0`; (b) the underlying root cause is the *optional* type, which the new producer should remove. Three findings (F13, F14, F15) share this rationale.

### F14 — Atomic `loan` block: optional-chaining + `?? null`
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:449-453`
- **Code excerpt:**
  ```ts
  loan: {
    termMonths:         ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.loan?.termMonths         ?? null),
    amortizationMonths: ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.loan?.amortizationMonths ?? null),
    ioMonths:           ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.loan?.ioMonths           ?? null),
  },
  ```
- **Pattern:** Same as F13 on numeric loan-structure fields.
- **Classification:** UNCLEAR
- **Rationale:** Same `undefined → null` normalization on optional block, three numeric fields. Same recommended cleanup (hydration always emits the block).
- **Recommended destination (if UW_LOGIC):** Hydration / producer stage.
- **Notes:** Per `UnderwritingContext` type, hydration is documented as the populator (line 196–204 of `underwriting-context.ts`). The new resolver should be pure pick; the optional `?` should disappear from the type.

### F15 — Atomic `parties` block: optional-chaining + `?? null`
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:454-457`
- **Code excerpt:**
  ```ts
  parties: {
    borrowerName: ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.parties?.borrowerName ?? null),
    sponsorName:  ALLOWED_OPS.passthrough<ResolvedCellValue>(ctx.parties?.sponsorName  ?? null),
  },
  ```
- **Pattern:** Same as F13/F14 on string party-name fields.
- **Classification:** UNCLEAR
- **Rationale:** String-typed; `?? null` is structurally trivial here (string `null` flows through), but the same R3-letter ambiguity applies. Same producer-side fix.
- **Recommended destination (if UW_LOGIC):** Hydration / producer stage.

### F16 — `comparablesLinkageRefs`: `?? []` empty-array substitution
- **File:line:** `apps/api/src/services/resolve-underwriting-context.ts:458`
- **Code excerpt:**
  ```ts
  comparablesLinkageRefs: ALLOWED_OPS.joinListAllowEmpty(ctx.comparablesLinkageRefs ?? []),
  ```
- **Pattern:** `?? []` — empty-array substitution on an optional field.
- **Classification:** UNCLEAR
- **Rationale:** R3's expanded definition explicitly enumerates "**Null coercion** … `array ?? []`" as forbidden. This one literally matches that pattern. However, the field is `comparablesLinkageRefs?: string[]` — *optional* on the type. The `?? []` is again normalizing `undefined → []`, not masking a degraded `null` array. Compare with `joinListAllowEmpty` (F3), which already handles `null | undefined` internally and returns empty string — so the inline `?? []` is *redundant* (the op would handle `undefined` itself).
- **Recommended destination (if UW_LOGIC):** Producer stage — make `comparablesLinkageRefs` non-optional, always populated (possibly empty). New resolver: pure passthrough through `joinListAllowEmpty`. Drop the inline `?? []`.
- **Notes:** This is the most clearly-flagged R3 pattern in the file ("array ?? []"). Strongly recommend cleaning it up before the new resolver lands — either by removing the `?` from the type or by deleting the redundant `?? []`. The behavior is currently safe (empty array = empty render cell) but it ticks the literal forbidden-pattern box.

## Recommendations

### High-priority moves (must land before new resolver)

1. **Make optional atomic blocks non-optional on `UnderwritingContext`.** Findings F13, F14, F15, F16 all stem from `property?`, `loan?`, `parties?`, `comparablesLinkageRefs?` being optional on the type. The hydration stage (which is the documented producer for these blocks per the type comment) should *always* emit the block with `null`-filled / empty-array members. After this fix, the resolver can use plain passthrough for every atomic field — no `?.` chains, no `?? null`, no `?? []`. **Destination: hydration / producer stage.** This is a prerequisite for satisfying R3 letter on the new resolver.

2. **Decide R4-strict vs current behavior on sentinel application** (F1, F2, F3, F4 sentinel branches). The doctrine §3.2 R4 says sentinel display ("—", "N/A", "Insufficient data") is the render layer's job. The legacy resolver applies `DATA_NOT_PROVIDED` sentinels itself, contradicting R4 strictly. Two paths: (a) keep sentinel application in the new resolver (consistent with project memory `architecture_render_four_axis.md`), or (b) push it to render and let the resolver carry `null` through. **Requires user decision.** Whichever wins, it should be the same in the new resolver — drift between resolver and render is the failure mode R4 was designed to prevent.

3. **Replace boot-time `assertImportGraphPure` (F6) with lint policy** per §2.3 (eslint `no-restricted-imports` + `dependency-cruiser`). This is doctrine-recommended and removes 60+ lines of self-introspection from the runtime resolver. Module-boundary lint policy must land as a CI gate before this code is removed.

### Lower-priority cleanups

- **Remove redundant `?? []` on line 458** (F16). Even before the optional-block fix, `joinListAllowEmpty` already handles `null | undefined` internally — the inline `?? []` is dead code. Removing it eliminates the literal R3 pattern match.
- **Carry over `assertResolvedByResolver` brand-check (F7), `assertNarrativeDomain` (F8/F9/F10), and `assertAllowedOpsLocked` (F5)** to the new resolver verbatim. They're shape-only invariants and aligned with R3 / R4 / R6 enforcement.
- **Document the source map (R1).** Every cell in the legacy resolver currently reads from `ctx.<section>.<field>` — that mapping needs to be expressed as the explicit "single declared source path" R1 mandates. The new resolver's source map should be a literal `Record<contextField, bundlePath>` so PR review can grep it.

### Items requiring user decision

- **Sentinel application location** (R4 strict-render vs project-memory current-resolver). Affects F1, F2, F3, F4. Recommend deciding before drafting the new resolver so its return shape is definite.
- **Whether `joinList`'s newline-join and `joinListAllowEmpty`'s comma-join belong in resolver or render.** Both are display-formatting concerns and could be argued either way. Currently in resolver, justified by header comment lines 4–8. R4 nudges them toward render.
- **Whether to keep the `RESOLVER_ISSUED` WeakSet brand** (F7) or rely on TypeScript's nominal-type tools (a private symbol field on the type) once the new resolver lands. Functional equivalence; choice is taste / runtime-cost.

## Closing note

No `UNDERWRITING_LOGIC` findings. The legacy resolver — by virtue of the four runtime guards in its header (ALLOWED_OPS, import-graph self-audit, output-domain check, identity brand) — has successfully kept asset-class branching, numeric normalization, derived booleans, semantic sorting, recomputation, and aggregation out of itself. The four `UNCLEAR` findings (F13–F16) are all the same root cause: optional atomic blocks on `UnderwritingContext`, which forces the resolver to do mild `undefined → null/[]` normalization that ticks R3's literal "null coercion" / "`array ?? []`" boxes. Fixing the producer to always emit the blocks resolves all four mechanically. The new Batch 6 resolver can then be a strict pick/rename projection with zero `??`.

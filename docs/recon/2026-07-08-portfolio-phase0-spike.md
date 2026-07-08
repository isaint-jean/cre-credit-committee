# Portfolio Phase 0 — Tractability Spike (2 unknowns)

Date: 2026-07-08
Author: Phase 0 spike (read-only inputs; throwaway spike scripts + this memo; NO cre.db write, NO doctrine, NO commit)
Follows: `docs/recon/2026-07-08-portfolio-rollup-scoping.md` (design scoping)
Test bed: **Prime Storage-Blue Portfolio** — Benchmark 2024-V8, assetNumber 19, 5 components (Union City / Jersey City / Newark / Hoboken / Garfield), NJ self-storage.

## Purpose

A NARROW spike (not a build) to decide whether the portfolio/roll-up feature's two
riskiest unknowns are cleanly solvable (→ Phases 1-4 are mechanical, commit) or carry
more risk than hoped (→ reshape before committing). No doctrine/scoring touched.

Spike scripts (throwaway, uncommitted):
- `apps/api/src/scripts/portfolio-spike1-ex102-uncollapse.ts`
- `apps/api/src/scripts/portfolio-spike2-render-repetition.ts`

---

## SPIKE 1 — EX-102 "un-collapse" (do the 5 survive as 5?) — **PROVEN**

**Result: 5 properties survive as 5 structured per-property records, every financial
field matched to `comps.db` ground truth (`19-001..19-005`) to the dollar.**

```
[1] 19-001 Union City   SF=69217 val=$29.0M NOI=$1,799,399.41 cap=0.062048 occ=0.954  ✓ all match
[2] 19-002 Jersey City  SF=44841 val=$21.5M NOI=$1,201,226.48 cap=0.055871 occ=0.933  ✓ all match
[3] 19-003 Newark       SF=62563 val=$19.5M NOI=$1,191,854.74 cap=0.061121 occ=0.909  ✓ all match
[4] 19-004 Hoboken      SF=34064 val=$13.5M NOI=$706,231.10   cap=0.052313 occ=0.876  ✓ all match
[5] 19-005 Garfield     SF=36427 val=$7.7M  NOI=$390,013.43   cap=0.050651 occ=0.93   ✓ all match
```

### Where the collapse point is — and the key finding

The brief hypothesized the parser "produces N internally, then flattens to one DealBag."
**The reality is stronger and simpler.** In this EX-102 filing, the 5 components are
**already independent top-level `<assets>` blocks** (`assetNumber` `19-001`..`19-005`),
each carrying a single `<property>` with full securitization financials, **plus** a
separate aggregate rollup block (`assetNumber` `19`, "Blue Portfolio",
`NumberProperties=5`).

- The **production** comps parser (`apps/api/src/services/extract-cmbs-comps.ts:67-129`)
  iterates every `<assets>` block and every `<property>` child, emitting one `CompRecord`
  each. **All 6 (1 aggregate + 5 components) already survive** — this is exactly how
  `comps.db` got its `19` + `19-001..005` rows. There is **no lossy collapse in the parser.**
- "Collapse to one DealBag" would be a **downstream** choice (keep the aggregate `19`,
  discard the components), not something the parser forces.
- Note: the `clean-corpus-ex102-parser.ts` (the older regex spike the brief pointed at,
  `~line 520`) samples only `assetNumber=1` per shelf and counts `<property>` children for a
  *quirk report*; it is NOT the production path. The production path is the DOM parser
  `extract-cmbs-comps.ts`, which never collapses.

### Un-collapse difficulty: **trivial**

The N components already exist as N fully-independent structured records. The only
net-new work is a **parent↔child link**: recognize `19-001..005` as children of rollup
`19` (via the `assetNumber` prefix + `NumberProperties=N` on the parent). This is a small,
deterministic, no-LLM join. Getting per-property records into the engine is **not** a
parser rework.

> ⚠ Caveat (not blocking): this is proven for the ONE filing where the issuer split
> components into separate `<assets>` blocks. Some filings nest multiple `<property>`
> children **inside one** `<assets>` block (the parser handles that too — it loops
> `<property>` children), so both shapes yield per-property records. A production build
> should handle both the "N-assets" and "N-properties-in-one-asset" shapes; the parser
> already does, but the parent↔child linking heuristic must cover both.

---

## SPIKE 2 — render repetition (one tab × N) — **MECHANISM PROVEN; end-to-end TRACTABLE with a bounded new layer**

**Result: one tab ("Property Detail - MF SS MHP") rendered ×5, each copy carrying
distinct real per-property data, persisted to a throwaway workbook and re-read from disk
(34 sheets = 29 template + 5 property copies). Every copy verified name/SF/NOI-correct
after round-trip.**

### The four-axis index cannot carry an ordinal — but it doesn't have to

The render schema index `(contractVersion, assetClass, variantKey, underwritingMode)`
is a **fixed tuple** used for a structural-determinism identity
(`render-schema.ts` `fingerprintKey` / `getStructuralIdentity`, boot-asserted). It has
**no room for a 5th `propertyOrdinal` axis** without a contract-version bump +
fingerprint regeneration + relaxing the "one identity per workbook" gate. Adding an
ordinal axis **is** a deep rework — the brief's worst-case fear is real *for that path*.

**But that path is avoidable.** The spike proved the alternative — **workbook-level
composition**:

- Tabs become sheets at the **ExcelJS layer** (`template-engine.service.ts`), which loads
  a template workbook and writes `cellBindings` keyed by `"SheetName!Addr"`.
- ExcelJS can **clone a template sheet N times** (model deep-copy preserves
  columns/merges/styles/formulas), each copy taking a unique sheet name
  (`Prop 19-001 - …`, capped at Excel's 31 chars).
- Because binding is by `"SheetName!Addr"`, N property-namespaced sheets keep the
  `cellBindings` map **flat** — no schema-key change, no fingerprint change. The
  four-axis rework is **sidestepped**.
- Verified round-trip: wrote `/tmp/portfolio-spike2-property-detail-x5.xlsx`, re-read it,
  confirmed all 5 copies persisted with distinct real data.

(The one real snag — ExcelJS crashing on `.xlsm` conditional-formatting rules with empty
`formulae` — is a **known, already-solved** issue: the production
`sanitizeConditionalFormatting` (`template-engine.service.ts:1645`) strips them, and the
spike reused it verbatim. Not a new risk.)

### Honest caveat — what Spike 2 does NOT prove (the real Phase-2 work)

The workbook layer is proven, but the **upstream producer layer is still single-property**:

1. `render.service.buildRenderPayload` takes **one** `RenderInput` → emits **one** flat
   `visibleTabs` + **one** `cellBindings` map. `materialize-rendered-analysis` is
   **1 Analysis → 1 RenderedAnalysis**. `getVisibleTabs` returns a **fixed** tab list with
   no "×property" concept. There is **zero precedent** for multi-render composition.
2. Therefore a build needs a **new composition layer above `buildRenderPayload`**: run the
   per-property producers N times (one per component `DealBag`), **namespace** each result's
   target sheet, and **merge** the N `cellBindings` sets before the single template write.
   This is **additive** (a bounded new orchestration layer) — **not** a four-axis schema
   rewrite and **not** a doctrine change.
3. **Cross-sheet formulas** are the sharpest edge: sheets like "Property & Loan Summary"
   pull from "Property Detail" via formulas; a per-property copy would need its formula
   references re-pointed, OR the build repeats only **leaf / self-contained** tabs
   (Property Detail is a good first candidate) and keeps aggregate tabs single. The
   aggregation layer (the accepted `evaluateDeal()`-per-property + new aggregation seam)
   feeds the single aggregate tabs; the repeated tabs are the per-property detail.

---

## ★★ TRACTABILITY VERDICT

| Unknown | Verdict | Difficulty |
|---|---|---|
| Spike 1 — 5 survive un-collapse as 5, real data intact | **PROVEN** (matched to comps.db to the dollar) | **Trivial** — parser already emits N; only a parent↔child link is net-new |
| Spike 2 — one tab renders ×N | **MECHANISM PROVEN** (5 real per-property sheet copies, round-tripped) | **Bounded / additive** — new composition-and-merge layer above `buildRenderPayload`; NOT a four-axis rewrite, NOT doctrine |

**Both unknowns are tractable.** Neither carries the deep-rework risk the brief flagged as
the reshape trigger:

- Spike 1 is easier than hoped (components arrive pre-separated; extraction never collapsed).
- Spike 2's scary path (5th ordinal render axis) is real but **avoidable** — the
  workbook-composition path is proven and keeps the schema/fingerprint contract untouched.

**The genuine remaining Phase-2 work is a NEW additive composition layer** (run producers
per-property, namespace + merge cellBindings, clone the leaf tab per property), plus
handling cross-sheet formulas by repeating only self-contained tabs. That is mechanical and
bounded — consistent with "Phases 1-4 are mechanical," NOT a reshape.

### Recommended next step: **COMMIT to the full build (Phases 1-4), with two scoping guardrails**

1. **Scope the repeated tabs.** Repeat **leaf / self-contained** per-property tabs first
   (Property Detail is the proof candidate). Keep aggregate tabs (Property & Loan Summary,
   Conclusions & Escrows) **single**, fed by the aggregation layer. This avoids the
   cross-sheet-formula re-pointing problem in v1.
2. **Build the composition layer as additive orchestration**, above `buildRenderPayload`
   — do NOT touch the four-axis schema key or fingerprints. Per-property producers → namespace
   → merge flat cellBindings → clone template sheet per property → single template write
   (reuse `sanitizeConditionalFormatting`).

No reshape needed. Spike scripts can be deleted or promoted to `check:*` proofs at build time.

---

## Gate results

- ★ Spike 1: **PROVEN** — 5 survive as 5, all financial fields match `comps.db` ground truth.
- ★ Spike 2: **MECHANISM PROVEN** + honest caveat on the upstream single-property producer layer.
- `apps/api check:engines`: **7/7 ok** (doctrine, judgment, narrative, mitigation, committee-memo, model-a-boundary, render-snapshot).
- Real `cre.db`: **`142ee8ee` byte-UNCHANGED** (`shasum` from `apps/api`). Only a throwaway `/tmp` xlsx written.
- `git stash list`: **stash@{0} present** ("relight dark-revert WIP (pre-P1)").
- `git status`: only the 2 spike scripts + this memo are new (no doctrine/scoring/schema touched).
- No commit. No doctrine/scoring touched. No full-build commitment made.

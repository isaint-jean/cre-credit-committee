# doctrine-clean — parallel clean doctrine module

**FENCE (load-bearing).** This module derives ONLY from:

1. `doctrine-rederivation-spec-v2.md` (the rederivation contract)
2. The public sources spec v2 cites (Moody's CMBS methodology, KBRA CMBS
   methodology, DBRS Morningstar CMBS rating methodology, CREFC IRP)
3. The clean backbone corpus's empirical signal (`/tmp/clean-corpus-backbone-corpus.json`),
   as **directional confirmation only** — never as the primary fit

It **never** opens, imports, or references the old `manifesto_rules.json`
or any old doctrine module. The module is self-contained.

## Scope (current)

- Scaffold + clean dimensional building blocks
- **Dimension 8 — Asset class** (`dimensions/asset-class.ts`)

The remaining eight dimensions and the clean scoring architecture will
be added in subsequent build-order steps. The doctrine-clean module
will eventually replace the old doctrine wholesale.

## Provenance traceability

Every tier / threshold / weight in this module carries a `provenance`
field naming its source: spec v2 section, public agency document, or
"corpus confirmation only." A reader who wants to audit why a number
exists should find the citation in the source code, not in code-review
context.

## What this module does NOT do (yet)

- No global scoring architecture (no final score, no band assignment).
  Each dimension emits a normalized risk contribution; the scoring
  layer is its own build-order step.
- No coverage gate / band cap. The cap mechanics of the old doctrine
  produced most of the LOSS-vs-CLEAN finalScore separation on the
  clean corpus (sharpened-read finding); the rebuild deliberately
  separates "doctrine confidence" from "doctrine call."
- No retirement of the old doctrine. The two modules run in parallel
  until the rebuild is complete and validated end-to-end.

## Fence audit (run before any PR that touches this module)

```bash
grep -rE "manifesto_rules|services/doctrine/|services/judgment/" apps/api/src/doctrine-clean
# Expected output: nothing.
```

---

## Desk-policy notes

Locked operator-judgment decisions that materially affect the lever stack.
These are recorded here so they are not re-litigated each pass.

### DP-1 — NCF/NOI haircut vs lever-4 lockbox reserve are NOT duplicative

Two carve-outs both touch TI/LC + capex on Office (and analogously on
other tenant-based classes):

| Knob | Where | What it answers |
|---|---|---|
| **NCF/NOI ratio** (e.g. Office 0.89) | `normalization/sustainable-cashflow.ts` step (C) | **ANALYTICAL** — what is the sustainable cash flow that VALUE + COVERAGE size against? Applies regardless of deal structure. |
| **Lever-4 in-place lockbox reserve** (e.g. Office 3.0% × EGI) | `services/mitigation/produce-mitigations.ts` `ASSET_CLASS_RESERVE_PROFILE` | **CUSTODIAL** — what dollar amount must be ESCROWED to secure funding of TI/LC + capex during the loan term? Applies regardless of how NCF was computed. |

**Decision (locked):** retain BOTH. They answer different questions:
the NCF haircut shapes the doctrine's stressed value and coverage ratios
(an analytical proxy for cash flow durability); the lockbox reserve is
the bank-controlled cash mechanism that guarantees those costs are
actually funded (a custodial mechanism, independent of how NCF was
estimated). A deal can fail one without failing the other — e.g., a
deal can have a strong NCF baseline but still warrant escrowed
TI/LC under elevated rollover risk.

The carve-outs are NOT duplicative: removing either degrades the
read. Removing the NCF haircut over-states value and under-stresses
coverage; removing the lockbox removes the cash-control mechanism
even when the haircut signals capex pressure.

Provenance: operator-judgment. Anchored to KBRA/DBRS asset-class
treatments (which themselves apply both haircuts and reserves in
their methodology — albeit at different magnitudes). NOT
employer-derived.

Cross-references:
- Office NCF/NOI ratio: `normalization/sustainable-cashflow.ts`
- Lever-4 Office reserve: `services/mitigation/produce-mitigations.ts`
  (`ASSET_CLASS_RESERVE_PROFILE`)

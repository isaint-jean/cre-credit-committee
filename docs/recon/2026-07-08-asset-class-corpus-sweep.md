# Asset-class corpus sweep — EMPIRICAL proof the doctrine is asset-class-aware

**Date:** 2026-07-08
**Kind:** Recon / validation harness (FREE, no-LLM, read-only)
**Harness:** `apps/api/src/scripts/sweep-asset-class-corpus.ts`
**Scorer:** `apps/api/src/doctrine-clean/scoring/evaluate-deal.ts` (`evaluateDeal()` — deterministic, no LLM)
**Corpus:** `data/comps/comps.db` (889 EX-102 comps, opened `readonly`)

This turns the static "the doctrine IS asset-class-aware" audit
(`2026-07-08-asset-class-coverage.md`) into EMPIRICAL proof: 889 real EX-102
loan-level records fed through the real `evaluateDeal()`, grouped by asset class,
showing the per-class tables fire with numbers.

## Safety / gates (all green)

- **No LLM, no credits.** `evaluateDeal()` is a pure deterministic function.
- **Read-only.** comps.db opened `{ readonly: true }`; cre.db never opened.
- **cre.db byte-unchanged:** `shasum data/cre.db` (from `apps/api`) =
  `142ee8ee20b629ee31a078dbff947be2f8d9b915` before and after. (Note: the task
  brief cited a short baseline `26195601`; the live DB has since moved several
  times per MEMORY — the invariant honored here is *byte-UNCHANGED across this
  read-only sweep*, verified pre/post.)
- **comps.db byte-unchanged:** `aa021900412c8ef1efdc9b2549e1e4937a84ad73` pre/post.
- **`apps/api check:engines` 7/7 ok.**
- **`git stash list`** shows `stash@{0}` (relight dark-revert WIP) — untouched.
- **`git status`** — only new untracked files are this memo + the harness script.
- Nothing committed.

## The mapping (EX-102 field → `evaluateDeal()` DealBag input)

The corpus `propertyType` labels are NOT the scorer's canonical `assetType`
strings; the harness remaps them:

| EX-102 `propertyType` | scorer `assetType` |
|---|---|
| Multifamily | `Multifamily` |
| Retail | `Retail` (dim canonicalizes → UnanchoredRetail, or Mall by name) |
| Industrial | `Industrial` |
| Self-Storage | `SelfStorage` |
| Lodging | `Hotel` |
| Mixed-Use | `MixedUse` |
| Office | `Office` |
| Other / Health-Care | *(no clean signal → assetType null → HITL)* |

| DealBag field | EX-102 source | Exercises |
|---|---|---|
| `assetType` | `propertyType` (remapped) | asset-class dim 8, all per-class tables |
| `subType` | `propertyTypeCodeRaw` (non-numeric) | Office CBD/suburban/medical split |
| `concludedValue` | `value` | cap-rate valuation-aggressiveness (dim 7) |
| `concludedValueSource` | `'extracted-annex-a'` (prospectus-disclosed) | confidence note, NOT a penalty |
| `uwY1Noi` | `noi` | sustainable-cashflow spine, cap-rate numerator |
| `t12Noi` | **null** | *(EX-102 has one NOI period — no divergence haircut possible; HONEST)* |
| `loanAmount` | `loanPieceAmount` | DY (dim 3), LTV (dim 1) — **★ PARI-PASSU CAVEAT** |
| `coupon` | `interestRate` | DSCR (dim 2), refinance (dim 4) |
| `underwrittenOccupancy` | `occupancyPct` | **★ DBRS stabilized-vacancy floor (the self-storage/office tell)** |
| `largestTenantPct` | **null** | concentration (dim 5) — EX-102 has one tenant name+SF, no roster |
| `pctIncomeExpiringWithinTerm` | **null** | rollover (dim 6) — no lease-expiry-vs-maturity in EX-102 |

### Which dims EX-102 data can honestly exercise

- **Exercised (real numbers):** cap-rate valuation stress (dim 7), sustainable-
  cashflow normalization (NCF/NOI + vacancy floor), debt-yield (dim 3), leverage-
  LTV (dim 1), coverage-DSCR (dim 2), refinance (dim 4), asset-class tier (dim 8).
- **N/A-for-missing-input (honest, not a failure):** income-concentration (dim 5)
  and rollover (dim 6). EX-102 (Reg AB II Schedule AL) carries a single top-tenant
  name + SF and no lease-expiry-vs-maturity, so no roster and no rollover share can
  be built. For unit/room classes (MF/Hotel/SelfStorage) these dims correctly go
  `not-applicable-by-asset-type`; for tenant-based classes (Retail/Office/
  Industrial/MixedUse) they go `hitl-needed`. **No inputs were fabricated to force
  a dimension to fire.**
- **Overvaluation appraisal cascade** and the **full line-item KNCF** are not
  reconstructable from EX-102 (single-period, no appraisal-vs-stabilized split) —
  the sweep uses the single disclosed value as the dim-7 comparator only.

### ★ PARI-PASSU caveat (load-bearing)

`loanPieceAmount` in EX-102 is the **trust piece**, not the whole loan (already the
spine caveat in the SEC-comps memory). So the DY and LTV computed here are
**piece-based** and read structurally low-leverage / high-yield in absolute terms —
**do not trust the absolute levels.** But the same piece basis applies to *every*
class, so the **class-relative floor differentiation** (which floor is applied per
class) is fully valid — and that is exactly what this sweep proves.

## Sweep coverage

- **889 rows total. 479 scored. 410 skipped.**
- Skipped breakdown: 360 missing `noi`/`value`/`loanPiece`; 50 non-positive on one
  of the three. The three are the cap-rate-spine drivers (dim 7 HITL without them →
  InsufficientData anyway), so skipping is honest, not selective.
- Of the 479 scored, 36 (34 `Other` + 2 `Health-Care`) return **InsufficientData**
  because their label carries no canonical asset-class signal → `assetType` null →
  spine HITL. This is the coverage-gap-not-risk doctrine working (see Anomalies).
  **443 records produced a full rating.**

## (1) Score distribution per class  `finalScore = (1 − ratedRisk) × 100`

| class | n | scored | min | med | mean | max | band spread (Str/Acc/Wat/Ele/Dec/Insuff) |
|---|---|---|---|---|---|---|---|
| Multifamily | 122 | 122 | 39.1 | 55.0 | 63.0 | 90.0 | 9/25/11/77/0/0 |
| Retail | 115 | 115 | 26.4 | 55.0 | 57.4 | 85.3 | 2/17/38/51/7/0 |
| Lodging (Hotel) | 52 | 52 | 41.6 | 79.3 | 74.4 | 79.3 | 0/41/10/1/0/0 |
| Office | 46 | 46 | 15.5 | 61.6 | 55.5 | 79.3 | 0/12/16/12/6/0 |
| Industrial | 37 | 37 | 39.1 | 78.3 | 76.6 | 90.0 | 11/20/1/5/0/0 |
| Self-Storage | 37 | 37 | 29.2 | 65.1 | 63.3 | 90.0 | 3/13/6/14/1/0 |
| Mixed-Use | 34 | 34 | 26.4 | 72.6 | 64.7 | 85.3 | 4/15/5/9/1/0 |
| Other | 34 | 0 | — | — | — | — | 0/0/0/0/0/34 (all InsuffData) |
| Health-Care | 2 | 0 | — | — | — | — | 0/0/0/0/0/2 (all InsuffData) |

Reads directionally consistent with the agency tiering: Industrial + Multifamily
have the widest upside (Strong-reachable, high means), Retail carries the only
non-trivial Decline count (7), Office reaches Decline (6) despite low n, and Lodging
clusters tight (all 52 in Acceptable/Watch/Elevated, none Strong — the Tier III +
10.5% DY floor + 9.5% cap floor keep it out of the top band). The absolute levels
are piece-based (see caveat) so treat them as *relative*, not underwriting-grade.

## (2) Dimension drivers per class (mean weighted risk contribution, base-blend)

| class | cap | refinance | asset | rollover | income | ratio |
|---|---|---|---|---|---|---|
| Multifamily | 0.089 | **0.167** | 0.024 | n/a | n/a | 0.049 |
| Retail | **0.176** | 0.108 | 0.086 | n/a | n/a | 0.038 |
| Lodging | 0.064 | 0.043 | **0.130** | n/a | n/a | 0.018 |
| Office | **0.177** | 0.090 | **0.130** | n/a | n/a | 0.031 |
| Industrial | 0.084 | 0.096 | 0.024 | n/a | n/a | 0.026 |
| Self-Storage | 0.151 | **0.133** | 0.024 | n/a | n/a | 0.048 |
| Mixed-Use | 0.143 | 0.094 | 0.071 | n/a | n/a | 0.035 |

The per-class **asset-class** column is the cleanest tell: Lodging/Office at 0.130
(Tier III), Retail 0.086 / Mixed-Use 0.071 (Tier II with some Tier IV malls), MF /
Industrial / SelfStorage at 0.024 (Tier I × the 0.18 weight × renormalization). The
cap-rate signal is heaviest exactly where the class cap floor is high vs the
comps' actual cap rates (Office 0.177, Retail 0.176). `rollover` + `income` are
`n/a` for every class here — the honest EX-102 coverage gap, not a scoring miss.

## (3) The differentiation TELLS manifest (with real applied values)

### 3a. Applied per-class FLOORS — the per-class tables, live

| class | cap going-in | NCF/NOI | DY floor | vacancy floor | vacancy status |
|---|---|---|---|---|---|
| Multifamily | 6.50% | 0.950 | 7.5% | 7% | haircut-to-stabilized-floor |
| Retail | 8.50% | 0.920 | 9.0% | 9% | haircut-to-stabilized-floor |
| Lodging (Hotel) | 9.50% | 0.960 | 10.5% | **null** | **asset-not-vacancy-based** |
| Office | 9.00% | 0.890 | 9.0% | 10% | haircut-to-stabilized-floor |
| Industrial | 7.25% | 0.970 | 8.0% | 6% | haircut-to-stabilized-floor |
| Self-Storage | 7.75% | 0.970 | 8.5% | **13%** | **within-stabilized-floor** |
| Mixed-Use | 8.00% | 0.940 | 8.5% | 9% | haircut-to-stabilized-floor |

- **★ Self-storage uses its OWN floors, ≠ office.** SelfStorage applied cap-floor
  **7.75%**, DY-floor **8.5%**, vacancy-floor **13%**, NCF/NOI **0.97** — every one
  distinct from Office (cap **9.00%**, DY **9.0%**, vacancy **10%**, NCF/NOI
  **0.89**). The DY-floor 8.5% (self-storage) vs 9.0% (office) and vacancy 13% vs
  10% are the exact values the task asked to see applied. Note the 13% self-storage
  vacancy floor is high enough that its records mostly sit `within-stabilized-floor`
  (no haircut), whereas office's 10% floor triggers `haircut-to-stabilized-floor` —
  a second-order behavioral difference, not just a different constant.
- **★ Hotel (Lodging) → RevPAR path, not a vacancy number.** `vacancyFloor = null`,
  status `asset-not-vacancy-based` — the DBRS vacancy lever is skipped for hotel
  exactly as the spec prescribes (RevPAR basis). Shown, not asserted.
- **★ Per-class cap-rate + DY floors span the full range** MF 6.50% → Hotel 9.50%
  cap; MF/MHC 7.5% → Hotel 10.5% DY. Each class's floor is the one actually applied.

### 3b. Rollover + Concentration applicability (fire only when they should)

| class | rollover | concentration |
|---|---|---|
| Multifamily | not-applicable-by-asset-type (122) | not-applicable-by-asset-type (122) |
| Lodging | not-applicable-by-asset-type (52) | not-applicable-by-asset-type (52) |
| Self-Storage | not-applicable-by-asset-type (37) | not-applicable-by-asset-type (37) |
| Retail | hitl-needed (115) | hitl-needed (115) |
| Office | hitl-needed (46) | hitl-needed (46) |
| Industrial | hitl-needed (37) | hitl-needed (37) |
| Mixed-Use | hitl-needed (34) | hitl-needed (34) |

- **★ MF / Hotel / SelfStorage rollover + concentration are correctly SILENT**
  (`not-applicable-by-asset-type`) — they do not fire, as required. Because they are
  N/A (not HITL), they are excluded from the coverage-reliability denominator, so MF
  records score at reliability **1.00** and never risk an InsufficientData on their
  account.
- **Retail rollover does NOT fire here** — but this is an **EX-102 data limit, not a
  doctrine miss.** The rollover dim is applicable to Retail (it is not gated out),
  but EX-102 carries no tenant roster or lease-expiry-vs-maturity, so
  `pctIncomeExpiringWithinTerm` is null → the dim routes to `hitl-needed` (honest
  coverage gap). Tenant-based records still score because reliability stays at 0.75
  (6 of 8 peer dims resolve, ≥ 50% gate). **To show retail rollover firing a real
  band would require the roster the corpus lacks** — this is called out as the one
  differentiation the corpus cannot exercise, rather than faked.

### 3c. Asset-class tier assigned (dim 8 table, live)

| class | tier(s) : risk (count) |
|---|---|
| Multifamily | I : 0.10 (122) |
| Industrial | I : 0.10 (37) |
| Self-Storage | I : 0.10 (37) |
| Retail | II : 0.30 (100), **IV : 0.80 (15)** |
| Mixed-Use | II : 0.30 (34) |
| Lodging (Hotel) | III : 0.55 (52) |
| Office | III : 0.55 (46) |
| Other / Health-Care | N/A : null |

- **Industrial single-tenant credit treatment:** Industrial sits at Tier I (0.10) —
  the lowest asset-class risk loading — consistent with the doctrine's
  logistics-tailwind / short-form-repricing framing. (Single-tenant *concentration*
  would surface via dim 5, which is HITL here for lack of roster; the *class* credit
  is applied and visible.)
- **The Retail IV : 0.80 (15) split is legitimate, verified:** those 15 Retail rows
  are mall-named (e.g. **Woodfield Mall** → `mall-name-detected` → Mall → Tier IV,
  confirmed by direct probe). The dim's mall-name detector correctly re-buckets
  named malls out of the Retail-default Tier II into Tier IV.

## (4) Anomalies — flagged honestly

**No scoring defects found.** Structural checks all clean:

- **No cross-class cap-floor leakage.** Each corpus label maps to exactly one
  applied cap-going-in floor family (Office would legitimately split by CBD/
  suburban/medical subtype, but the corpus `propertyTypeCodeRaw` for Office is just
  `OF` → default 9.00% applied uniformly; no leakage). Office assumptions
  (0.89 NCF/NOI, 9.0% DY, 10% vacancy) appear ONLY on Office rows.
- **No finalScore outside [0, 100].**
- **`Other` (34) + `Health-Care` (2) → InsufficientData is CORRECT, not a defect.**
  Direct probe (`60 Hudson`, a data-center under `Other`): `assetType` null →
  sustainable-cashflow HITL → **valuation spine (dim 7) not resolved** →
  `coverageReliability 0.00` → InsufficientData. This is the **coverage-gap-not-risk
  doctrine** doing its job: an unclassifiable record is routed to human review, not
  silently bucketed to a risk tier. (`Health-Care` has only n=2 in the corpus and no
  scorer bucket — genuinely out of scope.)

**One honest limitation (not an anomaly, but disclosed):** rollover + concentration
never fire a *real band* anywhere in the sweep because EX-102 lacks the tenant
roster + lease-expiry data. The dims behave correctly (N/A for unit classes, HITL
for tenant classes), but their *populated-band* logic is unexercised by this corpus.
Exercising it needs Annex-A / body-page roster extraction — out of EX-102 scope.

**Structural note repeated:** DY/LTV are piece-based (pari-passu) — absolute levels
unreliable; class-relative floor differentiation valid.

## Verdict: COMMITTABLE as a reusable regression harness

Recommendation: **committable** (though this run leaves it uncommitted per the task).
Rationale:

- It is **pure, deterministic, free, read-only** — safe to run in CI with no LLM /
  no credits / no DB writes.
- It exercises the real `evaluateDeal()` end-to-end over 889 real records and would
  **catch a regression** in any per-class table: a changed cap/DY/vacancy floor, a
  class leaking another's assumptions, a mall-name detector break, an applicability
  gate flipping (MF concentration firing, retail rollover N/A-ing wrongly), or a
  score escaping [0,100]. Section (4)'s checks are assertions-in-waiting.
- To harden it into a CI gate: pin the 3a floor table + 3c tier table as expected
  snapshots and fail on drift (mirrors the existing `check:*` boot-check pattern),
  and assert the two `(expected)` InsufficientData classes stay `Other` +
  `Health-Care`. That would make it a `check:asset-class-corpus` peer to the 7
  engine checks.

Until then it stands as **recon evidence** that the doctrine is empirically, not
just structurally, asset-class-aware.

### Reproduce

```
cd apps/api
npx tsx src/scripts/sweep-asset-class-corpus.ts            # prints the report
npx tsx src/scripts/sweep-asset-class-corpus.ts --json out.json   # + machine-readable
```

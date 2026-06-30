# CMBS Comps Blue-Box Cell Map — Phase 4b FIX-1 (corrected)

**Generated:** 2026-06-29 · read-only recon (ExcelJS fill inspection of the active template). ★★ **The 4b-1 cell-walk MISSED this table; the 4b-2 build bound the wrong rows (r13–18).**

## The blue box, pinned by fill style
- ExcelJS resolved fills: **r7–r10, columns B–Q, are filled `theme 3 / tint 0.80` = light blue** (the box Isabelle pointed to). The header r6 is `theme 0 / tint −0.15` (light gray). No other rows in 5–13 carry the blue fill.
- **Comp slots = r7, r8, r9, r10 → Comp 1–4.** `B7=1` (literal), `B8==B7+1`, `B9==B8+1`, `B10=4` (sharedFormula). `B11=null`. **Capacity = 4. Top-6 does NOT fit → top-N = 4.**
- The subject row is **r12** (formulas), BELOW the blue box. Header **r6**.

## Per-slot column → cell map (comp row N = 7,8,9,10)
| Col | Field | Bind? | Source |
|---|---|---|---|
| B | Comp # | **NO — formula** (`=+B{prev}+1`, auto-increments) | — |
| C | Loan Name | yes | propertyName |
| D–F | Address | yes → **F** (helper `R{N}=SUBSTITUTE(F{N},…)` reads F) | address |
| G | City, State | yes | `city + ", " + state` |
| H | Distance | blank | (no geocoding) |
| I | Loan Status | yes | loanStatus (default "Current") |
| J | Total sf | yes | netRentableSF |
| K | Year Built | yes | yearBuilt |
| L | Year Renov | yes | yearLastRenovated |
| M | Occup | yes | occupancyPct ×100 |
| N | Deal | yes | provenance note `SEC EX-102 · <deal> · asset#<n> · filed <date>` |
| O | Original Balance | yes | loanPieceAmount (piece) |
| P | Current Debt Yield | yes | computed noi/loanPieceAmount (piece) |
| Q | OPB / Measure | **NO — formula** (`Q{N}=IFERROR(+O{N}/J{N},…)` = $/SF, auto from O & J) | — |
| R | (helper) | **NO — formula** (address SUBSTITUTE) | — |

★ **Bind columns: C, F, G, H(blank), I, J, K, L, M, N, O, P.** B/Q/R auto-compute via the template's own formulas — do NOT write them (Q computing $/SF from O÷J is exactly the OPB/Measure the 4b-2 build computed manually). **J (Total sf) is a NEW column** the 4b-2 column map omitted; **Q should be left to its formula**, not bound.

## Reconciliation vs the 4b-2 build (what went wrong)
- The 4b-1 cell-walk identified r6 (header) + r12 (subject) + r13+ (CoStar cards) but **never recognized r7–r10 as the comp slots** — they were dismissed as part of the subject/operating region. The blue fill is the tell I didn't check.
- The 4b-2 build therefore: (a) **wrote 6 comps into r13–r18** — orphaned, BELOW the subject, in the card zone — instead of the blue box; (b) **cleared the CoStar card scaffolding** (r13–56), which is fine to keep but the data landed there; (c) used a column map **missing J (Total sf)** and **manually computing Q** (the blue box does Q by formula).
- The subject (r12) and header (r6) were correctly preserved — those parts are right.

## The fix (for FIX-2, not done here)
1. **Revert the r13–18 binding**: change the `cmbsComps` TableLayout `dataStartRow` 13 → **7**, capacity → **4** (top-4, not top-6).
2. **Bind columns C/F/G/H/I/J/K/L/M/N/O/P** (add J=Total sf; **drop Q** — let its formula run). Verify the column numbers: C=3, F=6, G=7, H=8, I=9, J=10, K=11, L=12, M=13, N=14, O=15, P=16.
3. **Keep** the parser wins, provenance note, piece labels, MISSING_DATA_FILL, self-exclusion — all still apply.
4. **Card clear-pass**: KEEP it (retires r13–56 CoStar cards/maps so nothing orphaned renders below the blue box) — but it must NOT touch r6–r12.
5. Likely **no new version bump** (V25 already added the layout); FIX-2 edits the V25 layout's rows/columns — confirm whether that requires a fingerprint refresh under the evolution-manifest gate.

★ The top-4 for Sunroad (from the 3b/4b-2 ranker): **Highlands Corporate Center · 225 Broadway** (both San Diego) **· 610 Newport Center · 11755 Wilshire** (SoCal) — the two San Diego peers + the two best SoCal, a clean 4-comp set.

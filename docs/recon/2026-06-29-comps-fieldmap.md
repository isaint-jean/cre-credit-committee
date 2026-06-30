# Comps Field Map — Phase 4a Step 2 (design only, no binding)

**Generated:** 2026-06-29 · Maps each Comps-tab column → a `CompRecord` field. Source tier = **SEC EX-102** (provenance-labeled) for all data columns. See 2026-06-29-comps-tab.md for the cell layout.

## CMBS Comps (loan-level — the PRIMARY home)
| Workbook column | CompRecord field | Transform / notes | Source tier |
|---|---|---|---|
| C Loan Name | `propertyName` | direct (the comp property/loan name) | SEC EX-102 |
| D-F Address | `address` | direct | SEC EX-102 |
| G City, State | `city` + `state` | `city + ', ' + state` | SEC EX-102 |
| H Distance: | — | **GAP** — needs geocoding (subject↔comp miles). CompRecord has geo *tier label*, not miles. | derived (none) |
| I Loan Status: | — | **GAP/partial** — EX-102 `paymentStatusLoanCode` not parsed; issuance = "Current"/performing. Default or extend parser. | SEC (unparsed) |
| K Year Built: | `yearBuilt` | direct | SEC EX-102 |
| L Year Renov: | — | **GAP** — EX-102 `yearLastRenovated` exists but parser skips it. Easy parser extension. | SEC (unparsed) |
| M Occup: | `occupancyPct` | ×100 → "%" (0..1 → percent) | SEC EX-102 |
| N Deal: | `dealName` (+ `assetNumber`,`filingDate`) | **provenance home** — the source CMBS deal | SEC EX-102 |
| O Original Balance: | `loanPieceAmount` | ⚠ **PIECE, not whole-loan** (pari-passu) — label as "deal piece" | SEC EX-102 (piece) |
| P Current Debt Yield: | computed `noi / loanPieceAmount` | ⚠ piece-based → unreliable like LTV; flag or omit | SEC (computed, piece) |
| Q OPB / Measure: | `loanPieceAmount / netRentableSF` | $/SF; piece caveat | SEC EX-102 (piece) |

## Sales Comps (valuation — appraised-value basis)
| Workbook column | CompRecord field | Transform / notes | Source tier |
|---|---|---|---|
| C Building Name | `propertyName` | direct | SEC EX-102 |
| D-F Address / G City,State | `address` / `city`+`state` | direct | SEC EX-102 |
| H Distance: / I Direction: | — | **GAP** — geocoding (miles + compass) | derived (none) |
| K Year Built / L Year Renov | `yearBuilt` / — | direct / **GAP** (renov unparsed) | SEC EX-102 |
| M Occup at Sale: | `occupancyPct` | ×100; basis = securitization occ, not at-sale | SEC EX-102 |
| N Sale Date | `valuationDate` | ⚠ **valuation date, not a sale date** — basis label | SEC EX-102 |
| O Sale Price | `value` | ⚠ **appraised securitization value, NOT a sale price** — provenance label makes basis honest | SEC EX-102 (appraised) |
| P Cap Rate: | `capRate` | direct (noi/value, already computed) | SEC EX-102 |
| Q Price / Measure | `value / netRentableSF` | $/SF | SEC EX-102 |

★ The Sales tab's sale-transaction framing (Sale Price / Sale Date) is a **basis mismatch** with our appraised value — two options for 4b: **(a)** populate + label the basis ("appraised value at securitization, not a closed sale"), or **(b)** leave Sales blank and bind only the CMBS (loan) tab. **Recommend (b)-leaning**: the **CMBS tab is the honest home** (loan comps are exactly what EX-102 is); the Sales/valuation tab is optional + needs the explicit basis caveat.

## Decision routing (A)
- **Financials → table columns** (value, noi/cap rate, balance, SF, year built, occup, city/state).
- **Provenance (deal + asset# + filingDate) → the "Deal:" column (N)** + a compact per-comp **note cell** carrying `SEC EX-102 · <deal> · asset#<n> · filed <date>` and the one-line **rationale** ("same metro, 5 mo newer, ~24% smaller").
- **Tier / within-tier / sub-scores → analysis page** (out of workbook scope — noted, not bound).

## Decision B — SEC source-tier treatment
- A **provenance label string** (mirrors the Environmental `Source:` precedent), attached to the **Deal column + note cell** per comp. **No new cell color** — reuse the existing provenance-note pattern; apply `MISSING_DATA_FILL` (FFFFC7CE) only to genuinely null cells.
- Distinguishes SEC-sourced comps from the subject deal's own docs (on-thesis, citable).

## Decision C — Lease section
Labeled deliberate blank: *"Lease comps require an appraisal/broker source — not present in SEC filings (EX-102 carries loan/sale data only)."*

## GAPS — tab columns with NO CompRecord source
1. **Distance (miles) + Direction (compass)** — both Sales & CMBS tabs. Need **geocoding** (subject + comp lat/long). CompRecord has a geo *tier*, not coordinates. → defer to a "geo-enrichment" batch, or leave blank w/ MISSING_DATA_FILL.
2. **Year Renov** — EX-102 `yearLastRenovated` present but unparsed → trivial parser extension (recommend doing it in 4b).
3. **Loan Status** — EX-102 `paymentStatusLoanCode` unparsed; issuance comps are performing → default "Current" or extend parser.
4. **Map regions / Map Link** — CoStar map images; no SEC source → leave blank.
5. **Debt Yield / Original Balance / OPB** — sourced but **piece-based** (pari-passu) → label as deal-piece, not whole-loan (consistent with `ltvReliable:false`).

## Coverage cross-reference (which columns blank-often)
- Corpus: **814/889 hasValue** (75 null-value); fieldCoverage histogram skews high (662 of 889 at ≥0.9).
- ★ **The top-6 office deliverable is high-coverage** — all 6 have value/noi/sf/occup (per the 3b smoke test), so **few blanks in the actual deliverable**. Columns most likely to need MISSING_DATA_FILL across the broader corpus: `dscr`, `occupancyPct`, `value` (the 75 null rows) — but these are filtered out of the curated top-6.
- **Treatment:** any null comp cell → `MISSING_DATA_FILL`; never fabricate.

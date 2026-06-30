# Comps Discovery Manifest — Phase 3a Step 1

**Generated:** 2026-06-29 · **Scope:** discovery only (no fetch/parse/store). Held at gate for sign-off.

## Header
- **Query window:** 2024-06-29 → 2026-06-29 (trailing 24 mo)
- **Route:** EDGAR full-text search `https://efts.sec.gov/LATEST/search-index` (forms=ABS-EE, entityName=<shelf>, sort=asc). UA `Isabelle Saint-Jean isaint-jean@mapaon.com`, ≤10 req/s. NOTE: deep paging (`from=`>0) returns HTTP 500 — used page-0 only (earliest ~100 filings per shelf), which captures 2024-vintage issuances.
- **Shelves hit:** Benchmark(BMARK), BANK, BANK5, BBCMS, BMO, WFCM ✓ | GSMS 0 (entity-name mismatch, deferred) | MSC/3650R/CGCMS thin (no recent-vintage in page 0)
- **ABS-EE filings seen in window (per-shelf totals):** BMARK 1330 · BANK 1246 · WFCM 839 · BBCMS 774 · BMO 517 · GSMS 368 · MSC 369 · BANK5 361 · 3650R 48 ≈ **5,852 total filings** (monthly + issuance)
- **Recent-vintage distinct trusts found:** 40 · **Kept in manifest:** 15

## Per-CIK rule: kept the EARLIEST in-window ABS-EE (issuance snapshot); later filings = monthly performance updates, discarded.

## Deal Manifest
| Deal | CIK | Accession | Filed | Shelf |
|---|---|---|---|---|
| BANK 2024-BNK47 | 0002023106 | 0001888524-24-011484 | 2024-08-01 | BANK |
| BANK5 2024-5YR5 | 0002006016 | 0001888524-24-009889 | 2024-07-01 | BANK5 |
| BANK5 2025-5YR15 | 0002071746 | 0001888524-25-015610 | 2025-08-29 | BANK5 |
| BANK5 2025-5YR19 | 0002098810 | 0001888524-26-001896 | 2026-01-30 | BANK5 |
| BBCMS Mortgage Trust 2024-C24 | 0002006370 | 0001888524-24-011157 | 2024-07-30 | BBCMS |
| BBCMS Mortgage Trust 2024-C28 | 0002030072 | 0001888524-24-014233 | 2024-09-30 | BBCMS |
| BBCMS Mortgage Trust 2024-5C31 | 0002044180 | 0001888524-25-001334 | 2025-01-30 | BBCMS |
| Benchmark 2024-V5 Mortgage Trust | 0002004982 | 0001888524-24-010292 | 2024-07-23 | BMARK |
| Benchmark 2024-V8 Mortgage Trust ⚓ | 0002024274 | 0001888524-24-012032 | 2024-08-27 | BMARK |
| Benchmark 2024-V10 Mortgage Trust | 0002034418 | 0001628297-24-000774 | 2024-10-31 | BMARK |
| BMO 2024-C8 Mortgage Trust | 0002012263 | 0001628297-24-000454 | 2024-07-01 | BMO |
| BMO 2024-C9 Mortgage Trust | 0002024812 | 0001888524-24-013070 | 2024-08-30 | BMO |
| BMO 2024-C10 Mortgage Trust | 0002038432 | 0001628297-24-000944 | 2024-12-30 | BMO |
| Wells Fargo Commercial Mortgage Trust 2024-C63 | 0002029929 | 0001539497-24-001644 | 2024-08-12 | WFCM |
| Wells Fargo Commercial Mortgage Trust 2024-5C1 | 0002028411 | 0001888524-24-012259 | 2024-08-27 | WFCM |

## Anchor check
- ✓ **BMARK 2024-V8 surfaces** (the Phase-2 correctness anchor) — discovered **issuance** accession `0001888524-24-012032` (2024-08-27).
- ⚠ NOTE: Phase-1/2 used `0001888524-24-018582` (a **Dec-2024 monthly**, not the issuance) — its securitization fields are IDENTICAL (static across a deal's ABS-EE filings), so the 13-field Sunroad validation holds. **For the corpus, use the issuance accession above.**

## Next (after sign-off): Step 2 — fetch each accession's EX-102 + parse via parseCmbsComps + build the corpus store.
# Data Room — Recon & Sequenced Build Plan

**Date:** 2026-08-09
**Status:** PLAN — recon complete, nothing built. Chunk 1 scoped build-ready (awaiting greenlight).
**Scope of spec:** a nested document repository replacing Intralinks for CRE/CMBS deals —
Deal/Pool → New Issue → Deal name → Contributing Bank → [Data Tapes + Loan Files] → Loan →
document Categories, with on-demand folders, dates/vintage, structured + delta download, a
confidentiality gate, and (later) watermarking + surfacing the engine's extraction alongside docs.

---

## 1. Headline: the spine is already ~70% built and proven

This is **not** a greenfield feature. A production-grade data-room pipeline already ships:

- **Routes** (`apps/api/src/routes/data-room.routes.ts`, mounted at `/api/data-room`, auth-gated):
  bulk drop → classify → assign; three projections (`/by-loan`, `/by-doc-type`, `/by-category`);
  per-doc streaming (`/doc/:fileHash`); per-user read/unread; **structured zip download with a delta
  cursor** (`/:poolId/download`); HELD ("needs identification") flow; version **pin/unpin**.
- **Classify** (`data-room-classify.service.ts`): deterministic 4-tier cascade (folder → filename →
  content front-matter → optional credit-gated LLM), auto-route only when confident, else HELD.
- **Zip security** (`data-room/unpack-zip.service.ts`): fail-closed zip-slip / zip-bomb / AppleDouble
  guards, streaming unzip, sandboxed.
- **Storage**: content-addressed blob store (`blob-store.ts`, SHA-256, dedup free) + `data_room_doc`
  SQLite table (`data-room-doc-store.ts`) + `data_room_held` + per-user `document_read_state` and
  `document_download_cursor`.
- **Frontend** (`apps/web/src/components/DataRoom/`, page at `app/pools/[poolId]/data-room/`): a page
  with a view toggle (Category / by-DocType / by-Loan), DropAssign, HeldView, VersionPicker, download.
- **~20 passing proof scripts** (`apps/api/src/scripts/data-room-*-proof.ts`) covering content routing,
  zip magic-byte gating, phases, and the manifest→SQLite v2 port.

So the plan below is scoped to the **remaining ~30%**: a unified tree UI, category alignment, a bank
grouping level, the access/confidentiality gate, and download-UX polish.

## 2. Recon table — spec feature → status → where

| Spec feature | Status | Where / why |
|---|---|---|
| Deal/Pool level | EXISTS | `pool` table (`shelf_name`, `vintage`, `seller`) — `pool-store.ts` |
| New Issue / Data Tape (versioned, dated) | EXISTS | `tape`/`working_tape`: `version`, `tape_date`, `received_at`, `prior_tape_id`, content-hash id — `pool.ts` |
| Loan-by-loan | EXISTS | `loan_in_pool` + per-tape `loan_membership` |
| Document categories (taxonomy) | PARTIAL | `DOC_TYPE_CATEGORY` (ASRs/Excels/Third-Party/Legal/General) — maps imperfectly to spec's 6 (see §3) |
| On-demand folders (no empties) | EXISTS | projections derive from actual `data_room_doc` rows; empty nodes never appear |
| De-dup (byte-identical collapse) | **FREE** | `blob-store.ts` SHA-256 content-addressed; identical bytes → same hash → one blob |
| Receipt date per file | EXISTS | `data_room_doc.uploaded_at` + `doc_effective_date` (extracted content date) |
| Tape vintage (current vs superseded) | PARTIAL | version/date/prior-chain exist; **no explicit prelim-vs-final flag** |
| Download-All (structure preserved) | EXISTS | `GET /:poolId/download` → zip `Category/Loan/DocType/FileName` |
| Incremental / delta download | EXISTS | `document_download_cursor(user_id,pool_id,last_synced_at)`, advances on success |
| Sticky *destination* (pick local folder once) | NET-NEW | server cursor exists; picking a **local** folder is client File System Access API |
| Clean collapsed-by-default nested tree UI | PARTIAL | drill-in views exist; **no unified Intralinks-style tree** (this is Chunk 1) |
| Contributing Bank grouping (Pool→Bank→Loan) | NET-NEW | `pool.seller` is one string; `mortgageLoanSeller` is display-only — no bank→loans hierarchy |
| Confidentiality gate (accept before entering) | NET-NEW | not even in the D1–D6 invite scope; an add-on |
| Per-buyer deal access (see only invited) | NET-NEW | today all-or-nothing by role; scoped as invitation D1–D2, zero code |
| Per-file download ledger / audit | PARTIAL | read-state + coarse cursor exist; no per-file "who downloaded what" table |
| Watermarking (email/IP/time) | NET-NEW (hard) | none |
| Extraction/UW surfaced alongside each doc (differentiator) | PARTIAL | data linkage exists (loan→`deal_ref`→extraction→doctrine eval, + `ingest`/`pinned`); only UI surfacing is new |

## 3. Category alignment detail (the one taxonomy gap → Chunk 2)

| Spec category | Status | Note |
|---|---|---|
| Third-Party Reports | CLEAN | `appraisal, pca, phase_i_esa` |
| Legal | CLEAN | `legal, title, closing, leases, loan_terms` |
| Financial Statements | split needed | today folded into `Excels` + `ASRs` (`cf, rent_roll, t12, occupancy, asr`) |
| Underwriting | NET-NEW | `seller_uw` exists but lives under `Excels` |
| Insurance | promote | `insurance` doc type exists but sits under `Legal` |
| Franchise / PIP | NET-NEW | no doc types at all (hotels) |

Taxonomy is a pure projection (`DOC_TYPE_CATEGORY` / `categoryOf`), so re-partitioning re-derives cleanly.

## 4. Sequenced build plan (remaining ~30%)

- **Chunk 1 — Read-only unified nested tree browser** ⭐ *first.* Deal → Loan → Category → file,
  collapsed-by-default, on-demand folders, dates + version/pin badges. View-only, frontend-mostly.
  **Size S–M · risk low · deps none.** Detailed scope in §7.
- **Chunk 2 — Category taxonomy alignment.** Add Underwriting (move `seller_uw`), promote Insurance,
  add Franchise/PIP. **Size S · risk low · deps Chunk 1.**
- **Chunk 3 — Confidentiality gate + per-buyer access.** Invitation D1 (deal_access + owner-on-create +
  backfill) + D2 (visibility enforcement on `/pools` + `/analyses/:id`) + a confi-accept step before
  entering the room. **Size L · risk HIGH (D2 touches every deal read) · gates external exposure.**
- **Chunk 4 — Contributing Bank grouping level.** Insert Bank between Deal and Loan. Cheapest path:
  group by existing denormalized `loan_membership.mortgage_loan_seller` — no schema change. **Size M ·
  risk med · deps Chunk 1.**
- **Chunk 5 — Download-All UX + sticky local destination.** Backend zips already exist; this is the
  client: buttons wired to existing endpoints + File System Access API for the sticky folder. **Size M ·
  risk med (browser API) · deps Chunk 1.**
- **Chunk 6 — Per-file download ledger + audit.** New `download_log(user_id, file_hash, pool_id,
  downloaded_at)`. **Size S–M · risk low · deps Chunk 3.**
- **Chunk 7 — (later) Watermarking · engagement insights · extraction-alongside-doc.** Watermarking is
  genuinely hard; insights = analytics over Chunk 6; the differentiator is mostly read+UI. **Size L ·
  risk high · split when reached.**

## 5. Honest flags

- **Already free / done — don't rebuild:** de-dup (content-hash), the tree *data* (projections),
  structured + delta download, receipt dates, tape vintage, the entire ingest/classify/zip/HELD pipeline.
- **Genuinely hard:** File System Access API sticky destination (Chunk 5), watermarking (Chunk 7), and
  **D2 visibility enforcement (Chunk 3)** — the single highest-risk change (touches every deal read).
- **Known adjacent blocker:** auto-underwrite-on-ingest ("Phase 3") was gated on a registry-persist-on-
  ingest fix; a `proof-registry-persist-on-ingest.ts` now exists — confirm it's closed before relying on
  live auto-underwrite. Not on Chunk 1's path.

## 6. How it interleaves with the invitation model (D1–D6)

The data room's "per-buyer access + confi gate" **is** the invitation model
(`docs/recon/deal-invitation-scope.md`). Chunk 3 = D1 + D2 plus a confidentiality-accept step D1–D6
doesn't currently include. Safe ordering: **Chunks 1–2 ship now** (read-only tree + categories are safe
on the current single-tenant), but **do not expose the room to external buyers until Chunk 3 lands** —
otherwise every authenticated user can still read any deal by id.

---

## 7. CHUNK 1 — DETAILED, BUILD-READY SCOPE (read-only nested tree)

**Goal:** one calm, collapsed-by-default tree that renders the Intralinks hierarchy over the documents
that already exist — proving the data model maps to the hierarchy before any download / security / bank
work. **View-only. No schema change. No mutations.**

### 7.1 Endpoint decision — add a read-only `GET /:poolId/tree` (recommended)

Two options: (a) compose the already-loaded `/by-loan` + `/by-category` + `/doc-types` client-side, or
(b) add one read-only `GET /:poolId/tree`.

**Recommend (b), a new `GET /:poolId/tree`,** because:
- **One call → simpler UI.** The page avoids re-nesting/merging three payloads into a tree in the client.
- **Server owns ordering** (loans, then `CATEGORIES_IN_ORDER`, then version order) so the tree is
  deterministic and matches the other projections.
- **Stable contract** that Chunks 4 (bank level) and 5 (download) extend, rather than reshuffling client
  glue each time.
- **Purely additive + read-only:** it composes the *existing* `projectByLoan` + `DOC_TYPE_CATEGORY` +
  the selected-version logic (`gatherTierADocs` / `pickSelectedVersion`) server-side. **No new table,
  no schema change, no writes.**

Response shape (illustrative — nests existing data, no new fields invented):
```jsonc
{
  "poolId": "…",
  "poolName": "…",            // pool.shelf_name (Deal root label; seller shown as subtitle, NOT a level)
  "loans": [                   // only loans that HAVE docs (on-demand)
    {
      "loanInPoolId": "…",
      "propertyName": "…",
      "categories": [          // only categories present, in CATEGORIES_IN_ORDER (on-demand)
        {
          "category": "Third-Party Reports",
          "slots": [           // grouped by docType within the category
            {
              "docType": "appraisal",
              "files": [        // versions within the slot, newest→oldest
                {
                  "fileHash": "…",
                  "fileName": "…",
                  "size": 123456,
                  "uploadedAt": "2026-…",
                  "docEffectiveDate": "2026-…" ,   // may be null
                  "pinned": false,
                  "isSelectedVersion": true,        // server-computed winner for the slot
                  "versionIndex": 1, "versionCount": 3
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```
Fallback: if we want *zero* backend change for a spike, the same tree is buildable client-side from the
already-fetched `byLoan` + `docTypes`; the dedicated endpoint is the cleaner foundation and is preferred.

### 7.2 The tree UI — a new `'tree'` view in the existing page

- **Lives in** `apps/web/src/app/pools/[poolId]/data-room/page.tsx` as a **new `RoomView` value**
  `'tree'` (add to the existing toggle: Category / by-DocType / by-Loan / **Tree**). New component
  `apps/web/src/components/DataRoom/TreeView.tsx`. Reuses the page's existing data-load + the role-gated
  shell; no new route.
- **Default:** add Tree as a toggle option; leave the current default (`category`) unchanged for now.
  Making Tree the default is a one-line follow-up once Isabelle likes it.
- **Collapsed-by-default + never cluttered at thousands of files:** every node starts collapsed; children
  mount **only when expanded** (lazy render keyed by an `expanded: Set<nodeId>` in state), so the DOM
  never holds thousands of rows at once. (If a *single* expanded slot ever holds thousands of files, note
  row-virtualization as a later optimization — not needed for Chunk 1.)
- **Calm design doctrine:** muted rows, a small disclosure triangle (▸/▾) per node, indentation per
  level, consistent with the analysis-page titled/boxed/▾ panels. Reuse `data-room-utils.ts`
  (`formatBytes`, `formatDate`, `tierChip`, `effectiveDateLabel`).
- **Levels for Chunk 1:** Deal (pool root, seller as subtitle) → Loan → Category → docType slot → file
  rows. **No Bank level** (Chunk 4).

### 7.3 On-demand folders — confirmed, verify at build

`projectByLoan` iterates `listPoolDocs` (only loans with docs); `projectByCategory` emits "only those
categories the pool has." The `/tree` endpoint inherits this: a loan/category/slot node is emitted **only
if it contains ≥1 file**. Empty folders never render. Build-time check: a pool with docs on some loans
shows only those loans/categories.

### 7.4 Data shown per file (and nothing more)

Each file row shows: **name**, **receipt date** (`docEffectiveDate` if present, else `uploadedAt`, with a
clear label of which), **version/pin badge** (`v{index} of {count}`, a "pinned" chip when `pinned`, and a
"current" marker on `isSelectedVersion`), and size. Category/slot nodes show a **count** of files. That's
it — no download button, no open-doc, no mark-read (those are later chunks; see 7.5).

### 7.5 Scope boundaries — explicitly OUT of Chunk 1

- **Bank grouping** → Chunk 4 (tree is Deal→Loan→Category, no Bank level).
- **Download UX / sticky destination / opening or streaming a file** → Chunk 5. Chunk 1 renders metadata
  only; it does **not** call `/doc/:fileHash` (opening can mark-read = a mutation, so it stays out to keep
  Chunk 1 strictly non-mutating).
- **Access control / confidentiality gate** → Chunk 3 (Chunk 1 relies on the current auth-gated route as-is).
- **Category re-alignment** → Chunk 2. **Chunk 1 uses the CURRENT taxonomy as-is** (ASRs / Excels /
  Third-Party Reports / Legal / General — 5 categories), *not* the spec's 6. The tree just renders
  whatever `DOC_TYPE_CATEGORY` says today.
- **No mark-read, no cursor writes, no pin changes** from the tree — pin/unpin stays in VersionPicker.

### 7.6 Build-time gates (acceptance criteria for when Chunk 1 is built)

- **View-only:** no mutations — no writes to `data_room_doc`, read-state, or the download cursor; the new
  endpoint is a pure read.
- **No schema change; additive only:** the existing endpoints and tables are untouched; `/tree` is new.
- **Canonical deals render:** on the live/seeded data, the pools that own Sunroad / 640 documents show
  their **real** docs in the tree, nested Deal→Loan→Category→file, with correct dates and version badges.
- **Byte-identical engine data:** the data room does not touch scores; `preflight-readiness --verify`
  still shows 640 = 60.238095 and Sunroad unchanged (640 head `221235987967` intact).
- **No new runtime deps.** Web typecheck (`tsc --noEmit`) + api engine checks pass.
- **Dev + live deploy unaffected:** `npm run dev` and the Fly deployment behave identically; the new view
  is purely additive behind the existing toggle.

### 7.7 Likely file touch-list (for the build, when greenlit)

- `apps/api/src/routes/data-room.routes.ts` — add `GET /:poolId/tree` (read-only handler).
- `apps/api/src/services/data-room-store.service.ts` — add a `projectTree(poolId)` composing existing
  `projectByLoan` + `DOC_TYPE_CATEGORY` + selected-version logic.
- `packages/contracts/src/` — a `DataRoomTree` response type (mirrors the shape in 7.1).
- `apps/web/src/components/DataRoom/TreeView.tsx` — new collapsed tree component.
- `apps/web/src/app/pools/[poolId]/data-room/page.tsx` — add the `'tree'` toggle + fetch `/tree`.
- `apps/api/src/scripts/data-room-tree-proof.ts` — a proof: tree over a seeded pool nests correctly,
  emits no empty folders, and marks the right selected version.

**Nothing above is built yet — this is the greenlight package.**

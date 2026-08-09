# Chunk 3 — Per-buyer deal access + confidentiality gate (recon + sub-plan)

**Date:** 2026-08-09
**Status:** PLAN. Sub-chunk 3a built (this commit); 3b–3d HELD.
**Risk:** the highest-risk chunk in the data-room plan — D2 (3b) touches every deal read.

Today deals are **ownerless + all-visible**: any authenticated user reads any deal/pool/analysis by id
(role gates the VIEW *within* a deal, not WHICH deals). Target: deal ownership (3a), visibility
enforcement (3b), a confidentiality gate (3c), and buyer invite/accept (3d).

## 1. Blast radius — the deal-scoped reads 3b must gate

~110 endpoints exist; the ones that leak deal data cluster on **three identifier spines**, all
currently `requireAuth`-only:

- **Spine A — analysis id (uuid *or* 64-hex lineageRootId):** `GET /analyses` (LIST), `/analyses/:id`,
  `/:id/buyer-diff`(+`/decisions`,`/export`), `/:id/memo`, `/:id/intake-completeness`,
  `/:id/handbook-evaluation`, `/:id/status`, `/analyses/lookup?dealRef`, `/analyses/compare`,
  `/analyses/audit-log` (LIST); writes: revisions, archive/restore/delete, decisions PUT.
- **Spine B — `rootId` (DoctrineEvaluationId → lineageRoot):** `GET /workflow-state`,
  `/committee-timeline`, `/audit-replay`, `/overlay-comments`; `POST /render`, `/underwriting/render`
  + `GET /underwriting/export` (dealId); `POST /committee-actions`,`/overlays`,`/overlay-comments`.
- **Spine C — `poolId`:** `GET /pools` (LIST), `/pools/:poolId`(+`/coverage`,`/underwrite-jobs`,
  `/working-tape`,`/tapes/:tapeId`(+`/membership`),`/loans/:loanInPoolId`(+`/history`),`/dispositions`,
  `/final-tape`,`/overrides`); all data-room reads `/data-room/:poolId/{tree,by-loan,by-doc-type,
  by-category,docs,doc/:fileHash,download,held,held/:fileHash,unread}`.

**NOT deal-scoped (role gates, not deal_access):** `criteria/*`, `registry/*`, `kicks/*`, `manifesto/*`,
`research/*`, `uw-intelligence/*` (the 267-UW library/rules/insights), `source-docs/*`,
`data-room/doc-types`. Institutional-memory corpus, not a buyer's active deals.

**Three traps:** LIST endpoints need per-row filtering (not per-id 403); file streams must check access
*before* bytes flow; dual-format ids (uuid + 64-hex) and lookup-by-dealRef must resolve → then check.

## 2. Access model + the key decision

The data room is **pool-scoped**, the invitation model is **deal(lineageRoot)-scoped**. Resolution —
ONE polymorphic table:

```
deal_access(
  resource_type TEXT,   -- 'deal' (key=lineageRootId) | 'pool' (key=poolId)
  resource_key  TEXT,
  user_id       TEXT,
  party         TEXT,   -- 'originator' | 'buyer' | 'admin'
  granted_by    TEXT,
  granted_at    TEXT,
  accepted_at   TEXT,   -- null until the buyer accepts the confi gate (ties confi→access)
  PRIMARY KEY (resource_type, resource_key, user_id)
)
```

- **Stable deal key = `lineageRootId`** (`dealRef` is non-unique across re-extractions; `analyses.
  lineage_root_id` is stable). Pool key = `poolId`.
- **Derivation:** pool access implies its loans' deals (a loan's `dealRef` → `lineageRootId` in the
  granted pool).
- **Admin bypass:** `enforceDealAccess` allows `role === 'ADMIN'` (explicit + tested).
- **Zero existing ownership** confirmed — no owner/created_by/user_id on analyses/pool/etc.; `pool.seller`
  is a metadata string.

The gate slots like `enforcePermission` (boundary-only): `requireAuth` → `requirePermission` →
`enforceDealAccess(req, res, {type,key})` → service. `req.user = { userId, email, role }`.

## 3. Backfill
Seeded users: `admin@cre.com` (admin), `originator@cre.com` (originator), `buyer@cre.com` (buyer).
Backfill grants **originator@ + admin@** on every existing analysis lineageRoot (Sunroad/640/Prime) and
every pool (BMARK). Post-enforcement: admin + originator see everything; `buyer@` sees nothing until
invited. Additive `deal_access` rows — deals byte-identical.

## 4. Confidentiality gate
- Gate before `/pools/[poolId]/data-room` renders (buyer-side only; admin/originator bypass).
- `POST /pools/:poolId/confidentiality/accept` → append to `confi_acceptances(id, resource_key,
  user_id, agreement_version, accepted_at, client_ip)` + set `deal_access.accepted_at`.
- **IP capture is NET-NEW** — no `req.ip`/`x-forwarded-for` today; needs `app.set('trust proxy', 1)`
  behind the Fly proxy. `CommitteeActionsStore` (append-only, author + occurred_at, chain-linked) is the
  closest reusable logging shape, but none capture IP.

## 5. Sequenced sub-chunks

| Sub-chunk | What | Size · Risk | Reversible |
|---|---|---|---|
| **3a ⭐** | `deal_access` table + owner-stamp on create + backfill originator+admin on all existing deals/pools. **No enforcement.** | S · LOW | Yes — drop rows/table |
| **3b** | `enforceDealAccess` + the sweep over Spine A/B/C; per-row LIST filter; admin bypass. **Split 3b-1 analyses/render/workflow · 3b-2 pools · 3b-3 data-room**, each with a denial proof. Feature-flagged. | L · HIGHEST | Flagged, per-route removable |
| **3c** | `confi_acceptances` + trust-proxy/IP + `POST /confidentiality/accept` + buyer modal. | M · MED | Yes |
| **3d** | Invite token/expiry/single-use + accept flow → buyer `deal_access` row; originator invite UI + buyer accept page. | M · MED | Yes |

**First: 3a** — the role-siloing pattern (model + seed/backfill *before* enforcing); removes 3b's
chicken-and-egg.

## 6. Denial-proof strategy (mirror role-siloing)
For 3b: create a throwaway buyer (no grants) → assert 403/empty on Sunroad/640/BMARK across all spines;
assert admin + owner still 200/full; delete the throwaway user (canonical 3a owner rows untouched, deals
byte-identical). Prefer in-memory/temp stores; access-table writes stay throwaway-user-scoped.

## 7. Honest flags
- **3b is the highest-risk change** — miss one → leak, over-gate → lock-out. Mitigations: a feature flag
  (`DEAL_ACCESS_ENFORCEMENT=off` by default) so it ships dark; split into 3 domain proofs; admin bypass
  wired + tested first.
- **Not locked out:** on the live deploy you log in as admin → bypass. originator@ owns everything
  post-backfill; buyer@ goes empty-until-invited (intended). Safe for the live app.
- **Pool-vs-deal grain** — the modeling call resolved by the single polymorphic table.
- **Confi legal-logging** — record the agreement version; append-only; IP needs trust-proxy.

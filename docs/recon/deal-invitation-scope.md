# Scoping Doc: Deal-Connection / Invitation Model

Status: scoping. Chunk D1 (deal-access model + owner-on-create) is the first build; D2–D6 held.

## A. Current state — the core gap is real
### A1. Deal ownership: NONE
No deal record references a user. `analyses` / `rendered_analyses` / `extraction_results` have no
owner/created_by/user_id. `pool.seller` and `loan_in_pool.originator_loan_ref` are metadata STRINGS,
not enforceable user links. `users` has no deal linkage. Deals are created via build-and-ingest with
no user stamped.

### A2. Deal visibility: all-or-nothing (the gap)
`GET /pools` filters only by vintage/seller query params — not by user; returns all pools.
`GET /analyses/:id` is requireAuth-only — any authenticated user reads any deal by id. Role-siloing
gates the VIEW (what surfaces per side), NOT WHICH DEALS you see. An invited buyer would see every
bank's deals. Same family as the earlier admin-read-guard gap (who-can-see-what, unenforced server-side).

### A3. Existing primitives
- POST /auth/register (admin-only, creates a user+role) — the user-creation half; not deal-linked.
- loan_membership (tape<->loan junction, append-only) — a PATTERN for a junction table, not as-is.
- Side-tagged overlay comments — cross-party linkage, not access.
- Invite / token / share / magic-link — does NOT exist. Net-new.

### A4. Pool/loan structure
A "deal" exists in two layers joined by a `deal_ref` string: the analysis/rendered_analysis (what the
siloed views render) and the loan_in_pool (a loan on a pool tape). The pool is NOT bank-scoped by user
(seller is metadata). ⚠️ `deal_ref` is NOT unique (re-extractions share it) — the access key should be
the stable `lineageRootId`, not dealRef.

## B. Target model — create → invite → accept → bound
1. Bank creates & owns — originator creates deal + first tape/UW → an originator access row (owner).
2. Bank invites buyer — originator mints a deal-scoped invite (token/link, optionally bound to an
   email) granting access to THAT deal only.
3. Buyer accepts → bound — accepting creates a buyer access row; both parties on the same deal via
   their enforced siloed views. The invite is the bridge between the two enforced worlds.
4. Access enforced server-side — buyer sees only invited deals; originator sees own; admin sees all
   (QA bypass). Many banks × many buyers, each pair bound per-deal.

Data shape: `deal_access(deal_key, user_id, party: originator|buyer, invited_by, accepted_at)` +
`deal_invites(token, deal_key, invited_email?, created_by, expires_at, accepted_by)`. deal_key =
lineageRootId.

## C. Gap → chunks (Size S/M/L · Risk Lo/Med/Hi)
- D1 — deal-access model + stamp owner on create + BACKFILL existing ownerless deals. M · Med. ← foundation.
- D2 — deal-visibility scoping (the core): GET /pools + GET /analyses/:id filter by deal_access; admin
  bypass. Buyer sees only invited deals. L · Hi (every read; bug leaks or hides).
- D3 — invite mechanism: POST /deals/:key/invite → token/link (+ email binding, expiry, single-use). M · Med.
- D4 — accept flow: buyer opens invite → POST /invites/:token/accept → buyer access row (register-then-
  accept if not a user — controlled expansion of admin-only registration). M · Med.
- D5 — full access-enforcement sweep: every deal-scoped read/write checks deal_access + role. L · Hi.
- D6 — UI: originator create-deal + invite-a-buyer + the buyer accept page. M · Lo-Med.

## D. View-only vs backend
Real backend/auth (data-leak-if-wrong): D1, D2, D4, D5 — same rigor as the role-siloing auth chunks
(backups, denial tests, byte-identical). Mostly view: D6 + the link-display half of D3.

## E. Interleave with deployment
A single-deal trusted private demo can deploy WITHOUT this model. The moment an untrusted buyer is
invited and must not see other banks' deals, D1 + D2 are a PREREQUISITE. Order: deploy private/trusted
first → build D1 + D2 → then invite model (D3–D6) → then public/multi-party.

## F. Order + first step
D1 → D2 (core) → D3 → D4 → D5 → D6. First step: D1 (deal_access table, owner-on-create, backfill) —
additive, low blast radius, unblocks D2. Do D2 immediately after (admin bypass + denial tests), since
D1 without D2 grants ownership rows nothing reads yet (seed-before-wire, like role-siloing ch.1→3).

## G. Honest flags
- ★ Real backend/auth — the "data leak if wrong" work. D2 is the highest-risk single change.
- ★ Existing ownerless deals need a backfill (who owns Sunroad/640 — admin or an originator).
- ★ Invite tokens = a new auth surface (expiry, single-use, unguessable, no leakage).
- ★ Invite-creates-user expands admin-only registration into a controlled self-service path.
- ★ Deal key = stable lineageRootId, not the non-unique dealRef.
- ★ Admin bypass must be explicit + tested (mirrors the role-siloing model).

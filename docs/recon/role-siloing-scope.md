# Scoping Doc: Real Role-Siloed Front End (ORIGINATOR / BUYER / ADMIN)

Status: scoping only. Chunk 1 (roles + seed users) is the first build; chunks 2–7 held.

## A. Current state

### A1. Auth & roles
- JWT auth. `login(email,password)` → `POST /auth/login` → token in `localStorage.cre_token`;
  `useAuth()` exposes `{ user, token }`, and `user.role` is available client-side (JWT carries
  `{id,email,role}`). Token re-validated on mount.
- Seeded user: `admin@cre.com` / `admin123` → ADMIN. `POST /auth/register` (admin-only) creates users.
- Role matrix (`packages/contracts/src/roles.ts`) — 5 internal roles, no side concept:
  - VIEWER: reads only.
  - ANALYST: submit, override, revise.
  - CREDIT_OFFICER: submit, request-info, override, revise.
  - COMMITTEE_MEMBER: request-info, approve, reject, postpone.
  - ADMIN: everything.
- Confirmed: NO originator/buyer role today. `workflow:approve`/`workflow:reject` held only by
  COMMITTEE_MEMBER + ADMIN, enforced server-side by `enforcePermission(req.user.role, …)` —
  independent of `?side`.

### A2. The `?side` mechanism + side-aware surface inventory
- `useSide()` reads `?side=originator|buyer` from the URL (`side-context.tsx`). Frontend-only: no
  backend, no persistence. `null` = Platform.
- Side-aware surfaces today (the reusable presentation layer for the target):
  `/` two-door home; `auth-shell` breadcrumb; `WorkbookReadiness` (originator checklist vs workbook);
  `RenderedAnalysisView` (accent + originator OpenFlags); `NegotiationSurface` (side chip / notice);
  `DealRoom` (legacy); `/pools`, `/pools/[poolId]`, `…/loans/…`, `…/data-room` (withSide links);
  `PoolRail/*`, `NewDealForm`. Helper: `side-accent.ts` / `withSide()`.

### A3. Three overlapping "role/side" concepts (must collapse to one)
1. `user.role` (VIEWER…ADMIN) — real, enforced.
2. `?side` (originator/buyer/platform) — cosmetic view accent.
3. NegotiationSurface/DealRoom local "Viewing as" toggle (`bp_spire`/`originator`) — component-local.
Target: `user.role` is the source of truth; existing `?side` rendering becomes the presentation layer
driven by role.

### A4. Cosmetic vs enforced
- Enforced (server): committee actions via role→permission matrix. Reads are `requireAuth`-only.
- Cosmetic (client): all `?side`. Hiding committee buttons on the originator view does nothing
  server-side — an ADMIN on `?side=originator` can still approve.

## B. Target (enforced)

| | ORIGINATOR (bank) | BUYER (B-piece) | ADMIN |
|---|---|---|---|
| Sees | Seller UW + buyer-diff, "what buyers need" checklist + upload, negotiation, Red Flags | Workbook, full analysis, mitigants, Red Flags | Everything |
| Does | Upload, negotiate/communicate, self-check — no verdict | Approve/Reject (first-loss), request info, negotiate | All + view-as switch |
| Denied | approve/reject/submit; no workbook | — | — |

## C. Gap → sequenced chunks (Size S/M/L · Risk Lo/Med/Hi)

1. **Add ORIGINATOR + BUYER roles + seed users.** S · Lo. Additive matrix rows + seeded users. Deps: none. ← FIRST
2. **Server-gate approve/reject/submit vs ORIGINATOR.** S · Med. Matrix already denies; verify 403 + test. Deps: 1.
3. **Derive `side` from `user.role` (bridge).** M · Med. Non-admins forced side from role; admin overrides via `?side`. Makes all A2 surfaces role-driven with no rewrites. Deps: 1.
4. **Login role-picker + per-role landing.** M · Med. Route by role; deny cross-role deep links. Deps: 1,3.
5. **Client role-siloing of components.** M · Lo. Hide committee/workbook chrome for originator (now honest). Deps: 3.
6. **Admin "view as" switch.** S · Lo. Admin-only `?side` control in the shell. Deps: 3.
7. **Originator communication actions (NET-NEW).** L · Med. send-to-buyer/nudge/waiting, possible new states + perms + UI. Deps: 1,2.

## D. View-only-able vs real backend/auth
- Real auth (needs denial tests): 1, 2, 3, 4, 7.
- View-only-able (meaningful only after 3): 5, 6.
- Migration: Chunk 3 reconciles cosmetic `?side` with real role — side derives from role for non-admins,
  falls back to `?side` for admin, so existing surfaces keep working unchanged.

## E. Recommended build order
Start Chunk 1 (roles + seed users) → Chunk 3 (derive side from role, the keystone) → Chunk 2 (verify
server denial) → 5 → 4 → 6 → 7. Chunks 1+3 convert the existing `?side` surface into a real role system
with almost no component rewrites.

## F. Net-new
ORIGINATOR + BUYER roles/users; side-derived-from-role + admin override; role-picker login / per-role
routing; admin view-as switch; originator communication actions + any new lifecycle states.

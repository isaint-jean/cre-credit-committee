# Deployment Scoping Doc: cre-credit-committee → Fly.io

Status: scoping. Step 1 (local Docker dry-run of the api) is the first build; Fly steps 2–8 held.

## A. Topology — two services

| Service | Today | Prod build | Prod run | Port |
|---|---|---|---|---|
| web (Next.js) | `next dev` :3000 | `next build` | `next start` | 3000 |
| api (Node) | `tsx watch src/index.ts` :3001 | — (see below) | **`tsx src/index.ts`** | 3001 |

⚠️ The api's `build: tsc` / `start: node dist/index.js` do NOT produce a runnable prod binary:
`apps/api/tsconfig.json` uses `moduleResolution: "bundler"`, and the workspace packages
(`@cre/contracts`, `@cre/shared`) are consumed as TS source (`main: ./src/index.ts`, no JS build).
So `node dist/index.js` can't resolve them. Deploy the api by running it via `tsx src/index.ts`
(no watch) — the lowest-friction path; sidesteps a real bundling project.

Recommended host split: BOTH on Fly, api private. api = Fly app with a volume (SQLite lives with it),
no public IP — reachable only by web over Fly's internal `.internal` network. web = the only public
service, calling the api at `http://cre-api.internal:3001`. No CORS, api never publicly exposed
(private-first win), one provider.

## B. Database — the real work
`sqlite-store.ts` uses better-sqlite3 with `DB_PATH = path.join(process.cwd(), 'data', 'cre.db')`
(auto-creates the dir). Volume-mounted SQLite is viable as-is; the only caveat is the path derives
from `process.cwd()` (no env override) — the container must run with cwd = the app dir that has
`data/` on the volume.

Recommendation: (a) volume-mounted SQLite — lowest friction. Fly volumes are region-pinned + SQLite
single-writer → single-region only (fine for a demo). Postgres (option b) = a real port of ~1000
lines of hand-written better-sqlite3 SQL; only if you need multi-region/HA. Not now.

Seed: users seed on boot (seedDefaultUser, idempotent — admin/originator/buyer). Deals do NOT seed —
Sunroad/640 live in the local cre.db (ingested manually). To have them in prod, SHIP the existing
cre.db to the volume once (sqlite3 .backup snapshot, ~18.9 MB).

## C. Secrets / env → Fly secrets
env.ts loads `../../.env` in dev (no-ops in prod) and falls back to process.env → Fly secrets work.
- JWT_SECRET — ★ MUST set (defaults to an insecure literal today).
- ANTHROPIC_API_KEY — LLM (ingest/extraction) — ★ credits.
- FRONTEND_URL — CORS allow-origin (the web's public URL).
- BRAVE_SEARCH_API_KEY / STRIPE_SECRET_KEY / STRIPE_PRICE_ID — secret (or empty).
- PORT (default 3001) / EXTERNAL_DD_AT_MINT (flag).
- web: NEXT_PUBLIC_API_URL or API_ORIGIN — ★ the hardcoded next.config.js rewrite (`localhost:3001`)
  must become env-driven (point at `http://cre-api.internal:3001`).

## D. Minimum-viable auth for one external user
Seeded users + JWT over HTTPS already work; nothing assumes localhost in the auth path. To let one
partner in: (1) set a real JWT_SECRET; (2) rotate the weak dev passwords; (3) hand them a login. No
multi-tenant work needed.

## E. Build / Dockerfile
- api: one Dockerfile; build context = repo ROOT (workspaces need packages/*); `npm ci` at root;
  better-sqlite3 native module compiles for linux (needs a build toolchain in the image); run
  `npx tsx src/index.ts` from apps/api (NOT node dist); volume at /app/data; healthcheck GET /health.
- web: `next build` → `next start` (or Next standalone); set the api base env at build.

## F. Private-first (real URL, not public)
api internal-only (no public IP, Fly `.internal`). web has a login wall (no anonymous use); for extra
privacy add HTTP Basic Auth in Next middleware; use a non-obvious `*.fly.dev` name. Reachable only via
URL + Basic-Auth + app-login — not indexable, not anonymously usable.

## G. Sequenced steps (Size S/M/L · Risk Lo/Med/Hi · all reversible)
1. LOCAL Docker dry-run of the api (Dockerfile + tsx run + throwaway volume; verify boot + /health +
   login). M · Med. ← START HERE (catches tsx/better-sqlite3/cwd gotchas locally, zero Fly cost).
2. Fly account + `fly launch` scaffolding. S · Lo.
3. Volume + deploy api private; ship cre.db. M · Med.
4. Set secrets (JWT_SECRET, ANTHROPIC_API_KEY, FRONTEND_URL). S · Med.
5. web Dockerfile + env-drive the api URL (fix the hardcoded rewrite). M · Med.
6. Deploy web public + Basic-Auth gate. M · Med.
7. Rotate seeded passwords; give the partner a login. S · Lo.
8. Internet smoke test (login → view Sunroad). S · Lo.

## H. Honest flags
- ★ tsc/node dist won't run (moduleResolution: bundler + TS-source workspaces) → deploy via tsx.
- ★ Anthropic credits: a live deploy makes real LLM calls on ingest — credits are exhausted, so new
  ingest fails until topped up. Viewing already-ingested deals (Sunroad/640) needs zero LLM → a
  read-only demo works today; new-deal ingest doesn't.
- ★ better-sqlite3 native module — compiles in the Docker build (linux).
- ★ JWT_SECRET insecure default + weak dev passwords — fix before external access.
- ★ hardcoded next.config.js rewrite — must become env-driven.
- ★ SQLite single-region/single-writer — fine for a demo, not scale/HA.
- ★ cre.db must be shipped — deals aren't seeded; only users are.

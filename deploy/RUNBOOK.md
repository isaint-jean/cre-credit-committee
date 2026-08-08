# Fly Deploy Runbook — run these AFTER you have a Fly account + billing set up

Everything CC could prepare is in `deploy/` (two `fly.*.toml`, two Dockerfiles, the
Basic-Auth middleware, the env-driven api URL). This is the exact sequence YOU run.
CC ran none of these (no account). All commands run from the **repo root**.

---

## ⚠️ BEFORE YOU START — cost + safety
- **Fly bills per running machine.** Both apps are set to **scale-to-zero** (`min_machines_running = 0`,
  `auto_stop_machines = "stop"`) so they cost ~nothing when idle and wake on the first request.
- Fly gives a small **free allowance**; two shared-cpu-1x/512mb machines that mostly idle are cheap,
  but **not free forever**.
- ★ **Set a spending limit / billing alert in the Fly dashboard FIRST** (Organization → Billing).
- **Machines start billing at Step 5 (`fly deploy`)** — nothing before that costs money.
- ★ **Anthropic credits:** the deployed api makes REAL LLM calls on **new-deal ingest/extraction** —
  those fail until you top up credits. **Viewing the already-ingested deals (Sunroad/640) needs zero
  credits**, so a read-only demo works without topping up.

## App names
The `.toml` files use `cre-api` / `cre-web`. **These must be globally unique on Fly.** If taken,
rename in BOTH tomls AND the two `cre-api.internal` references (fly.web.toml `build.args` + `[env]`)
to match your api app name.

---

## 0. Install flyctl + log in (free)
```bash
curl -L https://fly.io/install.sh | sh          # installs flyctl
fly auth login                                   # opens the browser
```
Success: `fly auth whoami` prints your email.

## 1. Create the api app (no deploy, no cost yet)
```bash
fly apps create cre-api
```
Success: "New app created: cre-api". Gotcha: if the name is taken, pick another + update the tomls.

## 2. Create the SQLite volume (in the SAME region as the toml's primary_region)
```bash
fly volumes create cre_data --app cre-api --region iad --size 1
```
Success: a volume `cre_data` (1 GB). Gotcha: the region MUST match `primary_region` in fly.api.toml
(`iad` by default) — SQLite is single-region.

## 3. Set the api secrets (free; stored encrypted)
```bash
fly secrets set --app cre-api \
  JWT_SECRET="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY="sk-ant-..."            # your real key (only needed for NEW ingest)
```
Success: "Secrets are staged for the next deployment." ★ The random `JWT_SECRET` replaces the insecure
default — non-negotiable before anyone logs in.

## 4. Deploy the api  ← 💵 machines start here
```bash
fly deploy --config deploy/fly.api.toml
```
Success: build runs (npm ci + better-sqlite3 + tsx), machine boots, health check on `/health` goes
green. Gotchas to watch: (a) it runs via **tsx** (NOT node dist — proven locally); (b) the volume is
mounted at `/app/apps/api/data` so `process.cwd()/data/cre.db` resolves; (c) on the empty volume it
**seeds the 3 users on boot but has NO deals yet** (next step ships them).

## 5. Ship cre.db (the deals) onto the volume
The api seeds users but not deals. To have Sunroad/640, ship your local DB:
```bash
# make a clean snapshot (never cp the live file):
sqlite3 apps/api/data/cre.db ".backup './cre.db.snapshot'"
# stop the machine so nothing holds the DB open, upload, restart:
fly machine list --app cre-api                       # note the machine id
fly machine stop <machine-id> --app cre-api
fly ssh sftp shell --app cre-api                     # then: put ./cre.db.snapshot /app/apps/api/data/cre.db   (then `quit`)
fly machine start <machine-id> --app cre-api
rm ./cre.db.snapshot
```
Success: after restart, `fly logs --app cre-api` shows a clean boot; a later `/pools` read returns the
deals. Gotcha: upload while the machine is **stopped** (avoid a WAL write conflict).

## 6. Create + configure the web app
```bash
fly apps create cre-web
# the private-first Basic-Auth gate (share these creds with your partner):
fly secrets set --app cre-web \
  BASIC_AUTH_USER="isabelle" \
  BASIC_AUTH_PASS="$(openssl rand -base64 12)"    # note the output — you'll need it
# point the api's CORS at the real web URL:
fly secrets set --app cre-api FRONTEND_URL="https://cre-web.fly.dev"
```
Success: secrets staged. Gotcha: if you renamed the apps, fix the `.internal` URL + FRONTEND_URL.

## 7. Deploy the web  ← 💵 second machine
```bash
fly deploy --config deploy/fly.web.toml
```
Success: `next build` runs, machine boots, the public `https://cre-web.fly.dev` is live. The web
proxies `/api/*` to the private `cre-api.internal:3001` (no CORS, api never public).

## 8. Smoke test (over the internet)
Open `https://cre-web.fly.dev`:
1. **Basic-Auth prompt** → enter the BASIC_AUTH_USER / PASS from Step 6. (Proves the private gate.)
2. **App login page** → `admin@cre.com` / `admin123` (or originator@/buyer@). (Proves JWT auth in prod.)
3. Open a deal (Sunroad) → the analysis renders. (Proves the DB + api proxy end-to-end.)

---

## ★ Security checklist — DONE before the URL goes to anyone but you
- [ ] `JWT_SECRET` set to a real random value (Step 3) — not the insecure default.
- [ ] **Rotate the weak dev passwords** (`admin123` / `originator123` / `buyer123`). Easiest: `fly ssh
      console --app cre-api`, then a one-off node/tsx snippet using the store's `bcrypt` to update
      `users.password_hash` — or hand out only a login you've rotated.
- [ ] Basic-Auth gate active (Step 6 secrets set) — the app 401s anonymously.
- [ ] The api has **no public IP** (fly.api.toml has no `[[services.ports]]`; don't run `fly ips
      allocate` on cre-api). Verify: `fly ips list --app cre-api` is empty.

## Teardown (stop billing)
```bash
fly apps destroy cre-web && fly apps destroy cre-api   # removes machines + volume; fully reversible
```

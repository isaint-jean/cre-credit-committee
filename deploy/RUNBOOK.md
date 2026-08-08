# Fly Deploy Runbook — run these AFTER you have a Fly account + billing set up

Everything CC could prepare is in `deploy/` (two `fly.*.toml`, two Dockerfiles, the
Basic-Auth middleware, the env-driven api URL). This is the exact sequence YOU run.
CC ran none of these (no account). All commands run from the **repo root**.

---

## ⚠️ BEFORE YOU START — cost + safety
- **Fly bills per running machine.** The two apps are now deliberately **asymmetric**:
  - **web** — scale-to-zero (`min_machines_running = 0`, `auto_stop_machines = "stop"`). Costs ~nothing
    idle, wakes on the first request.
  - **api** — ★ **always-on** (`min_machines_running = 1`, `auto_stop_machines = "off"`) at
    **shared-cpu-1x / 2GB**. This is the one continuously-billed machine.
- ★ **Why the api is always-on:** it runs a background underwrite queue. Fly's idle-stop counts inbound
  *requests*, so a drain running for minutes with no HTTP traffic looks idle and gets stopped
  mid-underwrite. Jobs are marked INTERRUPTED (not corrupted) but need a manual re-run. If you'd rather
  pay less and accept that, flip `auto_stop_machines = "stop"` + `min_machines_running = 0` in
  `deploy/fly.api.toml`.
- ★ **Why 2GB, not 512MB:** xlsx/PDF/zip extraction is memory-hungry (dev runs with
  `--max-old-space-size=8192`); 512MB OOM-kills on real ingest. Drop `[[vm]] memory` to `1gb` — and
  `NODE_OPTIONS` to `~768` — if the always-on cost matters more than ingest headroom.
- Fly gives a small **free allowance**, but an always-on 2GB machine plus ~5GB of volumes is **not free**.
  Confirm current rates on Fly's pricing page before Step 4 — that's where billing starts.
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

## 2. Create ONE volume (in the SAME region as the toml's primary_region)
★ Fly Machines allow only **ONE volume per machine** — so both trees (the SQLite DB *and* the
document bytes + corpus) share a single volume, `cre_docs`. The DB lives in `.data/db/` on it, via a
symlink baked into the image; the docs + corpus are the volume root. Both survive every redeploy.

```bash
# the document bytes + UW corpus (.data/ is 1.4GB locally: source-docs 1.2G, blobs 243M,
# corpus JSON ~4M) PLUS the SQLite DB in .data/db/ (18MB). 4GB holds all of it, plus the
# upload tarball AND its extraction side-by-side during Step 6.
fly volumes create cre_docs --app cre-api --region iad --size 4
```
Success: `fly volumes list --app cre-api` shows `cre_docs`.

★ If you already created `cre_data` (1GB) from the two-volume attempt, it's now **unused** — destroy it
so it isn't billed:
```bash
fly volumes list --app cre-api                       # note the cre_data volume id
fly volumes destroy <cre_data-volume-id> --app cre-api
```

Gotchas:
- The region MUST match `primary_region` in fly.api.toml (`iad` by default) — SQLite is single-region,
  and a volume in the wrong region simply won't attach.
- The volume name must match `[[mounts]] source` in fly.api.toml exactly (`cre_docs`).
- Going lean? If you skip `.data/source-docs` in Step 6 (1.2G of historical-UW source files, not needed
  to view existing deals), `--size 1` is enough.

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
green. Gotchas to watch: (a) it runs via **tsx** (NOT node dist — proven locally); (b) the single
`cre_docs` volume mounts at cwd `/app/apps/api/.data`, and `data/` is a **symlink → `.data/db`** so
`process.cwd()/data/cre.db` resolves onto the same volume (both DB and docs persist); (c) on an empty
volume it **seeds the 3 users on boot but has NO deals and NO documents yet** — Steps 5 and 6 ship those.
A boot log reading `Loaded 0 historical UWs, 0 learned rules from disk.` is EXPECTED here, not an error:
the corpus arrives in Step 6. Verify the mount with
`fly ssh console --app cre-api --command "df -h /app/apps/api/.data && ls -ld /app/apps/api/data"`
(the volume on `.data`, and `data` shown as a symlink to `.data/db`).

## 5. Ship cre.db (the deals) onto the volume
The api seeds users but not deals. To have Sunroad/640, ship your local DB.

★ **Why staging + swap, not "stop then sftp":** Fly's `sftp` connects to the SSH server running
*inside* the machine, so the machine must be **RUNNING** — you can't `sftp` to a stopped machine.
Instead, upload to a `.new` staging file while the machine is up, then atomically swap it in, clear any
stale WAL, and restart so the app opens the new DB. Safe because the freshly-booted api is idle (no
traffic, no deals yet), so nothing is writing to `cre.db` during the swap; the atomic `mv` + WAL clear
+ restart leave a clean, self-contained DB (the `.backup` snapshot has no WAL of its own).

```bash
# 1) clean snapshot (never cp the live file — the dev server holds it open):
sqlite3 apps/api/data/cre.db ".backup './cre.db.snapshot'"

# 2) upload to a STAGING path (machine stays running — Fly's sftp needs it up):
fly ssh sftp shell --app cre-api                     # then: put ./cre.db.snapshot /app/apps/api/.data/db/cre.db.new   (then `quit`)

# 3) swap it in atomically, clear any stale WAL/SHM, then restart so the app opens the new DB:
fly ssh console --app cre-api --command "sh -lc 'cd /app/apps/api/.data/db && mv -f cre.db.new cre.db && rm -f cre.db-wal cre.db-shm'"
fly machine list --app cre-api                       # note the machine id
fly machine restart <machine-id> --app cre-api

# 4) clean up the local snapshot:
rm ./cre.db.snapshot
```
Success: after the restart, `fly logs --app cre-api` shows a clean boot; a later `/pools` read returns
the deals. Note: the target dir `.data/db/` (where the `data` symlink points) was mkdir'd on the first
boot in Step 4, so it already exists on the volume.

## 6. ★ Ship `.data/` (the document bytes + UW corpus) onto the cre_docs volume
Step 5 shipped the *deals*; this ships the *documents and the learned corpus*. Skip it and the app boots
with `Loaded 0 historical UWs, 0 learned rules` and no document bytes behind the deals.

★ Ship this while the machine is **stopped**, same as Step 5 — `.data/blobs` is written live.

```bash
# 1) tarball the tree locally (1.4GB; ~10-20 min to upload on a home connection)
tar -czf ./dotdata.tgz -C apps/api .data
#    LEAN ALTERNATIVE — skip source-docs (1.2G of historical-UW source files; the existing
#    deals render fine without them). Yields ~250MB:
#    tar -czf ./dotdata.tgz -C apps/api --exclude='.data/source-docs' .data

# 2) stop the machine, upload onto the volume, extract in place, restart
fly machine list --app cre-api                       # note the machine id
fly machine stop <machine-id> --app cre-api
fly ssh sftp shell --app cre-api                     # then: put ./dotdata.tgz /app/apps/api/.data/_import.tgz   (then `quit`)
fly machine start <machine-id> --app cre-api
fly ssh console --app cre-api --command "sh -lc 'cd /app/apps/api && tar -xzf .data/_import.tgz && rm -f .data/_import.tgz'"

# 3) restart so the corpus is re-read at boot, then clean up locally
fly machine restart <machine-id> --app cre-api
rm ./dotdata.tgz
```

Success: `fly logs --app cre-api` now shows **`Loaded 267 historical UWs, 36 learned rules from disk.`**
(instead of `0`/`0`) — that line IS the check that this step worked. Opening a deal's documents returns
bytes rather than 404s.

Gotchas:
- The tarball is staged **on the cre_docs volume itself** (`/app/apps/api/.data/_import.tgz`), which is
  why Step 2 sizes it at 4GB — it must hold the archive and the extraction at once. The `rm` above frees
  it again.
- `tar -C apps/api .data` stores paths as `.data/...`, so extracting from `/app/apps/api` lands them
  exactly on the mount. Don't extract from `/`.
- The corpus is read **once at module load**, so the restart in (3) is required — extracting into a
  running machine won't reload it.
- ★ Re-running this step **overwrites** same-named corpus files with your local copies. Anything
  uploaded in production since the last ship is not in your local `.data/` and will be lost. Ship early,
  before production has state worth keeping.

## 7. Create + configure the web app
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

## 8. Deploy the web  ← 💵 second machine
```bash
fly deploy --config deploy/fly.web.toml
```
Success: `next build` runs, machine boots, the public `https://cre-web.fly.dev` is live. The web
proxies `/api/*` to the private `cre-api.internal:3001` (no CORS, api never public).

## 9. Smoke test (over the internet)
Open `https://cre-web.fly.dev`:
1. **Basic-Auth prompt** → enter the BASIC_AUTH_USER / PASS from Step 7. (Proves the private gate.)
2. **App login page** → `admin@cre.com` / `admin123` (or originator@/buyer@). (Proves JWT auth in prod.)
3. Open a deal (Sunroad) → the analysis renders. (Proves the DB + api proxy end-to-end.)
4. ★ Open a **document** on that deal → bytes load, not a 404. (Proves `.data/blobs` came across in
   Step 6 — the persistence fix. `Loaded 267 historical UWs…` in `fly logs` is the same check.)
5. ★ **Redeploy and re-check** (`fly deploy --config deploy/fly.api.toml`, then reopen the document).
   Surviving a redeploy is the whole point of the two volumes — if documents 404 after a redeploy,
   `cre_docs` is not mounted and Step 2 or the `[[mounts]]` block is wrong.

---

## ★ Security checklist — DONE before the URL goes to anyone but you
- [ ] `JWT_SECRET` set to a real random value (Step 3) — not the insecure default.
- [ ] **Rotate the weak dev passwords** (`admin123` / `originator123` / `buyer123`). Easiest: `fly ssh
      console --app cre-api`, then a one-off node/tsx snippet using the store's `bcrypt` to update
      `users.password_hash` — or hand out only a login you've rotated.
- [ ] Basic-Auth gate active (Step 7 secrets set) — the app 401s anonymously.
- [ ] The api has **no public IP** (fly.api.toml has no `[[services.ports]]`; don't run `fly ips
      allocate` on cre-api). Verify: `fly ips list --app cre-api` is empty.

## Teardown (stop billing)
```bash
fly apps destroy cre-web && fly apps destroy cre-api   # removes machines + BOTH volumes
```
★ Destroying `cre-api` destroys the `cre_docs` volume with it — the SQLite DB (`.data/db`), every
document, and every production-side corpus change go with it. Your local `apps/api/data` + `.data` are
the only other copy, so this is only "reversible" to the state you last shipped in Steps 5-6.

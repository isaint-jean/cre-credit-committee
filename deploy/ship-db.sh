#!/usr/bin/env bash
#
# deploy/ship-db.sh — one-command Step 5: ship cre.db (the deals) onto the cre_docs volume,
# end-to-end and NON-INTERACTIVE. Run from anywhere:
#
#     bash deploy/ship-db.sh
#
# Sequence: sqlite3 .backup snapshot → upload to .data/db/cre.db.new → verify remote size
# → atomic swap + clear WAL → restart the machine → clean up. Fail-fast at every step.
#
# ── Upload method ────────────────────────────────────────────────────────────────────────
# flyctl has NO one-shot `sftp put` (only `sftp get` and the interactive `sftp shell`). So we
# drive the shell non-interactively by piping a `put` command into its stdin — it runs piped
# commands and exits on EOF, no prompt. Because that path is a little unusual, step [3] then
# STATs the uploaded file and refuses to swap unless its size matches the local snapshot — so
# a silent upload failure can never overwrite the good cre.db.
#
# If the piped-shell upload ever misbehaves, the manual fallback (interactive) is:
#     fly ssh sftp shell --app cre-api
#     >>> put ./cre.db.snapshot /app/apps/api/.data/db/cre.db.new
#     >>> quit
# then re-run this script (it will find the size matches and proceed to the swap+restart), or
# run steps [4]/[5] by hand. A second fallback is base64 over the console:
#     base64 < ./cre.db.snapshot | fly ssh console --app cre-api --command "sh -lc 'base64 -d > /app/apps/api/.data/db/cre.db.new'"
# ─────────────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

APP="cre-api"
LOCAL_DB="apps/api/data/cre.db"
SNAPSHOT="./cre.db.snapshot"
REMOTE_DIR="/app/apps/api/.data/db"
REMOTE_NEW="$REMOTE_DIR/cre.db.new"

fail() { echo "❌ ship-db FAILED at: $*" >&2; exit 1; }

# Always run from the repo root (so apps/api/data/cre.db resolves no matter where invoked),
# and always clean up the local snapshot on exit (success or failure).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.." || fail "cd to repo root"
trap 'rm -f "$SNAPSHOT"' EXIT

# 0) sanity ---------------------------------------------------------------------------------
command -v fly     >/dev/null 2>&1 || fail "flyctl not on PATH (install: curl -L https://fly.io/install.sh | sh)"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 not on PATH"
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH (used to parse the machine id)"
[ -f "$LOCAL_DB" ] || fail "local DB not found at $LOCAL_DB"

# 1) clean snapshot — never cp a live DB (the dev server holds it open); .backup is safe -----
echo "→ [1/5] snapshotting $LOCAL_DB via sqlite3 .backup ..."
rm -f "$SNAPSHOT"
sqlite3 "$LOCAL_DB" ".backup '$SNAPSHOT'" || fail "sqlite3 .backup"
LOCAL_SIZE=$(wc -c < "$SNAPSHOT" | tr -d ' ')
[ "${LOCAL_SIZE:-0}" -gt 0 ] || fail "snapshot is empty"
echo "  snapshot OK (${LOCAL_SIZE} bytes)"

# 2) upload NON-INTERACTIVELY to a staging path (machine must be RUNNING for sftp) -----------
echo "→ [2/5] uploading to ${REMOTE_NEW} (non-interactive sftp) ..."
printf 'put %s %s\n' "$SNAPSHOT" "$REMOTE_NEW" | fly ssh sftp shell --app "$APP" || fail "sftp upload"

# 3) VERIFY the upload landed with the right size BEFORE swapping ----------------------------
echo "→ [3/5] verifying remote size ..."
REMOTE_SIZE=$(fly ssh console --app "$APP" --command "stat -c %s $REMOTE_NEW" 2>/dev/null | tr -dc '0-9')
[ "${REMOTE_SIZE:-}" = "$LOCAL_SIZE" ] || fail "size mismatch (local ${LOCAL_SIZE} vs remote '${REMOTE_SIZE:-none}') — NOT swapping, cre.db untouched"
echo "  remote size matches (${REMOTE_SIZE} bytes)"

# 4) atomic swap + clear any stale WAL/SHM (safe: the freshly-booted app is idle) ------------
echo "→ [4/5] swapping in the new DB + clearing WAL ..."
fly ssh console --app "$APP" --command "sh -lc 'cd $REMOTE_DIR && mv -f cre.db.new cre.db && rm -f cre.db-wal cre.db-shm'" || fail "swap"

# 5) restart so the app reopens the fresh DB ------------------------------------------------
echo "→ [5/5] restarting the machine ..."
MACHINE_ID=$(fly machine list --app "$APP" --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")') || fail "machine list"
[ -n "$MACHINE_ID" ] || fail "no machine found for app $APP"
fly machine restart "$MACHINE_ID" --app "$APP" || fail "machine restart"

echo "✅ deals shipped — cre.db swapped in, machine ${MACHINE_ID} restarting."
echo "   Verify:  fly logs --app ${APP}   (clean boot; a /pools read returns Sunroad/640 once the web is up)"

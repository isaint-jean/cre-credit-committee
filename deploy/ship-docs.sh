#!/usr/bin/env bash
#
# deploy/ship-docs.sh — one-command Step 6: ship .data/ (document bytes + UW corpus) onto the
# cre_docs volume, end-to-end and NON-INTERACTIVE. Run from anywhere:
#
#     bash deploy/ship-docs.sh          # LEAN (~250MB): blobs + corpus, SKIPS source-docs
#     bash deploy/ship-docs.sh --full   # FULL (~1.4GB): everything, incl. historical-UW source files
#
# LEAN is enough to (a) view the current deals' documents — those bytes live in .data/blobs — and
# (b) load the "Loaded 267 historical UWs, 36 learned rules" corpus (that's .data/historical-uws.json
# + learned-rules.json, ~4MB, always included). --full ADDITIONALLY ships .data/source-docs (1.2G of
# historical-UW SOURCE files), only needed to drill into those original sources. With Anthropic credits
# exhausted (no new ingest) and a read-only demo in mind, LEAN is the right default.
#
# Sequence: tar .data → upload to .data/_import.tgz → verify remote size → extract in place →
# restart so the corpus re-reads at boot → clean up. Fail-fast at every step.
#
# Upload uses the same non-interactive trick as ship-db.sh (pipe a `put` into `fly ssh sftp shell`;
# flyctl has no one-shot `sftp put`). A remote-size check gates the EXTRACT, so a truncated upload can
# never be unpacked onto the volume. The extract only ADDS the archive's entries (.data/blobs, *.json,
# …); it does NOT touch .data/db/cre.db shipped in Step 5.
#
# Fallbacks if the piped upload ever misbehaves (see ship-db.sh header for detail): interactive
# `fly ssh sftp shell` then `put ./dotdata.tgz /app/apps/api/.data/_import.tgz`, then re-run this
# script (it will size-match and proceed to extract+restart).

set -euo pipefail

APP="cre-api"
MODE="lean"
[ "${1:-}" = "--full" ] && MODE="full"

TARBALL="./dotdata.tgz"
REMOTE_STAGE="/app/apps/api/.data/_import.tgz"

fail() { echo "❌ ship-docs FAILED at: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.." || fail "cd to repo root"
trap 'rm -f "$TARBALL"' EXIT

# 0) sanity ---------------------------------------------------------------------------------
command -v fly     >/dev/null 2>&1 || fail "flyctl not on PATH"
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH (used to parse the machine id)"
[ -d apps/api/.data ] || fail "apps/api/.data not found (nothing to ship)"

# 1) tarball (paths stored as .data/... so they extract onto the mount) ---------------------
echo "→ [1/5] building ${MODE} tarball of apps/api/.data ..."
rm -f "$TARBALL"
if [ "$MODE" = "full" ]; then
  tar -czf "$TARBALL" -C apps/api .data || fail "tar (full)"
else
  tar -czf "$TARBALL" -C apps/api --exclude='.data/source-docs' .data || fail "tar (lean)"
fi
LOCAL_SIZE=$(wc -c < "$TARBALL" | tr -d ' ')
[ "${LOCAL_SIZE:-0}" -gt 0 ] || fail "tarball is empty"
echo "  tarball OK ($((LOCAL_SIZE/1024/1024)) MB)"

# 2) upload NON-INTERACTIVELY to a staging path on the volume (machine must be RUNNING) ------
echo "→ [2/5] uploading to ${REMOTE_STAGE} (can take a while on a home connection) ..."
printf 'put %s %s\n' "$TARBALL" "$REMOTE_STAGE" | fly ssh sftp shell --app "$APP" || fail "sftp upload"

# 3) VERIFY the upload landed intact BEFORE extracting --------------------------------------
echo "→ [3/5] verifying remote size ..."
REMOTE_SIZE=$(fly ssh console --app "$APP" --command "stat -c %s $REMOTE_STAGE" 2>/dev/null | tr -dc '0-9')
[ "${REMOTE_SIZE:-}" = "$LOCAL_SIZE" ] || fail "size mismatch (local ${LOCAL_SIZE} vs remote '${REMOTE_SIZE:-none}') — NOT extracting"
echo "  remote size matches (${REMOTE_SIZE} bytes)"

# 4) extract in place — tar entries are .data/..., so unpack from /app/apps/api -------------
echo "→ [4/5] extracting on the volume ..."
fly ssh console --app "$APP" --command "sh -lc 'cd /app/apps/api && tar -xzf .data/_import.tgz && rm -f .data/_import.tgz'" || fail "extract"

# 5) restart so the corpus is re-read at boot (it loads once at module init) -----------------
echo "→ [5/5] restarting so the corpus reloads ..."
MACHINE_ID=$(fly machine list --app "$APP" --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if d else "")') || fail "machine list"
[ -n "$MACHINE_ID" ] || fail "no machine found for app $APP"
fly machine restart "$MACHINE_ID" --app "$APP" || fail "machine restart"

echo "✅ docs + corpus shipped (${MODE}) — machine ${MACHINE_ID} restarting."
echo "   Verify:  fly logs --app ${APP}   (expect 'Loaded 267 historical UWs, 36 learned rules from disk.')"
echo "   Then opening a deal's document should return bytes, not a 404."

#!/usr/bin/env bash
# Deploy runtime files to a remote host via scp.
#
# Usage:
#   ./deploy/deploy.sh <host> [path]
#
# Args:
#   host  SSH target (required), e.g. user@vps.example.com
#   path  Remote app directory (optional, default: /opt/speculator)
#
# Copies dist/, package.json, pnpm-lock.yaml, .env.example, and
# data/speculator.duckdb (plus .wal if present). Does not overwrite remote .env.
# Stops the speculator service before copying files so DuckDB is not open.
# Runs `pnpm install --prod` on the host after upload, then starts the service.
set -euo pipefail

usage() {
  echo "Usage: $0 <host> [path]" >&2
  echo "  host  SSH target (required), e.g. user@vps.example.com" >&2
  echo "  path  Remote app directory (optional, default: /opt/speculator)" >&2
  exit 1
}

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage
fi

HOST="$1"
REMOTE_PATH="${2:-/opt/speculator}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f package.json || ! -f pnpm-lock.yaml ]]; then
  echo "error: package.json or pnpm-lock.yaml missing in $REPO_ROOT" >&2
  exit 1
fi

echo "Building…"
pnpm build

if [[ ! -d dist ]]; then
  echo "error: dist/ missing after build" >&2
  exit 1
fi

echo "Ensuring remote directory $HOST:$REMOTE_PATH …"
ssh "$HOST" "mkdir -p $(printf '%q' "$REMOTE_PATH")"

echo "Stopping speculator so files (including DuckDB) can be copied…"
ssh "$HOST" "sudo systemctl stop speculator || true"

echo "Uploading runtime files…"
# Replace dist/ atomically-ish: upload to dist.new then swap on the host.
ssh "$HOST" "rm -rf $(printf '%q' "$REMOTE_PATH/dist.new")"
scp -r dist "$HOST:$REMOTE_PATH/dist.new"
ssh "$HOST" "rm -rf $(printf '%q' "$REMOTE_PATH/dist") && mv $(printf '%q' "$REMOTE_PATH/dist.new") $(printf '%q' "$REMOTE_PATH/dist")"

scp package.json pnpm-lock.yaml .env.example "$HOST:$REMOTE_PATH/"

LOCAL_DB="data/speculator.duckdb"
if [[ -f "$LOCAL_DB" ]]; then
  echo "Uploading $LOCAL_DB…"
  ssh "$HOST" "mkdir -p $(printf '%q' "$REMOTE_PATH/data")"
  scp "$LOCAL_DB" "$HOST:$REMOTE_PATH/data/speculator.duckdb"
  if [[ -f "${LOCAL_DB}.wal" ]]; then
    scp "${LOCAL_DB}.wal" "$HOST:$REMOTE_PATH/data/speculator.duckdb.wal"
  else
    # Do not leave a stale WAL next to a replaced database file.
    ssh "$HOST" "rm -f $(printf '%q' "$REMOTE_PATH/data/speculator.duckdb.wal")"
  fi
else
  echo "No local $LOCAL_DB — skipping DuckDB copy"
fi

echo "Installing production dependencies on host…"
ssh "$HOST" bash -s -- "$REMOTE_PATH" <<'REMOTE'
set -euo pipefail
target="$1"
cd "$target"

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created $target/.env from .env.example — edit secrets before starting."
else
  echo "Preserved existing $target/.env"
fi

pnpm install --prod --dir "$target"
echo "Runtime deployed at $target"
REMOTE

echo "Starting speculator service…"
ssh "$HOST" "sudo systemctl start speculator"
echo "Deploy complete."

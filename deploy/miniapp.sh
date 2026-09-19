#!/usr/bin/env bash
# Deploy the Telegram Mini App (SPA + HTTP server) to a remote host via scp.
#
# Usage:
#   ./deploy/miniapp.sh <host> [path]
#
# Args:
#   host  SSH target (required), e.g. user@vps.example.com
#   path  Remote app directory (optional, default: /opt/speculator)
#
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

echo "Building Mini App UI…"
pnpm web:build

if [[ ! -d web/dist ]]; then
  echo "error: web/dist missing after web:build" >&2
  exit 1
fi

echo "Building Mini App server…"
pnpm server:build

WEB_BIN="$REPO_ROOT/server/target/release/speculator-web"
if [[ ! -x "$WEB_BIN" ]]; then
  echo "error: $WEB_BIN missing after server:build" >&2
  exit 1
fi

echo "Ensuring remote group/user and directory $HOST:$REMOTE_PATH …"
ssh "$HOST" "sudo bash -s -- $(printf '%q' "$REMOTE_PATH")" <<'REMOTE'
set -euo pipefail
target="$1"

if ! getent group speculator >/dev/null; then
  groupadd --system speculator
  echo "Created group speculator"
fi

if ! getent passwd miniapp >/dev/null; then
  useradd --system --gid speculator --home-dir "$target" --no-create-home --shell /usr/sbin/nologin miniapp
  echo "Created user miniapp"
fi

if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  usermod -aG speculator "$SUDO_USER"
fi
REMOTE

ssh "$HOST" "mkdir -p $(printf '%q' "$REMOTE_PATH/bin")"

echo "Uploading Mini App SPA…"
ssh "$HOST" "rm -rf $(printf '%q' "$REMOTE_PATH/web.new")"
ssh "$HOST" "mkdir -p $(printf '%q' "$REMOTE_PATH/web.new")"
scp -r web/dist "$HOST:$REMOTE_PATH/web.new/dist"

echo "Uploading Mini App binary…"
scp "$WEB_BIN" "$HOST:$REMOTE_PATH/bin/server.new"

scp .env.example "$HOST:$REMOTE_PATH/"
scp deploy/miniapp.service "$HOST:$REMOTE_PATH/"

echo "Swapping files, fixing ownership, installing miniapp.service…"
ssh "$HOST" "sudo bash -s -- $(printf '%q' "$REMOTE_PATH")" <<'REMOTE'
set -euo pipefail
target="$1"
cd "$target"

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 640 .env
  echo "Created $target/.env from .env.example — edit secrets before starting."
else
  echo "Preserved existing $target/.env"
fi

rm -rf web
mv web.new web

chmod +x bin/server.new
mv bin/server.new bin/server

chown miniapp:speculator .env.example
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  chown "$SUDO_USER":speculator .env
else
  chown miniapp:speculator .env
fi
chmod 640 .env
chown -R miniapp:speculator web bin
chmod 0755 bin/server

install -m 0644 miniapp.service /etc/systemd/system/miniapp.service
systemctl daemon-reload
systemctl disable --now speculator-web 2>/dev/null || true
systemctl enable miniapp
systemctl restart miniapp
REMOTE

echo "Mini App deploy complete."
echo "Logs: journalctl -u miniapp -f"

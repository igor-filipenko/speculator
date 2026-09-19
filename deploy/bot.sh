#!/usr/bin/env bash
# Deploy the trading bot runtime to a remote host via scp.
#
# Usage:
#   ./deploy/bot.sh <host> [path]
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

if [[ ! -f package.json || ! -f pnpm-lock.yaml ]]; then
  echo "error: package.json or pnpm-lock.yaml missing in $REPO_ROOT" >&2
  exit 1
fi

if [[ ! -d migrations ]]; then
  echo "error: migrations/ missing in $REPO_ROOT" >&2
  exit 1
fi

echo "Building bot…"
pnpm build

if [[ ! -d dist ]]; then
  echo "error: dist/ missing after build" >&2
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

if ! getent passwd bot >/dev/null; then
  useradd --system --gid speculator --home-dir "$target" --no-create-home --shell /usr/sbin/nologin bot
  echo "Created user bot"
fi

if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  usermod -aG speculator "$SUDO_USER"
fi
REMOTE

ssh "$HOST" "mkdir -p $(printf '%q' "$REMOTE_PATH")"

echo "Uploading bot runtime…"
ssh "$HOST" "rm -rf $(printf '%q' "$REMOTE_PATH/dist.new")"
scp -r dist "$HOST:$REMOTE_PATH/dist.new"

echo "Uploading migrations…"
ssh "$HOST" "rm -rf $(printf '%q' "$REMOTE_PATH/migrations.new")"
scp -r migrations "$HOST:$REMOTE_PATH/migrations.new"

scp package.json pnpm-lock.yaml .env.example "$HOST:$REMOTE_PATH/"
scp deploy/bot.service "$HOST:$REMOTE_PATH/"

echo "Installing production dependencies on host…"
ssh "$HOST" bash -s -- "$REMOTE_PATH" <<'REMOTE'
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

if [[ -d node_modules ]]; then
  sudo chown -R "$(id -u):$(id -g)" node_modules
fi

pnpm install --prod --dir "$target"
echo "Bot runtime deployed at $target"
REMOTE

echo "Swapping files, fixing ownership, installing bot.service…"
ssh "$HOST" "sudo bash -s -- $(printf '%q' "$REMOTE_PATH")" <<'REMOTE'
set -euo pipefail
target="$1"
cd "$target"

rm -rf dist
mv dist.new dist

rm -rf migrations
mv migrations.new migrations

chown -R bot:speculator dist migrations node_modules package.json pnpm-lock.yaml .env.example
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  chown "$SUDO_USER":speculator .env
else
  chown bot:speculator .env
fi
chmod 640 .env

install -m 0644 bot.service /etc/systemd/system/bot.service
systemctl daemon-reload
systemctl disable --now speculator 2>/dev/null || true
systemctl enable bot
systemctl restart bot
REMOTE

echo "Bot deploy complete."
echo "Logs: journalctl -u bot -f"
echo "After first deploy, set secrets in $REMOTE_PATH/.env and run: ssh $HOST 'cd $REMOTE_PATH && pnpm migrate'"

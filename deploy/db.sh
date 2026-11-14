#!/usr/bin/env bash
# Copy the TimescaleDB installer to a remote host and run it.
#
# Usage:
#   SPECULATOR_PASSWORD='…' ./deploy/db.sh <host>
#
# Remote TLS on port 5432 (sslmode=require):
#   SPECULATOR_PASSWORD='…' SPECULATOR_DB_PUBLIC=1 ./deploy/db.sh <host>
#
# Args:
#   host  SSH target (required), e.g. user@vps.example.com
#
# Environment:
#   SPECULATOR_PASSWORD  required password for role speculator
#   SPECULATOR_DB_PUBLIC 1 to allow remote TLS connections
#   SPECULATOR_DB_HOST   hostname written for remote clients (default: SSH host)
#
set -euo pipefail

usage() {
  echo "Usage: SPECULATOR_PASSWORD='…' $0 <host>" >&2
  echo "  host  SSH target (required), e.g. user@vps.example.com" >&2
  echo "  SPECULATOR_DB_PUBLIC=1  allow remote TLS connections on port 5432" >&2
  echo "  SPECULATOR_DB_HOST      hostname for remote clients (default: SSH host)" >&2
  exit 1
}

if [[ $# -ne 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage
fi

if [[ -z "${SPECULATOR_PASSWORD:-}" ]]; then
  echo "error: set SPECULATOR_PASSWORD" >&2
  exit 1
fi
if [[ "$SPECULATOR_PASSWORD" == *$'\n'* || "$SPECULATOR_PASSWORD" == *$'\r'* ]]; then
  echo "error: SPECULATOR_PASSWORD must be a single line" >&2
  exit 1
fi

HOST="$1"
case "${SPECULATOR_DB_PUBLIC:-0}" in
  1 | true | TRUE | yes | YES | on | ON) PUBLIC=1 ;;
  0 | false | FALSE | no | NO | off | OFF | "") PUBLIC=0 ;;
  *)
    echo "error: SPECULATOR_DB_PUBLIC must be 1 or 0" >&2
    exit 1
    ;;
esac

SSH_HOST="${HOST#*@}"
DB_HOST="${SPECULATOR_DB_HOST:-$SSH_HOST}"
if [[ "$PUBLIC" -eq 1 && -z "$DB_HOST" ]]; then
  echo "error: set SPECULATOR_DB_HOST" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/timescaledb.sh"
if [[ ! -f "$INSTALLER" ]]; then
  echo "error: $INSTALLER is missing" >&2
  exit 1
fi

PASSWORD_Q="$(printf '%q' "$SPECULATOR_PASSWORD")"
PUBLIC_Q="$(printf '%q' "$PUBLIC")"
DB_HOST_Q="$(printf '%q' "$DB_HOST")"

echo "Uploading TimescaleDB installer to $HOST …"
scp "$INSTALLER" "$HOST:.timescaledb-install.sh"

echo "Installing TimescaleDB on $HOST …"
# $HOME expands on the remote before sudo. The heredoc stays unquoted so the
# locally quoted password is embedded; \$ keeps remote parameter expansion.
# shellcheck disable=SC2087
ssh "$HOST" "sudo bash -s -- \"\$HOME/.timescaledb-install.sh\"" <<EOF
set -euo pipefail
src="\$1"
install -m 0700 "\$src" /root/timescaledb.sh
rm -f "\$src"
export SPECULATOR_PASSWORD=$PASSWORD_Q
export SPECULATOR_DB_PUBLIC=$PUBLIC_Q
export SPECULATOR_DB_HOST=$DB_HOST_Q
exec bash /root/timescaledb.sh
EOF

echo "TimescaleDB install finished on $HOST."
echo "Local app URL: /root/speculator-database-url"
if [[ "$PUBLIC" -eq 1 ]]; then
  echo "Remote TLS: ${DB_HOST}:5432 sslmode=require user speculator"
fi

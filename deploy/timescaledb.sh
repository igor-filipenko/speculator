#!/usr/bin/env bash
# Install TimescaleDB on Ubuntu and create the speculator role and database.
#
# This file is copied to the VPS and run as root. It does not read the git checkout.
# Ubuntu steps: https://www.tigerdata.com/docs/get-started/choose-your-path/install-timescaledb
# PostgreSQL 18 matches docker-compose.yml (timescale/timescaledb pg18).
#
# Usage:
#   sudo SPECULATOR_PASSWORD='…' ./timescaledb.sh
#
# Environment:
#   SPECULATOR_PASSWORD   required login password for role speculator
#   SPECULATOR_DB_PUBLIC  1 opens port 5432 on all interfaces; remote clients must use TLS
#   SPECULATOR_DB_HOST    hostname for the remote URL when SPECULATOR_DB_PUBLIC=1
#
# Writes /root/speculator-database-url (mode 600). DATABASE_URL there is the local app URL.
#
set -euo pipefail

PG_MAJOR=18
SECRET_FILE="${SECRET_FILE:-/root/speculator-database-url}"

tmp_files=()
PSQL=""
PG_ISREADY=""
PUBLIC=0
cleanup() {
  local f
  for f in "${tmp_files[@]}"; do
    rm -rf "$f"
  done
}
trap cleanup EXIT

usage() {
  echo "Usage: sudo SPECULATOR_PASSWORD='…' $0" >&2
  echo "  SPECULATOR_PASSWORD   required password for role speculator" >&2
  echo "  SPECULATOR_DB_PUBLIC  1 to allow remote TLS connections on port 5432" >&2
  echo "  SPECULATOR_DB_HOST    hostname stored for remote clients when public access is on" >&2
  exit 1
}

sql_quote() {
  local s=$1
  s=${s//\'/\'\'}
  printf "'%s'" "$s"
}

urlencode() {
  local s=$1
  local i c
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9.~_-]) printf '%s' "$c" ;;
      *) printf '%%%02X' "'$c" ;;
    esac
  done
}

as_postgres() {
  runuser -u postgres -- "$@"
}

require_ubuntu_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: run as root: sudo SPECULATOR_PASSWORD='…' $0" >&2
    exit 1
  fi
  if [[ ! -f /etc/os-release ]]; then
    echo "error: /etc/os-release is missing; this script supports Ubuntu" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "error: this script supports Ubuntu (found ID=${ID:-unknown})" >&2
    exit 1
  fi
}

require_password() {
  if [[ -z "${SPECULATOR_PASSWORD:-}" ]]; then
    echo "error: set SPECULATOR_PASSWORD" >&2
    exit 1
  fi
  if [[ "$SPECULATOR_PASSWORD" == *$'\n'* || "$SPECULATOR_PASSWORD" == *$'\r'* ]]; then
    echo "error: SPECULATOR_PASSWORD must be a single line" >&2
    exit 1
  fi
}

parse_public() {
  case "${SPECULATOR_DB_PUBLIC:-0}" in
    1 | true | TRUE | yes | YES | on | ON) PUBLIC=1 ;;
    0 | false | FALSE | no | NO | off | OFF | "") PUBLIC=0 ;;
    *)
      echo "error: SPECULATOR_DB_PUBLIC must be 1 or 0" >&2
      exit 1
      ;;
  esac
  if [[ "$PUBLIC" -eq 1 && -z "${SPECULATOR_DB_HOST:-}" ]]; then
    echo "error: set SPECULATOR_DB_HOST when SPECULATOR_DB_PUBLIC=1" >&2
    exit 1
  fi
  if [[ "$PUBLIC" -eq 1 && "${SPECULATOR_DB_HOST}" == *[@/\ ]* ]]; then
    echo "error: SPECULATOR_DB_HOST must be a hostname or address" >&2
    exit 1
  fi
}

refuse_other_postgres() {
  local path version
  [[ -d /etc/postgresql ]] || return 0
  for path in /etc/postgresql/*; do
    [[ -d "$path" ]] || continue
    version="$(basename "$path")"
    if [[ "$version" != "$PG_MAJOR" ]]; then
      echo "error: PostgreSQL ${version} is already installed in ${path}." >&2
      echo "Remove other major versions before installing TimescaleDB." >&2
      exit 1
    fi
  done
}

install_timescaledb() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    gnupg postgresql-common apt-transport-https lsb-release wget ca-certificates ssl-cert
  YES=yes /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y

  local codename
  codename="$(lsb_release -c -s)"
  echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ ${codename} main" \
    > /etc/apt/sources.list.d/timescaledb.list
  rm -f /etc/apt/trusted.gpg.d/timescaledb.gpg
  wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
    | gpg --batch --yes --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg
  apt-get update
  apt-get install -y \
    "timescaledb-2-postgresql-${PG_MAJOR}" \
    "postgresql-client-${PG_MAJOR}" \
    timescaledb-tools

  local groups
  groups="$(id -nG postgres)"
  if [[ " $groups " != *" ssl-cert "* ]]; then
    usermod -aG ssl-cert postgres
  fi

  PSQL="$(command -v psql)"
  PG_ISREADY="$(command -v pg_isready)"
  if [[ -z "$PSQL" || -z "$PG_ISREADY" ]]; then
    echo "error: psql or pg_isready is not on PATH" >&2
    exit 1
  fi
}

write_listen_conf() {
  local conf_dir="/etc/postgresql/${PG_MAJOR}/main"
  local snippet="${conf_dir}/conf.d/00-speculator.conf"
  install -d -o postgres -g postgres -m 755 "${conf_dir}/conf.d"
  if [[ "$PUBLIC" -eq 1 ]]; then
    if [[ ! -f /etc/ssl/certs/ssl-cert-snakeoil.pem || ! -f /etc/ssl/private/ssl-cert-snakeoil.key ]]; then
      echo "error: Ubuntu snakeoil TLS certificate is missing" >&2
      exit 1
    fi
    cat > "$snippet" <<'EOF'
# speculator: remote clients must use TLS. Local apps keep using 127.0.0.1.
listen_addresses = '*'
ssl = on
ssl_min_protocol_version = 'TLSv1.2'
ssl_cert_file = '/etc/ssl/certs/ssl-cert-snakeoil.pem'
ssl_key_file = '/etc/ssl/private/ssl-cert-snakeoil.key'
EOF
  else
    cat > "$snippet" <<'EOF'
# speculator: the bot and Mini App connect over the loopback interface.
listen_addresses = 'localhost'
EOF
  fi
  chown postgres:postgres "$snippet"
  chmod 644 "$snippet"
}

update_pg_hba() {
  local hba="/etc/postgresql/${PG_MAJOR}/main/pg_hba.conf"
  local tmp
  tmp="$(mktemp)"
  tmp_files+=("$tmp")
  awk '
    /^# BEGIN speculator$/ { skip = 1; next }
    /^# END speculator$/ { skip = 0; next }
    skip { next }
    { print }
  ' "$hba" > "$tmp"
  if [[ "$PUBLIC" -eq 1 ]]; then
    cat >> "$tmp" <<'EOF'
# BEGIN speculator
hostssl speculator speculator 0.0.0.0/0 scram-sha-256
hostssl speculator speculator ::/0 scram-sha-256
# END speculator
EOF
  fi
  cat "$tmp" > "$hba"
  chown postgres:postgres "$hba"
  chmod 640 "$hba"
}

configure_and_restart() {
  local conf="/etc/postgresql/${PG_MAJOR}/main/postgresql.conf"
  if [[ ! -f "$conf" ]]; then
    echo "error: expected ${conf} after package install" >&2
    exit 1
  fi
  timescaledb-tune --yes --quiet --conf-path="$conf"
  write_listen_conf
  update_pg_hba
  systemctl enable postgresql
  systemctl restart postgresql

  local attempt preload listen_addresses ssl_on
  for attempt in $(seq 1 30); do
    if as_postgres "$PG_ISREADY" -q; then
      break
    fi
    if [[ "$attempt" -eq 30 ]]; then
      echo "error: PostgreSQL did not become ready" >&2
      exit 1
    fi
    sleep 1
  done

  preload="$(as_postgres "$PSQL" --no-psqlrc -d postgres -tAc "SHOW shared_preload_libraries")"
  preload="${preload//[[:space:]]/}"
  if [[ "$preload" != *timescaledb* ]]; then
    echo "error: shared_preload_libraries is '${preload}' after timescaledb-tune" >&2
    exit 1
  fi

  if [[ "$PUBLIC" -eq 1 ]]; then
    listen_addresses="$(as_postgres "$PSQL" --no-psqlrc -d postgres -tAc "SHOW listen_addresses")"
    listen_addresses="${listen_addresses//[[:space:]]/}"
    ssl_on="$(as_postgres "$PSQL" --no-psqlrc -d postgres -tAc "SHOW ssl")"
    ssl_on="${ssl_on//[[:space:]]/}"
    if [[ "$listen_addresses" != "*" || "$ssl_on" != "on" ]]; then
      echo "error: public TLS is not active (listen_addresses=${listen_addresses}, ssl=${ssl_on})" >&2
      exit 1
    fi
  fi
}

write_role_sql() {
  local path=$1
  local quoted
  quoted="$(sql_quote "$SPECULATOR_PASSWORD")"
  {
    printf '\\o /dev/null\n'
    printf "SELECT format('CREATE ROLE speculator LOGIN PASSWORD %%L', %s)\n" "$quoted"
    printf "WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'speculator');\n"
    printf '\\gexec\n'
    printf "SELECT format('ALTER ROLE speculator WITH LOGIN PASSWORD %%L', %s)\n" "$quoted"
    printf "WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'speculator');\n"
    printf '\\gexec\n'
    printf '\\o\n'
  } > "$path"
}

write_database_sql() {
  local path=$1
  {
    printf "SELECT 'CREATE DATABASE speculator OWNER speculator'\n"
    printf "WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'speculator');\n"
    printf '\\gexec\n'
  } > "$path"
}

run_sql_file() {
  local path=$1
  chown postgres:postgres "$path"
  chmod 600 "$path"
  as_postgres "$PSQL" --no-psqlrc -d postgres -v ON_ERROR_STOP=1 -f "$path"
}

write_secret_file() {
  local url_host=$1
  local local_url remote_url
  local_url="postgres://speculator:$(urlencode "$SPECULATOR_PASSWORD")@127.0.0.1:5432/speculator?sslmode=prefer"
  umask 077
  {
    printf 'DATABASE_URL=%s\n' "$local_url"
    if [[ "$PUBLIC" -eq 1 ]]; then
      if [[ "$url_host" == *:* && "$url_host" != \[*\] ]]; then
        url_host="[${url_host}]"
      fi
      remote_url="postgres://speculator:$(urlencode "$SPECULATOR_PASSWORD")@${url_host}:5432/speculator?sslmode=require"
      printf 'REMOTE_DATABASE_URL=%s\n' "$remote_url"
    fi
  } > "$SECRET_FILE"
  umask 022
  chown root:root "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
}

prepare_role_and_database() {
  local sql_file owner
  sql_file="$(mktemp)"
  tmp_files+=("$sql_file")
  write_role_sql "$sql_file"
  run_sql_file "$sql_file"

  sql_file="$(mktemp)"
  tmp_files+=("$sql_file")
  write_database_sql "$sql_file"
  run_sql_file "$sql_file"

  owner="$(as_postgres "$PSQL" --no-psqlrc -d postgres -tAc "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = 'speculator'")"
  owner="${owner//[[:space:]]/}"
  if [[ "$owner" != "speculator" ]]; then
    echo "error: database speculator is owned by ${owner}; this script keeps ownership with speculator" >&2
    exit 1
  fi

  as_postgres "$PSQL" --no-psqlrc -d speculator -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
  write_secret_file "${SPECULATOR_DB_HOST:-127.0.0.1}"

  PGPASSWORD="$SPECULATOR_PASSWORD" "$PSQL" --no-psqlrc \
    -h 127.0.0.1 -U speculator -d speculator \
    -v ON_ERROR_STOP=1 -c "SELECT current_user;" >/dev/null
}

apply_firewall() {
  local ufw_status
  if ! command -v ufw >/dev/null 2>&1; then
    if [[ "$PUBLIC" -eq 1 ]]; then
      echo "ufw is not installed. Allow TCP 5432 on the host firewall for remote clients."
    fi
    return 0
  fi
  ufw_status="$(ufw status)"
  if [[ "$ufw_status" != *"Status: active"* ]]; then
    if [[ "$PUBLIC" -eq 1 ]]; then
      echo "ufw is inactive. Allow TCP 5432 on the host firewall for remote clients."
    fi
    return 0
  fi
  if [[ "$PUBLIC" -eq 1 ]]; then
    ufw allow 5432/tcp comment 'speculator timescaledb'
  else
    ufw --force delete allow 5432/tcp >/dev/null 2>&1 || true
  fi
}

main() {
  if [[ $# -gt 0 ]]; then
    usage
  fi
  require_ubuntu_root
  require_password
  parse_public
  refuse_other_postgres
  install_timescaledb
  configure_and_restart
  prepare_role_and_database
  apply_firewall
  echo "TimescaleDB is installed. Role and database speculator are ready."
  echo "Local app URL is in ${SECRET_FILE}."
  if [[ "$PUBLIC" -eq 1 ]]; then
    echo "Remote TLS is on for ${SPECULATOR_DB_HOST}:5432 (sslmode=require, user speculator)."
  else
    echo "PostgreSQL is listening on 127.0.0.1."
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

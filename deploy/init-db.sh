#!/bin/bash
# init-db.sh — Initialize the messages table on a managed MySQL database
# Run once from any machine with mysql client installed:
#   bash deploy/init-db.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

load_env

if ! command -v mysql &>/dev/null; then
    err "mysql client not found. Install it:"
    err "  sudo apt-get install -y mysql-client"
    exit 1
fi

log "Connecting to managed MySQL at ${MYSQL_HOST}:${MYSQL_PORT:-3306}..."

# Strip CREATE DATABASE and USE lines (managed DBs handle this via dashboard)
# Only run the CREATE TABLE statement
SQL=$(grep -v "^CREATE DATABASE" "$PROJECT_DIR/sql/init.sql" | grep -v "^USE ")

echo "$SQL" | mysql \
    -h "${MYSQL_HOST}" \
    -P "${MYSQL_PORT:-3306}" \
    -u "${MYSQL_USER}" \
    -p"${MYSQL_PASSWORD}" \
    "${MYSQL_DATABASE}"

log "Database initialized! Table 'messages' created in '${MYSQL_DATABASE}'."

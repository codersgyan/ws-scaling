#!/bin/bash
# teardown.sh — Stop and remove a deployed container
# Run: sudo bash deploy/teardown.sh <caddy|nats|ws-server> [--purge]

set -euo pipefail

USAGE="Usage: sudo bash deploy/teardown.sh <caddy|nats|ws-server|mysql> [--purge]"

if [[ $# -lt 1 ]]; then
    echo "$USAGE"
    exit 1
fi

ROLE="$1"
PURGE="${2:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

case "$ROLE" in
    caddy)
        CONTAINER="ws-caddy"
        IMAGE="caddy:2-alpine"
        ;;
    nats)
        CONTAINER="ws-nats"
        IMAGE="nats:2-alpine"
        ;;
    ws-server)
        CONTAINER="ws-server"
        IMAGE="ws-chat-server:latest"
        ;;
    mysql)
        CONTAINER="ws-mysql"
        IMAGE="mysql:8"
        ;;
    *)
        echo "$USAGE"
        echo "Valid roles: caddy, nats, ws-server, mysql"
        exit 1
        ;;
esac

# Stop and remove container
if docker ps -a --filter name="$CONTAINER" --format '{{.Names}}' | grep -q "$CONTAINER"; then
    log "Stopping $CONTAINER..."
    docker stop "$CONTAINER"
    docker rm "$CONTAINER"
    log "$CONTAINER removed"
else
    warn "$CONTAINER not found"
fi

# Purge image and volumes if requested
if [[ "$PURGE" == "--purge" ]]; then
    log "Removing image $IMAGE..."
    docker rmi "$IMAGE" 2>/dev/null || true

    if [[ "$ROLE" == "caddy" ]]; then
        warn "Removing caddy_data volume (TLS certificates will be lost)..."
        docker volume rm caddy_data 2>/dev/null || true
    fi

    if [[ "$ROLE" == "mysql" ]]; then
        warn "Removing mysql_data volume (ALL DATABASE DATA WILL BE LOST)..."
        docker volume rm mysql_data 2>/dev/null || true
    fi

    log "Purge complete"
fi

echo ""
log "Teardown of $ROLE complete."

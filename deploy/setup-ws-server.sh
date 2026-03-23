#!/bin/bash
# setup-ws-server.sh — Set up a WebSocket server instance
# Run: sudo bash deploy/setup-ws-server.sh <1|2|3>

set -euo pipefail

if [[ $# -ne 1 ]] || [[ ! "$1" =~ ^[1-3]$ ]]; then
    echo "Usage: sudo bash deploy/setup-ws-server.sh <1|2|3>"
    echo "  1 = ws-server-1 (run on VM 3)"
    echo "  2 = ws-server-2 (run on VM 4)"
    echo "  3 = ws-server-3 (run on VM 5)"
    exit 1
fi

SERVER_NUM="$1"
SERVER_ID="ws-server-${SERVER_NUM}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

load_env
update_system
ensure_docker
apply_sysctl_tuning
apply_ulimit_tuning

# Build the server image
log "Building Docker image from server/Dockerfile..."
docker build -t ws-chat-server:latest "$PROJECT_DIR/server"

# Stop existing container if running
docker rm -f ws-server 2>/dev/null || true

# Run the server
log "Starting ${SERVER_ID}..."
docker run -d \
    --name ws-server \
    --restart unless-stopped \
    --ulimit nofile=65535:65535 \
    --stop-timeout 15 \
    --log-opt max-size=50m \
    --log-opt max-file=3 \
    -p 8080:8080 \
    -e SERVER_ID="${SERVER_ID}" \
    -e PORT=8080 \
    -e NATS_URL="nats://${NATS_VM_IP}:4222" \
    -e MYSQL_HOST="${MYSQL_HOST}" \
    -e MYSQL_PORT="${MYSQL_PORT:-3306}" \
    -e MYSQL_USER="${MYSQL_USER}" \
    -e MYSQL_PASSWORD="${MYSQL_PASSWORD}" \
    -e MYSQL_DATABASE="${MYSQL_DATABASE:-wschat}" \
    -e MYSQL_SSL="${MYSQL_SSL:-false}" \
    ws-chat-server:latest

# Wait and verify
sleep 3

if docker ps --filter name=ws-server --format '{{.Status}}' | grep -q "Up"; then
    log "${SERVER_ID} is running on port 8080"
    echo ""
    log "Recent logs:"
    docker logs --tail 15 ws-server
else
    err "${SERVER_ID} failed to start. Check logs:"
    docker logs ws-server
    exit 1
fi

CADDY_VM_IP="${CADDY_VM_IP:-<CADDY_VM_IP>}"

echo ""
log "=== Suggested Firewall Rules ==="
echo "  sudo ufw allow from ${CADDY_VM_IP} to any port 8080"
echo "  sudo ufw allow 22/tcp    # SSH"
echo "  sudo ufw default deny incoming"
echo "  sudo ufw enable"

echo ""
log "Done! ${SERVER_ID} is ready."

#!/bin/bash
# setup-nats.sh — Set up NATS message broker
# Run: sudo bash deploy/setup-nats.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

load_env
update_system
ensure_docker
apply_sysctl_tuning

# Stop existing container if running
docker rm -f ws-nats 2>/dev/null || true

# Run NATS
log "Starting NATS container..."
docker run -d \
    --name ws-nats \
    --restart unless-stopped \
    --ulimit nofile=65535:65535 \
    -p 4222:4222 \
    -p 8222:8222 \
    nats:2-alpine \
    --max_connections 10000 \
    --max_payload 1048576

# Wait and verify
sleep 2

if docker ps --filter name=ws-nats --format '{{.Status}}' | grep -q "Up"; then
    log "NATS is running on port 4222"
    log "NATS monitoring available on port 8222"
else
    err "NATS container failed to start. Check logs:"
    docker logs ws-nats
    exit 1
fi

echo ""
log "=== Suggested Firewall Rules ==="
echo "  sudo ufw allow from ${WS_VM_1_IP} to any port 4222"
echo "  sudo ufw allow from ${WS_VM_2_IP} to any port 4222"
echo "  sudo ufw allow from ${WS_VM_3_IP} to any port 4222"
echo "  sudo ufw allow 22/tcp    # SSH"
echo "  sudo ufw default deny incoming"
echo "  sudo ufw enable"

echo ""
log "Done!"

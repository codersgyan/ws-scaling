#!/bin/bash
# setup-caddy.sh — Set up Caddy reverse proxy with automatic HTTPS
# Run: sudo bash deploy/setup-caddy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

load_env
update_system
ensure_docker
apply_sysctl_tuning

# Generate Caddyfile from template
log "Generating Caddyfile..."
sed \
    -e "s/__DOMAIN__/${DOMAIN}/g" \
    -e "s/__WS_VM_1_IP__/${WS_VM_1_IP}/g" \
    -e "s/__WS_VM_2_IP__/${WS_VM_2_IP}/g" \
    -e "s/__WS_VM_3_IP__/${WS_VM_3_IP}/g" \
    "$SCRIPT_DIR/Caddyfile.template" > /tmp/Caddyfile

log "Generated Caddyfile:"
cat /tmp/Caddyfile
echo ""

# Create persistent volume for TLS certificates
docker volume create caddy_data > /dev/null 2>&1 || true

# Stop existing container if running
docker rm -f ws-caddy 2>/dev/null || true

# Run Caddy
log "Starting Caddy container..."
docker run -d \
    --name ws-caddy \
    --restart unless-stopped \
    --ulimit nofile=65535:65535 \
    -p 80:80 \
    -p 443:443 \
    -v caddy_data:/data \
    -v /tmp/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v "$PROJECT_DIR/client":/srv/client:ro \
    caddy:2-alpine

# Wait for container to start
sleep 3

if docker ps --filter name=ws-caddy --format '{{.Status}}' | grep -q "Up"; then
    log "Caddy is running!"
    log "Caddy will auto-provision SSL for ${DOMAIN}"
    log "Make sure DNS A record for ${DOMAIN} points to this VM's public IP"
else
    err "Caddy container failed to start. Check logs:"
    docker logs ws-caddy
    exit 1
fi

echo ""
log "=== Suggested Firewall Rules ==="
echo "  sudo ufw allow 80/tcp    # Let's Encrypt + HTTP redirect"
echo "  sudo ufw allow 443/tcp   # HTTPS"
echo "  sudo ufw allow 22/tcp    # SSH"
echo "  sudo ufw default deny incoming"
echo "  sudo ufw enable"

echo ""
log "Done! Access your app at https://${DOMAIN}"

#!/bin/bash
# setup-loadtest.sh — Set up the load testing VM
# Run: sudo bash deploy/setup-loadtest.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

load_env DOMAIN
update_system
ensure_docker
apply_sysctl_tuning
apply_ulimit_tuning

# Build the load test image
log "Building load test Docker image..."
docker build -t ws-load-test:latest "$PROJECT_DIR/scripts"

log "Load test image built successfully!"

echo ""
log "=== Usage ==="
echo ""
echo "  Run with default settings (10,000 connections, 60s duration):"
echo ""
echo "    docker run --rm --ulimit nofile=65535:65535 \\"
echo "      -e WS_URL=wss://${DOMAIN}/ws \\"
echo "      ws-load-test:latest"
echo ""
echo "  Custom settings:"
echo ""
echo "    docker run --rm --ulimit nofile=65535:65535 \\"
echo "      -e WS_URL=wss://${DOMAIN}/ws \\"
echo "      -e TOTAL_CONNECTIONS=10000 \\"
echo "      -e RAMP_RATE=100 \\"
echo "      -e MESSAGE_INTERVAL_MS=2000 \\"
echo "      -e TEST_DURATION_SEC=120 \\"
echo "      -e NUM_ROOMS=10 \\"
echo "      -e THUNDERING_HERD=true \\"
echo "      -e HERD_DISCONNECT_PERCENT=80 \\"
echo "      ws-load-test:latest"
echo ""
echo "  Environment variables:"
echo "    TOTAL_CONNECTIONS       Total WebSocket connections (default: 10000)"
echo "    RAMP_RATE               Connections opened per second (default: 100)"
echo "    MESSAGE_INTERVAL_MS     Ms between messages per client (default: 2000)"
echo "    TEST_DURATION_SEC       Total test duration in seconds (default: 60)"
echo "    NUM_ROOMS               Number of chat rooms to spread across (default: 10)"
echo "    THUNDERING_HERD         Enable herd test: true/false (default: true)"
echo "    HERD_DISCONNECT_PERCENT Percent of clients to disconnect at once (default: 80)"
echo ""
log "Done!"

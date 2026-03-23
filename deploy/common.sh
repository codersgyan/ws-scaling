#!/bin/bash
# common.sh — Shared functions for all deploy scripts
# Source this file, do not execute it directly.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[x]${NC} $1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

load_env() {
    local env_file="$SCRIPT_DIR/.env"

    if [[ ! -f "$env_file" ]]; then
        err "Missing $env_file"
        err "Copy .env.example to .env and fill in your values:"
        err "  cp $SCRIPT_DIR/.env.example $SCRIPT_DIR/.env"
        exit 1
    fi

    source "$env_file"

    # If caller passes specific vars, validate only those. Otherwise use defaults.
    local required_vars=("$@")
    if [[ ${#required_vars[@]} -eq 0 ]]; then
        required_vars=(DOMAIN NATS_VM_IP WS_VM_1_IP WS_VM_2_IP WS_VM_3_IP MYSQL_HOST MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE)
    fi

    local missing=()
    for var in "${required_vars[@]}"; do
        if [[ -z "${!var:-}" ]]; then
            missing+=("$var")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        err "Missing required variables in .env:"
        for var in "${missing[@]}"; do
            err "  $var"
        done
        exit 1
    fi

    log "Environment loaded from $env_file"
}

update_system() {
    log "Updating and upgrading system packages..."
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
    log "System updated"
}

ensure_docker() {
    if command -v docker &>/dev/null; then
        log "Docker already installed: $(docker --version)"
        return
    fi

    log "Installing Docker CE..."

    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg

    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin

    sudo systemctl enable docker
    sudo systemctl start docker

    if [[ -n "${SUDO_USER:-}" ]]; then
        sudo usermod -aG docker "$SUDO_USER"
        warn "Added $SUDO_USER to docker group. Log out and back in for it to take effect."
    fi

    log "Docker installed: $(docker --version)"
}

apply_sysctl_tuning() {
    log "Applying sysctl tuning..."

    sudo tee /etc/sysctl.d/99-ws-tuning.conf > /dev/null <<'SYSCTL'
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
fs.file-max = 2097152
fs.nr_open = 2097152
SYSCTL

    sudo sysctl --system > /dev/null 2>&1
    log "sysctl tuning applied"
}

apply_ulimit_tuning() {
    log "Applying ulimit tuning..."

    sudo tee /etc/security/limits.d/99-ws.conf > /dev/null <<'LIMITS'
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
LIMITS

    log "ulimit tuning applied (re-login required for shell sessions)"
}

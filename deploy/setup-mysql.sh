#!/bin/bash
# setup-mysql.sh — Set up a self-hosted MySQL 8 database server
# Run: sudo bash deploy/setup-mysql.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

load_env
update_system
ensure_docker
apply_sysctl_tuning

# Create persistent volume for MySQL data
docker volume create mysql_data > /dev/null 2>&1 || true

# Create custom MySQL config for connection pooling & performance
log "Writing MySQL configuration..."
sudo mkdir -p /etc/mysql/conf.d
sudo tee /etc/mysql/conf.d/custom.cnf > /dev/null <<'MYSQLCNF'
[mysqld]
# --- Connection Pooling & Limits ---
max_connections              = 500
max_connect_errors           = 1000000
wait_timeout                 = 28800
interactive_timeout          = 28800
thread_cache_size            = 128

# --- InnoDB Performance ---
innodb_buffer_pool_size      = 512M
innodb_buffer_pool_instances = 4
innodb_log_file_size         = 256M
innodb_flush_log_at_trx_commit = 2
innodb_flush_method          = O_DIRECT
innodb_io_capacity           = 2000
innodb_io_capacity_max       = 4000
innodb_read_io_threads       = 8
innodb_write_io_threads      = 8

# --- Query & Table Cache ---
table_open_cache             = 4096
table_open_cache_instances   = 16
open_files_limit             = 65535

# --- Temp Tables ---
tmp_table_size               = 64M
max_heap_table_size          = 64M

# --- Networking ---
back_log                     = 1024
net_buffer_length            = 16384
max_allowed_packet           = 64M

# --- Logging (minimal for performance) ---
slow_query_log               = 1
slow_query_log_file          = /var/log/mysql/slow.log
long_query_time              = 2

# --- Binary Logging (for point-in-time recovery) ---
server-id                    = 1
log_bin                      = mysql-bin
binlog_expire_logs_seconds   = 604800
sync_binlog                  = 0

# --- Character Set ---
character-set-server         = utf8mb4
collation-server             = utf8mb4_unicode_ci
MYSQLCNF

# Stop existing container if running
docker rm -f ws-mysql 2>/dev/null || true

# Run MySQL
log "Starting MySQL 8 container..."
docker run -d \
    --name ws-mysql \
    --restart unless-stopped \
    --ulimit nofile=65535:65535 \
    --log-opt max-size=50m \
    --log-opt max-file=3 \
    -p 3306:3306 \
    -v mysql_data:/var/lib/mysql \
    -v /etc/mysql/conf.d/custom.cnf:/etc/mysql/conf.d/custom.cnf:ro \
    -v "$PROJECT_DIR/sql/init.sql":/docker-entrypoint-initdb.d/init.sql:ro \
    -e MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD}" \
    -e MYSQL_DATABASE="${MYSQL_DATABASE:-wschat}" \
    -e MYSQL_USER="${MYSQL_SELF_HOSTED_USER}" \
    -e MYSQL_PASSWORD="${MYSQL_SELF_HOSTED_PASSWORD}" \
    mysql:8

# Wait for MySQL to be ready
log "Waiting for MySQL to initialize (this may take 30-60 seconds on first run)..."
for i in $(seq 1 60); do
    if docker exec ws-mysql mysqladmin ping -h localhost --silent 2>/dev/null; then
        break
    fi
    if [[ $i -eq 60 ]]; then
        err "MySQL failed to start within 60 seconds. Check logs:"
        docker logs ws-mysql --tail 30
        exit 1
    fi
    sleep 2
done

log "MySQL is running on port 3306"

# Show connection info
echo ""
log "=== Connection Details ==="
MYSQL_VM_IP=$(hostname -I | awk '{print $1}')
echo "  Host:     ${MYSQL_VM_IP}"
echo "  Port:     3306"
echo "  Database: ${MYSQL_DATABASE:-wschat}"
echo "  User:     ${MYSQL_SELF_HOSTED_USER}"
echo "  Password: (as set in .env)"
echo ""
echo "  For your deploy/.env on other VMs, set:"
echo "    MYSQL_HOST=${MYSQL_VM_IP}"
echo "    MYSQL_PORT=3306"
echo "    MYSQL_USER=${MYSQL_SELF_HOSTED_USER}"
echo "    MYSQL_PASSWORD=<your password>"
echo "    MYSQL_DATABASE=${MYSQL_DATABASE:-wschat}"
echo "    MYSQL_SSL=false"

# Verify the database and table were created
log "Verifying database initialization..."
TABLE_CHECK=$(docker exec ws-mysql mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "USE ${MYSQL_DATABASE:-wschat}; SHOW TABLES;" 2>/dev/null || true)
if echo "$TABLE_CHECK" | grep -q "messages"; then
    log "Table 'messages' created successfully"
else
    warn "Table 'messages' not found. It may still be initializing."
    warn "Check manually: docker exec -it ws-mysql mysql -u root -p"
fi

# Show MySQL configuration summary
echo ""
log "=== MySQL Configuration Summary ==="
echo "  max_connections:          500"
echo "  innodb_buffer_pool_size:  512M"
echo "  thread_cache_size:        128"
echo "  slow_query_log:           enabled (queries > 2s)"
echo "  binary logging:           enabled (7-day retention)"
echo "  data volume:              mysql_data (persistent)"

echo ""
log "=== Suggested Firewall Rules ==="
echo "  sudo ufw allow from ${WS_VM_1_IP} to any port 3306"
echo "  sudo ufw allow from ${WS_VM_2_IP} to any port 3306"
echo "  sudo ufw allow from ${WS_VM_3_IP} to any port 3306"
echo "  sudo ufw allow 22/tcp    # SSH"
echo "  sudo ufw default deny incoming"
echo "  sudo ufw enable"

echo ""
log "Done! MySQL is ready to accept connections."

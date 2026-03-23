# Deployment Guide — WebSocket Chat on Linux VMs

This guide walks you through deploying the scalable WebSocket chat application across **Ubuntu Linux VMs** using Docker. You can use either a **self-hosted MySQL** (6 VMs total) or a **managed MySQL** (5 VMs total).

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [VM Inventory](#vm-inventory)
- [Step 0 — Prepare the Environment File](#step-0--prepare-the-environment-file)
- [Step 1 — Set Up MySQL Database](#step-1--set-up-mysql-database)
  - [Option A — Self-Hosted MySQL (VM 6)](#option-a--self-hosted-mysql-vm-6)
  - [Option B — Managed MySQL](#option-b--managed-mysql)
- [Step 2 — Set Up NATS (VM 2)](#step-2--set-up-nats-vm-2)
- [Step 3 — Set Up WebSocket Servers (VMs 3, 4, 5)](#step-3--set-up-websocket-servers-vms-3-4-5)
- [Step 4 — Set Up Caddy Reverse Proxy (VM 1)](#step-4--set-up-caddy-reverse-proxy-vm-1)
- [Step 5 — Verify the Deployment](#step-5--verify-the-deployment)
- [Firewall Configuration](#firewall-configuration)
- [Managing the Deployment](#managing-the-deployment)
- [Troubleshooting](#troubleshooting)
- [Architecture Deep Dive](#architecture-deep-dive)

---

## Architecture Overview

```
                         Internet
                            |
                     [ DNS: chat.example.com ]
                            |
                    ┌───────┴───────┐
                    │   VM 1        │
                    │   Caddy       │
                    │   (HTTPS/LB)  │
                    │   :80 :443    │
                    └───┬───┬───┬───┘
                        │   │   │
            ┌───────────┘   │   └───────────┐
            │               │               │
     ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
     │   VM 3      │ │   VM 4      │ │   VM 5      │
     │ ws-server-1 │ │ ws-server-2 │ │ ws-server-3 │
     │   :8080     │ │   :8080     │ │   :8080     │
     └──┬─────┬────┘ └──┬─────┬───┘ └──┬─────┬────┘
        │     │          │     │         │     │
        │     └──────────┼─────┼─────────┘     │
        │                │     │               │
        │          ┌─────┴─────┴─────┐         │
        │          │   VM 2          │         │
        │          │   NATS          │         │
        │          │   :4222         │         │
        │          └─────────────────┘         │
        │                                      │
        └──────────────┐    ┌──────────────────┘
                       │    │
                 ┌─────┴────┴─────┐
                 │   VM 6         │
                 │   MySQL 8      │
                 │   :3306        │
                 │ (self-hosted)  │
                 └────────────────┘
                       OR
                 ┌────────────────┐
                 │   Managed      │
                 │   MySQL        │
                 │   (external)   │
                 └────────────────┘
```

**How it works:**

1. A user opens `https://chat.example.com` in their browser
2. Caddy serves the static HTML client and terminates TLS (auto Let's Encrypt)
3. The client opens a WebSocket connection to `wss://chat.example.com/ws`
4. Caddy load-balances the connection to one of the 3 WebSocket servers using **least-connections** algorithm
5. When a user sends a message, the server saves it to MySQL, broadcasts to local clients, and publishes to NATS
6. The other 2 servers receive the NATS message and deliver it to their own local clients
7. Result: all users see all messages regardless of which server they're connected to

---

## Prerequisites

### VMs

- **5 or 6 Ubuntu VMs** (22.04 or 24.04 LTS)
  - 5 VMs if using a managed MySQL provider
  - 6 VMs if self-hosting MySQL
- Each VM must have:
  - **SSH access** (root or sudo-capable user)
  - **Internet access** (to install Docker, pull images, and obtain TLS certs)
  - At least **1 GB RAM** and **10 GB disk** per VM
  - MySQL VM: recommend **2 GB RAM** and **20 GB disk** minimum
- VMs must be able to communicate with each other over their private/internal IPs
- The Caddy VM (VM 1) must have a **public IP** accessible from the internet

### Domain

- A **domain name** (e.g., `chat.example.com`) with the DNS A record pointed to VM 1's **public IP**
- This is required for Caddy's automatic Let's Encrypt SSL certificate provisioning
- DNS propagation can take up to 24 hours, so set this up in advance

### MySQL Database (choose one)

**Option A — Self-Hosted (VM 6):**
- One additional Ubuntu VM dedicated to MySQL
- The `setup-mysql.sh` script handles everything: Docker, MySQL 8, performance tuning, database creation, and table initialization
- No external dependencies

**Option B — Managed MySQL:**
- A managed MySQL instance (PlanetScale, AWS RDS, DigitalOcean Managed Database, Aiven, etc.)
- You will need: **host**, **port**, **username**, **password**, and **database name**
- If your provider requires TLS/SSL connections (e.g., PlanetScale), you'll set `MYSQL_SSL=true`
- Ensure the managed database allows at least **150 concurrent connections** (each server uses a pool of up to 50)

### Repository

- The project repository must be cloned on each VM

---

## VM Inventory

Before you begin, note down the IPs of all your VMs. You'll need them for the configuration file.

| VM # | Role | What It Runs | Key Port(s) | Required? |
|------|------|--------------|-------------|-----------|
| 1 | Reverse Proxy | Caddy (auto HTTPS + load balancing) | 80, 443 | Yes |
| 2 | Message Broker | NATS (pub/sub for cross-server messaging) | 4222, 8222 | Yes |
| 3 | App Server | ws-server-1 (WebSocket + HTTP metrics) | 8080 | Yes |
| 4 | App Server | ws-server-2 (WebSocket + HTTP metrics) | 8080 | Yes |
| 5 | App Server | ws-server-3 (WebSocket + HTTP metrics) | 8080 | Yes |
| 6 | Database | MySQL 8 (self-hosted) | 3306 | Only if self-hosting |

---

## Step 0 — Prepare the Environment File

This step is done **once on your local machine**. You'll create a single `.env` file and copy it to all VMs.

### 0.1 — Create the `.env` file

```bash
cp deploy/.env.example deploy/.env
```

### 0.2 — Edit `deploy/.env` with your actual values

Open `deploy/.env` in your editor. The file has two sections for MySQL — fill in the one that matches your setup.

#### If self-hosting MySQL (Option A):

```bash
# Domain
DOMAIN=chat.example.com

# VM IPs (use private/internal IPs)
CADDY_VM_IP=10.0.0.1
NATS_VM_IP=10.0.0.2
WS_VM_1_IP=10.0.0.3
WS_VM_2_IP=10.0.0.4
WS_VM_3_IP=10.0.0.5

# Self-hosted MySQL setup (used by setup-mysql.sh)
MYSQL_VM_IP=10.0.0.6
MYSQL_ROOT_PASSWORD=your_strong_root_password
MYSQL_SELF_HOSTED_USER=wsapp
MYSQL_SELF_HOSTED_PASSWORD=your_strong_app_password

# Connection details (used by WS servers to connect to MySQL)
MYSQL_HOST=10.0.0.6
MYSQL_PORT=3306
MYSQL_USER=wsapp
MYSQL_PASSWORD=your_strong_app_password
MYSQL_DATABASE=wschat
MYSQL_SSL=false
```

**Important:** For self-hosted MySQL, make sure:
- `MYSQL_HOST` matches `MYSQL_VM_IP`
- `MYSQL_USER` matches `MYSQL_SELF_HOSTED_USER`
- `MYSQL_PASSWORD` matches `MYSQL_SELF_HOSTED_PASSWORD`
- Use strong passwords — these are the real credentials for your database

#### If using managed MySQL (Option B):

```bash
# Domain
DOMAIN=chat.example.com

# VM IPs (use private/internal IPs)
CADDY_VM_IP=10.0.0.1
NATS_VM_IP=10.0.0.2
WS_VM_1_IP=10.0.0.3
WS_VM_2_IP=10.0.0.4
WS_VM_3_IP=10.0.0.5

# Leave self-hosted fields empty
MYSQL_VM_IP=
MYSQL_ROOT_PASSWORD=
MYSQL_SELF_HOSTED_USER=
MYSQL_SELF_HOSTED_PASSWORD=

# Connection details from your managed DB provider
MYSQL_HOST=your-db-host.example.com
MYSQL_PORT=3306
MYSQL_USER=your_db_user
MYSQL_PASSWORD=your_db_password
MYSQL_DATABASE=wschat
MYSQL_SSL=true
```

### 0.3 — Clone the repo and copy `.env` to every VM

Repeat this on all VMs (5 or 6):

```bash
# SSH into each VM
ssh user@<VM_PUBLIC_IP>

# Clone the repository
git clone <your-repo-url>
cd ws

# Copy the .env file (do this from your local machine, or create it on each VM)
# Option A: scp from local
scp deploy/.env user@<VM_PUBLIC_IP>:~/ws/deploy/.env

# Option B: or just create it manually on each VM
nano deploy/.env
# paste the same content on all VMs
```

---

## Step 1 — Set Up MySQL Database

### Option A — Self-Hosted MySQL (VM 6)

This sets up a production-tuned MySQL 8 server on a dedicated VM with persistent storage, connection pooling, and performance optimizations.

#### 1A.1 — SSH into VM 6

```bash
ssh user@<MYSQL_VM_PUBLIC_IP>
cd ws
```

#### 1A.2 — Run the setup script

```bash
sudo bash deploy/setup-mysql.sh
```

**What this does:**

1. Updates and upgrades all system packages (`apt-get update && upgrade`)
2. Installs Docker CE if not already installed
3. Applies sysctl kernel tuning for high-concurrency networking
4. **Creates a custom MySQL configuration** (`/etc/mysql/conf.d/custom.cnf`) with production-grade settings:

   **Connection Pooling & Limits:**
   | Setting | Value | What It Does |
   |---------|-------|-------------|
   | `max_connections` | 500 | Maximum simultaneous client connections. Your 3 WS servers use up to 50 each (150 total), leaving headroom for admin queries, monitoring, and future scaling |
   | `thread_cache_size` | 128 | Caches threads for reuse instead of creating/destroying per connection. Reduces overhead when connections are frequently opened/closed |
   | `max_connect_errors` | 1000000 | Number of failed connection attempts before blocking a host. Set high to prevent false lockouts from connection pool churn |
   | `wait_timeout` | 28800 | Seconds an idle connection stays open (8 hours). Pooled connections from Node.js stay idle between bursts of messages |
   | `interactive_timeout` | 28800 | Same as `wait_timeout` but for interactive sessions (e.g., when you SSH in and run `mysql` manually) |
   | `back_log` | 1024 | Queue size for incoming connections waiting when all threads are busy. Handles connection spikes during message bursts |

   **InnoDB Storage Engine (where your data lives):**
   | Setting | Value | What It Does |
   |---------|-------|-------------|
   | `innodb_buffer_pool_size` | 512M | RAM allocated for caching table data and indexes. This is the single most important MySQL performance setting. More = fewer disk reads. Rule of thumb: 50-70% of available RAM |
   | `innodb_buffer_pool_instances` | 4 | Splits the buffer pool into 4 independent regions. Reduces lock contention when multiple connections read/write simultaneously |
   | `innodb_log_file_size` | 256M | Size of the redo log (write-ahead log). Larger = fewer checkpoints = better write performance. Trade-off: crash recovery takes slightly longer |
   | `innodb_flush_log_at_trx_commit` | 2 | Flushes redo log to OS cache on each commit, but only writes to disk once per second. This is ~10x faster than the default (1) with minimal data loss risk (at most 1 second of transactions lost on OS crash) |
   | `innodb_flush_method` | O_DIRECT | Bypasses the OS file cache and writes directly to disk. Prevents "double buffering" since InnoDB has its own buffer pool |
   | `innodb_io_capacity` | 2000 | Tells InnoDB how many I/O operations per second the disk can handle. Set for SSD storage (increase if using NVMe) |
   | `innodb_io_capacity_max` | 4000 | Maximum I/O operations per second during background flushing |
   | `innodb_read_io_threads` | 8 | Threads for read-ahead prefetching. More threads = better read parallelism |
   | `innodb_write_io_threads` | 8 | Threads for flushing dirty pages to disk. More threads = better write parallelism |

   **Table & Query Settings:**
   | Setting | Value | What It Does |
   |---------|-------|-------------|
   | `table_open_cache` | 4096 | Number of open table file descriptors to cache. Avoids reopening table files for each query |
   | `table_open_cache_instances` | 16 | Splits the table cache into 16 partitions to reduce mutex contention |
   | `tmp_table_size` | 64M | Max size for in-memory temp tables (used for GROUP BY, DISTINCT, etc.). Beyond this, MySQL writes to disk |
   | `max_heap_table_size` | 64M | Must match `tmp_table_size`. Controls max size for MEMORY engine tables |
   | `max_allowed_packet` | 64M | Largest single query or result set MySQL will accept. 64M handles large text messages with plenty of headroom |

   **Logging & Recovery:**
   | Setting | Value | What It Does |
   |---------|-------|-------------|
   | `slow_query_log` | enabled | Logs queries taking longer than 2 seconds to `/var/log/mysql/slow.log`. Essential for finding performance bottlenecks |
   | `log_bin` | enabled | Binary logging for point-in-time recovery. If something goes wrong, you can replay transactions |
   | `binlog_expire_logs_seconds` | 604800 | Keeps 7 days of binary logs, then auto-deletes. Prevents disk from filling up |
   | `sync_binlog` | 0 | OS handles binary log flushing (not MySQL). Faster writes, acceptable for non-replicated setups |

5. Creates a **Docker volume** `mysql_data` for persistent storage — your data survives container restarts and upgrades
6. Starts the MySQL 8 container with:
   - `--restart unless-stopped` — auto-restart on crash or VM reboot
   - `--ulimit nofile=65535:65535` — high file descriptor limit
   - `--log-opt max-size=50m --log-opt max-file=3` — Docker log rotation (max 150 MB)
   - Port `3306` mapped for database connections
   - `mysql_data` volume for persistent data at `/var/lib/mysql`
   - Custom config mounted at `/etc/mysql/conf.d/custom.cnf`
   - `sql/init.sql` mounted at `/docker-entrypoint-initdb.d/init.sql` — **automatically creates the `wschat` database and `messages` table on first run**
   - Environment variables: root password, database name, application user and password
7. Waits up to 2 minutes for MySQL to fully initialize
8. Verifies the `messages` table was created successfully

**Expected output:**
```
[+] Environment loaded from /home/user/ws/deploy/.env
[+] Updating and upgrading system packages...
[+] System updated
[+] Docker already installed: Docker version 24.x.x
[+] Applying sysctl tuning...
[+] sysctl tuning applied
[+] Writing MySQL configuration...
[+] Starting MySQL 8 container...
[+] Waiting for MySQL to initialize (this may take 30-60 seconds on first run)...
[+] MySQL is running on port 3306

[+] === Connection Details ===
  Host:     10.0.0.6
  Port:     3306
  Database: wschat
  User:     wsapp
  Password: (as set in .env)

  For your deploy/.env on other VMs, set:
    MYSQL_HOST=10.0.0.6
    MYSQL_PORT=3306
    MYSQL_USER=wsapp
    MYSQL_PASSWORD=<your password>
    MYSQL_DATABASE=wschat
    MYSQL_SSL=false

[+] Verifying database initialization...
[+] Table 'messages' created successfully

[+] === MySQL Configuration Summary ===
  max_connections:          500
  innodb_buffer_pool_size:  512M
  thread_cache_size:        128
  slow_query_log:           enabled (queries > 2s)
  binary logging:           enabled (7-day retention)
  data volume:              mysql_data (persistent)

[+] === Suggested Firewall Rules ===
  sudo ufw allow from 10.0.0.3 to any port 3306
  sudo ufw allow from 10.0.0.4 to any port 3306
  sudo ufw allow from 10.0.0.5 to any port 3306
  sudo ufw allow 22/tcp    # SSH
  sudo ufw default deny incoming
  sudo ufw enable

[+] Done! MySQL is ready to accept connections.
```

#### 1A.3 — Verify MySQL is working

```bash
# Check container is running
docker ps

# Connect as the application user
docker exec -it ws-mysql mysql -u wsapp -p'your_strong_app_password' wschat -e "DESCRIBE messages;"
```

You should see:

```
+------------+--------------+------+-----+-------------------+-------------------+
| Field      | Type         | Null | Key | Default           | Extra             |
+------------+--------------+------+-----+-------------------+-------------------+
| id         | bigint       | NO   | PRI | NULL              | auto_increment    |
| room       | varchar(100) | NO   | MUL | NULL              |                   |
| username   | varchar(100) | NO   |     | NULL              |                   |
| text       | text         | NO   |     | NULL              |                   |
| server_id  | varchar(50)  | NO   |     | NULL              |                   |
| created_at | timestamp    | YES  |     | CURRENT_TIMESTAMP | DEFAULT_GENERATED |
+------------+--------------+------+-----+-------------------+-------------------+
```

#### 1A.4 — Verify connection pooling settings

```bash
docker exec ws-mysql mysql -u root -p'your_root_password' -e "SHOW VARIABLES LIKE 'max_connections';"
docker exec ws-mysql mysql -u root -p'your_root_password' -e "SHOW VARIABLES LIKE 'thread_cache_size';"
docker exec ws-mysql mysql -u root -p'your_root_password' -e "SHOW VARIABLES LIKE 'innodb_buffer_pool_size';"
```

Expected:

```
+-----------------+-------+
| Variable_name   | Value |
+-----------------+-------+
| max_connections | 500   |
+-----------------+-------+

+-------------------+-------+
| Variable_name     | Value |
+-------------------+-------+
| thread_cache_size | 128   |
+-------------------+-------+

+-------------------------+-----------+
| Variable_name           | Value     |
+-------------------------+-----------+
| innodb_buffer_pool_size | 536870912 |   (= 512 MB)
+-------------------------+-----------+
```

#### 1A.5 — Test connectivity from a WS server VM

SSH into one of the WS server VMs (3, 4, or 5) and test:

```bash
# Install MySQL client for testing
sudo apt-get update && sudo apt-get install -y mysql-client

# Test connection from WS server to MySQL VM
mysql -h <MYSQL_VM_IP> -P 3306 -u wsapp -p'your_strong_app_password' wschat -e "SELECT 1;"
```

If this fails, check firewall rules on the MySQL VM (port 3306 must be open for the WS server IPs).

> **Skip `init-db.sh`:** When using self-hosted MySQL, the `setup-mysql.sh` script automatically initializes the database. The `init.sql` file is mounted into the container and runs on first boot. You do **not** need to run `init-db.sh` separately.

---

### Option B — Managed MySQL

If you're using a managed MySQL provider (PlanetScale, AWS RDS, DigitalOcean, etc.), skip `setup-mysql.sh` and run `init-db.sh` instead to create the `messages` table.

#### 1B.1 — Install the MySQL client (on any machine)

```bash
sudo apt-get update
sudo apt-get install -y mysql-client
```

#### 1B.2 — Run the init script

```bash
cd ws
bash deploy/init-db.sh
```

**What this does:**
- Reads your database credentials from `deploy/.env`
- Runs the `CREATE TABLE` statement from `sql/init.sql` against your managed MySQL
- Creates the `messages` table with this schema:

```sql
CREATE TABLE messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  room VARCHAR(100) NOT NULL,
  username VARCHAR(100) NOT NULL,
  text TEXT NOT NULL,
  server_id VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_room_id (room, id)
);
```

**Expected output:**
```
[+] Environment loaded from /path/to/deploy/.env
[+] Connecting to managed MySQL at your-db-host.example.com:3306...
[+] Database initialized! Table 'messages' created in 'wschat'.
```

#### 1B.3 — Verify (optional)

```bash
mysql -h <MYSQL_HOST> -P <MYSQL_PORT> -u <MYSQL_USER> -p<MYSQL_PASSWORD> <MYSQL_DATABASE> -e "DESCRIBE messages;"
```

> **Note for PlanetScale users:** PlanetScale does not support the `CREATE DATABASE` or `USE` commands. The init script automatically strips these. Your database should already exist in the PlanetScale dashboard before running this script.

---

## Step 2 — Set Up NATS (VM 2)

NATS is the message broker that enables cross-server communication. When a user sends a message to ws-server-1, NATS distributes it to ws-server-2 and ws-server-3 so all connected clients see it.

**NATS must be running before the WebSocket servers start.**

### 2.1 — SSH into VM 2

```bash
ssh user@<NATS_VM_PUBLIC_IP>
cd ws
```

### 2.2 — Run the setup script

```bash
sudo bash deploy/setup-nats.sh
```

**What this does:**
1. Updates and upgrades all system packages
2. Installs Docker CE if not already installed (adds Docker's official apt repository)
3. Applies kernel-level sysctl tuning for high-concurrency networking:
   - `net.core.somaxconn = 65535` — max socket listen backlog
   - `net.ipv4.tcp_tw_reuse = 1` — reuse TIME_WAIT sockets
   - `net.ipv4.tcp_fin_timeout = 15` — faster socket cleanup
   - `fs.file-max = 2097152` — max open file handles system-wide
   - And more (see `common.sh` for the full list)
4. Pulls the `nats:2-alpine` Docker image
5. Starts the NATS container with:
   - `--restart unless-stopped` — auto-restart on crash or VM reboot
   - `--ulimit nofile=65535:65535` — high file descriptor limit inside the container
   - `--max_connections 10000` — allow up to 10,000 simultaneous connections
   - `--max_payload 1048576` — 1 MB max message payload
   - Port `4222` exposed for client connections
   - Port `8222` exposed for NATS monitoring HTTP endpoint

**Expected output:**
```
[+] Updating and upgrading system packages...
[+] System updated
[+] Docker already installed: Docker version 24.x.x
[+] Applying sysctl tuning...
[+] sysctl tuning applied
[+] Starting NATS container...
[+] NATS is running on port 4222
[+] NATS monitoring available on port 8222

[+] === Suggested Firewall Rules ===
  sudo ufw allow from 10.0.0.3 to any port 4222
  sudo ufw allow from 10.0.0.4 to any port 4222
  sudo ufw allow from 10.0.0.5 to any port 4222
  sudo ufw allow 22/tcp    # SSH
  sudo ufw default deny incoming
  sudo ufw enable

[+] Done!
```

### 2.3 — Verify NATS is running

```bash
docker ps
```

You should see:
```
CONTAINER ID   IMAGE           COMMAND                  STATUS         PORTS
abc123         nats:2-alpine   "/nats-server --max…"    Up X seconds   0.0.0.0:4222->4222/tcp, 0.0.0.0:8222->8222/tcp
```

You can also check the NATS monitoring endpoint:

```bash
curl http://localhost:8222/varz
```

This returns NATS server statistics in JSON format.

---

## Step 3 — Set Up WebSocket Servers (VMs 3, 4, 5)

The three WebSocket servers are the core of the application. Each one:
- Accepts WebSocket connections from clients (via Caddy)
- Saves messages to MySQL
- Publishes messages to NATS for cross-server delivery
- Subscribes to NATS to receive messages from other servers
- Serves a `/metrics` endpoint for monitoring

**All 3 servers can be set up in parallel** since they are independent of each other. They only depend on NATS (Step 2) and MySQL (Step 1) being up.

### 3.1 — SSH into each server VM

Open 3 terminal sessions and SSH into VMs 3, 4, and 5:

```bash
# Terminal 1
ssh user@<WS_VM_1_PUBLIC_IP>
cd ws

# Terminal 2
ssh user@<WS_VM_2_PUBLIC_IP>
cd ws

# Terminal 3
ssh user@<WS_VM_3_PUBLIC_IP>
cd ws
```

### 3.2 — Run the setup script on each VM

On **VM 3**:
```bash
sudo bash deploy/setup-ws-server.sh 1
```

On **VM 4**:
```bash
sudo bash deploy/setup-ws-server.sh 2
```

On **VM 5**:
```bash
sudo bash deploy/setup-ws-server.sh 3
```

> The numeric argument (`1`, `2`, or `3`) sets the `SERVER_ID` environment variable inside the container (`ws-server-1`, `ws-server-2`, `ws-server-3`). This ID is stored with each message in the database and shown in the UI, so you can see which server handled each message.

**What this does (on each VM):**

1. Updates and upgrades all system packages
2. Installs Docker CE if not already installed
3. Applies sysctl tuning (same as other VMs) for high-concurrency networking
4. Applies ulimit tuning — sets the max open files to 1,048,576 system-wide, needed for handling thousands of concurrent WebSocket connections
5. **Builds the Docker image** from `server/Dockerfile`:
   - Base image: `node:20-alpine` (minimal ~180 MB)
   - Installs production npm dependencies (`ws`, `mysql2`, `nats`)
   - Sets Node.js heap limit to 512 MB (`--max-old-space-size=512`)
6. Starts the server container with:
   - `--restart unless-stopped` — auto-restart on crash or VM reboot
   - `--ulimit nofile=65535:65535` — high file descriptor limit inside the container
   - `--stop-timeout 15` — gives the graceful shutdown handler 15 seconds to drain connections before Docker sends SIGKILL (the app has a 6-second internal grace period)
   - `--log-opt max-size=50m --log-opt max-file=3` — rotates Docker logs (max 150 MB total) to prevent disk exhaustion
   - Port `8080` mapped for incoming connections from Caddy
   - Environment variables for NATS and MySQL connection details

**Expected output (example for server 1):**
```
[+] Environment loaded from /home/user/ws/deploy/.env
[+] Updating and upgrading system packages...
[+] System updated
[+] Docker already installed: Docker version 24.x.x
[+] Applying sysctl tuning...
[+] sysctl tuning applied
[+] Applying ulimit tuning...
[+] ulimit tuning applied (re-login required for shell sessions)
[+] Building Docker image from server/Dockerfile...
 => [1/5] FROM docker.io/library/node:20-alpine
 => [2/5] WORKDIR /app
 => [3/5] COPY package.json ./
 => [4/5] RUN npm install --production
 => [5/5] COPY . .
 => exporting to image
[+] Starting ws-server-1...
[+] ws-server-1 is running on port 8080

[+] Recent logs:
[nats] Connected on attempt 1
[db] Connected to MySQL on attempt 1
[server] ws-server-1 listening on port 8080

[+] === Suggested Firewall Rules ===
  sudo ufw allow from 10.0.0.1 to any port 8080
  sudo ufw allow 22/tcp    # SSH
  sudo ufw default deny incoming
  sudo ufw enable

[+] Done! ws-server-1 is ready.
```

### 3.3 — Verify each server

On each server VM, check:

```bash
# Container is running
docker ps

# Server connected to NATS and MySQL
docker logs ws-server

# Metrics endpoint responds
curl http://localhost:8080/metrics
```

The metrics endpoint returns JSON with CPU usage, memory, connection count, and server ID:

```json
{
  "serverId": "ws-server-1",
  "uptime": 42,
  "connections": 0,
  "rooms": 0,
  "cpu": { "user": 32000, "system": 12000 },
  "memory": { "rss": 45678592, "heapUsed": 12345678 }
}
```

> **If you see connection errors:** The server retries both NATS and MySQL connections up to 10 times with a 2-second delay between attempts. If NATS is not yet running or MySQL is unreachable, check the logs for retry output. Common issues: firewall blocking port 4222 to NATS VM, wrong MySQL host/credentials, or MySQL requiring SSL when `MYSQL_SSL` is set to `false`.

---

## Step 4 — Set Up Caddy Reverse Proxy (VM 1)

Caddy is the entry point for all user traffic. It:
- **Automatically provisions and renews TLS certificates** from Let's Encrypt — no manual cert management
- Serves the static HTML/CSS/JS chat client
- Load-balances WebSocket connections across the 3 backend servers using **least-connections** algorithm
- Automatically redirects HTTP to HTTPS

### 4.1 — SSH into VM 1

```bash
ssh user@<CADDY_VM_PUBLIC_IP>
cd ws
```

### 4.2 — Verify DNS is pointing to this VM

Before running the setup script, confirm your domain resolves to this VM's public IP:

```bash
dig +short chat.example.com
# Should return this VM's public IP, e.g., 203.0.113.10
```

If it doesn't resolve yet, wait for DNS propagation or check your DNS provider's settings. **Caddy will fail to obtain a certificate if DNS is not configured.**

### 4.3 — Run the setup script

```bash
sudo bash deploy/setup-caddy.sh
```

**What this does:**

1. Updates and upgrades all system packages
2. Installs Docker CE if not already installed
3. Applies sysctl tuning for high-concurrency networking
4. **Generates the Caddyfile** from the template (`Caddyfile.template`):
   - Replaces `__DOMAIN__` with your actual domain name
   - Replaces `__WS_VM_1_IP__`, `__WS_VM_2_IP__`, `__WS_VM_3_IP__` with actual server IPs
   - The generated Caddyfile is written to `/tmp/Caddyfile`
5. Creates a Docker volume `caddy_data` to persist TLS certificates across container restarts
6. Starts the Caddy container with:
   - `--restart unless-stopped` — auto-restart on crash or VM reboot
   - `--ulimit nofile=65535:65535` — high file descriptor limit
   - Port `80` mapped — used for Let's Encrypt HTTP-01 challenge and HTTP→HTTPS redirect
   - Port `443` mapped — HTTPS traffic
   - `caddy_data` volume mounted to `/data` — stores TLS certificates
   - `Caddyfile` mounted read-only to `/etc/caddy/Caddyfile`
   - `client/` directory mounted read-only to `/srv/client` — serves the chat UI

**Generated Caddyfile (example):**

```caddyfile
chat.example.com {
    # Serve static client files
    handle / {
        root * /srv/client
        file_server
    }

    # WebSocket reverse proxy with load balancing
    handle /ws* {
        reverse_proxy 10.0.0.3:8080 10.0.0.4:8080 10.0.0.5:8080 {
            lb_policy least_conn
            flush_interval -1
        }
    }

    # Metrics endpoint
    handle /metrics {
        reverse_proxy 10.0.0.3:8080 10.0.0.4:8080 10.0.0.5:8080 {
            lb_policy round_robin
        }
    }
}
```

**Expected output:**
```
[+] Environment loaded from /home/user/ws/deploy/.env
[+] Updating and upgrading system packages...
[+] System updated
[+] Docker already installed: Docker version 24.x.x
[+] Applying sysctl tuning...
[+] sysctl tuning applied
[+] Generating Caddyfile...
[+] Generated Caddyfile:
chat.example.com {
    ...
}
[+] Starting Caddy container...
[+] Caddy is running!
[+] Caddy will auto-provision SSL for chat.example.com
[+] Make sure DNS A record for chat.example.com points to this VM's public IP

[+] === Suggested Firewall Rules ===
  sudo ufw allow 80/tcp    # Let's Encrypt + HTTP redirect
  sudo ufw allow 443/tcp   # HTTPS
  sudo ufw allow 22/tcp    # SSH
  sudo ufw default deny incoming
  sudo ufw enable

[+] Done! Access your app at https://chat.example.com
```

### 4.4 — Verify TLS certificate provisioning

Check Caddy logs for the certificate:

```bash
docker logs ws-caddy 2>&1 | grep -i "certificate"
```

You should see something like:
```
"msg":"certificate obtained successfully","identifier":"chat.example.com"
```

> **If certificate provisioning fails:** Ensure port 80 is open from the internet (Let's Encrypt uses HTTP-01 challenge). Check that your domain's A record correctly points to this VM's public IP. Caddy will automatically retry certificate provisioning.

---

## Step 5 — Verify the Deployment

### 5.1 — Open the chat application

Open your browser and navigate to:

```
https://chat.example.com
```

You should see:
- A valid SSL certificate (green padlock)
- The chat interface with username and room fields
- Connection status showing "Connected"

### 5.2 — Test cross-server messaging

1. Open **3 browser tabs** (or use different browsers / incognito windows)
2. In each tab, enter a different username but the **same room name** (e.g., "general")
3. Click "Join" in all 3 tabs
4. Send a message from one tab — it should appear in all 3 tabs
5. Each message shows which server handled it (e.g., `ws-server-1`, `ws-server-2`)
6. If users are on different servers and still see each other's messages, NATS cross-server routing is working

### 5.3 — Check metrics

```bash
curl https://chat.example.com/metrics
```

This returns metrics from one of the servers (round-robin). To check all 3, run it multiple times or hit each server directly:

```bash
curl http://<WS_VM_1_IP>:8080/metrics
curl http://<WS_VM_2_IP>:8080/metrics
curl http://<WS_VM_3_IP>:8080/metrics
```

### 5.4 — Verify HTTP→HTTPS redirect

```bash
curl -I http://chat.example.com
```

Expected:
```
HTTP/1.1 301 Moved Permanently
Location: https://chat.example.com/
```

### 5.5 — Check container health on all VMs

Run on each VM:
```bash
docker ps
docker logs <container-name> --tail 20
```

Container names by VM:
| VM | Container Name |
|----|---------------|
| 1 (Caddy) | `ws-caddy` |
| 2 (NATS) | `ws-nats` |
| 3, 4, 5 (Servers) | `ws-server` |
| 6 (MySQL) | `ws-mysql` |

### 5.6 — Check MySQL connection pool status (self-hosted only)

```bash
# On the MySQL VM
docker exec ws-mysql mysql -u root -p'your_root_password' -e "SHOW STATUS LIKE 'Threads_%';"
```

Expected:
```
+-------------------+-------+
| Variable_name     | Value |
+-------------------+-------+
| Threads_cached    | 3     |    <- Threads reused from cache (connection pooling working)
| Threads_connected | 4     |    <- Currently connected clients (3 WS servers + this query)
| Threads_created   | 7     |    <- Total threads ever created (should stabilize)
| Threads_running   | 1     |    <- Actively executing queries right now
+-------------------+-------+
```

Key indicators:
- `Threads_cached > 0` means the thread cache is working (connections are being reused, not created from scratch)
- `Threads_connected` should be ~3 when idle (one per WS server's connection pool)
- `Threads_created` should stabilize after initial connections — if it keeps growing, increase `thread_cache_size`

---

## Firewall Configuration

Each setup script prints **suggested** UFW firewall rules but does not apply them. This is intentional — you may be using cloud provider security groups, iptables, or a different firewall tool.

Here are the recommended rules for each VM:

### VM 1 — Caddy

```bash
sudo ufw allow 80/tcp          # Let's Encrypt HTTP challenge + redirect
sudo ufw allow 443/tcp         # HTTPS
sudo ufw allow 22/tcp          # SSH
sudo ufw default deny incoming
sudo ufw enable
```

### VM 2 — NATS

```bash
sudo ufw allow from <WS_VM_1_IP> to any port 4222   # ws-server-1
sudo ufw allow from <WS_VM_2_IP> to any port 4222   # ws-server-2
sudo ufw allow from <WS_VM_3_IP> to any port 4222   # ws-server-3
sudo ufw allow 22/tcp                                 # SSH
sudo ufw default deny incoming
sudo ufw enable
```

### VMs 3, 4, 5 — WebSocket Servers

```bash
sudo ufw allow from <CADDY_VM_IP> to any port 8080   # Caddy reverse proxy
sudo ufw allow 22/tcp                                  # SSH
sudo ufw default deny incoming
sudo ufw enable
```

### VM 6 — MySQL (self-hosted)

```bash
sudo ufw allow from <WS_VM_1_IP> to any port 3306   # ws-server-1
sudo ufw allow from <WS_VM_2_IP> to any port 3306   # ws-server-2
sudo ufw allow from <WS_VM_3_IP> to any port 3306   # ws-server-3
sudo ufw allow 22/tcp                                 # SSH
sudo ufw default deny incoming
sudo ufw enable
```

> **Cloud provider security groups:** If you're using AWS, GCP, DigitalOcean, etc., configure equivalent inbound rules in the security group/firewall attached to each VM. This is often preferred over UFW since it's managed at the infrastructure level.

---

## Managing the Deployment

### Viewing logs

```bash
# Follow logs in real-time
docker logs -f ws-caddy      # On VM 1
docker logs -f ws-nats       # On VM 2
docker logs -f ws-server     # On VMs 3/4/5
docker logs -f ws-mysql      # On VM 6

# Show last 100 lines
docker logs --tail 100 ws-server
```

### Restarting a service

```bash
docker restart ws-caddy      # On VM 1
docker restart ws-nats       # On VM 2
docker restart ws-server     # On VMs 3/4/5
docker restart ws-mysql      # On VM 6
```

### Redeploying after code changes

The setup scripts are **idempotent** — running them again will stop the old container, rebuild the image (if applicable), and start a new container.

On each WebSocket server VM (after pulling the latest code):

```bash
cd ws
git pull
sudo bash deploy/setup-ws-server.sh <1|2|3>
```

For Caddy config changes:

```bash
cd ws
git pull
sudo bash deploy/setup-caddy.sh
```

### Tearing down a service

```bash
# Stop and remove container (keeps Docker image and data)
sudo bash deploy/teardown.sh caddy
sudo bash deploy/teardown.sh nats
sudo bash deploy/teardown.sh ws-server
sudo bash deploy/teardown.sh mysql

# Stop, remove container, AND remove Docker image + data volumes
sudo bash deploy/teardown.sh caddy --purge
sudo bash deploy/teardown.sh nats --purge
sudo bash deploy/teardown.sh ws-server --purge
sudo bash deploy/teardown.sh mysql --purge    # WARNING: deletes ALL database data!
```

> **Note:** Tearing down Caddy without `--purge` preserves the `caddy_data` Docker volume containing your TLS certificates. Tearing down MySQL without `--purge` preserves the `mysql_data` volume containing all your database files. Using `--purge` **permanently deletes** this data.

### MySQL maintenance (self-hosted)

```bash
# Connect to MySQL as root
docker exec -it ws-mysql mysql -u root -p

# Check active connections
docker exec ws-mysql mysql -u root -p'your_root_password' -e "SHOW PROCESSLIST;"

# Check connection pool usage
docker exec ws-mysql mysql -u root -p'your_root_password' -e "SHOW STATUS LIKE 'Threads_%';"

# Check slow query log
docker exec ws-mysql cat /var/log/mysql/slow.log

# Check database size
docker exec ws-mysql mysql -u root -p'your_root_password' -e \
  "SELECT table_name, ROUND(data_length/1024/1024, 2) AS 'Data (MB)', ROUND(index_length/1024/1024, 2) AS 'Index (MB)', table_rows AS 'Rows' FROM information_schema.tables WHERE table_schema='wschat';"

# Check disk usage of the Docker volume
docker system df -v | grep mysql_data
```

### Checking disk usage

Docker images and logs can accumulate over time:

```bash
docker system df          # Show Docker disk usage
docker system prune -f    # Remove unused images, containers, and build cache
```

---

## Troubleshooting

### Server can't connect to NATS

**Symptom:** Logs show `[nats] Attempt X/10 failed: connection refused`

**Fixes:**
1. Verify NATS is running on VM 2: `docker ps` on the NATS VM
2. Check the `NATS_VM_IP` in `.env` matches VM 2's actual internal IP
3. Check firewall on VM 2: `sudo ufw status` — port 4222 must be open for the server VMs
4. Test connectivity from the server VM: `nc -zv <NATS_VM_IP> 4222`

### Server can't connect to MySQL

**Symptom:** Logs show `[db] Attempt X/10 failed: connect ECONNREFUSED` or `Access denied`

**Fixes:**
1. Verify credentials in `.env` are correct
2. **Self-hosted:** Check firewall on VM 6 — port 3306 must be open for the server VMs. Test: `nc -zv <MYSQL_VM_IP> 3306`
3. **Self-hosted:** Verify MySQL is running: `docker ps` on VM 6, then `docker exec ws-mysql mysqladmin ping -h localhost`
4. **Managed:** Check if the managed DB allows connections from the server VM IPs (check allowlists in your DB provider's dashboard)
5. **Managed with SSL:** Ensure `MYSQL_SSL=true` is set in `.env`
6. Test auth: `mysql -h <MYSQL_HOST> -P <MYSQL_PORT> -u <MYSQL_USER> -p<MYSQL_PASSWORD> <MYSQL_DATABASE> -e "SELECT 1;"`

### MySQL too many connections

**Symptom:** Logs show `Too many connections` error

**Fixes:**
1. Check current connections: `docker exec ws-mysql mysql -u root -p -e "SHOW STATUS LIKE 'Threads_connected';"`
2. Check max: `docker exec ws-mysql mysql -u root -p -e "SHOW VARIABLES LIKE 'max_connections';"` (should be 500)
3. Look for connection leaks: `docker exec ws-mysql mysql -u root -p -e "SHOW PROCESSLIST;"` — look for stuck queries
4. If legitimate, increase `max_connections` in `/etc/mysql/conf.d/custom.cnf` and restart: `docker restart ws-mysql`

### Caddy can't obtain SSL certificate

**Symptom:** Logs show `failed to obtain certificate` or `challenge failed`

**Fixes:**
1. Verify DNS resolves correctly: `dig +short <DOMAIN>` must return VM 1's public IP
2. Ensure port 80 is open from the internet (Let's Encrypt HTTP-01 challenge needs it)
3. Check that no other service is using port 80: `sudo ss -tlnp | grep :80`
4. Wait for DNS propagation if you just set up the A record
5. Check Caddy logs for details: `docker logs ws-caddy 2>&1 | grep -i error`

### Messages not appearing on other servers

**Symptom:** Users on different servers don't see each other's messages

**Fixes:**
1. Verify all 3 servers are connected to NATS: check `docker logs ws-server` on each VM for `[nats] Connected`
2. Make sure all servers are using the same `NATS_VM_IP`
3. Check NATS monitoring: `curl http://<NATS_VM_IP>:8222/connz` to see connected clients (should show 3 connections)

### Container keeps restarting

**Symptom:** `docker ps` shows container with status `Restarting`

**Fixes:**
1. Check logs: `docker logs ws-server` (or the relevant container name)
2. Common causes: wrong environment variables, unreachable NATS or MySQL after 10 retries
3. Fix the issue, then restart: `docker restart ws-server`

### WebSocket connection drops frequently

**Symptom:** Chat client shows frequent disconnections/reconnections

**Fixes:**
1. Verify sysctl tuning was applied: `sysctl net.core.somaxconn` should return `65535`
2. Check if the server is running out of memory: `docker stats ws-server`
3. Check Caddy logs for proxy errors: `docker logs ws-caddy 2>&1 | grep -i error`

---

## Architecture Deep Dive

### What each script does automatically

Every setup script (`setup-caddy.sh`, `setup-nats.sh`, `setup-ws-server.sh`, `setup-mysql.sh`) performs these common steps by sourcing `common.sh`:

| Step | What | Why |
|------|------|-----|
| `load_env()` | Reads `deploy/.env` and validates all required variables are set | Prevents runtime failures from missing config |
| `update_system()` | Runs `apt-get update && apt-get upgrade` | Fresh VMs need security patches and latest packages |
| `ensure_docker()` | Installs Docker CE from the official Docker apt repository | Ensures consistent Docker version across all VMs |
| `apply_sysctl_tuning()` | Writes kernel parameters to `/etc/sysctl.d/99-ws-tuning.conf` | Optimizes TCP/networking for thousands of concurrent connections |
| `apply_ulimit_tuning()` | Writes file descriptor limits to `/etc/security/limits.d/99-ws.conf` | Allows processes to open more than the default 1024 file descriptors |

### Sysctl parameters explained

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `net.core.somaxconn` | 65535 | Max queued connections waiting for accept() |
| `net.ipv4.tcp_max_syn_backlog` | 65535 | Max half-open connections (SYN_RECV state) |
| `net.ipv4.ip_local_port_range` | 1024-65535 | Ephemeral port range for outbound connections |
| `net.ipv4.tcp_tw_reuse` | 1 | Reuse TIME_WAIT sockets for new connections |
| `net.ipv4.tcp_fin_timeout` | 15 | Seconds to wait in FIN_WAIT_2 before closing |
| `net.core.netdev_max_backlog` | 65535 | Max packets queued on input when interface is faster than kernel |
| `net.ipv4.tcp_keepalive_time` | 300 | Seconds before sending first keepalive probe |
| `net.ipv4.tcp_keepalive_intvl` | 30 | Seconds between keepalive probes |
| `net.ipv4.tcp_keepalive_probes` | 5 | Number of failed probes before dropping connection |
| `fs.file-max` | 2097152 | System-wide max file descriptors (2M) |
| `fs.nr_open` | 2097152 | Per-process max file descriptors (2M) |

### How MySQL connection pooling works end-to-end

```
                    ┌─────────────────────────────────────┐
                    │         MySQL Server (VM 6)         │
                    │                                     │
                    │  max_connections = 500               │
                    │  thread_cache_size = 128             │
                    │                                     │
                    │  ┌───────────────────────────────┐  │
                    │  │      Thread Pool               │  │
                    │  │                               │  │
                    │  │  Thread 1 ← ws-server-1       │  │
                    │  │  Thread 2 ← ws-server-1       │  │
                    │  │  ...                          │  │
                    │  │  Thread 50 ← ws-server-1      │  │
                    │  │  Thread 51 ← ws-server-2      │  │
                    │  │  ...                          │  │
                    │  │  Thread 100 ← ws-server-2     │  │
                    │  │  Thread 101 ← ws-server-3     │  │
                    │  │  ...                          │  │
                    │  │  Thread 150 ← ws-server-3     │  │
                    │  │  Thread 151-500: available     │  │
                    │  └───────────────────────────────┘  │
                    └─────────────────────────────────────┘
                           ▲          ▲          ▲
                           │          │          │
             connectionLimit: 50 each (Node.js mysql2 pool)
                           │          │          │
                    ┌──────┘    ┌─────┘    ┌─────┘
                    │           │          │
              ws-server-1  ws-server-2  ws-server-3
```

**Two layers of pooling work together:**

1. **Node.js side (mysql2 pool):** Each WS server creates a connection pool with `connectionLimit: 50`. When a message arrives, it grabs an idle connection from the pool, runs the INSERT query, and returns the connection to the pool. No TCP handshake overhead per query.

2. **MySQL side (thread cache):** When a Node.js pool connection is returned and eventually closed, MySQL doesn't destroy the thread — it caches it (`thread_cache_size: 128`). When a new connection arrives, MySQL reuses the cached thread instead of creating a new one from scratch. This eliminates OS thread creation overhead.

**The result:** Even under burst traffic (100+ messages/second), connections are reused efficiently at both layers. The 500 `max_connections` limit provides headroom for 150 app connections + admin queries + monitoring.

### Message flow (detailed)

```
User A (browser) ──WebSocket──> Caddy ──proxy──> ws-server-1
                                                     │
                                                     ├─ 1. Save to MySQL
                                                     ├─ 2. Broadcast to local clients
                                                     └─ 3. Publish to NATS (topic: chat.general)
                                                              │
                                                    ┌─────────┴─────────┐
                                                    │                   │
                                               ws-server-2         ws-server-3
                                                    │                   │
                                          4. Deliver to          4. Deliver to
                                          local clients          local clients
                                                    │                   │
                                               User B              User C
```

### Docker container configuration summary

| Container | Image | Ports | Restart | Key Flags |
|-----------|-------|-------|---------|-----------|
| `ws-caddy` | `caddy:2-alpine` | 80, 443 | unless-stopped | `caddy_data` volume for certs |
| `ws-nats` | `nats:2-alpine` | 4222, 8222 | unless-stopped | `--max_connections 10000` |
| `ws-server` | `ws-chat-server:latest` (built locally) | 8080 | unless-stopped | `--stop-timeout 15`, log rotation |
| `ws-mysql` | `mysql:8` | 3306 | unless-stopped | `mysql_data` volume, custom config |

### Why Caddy instead of Nginx?

| Feature | Caddy | Nginx |
|---------|-------|-------|
| TLS certificates | Automatic (Let's Encrypt) | Manual (certbot + cron) |
| Config complexity | ~20 lines | ~43 lines + header boilerplate |
| WebSocket proxy | Built-in, zero config | Requires `proxy_set_header Upgrade` |
| HTTP→HTTPS redirect | Automatic | Manual `return 301` block |
| Config reload | `docker restart` | `nginx -s reload` |
| Load balancing | `lb_policy least_conn` | `least_conn` directive |

### Deployment order summary

```
1. MySQL (VM 6)              ← Database must exist first
   OR init-db.sh             ← For managed MySQL

2. NATS (VM 2)               ← Must be up before WS servers

3. WS Servers (VMs 3, 4, 5)  ← Can run in parallel after NATS + MySQL

4. Caddy (VM 1)              ← Last (needs servers running, but will retry)
```

### File reference

```
deploy/
├── .env.example           # Template — copy to .env and fill in values
├── .env                   # Your actual config (git-ignored, created by you)
├── common.sh              # Shared functions used by all setup scripts
├── Caddyfile.template     # Caddy config template with IP placeholders
├── setup-caddy.sh         # VM 1 setup: Caddy reverse proxy
├── setup-nats.sh          # VM 2 setup: NATS message broker
├── setup-ws-server.sh     # VMs 3/4/5 setup: WebSocket server (arg: 1, 2, or 3)
├── setup-mysql.sh         # VM 6 setup: Self-hosted MySQL 8
├── init-db.sh             # One-time: create messages table (for managed MySQL only)
├── teardown.sh            # Cleanup: stop and remove containers
└── README.md              # This file
```

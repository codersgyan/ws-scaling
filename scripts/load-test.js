import WebSocket from "ws";

const TOTAL_CONNECTIONS = parseInt(process.env.TOTAL_CONNECTIONS || "10000");
const RAMP_RATE = parseInt(process.env.RAMP_RATE || "100"); // connections per second
const MESSAGE_INTERVAL_MS = parseInt(process.env.MESSAGE_INTERVAL_MS || "2000");
const TEST_DURATION_SEC = parseInt(process.env.TEST_DURATION_SEC || "60");
const NUM_ROOMS = parseInt(process.env.NUM_ROOMS || "10");
const WS_URL = process.env.WS_URL || "ws://localhost/ws";
const THUNDERING_HERD = process.env.THUNDERING_HERD !== "false"; // enable by default
const HERD_DISCONNECT_PERCENT = parseInt(process.env.HERD_DISCONNECT_PERCENT || "80");

const stats = {
  // Connection phase
  connectionsOpened: 0,
  connectionsFailed: 0,
  connectLatencies: [],

  // Messaging phase
  messagesSent: 0,
  messagesReceived: 0,
  crossServerMessages: 0,

  // Thundering herd phase
  herdDisconnected: 0,
  herdReconnected: 0,
  herdReconnectFailed: 0,
  herdReconnectLatencies: [],

  // Message replay
  replayMessagesReceived: 0,
  replayClientsTriggered: 0,

  // Reconnect signals from server
  serverReconnectSignals: 0,
};

const clients = [];
const seenServers = new Set();

function createClient(id, opts = {}) {
  const { lastMessageId = 0, trackReplay = false } = opts;

  return new Promise((resolve) => {
    const username = `loaduser-${id}`;
    const room = `loadtest-${id % NUM_ROOMS}`;
    let url = `${WS_URL}?username=${username}&room=${room}`;
    if (lastMessageId > 0) url += `&lastMessageId=${lastMessageId}`;

    const start = Date.now();
    const ws = new WebSocket(url);
    let connected = false;
    let serverId = null;
    let msgInterval = null;
    let clientLastMsgId = lastMessageId;
    let inReplay = false;
    let replayCount = 0;

    ws._clientId = id;
    ws._room = room;
    ws._username = username;
    ws._getLastMsgId = () => clientLastMsgId;

    ws.on("open", () => {
      connected = true;
      const latency = Date.now() - start;

      if (opts.isHerdReconnect) {
        stats.herdReconnectLatencies.push(latency);
        stats.herdReconnected++;
      } else {
        stats.connectLatencies.push(latency);
        stats.connectionsOpened++;
      }
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.type) {
          case "welcome":
            serverId = msg.serverId;
            seenServers.add(serverId);
            resolve(ws);

            // Start sending messages periodically (only in steady state, not during herd reconnect)
            if (!opts.noMessages) {
              msgInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "message", text: `msg-${id}-${Date.now()}` }));
                  stats.messagesSent++;
                }
              }, MESSAGE_INTERVAL_MS);
            }
            break;

          case "message":
            if (msg.id > clientLastMsgId) {
              clientLastMsgId = msg.id;
            }
            if (inReplay) {
              replayCount++;
            } else {
              stats.messagesReceived++;
              if (msg.serverId && msg.serverId !== serverId) {
                stats.crossServerMessages++;
              }
            }
            break;

          case "replay_start":
            inReplay = true;
            replayCount = 0;
            break;

          case "replay_end":
            inReplay = false;
            if (trackReplay && replayCount > 0) {
              stats.replayMessagesReceived += replayCount;
              stats.replayClientsTriggered++;
            }
            break;

          case "reconnect":
            stats.serverReconnectSignals++;
            break;
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("close", () => {
      if (msgInterval) clearInterval(msgInterval);
    });

    ws.on("error", () => {
      if (!connected) {
        if (opts.isHerdReconnect) {
          stats.herdReconnectFailed++;
        } else {
          stats.connectionsFailed++;
        }
        resolve(null);
      }
    });

    // Timeout after 15s
    setTimeout(() => {
      if (!connected) {
        if (opts.isHerdReconnect) {
          stats.herdReconnectFailed++;
        } else {
          stats.connectionsFailed++;
        }
        ws.terminate();
        resolve(null);
      }
    }, 15000);
  });
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[idx];
}

function printReport() {
  const mem = process.memoryUsage();

  const avgConnect = stats.connectLatencies.length > 0
    ? Math.round(stats.connectLatencies.reduce((a, b) => a + b, 0) / stats.connectLatencies.length)
    : 0;
  const p99Connect = percentile(stats.connectLatencies, 99);
  const p50Connect = percentile(stats.connectLatencies, 50);

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║            LOAD TEST REPORT                      ║");
  console.log("╠══════════════════════════════════════════════════╣");

  console.log("\n--- Connection Phase ---");
  console.log(`  Target connections:         ${TOTAL_CONNECTIONS}`);
  console.log(`  Opened:                     ${stats.connectionsOpened}`);
  console.log(`  Failed:                     ${stats.connectionsFailed}`);
  console.log(`  Success rate:               ${((stats.connectionsOpened / TOTAL_CONNECTIONS) * 100).toFixed(1)}%`);
  console.log(`  Connect latency (avg):      ${avgConnect}ms`);
  console.log(`  Connect latency (P50):      ${p50Connect}ms`);
  console.log(`  Connect latency (P99):      ${p99Connect}ms`);

  console.log("\n--- Messaging Phase ---");
  console.log(`  Messages sent:              ${stats.messagesSent}`);
  console.log(`  Messages received:          ${stats.messagesReceived}`);
  console.log(`  Cross-server deliveries:    ${stats.crossServerMessages}`);
  const deliveryRate = stats.messagesSent > 0
    ? ((stats.messagesReceived / stats.messagesSent) * 100).toFixed(1)
    : "N/A";
  console.log(`  Delivery ratio:             ${deliveryRate}%`);

  if (THUNDERING_HERD) {
    const avgHerd = stats.herdReconnectLatencies.length > 0
      ? Math.round(stats.herdReconnectLatencies.reduce((a, b) => a + b, 0) / stats.herdReconnectLatencies.length)
      : 0;
    const p99Herd = percentile(stats.herdReconnectLatencies, 99);
    const p50Herd = percentile(stats.herdReconnectLatencies, 50);

    console.log("\n--- Thundering Herd Phase ---");
    console.log(`  Clients disconnected:       ${stats.herdDisconnected} (${HERD_DISCONNECT_PERCENT}%)`);
    console.log(`  Reconnected:                ${stats.herdReconnected}`);
    console.log(`  Reconnect failed:           ${stats.herdReconnectFailed}`);
    console.log(`  Reconnect success rate:     ${stats.herdDisconnected > 0 ? ((stats.herdReconnected / stats.herdDisconnected) * 100).toFixed(1) : "N/A"}%`);
    console.log(`  Reconnect latency (avg):    ${avgHerd}ms`);
    console.log(`  Reconnect latency (P50):    ${p50Herd}ms`);
    console.log(`  Reconnect latency (P99):    ${p99Herd}ms`);

    console.log("\n--- Message Replay Phase ---");
    console.log(`  Clients that got replay:    ${stats.replayClientsTriggered}`);
    console.log(`  Messages replayed:          ${stats.replayMessagesReceived}`);
  }

  console.log("\n--- Infrastructure ---");
  console.log(`  Unique servers seen:        ${[...seenServers].join(", ") || "none"}`);
  console.log(`  Server reconnect signals:   ${stats.serverReconnectSignals}`);
  console.log(`  Load test memory (RSS):     ${Math.round(mem.rss / 1024 / 1024)} MB`);

  // Verdict
  console.log("\n--- Verdict ---");
  const issues = [];
  const successRate = (stats.connectionsOpened / TOTAL_CONNECTIONS) * 100;
  if (successRate < 95) issues.push(`Low connection success rate: ${successRate.toFixed(1)}%`);
  if (p99Connect > 5000) issues.push(`High P99 connect latency: ${p99Connect}ms`);
  if (stats.connectionsFailed > TOTAL_CONNECTIONS * 0.05) issues.push(`Too many connection failures: ${stats.connectionsFailed}`);
  if (THUNDERING_HERD && stats.herdReconnectFailed > stats.herdDisconnected * 0.1) issues.push(`Thundering herd: ${stats.herdReconnectFailed} reconnects failed`);
  if (seenServers.size < 2) issues.push("Traffic not distributed across multiple servers");

  if (issues.length === 0) {
    console.log("  PASS — System handled the load successfully");
  } else {
    console.log("  ISSUES FOUND:");
    issues.forEach(i => console.log(`    - ${i}`));
  }

  console.log("\n╚══════════════════════════════════════════════════╝\n");
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║            LOAD TEST STARTING                    ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`  Target:             ${WS_URL}`);
  console.log(`  Connections:        ${TOTAL_CONNECTIONS}`);
  console.log(`  Ramp rate:          ${RAMP_RATE}/sec`);
  console.log(`  Message interval:   ${MESSAGE_INTERVAL_MS}ms`);
  console.log(`  Duration:           ${TEST_DURATION_SEC}s`);
  console.log(`  Rooms:              ${NUM_ROOMS}`);
  console.log(`  Thundering herd:    ${THUNDERING_HERD ? `enabled (${HERD_DISCONNECT_PERCENT}%)` : "disabled"}`);
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ============================
  // PHASE 1: Ramp up connections
  // ============================
  console.log("=== Phase 1: Ramping up connections ===\n");

  const batchSize = RAMP_RATE;
  const batches = Math.ceil(TOTAL_CONNECTIONS / batchSize);

  for (let b = 0; b < batches; b++) {
    const start = b * batchSize;
    const end = Math.min(start + batchSize, TOTAL_CONNECTIONS);
    const promises = [];

    for (let i = start; i < end; i++) {
      promises.push(createClient(i));
    }

    const results = await Promise.all(promises);
    for (const ws of results) {
      if (ws) clients.push(ws);
    }

    console.log(`  Ramped ${end}/${TOTAL_CONNECTIONS} (${clients.length} active, ${stats.connectionsFailed} failed)`);

    if (b < batches - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`\n  Phase 1 complete: ${clients.length} connections established\n`);

  // ============================
  // PHASE 2: Steady state messaging
  // ============================
  console.log("=== Phase 2: Steady state messaging ===\n");

  const steadyDuration = THUNDERING_HERD
    ? Math.max(Math.floor(TEST_DURATION_SEC * 0.4), 15) // 40% of time for steady state
    : TEST_DURATION_SEC;

  console.log(`  Running for ${steadyDuration}s...\n`);

  const statsInterval = setInterval(() => {
    const activeConns = clients.filter(ws => ws.readyState === WebSocket.OPEN).length;
    console.log(
      `  [live] conns=${activeConns} sent=${stats.messagesSent} recv=${stats.messagesReceived} cross=${stats.crossServerMessages}`
    );
  }, 5000);

  await new Promise((r) => setTimeout(r, steadyDuration * 1000));
  clearInterval(statsInterval);

  console.log(`\n  Phase 2 complete: ${stats.messagesSent} sent, ${stats.messagesReceived} received\n`);

  if (THUNDERING_HERD) {
    // ============================
    // PHASE 3: Thundering herd
    // ============================
    console.log("=== Phase 3: Thundering herd simulation ===\n");

    // Stop all message intervals first
    for (const ws of clients) {
      if (ws._msgInterval) clearInterval(ws._msgInterval);
    }

    // Disconnect a percentage of clients simultaneously
    const disconnectCount = Math.floor(clients.length * (HERD_DISCONNECT_PERCENT / 100));
    const toDisconnect = clients.slice(0, disconnectCount);
    const disconnectInfo = [];

    console.log(`  Disconnecting ${disconnectCount} clients simultaneously...\n`);

    // Save last message IDs before disconnecting
    for (const ws of toDisconnect) {
      disconnectInfo.push({
        id: ws._clientId,
        lastMsgId: ws._getLastMsgId(),
      });
      ws.terminate(); // hard close — simulates crash/network failure
      stats.herdDisconnected++;
    }

    // Small delay to let servers process disconnections
    await new Promise((r) => setTimeout(r, 2000));

    // Reconnect all at once — this is the thundering herd
    console.log(`  Reconnecting ${disconnectCount} clients simultaneously (thundering herd)...\n`);

    const reconnectStart = Date.now();

    // Reconnect in batches to not overwhelm the test VM itself
    const herdBatchSize = Math.min(RAMP_RATE * 2, disconnectCount); // 2x ramp rate
    const herdBatches = Math.ceil(disconnectCount / herdBatchSize);
    const reconnectedClients = [];

    for (let b = 0; b < herdBatches; b++) {
      const bStart = b * herdBatchSize;
      const bEnd = Math.min(bStart + herdBatchSize, disconnectCount);
      const promises = [];

      for (let i = bStart; i < bEnd; i++) {
        const info = disconnectInfo[i];
        promises.push(
          createClient(info.id, {
            lastMessageId: info.lastMsgId,
            trackReplay: true,
            isHerdReconnect: true,
            noMessages: true, // don't send messages during reconnect phase
          })
        );
      }

      const results = await Promise.all(promises);
      for (const ws of results) {
        if (ws) reconnectedClients.push(ws);
      }

      console.log(`  Reconnected batch ${b + 1}/${herdBatches} (${bEnd}/${disconnectCount})`);
    }

    const reconnectDuration = Date.now() - reconnectStart;
    console.log(`\n  Thundering herd complete in ${(reconnectDuration / 1000).toFixed(1)}s`);
    console.log(`  Reconnected: ${stats.herdReconnected}, Failed: ${stats.herdReconnectFailed}`);
    console.log(`  Replays triggered: ${stats.replayClientsTriggered}, Messages replayed: ${stats.replayMessagesReceived}\n`);

    // Wait a bit for replays to complete
    await new Promise((r) => setTimeout(r, 5000));

    // ============================
    // PHASE 4: Post-herd stability
    // ============================
    const remainingTime = Math.max(TEST_DURATION_SEC - steadyDuration - Math.ceil(reconnectDuration / 1000) - 7, 10);
    console.log(`=== Phase 4: Post-herd stability (${remainingTime}s) ===\n`);

    // Re-enable messaging on reconnected clients
    for (const ws of reconnectedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        const id = ws._clientId;
        const interval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "message", text: `msg-${id}-${Date.now()}` }));
            stats.messagesSent++;
          } else {
            clearInterval(interval);
          }
        }, MESSAGE_INTERVAL_MS);
      }
    }

    const postHerdInterval = setInterval(() => {
      const activeConns = [...clients, ...reconnectedClients].filter(ws => ws.readyState === WebSocket.OPEN).length;
      console.log(
        `  [live] conns=${activeConns} sent=${stats.messagesSent} recv=${stats.messagesReceived} replays=${stats.replayMessagesReceived}`
      );
    }, 5000);

    await new Promise((r) => setTimeout(r, remainingTime * 1000));
    clearInterval(postHerdInterval);

    // Cleanup reconnected clients
    for (const ws of reconnectedClients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  }

  // Cleanup original clients
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }

  // Wait for graceful close
  await new Promise((r) => setTimeout(r, 2000));

  printReport();
  process.exit(0);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});

import WebSocket from "ws";

// --- Configuration ---
const TOTAL_CONNECTIONS = parseInt(process.env.TOTAL_CONNECTIONS || "10000");
const RAMP_RATE = parseInt(process.env.RAMP_RATE || "100");
const TEST_DURATION_SEC = parseInt(process.env.TEST_DURATION_SEC || "120");
const WS_URL = process.env.WS_URL || "ws://localhost/ws";
const THUNDERING_HERD = process.env.THUNDERING_HERD !== "false";
const HERD_DISCONNECT_PERCENT = parseInt(process.env.HERD_DISCONNECT_PERCENT || "80");

// --- Realistic chat patterns ---
const ACTIVE_SENDER_PERCENT = parseInt(process.env.ACTIVE_SENDER_PERCENT || "10");
const MIN_MSG_INTERVAL_MS = parseInt(process.env.MIN_MSG_INTERVAL_MS || "3000");
const MAX_MSG_INTERVAL_MS = parseInt(process.env.MAX_MSG_INTERVAL_MS || "15000");
const BURST_CHANCE = parseFloat(process.env.BURST_CHANCE || "0.3"); // 30% chance a sender does a burst
const BURST_COUNT_MIN = parseInt(process.env.BURST_COUNT_MIN || "2");
const BURST_COUNT_MAX = parseInt(process.env.BURST_COUNT_MAX || "5");
const BURST_DELAY_MS = parseInt(process.env.BURST_DELAY_MS || "800"); // delay between burst messages

// --- Room configuration ---
// Realistic mix: a few large groups, several medium, many small
const ROOM_CONFIG = [
  { name: "general", weight: 15 },      // ~15% of users — large company-wide channel
  { name: "announcements", weight: 8 },  // ~8% — mostly readers
  { name: "tech", weight: 10 },
  { name: "design", weight: 6 },
  { name: "marketing", weight: 5 },
  { name: "support", weight: 8 },
  { name: "random", weight: 12 },        // ~12% — active casual chat
  { name: "project-alpha", weight: 4 },
  { name: "project-beta", weight: 4 },
  { name: "project-gamma", weight: 3 },
  { name: "team-frontend", weight: 3 },
  { name: "team-backend", weight: 3 },
  { name: "team-mobile", weight: 2 },
  { name: "team-devops", weight: 2 },
  { name: "incidents", weight: 2 },
  { name: "watercooler", weight: 5 },
  { name: "book-club", weight: 1 },
  { name: "fitness", weight: 1 },
  { name: "food", weight: 2 },
  { name: "music", weight: 1 },
  { name: "gaming", weight: 1 },
  { name: "pets", weight: 1 },
  { name: "travel", weight: 1 },
];

const totalWeight = ROOM_CONFIG.reduce((sum, r) => sum + r.weight, 0);

function pickRoom() {
  let roll = Math.random() * totalWeight;
  for (const room of ROOM_CONFIG) {
    roll -= room.weight;
    if (roll <= 0) return room.name;
  }
  return ROOM_CONFIG[0].name;
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

// Realistic message templates
const MESSAGE_TEMPLATES = [
  "Hey, has anyone looked at this?",
  "I'll take a look at it",
  "Sounds good to me",
  "Let me check and get back to you",
  "Can someone review this?",
  "Updated the doc, please take a look",
  "Meeting in 5 minutes",
  "Thanks for the update!",
  "I agree with that approach",
  "Let's discuss this in the standup",
  "Working on it now",
  "Deployed to staging",
  "LGTM, merging now",
  "Can we push this to next sprint?",
  "Great work on this!",
  "Anyone available for a quick call?",
  "Just saw the alert, checking now",
  "Fixed the issue, deploying shortly",
  "The build is green now",
  "PR is ready for review",
];

function randomMessage(username) {
  const template = MESSAGE_TEMPLATES[Math.floor(Math.random() * MESSAGE_TEMPLATES.length)];
  return template;
}

// --- Stats ---
const stats = {
  connectionsOpened: 0,
  connectionsFailed: 0,
  connectionsClosed: 0,
  connectLatencies: [],

  messagesSent: 0,
  messagesReceived: 0,
  crossServerMessages: 0,

  activeSenders: 0,
  passiveReaders: 0,

  herdDisconnected: 0,
  herdReconnected: 0,
  herdReconnectFailed: 0,
  herdReconnectLatencies: [],

  replayMessagesReceived: 0,
  replayClientsTriggered: 0,

  serverReconnectSignals: 0,

  roomDistribution: {},
};

const allClients = [];
const seenServers = new Set();

function createClient(id, opts = {}) {
  const { lastMessageId = 0, trackReplay = false, isHerdReconnect = false, isSender = false, room: forceRoom = null } = opts;

  return new Promise((resolve) => {
    const username = `user-${id}`;
    const room = forceRoom || pickRoom();
    let url = `${WS_URL}?username=${username}&room=${room}`;
    if (lastMessageId > 0) url += `&lastMessageId=${lastMessageId}`;

    const start = Date.now();
    const ws = new WebSocket(url);
    let connected = false;
    let serverId = null;
    let sendTimer = null;
    let clientLastMsgId = lastMessageId;
    let inReplay = false;
    let replayCount = 0;

    ws._clientId = id;
    ws._room = room;
    ws._username = username;
    ws._isSender = isSender;
    ws._getLastMsgId = () => clientLastMsgId;

    // Track room distribution
    stats.roomDistribution[room] = (stats.roomDistribution[room] || 0) + 1;

    ws.on("open", () => {
      connected = true;
      const latency = Date.now() - start;

      if (isHerdReconnect) {
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

            // Only senders send messages
            if (isSender && !opts.noMessages) {
              stats.activeSenders++;
              scheduleSend(ws, username);
            } else if (!isSender) {
              stats.passiveReaders++;
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
      } catch {}
    });

    ws.on("close", () => {
      if (connected) stats.connectionsClosed++;
      if (ws._sendTimer) clearTimeout(ws._sendTimer);
    });

    ws.on("error", () => {
      if (!connected) {
        if (isHerdReconnect) {
          stats.herdReconnectFailed++;
        } else {
          stats.connectionsFailed++;
        }
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!connected) {
        if (isHerdReconnect) {
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

function scheduleSend(ws, username) {
  if (ws.readyState !== WebSocket.OPEN) return;

  // Decide: normal message or burst?
  if (Math.random() < BURST_CHANCE) {
    // Burst: send 2-5 messages quickly
    const burstCount = randomBetween(BURST_COUNT_MIN, BURST_COUNT_MAX + 1);
    let sent = 0;

    function sendBurst() {
      if (sent >= burstCount || ws.readyState !== WebSocket.OPEN) {
        // After burst, take a longer break
        const cooldown = randomBetween(MAX_MSG_INTERVAL_MS, MAX_MSG_INTERVAL_MS * 2);
        ws._sendTimer = setTimeout(() => scheduleSend(ws, username), cooldown);
        return;
      }
      ws.send(JSON.stringify({ type: "message", text: randomMessage(username) }));
      stats.messagesSent++;
      sent++;
      ws._sendTimer = setTimeout(sendBurst, BURST_DELAY_MS);
    }
    sendBurst();
  } else {
    // Normal: single message, then wait
    ws.send(JSON.stringify({ type: "message", text: randomMessage(username) }));
    stats.messagesSent++;

    const nextDelay = randomBetween(MIN_MSG_INTERVAL_MS, MAX_MSG_INTERVAL_MS);
    ws._sendTimer = setTimeout(() => scheduleSend(ws, username), nextDelay);
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[idx];
}

function activeCount() {
  return allClients.filter(ws => ws && ws.readyState === WebSocket.OPEN).length;
}

function printReport() {
  const mem = process.memoryUsage();

  const avgConnect = stats.connectLatencies.length > 0
    ? Math.round(stats.connectLatencies.reduce((a, b) => a + b, 0) / stats.connectLatencies.length)
    : 0;
  const p50Connect = percentile(stats.connectLatencies, 50);
  const p99Connect = percentile(stats.connectLatencies, 99);

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║              LOAD TEST REPORT                        ║");
  console.log("╠══════════════════════════════════════════════════════╣");

  console.log("\n--- Test Configuration ---");
  console.log(`  Total connections:          ${TOTAL_CONNECTIONS}`);
  console.log(`  Active senders:             ${ACTIVE_SENDER_PERCENT}% (${Math.floor(TOTAL_CONNECTIONS * ACTIVE_SENDER_PERCENT / 100)})`);
  console.log(`  Passive readers:            ${100 - ACTIVE_SENDER_PERCENT}% (${TOTAL_CONNECTIONS - Math.floor(TOTAL_CONNECTIONS * ACTIVE_SENDER_PERCENT / 100)})`);
  console.log(`  Rooms:                      ${ROOM_CONFIG.length}`);
  console.log(`  Message interval:           ${MIN_MSG_INTERVAL_MS}-${MAX_MSG_INTERVAL_MS}ms`);
  console.log(`  Burst chance:               ${(BURST_CHANCE * 100).toFixed(0)}%`);

  console.log("\n--- Connection Phase ---");
  console.log(`  Target connections:         ${TOTAL_CONNECTIONS}`);
  console.log(`  Opened:                     ${stats.connectionsOpened}`);
  console.log(`  Failed:                     ${stats.connectionsFailed}`);
  console.log(`  Active at end:              ${activeCount()}`);
  console.log(`  Closed during test:         ${stats.connectionsClosed}`);
  console.log(`  Success rate:               ${((stats.connectionsOpened / TOTAL_CONNECTIONS) * 100).toFixed(1)}%`);
  console.log(`  Connect latency (avg):      ${avgConnect}ms`);
  console.log(`  Connect latency (P50):      ${p50Connect}ms`);
  console.log(`  Connect latency (P99):      ${p99Connect}ms`);

  console.log("\n--- Messaging Phase ---");
  console.log(`  Active senders:             ${stats.activeSenders}`);
  console.log(`  Passive readers:            ${stats.passiveReaders}`);
  console.log(`  Messages sent:              ${stats.messagesSent}`);
  console.log(`  Messages received:          ${stats.messagesReceived}`);
  console.log(`  Cross-server deliveries:    ${stats.crossServerMessages}`);
  const avgPerSender = stats.activeSenders > 0 ? (stats.messagesSent / stats.activeSenders).toFixed(1) : "N/A";
  console.log(`  Avg messages per sender:    ${avgPerSender}`);

  console.log("\n--- Room Distribution ---");
  const sortedRooms = Object.entries(stats.roomDistribution).sort((a, b) => b[1] - a[1]);
  for (const [room, count] of sortedRooms.slice(0, 10)) {
    const bar = "█".repeat(Math.ceil(count / (TOTAL_CONNECTIONS / 50)));
    console.log(`  ${room.padEnd(20)} ${String(count).padStart(5)} users ${bar}`);
  }
  if (sortedRooms.length > 10) {
    console.log(`  ... and ${sortedRooms.length - 10} more rooms`);
  }

  if (THUNDERING_HERD) {
    const avgHerd = stats.herdReconnectLatencies.length > 0
      ? Math.round(stats.herdReconnectLatencies.reduce((a, b) => a + b, 0) / stats.herdReconnectLatencies.length)
      : 0;
    const p50Herd = percentile(stats.herdReconnectLatencies, 50);
    const p99Herd = percentile(stats.herdReconnectLatencies, 99);

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

  console.log("\n╚══════════════════════════════════════════════════════╝\n");
}

async function main() {
  const senderCount = Math.floor(TOTAL_CONNECTIONS * ACTIVE_SENDER_PERCENT / 100);
  const readerCount = TOTAL_CONNECTIONS - senderCount;

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║          REALISTIC LOAD TEST STARTING                ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`  Target:             ${WS_URL}`);
  console.log(`  Connections:        ${TOTAL_CONNECTIONS}`);
  console.log(`  Active senders:     ${senderCount} (${ACTIVE_SENDER_PERCENT}%)`);
  console.log(`  Passive readers:    ${readerCount} (${100 - ACTIVE_SENDER_PERCENT}%)`);
  console.log(`  Ramp rate:          ${RAMP_RATE}/sec`);
  console.log(`  Rooms:              ${ROOM_CONFIG.length} (weighted distribution)`);
  console.log(`  Message interval:   ${MIN_MSG_INTERVAL_MS}-${MAX_MSG_INTERVAL_MS}ms (randomized)`);
  console.log(`  Burst chance:       ${(BURST_CHANCE * 100).toFixed(0)}% (${BURST_COUNT_MIN}-${BURST_COUNT_MAX} msgs)`);
  console.log(`  Duration:           ${TEST_DURATION_SEC}s`);
  console.log(`  Thundering herd:    ${THUNDERING_HERD ? `enabled (${HERD_DISCONNECT_PERCENT}%)` : "disabled"}`);
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ============================
  // PHASE 1: Ramp up connections
  // ============================
  console.log("=== Phase 1: Ramping up connections ===\n");

  // Distribute senders evenly across batches
  const batchSize = RAMP_RATE;
  const batches = Math.ceil(TOTAL_CONNECTIONS / batchSize);
  let sendersAssigned = 0;

  for (let b = 0; b < batches; b++) {
    const start = b * batchSize;
    const end = Math.min(start + batchSize, TOTAL_CONNECTIONS);
    const batchCount = end - start;
    const promises = [];

    // How many senders in this batch (proportional)
    const sendersInBatch = Math.min(
      Math.round(batchCount * ACTIVE_SENDER_PERCENT / 100),
      senderCount - sendersAssigned
    );

    for (let i = start; i < end; i++) {
      const isSender = (i - start) < sendersInBatch;
      if (isSender) sendersAssigned++;

      promises.push(createClient(i, { isSender }));
    }

    const results = await Promise.all(promises);
    for (const ws of results) {
      if (ws) allClients.push(ws);
    }

    console.log(`  Ramped ${end}/${TOTAL_CONNECTIONS} (${allClients.length} active, ${stats.connectionsFailed} failed)`);

    if (b < batches - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`\n  Phase 1 complete: ${allClients.length} connections (${stats.activeSenders} senders, ${stats.passiveReaders} readers)\n`);

  // ============================
  // PHASE 2: Steady state
  // ============================
  console.log("=== Phase 2: Steady state messaging ===\n");

  const steadyDuration = THUNDERING_HERD
    ? Math.max(Math.floor(TEST_DURATION_SEC * 0.4), 20)
    : TEST_DURATION_SEC;

  console.log(`  Running for ${steadyDuration}s...\n`);

  const statsInterval = setInterval(() => {
    const active = activeCount();
    console.log(
      `  [live] active=${active} sent=${stats.messagesSent} recv=${stats.messagesReceived} cross=${stats.crossServerMessages}`
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

    const disconnectCount = Math.floor(allClients.length * (HERD_DISCONNECT_PERCENT / 100));
    const toDisconnect = allClients.slice(0, disconnectCount);
    const disconnectInfo = [];

    console.log(`  Disconnecting ${disconnectCount} clients simultaneously...\n`);

    for (const ws of toDisconnect) {
      disconnectInfo.push({
        id: ws._clientId,
        lastMsgId: ws._getLastMsgId(),
        room: ws._room,
        isSender: ws._isSender,
      });
      ws.terminate();
      stats.herdDisconnected++;
    }

    await new Promise((r) => setTimeout(r, 2000));

    console.log(`  Reconnecting ${disconnectCount} clients simultaneously (thundering herd)...\n`);

    const reconnectStart = Date.now();
    const herdBatchSize = Math.min(RAMP_RATE * 2, disconnectCount);
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
            isSender: info.isSender,
            noMessages: true,
            room: info.room,
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

    await new Promise((r) => setTimeout(r, 5000));

    // ============================
    // PHASE 4: Post-herd stability
    // ============================
    const remainingTime = Math.max(TEST_DURATION_SEC - steadyDuration - Math.ceil(reconnectDuration / 1000) - 7, 10);
    console.log(`=== Phase 4: Post-herd stability (${remainingTime}s) ===\n`);

    // Re-enable messaging on reconnected senders
    for (const ws of reconnectedClients) {
      if (ws.readyState === WebSocket.OPEN && ws._isSender) {
        scheduleSend(ws, ws._username);
      }
    }

    const postHerdInterval = setInterval(() => {
      const active = activeCount() + reconnectedClients.filter(ws => ws.readyState === WebSocket.OPEN).length;
      console.log(
        `  [live] active=${active} sent=${stats.messagesSent} recv=${stats.messagesReceived} replays=${stats.replayMessagesReceived}`
      );
    }, 5000);

    await new Promise((r) => setTimeout(r, remainingTime * 1000));
    clearInterval(postHerdInterval);

    for (const ws of reconnectedClients) {
      if (ws._sendTimer) clearTimeout(ws._sendTimer);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
  }

  // Cleanup
  for (const ws of allClients) {
    if (ws._sendTimer) clearTimeout(ws._sendTimer);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }

  await new Promise((r) => setTimeout(r, 2000));

  printReport();
  process.exit(0);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});

import WebSocket from "ws";

const TOTAL_CONNECTIONS = parseInt(
  process.env.TOTAL_CONNECTIONS || "10000",
);
const RAMP_RATE = parseInt(process.env.RAMP_RATE || "100"); // connections per second
const MESSAGE_INTERVAL_MS = parseInt(
  process.env.MESSAGE_INTERVAL_MS || "2000",
);
const TEST_DURATION_SEC = parseInt(
  process.env.TEST_DURATION_SEC || "60",
);
const NUM_ROOMS = parseInt(process.env.NUM_ROOMS || "10");
const WS_URL = process.env.WS_URL || "ws://localhost/ws";

const stats = {
  connectionsOpened: 0,
  connectionsFailed: 0,
  messagesSent: 0,
  messagesReceived: 0,
  crossServerMessages: 0,
  connectLatencies: [],
  reconnections: 0,
};

const clients = [];
const seenServers = new Set();

function createClient(id) {
  return new Promise((resolve) => {
    const username = `loaduser-${id}`;
    const room = `loadtest-${id % NUM_ROOMS}`;
    const url = `${WS_URL}?username=${username}&room=${room}`;

    const start = Date.now();
    const ws = new WebSocket(url);
    let connected = false;
    let serverId = null;
    let msgInterval = null;

    ws.on("open", () => {
      connected = true;
      const latency = Date.now() - start;
      stats.connectLatencies.push(latency);
      stats.connectionsOpened++;
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "welcome") {
          serverId = msg.serverId;
          seenServers.add(serverId);
          resolve(ws);

          // Start sending messages periodically
          msgInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "message",
                  text: `msg from ${username}`,
                }),
              );
              stats.messagesSent++;
            }
          }, MESSAGE_INTERVAL_MS);
        } else if (msg.type === "message") {
          stats.messagesReceived++;
          if (msg.serverId && msg.serverId !== serverId) {
            stats.crossServerMessages++;
          }
        } else if (msg.type === "reconnect") {
          stats.reconnections++;
        }
      } catch {
        // ignore
      }
    });

    ws.on("close", () => {
      if (msgInterval) clearInterval(msgInterval);
    });

    ws.on("error", () => {
      if (!connected) {
        stats.connectionsFailed++;
        resolve(null);
      }
    });

    // Timeout after 10s
    setTimeout(() => {
      if (!connected) {
        stats.connectionsFailed++;
        ws.terminate();
        resolve(null);
      }
    }, 10000);
  });
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[idx];
}

function printReport() {
  const avg =
    stats.connectLatencies.length > 0
      ? Math.round(
          stats.connectLatencies.reduce(
            (a, b) => a + b,
            0,
          ) / stats.connectLatencies.length,
        )
      : 0;
  const p99 = percentile(stats.connectLatencies, 99);
  const mem = process.memoryUsage();

  console.log("\n========== Load Test Report ==========");
  console.log(
    `Total target connections:   ${TOTAL_CONNECTIONS}`,
  );
  console.log(
    `Connections opened:         ${stats.connectionsOpened}`,
  );
  console.log(
    `Connections failed:         ${stats.connectionsFailed}`,
  );
  console.log(
    `Messages sent:              ${stats.messagesSent}`,
  );
  console.log(
    `Messages received:          ${stats.messagesReceived}`,
  );
  console.log(
    `Cross-server deliveries:    ${stats.crossServerMessages}`,
  );
  console.log(`Connect latency (avg):      ${avg}ms`);
  console.log(`Connect latency (P99):      ${p99}ms`);
  console.log(
    `Reconnections:              ${stats.reconnections}`,
  );
  console.log(
    `Unique servers seen:        ${[...seenServers].join(", ") || "none"}`,
  );
  console.log(
    `Client memory (RSS):        ${Math.round(mem.rss / 1024 / 1024)} MB`,
  );
  console.log("=======================================\n");
}

async function main() {
  console.log(
    `Starting load test: ${TOTAL_CONNECTIONS} connections at ${RAMP_RATE}/s`,
  );
  console.log(
    `Message interval: ${MESSAGE_INTERVAL_MS}ms, Duration: ${TEST_DURATION_SEC}s`,
  );
  console.log(`Target: ${WS_URL}\n`);

  const batchSize = RAMP_RATE;
  const batches = Math.ceil(TOTAL_CONNECTIONS / batchSize);

  for (let b = 0; b < batches; b++) {
    const start = b * batchSize;
    const end = Math.min(
      start + batchSize,
      TOTAL_CONNECTIONS,
    );
    const promises = [];

    for (let i = start; i < end; i++) {
      promises.push(createClient(i));
    }

    const results = await Promise.all(promises);
    for (const ws of results) {
      if (ws) clients.push(ws);
    }

    console.log(
      `  Ramped ${end}/${TOTAL_CONNECTIONS} connections (${stats.connectionsFailed} failed)`,
    );

    if (b < batches - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(
    `\nAll connections established. Running for ${TEST_DURATION_SEC}s...\n`,
  );

  // Print periodic stats
  const statsInterval = setInterval(() => {
    console.log(
      `  [live] sent=${stats.messagesSent} recv=${stats.messagesReceived} cross=${stats.crossServerMessages} conns=${stats.connectionsOpened - stats.connectionsFailed}`,
    );
  }, 5000);

  await new Promise((r) =>
    setTimeout(r, TEST_DURATION_SEC * 1000),
  );

  clearInterval(statsInterval);

  // Cleanup
  for (const ws of clients) {
    ws.close();
  }

  printReport();
  process.exit(0);
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});

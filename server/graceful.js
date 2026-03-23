import { drainNats } from "./nats-bridge.js";
import { getPool } from "./db.js";

export function setupGracefulShutdown(server, wss, nc) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] Received ${signal}, starting graceful shutdown...`);

    // 1. Stop accepting new connections
    server.close(() => {
      console.log("[shutdown] HTTP server closed");
    });

    // 2. Send staggered reconnect to each client
    let i = 0;
    for (const client of wss.clients) {
      try {
        client.send(
          JSON.stringify({
            type: "reconnect",
            delay: 1000 + i * 50,
          })
        );
      } catch {
        // client may already be gone
      }
      i++;
    }
    console.log(`[shutdown] Sent reconnect to ${i} clients`);

    // 3. Drain NATS
    if (nc) {
      await drainNats(nc);
    }

    // 4. Grace period
    console.log("[shutdown] Waiting 6s grace period...");
    await new Promise((r) => setTimeout(r, 6000));

    // 5. Force-close remaining connections
    for (const client of wss.clients) {
      client.terminate();
    }
    console.log("[shutdown] Force-closed remaining connections");

    // 6. Close MySQL pool
    const pool = getPool();
    if (pool) {
      await pool.end();
      console.log("[shutdown] MySQL pool closed");
    }

    // 7. Exit
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

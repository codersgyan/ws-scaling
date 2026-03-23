import { createServer } from "http";
import { WebSocketServer } from "ws";
import { URL } from "url";
import { initDb, saveMessage, getMessagesSince } from "./db.js";
import {
  initNats,
  publishMessage,
  subscribeToRoom,
  unsubscribeFromRoom,
} from "./nats-bridge.js";
import { getMetrics } from "./metrics.js";
import { setupGracefulShutdown } from "./graceful.js";

const PORT = parseInt(process.env.PORT || "8080");
const SERVER_ID = process.env.SERVER_ID || `server-${process.pid}`;

// room -> Set<{ ws, username }>
const rooms = new Map();

function addToRoom(room, client) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client);
}

function removeFromRoom(room, client) {
  const set = rooms.get(room);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) rooms.delete(room);
}

function broadcastToRoom(room, message, excludeWs = null) {
  const set = rooms.get(room);
  if (!set) return;
  const data = JSON.stringify(message);
  for (const client of set) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

async function main() {
  const pool = await initDb();
  const nc = await initNats();

  // NATS message handler — called when a message arrives for a room we're subscribed to
  function handleNatsMessage(data) {
    broadcastToRoom(data.room, {
      type: "message",
      id: data.id,
      room: data.room,
      username: data.username,
      text: data.text,
      serverId: data.serverId,
      createdAt: data.createdAt,
    });
  }

  // HTTP server for metrics
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getMetrics(wss, rooms, SERVER_ID)));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  // WebSocket server in noServer mode
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const username = url.searchParams.get("username");
    const room = url.searchParams.get("room");

    if (!username || !room) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.username = username;
      ws.room = room;
      ws.lastMessageId = url.searchParams.get("lastMessageId");
      wss.emit("connection", ws, req);
    });
  });

  // --- Ping/Pong heartbeat to detect zombie connections ---
  const HEARTBEAT_INTERVAL = 30000; // ping every 30s
  const HEARTBEAT_TIMEOUT = 10000;  // wait 10s for pong

  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.log(`[ws] Terminating zombie connection: ${ws.username}`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on("close", () => clearInterval(heartbeatInterval));

  wss.on("connection", async (ws) => {
    const { username, room, lastMessageId } = ws;
    const client = { ws, username };

    // Mark connection as alive
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    addToRoom(room, client);

    // Subscribe to NATS for this room if first local user
    subscribeToRoom(nc, room, SERVER_ID, handleNatsMessage);

    console.log(
      `[ws] ${username} joined room ${room} on ${SERVER_ID} (${rooms.get(room)?.size} in room)`
    );

    // Send welcome
    ws.send(
      JSON.stringify({
        type: "welcome",
        serverId: SERVER_ID,
        room,
        username,
      })
    );

    // Replay missed messages if reconnecting
    if (lastMessageId) {
      try {
        ws.send(JSON.stringify({ type: "replay_start" }));
        const missed = await getMessagesSince(room, parseInt(lastMessageId));
        for (const msg of missed) {
          ws.send(
            JSON.stringify({
              type: "message",
              id: msg.id,
              room: msg.room,
              username: msg.username,
              text: msg.text,
              serverId: msg.server_id,
              createdAt: msg.created_at,
            })
          );
        }
        ws.send(
          JSON.stringify({ type: "replay_end", count: missed.length })
        );
        console.log(
          `[ws] Replayed ${missed.length} messages to ${username} since id ${lastMessageId}`
        );
      } catch (err) {
        console.error("[ws] Replay error:", err.message);
      }
    }

    // Handle incoming messages
    ws.on("message", async (raw) => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type !== "message") return;

        const text = parsed.text?.trim();
        if (!text) return;

        // Save to MySQL
        const id = await saveMessage({
          room,
          username,
          text,
          serverId: SERVER_ID,
        });

        const outgoing = {
          type: "message",
          id: Number(id),
          room,
          username,
          text,
          serverId: SERVER_ID,
          createdAt: new Date().toISOString(),
        };

        // Deliver to local room members
        broadcastToRoom(room, outgoing);

        // Publish to NATS for other servers
        publishMessage(nc, room, outgoing);
      } catch (err) {
        console.error("[ws] Message handling error:", err.message);
      }
    });

    ws.on("close", () => {
      removeFromRoom(room, client);

      // Unsubscribe from NATS if no local users left in this room
      if (!rooms.has(room)) {
        unsubscribeFromRoom(room);
      }

      console.log(
        `[ws] ${username} left room ${room} on ${SERVER_ID}`
      );
    });

    ws.on("error", (err) => {
      console.error(`[ws] Error for ${username}:`, err.message);
    });
  });

  // Graceful shutdown
  setupGracefulShutdown(server, wss, nc);

  server.listen(PORT, () => {
    console.log(`[server] ${SERVER_ID} listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] Fatal:", err);
  process.exit(1);
});

import { connect, JSONCodec } from "nats";

const jc = JSONCodec();

export async function initNats() {
  const url = process.env.NATS_URL || "nats://localhost:4222";

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const nc = await connect({ servers: url });
      console.log(`[nats] Connected on attempt ${attempt}`);
      return nc;
    } catch (err) {
      console.log(`[nats] Attempt ${attempt}/10 failed: ${err.message}`);
      if (attempt === 10) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export function publishMessage(nc, room, payload) {
  nc.publish(`chat.${room}`, jc.encode(payload));
}

export function subscribeToMessages(nc, serverId, onMessage) {
  const sub = nc.subscribe("chat.*");

  (async () => {
    for await (const msg of sub) {
      try {
        const data = jc.decode(msg.data);
        if (data.serverId === serverId) continue; // skip own messages
        onMessage(data);
      } catch (err) {
        console.error("[nats] Failed to decode message:", err.message);
      }
    }
  })();

  return sub;
}

export async function drainNats(nc) {
  try {
    await nc.drain();
    console.log("[nats] Drained");
  } catch (err) {
    console.error("[nats] Drain error:", err.message);
  }
}

import mysql from "mysql2/promise";

let pool;

export async function initDb() {
  const config = {
    host: process.env.MYSQL_HOST || "localhost",
    port: parseInt(process.env.MYSQL_PORT || "3306"),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "rootpass",
    database: process.env.MYSQL_DATABASE || "wschat",
    waitForConnections: true,
    connectionLimit: 50,
    queueLimit: 0,
    ...(process.env.MYSQL_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  };

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      pool = mysql.createPool(config);
      const conn = await pool.getConnection();
      conn.release();
      console.log(`[db] Connected to MySQL on attempt ${attempt}`);
      return pool;
    } catch (err) {
      console.log(`[db] Attempt ${attempt}/10 failed: ${err.message}`);
      if (attempt === 10) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function saveMessage({ room, username, text, serverId }) {
  const [result] = await pool.execute(
    "INSERT INTO messages (room, username, text, server_id) VALUES (?, ?, ?, ?)",
    [room, username, text, serverId]
  );
  return result.insertId;
}

export async function getMessagesSince(room, lastMessageId) {
  const [rows] = await pool.execute(
    "SELECT id, room, username, text, server_id, created_at FROM messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT 1000",
    [room, lastMessageId]
  );
  return rows;
}

export function getPool() {
  return pool;
}

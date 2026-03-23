export function getMetrics(wss, rooms, serverId) {
  const mem = process.memoryUsage();
  const roomStats = {};

  for (const [room, clients] of rooms.entries()) {
    roomStats[room] = clients.size;
  }

  return {
    serverId,
    connections: wss.clients.size,
    rooms: roomStats,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    uptime: Math.round(process.uptime()),
  };
}

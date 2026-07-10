import { config } from '../config.js';
import { getDb } from '../db/index.js';

function dbStats() {
  try {
    const db = getDb();
    const wallets = Number(db.prepare(`SELECT COUNT(*) AS n FROM wallets`).get()?.n) || 0;
    const positions = Number(db.prepare(`SELECT COUNT(*) AS n FROM positions`).get()?.n) || 0;
    const stakers =
      Number(
        db.prepare(`SELECT COUNT(DISTINCT address) AS n FROM positions`).get()?.n
      ) || 0;
    return { wallets, positions, stakers };
  } catch {
    return null;
  }
}

export default async function healthRoutes(app) {
  app.get('/health', async () => {
    let dbOk = false;
    try {
      getDb().prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return {
      ok: true,
      service: 'moze-api',
      db: dbOk,
      // Persistence check: these counts survive redeploys when /data volume is mounted
      databasePath: config.databasePath,
      stake: dbOk ? dbStats() : null,
      chainId: config.chainId,
      moze: config.mozeCa,
      time: new Date().toISOString(),
    };
  });
}

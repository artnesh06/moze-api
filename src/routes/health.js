import { config } from '../config.js';
import { getDb } from '../db/index.js';

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
      chainId: config.chainId,
      moze: config.mozeCa,
      time: new Date().toISOString(),
    };
  });
}

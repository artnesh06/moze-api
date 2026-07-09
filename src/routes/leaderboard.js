import { getHolders, getLeaderboard, refreshHolders } from '../services/holders.js';
import { normalizeAddress } from '../services/auth.js';

export default async function leaderboardRoutes(app) {
  app.get('/v1/holders', async (req) => {
    const force = String(req.query.force || '') === '1';
    const data = await getHolders({ force });
    return {
      wallets: data.rows,
      walletCount: data.walletCount,
      supply: data.supply,
      updatedAt: data.updatedAt,
      stale: data.stale,
      scanning: data.scanning || false,
    };
  });

  app.get('/v1/leaderboard', async (req) => {
    const force = String(req.query.force || '') === '1';
    const top = Number(req.query.top || 25);
    const you = normalizeAddress(req.query.you || '');
    const data = await getLeaderboard({ top, force });

    let youRow = null;
    if (you) {
      const idx = data.rows.findIndex((r) => r.addr === you);
      if (idx >= 0) {
        youRow = { rank: idx + 1, ...data.rows[idx] };
      }
    }

    return {
      top: data.top,
      rows: data.rows,
      you: youRow,
      supply: data.supply,
      walletCount: data.walletCount,
      stakerCount: data.stakerCount ?? data.rows.length,
      updatedAt: data.updatedAt,
      stale: data.stale,
      scanning: data.scanning || false,
    };
  });

  app.post('/v1/holders/refresh', async (req, reply) => {
    // optional simple secret for manual refresh
    const secret = process.env.ADMIN_SECRET;
    if (secret && req.headers['x-admin-secret'] !== secret) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const data = await refreshHolders();
    return { ok: true, walletCount: data.walletCount, supply: data.supply, updatedAt: data.updatedAt };
  });
}

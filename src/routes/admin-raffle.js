/**
 * Admin raffle CRUD — protected by x-admin-secret (ADMIN_SECRET env).
 * Used by mozebot dashboard / ops to create raffles that power the live site.
 */
import { config } from '../config.js';
import {
  listRafflesAdmin,
  createRaffle,
  updateRaffle,
  deleteRaffle,
  setRaffleStatus,
  drawRaffle,
} from '../services/raffle.js';

function requireAdmin(req, reply) {
  const secret = process.env.ADMIN_SECRET || config.adminSecret || '';
  if (!secret) {
    reply.code(503).send({ error: 'ADMIN_SECRET not configured' });
    return false;
  }
  const got = req.headers['x-admin-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!got || got !== secret) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export default async function adminRaffleRoutes(app) {
  app.get('/v1/admin/raffles', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: true, raffles: listRafflesAdmin() };
  });

  app.post('/v1/admin/raffles', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const raffle = createRaffle(req.body || {});
      return { ok: true, raffle };
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: err.message || 'Create failed' });
    }
  });

  app.put('/v1/admin/raffles/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const id = Number(req.params.id);
      const raffle = updateRaffle(id, req.body || {});
      return { ok: true, raffle };
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: err.message || 'Update failed' });
    }
  });

  app.patch('/v1/admin/raffles/:id/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const id = Number(req.params.id);
      const status = String(req.body?.status || '').toLowerCase();
      const raffle = setRaffleStatus(id, status);
      return { ok: true, raffle };
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: err.message || 'Status failed' });
    }
  });

  app.delete('/v1/admin/raffles/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const id = Number(req.params.id);
      // refuse delete if entries exist unless force=1
      const force = String(req.query.force || '') === '1';
      deleteRaffle(id, { force });
      return { ok: true, id };
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: err.message || 'Delete failed' });
    }
  });

  /** Weighted ticket draw — sets winner + status=drawn */
  app.post('/v1/admin/raffles/:id/draw', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const id = Number(req.params.id);
      const force =
        String(req.query.force || '') === '1' ||
        req.body?.force === true ||
        req.body?.force === 1;
      const result = drawRaffle(id, { force });
      return result;
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: err.message || 'Draw failed' });
    }
  });
}

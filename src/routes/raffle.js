import { normalizeAddress, verifyRaffleSignature } from '../services/auth.js';
import { getRaffleSummary, enterRaffle } from '../services/raffle.js';

export default async function raffleRoutes(app) {
  /**
   * Active / selected raffle + stats.
   * Query: ?you=0x  ?id=2  ?slug=moze-raffle-2
   * Returns { raffles: [...], raffle: full selected }.
   */
  app.get('/v1/raffle', async (req) => {
    const you = normalizeAddress(req.query.you || '');
    const idRaw = req.query.id;
    const id = idRaw != null && idRaw !== '' ? Number(idRaw) : null;
    const slug = req.query.slug ? String(req.query.slug) : null;
    return getRaffleSummary({
      you: you || null,
      id: Number.isFinite(id) ? id : null,
      slug,
    });
  });

  /** Spend pending soft $MOZE for tickets (signed). */
  app.post('/v1/raffle/enter', async (req, reply) => {
    try {
      const body = req.body || {};
      const tickets = Math.floor(Number(body.tickets || 1));
      const raffleId = Number(body.raffleId ?? body.raffle_id);
      if (!Number.isFinite(raffleId)) {
        return reply.code(400).send({ error: 'raffleId required' });
      }

      const { address } = verifyRaffleSignature({
        address: body.address,
        raffleId,
        tickets,
        nonce: body.nonce,
        timestamp: body.timestamp,
        signature: body.signature,
      });

      const result = enterRaffle({ address, raffleId, tickets });
      return result;
    } catch (err) {
      const status = err.statusCode || 400;
      return reply.code(status).send({
        error: err.message || 'Enter failed',
        code: err.code,
        need: err.need,
        have: err.have,
      });
    }
  });
}

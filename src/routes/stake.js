import { verifyActionSignature, normalizeAddress } from '../services/auth.js';
import {
  getStakeState,
  stakeTokens,
  unstakeTokens,
  claimMoze,
} from '../services/stake.js';
import { buildActionMessage } from '../services/auth.js';

function parseIds(body) {
  const raw = body?.tokenIds ?? body?.token_ids ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map(Number).filter((n) => Number.isFinite(n));
}

export default async function stakeRoutes(app) {
  app.get('/v1/stake/:address', async (req, reply) => {
    const address = normalizeAddress(req.params.address);
    if (!address) return reply.code(400).send({ error: 'Invalid address' });
    return getStakeState(address);
  });

  app.post('/v1/stake', async (req, reply) => {
    try {
      const body = req.body || {};
      const tokenIds = parseIds(body);
      const { address } = verifyActionSignature({
        action: 'stake',
        address: body.address,
        tokenIds,
        nonce: body.nonce,
        timestamp: body.timestamp,
        signature: body.signature,
      });
      const result = await stakeTokens(address, tokenIds);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: err.message || 'Stake failed' });
    }
  });

  app.post('/v1/unstake', async (req, reply) => {
    try {
      const body = req.body || {};
      const tokenIds = parseIds(body);
      const { address } = verifyActionSignature({
        action: 'unstake',
        address: body.address,
        tokenIds,
        nonce: body.nonce,
        timestamp: body.timestamp,
        signature: body.signature,
      });
      const result = unstakeTokens(address, tokenIds);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: err.message || 'Unstake failed' });
    }
  });

  app.post('/v1/claim', async (req, reply) => {
    try {
      const body = req.body || {};
      const { address } = verifyActionSignature({
        action: 'claim',
        address: body.address,
        tokenIds: [],
        nonce: body.nonce,
        timestamp: body.timestamp,
        signature: body.signature,
      });
      const result = claimMoze(address);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: err.message || 'Claim failed' });
    }
  });

  /** Helper: build exact message client must sign */
  app.post('/v1/stake/message', async (req, reply) => {
    const body = req.body || {};
    const address = normalizeAddress(body.address);
    if (!address) return reply.code(400).send({ error: 'Invalid address' });
    const action = String(body.action || 'stake');
    if (!['stake', 'unstake', 'claim'].includes(action)) {
      return reply.code(400).send({ error: 'Invalid action' });
    }
    const tokenIds = parseIds(body);
    const nonce = body.nonce;
    const timestamp = Number(body.timestamp);
    if (!nonce || !Number.isFinite(timestamp)) {
      return reply.code(400).send({ error: 'nonce and timestamp required' });
    }
    return {
      message: buildActionMessage({ action, address, tokenIds, nonce, timestamp }),
    };
  });
}

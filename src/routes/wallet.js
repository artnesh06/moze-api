import { normalizeAddress } from '../services/auth.js';
import { tokensOfOwner } from '../services/chain.js';

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      setTimeout(() => rej(new Error(label)), ms);
    }),
  ]);
}

export default async function walletRoutes(app) {
  /** Owned Moze token IDs for a wallet (server-side RPC — avoids browser RPC glitches). */
  app.get('/v1/wallet/:address/tokens', async (req, reply) => {
    const address = normalizeAddress(req.params.address || '');
    if (!address) {
      return reply.code(400).send({ error: 'Invalid address' });
    }
    const force = String(req.query.force || '') === '1';
    try {
      // Hard cap 8s — never hang connect/API workers
      const tokens = await withTimeout(
        tokensOfOwner(address, { force }),
        8_000,
        'Token lookup timeout — retry'
      );
      return {
        address,
        tokens,
        count: tokens.length,
        balanceOf: tokens.length,
      };
    } catch (err) {
      req.log.warn({ err: err?.message }, 'wallet tokens');
      const status = /timeout|cache|client scan/i.test(err?.message || '') ? 503 : 502;
      return reply.code(status).send({
        error: err?.message || 'Failed to read wallet tokens from chain',
        code: err?.code || undefined,
      });
    }
  });
}

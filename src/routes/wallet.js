import { normalizeAddress } from '../services/auth.js';
import { tokensOfOwner, balanceOf, getTotalSupply } from '../services/chain.js';

export default async function walletRoutes(app) {
  /** Owned Moze token IDs for a wallet (server-side RPC — avoids browser RPC glitches). */
  app.get('/v1/wallet/:address/tokens', async (req, reply) => {
    const address = normalizeAddress(req.params.address || '');
    if (!address) {
      return reply.code(400).send({ error: 'Invalid address' });
    }
    try {
      const tokens = await tokensOfOwner(address);
      const bal = await balanceOf(address);
      return {
        address,
        tokens,
        count: tokens.length,
        balanceOf: bal,
        supply: await getTotalSupply(),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({
        error: err?.message || 'Failed to read wallet tokens from chain',
      });
    }
  });
}

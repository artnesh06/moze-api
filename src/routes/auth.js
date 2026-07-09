import { createNonce, normalizeAddress, buildActionMessage } from '../services/auth.js';

export default async function authRoutes(app) {
  app.post('/v1/auth/nonce', async (req, reply) => {
    const address = normalizeAddress(req.body?.address);
    if (!address) {
      return reply.code(400).send({ error: 'Invalid address' });
    }
    const nonce = createNonce(address);
    const timestamp = Date.now();
    // preview message for stake (client fills action + tokens)
    return {
      address,
      nonce,
      timestamp,
      expiresInMs: 10 * 60 * 1000,
      messageTemplate: buildActionMessage({
        action: '{stake|unstake|claim}',
        address,
        tokenIds: [],
        nonce,
        timestamp: '{timestamp}',
      }),
    };
  });
}

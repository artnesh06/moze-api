import { getCollectionStats } from '../services/collectionStats.js';

export default async function statsRoutes(app) {
  /** Live collection stats for the Moze site (RPC + OpenSea proxy). */
  app.get('/v1/stats', async (req) => {
    const force = String(req.query.force || '') === '1';
    return getCollectionStats({ force });
  });
}

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { getDb } from './db/index.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import stakeRoutes from './routes/stake.js';
import leaderboardRoutes from './routes/leaderboard.js';
import walletRoutes from './routes/wallet.js';
import statsRoutes from './routes/stats.js';
import raffleRoutes from './routes/raffle.js';
import adminRaffleRoutes from './routes/admin-raffle.js';
import { getHolders } from './services/holders.js';

const app = Fastify({
  logger: true,
  trustProxy: true,
});

await app.register(cors, {
  origin(origin, cb) {
    // allow non-browser (curl, server) with no origin
    if (!origin) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    // allow localhost any port in dev
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS blocked: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

getDb(); // ensure schema

await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(stakeRoutes);
await app.register(leaderboardRoutes);
await app.register(walletRoutes);
await app.register(statsRoutes);
await app.register(raffleRoutes);
await app.register(adminRaffleRoutes);

app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  const status = err.statusCode || 500;
  reply.code(status).send({
    error: err.message || 'Internal error',
  });
});

// warm holders cache in background (non-blocking)
setTimeout(() => {
  getHolders({ force: false }).catch((e) => {
    app.log.warn({ err: e }, 'initial holders warm failed');
  });
}, 2000);

// periodic refresh
setInterval(() => {
  getHolders({ force: true }).catch((e) => {
    app.log.warn({ err: e }, 'holders refresh failed');
  });
}, config.holdersCacheTtlMs);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`moze-api listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

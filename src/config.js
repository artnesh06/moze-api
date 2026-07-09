import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function csv(name, fallback = '') {
  const raw = process.env[name] ?? fallback;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  corsOrigins: csv(
    'CORS_ORIGIN',
    'https://www.mozestreet.art,https://mozestreet.art,http://localhost:8765,http://127.0.0.1:8765'
  ),
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: Number(process.env.CHAIN_ID || 4663),
  mozeCa: (process.env.MOZE_CA || '0x0e579bcec21ae9dc5400db46cab67d5a8d0a58cc').toLowerCase(),
  mozeRatePerDay: Number(process.env.MOZE_RATE_PER_DAY || 10),
  databasePath: process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(root, 'data', 'moze.db'),
  holdersCacheTtlMs: Number(process.env.HOLDERS_CACHE_TTL_MS || 10 * 60 * 1000),
  maxSupply: Number(process.env.MAX_SUPPLY || 1000),
  sigMaxAgeMs: Number(process.env.SIG_MAX_AGE_MS || 10 * 60 * 1000),
  msPerDay: 86_400_000,
};

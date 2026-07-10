# moze-api

Backend for [Moze](https://www.mozestreet.art) — soft staking `$MOZE`, holders cache, and leaderboard.

**Repo:** separate from the static site ([artnesh06/moze](https://github.com/artnesh06/moze)).

## Stack

- Node 22 + Fastify
- SQLite (`better-sqlite3`) — single volume, Coolify-friendly
- ethers.js — Robinhood Chain RPC + EIP-191 signatures

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/v1/auth/nonce` | `{ address }` → nonce for signing |
| GET | `/v1/stake/:address` | Stake state (pending, claimed, positions) |
| POST | `/v1/stake/message` | Build exact message to sign |
| POST | `/v1/stake` | Stake tokens (signed) |
| POST | `/v1/unstake` | Unstake tokens (signed) |
| POST | `/v1/claim` | Claim pending $MOZE (signed) |
| GET | `/v1/holders` | Cached holder counts |
| GET | `/v1/leaderboard?top=25&you=0x…` | Top holders + soft $MOZE |
| POST | `/v1/holders/refresh` | Force rescan (`x-admin-secret` if set) |

### Signed actions

1. `POST /v1/auth/nonce` with wallet address  
2. Client builds / requests message  
3. `personal_sign` the message  
4. `POST /v1/stake` (or unstake/claim) with signature  

Message format:

```
Moze Staking
Action: stake
Tokens: 1,2,3
Address: 0xabc…
Nonce: uuid
Timestamp: 1710000000000
```

## Local dev

```bash
cp .env.example .env
npm install
npm run dev
# http://localhost:3000/health
```

## Coolify (deploy.artnesh.cloud)

1. **New Resource** → GitHub → `artnesh06/moze-api` · branch `main`
2. Build: **Dockerfile**
3. Port: **3000**
4. **Persistent storage (required):** named volume → container path **`/data`**  
   - SQLite lives at `/data/moze.db` (not inside the image)  
   - Redeploy **reuses** this volume — stake positions, banked/claimed, leaderboard stay  
   - Migrations are **additive only** (`CREATE TABLE IF NOT EXISTS`) — never wipe wallets/positions  
5. Domain: `api.mozestreet.art` + HTTPS
6. Env:

```
CORS_ORIGIN=https://www.mozestreet.art,https://mozestreet.art
RPC_URL=https://rpc.mainnet.chain.robinhood.com
MOZE_CA=0x0e579bcec21ae9dc5400db46cab67d5a8d0a58cc
DATABASE_PATH=/data/moze.db
ADMIN_SECRET=change-me
```

After deploy, check `/health` → `stake.positions` / `stake.stakers` should stay non-zero if people already staked.

DNS: `A` / `CNAME` for `api` → Coolify VPS.

## Frontend

Set on the static site:

```js
window.MOZE_API = 'https://api.mozestreet.art';
```

or env baked in `script.js` `API_BASE`.

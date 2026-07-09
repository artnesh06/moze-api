import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { ownersOfTokenIds } from './chain.js';

function ensureWallet(db, address, now) {
  db.prepare(
    `INSERT INTO wallets (address, banked, claimed, updated_at)
     VALUES (?, 0, 0, ?)
     ON CONFLICT(address) DO NOTHING`
  ).run(address, now);
}

/** Accrue pending $MOZE into banked for all positions of address */
export function settleAddress(address, now = Date.now()) {
  const db = getDb();
  ensureWallet(db, address, now);
  const positions = db
    .prepare(`SELECT token_id, last_settle_at FROM positions WHERE address = ?`)
    .all(address);

  let accrued = 0;
  const upd = db.prepare(
    `UPDATE positions SET last_settle_at = ? WHERE token_id = ?`
  );
  for (const p of positions) {
    const elapsed = Math.max(0, now - Number(p.last_settle_at));
    const add = (config.mozeRatePerDay * elapsed) / config.msPerDay;
    accrued += add;
    upd.run(now, p.token_id);
  }

  if (accrued > 0) {
    db.prepare(
      `UPDATE wallets SET banked = banked + ?, updated_at = ? WHERE address = ?`
    ).run(accrued, now, address);
  }
  return accrued;
}

export function getStakeState(address) {
  const db = getDb();
  const now = Date.now();
  settleAddress(address, now);

  const wallet = db
    .prepare(`SELECT banked, claimed FROM wallets WHERE address = ?`)
    .get(address) || { banked: 0, claimed: 0 };

  const positions = db
    .prepare(
      `SELECT token_id AS tokenId, staked_at AS stakedAt, last_settle_at AS lastSettleAt
       FROM positions WHERE address = ? ORDER BY token_id`
    )
    .all(address);

  const staked = positions.length;
  const rate = staked * config.mozeRatePerDay;
  const pending = Number(wallet.banked) || 0;
  const claimed = Number(wallet.claimed) || 0;

  return {
    address,
    staked,
    rate,
    pending,
    claimed,
    totalEarned: pending + claimed,
    positions,
    ratePerDay: config.mozeRatePerDay,
    updatedAt: now,
  };
}

export async function stakeTokens(address, tokenIds) {
  const db = getDb();
  const now = Date.now();
  const ids = [...new Set(tokenIds.map(Number).filter((n) => Number.isFinite(n) && n >= 0))];
  if (!ids.length) throw new Error('No token ids');

  // must own on-chain
  const owners = await ownersOfTokenIds(ids);
  for (const { id, owner } of owners) {
    if (!owner || owner !== address) {
      throw new Error(`Not owner of token #${id}`);
    }
  }

  settleAddress(address, now);
  ensureWallet(db, address, now);

  const getPos = db.prepare(`SELECT address FROM positions WHERE token_id = ?`);
  const insert = db.prepare(
    `INSERT INTO positions (token_id, address, staked_at, last_settle_at) VALUES (?, ?, ?, ?)`
  );

  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const existing = getPos.get(id);
      if (existing) {
        if (existing.address === address) continue; // already staked by you
        throw new Error(`Token #${id} already staked by another wallet`);
      }
      insert.run(id, address, now, now);
      n += 1;
    }
    db.prepare(
      `INSERT INTO events (address, action, token_ids, amount, created_at)
       VALUES (?, 'stake', ?, NULL, ?)`
    ).run(address, ids.join(','), now);
  });
  tx();

  return { staked: n, state: getStakeState(address) };
}

export function unstakeTokens(address, tokenIds) {
  const db = getDb();
  const now = Date.now();
  const ids = [...new Set(tokenIds.map(Number).filter((n) => Number.isFinite(n) && n >= 0))];
  if (!ids.length) throw new Error('No token ids');

  settleAddress(address, now);

  let n = 0;
  const getPos = db.prepare(`SELECT address FROM positions WHERE token_id = ?`);
  const del = db.prepare(`DELETE FROM positions WHERE token_id = ? AND address = ?`);

  const tx = db.transaction(() => {
    for (const id of ids) {
      const existing = getPos.get(id);
      if (!existing || existing.address !== address) continue;
      del.run(id, address);
      n += 1;
    }
    db.prepare(
      `INSERT INTO events (address, action, token_ids, amount, created_at)
       VALUES (?, 'unstake', ?, NULL, ?)`
    ).run(address, ids.join(','), now);
  });
  tx();

  return { unstaked: n, state: getStakeState(address) };
}

export function claimMoze(address) {
  const db = getDb();
  const now = Date.now();
  settleAddress(address, now);

  const wallet = db
    .prepare(`SELECT banked, claimed FROM wallets WHERE address = ?`)
    .get(address);
  const amount = Number(wallet?.banked) || 0;
  if (amount < 0.0001) {
    return { claimed: 0, state: getStakeState(address) };
  }

  db.prepare(
    `UPDATE wallets SET claimed = claimed + ?, banked = 0, updated_at = ? WHERE address = ?`
  ).run(amount, now, address);

  db.prepare(
    `INSERT INTO events (address, action, token_ids, amount, created_at)
     VALUES (?, 'claim', NULL, ?, ?)`
  ).run(address, amount, now);

  return { claimed: amount, state: getStakeState(address) };
}

/** Soft $MOZE points for leaderboard (pending + claimed) */
export function softPointsFor(address) {
  try {
    settleAddress(address);
    const w = getDb()
      .prepare(`SELECT banked, claimed FROM wallets WHERE address = ?`)
      .get(address);
    if (!w) return 0;
    return (Number(w.banked) || 0) + (Number(w.claimed) || 0);
  } catch {
    return 0;
  }
}

export function allSoftPoints() {
  const db = getDb();
  // settle everyone with positions (batch)
  const addrs = db.prepare(`SELECT DISTINCT address FROM positions`).all().map((r) => r.address);
  const now = Date.now();
  for (const a of addrs) settleAddress(a, now);

  const rows = db
    .prepare(`SELECT address, banked, claimed FROM wallets`)
    .all();
  const map = new Map();
  for (const r of rows) {
    map.set(r.address, (Number(r.banked) || 0) + (Number(r.claimed) || 0));
  }
  // staked counts
  const stakedRows = db
    .prepare(`SELECT address, COUNT(*) AS n FROM positions GROUP BY address`)
    .all();
  const stakedMap = new Map(stakedRows.map((r) => [r.address, r.n]));
  return { points: map, staked: stakedMap };
}

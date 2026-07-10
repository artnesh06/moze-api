import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { scanHolders } from './chain.js';
import { allSoftPoints } from './stake.js';

let scanning = false;

export function getCachedHolders() {
  const db = getDb();
  const row = db.prepare(`SELECT payload, updated_at, supply FROM holders_cache WHERE id = 1`).get();
  if (!row) return null;
  const age = Date.now() - row.updated_at;
  return {
    ...JSON.parse(row.payload),
    updatedAt: row.updated_at,
    supply: row.supply,
    ageMs: age,
    stale: age > config.holdersCacheTtlMs,
  };
}

export async function refreshHolders() {
  if (scanning) throw new Error('Holder scan already in progress');
  scanning = true;
  try {
    const { counts, supply } = await scanHolders();
    const rows = [...counts.entries()]
      .map(([addr, held]) => ({ addr, held }))
      .sort((a, b) => b.held - a.held || a.addr.localeCompare(b.addr));

    const payload = { rows, walletCount: rows.length };
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO holders_cache (id, payload, updated_at, supply)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           supply = excluded.supply`
      )
      .run(JSON.stringify(payload), now, supply);

    return { ...payload, supply, updatedAt: now, ageMs: 0, stale: false };
  } finally {
    scanning = false;
  }
}

export async function getHolders({ force = false } = {}) {
  const cached = getCachedHolders();
  if (!force && cached && !cached.stale) return cached;
  // Never block HTTP on a long ownerOf scan — return cache and refresh in background
  if (scanning) {
    if (cached) return { ...cached, scanning: true };
    // first boot: no cache yet — wait only if nothing to return
  }
  if (force && cached) {
    // kick background refresh, respond immediately with cache
    refreshHolders().catch(() => {});
    return { ...cached, scanning: true };
  }
  if (!force && cached && cached.stale) {
    refreshHolders().catch(() => {});
    return { ...cached, scanning: true };
  }
  try {
    return await refreshHolders();
  } catch (err) {
    if (cached) return { ...cached, error: err.message };
    throw err;
  }
}

export async function getLeaderboard({ top = 25, force = false } = {}) {
  const holders = await getHolders({ force });
  const { points, staked } = allSoftPoints();

  const heldMap = new Map(holders.rows.map((r) => [r.addr, r.held]));

  // Only wallets that have soft-staked (≥1 position or soft points)
  const stakerAddrs = new Set([...staked.keys(), ...points.keys()]);
  const enriched = [...stakerAddrs]
    .map((addr) => ({
      addr,
      held: heldMap.get(addr) || 0,
      staked: staked.get(addr) || 0,
      softMoze: points.get(addr) || 0,
    }))
    .filter((r) => r.staked > 0 || r.softMoze > 0);

  // Rank stakers by soft $MOZE, then NFTs staked, then held
  enriched.sort(
    (a, b) =>
      b.softMoze - a.softMoze ||
      b.staked - a.staked ||
      b.held - a.held ||
      a.addr.localeCompare(b.addr)
  );

  const topN = Math.min(Math.max(1, top), 100);
  return {
    top: enriched.slice(0, topN),
    rows: enriched,
    supply: holders.supply,
    walletCount: holders.walletCount,
    stakerCount: enriched.length,
    updatedAt: holders.updatedAt,
    stale: holders.stale,
    scanning: holders.scanning || false,
  };
}

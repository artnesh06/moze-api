import { config } from '../config.js';
import { getTotalSupply } from './chain.js';
import { getDb } from '../db/index.js';
import { getCachedHolders } from './holders.js';

const OPENSEA_SLUG = process.env.OPENSEA_SLUG || 'mozestreetart';
const CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS || 60_000);

let cache = null;
let cacheAt = 0;
let inflight = null;

function countServerStaked() {
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM positions`)
      .get();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

async function fetchOpenSeaJson(url) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'moze-api/1.0 (+https://www.mozestreet.art)',
  };
  if (process.env.OPENSEA_API_KEY) {
    headers['X-API-KEY'] = process.env.OPENSEA_API_KEY;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenSea ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

/**
 * Live collection stats:
 * - minted: on-chain totalSupply (authoritative)
 * - holders: on-chain holder scan cache (walletCount) — no OpenSea key needed
 * - floor/volume/sales: OpenSea /stats (needs OPENSEA_API_KEY); collection meta is public
 * - staked: soft-stake positions in moze DB
 */
export async function getCollectionStats({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) {
    return { ...cache, cached: true, ageMs: now - cacheAt };
  }
  if (!force && inflight) return inflight;

  inflight = (async () => {
    const errors = [];
    let minted = null;
    let mintedSource = null;
    let supplyMax = config.maxSupply;

    try {
      minted = await getTotalSupply();
      mintedSource = 'rpc';
    } catch (err) {
      errors.push(`rpc: ${err?.message || err}`);
    }

    // On-chain holders from existing scan cache (warmed by index.js)
    let holders = null;
    let holdersSource = null;
    try {
      const hc = getCachedHolders();
      if (hc && hc.walletCount != null) {
        holders = Number(hc.walletCount) || 0;
        holdersSource = 'on-chain-scan';
        if (minted == null && hc.supply != null) {
          minted = Number(hc.supply) || null;
          if (minted != null) mintedSource = 'holders-cache';
        }
      }
    } catch (err) {
      errors.push(`holders: ${err?.message || err}`);
    }

    let floor = null;
    let floorSymbol = 'ETH';
    let volume = null;
    let sales = null;
    let listed = null;
    let openseaName = null;
    let marketSource = null;

    // Public collection metadata (no API key)
    try {
      const col = await fetchOpenSeaJson(
        `https://api.opensea.io/api/v2/collections/${OPENSEA_SLUG}`
      );
      if (col?.name) openseaName = col.name;
      if (col?.listed_count != null) listed = Number(col.listed_count);
      if (minted == null) {
        const ts = Number(col.total_supply ?? col.unique_item_count);
        if (Number.isFinite(ts) && ts > 0) {
          minted = ts;
          mintedSource = 'opensea-collection';
        }
      }
    } catch (err) {
      errors.push(`opensea-collection: ${err?.message || err}`);
    }

    // Market stats need API key (OpenSea returns 401 without it)
    try {
      const stats = await fetchOpenSeaJson(
        `https://api.opensea.io/api/v2/collections/${OPENSEA_SLUG}/stats`
      );
      const total = stats.total || stats;
      if (total.num_owners != null && holders == null) {
        holders = Number(total.num_owners);
        holdersSource = 'opensea-stats';
      }
      if (total.floor_price != null) {
        floor = Number(total.floor_price);
        floorSymbol = total.floor_price_symbol || 'ETH';
      }
      if (total.volume != null) volume = Number(total.volume);
      if (total.sales != null) sales = Number(total.sales);
      marketSource = 'opensea-stats';
    } catch (err) {
      // Expected without OPENSEA_API_KEY — floor/volume stay null; UI keeps snapshot
      errors.push(`opensea-stats: ${err?.message || err}`);
    }

    const staked = countServerStaked();
    const offer =
      floor == null
        ? null
        : floor === 0
          ? `0 ${floorSymbol}`
          : `${floor} ${floorSymbol}`;
    const volumeLabel =
      volume == null
        ? null
        : volume === 0
          ? `0 ${floorSymbol}`
          : `${volume} ${floorSymbol}`;

    const payload = {
      ok: true,
      updatedAt: Date.now(),
      supplyMax,
      minted,
      holders,
      floor,
      floorSymbol,
      offer,
      volume,
      volumeLabel,
      sales,
      listed,
      staked,
      price: 'FREE',
      collection: openseaName || 'Moze Street Art',
      chain: 'Robinhood',
      platform: 'OpenSea',
      openseaUrl: `https://opensea.io/collection/${OPENSEA_SLUG}/overview`,
      sources: {
        minted: mintedSource,
        holders: holdersSource,
        market: marketSource,
        staked: 'moze-api-db',
      },
      errors: errors.length ? errors : undefined,
      cached: false,
      ageMs: 0,
    };

    cache = payload;
    cacheAt = Date.now();
    return payload;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

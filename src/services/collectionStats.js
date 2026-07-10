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

/** Pretty floor/volume number without trailing junk. */
function fmtUnit(n) {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0;
  if (n >= 100) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(4));
  // floors like 0.0011
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return Number(s);
}

/**
 * OpenSea collection page embeds CollectionStats in HTML (no API key).
 * Used when /api/v2/.../stats returns 401 without OPENSEA_API_KEY.
 */
async function fetchOpenSeaPageStats(slug) {
  const res = await fetch(`https://opensea.io/collection/${slug}`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent':
        'Mozilla/5.0 (compatible; moze-api/1.0; +https://www.mozestreet.art)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenSea HTML ${res.status}`);
  const html = await res.text();
  if (!html || html.length < 1000) throw new Error('OpenSea HTML empty');

  const out = {
    holders: null,
    listed: null,
    floor: null,
    floorSymbol: 'ETH',
    volume: null,
    volumeSymbol: 'ETH',
    sales: null,
    totalSupply: null,
  };

  // "...listedItemCount":48,"ownerCount":936
  const ownListed = html.match(
    /"listedItemCount"\s*:\s*(\d+)\s*,\s*"ownerCount"\s*:\s*(\d+)/
  );
  if (ownListed) {
    out.listed = Number(ownListed[1]);
    out.holders = Number(ownListed[2]);
  } else {
    const oc = html.match(/"ownerCount"\s*:\s*(\d+)/);
    const li = html.match(/"listedItemCount"\s*:\s*(\d+)/);
    if (oc) out.holders = Number(oc[1]);
    if (li) out.listed = Number(li[1]);
  }

  const ts = html.match(
    /"__typename"\s*:\s*"CollectionStats"\s*,\s*"totalSupply"\s*:\s*(\d+)/
  );
  if (ts) out.totalSupply = Number(ts[1]);

  // "floorPrice":{"pricePerItem":{"token":{"unit":0.0011,"symbol":"ETH"
  const floor = html.match(
    /"floorPrice"\s*:\s*\{\s*"pricePerItem"\s*:\s*\{\s*"token"\s*:\s*\{\s*"unit"\s*:\s*([0-9.eE+-]+)\s*,\s*"symbol"\s*:\s*"([^"]+)"/
  );
  if (floor) {
    out.floor = fmtUnit(Number(floor[1]));
    out.floorSymbol = floor[2] || 'ETH';
  }

  // All-time volume on CollectionStats: "volume":{"native":{"unit":0,...,"symbol":"ETH"
  // Prefer the CollectionStats block volume (first after totalSupply)
  const statsChunk = html.match(
    /"__typename"\s*:\s*"CollectionStats"[\s\S]{0,1800}?"volume"\s*:\s*\{\s*"native"\s*:\s*\{[^}]*?"unit"\s*:\s*([0-9.eE+-]+)[^}]*?"symbol"\s*:\s*"([^"]+)"/
  ) || html.match(
    /"volume"\s*:\s*\{\s*"native"\s*:\s*\{\s*"unit"\s*:\s*([0-9.eE+-]+)[^}]*?"symbol"\s*:\s*"([^"]+)"/
  );
  if (statsChunk) {
    out.volume = fmtUnit(Number(statsChunk[1]));
    out.volumeSymbol = statsChunk[2] || 'ETH';
  } else {
    // alternate order: symbol then unit
    const alt = html.match(
      /"volume"\s*:\s*\{\s*"native"\s*:\s*\{\s*"symbol"\s*:\s*"([^"]+)"\s*,\s*"unit"\s*:\s*([0-9.eE+-]+)/
    );
    if (alt) {
      out.volumeSymbol = alt[1] || 'ETH';
      out.volume = fmtUnit(Number(alt[2]));
    }
  }

  // Sales rarely embedded; if all-time volume is 0, secondary sales are 0
  if (out.volume === 0) out.sales = 0;

  if (
    out.holders == null &&
    out.floor == null &&
    out.volume == null &&
    out.listed == null
  ) {
    throw new Error('OpenSea HTML parse found no stats');
  }
  return out;
}

/**
 * Detect incomplete on-chain holder scan (RPC failures → few wallets vs supply).
 */
function isHoldersScanIncomplete(hc, minted) {
  if (!hc || hc.walletCount == null) return true;
  const supply = Number(hc.supply ?? minted ?? 0) || 0;
  const wc = Number(hc.walletCount) || 0;
  if (!supply) return wc < 1;
  let heldSum = 0;
  if (Array.isArray(hc.rows) && hc.rows.length) {
    heldSum = hc.rows.reduce((s, r) => s + (Number(r.held) || 0), 0);
  } else {
    // lower bound: at least 1 token per wallet
    heldSum = wc;
  }
  // Incomplete if we resolved owners for under half the supply
  return heldSum < supply * 0.5;
}

/**
 * Live collection stats:
 * - minted: on-chain totalSupply (authoritative)
 * - holders: OpenSea ownerCount preferred when on-chain scan incomplete
 * - floor/volume/sales/listed: OpenSea /stats (API key) or HTML scrape fallback
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
    let holdersIncomplete = true;
    try {
      const hc = getCachedHolders();
      if (hc && hc.walletCount != null) {
        holdersIncomplete = isHoldersScanIncomplete(hc, minted);
        if (!holdersIncomplete) {
          holders = Number(hc.walletCount) || 0;
          holdersSource = 'on-chain-scan';
        } else {
          // keep as weak fallback only
          holders = Number(hc.walletCount) || 0;
          holdersSource = 'on-chain-scan-incomplete';
        }
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

    // Public collection metadata (no API key) — total_supply, listed_count sometimes
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
      if (total.num_owners != null) {
        // Prefer OpenSea owners when on-chain incomplete, else keep on-chain
        if (holders == null || holdersIncomplete) {
          holders = Number(total.num_owners);
          holdersSource = 'opensea-stats';
          holdersIncomplete = false;
        }
      }
      if (total.floor_price != null) {
        floor = fmtUnit(Number(total.floor_price));
        floorSymbol = total.floor_price_symbol || 'ETH';
      }
      if (total.volume != null) volume = fmtUnit(Number(total.volume));
      if (total.sales != null) sales = Number(total.sales);
      else if (volume === 0) sales = 0;
      if (total.num_listed != null || total.listed_count != null) {
        listed = Number(total.num_listed ?? total.listed_count);
      }
      marketSource = 'opensea-stats';
    } catch (err) {
      errors.push(`opensea-stats: ${err?.message || err}`);
    }

    // HTML scrape fallback (no API key) — floor, volume, owners, listed
    if (
      marketSource == null ||
      floor == null ||
      volume == null ||
      listed == null ||
      holders == null ||
      holdersIncomplete
    ) {
      try {
        const page = await fetchOpenSeaPageStats(OPENSEA_SLUG);
        if (page.floor != null && floor == null) {
          floor = page.floor;
          floorSymbol = page.floorSymbol || floorSymbol;
        }
        if (page.volume != null && volume == null) {
          volume = page.volume;
        }
        if (page.sales != null && sales == null) sales = page.sales;
        if (page.listed != null && listed == null) listed = page.listed;
        if (
          page.holders != null &&
          (holders == null || holdersIncomplete)
        ) {
          holders = page.holders;
          holdersSource = 'opensea-page';
          holdersIncomplete = false;
        }
        if (minted == null && page.totalSupply != null) {
          minted = page.totalSupply;
          mintedSource = 'opensea-page';
        }
        if (marketSource == null) marketSource = 'opensea-page';
        else if (floor != null || volume != null) {
          marketSource = `${marketSource}+page`;
        }
      } catch (err) {
        errors.push(`opensea-page: ${err?.message || err}`);
      }
    }

    // Final sales rule: zero volume ⇒ zero secondary sales (don't leave null for bad snapshot)
    if (sales == null && volume === 0) sales = 0;

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

import { ethers } from 'ethers';
import { config } from '../config.js';

const ERC721_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
];

let provider;
let contract;

/** Short TTL cache for wallet token lists (speeds up reconnect). */
const tokensCache = new Map(); // addr -> { at, tokens, bal }
const TOKENS_CACHE_TTL_MS = Number(process.env.WALLET_TOKENS_CACHE_TTL_MS || 90_000);

export function getProvider() {
  if (!provider) {
    const network = ethers.Network.from(config.chainId);
    provider = new ethers.JsonRpcProvider(config.rpcUrl, network, {
      staticNetwork: network,
    });
  }
  return provider;
}

export function getContract() {
  if (!contract) {
    contract = new ethers.Contract(config.mozeCa, ERC721_ABI, getProvider());
  }
  return contract;
}

export async function getTotalSupply() {
  try {
    const ts = Number(await getContract().totalSupply());
    if (ts > 0) return Math.min(config.maxSupply, ts);
  } catch {
    /* fallback */
  }
  return config.maxSupply;
}

/**
 * Full collection owner scan.
 * @returns {{ counts: Map, tokensByOwner: Map<string, number[]>, supply: number }}
 */
export async function scanHolders(onProgress) {
  const c = getContract();
  const supply = await getTotalSupply();
  const counts = new Map();
  const tokensByOwner = new Map(); // addr -> token ids
  const batch = 100;
  const maxId = Math.max(supply, 1);

  for (let start = 1; start <= maxId; start += batch) {
    const chunk = [];
    for (let id = start; id < start + batch && id <= maxId; id += 1) {
      chunk.push(
        c
          .ownerOf(id)
          .then((o) => ({ id, owner: String(o).toLowerCase() }))
          .catch(() => ({ id, owner: null }))
      );
    }
    const results = await Promise.all(chunk);
    for (const { id, owner } of results) {
      if (!owner || owner === ethers.ZeroAddress.toLowerCase()) continue;
      counts.set(owner, (counts.get(owner) || 0) + 1);
      if (!tokensByOwner.has(owner)) tokensByOwner.set(owner, []);
      tokensByOwner.get(owner).push(id);
    }
    if (onProgress) onProgress(Math.min(start + batch - 1, maxId), maxId);
  }

  try {
    const o0 = String(await c.ownerOf(0)).toLowerCase();
    if (o0 && o0 !== ethers.ZeroAddress.toLowerCase()) {
      counts.set(o0, (counts.get(o0) || 0) + 1);
      if (!tokensByOwner.has(o0)) tokensByOwner.set(o0, []);
      tokensByOwner.get(o0).push(0);
    }
  } catch {
    /* no token 0 */
  }

  // keep in-memory reverse index for fast /v1/wallet/:addr/tokens
  setOwnerTokensIndex(tokensByOwner, Date.now());

  return { counts, tokensByOwner, supply };
}

/** In-memory owner → tokenIds from last holder scan (fast path for wallet tokens). */
let ownerTokensIndex = new Map();
let ownerTokensIndexAt = 0;

export function setOwnerTokensIndex(map, at = Date.now()) {
  ownerTokensIndex = map instanceof Map ? map : new Map(Object.entries(map || {}));
  ownerTokensIndexAt = at;
}

export function getTokensFromIndex(address) {
  const owner = String(address || '').toLowerCase();
  if (!owner || !ownerTokensIndex.size) return null;
  // stale after 15 min without rescan
  if (Date.now() - ownerTokensIndexAt > 15 * 60 * 1000) return null;
  const ids = ownerTokensIndex.get(owner);
  if (!ids) return [];
  return [...ids].sort((a, b) => a - b);
}

export async function ownersOfTokenIds(tokenIds) {
  const c = getContract();
  const results = await Promise.all(
    tokenIds.map(async (id) => {
      try {
        const o = await c.ownerOf(id);
        return { id: Number(id), owner: String(o).toLowerCase() };
      } catch {
        return { id: Number(id), owner: null };
      }
    })
  );
  return results;
}

export async function balanceOf(address) {
  try {
    return Number(await getContract().balanceOf(address));
  } catch {
    return 0;
  }
}

/**
 * Token IDs owned by address.
 * Order: short TTL cache → holders reverse index → enumerable → batched ownerOf.
 */
export async function tokensOfOwner(address, { force = false } = {}) {
  const owner = String(address || '').toLowerCase();
  if (!owner || !owner.startsWith('0x') || owner.length !== 42) {
    throw new Error('Invalid address');
  }

  if (!force) {
    const hit = tokensCache.get(owner);
    if (hit && Date.now() - hit.at < TOKENS_CACHE_TTL_MS) {
      return hit.tokens;
    }
  }

  const c = getContract();
  let n = 0;
  try {
    n = Number(await c.balanceOf(owner));
  } catch (err) {
    throw new Error(`balanceOf failed: ${err?.shortMessage || err?.message || err}`);
  }
  if (!n) {
    tokensCache.set(owner, { at: Date.now(), tokens: [], bal: 0 });
    return [];
  }

  // Fast path: reverse index from last holders scan (same RPC work, reused)
  if (!force) {
    const fromIndex = getTokensFromIndex(owner);
    if (fromIndex && fromIndex.length === n) {
      tokensCache.set(owner, { at: Date.now(), tokens: fromIndex, bal: n });
      return fromIndex;
    }
    // partial index match still useful if non-empty and <= balance
    if (fromIndex && fromIndex.length > 0 && fromIndex.length <= n) {
      tokensCache.set(owner, { at: Date.now(), tokens: fromIndex, bal: n });
      return fromIndex;
    }
  }

  // Prefer enumerable if available (O(n) not O(supply))
  try {
    const ids = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        c.tokenOfOwnerByIndex(owner, i).then((x) => Number(x))
      )
    );
    if (ids.length === n && ids.every((x) => Number.isFinite(x))) {
      const sorted = [...new Set(ids)].sort((a, b) => a - b);
      tokensCache.set(owner, { at: Date.now(), tokens: sorted, bal: n });
      return sorted;
    }
  } catch {
    /* not enumerable */
  }

  // IMPORTANT: never do full 1..supply ownerOf scan on the request path.
  // It hangs for 60s+ on this RPC and blocks connects. Client scans instead;
  // holders reverse-index covers warm cache after background scan.
  const err = new Error('Token list not in cache — client should scan');
  err.code = 'TOKENS_NEED_CLIENT_SCAN';
  throw err;
}

export function clearTokensCache(address) {
  if (!address) {
    tokensCache.clear();
    return;
  }
  tokensCache.delete(String(address).toLowerCase());
}

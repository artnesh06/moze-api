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

/** Returns Map<lowerAddress, heldCount> */
export async function scanHolders(onProgress) {
  const c = getContract();
  const supply = await getTotalSupply();
  const counts = new Map();
  const batch = 60;
  const maxId = Math.max(supply, 1);

  for (let start = 1; start <= maxId; start += batch) {
    const chunk = [];
    for (let id = start; id < start + batch && id <= maxId; id += 1) {
      chunk.push(
        c
          .ownerOf(id)
          .then((o) => String(o).toLowerCase())
          .catch(() => null)
      );
    }
    const owners = await Promise.all(chunk);
    for (const o of owners) {
      if (!o || o === ethers.ZeroAddress.toLowerCase()) continue;
      counts.set(o, (counts.get(o) || 0) + 1);
    }
    if (onProgress) onProgress(Math.min(start + batch - 1, maxId), maxId);
  }

  try {
    const o0 = String(await c.ownerOf(0)).toLowerCase();
    if (o0 && o0 !== ethers.ZeroAddress.toLowerCase()) {
      counts.set(o0, (counts.get(o0) || 0) + 1);
    }
  } catch {
    /* no token 0 */
  }

  return { counts, supply };
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
 * Prefer IERC721Enumerable; else batched ownerOf scan with early exit.
 * Cached briefly so reconnects are fast.
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

  // Prefer enumerable if available (O(n) not O(supply))
  try {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(Number(await c.tokenOfOwnerByIndex(owner, i)));
    }
    if (ids.length === n) {
      const sorted = [...new Set(ids)].sort((a, b) => a - b);
      tokensCache.set(owner, { at: Date.now(), tokens: sorted, bal: n });
      return sorted;
    }
  } catch {
    /* scan fallback */
  }

  const supply = await getTotalSupply();
  const found = [];
  const batch = 80; // larger batches = fewer round-trips
  const maxId = Math.max(supply, 1);

  for (let start = 1; start <= maxId && found.length < n; start += batch) {
    const chunk = [];
    for (let id = start; id < start + batch && id <= maxId; id += 1) {
      chunk.push(
        c
          .ownerOf(id)
          .then((o) => (String(o).toLowerCase() === owner ? id : null))
          .catch(() => null)
      );
    }
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(chunk);
    for (const id of results) {
      if (id != null) found.push(id);
    }
  }

  if (found.length < n) {
    try {
      const o0 = String(await c.ownerOf(0)).toLowerCase();
      if (o0 === owner) found.push(0);
    } catch {
      /* no token 0 */
    }
  }

  const sorted = [...new Set(found)].sort((a, b) => a - b);
  tokensCache.set(owner, { at: Date.now(), tokens: sorted, bal: n });
  return sorted;
}

export function clearTokensCache(address) {
  if (!address) {
    tokensCache.clear();
    return;
  }
  tokensCache.delete(String(address).toLowerCase());
}

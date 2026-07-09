import { ethers } from 'ethers';
import { config } from '../config.js';

const ERC721_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)',
];

let provider;
let contract;

export function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
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
  const batch = 40;
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

  // token 0 if exists
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

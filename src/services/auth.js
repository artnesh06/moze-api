import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { getDb } from '../db/index.js';

export function normalizeAddress(addr) {
  try {
    return ethers.getAddress(addr).toLowerCase();
  } catch {
    return null;
  }
}

export function createNonce(address) {
  const db = getDb();
  const nonce = uuidv4();
  const now = Date.now();
  db.prepare(
    `INSERT INTO nonces (nonce, address, created_at, used_at) VALUES (?, ?, ?, NULL)`
  ).run(nonce, address, now);
  // prune old unused nonces (>1h)
  db.prepare(
    `DELETE FROM nonces WHERE used_at IS NULL AND created_at < ?`
  ).run(now - 60 * 60 * 1000);
  return nonce;
}

export function buildActionMessage({ action, address, tokenIds, nonce, timestamp }) {
  const tokens = (tokenIds || []).map(Number).sort((a, b) => a - b).join(',');
  return [
    'Moze Staking',
    `Action: ${action}`,
    `Tokens: ${tokens || '-'}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Timestamp: ${timestamp}`,
  ].join('\n');
}

export function verifyActionSignature({
  action,
  address,
  tokenIds,
  nonce,
  timestamp,
  signature,
}) {
  const addr = normalizeAddress(address);
  if (!addr) throw new Error('Invalid address');
  if (!signature) throw new Error('Missing signature');
  if (!nonce) throw new Error('Missing nonce');

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw new Error('Invalid timestamp');
  const age = Math.abs(Date.now() - ts);
  if (age > config.sigMaxAgeMs) throw new Error('Signature expired — request a new nonce');

  const db = getDb();
  const row = db.prepare(`SELECT * FROM nonces WHERE nonce = ?`).get(nonce);
  if (!row) throw new Error('Unknown nonce');
  if (row.used_at) throw new Error('Nonce already used');
  if (String(row.address).toLowerCase() !== addr) {
    throw new Error('Nonce was issued for a different address');
  }
  if (Date.now() - row.created_at > config.sigMaxAgeMs) {
    throw new Error('Nonce expired');
  }

  const message = buildActionMessage({
    action,
    address: addr,
    tokenIds,
    nonce,
    timestamp: ts,
  });

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    throw new Error('Invalid signature');
  }
  if (recovered !== addr) throw new Error('Signature does not match address');

  db.prepare(`UPDATE nonces SET used_at = ? WHERE nonce = ?`).run(Date.now(), nonce);
  return { address: addr, message };
}

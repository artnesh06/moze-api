import { getDb } from '../db/index.js';
import { settleAddress, getStakeState } from './stake.js';

function mapRaffle(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description || '',
    prizeLabel: row.prize_label || '',
    ticketCost: Number(row.ticket_cost) || 0,
    maxTicketsPerWallet:
      row.max_tickets_per_wallet == null ? null : Number(row.max_tickets_per_wallet),
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    winnerAddress: row.winner_address || null,
    drawnAt: row.drawn_at,
    createdAt: row.created_at,
  };
}

function toMs(ts) {
  let n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1e12) n *= 1000;
  return Math.floor(n);
}

function isWindowOpen(raffle, now = Date.now()) {
  if (!raffle || raffle.status !== 'open') return false;
  const starts = toMs(raffle.startsAt);
  const ends = toMs(raffle.endsAt);
  // Start immediately if startsAt missing or in the past
  if (starts && now < starts) return false;
  if (ends && now > ends) return false;
  return true;
}

export function getRaffleById(id) {
  const row = getDb().prepare(`SELECT * FROM raffles WHERE id = ?`).get(id);
  return mapRaffle(row);
}

export function getActiveRaffle() {
  const db = getDb();
  const now = Date.now();
  // Prefer open raffles still in window; fall back to latest open
  const open = db
    .prepare(
      `SELECT * FROM raffles
       WHERE status = 'open'
       ORDER BY id ASC`
    )
    .all()
    .map(mapRaffle)
    .find((r) => isWindowOpen(r, now));
  if (open) return open;
  const any = db
    .prepare(`SELECT * FROM raffles ORDER BY id DESC LIMIT 1`)
    .get();
  return mapRaffle(any);
}

function entryStats(raffleId, youAddr = null) {
  const db = getDb();
  const tot = db
    .prepare(
      `SELECT
         COALESCE(SUM(tickets), 0) AS totalTickets,
         COUNT(*) AS entrants
       FROM raffle_entries WHERE raffle_id = ?`
    )
    .get(raffleId);

  let yourTickets = 0;
  let yourSpent = 0;
  if (youAddr) {
    const mine = db
      .prepare(
        `SELECT tickets, moze_spent FROM raffle_entries
         WHERE raffle_id = ? AND address = ?`
      )
      .get(raffleId, youAddr);
    yourTickets = Number(mine?.tickets) || 0;
    yourSpent = Number(mine?.moze_spent) || 0;
  }

  const top = db
    .prepare(
      `SELECT address, tickets, moze_spent
       FROM raffle_entries
       WHERE raffle_id = ?
       ORDER BY tickets DESC, created_at ASC
       LIMIT 10`
    )
    .all(raffleId)
    .map((r) => ({
      addr: r.address,
      tickets: Number(r.tickets) || 0,
      spent: Number(r.moze_spent) || 0,
    }));

  return {
    totalTickets: Number(tot?.totalTickets) || 0,
    entrants: Number(tot?.entrants) || 0,
    yourTickets,
    yourSpent,
    top,
  };
}

/** Public summary for GET /v1/raffle */
export function getRaffleSummary({ you = null } = {}) {
  const raffle = getActiveRaffle();
  if (!raffle) return { ok: true, raffle: null };

  const stats = entryStats(raffle.id, you);
  let yourPending = null;
  let yourClaimed = null;
  let yourMoze = null;
  if (you) {
    try {
      const state = getStakeState(you);
      yourPending = Number(state.pending) || 0;
      yourClaimed = Number(state.claimed) || 0;
      yourMoze = yourPending + yourClaimed;
    } catch {
      yourPending = 0;
      yourClaimed = 0;
      yourMoze = 0;
    }
  }

  return {
    ok: true,
    raffle: {
      ...raffle,
      open: isWindowOpen(raffle),
      ...stats,
      // total soft $MOZE (pending + claimed) — spendable on raffle
      yourMoze,
      yourPending,
      yourClaimed,
    },
  };
}

/**
 * Spend soft $MOZE for tickets (pending/banked first, then claimed).
 * @returns summary + new balance
 */
export function enterRaffle({ address, raffleId, tickets }) {
  const db = getDb();
  const now = Date.now();
  const n = Math.floor(Number(tickets));
  if (!Number.isFinite(n) || n < 1) {
    const err = new Error('Tickets must be at least 1');
    err.statusCode = 400;
    throw err;
  }
  // Soft per-request cap only (abuse guard). No per-wallet max by default.
  if (n > 10000) {
    const err = new Error('Max 10000 tickets per request');
    err.statusCode = 400;
    throw err;
  }

  const raffle = getRaffleById(raffleId) || getActiveRaffle();
  if (!raffle || raffle.id !== Number(raffleId)) {
    const err = new Error('Raffle not found');
    err.statusCode = 404;
    throw err;
  }
  if (!isWindowOpen(raffle, now)) {
    const err = new Error('Raffle is not open');
    err.statusCode = 400;
    throw err;
  }

  const cost = Number(raffle.ticketCost) || 0;
  const spent = cost * n;
  if (spent <= 0) {
    const err = new Error('Invalid ticket cost');
    err.statusCode = 400;
    throw err;
  }

  // Accrue pending, then spend from total soft $MOZE (banked + claimed)
  settleAddress(address, now);
  const wallet = db
    .prepare(`SELECT banked, claimed FROM wallets WHERE address = ?`)
    .get(address);
  const banked = Number(wallet?.banked) || 0;
  const claimed = Number(wallet?.claimed) || 0;
  const total = banked + claimed;
  if (total + 1e-9 < spent) {
    const err = new Error(
      `Not enough $MOZE. Need ${spent}, have ${Math.round(total * 10000) / 10000}`
    );
    err.statusCode = 400;
    err.code = 'INSUFFICIENT_MOZE';
    err.need = spent;
    err.have = total;
    throw err;
  }

  const fromBanked = Math.min(banked, spent);
  const fromClaimed = Math.max(0, spent - fromBanked);

  const existing = db
    .prepare(
      `SELECT tickets, moze_spent FROM raffle_entries WHERE raffle_id = ? AND address = ?`
    )
    .get(raffle.id, address);
  const already = Number(existing?.tickets) || 0;
  const max = raffle.maxTicketsPerWallet;
  if (max != null && already + n > max) {
    const left = Math.max(0, max - already);
    const err = new Error(
      left
        ? `Max ${max} tickets per wallet. You can buy ${left} more.`
        : `Max ${max} tickets per wallet reached.`
    );
    err.statusCode = 400;
    throw err;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE wallets
       SET banked = banked - ?, claimed = claimed - ?, updated_at = ?
       WHERE address = ?`
    ).run(fromBanked, fromClaimed, now, address);

    if (existing) {
      db.prepare(
        `UPDATE raffle_entries
         SET tickets = tickets + ?, moze_spent = moze_spent + ?, updated_at = ?
         WHERE raffle_id = ? AND address = ?`
      ).run(n, spent, now, raffle.id, address);
    } else {
      db.prepare(
        `INSERT INTO raffle_entries
           (raffle_id, address, tickets, moze_spent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(raffle.id, address, n, spent, now, now);
    }

    db.prepare(
      `INSERT INTO events (address, action, token_ids, amount, created_at)
       VALUES (?, 'raffle_enter', ?, ?, ?)`
    ).run(address, String(raffle.id), spent, now);
  });
  tx();

  const state = getStakeState(address);
  const summary = getRaffleSummary({ you: address });

  return {
    ok: true,
    raffleId: raffle.id,
    ticketsBought: n,
    spent,
    fromBanked,
    fromClaimed,
    pending: Number(state.pending) || 0,
    claimed: Number(state.claimed) || 0,
    yourMoze: (Number(state.pending) || 0) + (Number(state.claimed) || 0),
    raffle: summary.raffle,
  };
}

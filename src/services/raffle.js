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

export function getRaffleBySlug(slug) {
  if (!slug) return null;
  const row = getDb().prepare(`SELECT * FROM raffles WHERE slug = ?`).get(String(slug));
  return mapRaffle(row);
}

/** All raffles (for multi-prize picker). */
export function listRaffles() {
  return getDb()
    .prepare(`SELECT * FROM raffles ORDER BY id ASC`)
    .all()
    .map(mapRaffle);
}

function resolveRaffle({ id = null, slug = null } = {}) {
  if (id != null && Number.isFinite(Number(id))) {
    return getRaffleById(Number(id));
  }
  if (slug) return getRaffleBySlug(slug);
  return getActiveRaffle();
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

function buildRafflePayload(raffle, you) {
  if (!raffle) return null;
  const stats = entryStats(raffle.id, you);
  return {
    ...raffle,
    open: isWindowOpen(raffle),
    ...stats,
  };
}

/** Public summary for GET /v1/raffle — supports multi raffle via ?id= / ?slug= */
export function getRaffleSummary({ you = null, id = null, slug = null } = {}) {
  const raffle = resolveRaffle({ id, slug });

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

  // Light list for prize picker (all raffles)
  const raffles = listRaffles().map((r) => {
    const st = entryStats(r.id, you);
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      prizeLabel: r.prizeLabel,
      ticketCost: r.ticketCost,
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      open: isWindowOpen(r),
      totalTickets: st.totalTickets,
      entrants: st.entrants,
      yourTickets: st.yourTickets,
    };
  });

  const payload = buildRafflePayload(raffle, you);
  if (payload) {
    payload.yourMoze = yourMoze;
    payload.yourPending = yourPending;
    payload.yourClaimed = yourClaimed;
  }

  return {
    ok: true,
    raffles,
    raffle: payload,
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

// ── Admin CRUD ──────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/** Admin list with entry stats. */
export function listRafflesAdmin() {
  return listRaffles().map((r) => {
    const st = entryStats(r.id, null);
    return {
      ...r,
      open: isWindowOpen(r),
      totalTickets: st.totalTickets,
      entrants: st.entrants,
    };
  });
}

/**
 * Create raffle. Body: slug?, title, prizeLabel|prize_label, description?,
 * ticketCost?, maxTicketsPerWallet?, startsAt?, endsAt?, status?, endsInDays?
 */
export function createRaffle(body = {}) {
  const title = String(body.title || '').trim();
  const prizeLabel = String(body.prizeLabel || body.prize_label || '').trim();
  if (!title || !prizeLabel) {
    const err = new Error('title and prizeLabel required');
    err.statusCode = 400;
    throw err;
  }

  let slug = String(body.slug || '').trim() || slugify(title);
  if (!slug) slug = `raffle-${Date.now()}`;

  const ticketCost = Number(body.ticketCost ?? body.ticket_cost ?? 1);
  if (!Number.isFinite(ticketCost) || ticketCost <= 0) {
    const err = new Error('ticketCost must be > 0');
    err.statusCode = 400;
    throw err;
  }

  let maxPer = body.maxTicketsPerWallet ?? body.max_tickets_per_wallet;
  if (maxPer === '' || maxPer === undefined) maxPer = null;
  else if (maxPer != null) {
    maxPer = Number(maxPer);
    if (!Number.isFinite(maxPer) || maxPer < 1) maxPer = null;
  }

  const now = Date.now();
  let startsAt = body.startsAt ?? body.starts_at;
  let endsAt = body.endsAt ?? body.ends_at;
  if (startsAt != null) startsAt = toMs(startsAt) || now;
  else startsAt = now;
  if (endsAt != null) endsAt = toMs(endsAt) || null;
  else {
    const days = Number(body.endsInDays ?? process.env.RAFFLE_ENDS_IN_DAYS ?? 14);
    endsAt = days > 0 ? now + days * 86_400_000 : null;
  }

  const status = ['open', 'closed', 'drawn'].includes(String(body.status || '').toLowerCase())
    ? String(body.status).toLowerCase()
    : 'open';
  const description = body.description != null ? String(body.description) : '';

  const db = getDb();
  try {
    const result = db
      .prepare(
        `INSERT INTO raffles (
          slug, title, description, prize_label, ticket_cost,
          max_tickets_per_wallet, status, starts_at, ends_at,
          winner_address, drawn_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .run(
        slug,
        title,
        description,
        prizeLabel,
        ticketCost,
        maxPer,
        status,
        startsAt,
        endsAt,
        now
      );
    return getRaffleById(result.lastInsertRowid);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const err = new Error(`slug already exists: ${slug}`);
      err.statusCode = 400;
      throw err;
    }
    throw e;
  }
}

/** Partial update by id. */
export function updateRaffle(id, body = {}) {
  const existing = getRaffleById(id);
  if (!existing) {
    const err = new Error('Raffle not found');
    err.statusCode = 404;
    throw err;
  }

  const slug = body.slug != null ? String(body.slug).trim() : existing.slug;
  const title = body.title != null ? String(body.title).trim() : existing.title;
  const description =
    body.description != null ? String(body.description) : existing.description;
  const prizeLabel =
    body.prizeLabel != null || body.prize_label != null
      ? String(body.prizeLabel ?? body.prize_label).trim()
      : existing.prizeLabel;
  const ticketCost =
    body.ticketCost != null || body.ticket_cost != null
      ? Number(body.ticketCost ?? body.ticket_cost)
      : existing.ticketCost;
  if (!title || !prizeLabel || !Number.isFinite(ticketCost) || ticketCost <= 0) {
    const err = new Error('Invalid title/prizeLabel/ticketCost');
    err.statusCode = 400;
    throw err;
  }

  let maxPer = existing.maxTicketsPerWallet;
  if (body.maxTicketsPerWallet !== undefined || body.max_tickets_per_wallet !== undefined) {
    const raw = body.maxTicketsPerWallet ?? body.max_tickets_per_wallet;
    maxPer = raw === '' || raw == null ? null : Number(raw);
    if (maxPer != null && (!Number.isFinite(maxPer) || maxPer < 1)) maxPer = null;
  }

  let startsAt = existing.startsAt;
  let endsAt = existing.endsAt;
  if (body.startsAt !== undefined || body.starts_at !== undefined) {
    startsAt = toMs(body.startsAt ?? body.starts_at) || null;
  }
  if (body.endsAt !== undefined || body.ends_at !== undefined) {
    endsAt = toMs(body.endsAt ?? body.ends_at) || null;
  }

  let status = existing.status;
  if (body.status != null) {
    const s = String(body.status).toLowerCase();
    if (['open', 'closed', 'drawn'].includes(s)) status = s;
  }
  // Convenience: open: true/false from bot dashboard
  if (body.open === true || body.open === 1 || body.open === '1') status = 'open';
  if (body.open === false || body.open === 0 || body.open === '0') status = 'closed';

  try {
    getDb()
      .prepare(
        `UPDATE raffles SET
          slug = ?, title = ?, description = ?, prize_label = ?,
          ticket_cost = ?, max_tickets_per_wallet = ?, status = ?,
          starts_at = ?, ends_at = ?
         WHERE id = ?`
      )
      .run(slug, title, description, prizeLabel, ticketCost, maxPer, status, startsAt, endsAt, id);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      const err = new Error(`slug already exists: ${slug}`);
      err.statusCode = 400;
      throw err;
    }
    throw e;
  }
  return getRaffleById(id);
}

export function setRaffleStatus(id, status) {
  const s = String(status || '').toLowerCase();
  if (!['open', 'closed', 'drawn'].includes(s)) {
    const err = new Error('status must be open|closed|drawn');
    err.statusCode = 400;
    throw err;
  }
  return updateRaffle(id, { status: s });
}

/**
 * Delete raffle. Refuses if entries exist unless force.
 * force also deletes raffle_entries for that raffle (does NOT refund $MOZE).
 */
export function deleteRaffle(id, { force = false } = {}) {
  const existing = getRaffleById(id);
  if (!existing) {
    const err = new Error('Raffle not found');
    err.statusCode = 404;
    throw err;
  }
  const db = getDb();
  const cnt = db
    .prepare(`SELECT COUNT(*) AS c FROM raffle_entries WHERE raffle_id = ?`)
    .get(id);
  if ((Number(cnt?.c) || 0) > 0 && !force) {
    const err = new Error(
      `Raffle has ${cnt.c} entrant(s). Pass force=1 to delete (does not refund $MOZE).`
    );
    err.statusCode = 400;
    throw err;
  }
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM raffle_entries WHERE raffle_id = ?`).run(id);
    db.prepare(`DELETE FROM raffles WHERE id = ?`).run(id);
  });
  tx();
  return true;
}

/**
 * Weighted random draw by ticket count. Sets status=drawn + winner_address.
 * @param {number} id
 * @param {{ force?: boolean }} opts — force redraw if already drawn
 */
export function drawRaffle(id, { force = false } = {}) {
  const raffle = getRaffleById(id);
  if (!raffle) {
    const err = new Error('Raffle not found');
    err.statusCode = 404;
    throw err;
  }
  if (raffle.status === 'drawn' && raffle.winnerAddress && !force) {
    const err = new Error(
      `Already drawn. Winner: ${raffle.winnerAddress}. Pass force=1 to redraw.`
    );
    err.statusCode = 400;
    throw err;
  }

  const db = getDb();
  const entries = db
    .prepare(
      `SELECT address, tickets FROM raffle_entries
       WHERE raffle_id = ? AND tickets > 0
       ORDER BY tickets DESC, created_at ASC`
    )
    .all(id);

  if (!entries.length) {
    const err = new Error('No entries to draw from');
    err.statusCode = 400;
    throw err;
  }

  // Build ticket pool (cap expand for memory: use cumulative weights)
  let total = 0;
  for (const e of entries) total += Number(e.tickets) || 0;
  if (total <= 0) {
    const err = new Error('Total tickets is 0');
    err.statusCode = 400;
    throw err;
  }

  // crypto-ish random in [0, total)
  const r = Math.floor(Math.random() * total);
  let acc = 0;
  let winner = entries[0].address;
  for (const e of entries) {
    acc += Number(e.tickets) || 0;
    if (r < acc) {
      winner = e.address;
      break;
    }
  }

  const now = Date.now();
  db.prepare(
    `UPDATE raffles
     SET status = 'drawn', winner_address = ?, drawn_at = ?, ends_at = COALESCE(ends_at, ?)
     WHERE id = ?`
  ).run(String(winner).toLowerCase(), now, now, id);

  const winnerEntry = entries.find(
    (e) => String(e.address).toLowerCase() === String(winner).toLowerCase()
  );

  return {
    ok: true,
    raffleId: id,
    slug: raffle.slug,
    title: raffle.title,
    prizeLabel: raffle.prizeLabel,
    winnerAddress: String(winner).toLowerCase(),
    winnerTickets: Number(winnerEntry?.tickets) || 0,
    totalTickets: total,
    entrants: entries.length,
    drawnAt: now,
    raffle: getRaffleById(id),
  };
}

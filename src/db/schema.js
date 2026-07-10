/**
 * Additive migrations only.
 * Never DROP wallets / positions / events — stake data lives on the Coolify
 * volume at DATABASE_PATH (default /data/moze.db) and must survive redeploys.
 */
export function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      banked REAL NOT NULL DEFAULT 0,
      claimed REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      token_id INTEGER PRIMARY KEY,
      address TEXT NOT NULL,
      staked_at INTEGER NOT NULL,
      last_settle_at INTEGER NOT NULL,
      FOREIGN KEY (address) REFERENCES wallets(address)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_address ON positions(address);

    CREATE TABLE IF NOT EXISTS holders_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      supply INTEGER NOT NULL DEFAULT 1000
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      action TEXT NOT NULL,
      token_ids TEXT,
      amount REAL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raffles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      prize_label TEXT,
      ticket_cost REAL NOT NULL,
      max_tickets_per_wallet INTEGER,
      status TEXT NOT NULL,
      starts_at INTEGER,
      ends_at INTEGER,
      winner_address TEXT,
      drawn_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raffle_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raffle_id INTEGER NOT NULL,
      address TEXT NOT NULL,
      tickets INTEGER NOT NULL DEFAULT 0,
      moze_spent REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(raffle_id, address),
      FOREIGN KEY (raffle_id) REFERENCES raffles(id)
    );

    CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle ON raffle_entries(raffle_id);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_addr ON raffle_entries(address);
  `);

  seedDefaultRaffle(db);
}

function defaultTicketCost() {
  // Default: 1 $MOZE per ticket (override with RAFFLE_TICKET_COST).
  if (process.env.RAFFLE_TICKET_COST != null && process.env.RAFFLE_TICKET_COST !== '') {
    const n = Number(process.env.RAFFLE_TICKET_COST);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

/** null = unlimited tickets per wallet. Set RAFFLE_MAX_TICKETS_PER_WALLET to cap. */
function defaultMaxTicketsPerWallet() {
  const raw = process.env.RAFFLE_MAX_TICKETS_PER_WALLET;
  if (raw == null || raw === '' || raw === '0' || String(raw).toLowerCase() === 'unlimited') {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Upsert one raffle by slug. Never wipes entries / stake tables.
 * @param {import('better-sqlite3').Database} db
 * @param {{ slug: string, title: string, description: string, prizeLabel: string, cost?: number, maxPer?: number|null, endsInDays?: number, forceEnds?: boolean }} cfg
 */
function upsertRaffle(db, cfg) {
  const cost = cfg.cost != null ? cfg.cost : defaultTicketCost();
  const maxPer = cfg.maxPer !== undefined ? cfg.maxPer : defaultMaxTicketsPerWallet();
  const endsInDays = Number(cfg.endsInDays ?? process.env.RAFFLE_ENDS_IN_DAYS ?? 14);
  const forceEnds =
    cfg.forceEnds != null
      ? !!cfg.forceEnds
      : String(process.env.RAFFLE_REFRESH_ENDS || '') === '1';

  const row = db.prepare(`SELECT id, ends_at FROM raffles WHERE slug = ?`).get(cfg.slug);
  if (row) {
    db.prepare(
      `UPDATE raffles
       SET ticket_cost = ?,
           prize_label = ?,
           title = ?,
           description = ?,
           max_tickets_per_wallet = ?,
           status = CASE WHEN status = 'drawn' THEN status ELSE 'open' END
       WHERE slug = ?`
    ).run(cost, cfg.prizeLabel, cfg.title, cfg.description, maxPer, cfg.slug);

    if ((row.ends_at == null || forceEnds) && endsInDays > 0) {
      const endsAt = Date.now() + endsInDays * 24 * 60 * 60 * 1000;
      const startsAt = Date.now();
      db.prepare(
        `UPDATE raffles SET starts_at = ?, ends_at = ?, status = 'open' WHERE slug = ?`
      ).run(startsAt, endsAt, cfg.slug);
    }
    return;
  }

  const now = Date.now();
  const endsAt = endsInDays > 0 ? now + endsInDays * 24 * 60 * 60 * 1000 : null;
  db.prepare(
    `INSERT INTO raffles (
      slug, title, description, prize_label, ticket_cost,
      max_tickets_per_wallet, status, starts_at, ends_at,
      winner_address, drawn_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?)`
  ).run(
    cfg.slug,
    cfg.title,
    cfg.description,
    cfg.prizeLabel,
    cost,
    maxPer,
    now,
    endsAt,
    now
  );
}

function seedDefaultRaffle(db) {
  // Raffle #1 — founder Moze #30
  upsertRaffle(db, {
    slug: 'moze-raffle-1',
    title: process.env.RAFFLE_TITLE || 'Moze Raffle #1 — Win #30',
    description:
      process.env.RAFFLE_DESCRIPTION ||
      'Enter with soft $MOZE from staking. Prize: Moze #30 from the founder. One ticket = one chance.',
    prizeLabel: process.env.RAFFLE_PRIZE_LABEL || 'Moze #30 (founder)',
  });

  // Raffle #2 — Robin Frogs #4284 (collab / trending prize)
  // OpenSea: https://opensea.io/item/robinhood/0x748af7baa726b49316573a124f2644b5638452d7/4284
  upsertRaffle(db, {
    slug: 'moze-raffle-2',
    title: process.env.RAFFLE_2_TITLE || 'Moze Raffle #2 — Robin Frogs #4284',
    description:
      process.env.RAFFLE_2_DESCRIPTION ||
      'Enter with soft $MOZE. Prize: Robin Frogs #4284. One ticket = one chance.',
    prizeLabel: process.env.RAFFLE_2_PRIZE_LABEL || 'Robin Frogs #4284',
    // force fresh 14-day window on first seed only (ends_at null → set); existing keeps ends
  });
}

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
  // Local/dev: 0.1 $MOZE for easy testing. Production: 11 (or set RAFFLE_TICKET_COST).
  if (process.env.RAFFLE_TICKET_COST != null && process.env.RAFFLE_TICKET_COST !== '') {
    const n = Number(process.env.RAFFLE_TICKET_COST);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return process.env.NODE_ENV === 'production' ? 11 : 0.1;
}

function seedDefaultRaffle(db) {
  // Never resets stake tables. Prize = founder Moze #30.
  const prizeLabel = process.env.RAFFLE_PRIZE_LABEL || 'Moze #30 (founder)';
  const title = process.env.RAFFLE_TITLE || 'Moze Raffle #1 — Win #30';
  const description =
    process.env.RAFFLE_DESCRIPTION ||
    'Enter with soft $MOZE from staking. Prize: Moze #30 from the founder. One ticket = one chance.';
  const cost = defaultTicketCost();
  const maxPer = Number(process.env.RAFFLE_MAX_TICKETS_PER_WALLET || 20);
  // Default window: 14 days from first seed (or RAFFLE_ENDS_IN_DAYS)
  const endsInDays = Number(process.env.RAFFLE_ENDS_IN_DAYS || 14);
  const forceEnds = String(process.env.RAFFLE_REFRESH_ENDS || '') === '1';

  const row = db.prepare(`SELECT id, ends_at FROM raffles WHERE slug = ?`).get('moze-raffle-1');
  if (row) {
    // Sync price/copy from env without wiping stake tables or entry tickets
    db.prepare(
      `UPDATE raffles
       SET ticket_cost = ?,
           prize_label = ?,
           title = ?,
           description = ?,
           max_tickets_per_wallet = ?,
           status = CASE WHEN status = 'drawn' THEN status ELSE 'open' END
       WHERE slug = ?`
    ).run(
      cost,
      prizeLabel,
      title,
      description,
      Number.isFinite(maxPer) && maxPer > 0 ? maxPer : 20,
      'moze-raffle-1'
    );
    // Set 14-day end once if missing, or when RAFFLE_REFRESH_ENDS=1 (one-shot on deploy)
    if ((row.ends_at == null || forceEnds) && endsInDays > 0) {
      const endsAt = Date.now() + endsInDays * 24 * 60 * 60 * 1000;
      const startsAt = Date.now();
      db.prepare(
        `UPDATE raffles SET starts_at = ?, ends_at = ?, status = 'open' WHERE slug = ?`
      ).run(startsAt, endsAt, 'moze-raffle-1');
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
    'moze-raffle-1',
    title,
    description,
    prizeLabel,
    cost,
    Number.isFinite(maxPer) && maxPer > 0 ? maxPer : 20,
    now,
    endsAt,
    now
  );
}

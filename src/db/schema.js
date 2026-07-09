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
  `);
}

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrate } from './schema.js';

let db;

export function getDb() {
  if (db) return db;
  const dir = path.dirname(config.databasePath);
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(config.databasePath);
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  try {
    const positions = Number(db.prepare(`SELECT COUNT(*) AS n FROM positions`).get()?.n) || 0;
    const wallets = Number(db.prepare(`SELECT COUNT(*) AS n FROM wallets`).get()?.n) || 0;
    console.log(
      `[moze-db] path=${config.databasePath} existed=${existed} wallets=${wallets} positions=${positions}`
    );
  } catch (err) {
    console.warn('[moze-db] stats failed', err?.message || err);
  }
  return db;
}

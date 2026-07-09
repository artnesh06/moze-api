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
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

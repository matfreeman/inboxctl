import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { dirname, resolve } from "node:path";
import { ensureDir } from "../../config.js";
import * as schema from "./schema.js";

const dbCache = new Map<string, ReturnType<typeof drizzle>>();
const sqliteCache = new Map<string, Database.Database>();

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  subject TEXT,
  snippet TEXT,
  date INTEGER,
  is_read INTEGER,
  is_starred INTEGER,
  label_ids TEXT,
  size_estimate INTEGER,
  has_attachments INTEGER,
  list_unsubscribe TEXT,
  synced_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_emails_from_address ON emails(from_address);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_is_read ON emails(is_read);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  yaml_hash TEXT,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  priority INTEGER DEFAULT 50,
  deployed_at INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS execution_runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  rule_id TEXT,
  dry_run INTEGER DEFAULT 0,
  requested_actions TEXT NOT NULL,
  query TEXT,
  status TEXT NOT NULL,
  created_at INTEGER,
  undone_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_execution_runs_rule_id ON execution_runs(rule_id);
CREATE INDEX IF NOT EXISTS idx_execution_runs_created_at ON execution_runs(created_at);

CREATE TABLE IF NOT EXISTS execution_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  email_id TEXT NOT NULL,
  status TEXT NOT NULL,
  applied_actions TEXT NOT NULL,
  before_label_ids TEXT NOT NULL,
  after_label_ids TEXT NOT NULL,
  error_message TEXT,
  executed_at INTEGER,
  undone_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_execution_items_run_id ON execution_items(run_id);
CREATE INDEX IF NOT EXISTS idx_execution_items_email_id ON execution_items(email_id);
CREATE INDEX IF NOT EXISTS idx_execution_items_executed_at ON execution_items(executed_at);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY,
  account_email TEXT,
  history_id TEXT,
  last_full_sync INTEGER,
  last_incremental_sync INTEGER,
  total_messages INTEGER,
  full_sync_cursor TEXT,
  full_sync_processed INTEGER,
  full_sync_total INTEGER
);

CREATE TABLE IF NOT EXISTS newsletter_senders (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  message_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  unsubscribe_link TEXT,
  detection_reason TEXT,
  first_seen INTEGER,
  last_seen INTEGER
);

CREATE INDEX IF NOT EXISTS idx_newsletter_senders_email ON newsletter_senders(email);

INSERT OR IGNORE INTO sync_state (id, history_id, last_full_sync, last_incremental_sync, total_messages)
VALUES (1, NULL, NULL, NULL, 0);
`;

function ensureSyncStateColumns(sqlite: Database.Database): void {
  const columns = sqlite
    .prepare("PRAGMA table_info(sync_state)")
    .all() as Array<{ name: string }>;

  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("account_email")) {
    sqlite.exec("ALTER TABLE sync_state ADD COLUMN account_email TEXT");
  }

  if (!columnNames.has("full_sync_cursor")) {
    sqlite.exec("ALTER TABLE sync_state ADD COLUMN full_sync_cursor TEXT");
  }

  if (!columnNames.has("full_sync_processed")) {
    sqlite.exec("ALTER TABLE sync_state ADD COLUMN full_sync_processed INTEGER");
  }

  if (!columnNames.has("full_sync_total")) {
    sqlite.exec("ALTER TABLE sync_state ADD COLUMN full_sync_total INTEGER");
  }
}

function getResolvedPath(dbPath: string): string {
  return resolve(dbPath);
}

export function getSqlite(dbPath: string): Database.Database {
  const resolvedPath = getResolvedPath(dbPath);
  const cached = sqliteCache.get(resolvedPath);

  if (cached) {
    return cached;
  }

  ensureDir(dirname(resolvedPath));
  const sqlite = new Database(resolvedPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(SCHEMA_SQL);
  ensureSyncStateColumns(sqlite);
  sqliteCache.set(resolvedPath, sqlite);

  return sqlite;
}

export function getDb(dbPath: string) {
  const resolvedPath = getResolvedPath(dbPath);
  const cached = dbCache.get(resolvedPath);

  if (cached) {
    return cached;
  }

  const sqlite = getSqlite(resolvedPath);
  const db = drizzle(sqlite, { schema });
  dbCache.set(resolvedPath, db);

  return db;
}

export function initializeDb(dbPath: string) {
  return getDb(dbPath);
}

export function closeDb(dbPath: string): void {
  const resolvedPath = getResolvedPath(dbPath);
  const sqlite = sqliteCache.get(resolvedPath);

  if (sqlite) {
    sqlite.close();
    sqliteCache.delete(resolvedPath);
  }

  dbCache.delete(resolvedPath);
}

export function closeAllDbs(): void {
  for (const sqlite of sqliteCache.values()) {
    sqlite.close();
  }

  sqliteCache.clear();
  dbCache.clear();
}

export type InboxctlDb = ReturnType<typeof getDb>;

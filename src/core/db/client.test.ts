import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDb, getSqlite } from "./client.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("database bootstrap", () => {
  it("upgrades a legacy sync_state table before account-aware reads occur", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inboxctl-db-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "emails.db");

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE sync_state (
        id INTEGER PRIMARY KEY,
        history_id TEXT,
        last_full_sync INTEGER,
        last_incremental_sync INTEGER,
        total_messages INTEGER
      );

      INSERT INTO sync_state (id, history_id, last_full_sync, last_incremental_sync, total_messages)
      VALUES (1, 'legacy-history', 1, 2, 3);
    `);
    legacyDb.close();

    expect(() => initializeDb(dbPath)).not.toThrow();

    const sqlite = getSqlite(dbPath);
    const columns = sqlite.prepare("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>;
    const row = sqlite
      .prepare(
        "SELECT id, account_email, history_id, last_full_sync, last_incremental_sync, total_messages FROM sync_state WHERE id = 1",
      )
      .get() as {
      id: number;
      account_email: string | null;
      history_id: string | null;
      last_full_sync: number | null;
      last_incremental_sync: number | null;
      total_messages: number | null;
    };

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "account_email",
        "full_sync_cursor",
        "full_sync_processed",
        "full_sync_total",
      ]),
    );
    expect(row).toEqual({
      id: 1,
      account_email: null,
      history_id: "legacy-history",
      last_full_sync: 1,
      last_incremental_sync: 2,
      total_messages: 3,
    });
  });
});

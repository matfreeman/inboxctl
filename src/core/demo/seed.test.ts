import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getSqlite, initializeDb } from "../db/client.js";
import { seedDemoData } from "./seed.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      closeDb(join(dir, "demo.db"));
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("seedDemoData", () => {
  it("populates the standalone demo database with realistic publish assets", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inboxctl-demo-seed-"));
    const dbPath = join(tempDir, "demo.db");
    tempDirs.push(tempDir);

    initializeDb(dbPath);
    const dataset = seedDemoData(getSqlite(dbPath), Date.parse("2026-04-08T10:00:00Z"));
    const sqlite = getSqlite(dbPath);

    const emailCount = sqlite.prepare("SELECT COUNT(*) AS count FROM emails").get() as { count: number };
    const ruleCount = sqlite.prepare("SELECT COUNT(*) AS count FROM rules").get() as { count: number };
    const runCount = sqlite.prepare("SELECT COUNT(*) AS count FROM execution_runs").get() as { count: number };
    const itemCount = sqlite.prepare("SELECT COUNT(*) AS count FROM execution_items").get() as { count: number };
    const newsletterCount = sqlite.prepare("SELECT COUNT(*) AS count FROM newsletter_senders").get() as { count: number };
    const syncState = sqlite
      .prepare(
        "SELECT account_email AS accountEmail, history_id AS historyId, total_messages AS totalMessages FROM sync_state WHERE id = 1",
      )
      .get() as {
      accountEmail: string;
      historyId: string;
      totalMessages: number;
    };

    expect(dataset.messages).toHaveLength(150);
    expect(dataset.labels).toHaveLength(12);
    expect(emailCount.count).toBe(150);
    expect(ruleCount.count).toBe(3);
    expect(runCount.count).toBe(5);
    expect(itemCount.count).toBe(19);
    expect(newsletterCount.count).toBe(6);
    expect(syncState).toEqual({
      accountEmail: "demo@example.com",
      historyId: "12345678",
      totalMessages: 150,
    });
  });
});

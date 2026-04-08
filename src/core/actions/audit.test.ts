import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDb, getSqlite } from "../db/client.js";
import {
  appendExecutionItem,
  createExecutionRun,
  getRecentRuns,
  getRun,
  getRunItems,
  getRunsByEmail,
  getRunsByRule,
} from "./audit.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-audit-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH);
});

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function insertEmail(id: string, overrides: Partial<{
  threadId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
}>) {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  sqlite
    .prepare(
      `
      INSERT INTO emails (
        id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
        is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      overrides.threadId ?? "thread-1",
      overrides.fromAddress ?? "sender@example.com",
      overrides.fromName ?? "Sender",
      JSON.stringify(["user@example.com"]),
      overrides.subject ?? "Subject",
      "Snippet",
      Date.parse("2026-04-01T00:00:00Z"),
      overrides.isRead === false ? 0 : 1,
      overrides.isStarred ? 1 : 0,
      JSON.stringify(overrides.labelIds ?? ["INBOX"]),
      1024,
      0,
      null,
      Date.now(),
    );
}

describe("audit layer", () => {
  it("creates execution runs and execution items with snapshots", async () => {
    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      query: "from:alerts@example.com",
      status: "applied",
    });

    const item = await appendExecutionItem(run.id, {
      emailId: "msg-1",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["UNREAD"],
    });

    const loadedRun = await getRun(run.id);
    const loadedItems = await getRunItems(run.id);

    expect(loadedRun).not.toBeNull();
    expect(loadedRun?.requestedActions).toEqual([{ type: "archive" }]);
    expect(loadedRun?.itemCount).toBe(1);
    expect(loadedRun?.appliedItemCount).toBe(1);
    expect(item.beforeLabelIds).toEqual(["INBOX", "UNREAD"]);
    expect(loadedItems).toHaveLength(1);
    expect(loadedItems[0]?.afterLabelIds).toEqual(["UNREAD"]);
  });

  it("returns recent runs ordered by newest first", async () => {
    const older = await createExecutionRun({
      id: "run-older",
      sourceType: "manual",
      createdAt: 1000,
      requestedActions: [{ type: "label", label: "Receipts" }],
    });
    await appendExecutionItem(older.id, {
      emailId: "msg-old",
      status: "applied",
      appliedActions: [{ type: "label", label: "Receipts" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX", "Receipts"],
    });

    const newer = await createExecutionRun({
      id: "run-newer",
      sourceType: "rule",
      ruleId: "rule-1",
      createdAt: 2000,
      requestedActions: [{ type: "mark_read" }],
    });

    const recent = await getRecentRuns(10);
    const byRule = await getRunsByRule("rule-1");
    const byEmail = await getRunsByEmail("msg-old");

    expect(recent.map((run) => run.id)).toEqual([newer.id, older.id]);
    expect(byRule.map((run) => run.id)).toEqual([newer.id]);
    expect(byEmail.map((run) => run.id)).toEqual([older.id]);
  });

  it("returns null for missing runs and empty arrays for missing items", async () => {
    expect(await getRun("missing")).toBeNull();
    expect(await getRunItems("missing")).toEqual([]);
  });
});


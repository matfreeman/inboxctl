import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDb, getSqlite } from "../db/client.js";
import { createMockTransport, makeEmailMessage } from "../../__tests__/helpers/mock-gmail.js";

vi.mock("../gmail/transport.js", () => ({
  getGmailTransport: vi.fn(),
}));

vi.mock("../gmail/messages.js", () => ({
  batchGetMessages: vi.fn(),
}));

import { getGmailTransport } from "../gmail/transport.js";
import { batchGetMessages } from "../gmail/messages.js";
import { fullSync, incrementalSync, getSyncStatus } from "./sync.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_TOKENS_PATH",
  "INBOXCTL_RULES_DIR",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-sync-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  initializeDb(process.env.INBOXCTL_DB_PATH);
  vi.mocked(getGmailTransport).mockReset();
  vi.mocked(batchGetMessages).mockReset();
});

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("fullSync", () => {
  it("fetches all message pages, upserts to DB, and saves sync state", async () => {
    const transport = createMockTransport({
      listMessages: vi.fn()
        .mockResolvedValueOnce({
          messages: [{ id: "msg-1" }, { id: "msg-2" }],
          nextPageToken: "token-2",
          resultSizeEstimate: 3,
        })
        .mockResolvedValueOnce({
          messages: [{ id: "msg-3" }],
          resultSizeEstimate: 3,
        }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "999",
        messagesTotal: 3,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages)
      .mockResolvedValueOnce([makeEmailMessage("msg-1"), makeEmailMessage("msg-2")])
      .mockResolvedValueOnce([makeEmailMessage("msg-3")]);

    const result = await fullSync();

    expect(result.mode).toBe("full");
    expect(result.messagesProcessed).toBe(3);
    expect(result.usedHistoryFallback).toBe(false);
    expect(result.historyId).toBe("999");

    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    const count = (sqlite.prepare("SELECT COUNT(*) as c FROM emails").get() as { c: number }).c;
    expect(count).toBe(3);

    const state = sqlite
      .prepare("SELECT account_email, history_id, last_full_sync, total_messages FROM sync_state WHERE id = 1")
      .get() as { account_email: string; history_id: string; last_full_sync: number; total_messages: number };
    expect(state.account_email).toBe("user@example.com");
    expect(state.history_id).toBe("999");
    expect(state.last_full_sync).toBeGreaterThan(0);
    expect(state.total_messages).toBe(3);
  });

  it("calls the progress callback with updated counts", async () => {
    const transport = createMockTransport({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "msg-1" }],
        resultSizeEstimate: 5,
      }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "10",
        messagesTotal: 5,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("msg-1")]);

    const progress: Array<[number, number | null]> = [];
    await fullSync((synced, total) => {
      progress.push([synced, total]);
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toEqual([0, 5]);
    expect(progress).toContainEqual([1, 5]);
  });

  it("stops early when maxMessages is reached", async () => {
    process.env.INBOXCTL_SYNC_MAX_MESSAGES = "2";

    const transport = createMockTransport({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "msg-1" }, { id: "msg-2" }, { id: "msg-3" }],
        nextPageToken: "next",
        resultSizeEstimate: 10,
      }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "50",
        messagesTotal: 10,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([
      makeEmailMessage("msg-1"),
      makeEmailMessage("msg-2"),
      makeEmailMessage("msg-3"),
    ]);

    const result = await fullSync();

    expect(result.messagesProcessed).toBeGreaterThanOrEqual(2);
    // Should not have paginated again after hitting limit
    expect(transport.listMessages).toHaveBeenCalledTimes(1);

    delete process.env.INBOXCTL_SYNC_MAX_MESSAGES;
  });

  it("resumes an interrupted full sync from the saved cursor", async () => {
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare(`
      INSERT INTO emails (id, thread_id, from_address, from_name, to_addresses, subject, snippet, date, is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at)
      VALUES ('msg-1', 'thread-msg-1', 'a@b.com', 'A', '[]', 'One', 'one', 1000, 1, 0, '[]', 100, 0, null, ${Date.now()})
    `).run();
    sqlite.prepare(`
      INSERT INTO emails (id, thread_id, from_address, from_name, to_addresses, subject, snippet, date, is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at)
      VALUES ('msg-2', 'thread-msg-2', 'a@b.com', 'A', '[]', 'Two', 'two', 1000, 1, 0, '[]', 100, 0, null, ${Date.now()})
    `).run();
    sqlite.prepare(`
      UPDATE sync_state
      SET account_email = 'user@example.com',
          history_id = NULL,
          total_messages = 2,
          full_sync_cursor = 'token-2',
          full_sync_processed = 2,
          full_sync_total = 5
      WHERE id = 1
    `).run();

    const transport = createMockTransport({
      listMessages: vi.fn()
        .mockResolvedValueOnce({
          messages: [{ id: "msg-3" }, { id: "msg-4" }],
          nextPageToken: "token-3",
          resultSizeEstimate: 5,
        })
        .mockResolvedValueOnce({
          messages: [{ id: "msg-5" }],
          resultSizeEstimate: 5,
        }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "999",
        messagesTotal: 5,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages)
      .mockResolvedValueOnce([makeEmailMessage("msg-3"), makeEmailMessage("msg-4")])
      .mockResolvedValueOnce([makeEmailMessage("msg-5")]);

    const result = await fullSync();

    expect(result.messagesProcessed).toBe(5);
    expect(transport.listMessages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pageToken: "token-2" }),
    );

    const emailIds = (sqlite.prepare("SELECT id FROM emails ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id);
    const state = sqlite
      .prepare("SELECT full_sync_cursor, full_sync_processed, full_sync_total, history_id, total_messages FROM sync_state WHERE id = 1")
      .get() as {
      full_sync_cursor: string | null;
      full_sync_processed: number;
      full_sync_total: number;
      history_id: string | null;
      total_messages: number;
    };

    expect(emailIds).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
    expect(state).toEqual({
      full_sync_cursor: null,
      full_sync_processed: 0,
      full_sync_total: 0,
      history_id: "999",
      total_messages: 5,
    });
  });
});

describe("incrementalSync", () => {
  it("falls back to fullSync when no historyId is stored", async () => {
    const transport = createMockTransport({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "msg-1" }],
        resultSizeEstimate: 1,
      }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "200",
        messagesTotal: 1,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("msg-1")]);

    const result = await incrementalSync();

    expect(result.mode).toBe("full");
    expect(transport.listHistory).not.toHaveBeenCalled();
  });

  it("applies history changes: upserts added messages, removes deleted ones", async () => {
    // Seed an existing email and history state
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare(`
      INSERT INTO emails (id, thread_id, from_address, from_name, to_addresses, subject, snippet, date, is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at)
      VALUES ('old-1', 'thread-old-1', 'a@b.com', 'A', '[]', 'Old', 'old', 1000, 1, 0, '[]', 100, 0, null, ${Date.now()})
    `).run();
    sqlite
      .prepare("UPDATE sync_state SET account_email = 'user@example.com', history_id = '500' WHERE id = 1")
      .run();

    const transport = createMockTransport({
      listHistory: vi.fn().mockResolvedValue({
        history: [
          { messagesAdded: [{ message: { id: "new-1" } }] },
          { messagesDeleted: [{ message: { id: "old-1" } }] },
        ],
        historyId: "600",
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("new-1")]);

    const result = await incrementalSync();

    expect(result.mode).toBe("incremental");
    expect(result.usedHistoryFallback).toBe(false);
    expect(result.historyId).toBe("600");

    const ids = (sqlite.prepare("SELECT id FROM emails").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toContain("new-1");
    expect(ids).not.toContain("old-1");
  });

  it("S10: stale historyId (404) falls back to fullSync and sets usedHistoryFallback=true", async () => {
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare("UPDATE sync_state SET history_id = '123' WHERE id = 1").run();

    const staleError = Object.assign(new Error("Requested entity was not found."), {
      code: 404,
      status: 404,
    });

    const transport = createMockTransport({
      listHistory: vi.fn().mockRejectedValue(staleError),
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "msg-a" }],
        resultSizeEstimate: 1,
      }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "999",
        messagesTotal: 1,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("msg-a")]);

    const result = await incrementalSync();

    expect(result.mode).toBe("full");
    expect(result.usedHistoryFallback).toBe(true);
    expect(transport.listHistory).toHaveBeenCalledTimes(1);
    expect(transport.listMessages).toHaveBeenCalled();
  });

  it("processes labelsAdded and labelsRemoved history entries", async () => {
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare("UPDATE sync_state SET history_id = '500' WHERE id = 1").run();

    const transport = createMockTransport({
      listHistory: vi.fn().mockResolvedValue({
        history: [
          { labelsAdded: [{ message: { id: "msg-la" } }] },
          { labelsRemoved: [{ message: { id: "msg-lr" } }] },
        ],
        historyId: "600",
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([
      makeEmailMessage("msg-la"),
      makeEmailMessage("msg-lr"),
    ]);

    const result = await incrementalSync();

    expect(result.mode).toBe("incremental");
    expect(batchGetMessages).toHaveBeenCalledWith(
      expect.arrayContaining(["msg-la", "msg-lr"]),
      expect.any(Function),
    );
  });

  it("re-throws non-404 errors from listHistory", async () => {
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare("UPDATE sync_state SET history_id = '123' WHERE id = 1").run();

    const serverError = Object.assign(new Error("Internal Server Error"), {
      code: 500,
      status: 500,
    });

    const transport = createMockTransport({
      listHistory: vi.fn().mockRejectedValue(serverError),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);

    await expect(incrementalSync()).rejects.toThrow("Internal Server Error");
  });

  it("clears cached data when syncing a different authenticated Gmail account", async () => {
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare(`
      INSERT INTO emails (id, thread_id, from_address, from_name, to_addresses, subject, snippet, date, is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at)
      VALUES ('old-1', 'thread-old-1', 'old@example.com', 'Old', '[]', 'Old Subject', 'old', 1000, 1, 0, '[]', 100, 0, null, ${Date.now()})
    `).run();
    sqlite.prepare(`
      INSERT INTO execution_runs (id, source_type, requested_actions, status, created_at)
      VALUES ('run-1', 'manual', '[]', 'applied', ${Date.now()})
    `).run();
    sqlite.prepare(`
      INSERT INTO execution_items (id, run_id, email_id, status, applied_actions, before_label_ids, after_label_ids, executed_at)
      VALUES ('item-1', 'run-1', 'old-1', 'applied', '[]', '[]', '[]', ${Date.now()})
    `).run();
    sqlite.prepare(`
      UPDATE sync_state
      SET account_email = 'old@example.com', history_id = '500', total_messages = 1
      WHERE id = 1
    `).run();

    const transport = createMockTransport({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "new-1" }],
        resultSizeEstimate: 1,
      }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "new@example.com",
        historyId: "900",
        messagesTotal: 1,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("new-1")]);

    await fullSync();

    const emailIds = (sqlite.prepare("SELECT id FROM emails").all() as Array<{ id: string }>).map((row) => row.id);
    const runCount = (sqlite.prepare("SELECT COUNT(*) as count FROM execution_runs").get() as { count: number }).count;
    const state = sqlite
      .prepare("SELECT account_email, history_id, total_messages FROM sync_state WHERE id = 1")
      .get() as { account_email: string; history_id: string; total_messages: number };

    expect(emailIds).toEqual(["new-1"]);
    expect(runCount).toBe(0);
    expect(state.account_email).toBe("new@example.com");
    expect(state.history_id).toBe("900");
    expect(state.total_messages).toBe(1);
  });
});

describe("getSyncStatus", () => {
  it("returns null/zero values when no sync has been run", async () => {
    const status = await getSyncStatus();
    expect(status.historyId).toBeNull();
    expect(status.lastFullSync).toBeNull();
    expect(status.lastIncrementalSync).toBeNull();
    expect(status.totalMessages).toBe(0);
  });

  it("reflects updated sync state after fullSync", async () => {
    const transport = createMockTransport({
      listMessages: vi.fn().mockResolvedValue({ messages: [{ id: "msg-1" }], resultSizeEstimate: 1 }),
      getProfile: vi.fn().mockResolvedValue({
        emailAddress: "user@example.com",
        historyId: "777",
        messagesTotal: 1,
      }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("msg-1")]);

    await fullSync();
    const status = await getSyncStatus();

    expect(status.accountEmail).toBe("user@example.com");
    expect(status.historyId).toBe("777");
    expect(status.lastFullSync).toBeGreaterThan(0);
    expect(status.totalMessages).toBe(1);
  });
});

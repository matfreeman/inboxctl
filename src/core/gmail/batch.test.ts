import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import { getRecentRuns, getRunItems } from "../actions/audit.js";
import { undoRun } from "../actions/undo.js";
import { initializeDb, getSqlite } from "../db/client.js";
import { setGmailTransportOverride, clearGmailTransportOverride, type GmailTransport } from "./transport.js";
import { batchApplyActions } from "./batch.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

function insertEmails(emails: ReturnType<typeof createTestEmail>[]) {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  const insert = sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = sqlite.transaction((rows: ReturnType<typeof createTestEmail>[]) => {
    for (const email of rows) {
      insert.run(
        email.id,
        email.threadId,
        email.fromAddress,
        email.fromName,
        JSON.stringify(email.toAddresses),
        email.subject,
        email.snippet,
        email.date,
        email.isRead ? 1 : 0,
        email.isStarred ? 1 : 0,
        JSON.stringify(email.labelIds),
        email.sizeEstimate,
        email.hasAttachments ? 1 : 0,
        email.listUnsubscribe,
        Date.now(),
      );
    }
  });

  transaction(emails);
}

function readLabels(emailId: string) {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  const row = sqlite
    .prepare("SELECT label_ids, is_read FROM emails WHERE id = ?")
    .get(emailId) as { label_ids: string; is_read: number } | undefined;

  if (!row) {
    throw new Error(`Missing email: ${emailId}`);
  }

  return {
    labelIds: JSON.parse(row.label_ids) as string[],
    isRead: row.is_read === 1,
  };
}

function createTransport(initialLabels: Array<{ id: string; name: string; type?: "system" | "user" }> = []): GmailTransport {
  const labels = new Map(
    initialLabels.map((label) => [
      label.id,
      {
        id: label.id,
        name: label.name,
        type: label.type ?? "user",
        messagesTotal: 0,
        messagesUnread: 0,
        threadsTotal: 0,
        threadsUnread: 0,
      },
    ]),
  );

  return {
    kind: "rest",
    getProfile: vi.fn(async () => ({
      emailAddress: "user@example.com",
      historyId: "1",
      messagesTotal: 3,
      threadsTotal: 3,
    })),
    listLabels: vi.fn(async () => ({
      labels: [...labels.values()],
    })),
    getLabel: vi.fn(async (id: string) => {
      const label = labels.get(id);

      if (!label) {
        throw new Error(`Unknown label: ${id}`);
      }

      return label;
    }),
    createLabel: vi.fn(async (input: { name: string }) => {
      const existing = [...labels.values()].find(
        (label) => label.name.toLowerCase() === input.name.toLowerCase(),
      );

      if (existing) {
        return existing;
      }

      const id = `Label_${input.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
      const created = {
        id,
        name: input.name,
        type: "user" as const,
        messagesTotal: 0,
        messagesUnread: 0,
        threadsTotal: 0,
        threadsUnread: 0,
      };
      labels.set(id, created);
      return created;
    }),
    deleteLabel: vi.fn(async (id: string) => {
      if (!labels.delete(id)) {
        throw new Error(`Unknown label: ${id}`);
      }
    }),
    batchModifyMessages: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ id: "sent-1", threadId: "thread-sent", labelIds: ["SENT"] })),
    listMessages: vi.fn(async () => ({ messages: [], resultSizeEstimate: 0 })),
    getMessage: vi.fn(async ({ id }: { id: string }) => ({
      id,
      threadId: `thread-${id}`,
      snippet: `Snippet for ${id}`,
      internalDate: String(Date.now()),
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "user@example.com" },
          { name: "Subject", value: `Subject ${id}` },
          { name: "Date", value: "Wed, 1 Apr 2026 10:00:00 +0000" },
        ],
      },
    })),
    getThread: vi.fn(async (id: string) => ({ id, messages: [] })),
    listHistory: vi.fn(async () => ({ history: [], historyId: "2" })),
    listFilters: vi.fn(async () => ({ filter: [] })),
    getFilter: vi.fn(async () => ({ id: "filter-1" })),
    createFilter: vi.fn(async () => ({ id: "filter-1" })),
    deleteFilter: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-batch-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);
});

afterEach(async () => {
  if (tempDir) {
    clearGmailTransportOverride(tempDir);
  }

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

describe("batchApplyActions", () => {
  it("applies grouped actions in one audited run and supports undo", async () => {
    insertEmails([
      createTestEmail({ id: "msg-1", labelIds: ["INBOX", "UNREAD"], isRead: false }),
      createTestEmail({ id: "msg-2", labelIds: ["INBOX", "UNREAD"], isRead: false }),
      createTestEmail({ id: "msg-3", labelIds: ["INBOX"], isRead: true }),
    ]);

    const config = loadConfig();
    const transport = createTransport([
      { id: "Label_RECEIPTS", name: "Receipts" },
    ]);
    setGmailTransportOverride(config.dataDir, transport);

    const result = await batchApplyActions({
      groups: [
        {
          emailIds: ["msg-1", "msg-2"],
          actions: [{ type: "label", label: "Receipts" }, { type: "mark_read" }],
        },
        {
          emailIds: ["msg-3"],
          actions: [{ type: "archive" }],
        },
      ],
      config,
      transport,
    });

    expect(result.runId).toBeTruthy();
    expect(result.groups).toEqual([
      {
        emailCount: 2,
        actionsApplied: ["label:Receipts", "mark_read"],
        status: "applied",
      },
      {
        emailCount: 1,
        actionsApplied: ["archive"],
        status: "applied",
      },
    ]);
    expect(result.totalEmailsAffected).toBe(3);
    expect(result.undoAvailable).toBe(true);

    const runs = await getRecentRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("applied");
    expect(runs[0]?.itemCount).toBe(3);

    const items = await getRunItems(result.runId as string);
    expect(items).toHaveLength(3);
    expect(items.find((item) => item.emailId === "msg-1")?.appliedActions).toEqual([
      { type: "label", label: "Receipts" },
      { type: "mark_read" },
    ]);

    expect(readLabels("msg-1")).toEqual({
      labelIds: ["INBOX", "Label_RECEIPTS"],
      isRead: true,
    });
    expect(readLabels("msg-3")).toEqual({
      labelIds: [],
      isRead: true,
    });

    const undoResult = await undoRun(result.runId as string);
    expect(undoResult.status).toBe("undone");
    expect(readLabels("msg-1")).toEqual({
      labelIds: ["INBOX", "UNREAD"],
      isRead: false,
    });
    expect(readLabels("msg-3")).toEqual({
      labelIds: ["INBOX"],
      isRead: true,
    });
  });

  it("returns a dry-run plan without mutating or auditing", async () => {
    insertEmails([
      createTestEmail({ id: "msg-1", labelIds: ["INBOX", "UNREAD"], isRead: false }),
    ]);

    const config = loadConfig();
    const transport = createTransport();

    const result = await batchApplyActions({
      groups: [
        {
          emailIds: ["msg-1"],
          actions: [{ type: "label", label: "Receipts" }, { type: "mark_read" }],
        },
      ],
      dryRun: true,
      config,
      transport,
    });

    expect(result).toEqual({
      runId: null,
      dryRun: true,
      groups: [
        {
          emailCount: 1,
          actionsApplied: ["label:Receipts", "mark_read"],
          status: "planned",
        },
      ],
      totalEmailsAffected: 1,
      undoAvailable: false,
    });
    expect(transport.batchModifyMessages).not.toHaveBeenCalled();
    expect(transport.createLabel).not.toHaveBeenCalled();
    expect(await getRecentRuns(10)).toEqual([]);
    expect(readLabels("msg-1")).toEqual({
      labelIds: ["INBOX", "UNREAD"],
      isRead: false,
    });
  });

  it("auto-creates missing labels before applying label actions", async () => {
    insertEmails([
      createTestEmail({ id: "msg-1", labelIds: ["INBOX"], isRead: true }),
    ]);

    const config = loadConfig();
    const transport = createTransport();

    await batchApplyActions({
      groups: [
        {
          emailIds: ["msg-1"],
          actions: [{ type: "label", label: "Finance" }],
        },
      ],
      config,
      transport,
    });

    expect(transport.createLabel).toHaveBeenCalledWith({
      name: "Finance",
      color: undefined,
    });
    expect(readLabels("msg-1")).toEqual({
      labelIds: ["INBOX", "Label_FINANCE"],
      isRead: true,
    });
  });

  it("validates group limits, action limits, and overlapping email ids", async () => {
    const config = loadConfig();
    const transport = createTransport();

    await expect(
      batchApplyActions({
        groups: Array.from({ length: 21 }, (_value, index) => ({
          emailIds: [`msg-${index}`],
          actions: [{ type: "archive" as const }],
        })),
        config,
        transport,
      }),
    ).rejects.toThrow(/at most 20 groups/i);

    await expect(
      batchApplyActions({
        groups: [
          {
            emailIds: Array.from({ length: 501 }, (_value, index) => `msg-${index}`),
            actions: [{ type: "archive" as const }],
          },
        ],
        config,
        transport,
      }),
    ).rejects.toThrow(/at most 500 email ids/i);

    await expect(
      batchApplyActions({
        groups: [
          {
            emailIds: ["msg-1"],
            actions: [
              { type: "archive" as const },
              { type: "mark_read" as const },
              { type: "mark_spam" as const },
              { type: "label" as const, label: "One" },
              { type: "label" as const, label: "Two" },
              { type: "label" as const, label: "Three" },
            ],
          },
        ],
        config,
        transport,
      }),
    ).rejects.toThrow(/at most 5 actions/i);

    await expect(
      batchApplyActions({
        groups: [
          {
            emailIds: ["msg-1"],
            actions: [{ type: "archive" as const }],
          },
          {
            emailIds: ["msg-1"],
            actions: [{ type: "mark_read" as const }],
          },
        ],
        config,
        transport,
      }),
    ).rejects.toThrow(/appears in more than one group/i);
  });
});

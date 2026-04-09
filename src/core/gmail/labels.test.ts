import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { cleanupEmptyLabels, createLabel, getLabelId, listLabels, syncLabels } from "./labels.js";
import type { GmailTransport } from "./transport.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makeConfig(): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-labels-"));
  tempDirs.push(dataDir);

  return {
    dataDir,
    dbPath: join(dataDir, "emails.db"),
    rulesDir: join(dataDir, "rules"),
    tokensPath: join(dataDir, "tokens.json"),
    google: {
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1:3456/callback",
    },
    sync: {
      pageSize: 500,
      maxMessages: null,
    },
  };
}

function makeTransport(overrides: Partial<GmailTransport> = {}): GmailTransport {
  const getProfile = vi.fn(async () => ({
    emailAddress: "user@example.com",
    historyId: "1",
    messagesTotal: 1,
    threadsTotal: 1,
  }));
  const listLabels = vi.fn(async () => ({
    labels: [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_123", name: "Receipts", type: "user" },
    ],
  }));
  const getLabel = vi.fn(async (id: string) => ({
    id,
    name: id === "Label_123" ? "Receipts" : id,
    type: id === "Label_123" ? "user" : "system",
    messagesTotal: id === "Label_123" ? 7 : 42,
    messagesUnread: id === "Label_123" ? 2 : 12,
    threadsTotal: 0,
    threadsUnread: 0,
  }));
  const createLabel = vi.fn(async (input) => ({
    id: "Label_NEW",
    name: input.name,
    type: "user",
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
  }));
  const deleteLabel = vi.fn(async () => undefined);
  const batchModifyMessages = vi.fn(async () => undefined);
  const modifyMessage = vi.fn(async () => ({ id: "msg-1", labelIds: ["INBOX"] }));
  const sendMessage = vi.fn(async () => ({ id: "sent-1" }));
  const listMessages = vi.fn(async () => ({ messages: [] }));
  const getMessage = vi.fn(async () => ({ id: "msg-1" }));
  const getThread = vi.fn(async () => ({ id: "thread-1", messages: [] }));
  const listHistory = vi.fn(async () => ({ history: [] }));

  return {
    kind: "rest",
    getProfile,
    listLabels,
    getLabel,
    createLabel,
    deleteLabel,
    batchModifyMessages,
    modifyMessage,
    sendMessage,
    listMessages,
    getMessage,
    getThread,
    listHistory,
    ...overrides,
  } as unknown as GmailTransport;
}

function insertEmail(config: Config, id: string, labelIds: string[]): void {
  const sqlite = getSqlite(config.dbPath);
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
      `thread-${id}`,
      "sender@example.com",
      "Sender",
      JSON.stringify(["user@example.com"]),
      "Subject",
      "Snippet",
      Date.now(),
      labelIds.includes("UNREAD") ? 0 : 1,
      0,
      JSON.stringify(labelIds),
      1024,
      0,
      null,
      Date.now(),
    );
}

describe("gmail labels", () => {
  it("refreshes labels with counts and resolves names case-insensitively", async () => {
    const config = makeConfig();
    const transport = makeTransport();

    const labels = await listLabels({ config, transport });

    expect(labels).toHaveLength(2);
    expect(labels[0]?.id).toBe("INBOX");
    expect(labels[1]?.messagesTotal).toBe(7);
    expect(transport.listLabels).toHaveBeenCalledTimes(1);
    expect(transport.getLabel).toHaveBeenCalledWith("INBOX");
    expect(transport.getLabel).toHaveBeenCalledWith("Label_123");

    await syncLabels({ config, transport });
    expect(await getLabelId("receipts", { config, transport })).toBe("Label_123");
    expect(await getLabelId("Inbox", { config, transport })).toBe("INBOX");
  });

  it("creates a new user label and caches the result", async () => {
    const config = makeConfig();
    const transport = makeTransport({
      listLabels: vi.fn(async () => ({ labels: [] })),
      getLabel: vi.fn(async (id: string) => ({
        id,
        name: "Receipts",
        type: "user",
        messagesTotal: 0,
        messagesUnread: 0,
        threadsTotal: 0,
        threadsUnread: 0,
      })),
    });

    const created = await createLabel("Receipts", undefined, { config, transport });

    expect(created.id).toBe("Label_NEW");
    expect(transport.createLabel).toHaveBeenCalledWith({
      name: "Receipts",
      color: undefined,
    });
    expect(await getLabelId("receipts", { config, transport })).toBe("Label_NEW");
  });

  it("deletes empty inboxctl-managed labels and skips non-empty or unmanaged ones", async () => {
    const config = makeConfig();
    const transport = makeTransport({
      listLabels: vi.fn(async () => ({
        labels: [
          { id: "Label_EMPTY", name: "inboxctl/Empty", type: "user" },
          { id: "Label_USED", name: "inboxctl/Used", type: "user" },
          { id: "Label_OTHER", name: "Receipts", type: "user" },
        ],
      })),
      getLabel: vi.fn(async (id: string) => ({
        id,
        name:
          id === "Label_EMPTY"
            ? "inboxctl/Empty"
            : id === "Label_USED"
              ? "inboxctl/Used"
              : "Receipts",
        type: "user",
        messagesTotal: 0,
        messagesUnread: 0,
        threadsTotal: 0,
        threadsUnread: 0,
      })),
    });

    insertEmail(config, "msg-1", ["INBOX", "Label_USED"]);

    const result = await cleanupEmptyLabels({ config, transport });

    expect(result).toEqual({
      deletedLabels: ["inboxctl/Empty"],
      skippedLabels: ["inboxctl/Used", "Receipts"],
      dryRun: false,
    });
    expect(transport.deleteLabel).toHaveBeenCalledTimes(1);
    expect(transport.deleteLabel).toHaveBeenCalledWith("Label_EMPTY");
  });

  it("supports dry run label cleanup", async () => {
    const config = makeConfig();
    const transport = makeTransport({
      listLabels: vi.fn(async () => ({
        labels: [{ id: "Label_EMPTY", name: "inboxctl/Empty", type: "user" }],
      })),
      getLabel: vi.fn(async () => ({
        id: "Label_EMPTY",
        name: "inboxctl/Empty",
        type: "user",
        messagesTotal: 0,
        messagesUnread: 0,
        threadsTotal: 0,
        threadsUnread: 0,
      })),
    });

    const result = await cleanupEmptyLabels({ config, transport, dryRun: true });

    expect(result).toEqual({
      deletedLabels: ["inboxctl/Empty"],
      skippedLabels: [],
      dryRun: true,
    });
    expect(transport.deleteLabel).not.toHaveBeenCalled();
  });
});

import type { gmail_v1 } from "@googleapis/gmail";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { archiveEmails, labelEmails, markRead, markSpam, markUnread, forwardEmail, unmarkSpam } from "./modify.js";
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
  const dataDir = mkdtempSync(join(tmpdir(), "inboxctl-modify-"));
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
      { id: "Label_123", name: "Receipts", type: "user" },
    ],
  }));
  const getLabel = vi.fn(async (id: string) => ({
    id,
    name: "Receipts",
    type: "user",
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
  }));
  const createLabel = vi.fn(async () => ({
    id: "Label_123",
    name: "Receipts",
    type: "user",
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
  }));
  const batchModifyMessages = vi.fn(async () => undefined);
  const modifyMessage = vi.fn(async (input: { id: string; addLabelIds?: string[]; removeLabelIds?: string[] }) => ({
    id: input.id,
    threadId: `${input.id}-thread`,
    labelIds: [
      ...(input.addLabelIds || []),
    ],
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "user@example.com" },
        { name: "Subject", value: "Subject" },
        { name: "Date", value: "Wed, 1 Apr 2026 10:00:00 +0000" },
      ],
    },
  }));
  const sendMessage = vi.fn(async () => ({ id: "sent-1", threadId: "thread-sent" }));
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

function seedEmail(config: Config, row: {
  id: string;
  labelIds: string[];
  isRead?: boolean;
  subject?: string;
}): void {
  const sqlite = getSqlite(config.dbPath);
  sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (
      @id, @thread_id, @from_address, @from_name, @to_addresses, @subject, @snippet, @date,
      @is_read, @is_starred, @label_ids, @size_estimate, @has_attachments, @list_unsubscribe, @synced_at
    )
  `).run({
    id: row.id,
    thread_id: `${row.id}-thread`,
    from_address: "sender@example.com",
    from_name: "Sender",
    to_addresses: JSON.stringify(["user@example.com"]),
    subject: row.subject || "Subject",
    snippet: "Snippet",
    date: 1_710_000_000_000,
    is_read: row.isRead ? 1 : 0,
    is_starred: 0,
    label_ids: JSON.stringify(row.labelIds),
    size_estimate: 100,
    has_attachments: 0,
    list_unsubscribe: null,
    synced_at: Date.now(),
  });
}

function readLabels(config: Config, id: string): { labelIds: string[]; isRead: boolean } {
  const sqlite = getSqlite(config.dbPath);
  const row = sqlite
    .prepare(`SELECT label_ids, is_read FROM emails WHERE id = ?`)
    .get(id) as { label_ids: string; is_read: number } | undefined;

  if (!row) {
    throw new Error(`Missing row ${id}`);
  }

  return {
    labelIds: JSON.parse(row.label_ids) as string[],
    isRead: row.is_read === 1,
  };
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function createForwardMessage(): gmail_v1.Schema$Message {
  const body = Buffer.from("Hello from the original message", "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return {
    id: "msg-forward",
    threadId: "thread-forward",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      headers: [
        { name: "From", value: "Alice Example <alice@example.com>" },
        { name: "To", value: "user@example.com" },
        { name: "Subject", value: "Project update" },
        { name: "Date", value: "Wed, 1 Apr 2026 10:00:00 +0000" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: body,
          },
        },
      ],
    },
  };
}

describe("gmail modify", () => {
  it("archives multiple emails in a batch and updates the cache", async () => {
    const config = makeConfig();
    const transport = makeTransport();
    seedEmail(config, { id: "msg-1", labelIds: ["INBOX", "UNREAD"] });
    seedEmail(config, { id: "msg-2", labelIds: ["INBOX"] });

    const result = await archiveEmails(["msg-1", "msg-2"], { config, transport });

    expect(result.action).toBe("archive");
    expect(result.affectedCount).toBe(2);
    expect(transport.batchModifyMessages).toHaveBeenCalledTimes(1);
    expect(transport.batchModifyMessages).toHaveBeenCalledWith({
      ids: ["msg-1", "msg-2"],
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });
    expect(readLabels(config, "msg-1")).toEqual({
      labelIds: ["UNREAD"],
      isRead: false,
    });
    expect(readLabels(config, "msg-2")).toEqual({
      labelIds: [],
      isRead: true,
    });
  });

  it("resolves labels by name and applies them to the local cache", async () => {
    const config = makeConfig();
    const transport = makeTransport();
    seedEmail(config, { id: "msg-3", labelIds: ["INBOX"] });

    const result = await labelEmails(["msg-3"], "receipts", { config, transport });

    expect(result.action).toBe("label");
    expect(result.labelId).toBe("Label_123");
    expect(transport.batchModifyMessages).toHaveBeenCalledWith({
      ids: ["msg-3"],
      addLabelIds: ["Label_123"],
      removeLabelIds: [],
    });
    expect(readLabels(config, "msg-3")).toEqual({
      labelIds: ["INBOX", "Label_123"],
      isRead: true,
    });
  });

  it.each([
    ["mark_read", markRead, ["INBOX", "UNREAD"], ["INBOX"], true, false],
    ["mark_unread", markUnread, ["INBOX"], ["INBOX", "UNREAD"], false, false],
    ["mark_spam", markSpam, ["INBOX", "UNREAD"], ["UNREAD", "SPAM"], false, false],
    ["unmark_spam", unmarkSpam, ["SPAM"], ["INBOX"], true, false],
  ] as const)(
    "applies %s changes and keeps read state aligned",
    async (_name, fn, initialLabels, expectedLabels, expectedRead, nonReversible) => {
      const config = makeConfig();
      const transport = makeTransport();
      seedEmail(config, { id: "msg-4", labelIds: [...initialLabels], isRead: initialLabels.includes("UNREAD") ? false : true });

      const result = await fn(["msg-4"], { config, transport });

      expect(result.nonReversible).toBe(nonReversible);
      expect(result.items[0]?.afterLabelIds).toEqual(expectedLabels);
      expect(readLabels(config, "msg-4")).toEqual({
        labelIds: expectedLabels,
        isRead: expectedRead,
      });
    },
  );

  it("forwards a message with a raw MIME payload", async () => {
    const config = makeConfig();
    const transport = makeTransport({
      getMessage: vi.fn(async () => createForwardMessage()),
      sendMessage: vi.fn(async () => ({ id: "sent-99", threadId: "thread-forward" })),
    });

    const result = await forwardEmail("msg-forward", "recipient@example.com", {
      config,
      transport,
    });

    expect(result.action).toBe("forward");
    expect(result.nonReversible).toBe(true);
    expect(result.sentMessageId).toBe("sent-99");

    const sendMessage = transport.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const firstArg = sendMessage.mock.calls[0]?.[0] as { raw?: string } | string | undefined;
    const raw = typeof firstArg === "string" ? firstArg : firstArg?.raw;
    expect(raw).toBeTruthy();
    const decoded = decodeBase64Url(raw as string);
    expect(decoded).toContain("To: recipient@example.com");
    expect(decoded).toContain("Subject: Fwd: Project update");
    expect(decoded).toContain("Forwarded message");
    expect(decoded).toContain("Hello from the original message");
  });
});

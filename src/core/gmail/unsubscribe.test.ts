import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import { undoRun } from "../actions/undo.js";
import { initializeDb, getSqlite } from "../db/client.js";
import {
  clearGmailTransportOverride,
  setGmailTransportOverride,
  type GmailTransport,
} from "./transport.js";
import { unsubscribe } from "./unsubscribe.js";

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
    .prepare("SELECT label_ids FROM emails WHERE id = ?")
    .get(emailId) as { label_ids: string } | undefined;

  if (!row) {
    throw new Error(`Missing email: ${emailId}`);
  }

  return JSON.parse(row.label_ids) as string[];
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
      messagesTotal: 2,
      threadsTotal: 2,
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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-unsubscribe-"));
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

describe("unsubscribe", () => {
  it("returns the unsubscribe target without mutating when cleanup is not requested", async () => {
    insertEmails([
      createTestEmail({
        id: "msg-1",
        fromAddress: "promo@example.com",
        fromName: "Promo",
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
        listUnsubscribe: "<mailto:unsubscribe@example.com>, <https://example.com/unsubscribe>",
      }),
    ]);

    const result = await unsubscribe({
      senderEmail: "promo@example.com",
    });

    expect(result).toMatchObject({
      sender: "promo@example.com",
      unsubscribeLink: "https://example.com/unsubscribe",
      unsubscribeMethod: "both",
      messageCount: 1,
      archivedCount: 0,
      labeledCount: 0,
    });
    expect(result.runId).toBeUndefined();
    expect(readLabels("msg-1")).toEqual(["INBOX", "UNREAD"]);
  });

  it("labels and archives existing emails in one undoable run", async () => {
    insertEmails([
      createTestEmail({
        id: "msg-1",
        fromAddress: "cleanup@example.com",
        fromName: "Cleanup",
        isRead: true,
        labelIds: ["INBOX"],
        listUnsubscribe: "<https://cleanup.example.com/unsubscribe>",
      }),
      createTestEmail({
        id: "msg-2",
        fromAddress: "cleanup@example.com",
        fromName: "Cleanup",
        isRead: true,
        labelIds: ["INBOX"],
        listUnsubscribe: "<https://cleanup.example.com/unsubscribe>",
      }),
    ]);

    const config = loadConfig();
    const transport = createTransport();
    setGmailTransportOverride(config.dataDir, transport);

    const result = await unsubscribe({
      senderEmail: "cleanup@example.com",
      alsoLabel: "Unsubscribed",
      alsoArchive: true,
      config,
      transport,
    });

    expect(result).toMatchObject({
      sender: "cleanup@example.com",
      unsubscribeLink: "https://cleanup.example.com/unsubscribe",
      unsubscribeMethod: "link",
      messageCount: 2,
      archivedCount: 2,
      labeledCount: 2,
      undoAvailable: true,
    });
    expect(result.runId).toBeTruthy();
    expect(readLabels("msg-1")).toEqual(["Label_UNSUBSCRIBED"]);
    expect(readLabels("msg-2")).toEqual(["Label_UNSUBSCRIBED"]);

    const undoResult = await undoRun(result.runId as string);
    expect(undoResult.status).toBe("undone");
    expect(readLabels("msg-1")).toEqual(["INBOX"]);
    expect(readLabels("msg-2")).toEqual(["INBOX"]);
  });

  it("throws helpful errors for missing senders or missing unsubscribe links", async () => {
    insertEmails([
      createTestEmail({
        id: "msg-1",
        fromAddress: "no-link@example.com",
        fromName: "No Link",
        listUnsubscribe: null,
      }),
    ]);

    await expect(
      unsubscribe({
        senderEmail: "missing@example.com",
      }),
    ).rejects.toThrow("No emails found from missing@example.com");

    await expect(
      unsubscribe({
        senderEmail: "no-link@example.com",
      }),
    ).rejects.toThrow(
      "No unsubscribe link found for no-link@example.com. This sender does not include List-Unsubscribe headers.",
    );
  });
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { createLabel, getLabelId, listLabels, syncLabels } from "./labels.js";
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
});

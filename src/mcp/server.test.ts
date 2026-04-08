import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../__tests__/helpers/test-db.js";
import { initializeDb, getSqlite } from "../core/db/client.js";
import {
  createMcpServer,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_TOOLS,
} from "./server.js";
import type { EmailMessage } from "../core/gmail/types.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

function seedEmails(emails: EmailMessage[]): void {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  const insert = sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = sqlite.transaction((rows: EmailMessage[]) => {
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-mcp-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);

  seedEmails([
    createTestEmail({
      id: "msg-1",
      fromAddress: "newsletter@example.com",
      fromName: "Newsletter",
      subject: "Weekly digest",
      isRead: false,
      isStarred: true,
      labelIds: ["INBOX", "UNREAD", "STARRED"],
      listUnsubscribe: "<https://example.com/unsubscribe>",
    }),
    createTestEmail({
      id: "msg-2",
      fromAddress: "boss@example.com",
      fromName: "Boss",
      subject: "Need this today",
      isRead: true,
      labelIds: ["INBOX"],
      date: Date.now() - 2 * 60 * 60 * 1000,
    }),
  ]);
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

describe("createMcpServer", () => {
  it("returns the MCP contract", async () => {
    const { contract, server } = await createMcpServer();

    expect(contract.transport).toBe("stdio");
    expect(contract.ready).toBe(true);
    expect(contract.tools).toEqual(MCP_TOOLS);
    expect(contract.resources).toEqual(MCP_RESOURCES);
    expect(contract.prompts).toEqual(MCP_PROMPTS);
    expect(contract.warnings.length).toBeGreaterThan(0);
    expect(server).toBeDefined();
  });

  it("registers working cached stats tools, resources, and prompts", async () => {
    const { server } = await createMcpServer();
    const internals = server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: { result?: unknown } }> }>;
      _registeredResources: Record<string, { readCallback: (uri: string) => Promise<{ contents: Array<{ text: string }> }> }>;
      _registeredPrompts: Record<string, { callback: () => Promise<{ messages: Array<{ content: { text: string } }> }> }>;
    };

    const statsResult = await internals._registeredTools.get_inbox_stats.handler({});
    const summaryResource = await internals._registeredResources["inbox://summary"].readCallback("inbox://summary");
    const prompt = await internals._registeredPrompts["summarize-inbox"].callback();

    expect(internals._registeredTools.get_newsletter_senders).toBeDefined();
    expect(internals._registeredResources["stats://overview"]).toBeDefined();
    expect(internals._registeredPrompts["triage-inbox"]).toBeDefined();

    expect((statsResult.structuredContent?.result as { total: number }).total).toBe(2);
    expect(summaryResource.contents[0]?.text).toContain("\"unread\": 1");
    expect(prompt.messages[0]?.content.text).toContain("inbox://summary");
  });
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../__tests__/helpers/test-db.js";
import { initializeDb, getSqlite } from "../core/db/client.js";
import { appendExecutionItem, createExecutionRun } from "../core/actions/audit.js";
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
    const markReadRun = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "mark_read" }],
      status: "applied",
    });
    await appendExecutionItem(markReadRun.id, {
      emailId: "msg-1",
      status: "applied",
      appliedActions: [{ type: "mark_read" }],
      beforeLabelIds: ["INBOX", "UNREAD", "STARRED"],
      afterLabelIds: ["INBOX", "STARRED"],
    });
    const reviewRun = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Newsletters" }, { type: "archive" }],
      status: "applied",
    });
    await appendExecutionItem(reviewRun.id, {
      emailId: "msg-2",
      status: "applied",
      appliedActions: [{ type: "label", label: "Newsletters" }, { type: "archive" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["Newsletters"],
    });

    const { server } = await createMcpServer();
    const internals = server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: { result?: unknown } }> }>;
      _registeredResources: Record<string, { readCallback: (uri: string) => Promise<{ contents: Array<{ text: string }> }> }>;
      _registeredPrompts: Record<string, { callback: () => Promise<{ messages: Array<{ content: { text: string } }> }> }>;
    };

    const statsResult = await internals._registeredTools.get_inbox_stats.handler({});
    const uncategorizedResult = await internals._registeredTools.get_uncategorized_emails.handler({
      unread_only: true,
      limit: 500,
      offset: 0,
    });
    const uncategorizedSendersResult = await internals._registeredTools.get_uncategorized_senders.handler({
      limit: 100,
      offset: 0,
    });
    const reviewCategorizedResult = await internals._registeredTools.review_categorized.handler({});
    const queryEmailsResult = await internals._registeredTools.query_emails.handler({
      filters: {
        has_unsubscribe: true,
      },
      group_by: "sender",
      aggregates: ["count"],
      order_by: "sender asc",
    });
    const noiseResult = await internals._registeredTools.get_noise_senders.handler({
      min_noise_score: 1,
      sort_by: "all_time_noise_score",
    });
    const unsubscribeSuggestionsResult = await internals._registeredTools.get_unsubscribe_suggestions.handler({
      min_messages: 1,
    });
    const unsubscribeResult = await internals._registeredTools.unsubscribe.handler({
      sender_email: "newsletter@example.com",
    });
    const batchDryRun = await internals._registeredTools.batch_apply_actions.handler({
      groups: [
        {
          email_ids: ["msg-1"],
          actions: [{ type: "label", label: "Receipts" }, { type: "mark_read" }],
        },
      ],
      dry_run: true,
    });
    const summaryResource = await internals._registeredResources["inbox://summary"].readCallback("inbox://summary");
    const actionLogResource = await internals._registeredResources["inbox://action-log"].readCallback("inbox://action-log");
    const queryFieldsResource = await internals._registeredResources["schema://query-fields"].readCallback("schema://query-fields");
    const prompt = await internals._registeredPrompts["summarize-inbox"].callback();
    const reviewSendersPrompt = await internals._registeredPrompts["review-senders"].callback();
    const triagePrompt = await internals._registeredPrompts["triage-inbox"].callback();
    const suggestRulesPrompt = await internals._registeredPrompts["suggest-rules"].callback();
    const categorizePrompt = await internals._registeredPrompts["categorize-emails"].callback();

    expect(internals._registeredTools.get_newsletter_senders).toBeDefined();
    expect(internals._registeredTools.get_uncategorized_emails).toBeDefined();
    expect(internals._registeredTools.get_uncategorized_senders).toBeDefined();
    expect(internals._registeredTools.review_categorized).toBeDefined();
    expect(internals._registeredTools.query_emails).toBeDefined();
    expect(internals._registeredTools.get_noise_senders).toBeDefined();
    expect(internals._registeredTools.get_unsubscribe_suggestions).toBeDefined();
    expect(internals._registeredTools.unsubscribe).toBeDefined();
    expect(internals._registeredTools.batch_apply_actions).toBeDefined();
    expect(internals._registeredResources["stats://overview"]).toBeDefined();
    expect(internals._registeredResources["inbox://action-log"]).toBeDefined();
    expect(internals._registeredResources["schema://query-fields"]).toBeDefined();
    expect(internals._registeredPrompts["triage-inbox"]).toBeDefined();
    expect(internals._registeredPrompts["categorize-emails"]).toBeDefined();

    expect((statsResult.structuredContent?.result as { total: number }).total).toBe(2);
    expect((uncategorizedResult.structuredContent?.result as { totalUncategorized: number }).totalUncategorized).toBe(1);
    expect((uncategorizedResult.structuredContent?.result as { offset: number; hasMore: boolean }).offset).toBe(0);
    expect((uncategorizedResult.structuredContent?.result as { offset: number; hasMore: boolean }).hasMore).toBe(false);
    expect(
      (uncategorizedResult.structuredContent?.result as {
        emails: Array<{ senderContext: { confidence: string; signals: string[] } }>;
      }).emails[0]?.senderContext,
    ).toMatchObject({
      confidence: "high",
    });
    expect(
      (uncategorizedSendersResult.structuredContent?.result as {
        totalSenders: number;
        senders: Array<{ sender: string; emailIds: string[]; confidence: string }>;
      }),
    ).toMatchObject({
      totalSenders: 2,
    });
    expect(
      (uncategorizedSendersResult.structuredContent?.result as {
        senders: Array<{ sender: string; emailIds: string[]; confidence: string }>;
      }).senders[0],
    ).toMatchObject({
      sender: "newsletter@example.com",
      emailIds: ["msg-1"],
      confidence: "high",
    });
    expect(
      (reviewCategorizedResult.structuredContent?.result as {
        anomalyCount: number;
        anomalies: Array<{ rule: string; severity: string }>;
      }),
    ).toMatchObject({
      anomalyCount: 1,
    });
    expect(
      (reviewCategorizedResult.structuredContent?.result as {
        anomalies: Array<{ rule: string; severity: string }>;
      }).anomalies[0],
    ).toMatchObject({
      rule: "rare_sender_archived",
      severity: "high",
    });
    expect(
      (queryEmailsResult.structuredContent?.result as {
        rows: Array<{ sender: string; count: number }>;
      }).rows,
    ).toEqual([
      { sender: "newsletter@example.com", count: 1 },
    ]);
    expect(
      (noiseResult.structuredContent?.result as {
        senders: Array<{ email: string; allTimeMessageCount: number; unsubscribeLink: string | null }>;
      }).senders[0],
    ).toMatchObject({
      email: "newsletter@example.com",
      allTimeMessageCount: 1,
      unsubscribeLink: "https://example.com/unsubscribe",
    });
    expect(
      (unsubscribeSuggestionsResult.structuredContent?.result as {
        suggestions: Array<{ email: string; unsubscribeMethod: string }>;
      }).suggestions[0],
    ).toMatchObject({
      email: "newsletter@example.com",
      unsubscribeMethod: "link",
    });
    expect(
      (unsubscribeResult.structuredContent?.result as {
        sender: string;
        unsubscribeLink: string;
        unsubscribeMethod: string;
      }),
    ).toMatchObject({
      sender: "newsletter@example.com",
      unsubscribeLink: "https://example.com/unsubscribe",
      unsubscribeMethod: "link",
    });
    expect((batchDryRun.structuredContent?.result as { runId: string | null }).runId).toBeNull();
    expect(summaryResource.contents[0]?.text).toContain("\"unread\": 1");
    expect(actionLogResource.contents[0]?.text).toContain("\"runId\"");
    expect(actionLogResource.contents[0]?.text).toContain("\"undoAvailable\": true");
    expect(queryFieldsResource.contents[0]?.text).toContain("\"group_by\"");
    expect(queryFieldsResource.contents[0]?.text).toContain("\"min_sender_messages\"");
    expect(prompt.messages[0]?.content.text).toContain("inbox://summary");
    expect(reviewSendersPrompt.messages[0]?.content.text).toContain("review_categorized");
    expect(triagePrompt.messages[0]?.content.text).toContain("batch_apply_actions");
    expect(triagePrompt.messages[0]?.content.text).toContain("unsubscribe");
    expect(triagePrompt.messages[0]?.content.text).toContain("confidence: \"low\"");
    expect(suggestRulesPrompt.messages[0]?.content.text).toContain("query_emails");
    expect(suggestRulesPrompt.messages[0]?.content.text).toContain("name: kebab-case-name");
    expect(categorizePrompt.messages[0]?.content.text).toContain("get_uncategorized_senders");
    expect(categorizePrompt.messages[0]?.content.text).toContain("get_uncategorized_emails");
    expect(categorizePrompt.messages[0]?.content.text).toContain("get_unsubscribe_suggestions");
    expect(categorizePrompt.messages[0]?.content.text).toContain("inboxctl/Review");
    expect(categorizePrompt.messages[0]?.content.text).toContain("review_categorized");
  });
});

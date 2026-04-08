import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import { appendExecutionItem, createExecutionRun } from "../actions/audit.js";
import { initializeDb, getSqlite } from "../db/client.js";
import type { EmailMessage } from "../gmail/types.js";
import { reviewCategorized } from "./anomalies.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

function insertEmails(emails: EmailMessage[]) {
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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-anomalies-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);
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

describe("reviewCategorized", () => {
  it("flags archived emails from rare senders as high severity anomalies", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "rare-1",
        fromAddress: "friend@example.com",
        fromName: "Friend",
        subject: "Quick question",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
    ]);

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Important" }, { type: "archive" }],
      status: "applied",
      createdAt: now,
    });

    await appendExecutionItem(run.id, {
      emailId: "rare-1",
      status: "applied",
      appliedActions: [{ type: "label", label: "Important" }, { type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["Important"],
      executedAt: now,
    });

    const result = await reviewCategorized();

    expect(result.totalReviewed).toBe(1);
    expect(result.anomalyCount).toBe(1);
    expect(result.anomalies[0]).toMatchObject({
      emailId: "rare-1",
      severity: "high",
      rule: "rare_sender_archived",
      action: "archive",
      undoAvailable: true,
    });
  });

  it("flags bulk labels without newsletter signals", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "newsletter-maybe-1",
        fromAddress: "jane.doe@company.com",
        fromName: "Jane Doe",
        subject: "Quick question about Friday",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "newsletter-maybe-2",
        fromAddress: "jane.doe@company.com",
        fromName: "Jane Doe",
        subject: "Following up",
        date: now - 60_000,
        isRead: true,
        labelIds: ["INBOX"],
      }),
    ]);

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Newsletters" }],
      status: "applied",
      createdAt: now,
    });

    await appendExecutionItem(run.id, {
      emailId: "newsletter-maybe-1",
      status: "applied",
      appliedActions: [{ type: "label", label: "Newsletters" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["INBOX", "UNREAD", "Newsletters"],
      executedAt: now,
    });

    const result = await reviewCategorized();

    expect(result.anomalyCount).toBe(1);
    expect(result.anomalies[0]).toMatchObject({
      emailId: "newsletter-maybe-1",
      severity: "high",
      rule: "no_newsletter_signals_as_newsletter",
      assignedLabel: "Newsletters",
    });
    expect(result.anomalies[0]?.reason).toContain("no List-Unsubscribe header");
  });

  it("does not flag well-supported newsletter archives", async () => {
    const now = Date.now();

    insertEmails([
      ...Array.from({ length: 5 }, (_value, index) =>
        createTestEmail({
          id: `good-newsletter-${index + 1}`,
          fromAddress: "digest@example.com",
          fromName: "Digest Weekly",
          subject: `Digest ${index + 1}`,
          date: now - index * 60_000,
          isRead: index === 0,
          labelIds: index === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://example.com/unsubscribe>",
        })),
    ]);

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Newsletters" }, { type: "archive" }],
      status: "applied",
      createdAt: now,
    });

    await appendExecutionItem(run.id, {
      emailId: "good-newsletter-1",
      status: "applied",
      appliedActions: [{ type: "label", label: "Newsletters" }, { type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["Newsletters"],
      executedAt: now,
    });

    const result = await reviewCategorized();

    expect(result.totalReviewed).toBe(1);
    expect(result.anomalyCount).toBe(0);
    expect(result.anomalies).toEqual([]);
  });

  it("respects the since filter", async () => {
    const now = Date.now();
    const oldExecutedAt = now - 10 * 24 * 60 * 60 * 1000;

    insertEmails([
      createTestEmail({
        id: "old-item",
        fromAddress: "old@example.com",
        subject: "Old item",
        date: oldExecutedAt,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "new-item",
        fromAddress: "new@example.com",
        subject: "New item",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
    ]);

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      status: "applied",
      createdAt: now,
    });

    await appendExecutionItem(run.id, {
      emailId: "old-item",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: [],
      executedAt: oldExecutedAt,
    });

    await appendExecutionItem(run.id, {
      emailId: "new-item",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: [],
      executedAt: now,
    });

    const result = await reviewCategorized({
      since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(result.totalReviewed).toBe(1);
    expect(result.anomalyCount).toBe(1);
    expect(result.anomalies[0]?.emailId).toBe("new-item");
  });
});

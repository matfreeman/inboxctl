import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import type { EmailMessage } from "../gmail/types.js";
import { initializeDb, getSqlite } from "../db/client.js";
import { getUncategorizedEmails } from "./uncategorized.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-uncategorized-"));
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

describe("getUncategorizedEmails", () => {
  it("filters out emails with user labels and adds confidence signals", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "newsletter-1",
        fromAddress: "newsletter@example.com",
        fromName: "Weekly Digest",
        subject: "Issue #1",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        listUnsubscribe: "<https://example.com/unsubscribe>",
      }),
      createTestEmail({
        id: "newsletter-2",
        fromAddress: "newsletter@example.com",
        fromName: "Weekly Digest",
        subject: "Issue #2",
        date: now - 60_000,
        isRead: true,
        labelIds: ["INBOX"],
        listUnsubscribe: "<https://example.com/unsubscribe>",
      }),
      createTestEmail({
        id: "custom-labeled",
        fromAddress: "boss@example.com",
        fromName: "Boss",
        subject: "Organized already",
        date: now - 120_000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD", "Label_123"],
      }),
      createTestEmail({
        id: "system-only",
        fromAddress: "alerts@example.com",
        fromName: "Alerts",
        subject: "Service alert",
        date: now - 180_000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
      }),
    ]);

    const result = await getUncategorizedEmails({ limit: 10 });

    expect(result.totalUncategorized).toBe(3);
    expect(result.returned).toBe(3);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.emails.map((email) => email.id)).toEqual([
      "newsletter-1",
      "newsletter-2",
      "system-only",
    ]);

    expect(result.emails[0]).toMatchObject({
      id: "newsletter-1",
      from: "newsletter@example.com",
      isRead: false,
      labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    });
    expect(result.emails[0]?.senderContext.totalFromSender).toBe(2);
    expect(result.emails[0]?.senderContext.unreadRate).toBe(50);
    expect(result.emails[0]?.senderContext.isNewsletter).toBe(true);
    expect(result.emails[0]?.senderContext.detectionReason).toContain("list_unsubscribe");
    expect(result.emails[0]?.senderContext.confidence).toBe("high");
    expect(result.emails[0]?.senderContext.signals).toEqual(
      expect.arrayContaining(["list_unsubscribe_header", "newsletter_list_header"]),
    );
    expect(result.emails.every((email) => email.senderContext.signals.length > 0)).toBe(true);
  });

  it("assigns low confidence to rare personal senders and medium to ambiguous automated senders", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "personal-1",
        fromAddress: "jane.doe@example.com",
        fromName: "Jane Doe",
        subject: "Quick question about Friday",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      ...Array.from({ length: 5 }, (_value, index) =>
        createTestEmail({
          id: `updates-${index + 1}`,
          fromAddress: "updates@example.com",
          fromName: "Service Updates",
          subject: `Platform update ${index + 1}`,
          date: now - (index + 1) * 60_000,
          isRead: index === 0,
          labelIds: index === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
        })),
    ]);

    const result = await getUncategorizedEmails({ limit: 10 });
    const personal = result.emails.find((email) => email.id === "personal-1");
    const ambiguous = result.emails.find((email) => email.id === "updates-1");

    expect(personal?.senderContext).toMatchObject({
      confidence: "low",
      totalFromSender: 1,
    });
    expect(personal?.senderContext.signals).toEqual(
      expect.arrayContaining(["rare_sender", "no_newsletter_signals", "personal_sender_address"]),
    );

    expect(ambiguous?.senderContext).toMatchObject({
      confidence: "medium",
      totalFromSender: 5,
      isNewsletter: true,
    });
    expect(ambiguous?.senderContext.signals).toEqual(
      expect.arrayContaining(["moderate_volume_sender", "automated_sender_pattern"]),
    );
  });

  it("supports unread_only and since filters", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "recent-unread",
        fromAddress: "sender@example.com",
        subject: "Recent unread",
        date: now - 5 * 60 * 1000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "recent-read",
        fromAddress: "sender@example.com",
        subject: "Recent read",
        date: now - 10 * 60 * 1000,
        isRead: true,
        labelIds: ["INBOX"],
      }),
      createTestEmail({
        id: "old-unread",
        fromAddress: "sender@example.com",
        subject: "Old unread",
        date: now - 5 * 24 * 60 * 60 * 1000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
    ]);

    const result = await getUncategorizedEmails({
      unreadOnly: true,
      since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(result.totalUncategorized).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.emails.map((email) => email.id)).toEqual(["recent-unread"]);
  });

  it("supports pagination with offset and large limits", async () => {
    const now = Date.now();

    insertEmails(
      Array.from({ length: 5 }, (_value, index) =>
        createTestEmail({
          id: `page-${index}`,
          fromAddress: `sender-${index}@example.com`,
          subject: `Email ${index}`,
          date: now - index * 60_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
        }),
      ),
    );

    const firstPage = await getUncategorizedEmails({
      limit: 2,
      offset: 0,
    });
    const secondPage = await getUncategorizedEmails({
      limit: 2,
      offset: 2,
    });
    const emptyPage = await getUncategorizedEmails({
      limit: 1000,
      offset: 99999,
    });

    expect(firstPage.totalUncategorized).toBe(5);
    expect(firstPage.returned).toBe(2);
    expect(firstPage.offset).toBe(0);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.emails.map((email) => email.id)).toEqual(["page-0", "page-1"]);

    expect(secondPage.returned).toBe(2);
    expect(secondPage.offset).toBe(2);
    expect(secondPage.hasMore).toBe(true);
    expect(secondPage.emails.map((email) => email.id)).toEqual(["page-2", "page-3"]);

    expect(emptyPage.totalUncategorized).toBe(5);
    expect(emptyPage.returned).toBe(0);
    expect(emptyPage.offset).toBe(99999);
    expect(emptyPage.hasMore).toBe(false);
    expect(emptyPage.emails).toEqual([]);
  });
});

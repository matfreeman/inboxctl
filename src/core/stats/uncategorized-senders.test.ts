import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import type { EmailMessage } from "../gmail/types.js";
import { initializeDb, getSqlite } from "../db/client.js";
import { getUncategorizedSenders } from "./uncategorized-senders.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-uncategorized-senders-"));
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

describe("getUncategorizedSenders", () => {
  it("groups uncategorized emails by sender and returns summary stats", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "newsletter-1",
        fromAddress: "newsletter@example.com",
        fromName: "Weekly Digest",
        subject: "Issue #3",
        snippet: "Latest issue",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
        listUnsubscribe: "<https://example.com/unsubscribe>",
      }),
      createTestEmail({
        id: "newsletter-2",
        fromAddress: "newsletter@example.com",
        fromName: "Weekly Digest",
        subject: "Issue #2",
        snippet: "Older issue",
        date: now - 60_000,
        isRead: true,
        labelIds: ["INBOX"],
        listUnsubscribe: "<https://example.com/unsubscribe>",
      }),
      createTestEmail({
        id: "alerts-1",
        fromAddress: "alerts@example.com",
        fromName: "Alerts",
        subject: "System alert",
        snippet: "Service event",
        date: now - 120_000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "labeled-1",
        fromAddress: "organized@example.com",
        fromName: "Organized",
        subject: "Already sorted",
        date: now - 180_000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD", "Label_123"],
      }),
    ]);

    const result = await getUncategorizedSenders({ limit: 10 });

    expect(result.totalSenders).toBe(2);
    expect(result.totalEmails).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.summary.byConfidence.high).toEqual({ senders: 1, emails: 2 });
    expect(result.summary.byConfidence.low).toEqual({ senders: 1, emails: 1 });
    expect(result.summary.topDomains[0]).toEqual({
      domain: "example.com",
      emails: 3,
      senders: 2,
    });
    expect(result.senders[0]).toMatchObject({
      sender: "newsletter@example.com",
      emailCount: 2,
      emailIds: ["newsletter-1", "newsletter-2"],
      unreadCount: 1,
      unreadRate: 50,
      newestSubject: "Issue #3",
      secondSubject: "Issue #2",
      newestSnippet: "Latest issue",
      hasUnsubscribe: true,
      confidence: "high",
      totalFromSender: 2,
      domain: "example.com",
    });
    expect(result.senders[0]?.signals).toEqual(
      expect.arrayContaining(["list_unsubscribe_header", "newsletter_list_header"]),
    );
  });

  it("supports confidence filters, min_emails, since filters, and pagination", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "recent-high-1",
        fromAddress: "updates@example.com",
        fromName: "Updates",
        subject: "Release 1",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "recent-high-2",
        fromAddress: "updates@example.com",
        fromName: "Updates",
        subject: "Release 2",
        date: now - 60_000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "recent-high-3",
        fromAddress: "updates@example.com",
        fromName: "Updates",
        subject: "Release 3",
        date: now - 120_000,
        isRead: true,
        labelIds: ["INBOX"],
      }),
      createTestEmail({
        id: "old-low",
        fromAddress: "person@example.net",
        fromName: "Person",
        subject: "Quick question",
        date: now - 10 * 24 * 60 * 60 * 1000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
    ]);

    const filtered = await getUncategorizedSenders({
      confidence: "medium",
      minEmails: 2,
      since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(filtered.totalSenders).toBe(1);
    expect(filtered.senders[0]?.sender).toBe("updates@example.com");
    expect(filtered.senders[0]?.emailCount).toBe(3);

    const paged = await getUncategorizedSenders({
      limit: 1,
      offset: 1,
      sortBy: "newest",
    });

    expect(paged.returned).toBe(1);
    expect(paged.hasMore).toBe(false);
    expect(paged.senders[0]?.sender).toBe("person@example.net");
  });

  it("sorts by unread rate and truncates large email id lists", async () => {
    const now = Date.now();

    insertEmails([
      ...Array.from({ length: 501 }, (_, index) =>
        createTestEmail({
          id: `bulk-${index + 1}`,
          fromAddress: "bulk@example.com",
          fromName: "Bulk Sender",
          subject: `Bulk ${index + 1}`,
          date: now - index,
          isRead: index >= 500,
          labelIds: index >= 500 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://bulk.example.com/unsub>",
        })),
      ...Array.from({ length: 3 }, (_, index) =>
        createTestEmail({
          id: `quiet-${index + 1}`,
          fromAddress: "quiet@example.com",
          fromName: "Quiet Sender",
          subject: `Quiet ${index + 1}`,
          date: now - 10_000 - index,
          isRead: index > 0,
          labelIds: index > 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
        })),
    ]);

    const result = await getUncategorizedSenders({
      sortBy: "unread_rate",
      limit: 10,
    });

    expect(result.senders[0]?.sender).toBe("bulk@example.com");
    expect(result.senders[0]?.emailIds.length).toBe(500);
    expect(result.senders[0]?.emailIdsTruncated).toBe(true);
    expect(result.senders[0]?.unreadRate).toBeGreaterThan(result.senders[1]?.unreadRate || 0);
  });
});

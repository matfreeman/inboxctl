import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import type { EmailMessage } from "../gmail/types.js";
import { initializeDb, getSqlite } from "../db/client.js";
import { getNoiseSenders } from "./noise.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-noise-"));
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

describe("getNoiseSenders", () => {
  it("returns windowed and all-time noise context with unsubscribe links", async () => {
    const now = Date.now();
    const emails: EmailMessage[] = [];

    for (let index = 0; index < 10; index += 1) {
      emails.push(
        createTestEmail({
          id: `newsletter-${index}`,
          fromAddress: "newsletter@dev.to",
          fromName: "DEV Weekly Newsletter",
          subject: `Digest ${index}`,
          date: now - index * 60_000,
          isRead: index === 0,
          labelIds: index === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<mailto:unsubscribe@dev.to>, <https://dev.to/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 12; index += 1) {
      emails.push(
        createTestEmail({
          id: `newsletter-stale-${index}`,
          fromAddress: "newsletter@dev.to",
          fromName: "DEV Weekly Newsletter",
          subject: `Old digest ${index}`,
          date: now - 120 * 24 * 60 * 60 * 1000 - index * 60_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
          listUnsubscribe: "<mailto:unsubscribe@dev.to>, <https://dev.to/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 6; index += 1) {
      emails.push(
        createTestEmail({
          id: `offers-${index}`,
          fromAddress: "offers@marketing.co",
          fromName: "Marketing Offers",
          subject: `Deal ${index}`,
          date: now - index * 120_000,
          isRead: index === 0,
          labelIds: index === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://marketing.co/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 4; index += 1) {
      emails.push(
        createTestEmail({
          id: `billing-${index}`,
          fromAddress: "billing@example.com",
          fromName: "Billing",
          subject: `Invoice ${index}`,
          date: now - index * 180_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
        }),
      );
    }

    insertEmails(emails);

    const result = await getNoiseSenders();

    expect(result.senders.map((sender) => sender.email)).toEqual([
      "newsletter@dev.to",
      "offers@marketing.co",
    ]);

    expect(result.senders[0]).toMatchObject({
      email: "newsletter@dev.to",
      messageCount: 10,
      allTimeMessageCount: 22,
      unreadCount: 9,
      unreadRate: 90,
      noiseScore: 9,
      allTimeNoiseScore: 21,
      isNewsletter: true,
      hasUnsubscribeLink: true,
      unsubscribeLink: "https://dev.to/unsubscribe",
      suggestedCategory: "Newsletters",
    });

    expect(result.senders[1]).toMatchObject({
      email: "offers@marketing.co",
      messageCount: 6,
      allTimeMessageCount: 6,
      unreadCount: 5,
      noiseScore: 5,
      unsubscribeLink: "https://marketing.co/unsubscribe",
      suggestedCategory: "Promotions",
    });
  });

  it("respects minNoiseScore and activeDays filters", async () => {
    const now = Date.now();

    insertEmails([
      createTestEmail({
        id: "active-alert",
        fromAddress: "alerts@example.com",
        fromName: "Security Alerts",
        subject: "Alert",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "active-alert-2",
        fromAddress: "alerts@example.com",
        fromName: "Security Alerts",
        subject: "Alert 2",
        date: now - 60_000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "stale-alert",
        fromAddress: "alerts@example.com",
        fromName: "Security Alerts",
        subject: "Old alert",
        date: now - 120 * 24 * 60 * 60 * 1000,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
      createTestEmail({
        id: "tiny-volume",
        fromAddress: "tracking@example.com",
        fromName: "Tracking",
        subject: "Tracking",
        date: now,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
      }),
    ]);

    const result = await getNoiseSenders({ minNoiseScore: 1.5, activeDays: 30 });

    expect(result.senders).toHaveLength(1);
    expect(result.senders[0]).toMatchObject({
      email: "alerts@example.com",
      messageCount: 2,
      allTimeMessageCount: 3,
      noiseScore: 2,
      suggestedCategory: "Notifications",
    });
  });

  it("supports sorting by all-time noise score", async () => {
    const now = Date.now();
    const emails: EmailMessage[] = [];

    for (let index = 0; index < 10; index += 1) {
      emails.push(
        createTestEmail({
          id: `recent-heavy-${index}`,
          fromAddress: "recent-heavy@example.com",
          fromName: "Recent Heavy",
          subject: `Recent ${index}`,
          date: now - index * 60_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
        }),
      );
    }

    for (let index = 0; index < 4; index += 1) {
      emails.push(
        createTestEmail({
          id: `historic-heavy-${index}`,
          fromAddress: "historic-heavy@example.com",
          fromName: "Historic Heavy",
          subject: `Current ${index}`,
          date: now - index * 120_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://historic.example.com/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 30; index += 1) {
      emails.push(
        createTestEmail({
          id: `historic-heavy-old-${index}`,
          fromAddress: "historic-heavy@example.com",
          fromName: "Historic Heavy",
          subject: `Old ${index}`,
          date: now - 120 * 24 * 60 * 60 * 1000 - index * 60_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://historic.example.com/unsubscribe>",
        }),
      );
    }

    insertEmails(emails);

    const byWindow = await getNoiseSenders({
      minNoiseScore: 0,
      activeDays: 30,
    });
    const byAllTime = await getNoiseSenders({
      minNoiseScore: 0,
      activeDays: 30,
      sortBy: "all_time_noise_score",
    });

    expect(byWindow.senders[0]?.email).toBe("recent-heavy@example.com");
    expect(byAllTime.senders[0]?.email).toBe("historic-heavy@example.com");
    expect(byAllTime.senders[0]?.allTimeMessageCount).toBe(34);
    expect(byAllTime.senders[0]?.allTimeNoiseScore).toBe(34);
  });
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEmail } from "../../__tests__/helpers/test-db.js";
import type { EmailMessage } from "../gmail/types.js";
import { initializeDb, getSqlite } from "../db/client.js";
import { getUnsubscribeSuggestions } from "./unsubscribe.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-unsubscribe-suggestions-"));
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

describe("getUnsubscribeSuggestions", () => {
  it("ranks senders by impact score and exposes unsubscribe methods", async () => {
    const now = Date.now();
    const emails: EmailMessage[] = [];

    for (let index = 0; index < 10; index += 1) {
      emails.push(
        createTestEmail({
          id: `both-${index}`,
          fromAddress: "digest@example.com",
          fromName: "Digest",
          subject: `Digest ${index}`,
          date: now - index * 60_000,
          isRead: index === 0,
          labelIds: index === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<mailto:unsubscribe@example.com>, <https://example.com/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 8; index += 1) {
      emails.push(
        createTestEmail({
          id: `mailto-${index}`,
          fromAddress: "mailer@example.com",
          fromName: "Mailer",
          subject: `Mailer ${index}`,
          date: now - index * 120_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
          listUnsubscribe: "<mailto:leave@example.com>",
        }),
      );
    }

    for (let index = 0; index < 12; index += 1) {
      emails.push(
        createTestEmail({
          id: `low-impact-${index}`,
          fromAddress: "occasionally@example.com",
          fromName: "Occasionally",
          subject: `Occasionally ${index}`,
          date: now - index * 180_000,
          isRead: index < 10,
          labelIds: index < 10 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://occasionally.example.com/unsubscribe>",
        }),
      );
    }

    insertEmails(emails);

    const result = await getUnsubscribeSuggestions();

    expect(result.totalWithUnsubscribeLinks).toBe(3);
    expect(result.suggestions.map((suggestion) => suggestion.email)).toEqual([
      "digest@example.com",
      "mailer@example.com",
      "occasionally@example.com",
    ]);
    expect(result.suggestions[0]).toMatchObject({
      email: "digest@example.com",
      allTimeMessageCount: 10,
      unreadCount: 9,
      unreadRate: 90,
      readRate: 10,
      unsubscribeLink: "https://example.com/unsubscribe",
      unsubscribeMethod: "both",
      impactScore: 9,
      reason: "90% unread across 10 emails — you never engage with this sender",
    });
    expect(result.suggestions[1]).toMatchObject({
      email: "mailer@example.com",
      unsubscribeLink: "mailto:leave@example.com",
      unsubscribeMethod: "mailto",
      impactScore: 8,
    });
  });

  it("supports minMessages and unreadOnlySenders filters", async () => {
    const now = Date.now();
    const emails: EmailMessage[] = [];

    for (let index = 0; index < 4; index += 1) {
      emails.push(
        createTestEmail({
          id: `small-${index}`,
          fromAddress: "small@example.com",
          subject: `Small ${index}`,
          date: now - index * 60_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://small.example.com/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 6; index += 1) {
      emails.push(
        createTestEmail({
          id: `mixed-${index}`,
          fromAddress: "mixed@example.com",
          subject: `Mixed ${index}`,
          date: now - index * 120_000,
          isRead: index === 0,
          labelIds: index === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://mixed.example.com/unsubscribe>",
        }),
      );
    }

    for (let index = 0; index < 6; index += 1) {
      emails.push(
        createTestEmail({
          id: `unread-only-${index}`,
          fromAddress: "unread-only@example.com",
          subject: `Unread ${index}`,
          date: now - index * 180_000,
          isRead: false,
          labelIds: ["INBOX", "UNREAD"],
          listUnsubscribe: "<https://unread-only.example.com/unsubscribe>",
        }),
      );
    }

    insertEmails(emails);

    const result = await getUnsubscribeSuggestions({
      minMessages: 5,
      unreadOnlySenders: true,
    });

    expect(result.totalWithUnsubscribeLinks).toBe(1);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      email: "unread-only@example.com",
      allTimeMessageCount: 6,
      unreadCount: 6,
      unsubscribeMethod: "link",
    });
  });
});

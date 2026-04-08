import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_SENDERS,
  createTestEmail,
  generateTestEmails,
} from "../../__tests__/helpers/test-db.js";
import { initializeDb, getSqlite } from "../db/client.js";
import type { EmailMessage } from "../gmail/types.js";
import { queryEmails } from "./query.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;
let seededEmails: EmailMessage[] = [];

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

function buildDataset(): EmailMessage[] {
  const emails = generateTestEmails().map((email) => ({ ...email, labelIds: [...email.labelIds] }));
  let stripeSeen = 0;
  let bossLabeled = 0;

  for (const email of emails) {
    if (email.fromAddress === TEST_SENDERS.stripe.email) {
      stripeSeen += 1;
      email.labelIds = stripeSeen === 1
        ? ["INBOX", "Receipts", "Finance"]
        : ["INBOX", "Receipts"];
    }

    if (email.fromAddress === TEST_SENDERS.boss.email && bossLabeled < 2) {
      bossLabeled += 1;
      email.labelIds = email.isRead
        ? ["INBOX", "Work"]
        : ["INBOX", "UNREAD", "Work"];
    }
  }

  emails.push(
    createTestEmail({
      id: "old-history-1",
      fromAddress: "history@example.net",
      fromName: "History",
      subject: "Quarterly archive",
      date: Date.now() - 45 * 24 * 60 * 60 * 1000,
      isRead: true,
      labelIds: ["INBOX"],
    }),
  );

  return emails;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-query-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);

  seededEmails = buildDataset();
  insertEmails(seededEmails);
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

describe("queryEmails", () => {
  it("returns a single summary row with all aggregates when ungrouped", async () => {
    const result = await queryEmails({
      aggregates: ["count", "unread_count", "read_count", "unread_rate", "oldest", "newest", "sender_count"],
    });

    expect(result.totalRows).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      count: seededEmails.length,
      unread_count: seededEmails.filter((email) => !email.isRead).length,
      read_count: seededEmails.filter((email) => email.isRead).length,
      sender_count: 7,
    });
    expect(result.rows[0]?.unread_rate).toBeGreaterThan(0);
    expect(result.rows[0]?.oldest).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.rows[0]?.newest).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("supports sender, domain, date, newsletter, and unsubscribe filters", async () => {
    const exactSender = await queryEmails({
      filters: { from: "NEWSLETTER@DEV.TO" },
      group_by: "sender",
      aggregates: ["count"],
    });
    const domainContains = await queryEmails({
      filters: { domain_contains: "company.com" },
      group_by: "sender",
      aggregates: ["count"],
      order_by: "sender asc",
    });
    const dateWindow = await queryEmails({
      filters: {
        date_after: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        date_before: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      },
      aggregates: ["count"],
    });
    const newslettersOnly = await queryEmails({
      filters: { is_newsletter: true },
      group_by: "sender",
      aggregates: ["count"],
      order_by: "sender asc",
    });
    const unsubscribeDomains = await queryEmails({
      filters: { has_unsubscribe: true },
      group_by: "domain",
      aggregates: ["count"],
      order_by: "domain asc",
    });

    expect(exactSender.rows).toEqual([{ sender: "newsletter@dev.to", count: 10 }]);
    expect(domainContains.totalRows).toBe(2);
    expect(domainContains.rows).toEqual([
      { sender: "boss@company.com", count: 8 },
      { sender: "colleague@company.com", count: 5 },
    ]);
    expect(dateWindow.rows[0]?.count).toBeGreaterThan(0);
    expect(dateWindow.rows[0]?.count).toBeLessThan(seededEmails.length);
    expect(newslettersOnly.rows).toEqual([
      { sender: "newsletter@dev.to", count: 10 },
      { sender: "noreply@marketing.co", count: 5 },
    ]);
    expect(unsubscribeDomains.rows).toEqual([
      { domain: "dev.to", count: 10 },
      { domain: "marketing.co", count: 5 },
    ]);
  });

  it("supports has_label, label, and min_sender_messages filters", async () => {
    const labeled = await queryEmails({
      filters: { has_label: true },
      aggregates: ["count"],
    });
    const receipts = await queryEmails({
      filters: { label: "Receipts" },
      aggregates: ["count"],
    });
    const largeSenders = await queryEmails({
      filters: { min_sender_messages: 8 },
      group_by: "sender",
      aggregates: ["count"],
      order_by: "count desc",
    });

    expect(labeled.rows).toEqual([{ count: 9 }]);
    expect(receipts.rows).toEqual([{ count: 7 }]);
    expect(largeSenders.rows).toEqual([
      { sender: "notifications@github.com", count: 15 },
      { sender: "newsletter@dev.to", count: 10 },
      { sender: "boss@company.com", count: 8 },
    ]);
  });

  it("supports label, domain, year_month, year_week, and day_of_week groupings", async () => {
    const labelGroups = await queryEmails({
      group_by: "label",
      aggregates: ["count"],
      order_by: "label asc",
    });
    const domainGroups = await queryEmails({
      group_by: "domain",
      aggregates: ["count"],
      order_by: "count desc",
      limit: 3,
    });
    const monthGroups = await queryEmails({
      group_by: "year_month",
      aggregates: ["count", "unread_rate"],
      order_by: "year_month asc",
      limit: 12,
    });
    const weekGroups = await queryEmails({
      group_by: "year_week",
      aggregates: ["count"],
      order_by: "year_week asc",
      limit: 12,
    });
    const weekdayGroups = await queryEmails({
      group_by: "day_of_week",
      aggregates: ["count"],
      order_by: "day_of_week asc",
      limit: 7,
    });

    expect(labelGroups.totalRows).toBe(3);
    expect(labelGroups.rows).toEqual([
      { label: "Finance", count: 1 },
      { label: "Receipts", count: 7 },
      { label: "Work", count: 2 },
    ]);
    expect(domainGroups.rows[0]).toEqual({ domain: "github.com", count: 15 });
    expect(monthGroups.totalRows).toBeGreaterThanOrEqual(2);
    expect(monthGroups.rows.every((row) => typeof row.year_month === "string")).toBe(true);
    expect(weekGroups.rows.every((row) => String(row.year_week).match(/^\d{4}-W\d{2}$/))).toBe(true);
    expect(weekdayGroups.rows.every((row) => Number(row.day_of_week) >= 0 && Number(row.day_of_week) <= 6)).toBe(true);
  });

  it("supports boolean groupings, having filters, sort direction, and limits", async () => {
    const byReadState = await queryEmails({
      group_by: "is_read",
      aggregates: ["count"],
      order_by: "is_read asc",
    });
    const byNewsletterState = await queryEmails({
      group_by: "is_newsletter",
      aggregates: ["count"],
      order_by: "is_newsletter asc",
    });
    const havingCount = await queryEmails({
      group_by: "sender",
      aggregates: ["count", "unread_rate"],
      having: { count: { gte: 8 } },
      order_by: "count desc",
      limit: 2,
    });
    const havingUnreadRate = await queryEmails({
      group_by: "sender",
      aggregates: ["count", "unread_rate"],
      having: { unread_rate: { gte: 90 } },
      order_by: "sender asc",
    });
    const ascending = await queryEmails({
      group_by: "sender",
      aggregates: ["count"],
      order_by: "count asc",
      limit: 2,
    });

    expect(byReadState.rows).toEqual([
      { is_read: false, count: seededEmails.filter((email) => !email.isRead).length },
      { is_read: true, count: seededEmails.filter((email) => email.isRead).length },
    ]);
    expect(byNewsletterState.rows).toEqual([
      { is_newsletter: false, count: 36 },
      { is_newsletter: true, count: 15 },
    ]);
    expect(havingCount.totalRows).toBe(3);
    expect(havingCount.rows).toEqual([
      { sender: "notifications@github.com", count: 15, unread_rate: 33.3 },
      { sender: "newsletter@dev.to", count: 10, unread_rate: 90 },
    ]);
    expect(havingUnreadRate.rows).toEqual([
      { sender: "newsletter@dev.to", count: 10, unread_rate: 90 },
      { sender: "noreply@marketing.co", count: 5, unread_rate: 100 },
    ]);
    expect(ascending.rows).toHaveLength(2);
    expect(ascending.rows[0]?.count).toBeLessThanOrEqual(Number(ascending.rows[1]?.count));
  });

  it("rejects invalid filter and group_by values", async () => {
    await expect(
      queryEmails({ filters: { invalid: "oops" } as never }),
    ).rejects.toThrow();

    await expect(
      queryEmails({ group_by: "not_a_dimension" as never }),
    ).rejects.toThrow();
  });
});

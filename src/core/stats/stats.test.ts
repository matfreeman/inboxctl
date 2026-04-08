import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_SENDERS,
  generateTestEmails,
} from "../../__tests__/helpers/test-db.js";
import { initializeDb, getSqlite } from "../db/client.js";
import { getLabelDistribution } from "./labels.js";
import {
  detectNewsletters,
  getNewsletters,
  updateNewsletterStatus,
} from "./newsletters.js";
import { getSenderDomains, getSenderStats, getTopSenders } from "./sender.js";
import {
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
} from "./common.js";
import { getInboxOverview, getVolumeByPeriod } from "./volume.js";
import {
  getPeriodStart,
  extractDomain,
  normalizeLimit,
  clampPercentage,
  roundPercent,
} from "./common.js";
import type { EmailMessage } from "../gmail/types.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;
let seededEmails: EmailMessage[] = [];

function insertEmails(emails: EmailMessage[]): void {
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
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-stats-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);

  seededEmails = generateTestEmails().map((email, index) => {
    if (index === 0) {
      return {
        ...email,
        isStarred: true,
        labelIds: [...email.labelIds, "STARRED", "Label_123"],
      };
    }

    return email;
  });

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

describe("common utility functions", () => {
  it("getPeriodStart returns correct offsets for all periods", () => {
    const now = 1_000_000_000;
    expect(getPeriodStart("all", now)).toBeNull();
    expect(getPeriodStart("day", now)).toBe(now - 24 * 60 * 60 * 1000);
    expect(getPeriodStart("week", now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(getPeriodStart("month", now)).toBe(now - 30 * 24 * 60 * 60 * 1000);
    expect(getPeriodStart("year", now)).toBe(now - 365 * 24 * 60 * 60 * 1000);
  });

  it("extractDomain handles valid and invalid emails", () => {
    expect(extractDomain("user@example.com")).toBe("example.com");
    expect(extractDomain("no-at-sign")).toBeNull();
    expect(extractDomain("@nodomain")).toBeNull();
    expect(extractDomain("trailing@")).toBeNull();
  });

  it("normalizeLimit returns fallback for invalid inputs", () => {
    expect(normalizeLimit(10, 20)).toBe(10);
    expect(normalizeLimit(0, 20)).toBe(20);
    expect(normalizeLimit(undefined, 20)).toBe(20);
    expect(normalizeLimit(Number.NaN, 20)).toBe(20);
    expect(normalizeLimit(5.7, 20)).toBe(5);
  });

  it("clampPercentage clamps to 0-100 range", () => {
    expect(clampPercentage(50)).toBe(50);
    expect(clampPercentage(-10)).toBe(0);
    expect(clampPercentage(150)).toBe(100);
    expect(clampPercentage(undefined)).toBe(0);
    expect(clampPercentage(Number.NaN)).toBe(0);
  });

  it("roundPercent returns 0 when denominator is 0", () => {
    expect(roundPercent(5, 0)).toBe(0);
    expect(roundPercent(1, 4)).toBe(25);
  });
});

describe("stats analytics", () => {
  it("groups top senders and respects filters", async () => {
    const senders = await getTopSenders();
    const github = senders.find((sender) => sender.email === TEST_SENDERS.github.email);

    expect(github).toMatchObject({
      totalMessages: 15,
      unreadMessages: 5,
    });
    expect(github?.unreadRate).toBeCloseTo(33.3, 1);
    expect(github?.labels).toContain("Inbox");

    const highUnread = await getTopSenders({ minUnreadRate: 50 });
    expect(highUnread.map((sender) => sender.email)).toEqual([
      TEST_SENDERS.devto.email,
      TEST_SENDERS.marketing.email,
    ]);

    const thisWeek = await getTopSenders({ period: "week" });
    const devto = thisWeek.find((sender) => sender.email === TEST_SENDERS.devto.email);
    expect(devto?.totalMessages).toBe(3);
  });

  it("returns sender and domain detail stats", async () => {
    const boss = await getSenderStats(TEST_SENDERS.boss.email);
    expect(boss).not.toBeNull();
    expect(boss?.type).toBe("sender");
    expect(boss?.totalMessages).toBe(8);
    expect(boss?.recentEmails[0]?.fromAddress).toBe(TEST_SENDERS.boss.email);

    const company = await getSenderStats("@company.com");
    expect(company).not.toBeNull();
    expect(company?.type).toBe("domain");
    expect(company?.totalMessages).toBe(13);
    expect(company?.unreadMessages).toBe(3);
    expect(company?.matchingSenders).toEqual([
      TEST_SENDERS.boss.email,
      TEST_SENDERS.colleague.email,
    ]);
  });

  it("aggregates sender domains", async () => {
    const domains = await getSenderDomains();
    const company = domains.find((domain) => domain.email === "@company.com");

    expect(company).toMatchObject({
      totalMessages: 13,
      unreadMessages: 3,
      name: "company.com",
    });
  });

  it("detects newsletters from unsubscribe headers, unread-heavy volume, and known patterns", async () => {
    const detected = await detectNewsletters();
    const emails = detected.map((entry) => entry.email).sort();

    expect(emails).toEqual([
      TEST_SENDERS.devto.email,
      TEST_SENDERS.marketing.email,
    ]);

    const devto = detected.find((entry) => entry.email === TEST_SENDERS.devto.email);
    expect(devto?.detectionReason).toContain("list_unsubscribe");
    expect(devto?.detectionReason).toContain("high_volume_high_unread");

    const marketing = detected.find((entry) => entry.email === TEST_SENDERS.marketing.email);
    expect(marketing?.detectionReason).toContain("known_sender_pattern");
    expect(marketing?.unsubscribeLink).toBe("https://marketing.co/unsubscribe");
  });

  it("returns newsletters with status filters and supports status updates", async () => {
    let newsletters = await getNewsletters({ minUnreadRate: 80 });
    expect(newsletters.map((entry) => entry.email)).toEqual([
      TEST_SENDERS.devto.email,
      TEST_SENDERS.marketing.email,
    ]);

    await updateNewsletterStatus(TEST_SENDERS.devto.email, "archived");
    newsletters = await getNewsletters({ status: "archived" });
    expect(newsletters.map((entry) => entry.email)).toEqual([TEST_SENDERS.devto.email]);
  });

  it("computes volume buckets and inbox overview from the local cache", async () => {
    const now = Date.now();
    const start = now - 7 * 24 * 60 * 60 * 1000;
    const daily = await getVolumeByPeriod("day", { start });
    const weekly = await getVolumeByPeriod("week");
    const overview = await getInboxOverview();

    const expectedRecent = seededEmails.filter((email) => email.date >= start);
    expect(daily.reduce((sum, point) => sum + point.received, 0)).toBe(expectedRecent.length);
    expect(daily.every((point) => point.read + point.unread === point.received)).toBe(true);
    expect(weekly.length).toBeGreaterThan(0);

    expect(overview.total).toBe(50);
    expect(overview.unread).toBe(22);
    expect(overview.starred).toBe(1);
    expect(overview.today.received).toBe(
      seededEmails.filter((email) => email.date >= startOfLocalDay(now)).length,
    );
    expect(overview.thisWeek.received).toBe(
      seededEmails.filter((email) => email.date >= startOfLocalWeek(now)).length,
    );
    expect(overview.thisMonth.received).toBe(
      seededEmails.filter((email) => email.date >= startOfLocalMonth(now)).length,
    );
    expect(overview.oldestUnread).not.toBeNull();
  });

  it("getInboxOverview returns null for oldestUnread when all emails are read", async () => {
    // Mark all emails as read by inserting with is_read=1
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare("UPDATE emails SET is_read = 1").run();

    const overview = await getInboxOverview();

    expect(overview.unread).toBe(0);
    expect(overview.oldestUnread).toBeNull();
  });

  it("supports hour and month granularities and end-range filter", async () => {
    const now = Date.now();

    // hour granularity
    const hourly = await getVolumeByPeriod("hour");
    expect(hourly.length).toBeGreaterThan(0);
    // Period strings for hour granularity look like "2026-04-01 10:00"
    expect(hourly[0]?.period).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00$/);

    // month granularity
    const monthly = await getVolumeByPeriod("month");
    expect(monthly.length).toBeGreaterThan(0);
    // Period strings for month granularity look like "2026-04"
    expect(monthly[0]?.period).toMatch(/^\d{4}-\d{2}$/);

    // With range.end filter — only include emails before a cutoff
    const cutoff = now - 20 * 24 * 60 * 60 * 1000; // 20 days ago
    const recentOnly = await getVolumeByPeriod("day", { end: cutoff });
    const totalInRange = recentOnly.reduce((sum, point) => sum + point.received, 0);
    const expectedInRange = seededEmails.filter((email) => email.date <= cutoff).length;
    expect(totalInRange).toBe(expectedInRange);
  });

  it("computes label distribution with human-readable system labels", async () => {
    const labels = await getLabelDistribution();
    const inbox = labels.find((label) => label.labelId === "INBOX");
    const unread = labels.find((label) => label.labelId === "UNREAD");
    const custom = labels.find((label) => label.labelId === "Label_123");

    expect(inbox).toMatchObject({
      labelName: "Inbox",
      totalMessages: 50,
    });
    expect(unread).toMatchObject({
      labelName: "Unread",
      totalMessages: 22,
      unreadMessages: 22,
    });
    expect(custom).toMatchObject({
      labelName: "Label_123",
      totalMessages: 1,
    });
  });
});

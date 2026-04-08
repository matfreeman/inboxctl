import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDb, getSqlite } from "../db/client.js";
import { getRecentEmails, searchLocalEmails, getEmailById } from "./cache.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_TOKENS_PATH",
  "INBOXCTL_RULES_DIR",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

let tempDir: string;

function seedEmail(
  dbPath: string,
  id: string,
  overrides: Partial<{
    subject: string;
    fromAddress: string;
    fromName: string;
    snippet: string;
    date: number;
    labelIds: string[];
    isRead: boolean;
    isStarred: boolean;
    listUnsubscribe: string | null;
  }> = {},
): void {
  const sqlite = getSqlite(dbPath);
  sqlite
    .prepare(
      `INSERT INTO emails (
        id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
        is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `thread-${id}`,
      overrides.fromAddress ?? "sender@example.com",
      overrides.fromName ?? "Sender",
      JSON.stringify(["user@example.com"]),
      overrides.subject ?? `Subject ${id}`,
      overrides.snippet ?? `Snippet ${id}`,
      overrides.date ?? Date.parse("2026-04-01T00:00:00Z"),
      overrides.isRead === false ? 0 : 1,
      overrides.isStarred ? 1 : 0,
      JSON.stringify(overrides.labelIds ?? ["INBOX"]),
      1024,
      0,
      overrides.listUnsubscribe ?? null,
      Date.now(),
    );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-cache-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  initializeDb(process.env.INBOXCTL_DB_PATH);
});

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("getRecentEmails", () => {
  it("returns emails sorted by date descending", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    seedEmail(dbPath, "a", { date: 1_000 });
    seedEmail(dbPath, "b", { date: 3_000 });
    seedEmail(dbPath, "c", { date: 2_000 });

    const emails = await getRecentEmails(10);

    expect(emails.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("respects limit and offset", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    for (let i = 1; i <= 5; i++) {
      seedEmail(dbPath, `m-${i}`, { date: i * 1000 });
    }

    const page1 = await getRecentEmails(2, 0);
    const page2 = await getRecentEmails(2, 2);

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  it("maps rows to EmailMessage objects correctly", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    seedEmail(dbPath, "x1", {
      subject: "Hello",
      fromAddress: "alice@example.com",
      fromName: "Alice",
      isRead: false,
      isStarred: true,
      labelIds: ["INBOX", "UNREAD"],
      listUnsubscribe: "<mailto:unsub@example.com>",
    });

    const [email] = await getRecentEmails(1);

    expect(email?.subject).toBe("Hello");
    expect(email?.fromAddress).toBe("alice@example.com");
    expect(email?.fromName).toBe("Alice");
    expect(email?.isRead).toBe(false);
    expect(email?.isStarred).toBe(true);
    expect(email?.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(email?.listUnsubscribe).toBe("<mailto:unsub@example.com>");
  });

  it("returns empty array when DB is empty", async () => {
    const emails = await getRecentEmails(10);
    expect(emails).toEqual([]);
  });
});

describe("searchLocalEmails", () => {
  it("matches by subject substring", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    seedEmail(dbPath, "s1", { subject: "Invoice #1234" });
    seedEmail(dbPath, "s2", { subject: "Meeting notes" });

    const results = await searchLocalEmails("Invoice");

    expect(results.map((e) => e.id)).toContain("s1");
    expect(results.map((e) => e.id)).not.toContain("s2");
  });

  it("matches by from_address", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    seedEmail(dbPath, "f1", { fromAddress: "billing@stripe.com" });
    seedEmail(dbPath, "f2", { fromAddress: "updates@github.com" });

    const results = await searchLocalEmails("stripe");

    expect(results.map((e) => e.id)).toContain("f1");
    expect(results.map((e) => e.id)).not.toContain("f2");
  });

  it("returns empty array for no matches", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    seedEmail(dbPath, "e1", { subject: "Hello" });

    const results = await searchLocalEmails("zzz-no-match");
    expect(results).toEqual([]);
  });
});

describe("getEmailById", () => {
  it("returns the email when found", async () => {
    const dbPath = process.env.INBOXCTL_DB_PATH as string;
    seedEmail(dbPath, "id-42", { subject: "Specific email" });

    const email = await getEmailById("id-42");

    expect(email).not.toBeNull();
    expect(email?.id).toBe("id-42");
    expect(email?.subject).toBe("Specific email");
  });

  it("returns null when not found", async () => {
    const email = await getEmailById("nonexistent");
    expect(email).toBeNull();
  });
});

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDb, getSqlite } from "../db/client.js";
import { findMatchingEmails, matchEmail } from "./matcher.js";
import type { Conditions } from "./types.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-rules-matcher-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);

  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "msg-1",
    "thread-1",
    "Notifications@GitHub.com",
    "GitHub",
    JSON.stringify(["user@example.com"]),
    "Payment receipt inside",
    "Billing summary available",
    Date.parse("2026-04-01T00:00:00Z"),
    0,
    0,
    JSON.stringify(["INBOX", "UNREAD", "Finance"]),
    1024,
    0,
    null,
    Date.now(),
  );
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

describe("rules matcher", () => {
  it("matches exact values, contains clauses, and label checks case-insensitively", async () => {
    const conditions: Conditions = {
      operator: "OR",
      matchers: [
        { field: "from", values: ["notifications@github.com"], exclude: false },
        { field: "subject", contains: ["receipt"], exclude: false },
        { field: "labels", values: ["finance"], exclude: false },
      ],
    };

    const matches = await findMatchingEmails(conditions, 10);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedFields).toEqual(["from", "subject", "labels"]);
  });

  it("supports AND conditions and exclude matchers", () => {
    const email = {
      id: "msg-1",
      threadId: "thread-1",
      fromAddress: "notifications@github.com",
      fromName: "GitHub",
      toAddresses: ["user@example.com"],
      subject: "Payment receipt inside",
      snippet: "Billing summary available",
      date: Date.parse("2026-04-01T00:00:00Z"),
      isRead: false,
      isStarred: false,
      labelIds: ["INBOX", "UNREAD", "Finance"],
      sizeEstimate: 1024,
      hasAttachments: false,
      listUnsubscribe: null,
    };

    const includeAll: Conditions = {
      operator: "AND",
      matchers: [
        { field: "from", pattern: "github\\.com$", exclude: false },
        { field: "snippet", contains: ["billing"], exclude: false },
      ],
    };
    const excludeMarketing: Conditions = {
      operator: "AND",
      matchers: [
        { field: "subject", contains: ["receipt"], exclude: false },
        { field: "subject", contains: ["marketing"], exclude: true },
      ],
    };

    expect(matchEmail(email, includeAll)).toEqual({
      matches: true,
      matchedFields: ["from", "snippet"],
    });
    expect(matchEmail(email, excludeMarketing)).toEqual({
      matches: true,
      matchedFields: ["subject"],
    });
  });
});

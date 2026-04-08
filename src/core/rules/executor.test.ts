import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gmail/modify.js", () => ({
  archiveEmails: vi.fn(),
  forwardEmail: vi.fn(),
  labelEmails: vi.fn(),
  markRead: vi.fn(),
  markSpam: vi.fn(),
}));

vi.mock("../gmail/messages.js", () => ({
  listMessages: vi.fn(),
}));

import { getRun, getRunItems } from "../actions/audit.js";
import { initializeDb, getSqlite } from "../db/client.js";
import {
  archiveEmails,
  labelEmails,
  markRead,
} from "../gmail/modify.js";
import { listMessages } from "../gmail/messages.js";
import { deployRule } from "./deploy.js";
import { runAllRules, runRule } from "./executor.js";
import type { Rule } from "./types.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

function seedEmail(id: string, fromAddress: string, subject: string, labelIds: string[]): void {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `thread-${id}`,
    fromAddress,
    "Sender",
    JSON.stringify(["user@example.com"]),
    subject,
    "Snippet",
    Date.parse("2026-04-01T00:00:00Z"),
    labelIds.includes("UNREAD") ? 0 : 1,
    0,
    JSON.stringify(labelIds),
    100,
    0,
    null,
    Date.now(),
  );
}

function makeRule(name: string, priority: number, actions: Rule["actions"]): Rule {
  return {
    name,
    description: `${name} description`,
    enabled: true,
    priority,
    conditions: {
      operator: "OR",
      matchers: [{ field: "from", values: ["notifications@example.com"], exclude: false }],
    },
    actions,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-rules-executor-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH as string);
  vi.mocked(archiveEmails).mockReset();
  vi.mocked(labelEmails).mockReset();
  vi.mocked(markRead).mockReset();
  vi.mocked(listMessages).mockReset();
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

describe("rules executor", () => {
  it("dry-runs without invoking Gmail mutations and records a planned run", async () => {
    seedEmail("msg-1", "notifications@example.com", "Build complete", ["INBOX", "UNREAD"]);
    const rule = makeRule("archive-notifications", 10, [{ type: "archive" }]);
    await deployRule(rule, "hash-1");

    const result = await runRule("archive-notifications", {
      dryRun: true,
      maxEmails: 100,
    });

    expect(result.matchedCount).toBe(1);
    expect(archiveEmails).not.toHaveBeenCalled();
    expect(result.status).toBe("planned");

    const run = await getRun(result.runId);
    expect(run?.dryRun).toBe(true);
    expect(run?.status).toBe("planned");
  });

  it("applies actions, records audit rows, and respects action ordering", async () => {
    seedEmail("msg-1", "notifications@example.com", "Build complete", ["INBOX", "UNREAD"]);
    const rule = makeRule("triage-notifications", 10, [
      { type: "mark_read" },
      { type: "archive" },
    ]);
    await deployRule(rule, "hash-2");

    vi.mocked(markRead).mockResolvedValue({
      action: "mark_read",
      affectedCount: 1,
      items: [{
        emailId: "msg-1",
        beforeLabelIds: ["INBOX", "UNREAD"],
        afterLabelIds: ["INBOX"],
        status: "applied",
        appliedActions: [{ type: "mark_read" }],
      }],
      nonReversible: false,
      labelId: "UNREAD",
      labelName: "UNREAD",
    });
    vi.mocked(archiveEmails).mockResolvedValue({
      action: "archive",
      affectedCount: 1,
      items: [{
        emailId: "msg-1",
        beforeLabelIds: ["INBOX"],
        afterLabelIds: [],
        status: "applied",
        appliedActions: [{ type: "archive" }],
      }],
      nonReversible: false,
      labelId: "INBOX",
      labelName: "INBOX",
    });

    const result = await runRule("triage-notifications", {
      dryRun: false,
      maxEmails: 100,
    });

    expect(markRead).toHaveBeenCalledWith(
      ["msg-1"],
      expect.objectContaining({ config: expect.any(Object) }),
    );
    expect(archiveEmails).toHaveBeenCalledWith(
      ["msg-1"],
      expect.objectContaining({ config: expect.any(Object) }),
    );
    expect(result.status).toBe("applied");
    expect(result.items[0]?.afterLabelIds).toEqual([]);

    const items = await getRunItems(result.runId);
    expect(items).toHaveLength(1);
    expect(items[0]?.appliedActions).toEqual([
      { type: "mark_read" },
      { type: "archive" },
    ]);
  });

  it("runs all enabled rules in ascending priority order", async () => {
    seedEmail("msg-1", "notifications@example.com", "Build complete", ["INBOX"]);
    await deployRule(makeRule("second-rule", 50, [{ type: "archive" }]), "hash-a");
    await deployRule(makeRule("first-rule", 10, [{ type: "label", label: "Triage" }]), "hash-b");
    vi.mocked(labelEmails).mockResolvedValue({
      action: "label",
      affectedCount: 1,
      items: [{
        emailId: "msg-1",
        beforeLabelIds: ["INBOX"],
        afterLabelIds: ["INBOX", "Triage"],
        status: "applied",
        appliedActions: [{ type: "label", label: "Triage" }],
      }],
      nonReversible: false,
      labelId: "Label_123",
      labelName: "Triage",
    });
    vi.mocked(archiveEmails).mockResolvedValue({
      action: "archive",
      affectedCount: 1,
      items: [{
        emailId: "msg-1",
        beforeLabelIds: ["INBOX", "Triage"],
        afterLabelIds: ["Triage"],
        status: "applied",
        appliedActions: [{ type: "archive" }],
      }],
      nonReversible: false,
    });

    const result = await runAllRules({
      dryRun: false,
      maxEmails: 100,
    });

    expect(result.results.map((entry) => entry.rule.name)).toEqual([
      "first-rule",
      "second-rule",
    ]);
  });
});

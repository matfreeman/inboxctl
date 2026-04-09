import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDb, getSqlite } from "../db/client.js";
import { restoreEmailLabels } from "../gmail/modify.js";
import { appendExecutionItem, createExecutionRun, getRunItems } from "./audit.js";
import { undoRun } from "./undo.js";

vi.mock("../gmail/modify.js", () => ({
  restoreEmailLabels: vi.fn(),
}));

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-undo-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  initializeDb(process.env.INBOXCTL_DB_PATH);
  vi.mocked(restoreEmailLabels).mockReset();
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

function insertEmail(
  id: string,
  labelIds: string[],
  overrides: Partial<{
    isRead: boolean;
    isStarred: boolean;
  }> = {},
) {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  sqlite
    .prepare(
      `
      INSERT INTO emails (
        id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
        is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      `thread-${id}`,
      "sender@example.com",
      "Sender",
      JSON.stringify(["user@example.com"]),
      "Subject",
      "Snippet",
      Date.parse("2026-04-01T00:00:00Z"),
      overrides.isRead === false ? 0 : 1,
      overrides.isStarred ? 1 : 0,
      JSON.stringify(labelIds),
      1024,
      0,
      null,
      Date.now(),
    );
}

function insertRule(overrides: Partial<{
  id: string;
  name: string;
  enabled: boolean;
}> = {}) {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
  const id = overrides.id ?? randomUUID();
  sqlite
    .prepare(
      `
      INSERT INTO rules (
        id, name, description, enabled, yaml_hash, conditions, actions, priority, deployed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      overrides.name ?? "archive-newsletters",
      "Test rule",
      overrides.enabled === false ? 0 : 1,
      "hash",
      JSON.stringify({ operator: "OR", matchers: [] }),
      JSON.stringify([{ type: "archive" }]),
      50,
      Date.now(),
      Date.now(),
    );

  return {
    id,
    name: overrides.name ?? "archive-newsletters",
  };
}

describe("undo layer", () => {
  it("restores exact label snapshots for reversible actions", async () => {
    insertEmail("msg-1", ["INBOX", "UNREAD"], { isRead: false });
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-1",
      beforeLabelIds: ["UNREAD"],
      afterLabelIds: ["INBOX", "UNREAD"],
      status: "applied",
      appliedActions: [],
    });

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      status: "applied",
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-1",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["UNREAD"],
    });

    const result = await undoRun(run.id);

    expect(result.status).toBe("undone");
    expect(result.warnings).toEqual([]);
    expect(result.restoredItemCount).toBe(1);
    expect(restoreEmailLabels).toHaveBeenCalledWith("msg-1", ["INBOX", "UNREAD"]);

    const items = await getRunItems(run.id);
    expect(items[0]?.status).toBe("undone");
    expect(items[0]?.undoneAt).not.toBeNull();
  });

  it("returns partial status when a forward action is present", async () => {
    insertEmail("msg-1", ["INBOX", "UNREAD"], { isRead: false });
    insertEmail("msg-2", ["INBOX"], { isRead: true });
    vi.mocked(restoreEmailLabels)
      .mockResolvedValueOnce({
        emailId: "msg-1",
        beforeLabelIds: ["INBOX", "UNREAD", "Receipts"],
        afterLabelIds: ["INBOX", "UNREAD"],
        status: "applied",
        appliedActions: [],
      })
      .mockResolvedValueOnce({
        emailId: "msg-2",
        beforeLabelIds: ["INBOX"],
        afterLabelIds: ["INBOX"],
        status: "applied",
        appliedActions: [],
      });

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Receipts" }, { type: "forward", to: "me@example.com" }],
      status: "applied",
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-1",
      status: "applied",
      appliedActions: [{ type: "label", label: "Receipts" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["INBOX", "UNREAD", "Receipts"],
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-2",
      status: "applied",
      appliedActions: [{ type: "forward", to: "me@example.com" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX"],
    });

    const result = await undoRun(run.id);

    expect(result.status).toBe("partial");
    expect(result.warnings.some((warning) => warning.includes("forward actions cannot be undone"))).toBe(true);
    expect(restoreEmailLabels).toHaveBeenCalledTimes(2);
    expect(vi.mocked(restoreEmailLabels).mock.calls).toEqual(
      expect.arrayContaining([
        ["msg-1", ["INBOX", "UNREAD"]],
        ["msg-2", ["INBOX"]],
      ]),
    );
  });

  it("refuses to undo a run twice", async () => {
    insertEmail("msg-1", ["INBOX", "UNREAD"], { isRead: false });
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-1",
      beforeLabelIds: ["UNREAD"],
      afterLabelIds: ["INBOX", "UNREAD"],
      status: "applied",
      appliedActions: [],
    });

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      status: "applied",
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-1",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["UNREAD"],
    });

    await undoRun(run.id);
    await expect(undoRun(run.id)).rejects.toThrow(/already undone/i);
  });

  it("auto-disables the originating rule after undoing a rule run", async () => {
    insertEmail("msg-rule", ["INBOX", "UNREAD"], { isRead: false });
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-rule",
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["INBOX", "UNREAD"],
      status: "applied",
      appliedActions: [],
    });

    const rule = insertRule({ name: "github-notifications", enabled: true });
    const run = await createExecutionRun({
      sourceType: "rule",
      ruleId: rule.id,
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      status: "applied",
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-rule",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["UNREAD"],
    });

    const result = await undoRun(run.id);
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    const storedRule = sqlite
      .prepare("SELECT enabled FROM rules WHERE id = ?")
      .get(rule.id) as { enabled: number };

    expect(result.ruleDisabled).toBe(true);
    expect(result.ruleId).toBe(rule.id);
    expect(result.ruleName).toBe("github-notifications");
    expect(storedRule.enabled).toBe(0);
  });

  it("leaves already-disabled rules disabled and reports that no change was needed", async () => {
    insertEmail("msg-disabled", ["INBOX"], { isRead: true });
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-disabled",
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX"],
      status: "applied",
      appliedActions: [],
    });

    const rule = insertRule({ name: "already-disabled", enabled: false });
    const run = await createExecutionRun({
      sourceType: "rule",
      ruleId: rule.id,
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      status: "applied",
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-disabled",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: [],
    });

    const result = await undoRun(run.id);

    expect(result.status).toBe("undone");
    expect(result.ruleDisabled).toBe(false);
    expect(result.ruleId).toBe(rule.id);
    expect(result.ruleName).toBe("already-disabled");
    expect(result.warnings).toEqual([]);
  });
});

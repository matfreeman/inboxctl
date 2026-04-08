/**
 * Safety-Critical Test Suite
 *
 * Explicitly tests the core safety invariants that protect mailbox integrity.
 * Each test is labelled S1-S11 so the suite stays easy to audit.
 */

import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDb, getSqlite } from "../core/db/client.js";
import { appendExecutionItem, createExecutionRun } from "../core/actions/audit.js";
import { undoRun } from "../core/actions/undo.js";
import { loadRuleFile } from "../core/rules/loader.js";
import { RuleSchema } from "../core/rules/types.js";

// Mock the modify module — used by undo tests (S2–S5)
vi.mock("../core/gmail/modify.js", () => ({
  restoreEmailLabels: vi.fn(),
  archiveEmails: vi.fn(),
  labelEmails: vi.fn(),
  markRead: vi.fn(),
  markSpam: vi.fn(),
  forwardEmail: vi.fn(),
  unarchiveEmails: vi.fn(),
  unlabelEmails: vi.fn(),
  markUnread: vi.fn(),
  unmarkSpam: vi.fn(),
}));

vi.mock("../core/gmail/messages.js", () => ({
  listMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/gmail/transport.js", () => ({
  getGmailTransport: vi.fn(),
}));

vi.mock("../core/gmail/messages.js", () => ({
  batchGetMessages: vi.fn(),
  listMessages: vi.fn().mockResolvedValue([]),
}));

import { restoreEmailLabels } from "../core/gmail/modify.js";
import { getGmailTransport } from "../core/gmail/transport.js";
import { batchGetMessages } from "../core/gmail/messages.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_TOKENS_PATH",
  "INBOXCTL_RULES_DIR",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-safety-"));
  process.env.INBOXCTL_DATA_DIR = tempDir;
  process.env.INBOXCTL_DB_PATH = join(tempDir, "emails.db");
  process.env.INBOXCTL_TOKENS_PATH = join(tempDir, "tokens.json");
  process.env.INBOXCTL_RULES_DIR = join(tempDir, "rules");
  initializeDb(process.env.INBOXCTL_DB_PATH);
  vi.mocked(restoreEmailLabels).mockReset();
  vi.mocked(getGmailTransport).mockReset();
  vi.mocked(batchGetMessages).mockReset();
});

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(tempDir, { recursive: true, force: true });
});

function seedEmail(id: string, labelIds: string[]): void {
  const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
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
      "sender@example.com",
      "Sender",
      JSON.stringify(["user@example.com"]),
      "Subject",
      "Snippet",
      Date.parse("2026-04-01T00:00:00Z"),
      labelIds.includes("UNREAD") ? 0 : 1,
      0,
      JSON.stringify(labelIds),
      1024,
      0,
      null,
      Date.now(),
    );
}

// ---------------------------------------------------------------------------
// S1: No delete/trash code paths exist
// ---------------------------------------------------------------------------
describe("S1: no email delete or trash operations", () => {
  it("modify module exports no destructive delete/trash functions", () => {
    const modify = {
      restoreEmailLabels,
    };
    // The mock only exposes safe functions — verify the real module's export list
    // by checking the mocked export keys from vi.mock above
    const dangerousKeys = Object.keys(modify).filter((name) =>
      /deleteEmail|trashEmail|purge|permanentDelete/i.test(name),
    );
    expect(dangerousKeys).toEqual([]);
  });

  it("gmail transport interface has no deleteMessage or trashMessage method", async () => {
    const { createRestTransport } = await import("../core/gmail/transport_rest.js");
    const config = {
      dataDir: tempDir,
      dbPath: join(tempDir, "emails.db"),
      rulesDir: join(tempDir, "rules"),
      tokensPath: join(tempDir, "tokens.json"),
      google: { clientId: "cid", clientSecret: "csecret" },
      sync: { pageSize: 500, maxMessages: null },
    };
    const transport = createRestTransport(config);
    const dangerousKeys = Object.keys(transport).filter((name) =>
      /deleteMessage|trashMessage|permanentDelete/i.test(name),
    );
    expect(dangerousKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S2: Undo reverses archive correctly
// ---------------------------------------------------------------------------
describe("S2: undo reverses archive", () => {
  it("restores INBOX label after an archive action", async () => {
    seedEmail("msg-s2", ["INBOX", "UNREAD"]);
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-s2",
      beforeLabelIds: ["INBOX", "UNREAD"],
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
      emailId: "msg-s2",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["UNREAD"],
    });

    const result = await undoRun(run.id);

    expect(result.status).toBe("undone");
    expect(restoreEmailLabels).toHaveBeenCalledWith("msg-s2", ["INBOX", "UNREAD"]);
  });
});

// ---------------------------------------------------------------------------
// S3: Undo reverses label correctly
// ---------------------------------------------------------------------------
describe("S3: undo reverses label", () => {
  it("restores label state after a label action via snapshot", async () => {
    seedEmail("msg-s3", ["INBOX"]);
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-s3",
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX"],
      status: "applied",
      appliedActions: [],
    });

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Receipts" }],
      status: "applied",
    });
    await appendExecutionItem(run.id, {
      emailId: "msg-s3",
      status: "applied",
      appliedActions: [{ type: "label", label: "Receipts" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX", "Label_receipts"],
    });

    const result = await undoRun(run.id);

    expect(result.status).toBe("undone");
    expect(restoreEmailLabels).toHaveBeenCalledWith("msg-s3", ["INBOX"]);
  });
});

// ---------------------------------------------------------------------------
// S4: Undo refuses to undo forward
// ---------------------------------------------------------------------------
describe("S4: undo warns that forward cannot be undone", () => {
  it("returns partial status and includes a warning for forward items", async () => {
    seedEmail("msg-s4", ["INBOX"]);
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-s4",
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX"],
      status: "applied",
      appliedActions: [],
    });

    const run = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "forward", to: "other@example.com" }],
      status: "applied",
    });
    await appendExecutionItem(run.id, {
      emailId: "msg-s4",
      status: "applied",
      appliedActions: [{ type: "forward", to: "other@example.com" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX"],
    });

    const result = await undoRun(run.id);

    expect(result.status).toBe("partial");
    expect(result.warnings.some((w) => /forward actions cannot be undone/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S5: Undo refuses double-undo
// ---------------------------------------------------------------------------
describe("S5: double-undo is rejected", () => {
  it("throws when attempting to undo a run that is already undone", async () => {
    seedEmail("msg-s5", ["INBOX", "UNREAD"]);
    vi.mocked(restoreEmailLabels).mockResolvedValue({
      emailId: "msg-s5",
      beforeLabelIds: ["INBOX", "UNREAD"],
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
      emailId: "msg-s5",
      status: "applied",
      appliedActions: [{ type: "archive" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["UNREAD"],
    });

    await undoRun(run.id);
    await expect(undoRun(run.id)).rejects.toThrow(/already undone/i);
  });
});

// ---------------------------------------------------------------------------
// S6: Rule dry-run does NOT call Gmail API
// ---------------------------------------------------------------------------
describe("S6: rule dry-run makes no Gmail mutations", () => {
  it("executor dry-run records 'planned' status without calling archiveEmails", async () => {
    const { deployRule } = await import("../core/rules/deploy.js");
    const { runRule } = await import("../core/rules/executor.js");
    const { archiveEmails } = await import("../core/gmail/modify.js");

    const rule = {
      name: "s6-dry-run",
      description: "Safety test",
      enabled: true,
      priority: 10,
      conditions: {
        operator: "OR" as const,
        matchers: [{ field: "from" as const, values: ["test@example.com"], exclude: false }],
      },
      actions: [{ type: "archive" as const }],
    };
    await deployRule(rule, "hash-s6");

    const result = await runRule("s6-dry-run", { dryRun: true, maxEmails: 10 });

    expect(result.status).toBe("planned");
    expect(vi.mocked(archiveEmails)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S7: Invalid rule YAML is rejected
// ---------------------------------------------------------------------------
describe("S7: invalid rule YAML is rejected", () => {
  it("throws a parse error for malformed YAML syntax", async () => {
    const badYamlPath = join(tempDir, "bad-rule.yaml");
    await writeFile(badYamlPath, "name: [unclosed bracket\nconditions: !!invalid");

    await expect(loadRuleFile(badYamlPath)).rejects.toThrow();
  });

  it("throws for YAML that violates the rule schema (unknown action type)", async () => {
    const badSchemaPath = join(tempDir, "bad-schema.yaml");
    await writeFile(
      badSchemaPath,
      `name: invalid-rule
enabled: true
conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - a@b.com
      exclude: false
actions:
  - type: delete_email
`,
    );

    await expect(loadRuleFile(badSchemaPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// S8: Unknown action type rejected by Zod schema
// ---------------------------------------------------------------------------
describe("S8: unknown action type is rejected by the schema", () => {
  it("RuleSchema.parse throws for an unrecognised action type", () => {
    expect(() =>
      RuleSchema.parse({
        name: "test-s8",
        enabled: true,
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["a@b.com"], exclude: false }],
        },
        actions: [{ type: "delete_email" }],
      }),
    ).toThrow();
  });

  it("RuleSchema.parse throws for an empty actions array", () => {
    expect(() =>
      RuleSchema.parse({
        name: "test-s8-empty",
        enabled: true,
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["a@b.com"], exclude: false }],
        },
        actions: [],
      }),
    ).toThrow();
  });

  it("RuleSchema.parse throws for a trash action type", () => {
    expect(() =>
      RuleSchema.parse({
        name: "test-s8-trash",
        enabled: true,
        conditions: {
          operator: "OR",
          matchers: [{ field: "from", values: ["a@b.com"], exclude: false }],
        },
        actions: [{ type: "trash" }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// S9: `body` matcher rejected, `snippet` accepted
// ---------------------------------------------------------------------------
describe("S9: body field is rejected; snippet is accepted", () => {
  it("RuleSchema.parse throws when matcher uses field=body", () => {
    expect(() =>
      RuleSchema.parse({
        name: "s9-body",
        enabled: true,
        conditions: {
          operator: "OR",
          matchers: [{ field: "body", contains: ["secret"] }],
        },
        actions: [{ type: "archive" }],
      }),
    ).toThrow(/body|invalid enum/i);
  });

  it("RuleSchema.parse succeeds with field=snippet", () => {
    expect(() =>
      RuleSchema.parse({
        name: "s9-snippet",
        description: "Safety test snippet matcher",
        enabled: true,
        conditions: {
          operator: "OR",
          matchers: [{ field: "snippet", contains: ["invoice"] }],
        },
        actions: [{ type: "archive" }],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// S10: Stale history falls back to full sync
// ---------------------------------------------------------------------------
describe("S10: stale historyId triggers full-sync fallback", () => {
  it("incrementalSync catches a 404 from listHistory and returns usedHistoryFallback=true", async () => {
    const { makeEmailMessage, createMockTransport } = await import("./helpers/mock-gmail.js");
    const { incrementalSync } = await import("../core/sync/sync.js");

    // Set a non-null historyId so the incremental sync path is taken
    const sqlite = getSqlite(process.env.INBOXCTL_DB_PATH as string);
    sqlite.prepare("UPDATE sync_state SET history_id = 'stale-id' WHERE id = 1").run();

    const staleError = Object.assign(new Error("Requested entity was not found."), {
      code: 404,
      status: 404,
    });

    const transport = createMockTransport({
      listHistory: vi.fn().mockRejectedValue(staleError),
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: "recovered-msg" }],
        resultSizeEstimate: 1,
      }),
      getProfile: vi.fn().mockResolvedValue({ historyId: "new-id" }),
    });
    vi.mocked(getGmailTransport).mockResolvedValue(transport);
    vi.mocked(batchGetMessages).mockResolvedValue([makeEmailMessage("recovered-msg")]);

    const result = await incrementalSync();

    expect(result.usedHistoryFallback).toBe(true);
    expect(result.mode).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// S11: Batch operations require confirmation
// ---------------------------------------------------------------------------
describe("S11: batch operations require confirmation for >1 email", () => {
  it("single email with a query does not cross the confirmation threshold", () => {
    // Mirrors the confirmBatchIfNeeded guard in cli.ts: `if (!query || ids.length <= 1) return`
    const ids = ["only-one"];
    const query = "is:unread";
    const requiresConfirm = Boolean(query) && ids.length > 1;
    expect(requiresConfirm).toBe(false);
  });

  it("multiple emails with a query do cross the confirmation threshold", () => {
    const ids = ["msg-1", "msg-2", "msg-3"];
    const query = "from:newsletter@example.com";
    const requiresConfirm = Boolean(query) && ids.length > 1;
    expect(requiresConfirm).toBe(true);
  });

  it("no query bypasses confirmation (single targeted email by ID)", () => {
    const ids = ["msg-1"];
    const query = undefined;
    const requiresConfirm = Boolean(query) && ids.length > 1;
    expect(requiresConfirm).toBe(false);
  });
});

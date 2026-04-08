import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendExecutionItem, createExecutionRun } from "../actions/audit.js";
import { initializeDb } from "../db/client.js";
import { deployRule } from "./deploy.js";
import {
  getExecutionHistory,
  getExecutionRun,
  getExecutionRunItems,
  getExecutionStats,
} from "./history.js";
import type { Rule } from "./types.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-rules-history-"));
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

describe("rules history — additional coverage", () => {
  it("getExecutionHistory with no ruleId returns all recent runs", async () => {
    const run1 = await createExecutionRun({
      sourceType: "manual",
      dryRun: false,
      requestedActions: [{ type: "archive" }],
      status: "applied",
    });
    const run2 = await createExecutionRun({
      sourceType: "manual",
      dryRun: true,
      requestedActions: [{ type: "mark_read" }],
      status: "planned",
    });

    const history = await getExecutionHistory(undefined, 10);

    const ids = history.map((r) => r.id);
    expect(ids).toContain(run1.id);
    expect(ids).toContain(run2.id);
  });

  it("getExecutionRun returns null for a nonexistent run", async () => {
    const result = await getExecutionRun("nonexistent-id");
    expect(result).toBeNull();
  });

  it("getExecutionStats counts all status types correctly", async () => {
    for (const status of ["applied", "applied", "planned", "partial", "error", "undone"] as const) {
      await createExecutionRun({
        sourceType: "manual",
        dryRun: false,
        requestedActions: [{ type: "archive" }],
        status,
      });
    }

    const stats = await getExecutionStats();

    expect(stats.totalRuns).toBeGreaterThanOrEqual(6);
    expect(stats.appliedRuns).toBeGreaterThanOrEqual(2);
    expect(stats.plannedRuns).toBeGreaterThanOrEqual(1);
    expect(stats.partialRuns).toBeGreaterThanOrEqual(1);
    expect(stats.errorRuns).toBeGreaterThanOrEqual(1);
    expect(stats.undoneRuns).toBeGreaterThanOrEqual(1);
    expect(stats.lastExecutionAt).not.toBeNull();
  });
});

describe("rules history", () => {
  it("returns rule-scoped run history, run items, and aggregate stats", async () => {
    const rule: Rule = {
      name: "archive-notifications",
      description: "Archive notifications",
      enabled: true,
      priority: 10,
      conditions: {
        operator: "OR",
        matchers: [{ field: "from", values: ["notifications@example.com"], exclude: false }],
      },
      actions: [{ type: "archive" }],
    };

    const deployed = await deployRule(rule, "hash-1");
    const run = await createExecutionRun({
      sourceType: "rule",
      ruleId: deployed.id,
      dryRun: false,
      requestedActions: rule.actions,
      status: "applied",
    });

    await appendExecutionItem(run.id, {
      emailId: "msg-1",
      status: "applied",
      appliedActions: rule.actions,
      beforeLabelIds: ["INBOX"],
      afterLabelIds: [],
    });

    const history = await getExecutionHistory(deployed.id, 10);
    const loadedRun = await getExecutionRun(run.id);
    const items = await getExecutionRunItems(run.id);
    const stats = await getExecutionStats(deployed.id);

    expect(history.map((entry) => entry.id)).toEqual([run.id]);
    expect(loadedRun?.run.id).toBe(run.id);
    expect(items).toHaveLength(1);
    expect(stats).toMatchObject({
      totalRuns: 1,
      appliedRuns: 1,
      partialRuns: 0,
      errorRuns: 0,
      undoneRuns: 0,
    });
  });
});

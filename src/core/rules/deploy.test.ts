import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDb } from "../db/client.js";
import { createExecutionRun } from "../actions/audit.js";
import { loadRuleFile } from "./loader.js";
import {
  deployLoadedRule,
  deployRule,
  detectDrift,
  disableRule,
  enableRule,
  getAllRulesStatus,
  getRuleStatus,
  undeployRule,
} from "./deploy.js";

const envKeys = [
  "INBOXCTL_DATA_DIR",
  "INBOXCTL_DB_PATH",
  "INBOXCTL_RULES_DIR",
  "INBOXCTL_TOKENS_PATH",
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

let tempDir: string | null = null;

function ruleYaml(description = "Archive notifications") {
  return `
name: archive-notifications
description: ${description}
enabled: true
priority: 10
conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - notifications@example.com
actions:
  - type: archive
`;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "inboxctl-rules-deploy-"));
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

describe("rules deploy", () => {
  it("deploys new rules, reports unchanged redeploys, and toggles enabled state", async () => {
    const ruleFile = join(process.env.INBOXCTL_RULES_DIR as string, "archive-notifications.yaml");
    mkdirSync(process.env.INBOXCTL_RULES_DIR as string, { recursive: true });
    writeFileSync(ruleFile, ruleYaml());

    const loaded = await loadRuleFile(ruleFile);
    const created = await deployLoadedRule(loaded);
    const unchanged = await deployRule(loaded.rule, loaded.yamlHash);

    expect(created.status).toBe("created");
    expect(unchanged.status).toBe("unchanged");

    const disabled = await disableRule("archive-notifications");
    const enabled = await enableRule("archive-notifications");

    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);

    const status = await getRuleStatus("archive-notifications");
    expect(status?.name).toBe("archive-notifications");
    expect(status?.totalRuns).toBe(0);

    const allStatuses = await getAllRulesStatus();
    expect(allStatuses).toHaveLength(1);
  });

  it("detects changed and missing rule files and can undeploy rules", async () => {
    const ruleFile = join(process.env.INBOXCTL_RULES_DIR as string, "archive-notifications.yaml");
    mkdirSync(process.env.INBOXCTL_RULES_DIR as string, { recursive: true });
    writeFileSync(ruleFile, ruleYaml());

    const loaded = await loadRuleFile(ruleFile);
    await deployLoadedRule(loaded);
    await createExecutionRun({
      sourceType: "rule",
      ruleId: (await getRuleStatus("archive-notifications"))?.id,
      requestedActions: loaded.rule.actions,
      status: "applied",
    });

    writeFileSync(ruleFile, ruleYaml("Updated description"));
    let drift = await detectDrift(process.env.INBOXCTL_RULES_DIR as string);
    expect(drift.entries.find((entry) => entry.name === "archive-notifications")?.status).toBe("changed");

    await rm(ruleFile, { force: true });
    drift = await detectDrift(process.env.INBOXCTL_RULES_DIR as string);
    expect(drift.entries.find((entry) => entry.name === "archive-notifications")?.status).toBe("missing_file");

    await expect(undeployRule("archive-notifications")).resolves.toBe(true);
    await expect(getRuleStatus("archive-notifications")).resolves.toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import type { Action, Conditions, Rule } from "./types.js";
import { loadAllRules } from "./loader.js";

export interface DeployedRuleRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  yamlHash: string | null;
  conditions: Conditions;
  actions: Action[];
  priority: number;
  deployedAt: number | null;
  createdAt: number | null;
}

export type DeployStatus = "created" | "updated" | "unchanged";

export interface DeployResult extends DeployedRuleRecord {
  status: DeployStatus;
}

export interface RuleExecutionStats {
  totalRuns: number;
  plannedRuns: number;
  appliedRuns: number;
  partialRuns: number;
  errorRuns: number;
  undoneRuns: number;
  lastExecutionAt: number | null;
  lastExecutionStatus: string | null;
  lastRunId: string | null;
}

export interface RuleStatus extends DeployedRuleRecord, RuleExecutionStats {}

export interface DriftEntry {
  name: string;
  filePath?: string;
  fileHash?: string | null;
  deployedHash?: string | null;
  status: "in_sync" | "changed" | "missing_file" | "not_deployed";
}

export interface DriftReport {
  drifted: boolean;
  entries: DriftEntry[];
}

function getDatabase() {
  const config = loadConfig();
  return getSqlite(config.dbPath);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function rowToRule(row: {
  id: string;
  name: string;
  description: string | null;
  enabled: number | null;
  yamlHash: string | null;
  conditions: string;
  actions: string;
  priority: number | null;
  deployedAt: number | null;
  createdAt: number | null;
}): DeployedRuleRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    enabled: row.enabled !== 0,
    yamlHash: row.yamlHash,
    conditions: parseJson<Conditions>(row.conditions, { operator: "OR", matchers: [] }),
    actions: parseJson<Action[]>(row.actions, []),
    priority: row.priority ?? 50,
    deployedAt: row.deployedAt,
    createdAt: row.createdAt,
  };
}

function ruleSelectSql(whereClause: string = "", limitClause: string = ""): string {
  return `
      SELECT
        id,
        name,
        description,
        enabled,
        yaml_hash AS yamlHash,
        conditions,
        actions,
        priority,
        deployed_at AS deployedAt,
        created_at AS createdAt
      FROM rules
      ${whereClause}
      ORDER BY COALESCE(priority, 50) ASC, name ASC
      ${limitClause}
    `;
}

async function loadRuleRows(): Promise<DeployedRuleRecord[]> {
  const sqlite = getDatabase();
  const rows = sqlite.prepare(ruleSelectSql()).all() as Parameters<typeof rowToRule>[0][];
  return rows.map(rowToRule);
}

export async function getRuleByName(name: string): Promise<DeployedRuleRecord | null> {
  const trimmed = name.trim();

  if (!trimmed) {
    return null;
  }

  const sqlite = getDatabase();
  const row = sqlite
    .prepare(ruleSelectSql("WHERE name = ? OR id = ?", "LIMIT 1"))
    .get(trimmed, trimmed) as Parameters<typeof rowToRule>[0] | undefined;

  return row ? rowToRule(row) : null;
}

export async function getAllRules(): Promise<DeployedRuleRecord[]> {
  return loadRuleRows();
}

function upsertRule(rule: Rule, yamlHash: string): DeployResult {
  const sqlite = getDatabase();
  const existing = sqlite
    .prepare(ruleSelectSql("WHERE name = ?", "LIMIT 1"))
    .get(rule.name) as Parameters<typeof rowToRule>[0] | undefined;

  if (existing && existing.yamlHash === yamlHash) {
    return {
      ...rowToRule(existing),
      status: "unchanged",
    };
  }

  const now = Date.now();

  if (existing) {
    sqlite
      .prepare(
        `
        UPDATE rules
        SET description = ?, enabled = ?, yaml_hash = ?, conditions = ?, actions = ?, priority = ?, deployed_at = ?
        WHERE id = ?
        `,
      )
      .run(
        rule.description,
        rule.enabled ? 1 : 0,
        yamlHash,
        serializeJson(rule.conditions),
        serializeJson(rule.actions),
        rule.priority,
        now,
        existing.id,
      );
  } else {
    sqlite
      .prepare(
        `
        INSERT INTO rules (
          id, name, description, enabled, yaml_hash, conditions, actions, priority, deployed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        rule.name,
        rule.description,
        rule.enabled ? 1 : 0,
        yamlHash,
        serializeJson(rule.conditions),
        serializeJson(rule.actions),
        rule.priority,
        now,
        now,
      );
  }

  const refreshed = sqlite
    .prepare(ruleSelectSql("WHERE name = ?", "LIMIT 1"))
    .get(rule.name) as Parameters<typeof rowToRule>[0] | undefined;

  if (!refreshed) {
    throw new Error(`Failed to load deployed rule: ${rule.name}`);
  }

  return {
    ...rowToRule(refreshed),
    status: existing ? "updated" : "created",
  };
}

export async function deployRule(rule: Rule, yamlHash: string): Promise<DeployResult> {
  return upsertRule(rule, yamlHash);
}

export async function deployLoadedRule(loaded: { rule: Rule; yamlHash: string }): Promise<DeployResult> {
  return deployRule(loaded.rule, loaded.yamlHash);
}

export async function deployAllRules(rulesDir: string): Promise<DeployResult[]> {
  const loadedRules = await loadAllRules(rulesDir);
  const deployed: DeployResult[] = [];

  for (const entry of loadedRules) {
    deployed.push(await deployRule(entry.rule, entry.yamlHash));
  }

  return deployed;
}

export async function undeployRule(name: string): Promise<boolean> {
  const sqlite = getDatabase();
  const result = sqlite.prepare(`DELETE FROM rules WHERE name = ? OR id = ?`).run(name, name);
  return result.changes > 0;
}

async function getExecutionStatsByRuleId(ruleId: string): Promise<RuleExecutionStats> {
  const sqlite = getDatabase();
  const counts = sqlite
    .prepare(
      `
      SELECT
        COUNT(*) AS totalRuns,
        COALESCE(SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END), 0) AS plannedRuns,
        COALESCE(SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END), 0) AS appliedRuns,
        COALESCE(SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END), 0) AS partialRuns,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorRuns,
        COALESCE(SUM(CASE WHEN status = 'undone' THEN 1 ELSE 0 END), 0) AS undoneRuns,
        MAX(created_at) AS lastExecutionAt
      FROM execution_runs
      WHERE rule_id = ?
      `,
    )
    .get(ruleId) as
    | {
        totalRuns: number;
        plannedRuns: number;
        appliedRuns: number;
        partialRuns: number;
        errorRuns: number;
        undoneRuns: number;
        lastExecutionAt: number | null;
      }
    | undefined;

  const lastRun = sqlite
    .prepare(
      `
      SELECT id, status, created_at AS createdAt
      FROM execution_runs
      WHERE rule_id = ?
      ORDER BY COALESCE(created_at, 0) DESC, id DESC
      LIMIT 1
      `,
    )
    .get(ruleId) as { id: string; status: string; createdAt: number | null } | undefined;

  return {
    totalRuns: counts?.totalRuns ?? 0,
    plannedRuns: counts?.plannedRuns ?? 0,
    appliedRuns: counts?.appliedRuns ?? 0,
    partialRuns: counts?.partialRuns ?? 0,
    errorRuns: counts?.errorRuns ?? 0,
    undoneRuns: counts?.undoneRuns ?? 0,
    lastExecutionAt: counts?.lastExecutionAt ?? null,
    lastExecutionStatus: lastRun?.status ?? null,
    lastRunId: lastRun?.id ?? null,
  };
}

export async function getRuleStatus(name: string): Promise<RuleStatus | null> {
  const rule = await getRuleByName(name);

  if (!rule) {
    return null;
  }

  const stats = await getExecutionStatsByRuleId(rule.id);
  return {
    ...rule,
    ...stats,
  };
}

export async function getAllRulesStatus(): Promise<RuleStatus[]> {
  const rules = await loadRuleRows();
  const statuses = await Promise.all(
    rules.map(async (rule) => ({
      ...rule,
      ...(await getExecutionStatsByRuleId(rule.id)),
    })),
  );

  return statuses;
}

export async function detectDrift(rulesDir: string): Promise<DriftReport> {
  const loadedRules = await loadAllRules(rulesDir);
  const deployedRules = await loadRuleRows();
  const deployedByName = new Map(deployedRules.map((rule) => [rule.name, rule]));
  const fileByName = new Map(loadedRules.map((entry) => [entry.rule.name, entry]));
  const entries: DriftEntry[] = [];

  for (const entry of loadedRules) {
    const deployed = deployedByName.get(entry.rule.name);

    if (!deployed) {
      entries.push({
        name: entry.rule.name,
        filePath: entry.path,
        fileHash: entry.yamlHash,
        deployedHash: null,
        status: "not_deployed",
      });
      continue;
    }

    entries.push({
      name: entry.rule.name,
      filePath: entry.path,
      fileHash: entry.yamlHash,
      deployedHash: deployed.yamlHash,
      status: deployed.yamlHash === entry.yamlHash ? "in_sync" : "changed",
    });
  }

  for (const deployed of deployedRules) {
    if (fileByName.has(deployed.name)) {
      continue;
    }

    entries.push({
      name: deployed.name,
      deployedHash: deployed.yamlHash,
      status: "missing_file",
    });
  }

  return {
    drifted: entries.some((entry) => entry.status !== "in_sync"),
    entries,
  };
}

async function setRuleEnabled(name: string, enabled: boolean): Promise<DeployedRuleRecord> {
  const rule = await getRuleByName(name);

  if (!rule) {
    throw new Error(`Rule not found: ${name}`);
  }

  const sqlite = getDatabase();
  sqlite
    .prepare(
      `
      UPDATE rules
      SET enabled = ?
      WHERE id = ?
      `,
    )
    .run(enabled ? 1 : 0, rule.id);

  const refreshed = await getRuleByName(rule.id);

  if (!refreshed) {
    throw new Error(`Failed to refresh rule after update: ${name}`);
  }

  return refreshed;
}

export async function enableRule(name: string): Promise<DeployedRuleRecord> {
  return setRuleEnabled(name, true);
}

export async function disableRule(name: string): Promise<DeployedRuleRecord> {
  return setRuleEnabled(name, false);
}

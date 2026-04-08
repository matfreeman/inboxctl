import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import type { Action as RuleAction } from "../rules/types.js";

export type ExecutionSourceType = "manual" | "rule" | "unsubscribe";
export type ExecutionRunStatus = "planned" | "applied" | "partial" | "error" | "undone";
export type ExecutionItemStatus = "planned" | "applied" | "warning" | "error" | "undone";

export type AuditAction = RuleAction;

export interface CreateExecutionRunInput {
  id?: string;
  sourceType: ExecutionSourceType;
  ruleId?: string | null;
  dryRun?: boolean;
  requestedActions?: AuditAction[];
  query?: string | null;
  status?: ExecutionRunStatus;
  createdAt?: number;
  undoneAt?: number | null;
}

export interface AppendExecutionItemInput {
  id?: string;
  emailId: string;
  status: ExecutionItemStatus;
  appliedActions?: AuditAction[];
  beforeLabelIds: string[];
  afterLabelIds: string[];
  errorMessage?: string | null;
  executedAt?: number;
  undoneAt?: number | null;
}

export interface ExecutionRunRecord {
  id: string;
  sourceType: ExecutionSourceType;
  ruleId: string | null;
  dryRun: boolean;
  requestedActions: AuditAction[];
  query: string | null;
  status: ExecutionRunStatus;
  createdAt: number;
  undoneAt: number | null;
  itemCount: number;
  plannedItemCount: number;
  appliedItemCount: number;
  warningItemCount: number;
  errorItemCount: number;
  undoneItemCount: number;
}

export interface ExecutionItemRecord {
  id: string;
  runId: string;
  emailId: string;
  status: ExecutionItemStatus;
  appliedActions: AuditAction[];
  beforeLabelIds: string[];
  afterLabelIds: string[];
  errorMessage: string | null;
  executedAt: number;
  undoneAt: number | null;
}

function getDatabase() {
  const config = loadConfig();
  return getSqlite(config.dbPath);
}

function ensureValidSourceType(sourceType: string): asserts sourceType is ExecutionSourceType {
  if (sourceType !== "manual" && sourceType !== "rule" && sourceType !== "unsubscribe") {
    throw new Error(`Invalid execution source type: ${sourceType}`);
  }
}

function ensureValidRunStatus(status: string): asserts status is ExecutionRunStatus {
  if (status !== "planned" && status !== "applied" && status !== "partial" && status !== "error" && status !== "undone") {
    throw new Error(`Invalid execution run status: ${status}`);
  }
}

function ensureValidItemStatus(status: string): asserts status is ExecutionItemStatus {
  if (status !== "planned" && status !== "applied" && status !== "warning" && status !== "error" && status !== "undone") {
    throw new Error(`Invalid execution item status: ${status}`);
  }
}

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObjectArray(raw: string | null | undefined): AuditAction[] {
  return parseJsonArray<AuditAction>(raw, []);
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function rowToExecutionRun(row: {
  id: string;
  sourceType: string;
  ruleId: string | null;
  dryRun: number | null;
  requestedActions: string;
  query: string | null;
  status: string;
  createdAt: number | null;
  undoneAt: number | null;
  itemCount: number;
  plannedItemCount: number;
  appliedItemCount: number;
  warningItemCount: number;
  errorItemCount: number;
  undoneItemCount: number;
}): ExecutionRunRecord {
  ensureValidSourceType(row.sourceType);
  ensureValidRunStatus(row.status);

  return {
    id: row.id,
    sourceType: row.sourceType,
    ruleId: row.ruleId,
    dryRun: row.dryRun === 1,
    requestedActions: parseJsonObjectArray(row.requestedActions),
    query: row.query,
    status: row.status,
    createdAt: row.createdAt ?? 0,
    undoneAt: row.undoneAt ?? null,
    itemCount: row.itemCount,
    plannedItemCount: row.plannedItemCount,
    appliedItemCount: row.appliedItemCount,
    warningItemCount: row.warningItemCount,
    errorItemCount: row.errorItemCount,
    undoneItemCount: row.undoneItemCount,
  };
}

function rowToExecutionItem(row: {
  id: string;
  runId: string;
  emailId: string;
  status: string;
  appliedActions: string;
  beforeLabelIds: string;
  afterLabelIds: string;
  errorMessage: string | null;
  executedAt: number | null;
  undoneAt: number | null;
}): ExecutionItemRecord {
  ensureValidItemStatus(row.status);

  return {
    id: row.id,
    runId: row.runId,
    emailId: row.emailId,
    status: row.status,
    appliedActions: parseJsonObjectArray(row.appliedActions),
    beforeLabelIds: parseJsonArray<string>(row.beforeLabelIds, []),
    afterLabelIds: parseJsonArray<string>(row.afterLabelIds, []),
    errorMessage: row.errorMessage,
    executedAt: row.executedAt ?? 0,
    undoneAt: row.undoneAt ?? null,
  };
}

function queryRuns(
  whereClause: string = "",
  params: unknown[] = [],
  limit?: number,
): ExecutionRunRecord[] {
  const sqlite = getDatabase();
  const sql = `
    SELECT
      r.id AS id,
      r.source_type AS sourceType,
      r.rule_id AS ruleId,
      r.dry_run AS dryRun,
      r.requested_actions AS requestedActions,
      r.query AS query,
      r.status AS status,
      r.created_at AS createdAt,
      r.undone_at AS undoneAt,
      COUNT(i.id) AS itemCount,
      COALESCE(SUM(CASE WHEN i.status = 'planned' THEN 1 ELSE 0 END), 0) AS plannedItemCount,
      COALESCE(SUM(CASE WHEN i.status = 'applied' THEN 1 ELSE 0 END), 0) AS appliedItemCount,
      COALESCE(SUM(CASE WHEN i.status = 'warning' THEN 1 ELSE 0 END), 0) AS warningItemCount,
      COALESCE(SUM(CASE WHEN i.status = 'error' THEN 1 ELSE 0 END), 0) AS errorItemCount,
      COALESCE(SUM(CASE WHEN i.status = 'undone' THEN 1 ELSE 0 END), 0) AS undoneItemCount
    FROM execution_runs r
    LEFT JOIN execution_items i ON i.run_id = r.id
    ${whereClause}
    GROUP BY r.id
    ORDER BY COALESCE(r.created_at, 0) DESC, r.id DESC
    ${limit ? "LIMIT ?" : ""}
  `;

  const rows = limit === undefined
    ? sqlite.prepare(sql).all(...params)
    : sqlite.prepare(sql).all(...params, limit);

  return (rows as Parameters<typeof rowToExecutionRun>[0][]).map(rowToExecutionRun);
}

export async function createExecutionRun(
  input: CreateExecutionRunInput,
): Promise<ExecutionRunRecord> {
  ensureValidSourceType(input.sourceType);
  const sqlite = getDatabase();
  const now = input.createdAt ?? Date.now();
  const id = input.id ?? randomUUID();
  const status = input.status ?? "planned";
  ensureValidRunStatus(status);

  sqlite
    .prepare(
      `
      INSERT INTO execution_runs (
        id, source_type, rule_id, dry_run, requested_actions, query, status, created_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.sourceType,
      input.ruleId ?? null,
      input.dryRun ? 1 : 0,
      serializeJson(input.requestedActions ?? []),
      input.query ?? null,
      status,
      now,
      input.undoneAt ?? null,
    );

  return (await getRun(id)) as ExecutionRunRecord;
}

export async function appendExecutionItem(
  runId: string,
  input: AppendExecutionItemInput,
): Promise<ExecutionItemRecord> {
  const sqlite = getDatabase();
  const runExists = sqlite
    .prepare(`SELECT id FROM execution_runs WHERE id = ?`)
    .get(runId) as { id: string } | undefined;

  if (!runExists) {
    throw new Error(`Execution run not found: ${runId}`);
  }

  ensureValidItemStatus(input.status);
  const id = input.id ?? randomUUID();
  const executedAt = input.executedAt ?? Date.now();

  sqlite
    .prepare(
      `
      INSERT INTO execution_items (
        id, run_id, email_id, status, applied_actions, before_label_ids,
        after_label_ids, error_message, executed_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      runId,
      input.emailId,
      input.status,
      serializeJson(input.appliedActions ?? []),
      serializeJson(input.beforeLabelIds),
      serializeJson(input.afterLabelIds),
      input.errorMessage ?? null,
      executedAt,
      input.undoneAt ?? null,
    );

  const item = sqlite
    .prepare(
      `
      SELECT
        id,
        run_id AS runId,
        email_id AS emailId,
        status,
        applied_actions AS appliedActions,
        before_label_ids AS beforeLabelIds,
        after_label_ids AS afterLabelIds,
        error_message AS errorMessage,
        executed_at AS executedAt,
        undone_at AS undoneAt
      FROM execution_items
      WHERE id = ?
      `,
    )
    .get(id) as Parameters<typeof rowToExecutionItem>[0] | undefined;

  if (!item) {
    throw new Error(`Failed to load inserted execution item: ${id}`);
  }

  return rowToExecutionItem(item);
}

export async function addExecutionItems(
  runId: string,
  items: AppendExecutionItemInput[],
): Promise<ExecutionItemRecord[]> {
  const inserted: ExecutionItemRecord[] = [];

  for (const item of items) {
    inserted.push(await appendExecutionItem(runId, item));
  }

  return inserted;
}

export async function getRecentRuns(limit: number = 20): Promise<ExecutionRunRecord[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }

  return queryRuns("", [], limit);
}

export async function getRun(runId: string): Promise<ExecutionRunRecord | null> {
  const runs = queryRuns("WHERE r.id = ?", [runId], 1);
  return runs[0] ?? null;
}

export async function getRunItems(runId: string): Promise<ExecutionItemRecord[]> {
  const sqlite = getDatabase();
  const rows = sqlite
    .prepare(
      `
      SELECT
        id,
        run_id AS runId,
        email_id AS emailId,
        status,
        applied_actions AS appliedActions,
        before_label_ids AS beforeLabelIds,
        after_label_ids AS afterLabelIds,
        error_message AS errorMessage,
        executed_at AS executedAt,
        undone_at AS undoneAt
      FROM execution_items
      WHERE run_id = ?
      ORDER BY COALESCE(executed_at, 0) ASC, id ASC
      `,
    )
    .all(runId) as Parameters<typeof rowToExecutionItem>[0][];

  return rows.map(rowToExecutionItem);
}

export async function getRunsByEmail(emailId: string): Promise<ExecutionRunRecord[]> {
  return queryRuns(
    "WHERE EXISTS (SELECT 1 FROM execution_items i2 WHERE i2.run_id = r.id AND i2.email_id = ?)",
    [emailId],
  );
}

export async function getRunsByRule(ruleId: string): Promise<ExecutionRunRecord[]> {
  return queryRuns("WHERE r.rule_id = ?", [ruleId]);
}

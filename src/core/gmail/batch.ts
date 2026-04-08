import { loadConfig, type Config } from "../../config.js";
import {
  addExecutionItems,
  createExecutionRun,
  type AuditAction,
  type ExecutionSourceType,
  type ExecutionItemStatus,
  type ExecutionRunStatus,
} from "../actions/audit.js";
import { getSqlite } from "../db/client.js";
import { createLabel } from "./labels.js";
import { parseMessage } from "./messages.js";
import {
  archiveEmails,
  labelEmails,
  markRead,
  markSpam,
} from "./modify.js";
import type {
  EmailMessage,
  GmailModifyItemResult,
  RawGmailMessage,
} from "./types.js";
import { getGmailTransport } from "./transport.js";
import type { GmailTransport } from "./transport.js";
import type { Action } from "../rules/types.js";

const MESSAGE_FETCH_HEADERS = ["From", "To", "Subject", "Date", "List-Unsubscribe"];

export type BatchAction = Extract<Action, { type: "archive" | "label" | "mark_read" | "mark_spam" }>;

export interface BatchActionGroupInput {
  emailIds: string[];
  actions: BatchAction[];
}

export interface BatchApplyActionsOptions {
  groups: BatchActionGroupInput[];
  dryRun?: boolean;
  sourceType?: ExecutionSourceType;
  query?: string | null;
  config?: Config;
  transport?: GmailTransport;
}

export interface BatchApplyGroupResult {
  emailCount: number;
  actionsApplied: string[];
  status: ExecutionRunStatus;
}

export interface BatchApplyActionsResult {
  runId: string | null;
  dryRun: boolean;
  groups: BatchApplyGroupResult[];
  totalEmailsAffected: number;
  undoAvailable: boolean;
}

interface BatchContext {
  config: Config;
  transport: GmailTransport;
}

interface EmailRow {
  id: string;
  thread_id: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  subject: string | null;
  snippet: string | null;
  date: number | null;
  is_read: number | null;
  is_starred: number | null;
  label_ids: string | null;
  size_estimate: number | null;
  has_attachments: number | null;
  list_unsubscribe: string | null;
}

interface BatchExecutionItem {
  emailId: string;
  status: ExecutionItemStatus;
  appliedActions: AuditAction[];
  beforeLabelIds: string[];
  afterLabelIds: string[];
  errorMessage: string | null;
}

interface GroupExecutionResult {
  summary: BatchApplyGroupResult;
  items: BatchExecutionItem[];
}

function makePlaceholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToEmail(row: EmailRow): EmailMessage {
  return {
    id: row.id,
    threadId: row.thread_id || "",
    fromAddress: row.from_address || "",
    fromName: row.from_name || "",
    toAddresses: parseJsonArray(row.to_addresses),
    subject: row.subject || "",
    snippet: row.snippet || "",
    date: row.date || 0,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    labelIds: parseJsonArray(row.label_ids),
    sizeEstimate: row.size_estimate || 0,
    hasAttachments: row.has_attachments === 1,
    listUnsubscribe: row.list_unsubscribe,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function actionSignature(action: BatchAction): string {
  switch (action.type) {
    case "label":
      return `label:${action.label}`;
    default:
      return action.type;
  }
}

function combineItemStatus(
  current: ExecutionItemStatus,
  next: GmailModifyItemResult["status"],
): ExecutionItemStatus {
  if (current === "error" || next === "error") {
    return "error";
  }

  if (current === "warning" || next === "warning") {
    return "warning";
  }

  return "applied";
}

function resolveExecutionStatus(items: BatchExecutionItem[], dryRun: boolean): ExecutionRunStatus {
  if (dryRun) {
    return "planned";
  }

  if (items.length === 0) {
    return "applied";
  }

  if (items.every((item) => item.status === "applied")) {
    return "applied";
  }

  if (items.some((item) => item.status === "applied" || item.status === "warning")) {
    return "partial";
  }

  return "error";
}

function normalizeGroups(groups: BatchActionGroupInput[]): BatchActionGroupInput[] {
  if (groups.length === 0) {
    throw new Error("Provide at least one action group.");
  }

  if (groups.length > 20) {
    throw new Error("A batch may contain at most 20 groups.");
  }

  const seenEmailIds = new Set<string>();

  return groups.map((group, index) => {
    const emailIds = uniqueStrings(group.emailIds);
    const actionMap = new Map<string, BatchAction>();

    for (const action of group.actions) {
      if (action.type === "label" && !action.label.trim()) {
        throw new Error(`Group ${index + 1}: label actions require a label name.`);
      }

      actionMap.set(actionSignature(action), action);
    }

    if (emailIds.length === 0) {
      throw new Error(`Group ${index + 1}: provide at least one email ID.`);
    }

    if (emailIds.length > 500) {
      throw new Error(`Group ${index + 1}: a group may contain at most 500 email IDs.`);
    }

    const actions = [...actionMap.values()];

    if (actions.length === 0) {
      throw new Error(`Group ${index + 1}: provide at least one action.`);
    }

    if (actions.length > 5) {
      throw new Error(`Group ${index + 1}: a group may contain at most 5 actions.`);
    }

    for (const emailId of emailIds) {
      if (seenEmailIds.has(emailId)) {
        throw new Error(`Email ${emailId} appears in more than one group. Each email may only be targeted once per batch.`);
      }

      seenEmailIds.add(emailId);
    }

    return {
      emailIds,
      actions,
    };
  });
}

async function resolveContext(options?: Pick<BatchApplyActionsOptions, "config" | "transport">): Promise<BatchContext> {
  const config = options?.config || loadConfig();
  const transport = options?.transport || (await getGmailTransport(config));
  return { config, transport };
}

function readSnapshotEmails(config: Config, ids: string[]): Map<string, EmailMessage> {
  const sqlite = getSqlite(config.dbPath);
  const rows = sqlite
    .prepare(
      `
      SELECT id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
             is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe
      FROM emails
      WHERE id IN (${makePlaceholders(ids)})
      `,
    )
    .all(...ids) as EmailRow[];

  return new Map(rows.map((row) => [row.id, rowToEmail(row)]));
}

async function fetchMissingSnapshotEmails(
  transport: GmailTransport,
  ids: string[],
  snapshots: Map<string, EmailMessage>,
): Promise<void> {
  const missingIds = ids.filter((id) => !snapshots.has(id));

  const fetched = await Promise.all(
    missingIds.map(async (id) => {
      const response = await transport.getMessage({
        id,
        format: "metadata",
        metadataHeaders: MESSAGE_FETCH_HEADERS,
      });

      if (!response.id) {
        throw new Error(`Gmail message not found: ${id}`);
      }

      return parseMessage(response as RawGmailMessage);
    }),
  );

  for (const email of fetched) {
    snapshots.set(email.id, email);
  }
}

async function loadSnapshots(
  ids: string[],
  context: BatchContext,
): Promise<Map<string, EmailMessage>> {
  const snapshots = readSnapshotEmails(context.config, ids);
  await fetchMissingSnapshotEmails(context.transport, ids, snapshots);
  return snapshots;
}

async function executeAction(
  action: BatchAction,
  emailIds: string[],
  context: BatchContext,
): Promise<GmailModifyItemResult[]> {
  switch (action.type) {
    case "archive":
      return (await archiveEmails(emailIds, context)).items;
    case "label":
      await createLabel(action.label, undefined, context);
      return (await labelEmails(emailIds, action.label, context)).items;
    case "mark_read":
      return (await markRead(emailIds, context)).items;
    case "mark_spam":
      return (await markSpam(emailIds, context)).items;
  }
}

async function executeGroup(
  group: BatchActionGroupInput,
  context: BatchContext,
  dryRun: boolean,
): Promise<GroupExecutionResult> {
  const summary: BatchApplyGroupResult = {
    emailCount: group.emailIds.length,
    actionsApplied: group.actions.map(actionSignature),
    status: dryRun ? "planned" : "applied",
  };

  if (dryRun) {
    return {
      summary,
      items: [],
    };
  }

  const items = group.emailIds.map<BatchExecutionItem>((emailId) => ({
    emailId,
    status: "applied",
    appliedActions: [],
    beforeLabelIds: [],
    afterLabelIds: [],
    errorMessage: null,
  }));
  const itemMap = new Map(items.map((item) => [item.emailId, item]));

  try {
    const snapshots = await loadSnapshots(group.emailIds, context);

    for (const emailId of group.emailIds) {
      const snapshot = snapshots.get(emailId);
      const item = itemMap.get(emailId);

      if (!item) {
        continue;
      }

      if (!snapshot) {
        item.status = "error";
        item.errorMessage = `Unable to resolve Gmail message snapshot for ${emailId}`;
        continue;
      }

      item.beforeLabelIds = [...snapshot.labelIds];
      item.afterLabelIds = [...snapshot.labelIds];
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    for (const item of items) {
      item.status = "error";
      item.errorMessage = message;
    }

    summary.status = resolveExecutionStatus(items, false);
    return { summary, items };
  }

  for (const action of group.actions) {
    const activeIds = items
      .filter((item) => item.status !== "error")
      .map((item) => item.emailId);

    if (activeIds.length === 0) {
      break;
    }

    try {
      const results = await executeAction(action, activeIds, context);
      const resultMap = new Map(results.map((result) => [result.emailId, result]));

      for (const emailId of activeIds) {
        const item = itemMap.get(emailId);

        if (!item) {
          continue;
        }

        const result = resultMap.get(emailId);

        if (!result) {
          item.status = "error";
          item.errorMessage = `Missing Gmail mutation result for ${emailId}`;
          continue;
        }

        item.status = combineItemStatus(item.status, result.status);
        item.afterLabelIds = [...result.afterLabelIds];
        item.appliedActions = [...item.appliedActions, ...result.appliedActions];
        item.errorMessage = result.errorMessage ?? item.errorMessage;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      for (const emailId of activeIds) {
        const item = itemMap.get(emailId);

        if (!item) {
          continue;
        }

        item.status = "error";
        item.errorMessage = message;
      }

      break;
    }
  }

  summary.status = resolveExecutionStatus(items, false);

  return {
    summary,
    items,
  };
}

function collectRequestedActions(groups: BatchActionGroupInput[]): AuditAction[] {
  const actions = new Map<string, AuditAction>();

  for (const group of groups) {
    for (const action of group.actions) {
      actions.set(actionSignature(action), action);
    }
  }

  return [...actions.values()];
}

export async function batchApplyActions(
  options: BatchApplyActionsOptions,
): Promise<BatchApplyActionsResult> {
  const groups = normalizeGroups(options.groups);
  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    const summaries = groups.map((group) => ({
      emailCount: group.emailIds.length,
      actionsApplied: group.actions.map(actionSignature),
      status: "planned" as const,
    }));

    return {
      runId: null,
      dryRun: true,
      groups: summaries,
      totalEmailsAffected: summaries.reduce((sum, group) => sum + group.emailCount, 0),
      undoAvailable: false,
    };
  }

  const context = await resolveContext(options);
  const summaries: BatchApplyGroupResult[] = [];
  const executionItems: BatchExecutionItem[] = [];

  for (const group of groups) {
    const result = await executeGroup(group, context, false);
    summaries.push(result.summary);
    executionItems.push(...result.items);
  }

  const status = resolveExecutionStatus(executionItems, false);
  const run = await createExecutionRun({
    sourceType: options.sourceType ?? "manual",
    dryRun: false,
    requestedActions: collectRequestedActions(groups),
    query: options.query ?? null,
    status,
  });

  await addExecutionItems(
    run.id,
    executionItems.map((item) => ({
      emailId: item.emailId,
      status: item.status,
      appliedActions: item.appliedActions,
      beforeLabelIds: item.beforeLabelIds,
      afterLabelIds: item.afterLabelIds,
      errorMessage: item.errorMessage,
    })),
  );

  return {
    runId: run.id,
    dryRun: false,
    groups: summaries,
    totalEmailsAffected: summaries.reduce((sum, group) => sum + group.emailCount, 0),
    undoAvailable: status === "applied" || status === "partial" || status === "error",
  };
}

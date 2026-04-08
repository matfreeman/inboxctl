import { loadConfig, type Config } from "../../config.js";
import {
  addExecutionItems,
  createExecutionRun,
  type ExecutionItemRecord,
  type ExecutionItemStatus,
  type ExecutionRunRecord,
  type ExecutionRunStatus,
} from "../actions/audit.js";
import {
  archiveEmails,
  forwardEmail,
  labelEmails,
  markRead,
  markSpam,
} from "../gmail/modify.js";
import type { GmailModifyItemResult } from "../gmail/types.js";
import { listMessages } from "../gmail/messages.js";
import type { GmailTransport } from "../gmail/transport.js";
import { getAllRules, getRuleByName, type DeployedRuleRecord } from "./deploy.js";
import { findMatchingEmails } from "./matcher.js";
import type { Action } from "./types.js";

export interface RunOptions {
  dryRun?: boolean;
  maxEmails?: number;
  query?: string;
  config?: Config;
  transport?: GmailTransport;
}

export interface RuleRunItem {
  emailId: string;
  fromAddress: string;
  subject: string;
  date: number;
  matchedFields: string[];
  status: ExecutionItemStatus;
  appliedActions: Action[];
  beforeLabelIds: string[];
  afterLabelIds: string[];
  errorMessage: string | null;
}

export interface RuleRunResult {
  rule: DeployedRuleRecord;
  dryRun: boolean;
  maxEmails: number;
  query: string | null;
  matchedCount: number;
  runId: string;
  run: ExecutionRunRecord;
  status: ExecutionRunStatus;
  items: RuleRunItem[];
  skipped?: boolean;
}

export interface RunAllRulesResult {
  dryRun: boolean;
  results: RuleRunResult[];
}

function resolveRunStatus(items: RuleRunItem[], dryRun: boolean): ExecutionRunStatus {
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

async function getQueryLimitedIds(
  query: string,
  maxEmails: number,
  options: Pick<RunOptions, "config" | "transport">,
): Promise<Set<string>> {
  if (options.transport) {
    const response = await options.transport.listMessages({
      query,
      maxResults: maxEmails,
    });

    return new Set(
      (response.messages || [])
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id)),
    );
  }

  const emails = await listMessages(query, maxEmails);
  return new Set(emails.map((email) => email.id));
}

async function loadMatchedItems(
  rule: DeployedRuleRecord,
  options: Required<Pick<RunOptions, "dryRun" | "maxEmails">> & Pick<RunOptions, "query" | "config" | "transport">,
): Promise<RuleRunItem[]> {
  const matches = await findMatchingEmails(rule, options.maxEmails);
  const allowedIds = options.query
    ? await getQueryLimitedIds(options.query, Math.max(options.maxEmails, 1), {
        config: options.config,
        transport: options.transport,
      })
    : null;

  const filtered = allowedIds
    ? matches.filter((match) => allowedIds.has(match.email.id))
    : matches;

  return filtered.slice(0, options.maxEmails).map((match) => ({
    emailId: match.email.id,
    fromAddress: match.email.fromAddress,
    subject: match.email.subject,
    date: match.email.date,
    matchedFields: match.matchedFields,
    status: options.dryRun ? "planned" : "applied",
    appliedActions: options.dryRun ? [] : [...rule.actions],
    beforeLabelIds: [...match.email.labelIds],
    afterLabelIds: [...match.email.labelIds],
    errorMessage: null,
  }));
}

async function executeAction(
  emailId: string,
  action: Action,
  options: Pick<RunOptions, "config" | "transport">,
): Promise<GmailModifyItemResult> {
  switch (action.type) {
    case "archive":
      return (await archiveEmails([emailId], options)).items[0] as GmailModifyItemResult;
    case "label":
      return (await labelEmails([emailId], action.label, options)).items[0] as GmailModifyItemResult;
    case "mark_read":
      return (await markRead([emailId], options)).items[0] as GmailModifyItemResult;
    case "forward":
      return (await forwardEmail(emailId, action.to, options)).items[0] as GmailModifyItemResult;
    case "mark_spam":
      return (await markSpam([emailId], options)).items[0] as GmailModifyItemResult;
  }
}

async function applyRuleActions(
  item: RuleRunItem,
  actions: Action[],
  options: Pick<RunOptions, "config" | "transport">,
): Promise<RuleRunItem> {
  let current = {
    ...item,
    appliedActions: [] as Action[],
  };

  for (const action of actions) {
    try {
      const result = await executeAction(item.emailId, action, options);
      current = {
        ...current,
        status: result.status,
        appliedActions: [...current.appliedActions, ...result.appliedActions],
        afterLabelIds: [...result.afterLabelIds],
        errorMessage: result.errorMessage ?? null,
      };

      if (result.status === "error") {
        break;
      }
    } catch (error) {
      current = {
        ...current,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      break;
    }
  }

  return current;
}

async function recordRuleRun(
  rule: DeployedRuleRecord,
  options: Required<Pick<RunOptions, "dryRun" | "maxEmails">> & Pick<RunOptions, "query">,
  items: RuleRunItem[],
): Promise<{ runId: string; run: ExecutionRunRecord; status: ExecutionRunStatus }> {
  const status = resolveRunStatus(items, options.dryRun);
  const run = await createExecutionRun({
    sourceType: "rule",
    ruleId: rule.id,
    dryRun: options.dryRun,
    requestedActions: rule.actions,
    query: options.query ?? null,
    status,
  });

  await addExecutionItems(
    run.id,
    items.map((item) => ({
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
    run,
    status,
  };
}

export async function runRule(name: string, options: RunOptions): Promise<RuleRunResult> {
  const dryRun = options.dryRun ?? true;
  const maxEmails = options.maxEmails ?? 100;
  const config = options.config ?? loadConfig();
  const rule = await getRuleByName(name);

  if (!rule) {
    throw new Error(`Rule not found: ${name}`);
  }

  if (!rule.enabled) {
    const run = await createExecutionRun({
      sourceType: "rule",
      ruleId: rule.id,
      dryRun,
      requestedActions: rule.actions,
      query: options.query ?? null,
      status: "planned",
    });

    return {
      rule,
      dryRun,
      maxEmails,
      query: options.query ?? null,
      matchedCount: 0,
      runId: run.id,
      run,
      status: "planned",
      items: [],
      skipped: true,
    };
  }

  const plannedItems = await loadMatchedItems(rule, {
    dryRun,
    maxEmails,
    query: options.query,
    config,
    transport: options.transport,
  });

  const items = dryRun
    ? plannedItems
    : await Promise.all(
        plannedItems.map((item) =>
          applyRuleActions(item, rule.actions, {
            config,
            transport: options.transport,
          }),
        ),
      );

  const recorded = await recordRuleRun(
    rule,
    {
      dryRun,
      maxEmails,
      query: options.query,
    },
    items,
  );

  return {
    rule,
    dryRun,
    maxEmails,
    query: options.query ?? null,
    matchedCount: items.length,
    runId: recorded.runId,
    run: recorded.run,
    status: recorded.status,
    items,
  };
}

export async function runAllRules(options: RunOptions): Promise<RunAllRulesResult> {
  const rules = (await getAllRules())
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  const results: RuleRunResult[] = [];

  for (const rule of rules) {
    results.push(await runRule(rule.name, options));
  }

  return {
    dryRun: options.dryRun ?? true,
    results,
  };
}

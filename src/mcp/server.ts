import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecentRuns } from "../core/actions/audit.js";
import { undoRun } from "../core/actions/undo.js";
import { loadConfig, getGoogleCredentialStatus } from "../config.js";
import { loadTokens } from "../core/auth/tokens.js";
import { initializeDb } from "../core/db/client.js";
import { batchApplyActions } from "../core/gmail/batch.js";
import { getGmailReadiness } from "../core/gmail/client.js";
import { cleanupEmptyLabels, createLabel, listLabels } from "../core/gmail/labels.js";
import { getMessage, listMessages } from "../core/gmail/messages.js";
import {
  archiveEmails,
  forwardEmail,
  labelEmails,
  markRead,
  markUnread,
  unlabelEmails,
} from "../core/gmail/modify.js";
import { getThread } from "../core/gmail/threads.js";
import { unsubscribe } from "../core/gmail/unsubscribe.js";
import { reviewCategorized, reviewCategorizedInputSchema } from "../core/stats/anomalies.js";
import { getLabelDistribution } from "../core/stats/labels.js";
import { getNewsletters } from "../core/stats/newsletters.js";
import { getNoiseSenders } from "../core/stats/noise.js";
import {
  QUERY_EMAILS_FIELD_SCHEMA,
  queryEmails,
  queryEmailsInputSchema,
} from "../core/stats/query.js";
import { getSenderStats, getTopSenders } from "../core/stats/sender.js";
import { getUncategorizedEmails } from "../core/stats/uncategorized.js";
import { getUncategorizedSenders } from "../core/stats/uncategorized-senders.js";
import { getUnsubscribeSuggestions } from "../core/stats/unsubscribe.js";
import { getInboxOverview, getVolumeByPeriod } from "../core/stats/volume.js";
import { getExecutionHistory, getExecutionStats } from "../core/rules/history.js";
import {
  deployRule,
  disableRule,
  enableRule,
  getAllRulesStatus,
} from "../core/rules/deploy.js";
import { parseRuleYaml, hashRule } from "../core/rules/loader.js";
import { runRule } from "../core/rules/executor.js";
import {
  createFilter,
  deleteFilter,
  getFilter,
  listFilters,
  undoFilters,
} from "../core/gmail/filters.js";
import { getRecentEmails } from "../core/sync/cache.js";
import { fullSync, getSyncStatus, incrementalSync } from "../core/sync/sync.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MCP_VERSION = "0.7.3";

export const MCP_TOOLS = [
  "search_emails",
  "get_email",
  "get_thread",
  "sync_inbox",
  "archive_emails",
  "label_emails",
  "mark_read",
  "batch_apply_actions",
  "forward_email",
  "undo_run",
  "undo_filters",
  "get_labels",
  "create_label",
  "cleanup_labels",
  "get_inbox_stats",
  "get_top_senders",
  "get_sender_stats",
  "get_newsletter_senders",
  "get_uncategorized_emails",
  "get_uncategorized_senders",
  "review_categorized",
  "query_emails",
  "get_noise_senders",
  "get_unsubscribe_suggestions",
  "unsubscribe",
  "deploy_rule",
  "list_rules",
  "run_rule",
  "enable_rule",
  "disable_rule",
  "list_filters",
  "get_filter",
  "create_filter",
  "delete_filter",
] as const;

export const MCP_RESOURCES = [
  "inbox://recent",
  "inbox://summary",
  "inbox://action-log",
  "schema://query-fields",
  "rules://deployed",
  "rules://history",
  "stats://senders",
  "stats://overview",
] as const;

export const MCP_PROMPTS = [
  "summarize-inbox",
  "review-senders",
  "find-newsletters",
  "suggest-rules",
  "triage-inbox",
  "categorize-emails",
] as const;

export interface McpServerContract {
  transport: "stdio";
  tools: readonly string[];
  resources: readonly string[];
  prompts: readonly string[];
  ready: true;
  warnings: string[];
}

function toTextResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: {
      result: value,
    },
  };
}

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    structuredContent: {
      error: {
        message,
      },
    },
    isError: true,
  };
}

function toolHandler<TArgs extends Record<string, unknown> | undefined>(
  handler: (args: TArgs) => Promise<unknown>,
) {
  return async (args: TArgs) => {
    try {
      return toTextResult(await handler(args));
    } catch (error) {
      return toErrorResult(error);
    }
  };
}

function resourceText(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function promptResult(description: string, text: string) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

function buildSearchQuery(query: string, label?: string): string {
  const trimmedQuery = query.trim();
  const trimmedLabel = label?.trim();

  if (trimmedLabel) {
    return trimmedQuery ? `${trimmedQuery} label:${trimmedLabel}` : `label:${trimmedLabel}`;
  }

  return trimmedQuery;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean)));
}

function resolveResourceUri(uri: unknown, fallback: string): string {
  return typeof uri === "string" ? uri : fallback;
}

function formatActionSummary(action: {
  type: string;
  label?: string;
  to?: string;
}) {
  switch (action.type) {
    case "label":
      return action.label ? `label:${action.label}` : "label";
    case "forward":
      return action.to ? `forward:${action.to}` : "forward";
    default:
      return action.type;
  }
}

async function buildStartupWarnings(): Promise<string[]> {
  const config = loadConfig();
  initializeDb(config.dbPath);

  const warnings: string[] = [];
  const tokens = await loadTokens(config.tokensPath);
  const readiness = getGmailReadiness(config, tokens);
  const googleStatus = getGoogleCredentialStatus(config);
  const syncStatus = await getSyncStatus();
  const latestSync = Math.max(syncStatus.lastIncrementalSync ?? 0, syncStatus.lastFullSync ?? 0);

  if (!readiness.ready) {
    const missing = [
      ...googleStatus.missing,
      ...(tokens ? [] : ["gmail_tokens"]),
    ];
    warnings.push(
      `Gmail auth is incomplete (${missing.join(", ")}). Live Gmail MCP tools will fail until \`inboxctl auth login\` is complete.`,
    );
  }

  if (!latestSync) {
    warnings.push("Inbox cache has not been synced yet. Stats and resources will be empty until `sync_inbox` runs.");
  } else if (Date.now() - latestSync > DAY_MS) {
    warnings.push("Inbox cache appears stale (last sync older than 24 hours). Call `sync_inbox` if freshness matters.");
  }

  return warnings;
}

async function buildStatsOverview() {
  return {
    overview: await getInboxOverview(),
    topSenders: await getTopSenders({ limit: 10 }),
    labelDistribution: (await getLabelDistribution()).slice(0, 10),
    dailyVolume: await getVolumeByPeriod("day", {
      start: Date.now() - 30 * DAY_MS,
      end: Date.now(),
    }),
  };
}

async function buildRuleHistory() {
  const runs = await getExecutionHistory(undefined, 20);
  return {
    runs,
    recentRuns: await getRecentRuns(20),
  };
}

async function buildActionLog() {
  const recentRuns = await getRecentRuns(10);
  const stats = await getExecutionStats();

  return {
    recentRuns: recentRuns.map((run) => ({
      runId: run.id,
      createdAt: new Date(run.createdAt).toISOString(),
      sourceType: run.sourceType,
      dryRun: run.dryRun,
      status: run.status,
      emailCount: run.itemCount,
      actions: run.requestedActions.map(formatActionSummary),
      undoAvailable: !run.dryRun && run.undoneAt === null && run.status !== "planned" && run.status !== "undone" && run.itemCount > 0,
    })),
    totalRuns: stats.totalRuns,
  };
}

export async function createMcpServer(): Promise<{
  contract: McpServerContract;
  server: McpServer;
}> {
  const warnings = await buildStartupWarnings();
  const server = new McpServer({
    name: "inboxctl",
    version: MCP_VERSION,
  });

  server.registerTool(
    "search_emails",
    {
      description: "Search Gmail using Gmail query syntax and return matching email metadata.",
      inputSchema: {
        query: z.string().min(1),
        max_results: z.number().int().positive().max(100).optional(),
        label: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ query, max_results, label }) => {
      return listMessages(buildSearchQuery(query, label), max_results ?? 20);
    }),
  );

  server.registerTool(
    "get_email",
    {
      description: "Fetch a single email with full content by Gmail message ID.",
      inputSchema: {
        email_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ email_id }) => getMessage(email_id)),
  );

  server.registerTool(
    "get_thread",
    {
      description: "Fetch a full Gmail thread by thread ID.",
      inputSchema: {
        thread_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ thread_id }) => getThread(thread_id)),
  );

  server.registerTool(
    "sync_inbox",
    {
      description: "Run inbox sync. Uses incremental sync by default and full sync when requested.",
      inputSchema: {
        full: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    toolHandler(async ({ full }) => (full ? fullSync() : incrementalSync())),
  );

  server.registerTool(
    "archive_emails",
    {
      description: "Archive one or more Gmail messages by removing the INBOX label.",
      inputSchema: {
        email_ids: z.array(z.string().min(1)).min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ email_ids }) => archiveEmails(uniqueStrings(email_ids))),
  );

  server.registerTool(
    "label_emails",
    {
      description: "Add and/or remove Gmail labels on one or more messages.",
      inputSchema: {
        email_ids: z.array(z.string().min(1)).min(1),
        add_labels: z.array(z.string().min(1)).optional(),
        remove_labels: z.array(z.string().min(1)).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ email_ids, add_labels, remove_labels }) => {
      const ids = uniqueStrings(email_ids);
      const addLabels = uniqueStrings(add_labels);
      const removeLabels = uniqueStrings(remove_labels);

      if (addLabels.length === 0 && removeLabels.length === 0) {
        throw new Error("Provide at least one label to add or remove.");
      }

      const operations = [];

      for (const label of addLabels) {
        operations.push(await labelEmails(ids, label));
      }

      for (const label of removeLabels) {
        operations.push(await unlabelEmails(ids, label));
      }

      return {
        emailIds: ids,
        addLabels,
        removeLabels,
        operations,
      };
    }),
  );

  server.registerTool(
    "mark_read",
    {
      description: "Mark one or more Gmail messages as read or unread.",
      inputSchema: {
        email_ids: z.array(z.string().min(1)).min(1),
        read: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ email_ids, read }) => {
      const ids = uniqueStrings(email_ids);
      return read ? markRead(ids) : markUnread(ids);
    }),
  );

  server.registerTool(
    "batch_apply_actions",
    {
      description: "Apply grouped inbox actions in one call for faster AI-driven triage and categorization.",
      inputSchema: {
        groups: z.array(
          z.object({
            email_ids: z.array(z.string().min(1)).min(1).max(500),
            actions: z.array(
              z.discriminatedUnion("type", [
                z.object({
                  type: z.literal("label"),
                  label: z.string().min(1),
                }),
                z.object({ type: z.literal("archive") }),
                z.object({ type: z.literal("mark_read") }),
                z.object({ type: z.literal("mark_spam") }),
              ]),
            ).min(1).max(5),
          }),
        ).min(1).max(20),
        dry_run: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ groups, dry_run }) =>
      batchApplyActions({
        groups: groups.map((group) => ({
          emailIds: uniqueStrings(group.email_ids),
          actions: group.actions,
        })),
        dryRun: dry_run,
      })),
  );

  server.registerTool(
    "forward_email",
    {
      description: "Forward a Gmail message to another address.",
      inputSchema: {
        email_id: z.string().min(1),
        to: z.string().email(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ email_id, to }) => forwardEmail(email_id, to)),
  );

  server.registerTool(
    "undo_run",
    {
      description: "Undo a prior inboxctl action run when the underlying Gmail mutations are reversible.",
      inputSchema: {
        run_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ run_id }) => undoRun(run_id)),
  );

  server.registerTool(
    "undo_filters",
    {
      description:
        "Delete Gmail filters previously created by inboxctl during a specific execution run or session. This only affects future mail handling.",
      inputSchema: {
        run_id: z.string().min(1).optional(),
        session_id: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ run_id, session_id }) => {
      if (!run_id && !session_id) {
        throw new Error("run_id or session_id is required");
      }

      return undoFilters({
        runId: run_id,
        sessionId: session_id,
      });
    }),
  );

  server.registerTool(
    "get_labels",
    {
      description: "List Gmail labels with message and unread counts.",
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async () => listLabels()),
  );

  server.registerTool(
    "create_label",
    {
      description: "Create a Gmail label if it does not already exist.",
      inputSchema: {
        name: z.string().min(1),
        color: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ name, color }) => {
      const label = await createLabel(name);
      return {
        label,
        requestedColor: color ?? null,
        colorApplied: false,
        note: color ? "Color hints are not applied yet; the label was created with Gmail defaults." : null,
      };
    }),
  );

  server.registerTool(
    "cleanup_labels",
    {
      description:
        "Delete empty inboxctl-managed Gmail labels, typically after undoing a categorisation or cleanup session.",
      inputSchema: {
        prefix: z.string().min(1).optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ prefix, dry_run }) =>
      cleanupEmptyLabels({
        prefix,
        dryRun: dry_run,
      })),
  );

  server.registerTool(
    "get_inbox_stats",
    {
      description: "Return inbox overview counts from the local SQLite cache.",
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async () => getInboxOverview()),
  );

  server.registerTool(
    "get_top_senders",
    {
      description: "Return top senders ranked by cached email volume.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        min_unread_rate: z.number().min(0).max(100).optional(),
        period: z.enum(["day", "week", "month", "year", "all"]).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ limit, min_unread_rate, period }) =>
      getTopSenders({
        limit,
        minUnreadRate: min_unread_rate,
        period,
      })),
  );

  server.registerTool(
    "get_sender_stats",
    {
      description: "Return detailed stats for a sender email address or an @domain aggregate.",
      inputSchema: {
        email_or_domain: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ email_or_domain }) => {
      const result = await getSenderStats(email_or_domain);
      return {
        query: email_or_domain,
        found: result !== null,
        result,
      };
    }),
  );

  server.registerTool(
    "get_newsletter_senders",
    {
      description: "Return senders that look like newsletters or mailing lists based on cached heuristics.",
      inputSchema: {
        min_messages: z.number().int().positive().optional(),
        min_unread_rate: z.number().min(0).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ min_messages, min_unread_rate }) =>
      getNewsletters({
        minMessages: min_messages,
        minUnreadRate: min_unread_rate,
      })),
  );

  server.registerTool(
    "get_uncategorized_emails",
    {
      description: "Return cached emails that have only Gmail system labels and no user-applied organization.",
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional()
          .describe("Max emails to return per page. Default 50. AI clients should start with 50-100 and paginate."),
        offset: z.number().int().min(0).optional()
          .describe("Number of results to skip for pagination. Use with totalUncategorized and hasMore."),
        unread_only: z.boolean().optional(),
        since: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ limit, offset, unread_only, since }) =>
      getUncategorizedEmails({
        limit,
        offset,
        unreadOnly: unread_only,
        since,
      })),
  );

  server.registerTool(
    "get_uncategorized_senders",
    {
      description: "Return uncategorized emails grouped by sender so AI clients can categorize at sender-level instead of one email at a time.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional()
          .describe("Max senders per page. Default 100."),
        offset: z.number().int().min(0).optional()
          .describe("Number of senders to skip for pagination."),
        min_emails: z.number().int().positive().optional()
          .describe("Only include senders with at least this many uncategorized emails."),
        confidence: z.enum(["high", "medium", "low"]).optional()
          .describe("Filter senders by the confidence score inferred from sender signals."),
        since: z.string().min(1).optional()
          .describe("Only include uncategorized emails on or after this ISO date."),
        sort_by: z.enum(["email_count", "newest", "unread_rate"]).optional()
          .describe("Sort senders by email volume, most recent email, or unread rate."),
        include_email_ids: z.boolean().optional()
          .describe("Include emailIds for each sender. Defaults to false to keep payloads small. Only enable when you are about to act on a small batch."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ limit, offset, min_emails, confidence, since, sort_by, include_email_ids }) =>
      getUncategorizedSenders({
        limit,
        offset,
        minEmails: min_emails,
        confidence,
        since,
        sortBy: sort_by,
        includeEmailIds: include_email_ids,
      })),
  );

  server.registerTool(
    "review_categorized",
    {
      description: "Scan recently categorized emails for anomalies that suggest a misclassification or over-aggressive archive.",
      inputSchema: reviewCategorizedInputSchema.shape,
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async (args) => reviewCategorized(args)),
  );

  server.registerTool(
    "query_emails",
    {
      description: "Run structured analytics queries over the cached email dataset using fixed filters, groupings, and aggregates.",
      inputSchema: queryEmailsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async (args) => queryEmails(args)),
  );

  server.registerTool(
    "get_noise_senders",
    {
      description: "Return a focused list of active, high-noise senders worth categorizing, filtering, or unsubscribing.",
      inputSchema: {
        limit: z.number().int().positive().max(50).optional(),
        min_noise_score: z.number().min(0).optional(),
        active_days: z.number().int().positive().optional(),
        sort_by: z.enum(["noise_score", "all_time_noise_score", "message_count", "unread_rate"])
          .optional()
          .describe("Sort order. Default: noise_score. Use all_time_noise_score for lifetime perspective."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ limit, min_noise_score, active_days, sort_by }) =>
      getNoiseSenders({
        limit,
        minNoiseScore: min_noise_score,
        activeDays: active_days,
        sortBy: sort_by,
      })),
  );

  server.registerTool(
    "get_unsubscribe_suggestions",
    {
      description: "Return ranked senders with unsubscribe links, sorted by how much inbox noise unsubscribing would remove.",
      inputSchema: {
        limit: z.number().int().positive().max(50).optional(),
        min_messages: z.number().int().positive().optional(),
        unread_only_senders: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ limit, min_messages, unread_only_senders }) =>
      getUnsubscribeSuggestions({
        limit,
        minMessages: min_messages,
        unreadOnlySenders: unread_only_senders,
      })),
  );

  server.registerTool(
    "unsubscribe",
    {
      description: "Return the unsubscribe target for a sender and optionally label/archive existing emails in one undoable run.",
      inputSchema: {
        sender_email: z.string().min(1),
        also_archive: z.boolean().optional(),
        also_label: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ sender_email, also_archive, also_label }) =>
      unsubscribe({
        senderEmail: sender_email,
        alsoArchive: also_archive,
        alsoLabel: also_label,
      })),
  );

  server.registerTool(
    "deploy_rule",
    {
      description: "Validate and deploy a rule directly from YAML content.",
      inputSchema: {
        yaml_content: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ yaml_content }) => {
      const rule = parseRuleYaml(yaml_content, "<mcp:deploy_rule>");
      return deployRule(rule, hashRule(yaml_content));
    }),
  );

  server.registerTool(
    "list_rules",
    {
      description: "List deployed inboxctl rules and their execution status.",
      inputSchema: {
        enabled_only: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    toolHandler(async ({ enabled_only }) => {
      const rules = await getAllRulesStatus();
      return enabled_only ? rules.filter((rule) => rule.enabled) : rules;
    }),
  );

  server.registerTool(
    "run_rule",
    {
      description: "Run a deployed rule in dry-run mode by default, or apply it when dry_run is false.",
      inputSchema: {
        rule_name: z.string().min(1),
        dry_run: z.boolean().optional(),
        max_emails: z.number().int().positive().max(1000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ rule_name, dry_run, max_emails }) =>
      runRule(rule_name, {
        dryRun: dry_run,
        maxEmails: max_emails,
      })),
  );

  server.registerTool(
    "enable_rule",
    {
      description: "Enable a deployed rule by name.",
      inputSchema: {
        rule_name: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ rule_name }) => enableRule(rule_name)),
  );

  server.registerTool(
    "disable_rule",
    {
      description: "Disable a deployed rule by name.",
      inputSchema: {
        rule_name: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    toolHandler(async ({ rule_name }) => disableRule(rule_name)),
  );

  server.registerResource(
    "recent-inbox",
    "inbox://recent",
    {
      description: "Recent cached inbox email metadata.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "inbox://recent"), await getRecentEmails(50)),
  );

  server.registerResource(
    "inbox-summary",
    "inbox://summary",
    {
      description: "Inbox overview counts from the local cache.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "inbox://summary"), await getInboxOverview()),
  );

  server.registerResource(
    "inbox-action-log",
    "inbox://action-log",
    {
      description: "Recent action history showing what inboxctl already did and whether undo is still available.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "inbox://action-log"), await buildActionLog()),
  );

  server.registerResource(
    "query-fields",
    "schema://query-fields",
    {
      description: "Field vocabulary, aggregates, and examples for the query_emails analytics tool.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "schema://query-fields"), QUERY_EMAILS_FIELD_SCHEMA),
  );

  server.registerResource(
    "deployed-rules",
    "rules://deployed",
    {
      description: "All deployed rules with status and run counts.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "rules://deployed"), await getAllRulesStatus()),
  );

  server.registerResource(
    "rules-history",
    "rules://history",
    {
      description: "Recent execution run history across manual actions and rules.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "rules://history"), await buildRuleHistory()),
  );

  server.registerResource(
    "stats-senders",
    "stats://senders",
    {
      description: "Top cached senders ranked by message volume.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "stats://senders"), await getTopSenders({ limit: 20 })),
  );

  server.registerResource(
    "stats-overview",
    "stats://overview",
    {
      description: "Combined inbox overview, sender, label, and volume stats from the local cache.",
      mimeType: "application/json",
    },
    async (uri) => resourceText(resolveResourceUri(uri, "stats://overview"), await buildStatsOverview()),
  );

  server.registerPrompt(
    "summarize-inbox",
    {
      description: "Review inbox summary and recent mail, then suggest a short action plan.",
    },
    async () =>
      promptResult(
        "Summarize the inbox using inboxctl resources and tools.",
        [
          "Use `inbox://summary` and `inbox://recent` first.",
          "Summarize the current inbox state, call out anything urgent, and note sender or unread patterns.",
          "If the cache looks stale, suggest calling `sync_inbox` before drawing conclusions.",
          "Finish with 2-3 concrete actions the user could take now.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "review-senders",
    {
      description: "Review top senders and identify likely noise or cleanup opportunities.",
    },
    async () =>
      promptResult(
        "Review top senders and recommend cleanup actions.",
        [
          "Step 0 — Check for past mistakes:",
          "  Call `review_categorized` to see if any recent categorisations look incorrect.",
          "  If anomalies are found, present them first — fixing past mistakes takes priority over reviewing new senders.",
          "",
          "Step 1 — Gather data:",
          "  Use `get_noise_senders` for the most actionable noisy senders.",
          "  Use `rules://deployed` to check for existing rules covering these senders.",
          "  Use `get_unsubscribe_suggestions` for senders you can unsubscribe from.",
          "",
          "Step 2 — For each noisy sender, recommend one of:",
          "  KEEP — important, reduce noise with a label rule",
          "  RULE — create a rule to auto-label + mark read (or archive)",
          "  UNSUBSCRIBE — stop receiving entirely (has unsubscribe link, high unread rate)",
          "",
          "Step 3 — Present as a table:",
          "  Sender | Messages | Unread% | Noise Score | Has Unsub | Recommendation | Reason",
          "",
          "Step 4 — Offer to act:",
          "  For senders marked RULE, offer to generate YAML using the rule schema.",
          "  Group similar senders (e.g. all shipping senders) into one rule.",
          "  Present YAML for review before deploying with `deploy_rule`.",
          "  For senders marked UNSUBSCRIBE, use `unsubscribe` with `also_archive: true` and return the link for the user to follow.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "find-newsletters",
    {
      description: "Find likely newsletters and low-value bulk senders.",
    },
    async () =>
      promptResult(
        "Find newsletter-like senders and suggest which ones to keep versus clean up.",
        [
          "Use `get_newsletter_senders` and `get_top_senders` with a high unread threshold.",
          "Highlight senders with unsubscribe links, high unread rates, or obvious newsletter patterns.",
          "Separate likely keepers from likely unsubscribe/archive candidates.",
          "Suggest follow-up actions such as `archive_emails`, `label_emails`, or a new rule.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "suggest-rules",
    {
      description: "Suggest inboxctl YAML automation rules from observed inbox patterns.",
    },
    async () =>
      promptResult(
        "Analyze inbox patterns and propose valid inboxctl rule YAML.",
        [
          "First, inspect these data sources:",
          "- `rules://deployed` — existing rules (avoid duplicates)",
          "- `query_emails` — find high-volume domains, unread-heavy clusters, and labeling opportunities",
          "- `get_noise_senders` — high-volume low-read senders",
          "- `get_newsletter_senders` — detected newsletters and mailing lists",
          "",
          "Useful `query_emails` patterns before drafting rules:",
          "- `group_by: \"domain\"`, `aggregates: [\"count\", \"unread_rate\"]`, `having: { count: { gte: 20 } }`",
          "- `group_by: \"domain\"`, `aggregates: [\"count\", \"unread_rate\"]`, `having: { unread_rate: { gte: 80 } }`",
          "- Cross-check the results against `list_rules` and `list_filters` before proposing new automation.",
          "",
          "For each recommendation, generate complete YAML using this schema:",
          "",
          "  name: kebab-case-name          # lowercase, hyphens only",
          "  description: What this rule does",
          "  enabled: true",
          "  priority: 50                   # 0-100, lower = runs first",
          "  conditions:",
          "    operator: AND                # AND or OR",
          "    matchers:",
          "      - field: from              # from | to | subject | snippet | labels",
          "        contains:                # OR use: values (exact), pattern (regex)",
          "          - \"@example.com\"",
          "        exclude: false           # true to negate the match",
          "  actions:",
          "    - type: label                # label | archive | mark_read | forward | mark_spam",
          "      label: \"Category/Name\"",
          "    - type: mark_read",
          "    - type: archive",
          "",
          "Matcher fields: `from`, `to`, `subject`, `snippet`, `labels`.",
          "Match modes (provide exactly one per matcher): `values` (exact), `contains` (substring), `pattern` (regex).",
          "Action types: `label` (requires `label` field), `archive`, `mark_read`, `forward` (requires `to` field), `mark_spam`.",
          "",
          "Group related senders into a single rule where possible (e.g. all shipping notifications in one rule).",
          "Explain why each rule is safe. Default to `mark_read` + `label` over `archive` unless evidence is strong.",
          "Present the YAML so the user can review before deploying with `deploy_rule`.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "triage-inbox",
    {
      description: "Help categorize unread mail into action required, FYI, and noise.",
    },
    async () =>
      promptResult(
        "Triage unread mail using inboxctl data sources.",
        [
          "Step 1 — Gather data:",
          "  Use `get_uncategorized_emails` with `unread_only: true` for uncategorised unread mail.",
          "  Use `inbox://summary` for overall counts.",
          "  If totalUncategorized is large, process in pages rather than all at once.",
          "  If more context is needed on a specific email, use `get_email` or `get_thread`.",
          "",
          "Step 2 — Categorise each email into one of:",
          "  ACTION REQUIRED — needs a response or decision from the user",
          "  FYI — worth knowing about but no action needed",
          "  NOISE — bulk, promotional, or irrelevant",
          "",
          "Step 2.5 — Flag low-confidence items:",
          "  For any email with `confidence: \"low\"` in `senderContext`, always categorise it as ACTION REQUIRED.",
          "  Better to surface a false positive than bury a real personal or work email.",
          "",
          "Step 3 — Present findings:",
          "  List emails grouped by category with: sender, subject, and one-line reason.",
          "  For NOISE, suggest a label and whether to archive.",
          "  For FYI, suggest a label.",
          "  For ACTION REQUIRED, summarise what action seems needed.",
          "",
          "Step 4 — Offer to apply:",
          "  If the user approves, use `batch_apply_actions` to apply all decisions in one call.",
          "  Group emails by their action set (e.g. all `label:Receipts + mark_read` together).",
          "",
          "Step 5 — Offer noise reduction:",
          "  If NOISE senders appear repeatedly, suggest a rule or `unsubscribe` when a link is available.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "categorize-emails",
    {
      description: "Systematically categorise uncategorised emails using sender patterns, content, and inbox analytics.",
    },
    async () =>
      promptResult(
        "Categorise uncategorised emails in the user's inbox.",
        [
          "Step 1 — Gather data:",
          "  Use `get_uncategorized_senders` first (start with limit 100, leave `include_email_ids` unset).",
          "  This groups uncategorized emails by sender and keeps the initial payload small enough for large inbox backlogs.",
          "  Use `get_uncategorized_emails` only when you need to inspect specific emails from an ambiguous sender.",
          "  If totalSenders is more than 500, ask whether to process the recent batch or paginate through the full backlog.",
          "  Use `get_noise_senders` for sender context.",
          "  Use `get_unsubscribe_suggestions` for likely unsubscribe candidates.",
          "  Use `get_labels` to see what labels already exist.",
          "  Use `rules://deployed` to avoid duplicating existing automation.",
          "",
          "Step 2 — Assign each sender a category:",
          "  Receipts — purchase confirmations, invoices, payment notifications",
          "  Shipping — delivery tracking, dispatch notices, shipping updates",
          "  Newsletters — editorial content, digests, weekly roundups",
          "  Promotions — marketing, sales, deals, coupons",
          "  Social — social network notifications (LinkedIn, Facebook, etc.)",
          "  Notifications — automated alerts, system notifications, service updates",
          "  Finance — bank statements, investment updates, tax documents",
          "  Travel — bookings, itineraries, check-in reminders",
          "  Important — personal or work email requiring attention",
          "",
          "Step 3 — Present the categorisation plan:",
          "  Group senders by assigned category.",
          "  For each group show: sender count, total emails affected, senders involved, sample subjects.",
          "  Note confidence level: HIGH (clear pattern), MEDIUM (reasonable guess), LOW (uncertain).",
          "  Flag any LOW confidence senders for the user to decide.",
          "  Present the confidence breakdown: X HIGH (auto-apply), Y MEDIUM (label only), Z LOW (review queue).",
          "  If any LOW confidence senders are present, note why they were flagged from the `signals` array.",
          "",
          "Step 3.5 — Apply confidence gating:",
          "  HIGH confidence — safe to apply directly (label, mark_read, archive as appropriate).",
          "  MEDIUM confidence — apply the category label only. Do not archive. Keep the email visible in the inbox.",
          "  LOW confidence — apply only the label `inboxctl/Review`. Do not archive or mark read.",
          "  These senders need human review before any further action.",
          "",
          "Step 4 — Apply with user approval:",
          "  Create labels for any new categories (use `create_label`).",
          "  Before calling `batch_apply_actions`, fetch IDs only for the senders you are about to mutate.",
          "  Re-run `get_uncategorized_senders` with `include_email_ids: true` for a small page, or fetch the sender's specific messages separately.",
          "  Then call `batch_apply_actions`, grouping by action set and reusing just those retrieved email IDs.",
          "  For Newsletters and Promotions with high unread rates, suggest mark_read + archive or `unsubscribe` when a link is available.",
          "  For Receipts/Shipping/Notifications, suggest mark_read only (keep in inbox).",
          "  For Important, do not mark read or archive.",
          "",
          "Step 5 — Paginate if needed:",
          "  If hasMore is true, ask whether to continue with the next page using offset.",
          "  Each new page is a new set of senders, not more emails from the same senders.",
          "  Reuse the same sender categorisations on later pages instead of re-evaluating known senders.",
          "",
          "Step 6 — Suggest ongoing rules:",
          "  For any category with 3+ emails from the same sender, suggest a YAML rule.",
          "  This prevents the same categorisation from being needed again.",
          "  Use `deploy_rule` after user reviews the YAML.",
          "",
          "Step 7 — Post-categorisation audit:",
          "  After applying actions, call `review_categorized` to check for anomalies.",
          "  If anomalies are found, present them with the option to undo the relevant run.",
          "  If the user wants to fully unwind the session, suggest `undo_filters` for any Gmail filters created during it.",
          "  Suggest `cleanup_labels` after undoing runs to remove empty `inboxctl/*` labels.",
        ].join("\n"),
      ),
  );

  server.registerTool(
    "list_filters",
    {
      description:
        "List all Gmail server-side filters. These run automatically on incoming mail at delivery time — no client needed. For complex matching (regex, AND/OR, snippet), historical mail, or auditable/undoable operations, use YAML rules (list_rules) instead.",
    },
    toolHandler(async () => listFilters()),
  );

  server.registerTool(
    "get_filter",
    {
      description: "Get the details of a specific Gmail server-side filter by ID.",
      inputSchema: {
        filter_id: z.string().min(1).describe("Gmail filter ID"),
      },
    },
    toolHandler(async ({ filter_id }) => getFilter(filter_id)),
  );

  server.registerTool(
    "create_filter",
    {
      description:
        "Create a Gmail server-side filter that applies automatically to all future incoming mail. Useful for simple, always-on rules (e.g. 'label all mail from newsletter@x.com and archive it'). At least one criteria field and one action field are required. Gmail does not support updating filters — to change one, delete it and create a new one. For regex matching, OR conditions, snippet matching, or processing existing mail, use YAML rules instead.",
      inputSchema: {
        from: z.string().optional().describe("Match emails from this address"),
        to: z.string().optional().describe("Match emails sent to this address"),
        subject: z.string().optional().describe("Match emails with this text in the subject"),
        query: z.string().optional().describe("Match using Gmail search syntax (e.g. 'has:attachment')"),
        negated_query: z.string().optional().describe("Exclude emails matching this Gmail query"),
        has_attachment: z.boolean().optional().describe("Match emails with attachments"),
        exclude_chats: z.boolean().optional().describe("Exclude chat messages from matches"),
        size: z.number().int().positive().optional().describe("Size threshold in bytes"),
        size_comparison: z.enum(["larger", "smaller"]).optional().describe("Use with size: match emails larger or smaller than the threshold"),
        label: z.string().optional().describe("Apply this label to matching emails (auto-created if it does not exist)"),
        archive: z.boolean().optional().describe("Archive matching emails (remove from inbox)"),
        mark_read: z.boolean().optional().describe("Mark matching emails as read"),
        star: z.boolean().optional().describe("Star matching emails"),
        forward: z.string().email().optional().describe("Forward matching emails to this address (address must be verified in Gmail settings)"),
        run_id: z.string().optional().describe("Associate this filter with an inboxctl execution run for later undo_filters"),
        session_id: z.string().optional().describe("Associate this filter with an inboxctl session identifier for later undo_filters"),
      },
    },
    toolHandler(async (args) =>
      createFilter({
        from: args.from,
        to: args.to,
        subject: args.subject,
        query: args.query,
        negatedQuery: args.negated_query,
        hasAttachment: args.has_attachment,
        excludeChats: args.exclude_chats,
        size: args.size,
        sizeComparison: args.size_comparison,
        labelName: args.label,
        archive: args.archive,
        markRead: args.mark_read,
        star: args.star,
        forward: args.forward,
        runId: args.run_id,
        sessionId: args.session_id,
      }),
    ),
  );

  server.registerTool(
    "delete_filter",
    {
      description:
        "Delete a Gmail server-side filter by ID. The filter stops processing future mail immediately. Already-processed mail is not affected. Use list_filters to find filter IDs.",
      inputSchema: {
        filter_id: z.string().min(1).describe("Gmail filter ID to delete"),
        run_id: z.string().optional().describe("Associate this delete event with an inboxctl execution run"),
        session_id: z.string().optional().describe("Associate this delete event with an inboxctl session identifier"),
      },
    },
    toolHandler(async ({ filter_id, run_id, session_id }) => {
      await deleteFilter(filter_id, {
        runId: run_id,
        sessionId: session_id,
      });
      return { deleted: true, filter_id, run_id: run_id ?? null, session_id: session_id ?? null };
    }),
  );

  return {
    contract: {
      transport: "stdio",
      tools: MCP_TOOLS,
      resources: MCP_RESOURCES,
      prompts: MCP_PROMPTS,
      ready: true,
      warnings,
    },
    server,
  };
}

export async function startMcpServer(): Promise<McpServerContract> {
  const { contract, server } = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  for (const warning of contract.warnings) {
    console.error(`[inboxctl:mcp] ${warning}`);
  }

  return contract;
}

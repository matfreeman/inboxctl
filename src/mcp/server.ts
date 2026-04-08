import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getRecentRuns } from "../core/actions/audit.js";
import { undoRun } from "../core/actions/undo.js";
import { loadConfig, getGoogleCredentialStatus } from "../config.js";
import { loadTokens } from "../core/auth/tokens.js";
import { initializeDb } from "../core/db/client.js";
import { getGmailReadiness } from "../core/gmail/client.js";
import { createLabel, listLabels } from "../core/gmail/labels.js";
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
import { getLabelDistribution } from "../core/stats/labels.js";
import { getNewsletters } from "../core/stats/newsletters.js";
import { getSenderStats, getTopSenders } from "../core/stats/sender.js";
import { getInboxOverview, getVolumeByPeriod } from "../core/stats/volume.js";
import { getExecutionHistory } from "../core/rules/history.js";
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
} from "../core/gmail/filters.js";
import { getRecentEmails } from "../core/sync/cache.js";
import { fullSync, getSyncStatus, incrementalSync } from "../core/sync/sync.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MCP_VERSION = "0.1.0";

export const MCP_TOOLS = [
  "search_emails",
  "get_email",
  "get_thread",
  "sync_inbox",
  "archive_emails",
  "label_emails",
  "mark_read",
  "forward_email",
  "undo_run",
  "get_labels",
  "create_label",
  "get_inbox_stats",
  "get_top_senders",
  "get_sender_stats",
  "get_newsletter_senders",
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
          "Use `get_top_senders` and `stats://senders`.",
          "Focus on senders with high unread rates or high volume.",
          "For each notable sender, classify them as important, FYI, newsletter, or noise.",
          "Recommend one of: keep, unsubscribe, archive manually, or create a rule.",
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
          "Inspect `rules://deployed`, `stats://senders`, and `get_newsletter_senders` first.",
          "Look for ignored senders, repetitive notifications, and obvious auto-label opportunities.",
          "For each recommendation, explain why it is safe and include complete YAML the user could deploy with `deploy_rule`.",
          "Avoid risky suggestions when the evidence is weak.",
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
          "Use `inbox://recent`, `inbox://summary`, and `search_emails` for `is:unread` if needed.",
          "Group unread mail into ACTION REQUIRED, FYI, and NOISE.",
          "For NOISE, suggest batch actions or rules that would reduce future inbox load.",
          "Call out any assumptions when message bodies are unavailable.",
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
      },
    },
    toolHandler(async ({ filter_id }) => {
      await deleteFilter(filter_id);
      return { deleted: true, filter_id };
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

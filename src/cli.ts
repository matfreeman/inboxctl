import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  getGoogleCredentialStatus,
  loadConfig,
  type Config,
} from "./config.js";
import {
  createExecutionRun,
  addExecutionItems,
  getRecentRuns,
  getRunsByEmail,
} from "./core/actions/audit.js";
import { undoRun } from "./core/actions/undo.js";
import { startOAuthFlow } from "./core/auth/oauth.js";
import { isTokenExpired, loadTokens, saveTokens } from "./core/auth/tokens.js";
import { initializeDb } from "./core/db/client.js";
import { getGmailReadiness } from "./core/gmail/client.js";
import { createLabel, listLabels } from "./core/gmail/labels.js";
import { getMessage, listMessages } from "./core/gmail/messages.js";
import { getThread } from "./core/gmail/threads.js";
import {
  archiveEmails,
  forwardEmail,
  labelEmails,
  markRead,
} from "./core/gmail/modify.js";
import { unsubscribe } from "./core/gmail/unsubscribe.js";
import { reviewCategorized } from "./core/stats/anomalies.js";
import { getLabelDistribution } from "./core/stats/labels.js";
import { getNewsletters } from "./core/stats/newsletters.js";
import { getNoiseSenders } from "./core/stats/noise.js";
import { queryEmails } from "./core/stats/query.js";
import { getSenderStats, getTopSenders } from "./core/stats/sender.js";
import { getUncategorizedSenders } from "./core/stats/uncategorized-senders.js";
import { getUnsubscribeSuggestions } from "./core/stats/unsubscribe.js";
import { getInboxOverview, getVolumeByPeriod } from "./core/stats/volume.js";
import {
  deployAllRules,
  deployLoadedRule,
  detectDrift,
  disableRule,
  enableRule,
  getAllRulesStatus,
  getRuleStatus,
} from "./core/rules/deploy.js";
import { loadRuleFile } from "./core/rules/loader.js";
import { runAllRules, runRule } from "./core/rules/executor.js";
import {
  createFilter,
  deleteFilter,
  getFilter,
  listFilters,
} from "./core/gmail/filters.js";
import { runDemoSession } from "./core/demo/index.js";
import { runSetupWizard } from "./core/setup/setup.js";
import { getGmailTransport } from "./core/gmail/transport.js";
import { getRecentEmails } from "./core/sync/cache.js";
import {
  fullSync,
  getSyncStatus,
  incrementalSync,
  reconcileCacheForAuthenticatedAccount,
} from "./core/sync/sync.js";
import { startMcpServer } from "./mcp/server.js";
import { startTuiApp } from "./tui/app.js";
import type { Action } from "./core/rules/types.js";

const program = new Command();

interface RuntimeStatus {
  config: Config;
  tokensPresent: boolean;
  tokenExpired: boolean | null;
  googleConfigured: boolean;
  googleMissing: string[];
  gmailReady: boolean;
}

interface MutationItem {
  emailId: string;
  status: "planned" | "applied" | "warning" | "error" | "undone";
  beforeLabelIds: string[];
  afterLabelIds: string[];
  errorMessage?: string | null;
}

interface MutationResult {
  items: MutationItem[];
}

const colorEnabled = output.isTTY && process.env.NO_COLOR === undefined;

function ansi(code: number, value: string): string {
  return colorEnabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}

const ui = {
  bold: (value: string) => ansi(1, value),
  dim: (value: string) => ansi(2, value),
  cyan: (value: string) => ansi(36, value),
  green: (value: string) => ansi(32, value),
  yellow: (value: string) => ansi(33, value),
  red: (value: string) => ansi(31, value),
  magenta: (value: string) => ansi(35, value),
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  const visible = stripAnsi(value);

  if (visible.length >= width) {
    return value;
  }

  return `${value}${" ".repeat(width - visible.length)}`;
}

function printSection(title: string): void {
  console.log(ui.bold(title));
}

function printSimpleTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => stripAnsi(row[index] || "").length),
    ),
  );

  console.log(
    headers
      .map((header, index) => pad(ui.dim(header), widths[index] || header.length))
      .join("  "),
  );

  for (const row of rows) {
    console.log(
      row.map((cell, index) => pad(cell, widths[index] || cell.length)).join("  "),
    );
  }
}

function printKeyValue(label: string, value: string): void {
  console.log(`${ui.dim(`${label}:`)} ${value}`);
}

function formatStatus(status: MutationItem["status"] | "partial" | "noop"): string {
  const upper = status.toUpperCase();

  switch (status) {
    case "applied":
    case "undone":
      return ui.green(upper);
    case "warning":
    case "partial":
    case "noop":
      return ui.yellow(upper);
    case "error":
      return ui.red(upper);
    case "planned":
      return ui.cyan(upper);
  }
}

function hasLabelChange(item: MutationItem): boolean {
  return item.beforeLabelIds.join("\0") !== item.afterLabelIds.join("\0");
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

async function loadRuntimeStatus(): Promise<RuntimeStatus> {
  const config = loadConfig();
  initializeDb(config.dbPath);

  const tokens = await loadTokens(config.tokensPath);
  const googleStatus = getGoogleCredentialStatus(config);
  const gmailReadiness = getGmailReadiness(config, tokens);

  return {
    config,
    tokensPresent: tokens !== null,
    tokenExpired: tokens ? isTokenExpired(tokens) : null,
    googleConfigured: googleStatus.configured,
    googleMissing: googleStatus.missing,
    gmailReady: gmailReadiness.ready,
  };
}

function printCheckpointSummary(status: RuntimeStatus): void {
  printSection("Environment");
  printKeyValue("dataDir", status.config.dataDir);
  printKeyValue("dbPath", status.config.dbPath);
  printKeyValue("rulesDir", status.config.rulesDir);
  printKeyValue("tokensPath", status.config.tokensPath);
  printKeyValue(
    "googleCredentials",
    status.googleConfigured ? ui.green("configured") : ui.red("missing"),
  );
  printKeyValue("missingGoogleCredentials", formatList(status.googleMissing));
  printKeyValue("tokens", status.tokensPresent ? ui.green("present") : ui.red("missing"));
  printKeyValue(
    "tokenExpired",
    status.tokenExpired === null ? ui.dim("unknown (no tokens yet)") : status.tokenExpired ? ui.red("yes") : ui.green("no"),
  );
  printKeyValue("gmailReady", status.gmailReady ? ui.green("yes") : ui.red("no"));
}

function printGoogleCheckpointInstructions(status: RuntimeStatus): void {
  console.log("");
  console.log("Gmail access is not ready yet.");

  if (!status.googleConfigured) {
    console.log("Still needed:");
    console.log(`- GOOGLE_CLIENT_ID${status.googleMissing.includes("GOOGLE_CLIENT_ID") ? " (missing)" : ""}`);
    console.log(
      `- GOOGLE_CLIENT_SECRET${status.googleMissing.includes("GOOGLE_CLIENT_SECRET") ? " (missing)" : ""}`,
    );
    console.log("- OAuth consent screen configured in Google Cloud");
    console.log("- Localhost redirect URI allowed for the OAuth client");
    console.log("- Run `inboxctl setup` to configure this interactively");
    return;
  }

  if (!status.tokensPresent) {
    console.log("Google OAuth credentials are configured, but no Gmail account is authenticated yet.");
    console.log("- Run `inboxctl auth login` to sign in");
    return;
  }

  if (status.tokenExpired) {
    console.log("A Gmail account was authenticated before, but the saved token is expired or unusable.");
    console.log("- Run `inboxctl auth login` again");
    return;
  }

  console.log("Google OAuth is configured, but Gmail readiness still failed.");
  console.log("- Re-run `inboxctl auth login`");
}

async function requireLiveGmailReadiness(commandName: string): Promise<void> {
  const status = await loadRuntimeStatus();

  if (!status.gmailReady) {
    console.log(`${commandName} requires authenticated Gmail access.`);
    printCheckpointSummary(status);
    printGoogleCheckpointInstructions(status);
    process.exitCode = 1;
    return;
  }
}

async function resolveAuthenticatedEmail(config: Config): Promise<string | null> {
  const tokens = await loadTokens(config.tokensPath);

  if (!tokens) {
    return null;
  }

  if (tokens.email && tokens.email !== "unknown") {
    return tokens.email;
  }

  const transport = await getGmailTransport(config);
  const profile = await transport.getProfile();

  if (!profile.emailAddress) {
    return null;
  }

  await saveTokens(config.tokensPath, {
    ...tokens,
    email: profile.emailAddress,
  });

  return profile.emailAddress;
}

function formatEmailRow(email: {
  id: string;
  date: number;
  fromAddress: string;
  subject: string;
  isRead: boolean;
}): string {
  const state = pad(email.isRead ? ui.dim("read") : ui.yellow("unread"), 6);
  const date = ui.dim(new Date(email.date).toISOString().slice(0, 10));
  const sender = pad(truncate(email.fromAddress, 30), 30);
  const subject = truncate(email.subject, 58);
  const id = ui.dim(email.id);
  return `${state}  ${date}  ${sender}  ${subject} ${id}`;
}

function printEmailTableHeader(): void {
  console.log(
    [
      pad(ui.dim("STATE"), 6),
      ui.dim("DATE"),
      pad(ui.dim("FROM"), 30),
      ui.dim("SUBJECT"),
      ui.dim("ID"),
    ].join("  "),
  );
}

function formatTimestamp(value: number | null | undefined): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toISOString();
}

function formatDate(value: number | Date | null | undefined): string {
  if (!value) {
    return "-";
  }

  const timestamp = value instanceof Date ? value.getTime() : value;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatRelativeTime(value: number | Date | null | undefined): string {
  if (!value) {
    return "-";
  }

  const timestamp = value instanceof Date ? value.getTime() : value;
  const diff = Date.now() - timestamp;

  if (diff < 0) {
    return formatDate(timestamp);
  }

  if (diff < 60_000) {
    return `${Math.max(1, Math.floor(diff / 1_000))}s ago`;
  }

  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }

  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }

  if (diff < 604_800_000) {
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  if (diff < 2_592_000_000) {
    return `${Math.floor(diff / 604_800_000)}w ago`;
  }

  return formatDate(timestamp);
}

function formatPercent(value: number): string {
  const normalized = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  return `${normalized}%`;
}

function maybePrintJson(enabled: boolean | undefined, value: unknown): boolean {
  if (!enabled) {
    return false;
  }

  console.log(JSON.stringify(value, null, 2));
  return true;
}

function formatSenderIdentity(name: string, email: string, width: number): string {
  const identity = name && name !== email ? `${name} <${email}>` : email;
  return pad(truncate(identity, width), width);
}

function parseIntegerOption(value: string, label: string, min: number = 1): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer greater than or equal to ${min}.`);
  }

  return parsed;
}

function parsePercentOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${label} must be between 0 and 100.`);
  }

  return parsed;
}

function printInboxOverview(overview: Awaited<ReturnType<typeof getInboxOverview>>): void {
  printSection("Inbox Overview");
  printKeyValue("total", String(overview.total));
  printKeyValue("unread", overview.unread > 0 ? ui.yellow(String(overview.unread)) : ui.dim("0"));
  printKeyValue("starred", overview.starred > 0 ? ui.magenta(String(overview.starred)) : ui.dim("0"));
  printKeyValue(
    "today",
    `${overview.today.received} received, ${overview.today.unread} unread`,
  );
  printKeyValue(
    "thisWeek",
    `${overview.thisWeek.received} received, ${overview.thisWeek.unread} unread`,
  );
  printKeyValue(
    "thisMonth",
    `${overview.thisMonth.received} received, ${overview.thisMonth.unread} unread`,
  );
  printKeyValue(
    "oldestUnread",
    overview.oldestUnread
      ? `${formatRelativeTime(overview.oldestUnread)} (${formatDate(overview.oldestUnread)})`
      : "-",
  );
}

function printTopSendersTable(
  label: string,
  senders: Awaited<ReturnType<typeof getTopSenders>>,
): void {
  printSection(`Top Senders (${label})`);
  console.log(
    [
      pad(ui.dim("SENDER"), 42),
      pad(ui.dim("TOTAL"), 7),
      pad(ui.dim("UNREAD"), 8),
      pad(ui.dim("UNREAD%"), 8),
      ui.dim("LAST EMAIL"),
    ].join("  "),
  );

  for (const sender of senders) {
    console.log(
      [
        formatSenderIdentity(sender.name, sender.email, 42),
        pad(String(sender.totalMessages), 7),
        pad(String(sender.unreadMessages), 8),
        pad(formatPercent(sender.unreadRate), 8),
        formatRelativeTime(sender.lastEmailDate),
      ].join("  "),
    );
  }
}

function printNewslettersTable(
  newsletters: Awaited<ReturnType<typeof getNewsletters>>,
): void {
  printSection("Newsletters");
  console.log(
    [
      pad(ui.dim("SENDER"), 36),
      pad(ui.dim("TOTAL"), 7),
      pad(ui.dim("UNREAD"), 8),
      pad(ui.dim("UNREAD%"), 8),
      pad(ui.dim("STATUS"), 14),
      pad(ui.dim("LAST EMAIL"), 11),
      ui.dim("REASON"),
    ].join("  "),
  );

  for (const sender of newsletters) {
    const statusColor =
      sender.status === "active"
        ? ui.green(sender.status)
        : sender.status === "archived"
          ? ui.dim(sender.status)
          : ui.yellow(sender.status);

    console.log(
      [
        formatSenderIdentity(sender.name, sender.email, 36),
        pad(String(sender.messageCount), 7),
        pad(String(sender.unreadCount), 8),
        pad(formatPercent(sender.unreadRate), 8),
        pad(statusColor, 14),
        pad(formatRelativeTime(sender.lastSeen), 11),
        truncate(sender.detectionReason, 32),
      ].join("  "),
    );
  }
}

function printLabelDistributionTable(
  labels: Awaited<ReturnType<typeof getLabelDistribution>>,
): void {
  printSection("Label Distribution");
  console.log(
    [
      pad(ui.dim("LABEL"), 22),
      pad(ui.dim("TOTAL"), 7),
      pad(ui.dim("UNREAD"), 8),
      ui.dim("ID"),
    ].join("  "),
  );

  for (const label of labels) {
    console.log(
      [
        pad(truncate(label.labelName, 22), 22),
        pad(String(label.totalMessages), 7),
        pad(String(label.unreadMessages), 8),
        ui.dim(label.labelId),
      ].join("  "),
    );
  }
}

function printVolumeTable(
  label: string,
  points: Awaited<ReturnType<typeof getVolumeByPeriod>>,
): void {
  printSection(`Volume (${label})`);
  console.log(
    [
      pad(ui.dim("PERIOD"), 12),
      pad(ui.dim("RECEIVED"), 10),
      pad(ui.dim("READ"), 7),
      pad(ui.dim("UNREAD"), 8),
      ui.dim("ARCHIVED"),
    ].join("  "),
  );

  for (const point of points) {
    console.log(
      [
        pad(point.period, 12),
        pad(String(point.received), 10),
        pad(String(point.read), 7),
        pad(String(point.unread), 8),
        String(point.archived),
      ].join("  "),
    );
  }
}

function formatConfidence(confidence: "high" | "medium" | "low"): string {
  const upper = confidence.toUpperCase();

  switch (confidence) {
    case "high":
      return ui.green(upper);
    case "medium":
      return ui.yellow(upper);
    case "low":
      return ui.red(upper);
  }
}

function formatSeverity(severity: "high" | "medium"): string {
  return severity === "high" ? ui.red(severity.toUpperCase()) : ui.yellow(severity.toUpperCase());
}

function formatYesNo(value: boolean): string {
  return value ? ui.green("Yes") : ui.dim("No");
}

function formatImpactLevel(score: number): string {
  if (score >= 25) {
    return ui.red("HIGH");
  }

  if (score >= 10) {
    return ui.yellow("MEDIUM");
  }

  return ui.green("LOW");
}

function formatGenericCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  }

  return String(value);
}

function printNoiseSendersTable(
  result: Awaited<ReturnType<typeof getNoiseSenders>>,
): void {
  printSection(`Noise Senders (${result.senders.length})`);
  printSimpleTable(
    ["SENDER", "EMAILS", "UNREAD", "SCORE", "UNSUB?"],
    result.senders.map((sender) => [
      truncate(sender.name || sender.email, 34),
      String(sender.messageCount),
      formatPercent(sender.unreadRate),
      String(sender.noiseScore),
      formatYesNo(sender.hasUnsubscribeLink),
    ]),
  );
}

function printUncategorizedSendersTable(
  result: Awaited<ReturnType<typeof getUncategorizedSenders>>,
): void {
  printSection(`Uncategorized: ${result.totalEmails} emails from ${result.totalSenders} senders`);
  console.log("");
  printSimpleTable(
    ["CONFIDENCE", "SENDERS", "EMAILS"],
    [
      ["HIGH", String(result.summary.byConfidence.high.senders), String(result.summary.byConfidence.high.emails)],
      ["MEDIUM", String(result.summary.byConfidence.medium.senders), String(result.summary.byConfidence.medium.emails)],
      ["LOW", String(result.summary.byConfidence.low.senders), String(result.summary.byConfidence.low.emails)],
    ],
  );

  if (result.summary.topDomains.length > 0) {
    console.log("");
    printSection("Top Domains");
    printSimpleTable(
      ["DOMAIN", "EMAILS", "SENDERS"],
      result.summary.topDomains.map((domain) => [
        domain.domain,
        String(domain.emails),
        String(domain.senders),
      ]),
    );
  }

  console.log("");
  printSection("Top Senders");
  printSimpleTable(
    ["SENDER", "EMAILS", "UNREAD", "CONFIDENCE", "SIGNALS"],
    result.senders.map((sender) => [
      truncate(sender.name && sender.name !== sender.sender ? `${sender.name} <${sender.sender}>` : sender.sender, 36),
      String(sender.emailCount),
      formatPercent(sender.unreadRate),
      formatConfidence(sender.confidence),
      truncate(sender.signals.join(", "), 40),
    ]),
  );
}

function printUnsubscribeSuggestionsTable(
  result: Awaited<ReturnType<typeof getUnsubscribeSuggestions>>,
): void {
  printSection(`Unsubscribe Suggestions (${result.suggestions.length} candidates)`);
  printSimpleTable(
    ["SENDER", "EMAILS", "UNREAD", "IMPACT", "METHOD"],
    result.suggestions.map((sender) => [
      truncate(sender.name || sender.email, 34),
      String(sender.allTimeMessageCount),
      formatPercent(sender.unreadRate),
      formatImpactLevel(sender.impactScore),
      sender.unsubscribeMethod,
    ]),
  );
}

function printAnomaliesTable(
  result: Awaited<ReturnType<typeof reviewCategorized>>,
): void {
  printSection(result.summary);

  if (result.anomalies.length === 0) {
    return;
  }

  console.log("");
  printSimpleTable(
    ["SEVERITY", "SENDER", "SUBJECT", "LABEL", "RULE"],
    result.anomalies.map((anomaly) => [
      formatSeverity(anomaly.severity),
      truncate(anomaly.from, 24),
      truncate(anomaly.subject || "(no subject)", 32),
      truncate(anomaly.assignedLabel, 14),
      anomaly.rule,
    ]),
  );
}

function printQueryResult(
  result: Awaited<ReturnType<typeof queryEmails>>,
): void {
  printSection(`Query Results (${result.rows.length} of ${result.totalRows})`);

  if (result.rows.length === 0) {
    console.log("No rows matched that query.");
    return;
  }

  const headers = Object.keys(result.rows[0] || {});
  printSimpleTable(
    headers.map((header) => header.toUpperCase()),
    result.rows.map((row) => headers.map((header) => formatGenericCell(row[header]))),
  );
}

function printThreadResult(
  result: Awaited<ReturnType<typeof getThread>>,
): void {
  printSection(`Thread ${ui.dim(result.id)}`);
  printKeyValue("messages", String(result.messages.length));

  for (const message of result.messages) {
    console.log("");
    printSection(message.subject || "(no subject)");
    printKeyValue("from", message.fromAddress);
    printKeyValue("to", message.toAddresses.join(", "));
    printKeyValue("date", new Date(message.date).toISOString());
    printKeyValue("labels", message.labelIds.join(", ") || "-");
    console.log("");
    console.log(message.textPlain || message.body || message.snippet);
  }
}

function printSenderDetail(detail: NonNullable<Awaited<ReturnType<typeof getSenderStats>>>): void {
  printSection(detail.query);
  printKeyValue("type", detail.type);
  printKeyValue("name", detail.name);
  printKeyValue("messages", String(detail.totalMessages));
  printKeyValue("unread", `${detail.unreadMessages} (${formatPercent(detail.unreadRate)})`);
  printKeyValue("firstSeen", formatDate(detail.firstEmailDate));
  printKeyValue(
    "lastSeen",
    `${formatRelativeTime(detail.lastEmailDate)} (${formatDate(detail.lastEmailDate)})`,
  );
  printKeyValue("labels", detail.labels.join(", ") || "-");

  if (detail.type === "domain") {
    printKeyValue("matchedSenders", String(detail.matchingSenders.length));
    for (const sender of detail.matchingSenders) {
      console.log(`- ${sender}`);
    }
  }

  if (detail.recentEmails.length === 0) {
    return;
  }

  console.log("");
  printSection("Recent Emails");
  console.log(
    [
      pad(ui.dim("STATE"), 6),
      pad(ui.dim("DATE"), 10),
      pad(ui.dim("FROM"), 30),
      ui.dim("SUBJECT"),
    ].join("  "),
  );

  for (const email of detail.recentEmails) {
    console.log(
      [
        pad(email.isRead ? ui.dim("read") : ui.yellow("unread"), 6),
        pad(formatDate(email.date), 10),
        pad(truncate(email.fromAddress, 30), 30),
        truncate(email.subject || "(no subject)", 60),
      ].join("  "),
    );
  }
}

function getVolumeRange(period: "day" | "week" | "month"): { start: number; end: number } {
  const end = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  switch (period) {
    case "day":
      return { start: end - 30 * dayMs, end };
    case "week":
      return { start: end - 26 * 7 * dayMs, end };
    case "month":
      return { start: end - 365 * dayMs, end };
  }
}

function formatActions(actions: Action[]): string {
  if (actions.length === 0) {
    return "none";
  }

  return actions
    .map((action) => {
      switch (action.type) {
        case "label":
          return `label:${action.label}`;
        case "forward":
          return `forward:${action.to}`;
        case "archive":
          return "archive";
        case "mark_read":
          return "mark_read";
        case "mark_spam":
          return "mark_spam";
      }
    })
    .join(", ");
}

async function promptForConfirmation(message: string): Promise<boolean> {
  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function collectMessageIdsForQuery(query: string): Promise<string[]> {
  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const ids = new Set<string>();
  let pageToken: string | undefined;

  do {
    const response = await transport.listMessages({
      query,
      maxResults: 500,
      pageToken,
    });

    for (const message of response.messages || []) {
      if (message.id) {
        ids.add(message.id);
      }
    }

    pageToken = response.nextPageToken || undefined;
  } while (pageToken);

  return [...ids];
}

async function resolveMessageIds(id: string | undefined, query?: string): Promise<string[]> {
  if (query) {
    return collectMessageIdsForQuery(query);
  }

  if (!id) {
    throw new Error("Provide an email ID or use --query to target matching Gmail messages.");
  }

  return [id];
}

async function confirmBatchIfNeeded(query: string | undefined, ids: string[], verb: string): Promise<void> {
  if (!query || ids.length <= 1) {
    return;
  }

  const confirmed = await promptForConfirmation(
    `Found ${ids.length} emails matching "${query}"\n${verb} all ${ids.length} emails?`,
  );

  if (!confirmed) {
    throw new Error("Cancelled.");
  }
}

async function recordManualRun(options: {
  query?: string;
  requestedActions: Action[];
  result: MutationResult;
}): Promise<string> {
  const run = await createExecutionRun({
    sourceType: "manual",
    ruleId: null,
    dryRun: false,
    requestedActions: options.requestedActions,
    query: options.query || null,
    status: options.result.items.every((item) => item.status === "applied")
      ? "applied"
      : options.result.items.some((item) => item.status === "applied" || item.status === "warning")
        ? "partial"
        : "error",
  });

  await addExecutionItems(
    run.id,
    options.result.items.map((item) => ({
      emailId: item.emailId,
      status: item.status,
      appliedActions: options.requestedActions,
      beforeLabelIds: item.beforeLabelIds,
      afterLabelIds: item.afterLabelIds,
      errorMessage: item.errorMessage || null,
    })),
  );

  return run.id;
}

function printMutationSummary(result: MutationResult, runId: string): void {
  const applied = result.items.filter((item) => item.status === "applied").length;
  const warnings = result.items.filter((item) => item.status === "warning").length;
  const errors = result.items.filter((item) => item.status === "error").length;
  const noops = result.items.filter((item) => item.status === "applied" && !hasLabelChange(item)).length;

  printSection(`Run ${ui.dim(runId)}`);
  printKeyValue("total", String(result.items.length));
  printKeyValue("applied", ui.green(String(applied)));
  printKeyValue("noChange", noops > 0 ? ui.yellow(String(noops)) : ui.dim("0"));
  printKeyValue("warnings", warnings > 0 ? ui.yellow(String(warnings)) : ui.dim("0"));
  printKeyValue("errors", errors > 0 ? ui.red(String(errors)) : ui.dim("0"));
  console.log("");

  for (const item of result.items) {
    const displayStatus =
      item.status === "applied" && !hasLabelChange(item) ? "noop" : item.status;
    const line = [
      pad(formatStatus(displayStatus), 9),
      ui.dim(item.emailId),
      `${ui.dim("before")} ${item.beforeLabelIds.join(",") || "-"}`,
      `${ui.dim("after")} ${item.afterLabelIds.join(",") || "-"}`,
    ].join("  ");
    console.log(line);

    if (item.errorMessage) {
      console.log(`  ${ui.yellow("note")} ${item.errorMessage}`);
    }
  }
}

function printHistoryTable(runs: Awaited<ReturnType<typeof getRecentRuns>>): void {
  printSection("History");
  console.log(
    [
      pad(ui.dim("STATUS"), 10),
      pad(ui.dim("ACTION"), 20),
      pad(ui.dim("WHEN"), 22),
      pad(ui.dim("RUN ID"), 38),
      ui.dim("QUERY"),
    ].join("  "),
  );

  for (const run of runs) {
    console.log(
      [
        pad(formatStatus(run.status), 10),
        pad(truncate(formatActions(run.requestedActions), 20), 20),
        pad(ui.dim(formatTimestamp(run.createdAt)), 22),
        pad(ui.dim(run.id), 38),
        truncate(run.query || "-", 60),
      ].join("  "),
    );
  }
}

function formatEnabled(enabled: boolean): string {
  return enabled ? ui.green("enabled") : ui.yellow("disabled");
}

type RuleDeploySummaryInput =
  | Awaited<ReturnType<typeof deployAllRules>>
  | Awaited<ReturnType<typeof deployLoadedRule>>;

function printRuleDeploySummary(result: RuleDeploySummaryInput): void {
  const results = (Array.isArray(result) ? result : [result]) as Array<{
    status: "created" | "updated" | "unchanged";
    name: string;
    priority: number;
    enabled: boolean;
  }>;

  printSection("Rules Deployed");
  console.log(
    [
      pad(ui.dim("STATUS"), 10),
      pad(ui.dim("NAME"), 28),
      pad(ui.dim("PRIORITY"), 8),
      pad(ui.dim("ENABLED"), 10),
      ui.dim("FILE"),
    ].join("  "),
  );

  for (const entry of results) {
    const statusColor =
      entry.status === "created"
        ? ui.green(entry.status.toUpperCase())
        : entry.status === "updated"
          ? ui.yellow(entry.status.toUpperCase())
          : ui.dim(entry.status.toUpperCase());

    console.log(
      [
        pad(statusColor, 10),
        pad(entry.name, 28),
        pad(String(entry.priority), 8),
        pad(formatEnabled(entry.enabled), 10),
        truncate("-", 60),
      ].join("  "),
    );
  }
}

function printRuleStatusTable(rules: Awaited<ReturnType<typeof getAllRulesStatus>>): void {
  printSection("Rules");
  console.log(
    [
      pad(ui.dim("NAME"), 28),
      pad(ui.dim("STATE"), 10),
      pad(ui.dim("PRIORITY"), 8),
      pad(ui.dim("RUNS"), 6),
      pad(ui.dim("LAST RUN"), 22),
      ui.dim("ACTIONS"),
    ].join("  "),
  );

  for (const rule of rules) {
    console.log(
      [
        pad(truncate(rule.name, 28), 28),
        pad(formatEnabled(rule.enabled), 10),
        pad(String(rule.priority), 8),
        pad(String(rule.totalRuns), 6),
        pad(ui.dim(formatTimestamp(rule.lastExecutionAt)), 22),
        truncate(formatActions(rule.actions), 40),
      ].join("  "),
    );
  }
}

function printRuleStatusDetail(rule: NonNullable<Awaited<ReturnType<typeof getRuleStatus>>>): void {
  printSection(rule.name);
  printKeyValue("description", rule.description || "-");
  printKeyValue("enabled", formatEnabled(rule.enabled));
  printKeyValue("priority", String(rule.priority));
  printKeyValue("actions", formatActions(rule.actions));
  printKeyValue("totalRuns", String(rule.totalRuns));
  printKeyValue("appliedRuns", String(rule.appliedRuns));
  printKeyValue("partialRuns", String(rule.partialRuns));
  printKeyValue("errorRuns", String(rule.errorRuns));
  printKeyValue("undoneRuns", String(rule.undoneRuns));
  printKeyValue("lastRunId", rule.lastRunId ? ui.dim(rule.lastRunId) : "-");
  printKeyValue("lastExecutionAt", ui.dim(formatTimestamp(rule.lastExecutionAt)));
}

function printRuleRunResult(result: Awaited<ReturnType<typeof runRule>>): void {
  printSection(`Rule ${result.rule.name}`);
  printKeyValue("mode", result.dryRun ? ui.cyan("dry-run") : ui.green("apply"));
  printKeyValue("runId", ui.dim(result.runId));
  printKeyValue("status", formatStatus(result.status));
  printKeyValue("matched", String(result.matchedCount));
  printKeyValue("actions", formatActions(result.rule.actions));
  console.log("");

  if (result.items.length === 0) {
    console.log("No matching cached emails.");
    return;
  }

  for (const item of result.items) {
    const subject = truncate(item.subject || "(no subject)", 50);
    const from = truncate(item.fromAddress || "-", 28);
    const date = ui.dim(new Date(item.date).toISOString().slice(0, 10));
    console.log(
      [
        pad(formatStatus(item.status), 9),
        pad(from, 28),
        pad(date, 12),
        subject,
      ].join("  "),
    );
    console.log(`  ${ui.dim(item.emailId)} matched=${item.matchedFields.join(",") || "-"}`);

    if (item.errorMessage) {
      console.log(`  ${ui.yellow("note")} ${item.errorMessage}`);
    }
  }

  if (result.dryRun) {
    console.log("");
    console.log("Run again with `--apply` to execute these actions.");
  }
}

function printRunAllRulesResult(result: Awaited<ReturnType<typeof runAllRules>>): void {
  if (result.results.length === 0) {
    console.log("No enabled rules are currently deployed.");
    return;
  }

  for (const ruleResult of result.results) {
    printRuleRunResult(ruleResult);
    console.log("");
  }
}

function printDriftReport(result: Awaited<ReturnType<typeof detectDrift>>): void {
  printSection("Rule Drift");
  console.log(
    [
      pad(ui.dim("STATUS"), 14),
      pad(ui.dim("NAME"), 28),
      pad(ui.dim("DEPLOYED"), 16),
      pad(ui.dim("FILE"), 16),
      ui.dim("PATH"),
    ].join("  "),
  );

  for (const entry of result.entries) {
    const label =
      entry.status === "in_sync"
        ? ui.green("IN_SYNC")
        : entry.status === "changed"
          ? ui.yellow("CHANGED")
          : ui.red(entry.status.toUpperCase());

    console.log(
      [
        pad(label, 14),
        pad(truncate(entry.name, 28), 28),
        pad(truncate(entry.deployedHash || "-", 16), 16),
        pad(truncate(entry.fileHash || "-", 16), 16),
        truncate(entry.filePath || "-", 60),
      ].join("  "),
    );
  }
}

program
  .name("inboxctl")
  .description("CLI email management with MCP server, rules-as-code, and TUI")
  .version("0.7.3")
  .option("--demo", "Launch the seeded demo mailbox")
  .option("--no-sync", "Launch the TUI without running the initial background sync");

program
  .command("setup")
  .description("Run the interactive Google Cloud and OAuth setup wizard")
  .option("--skip-gcloud", "Skip gcloud detection and API enablement")
  .option("--project <id>", "Pre-set the Google Cloud project ID")
  .action(async (options) => {
    try {
      await runSetupWizard({
        skipGcloud: options.skipGcloud,
        project: options.project,
      });
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("login")
  .description("Authenticate with Gmail via OAuth2 (alias for auth login)")
  .action(async () => {
    const config = loadConfig();

    try {
      const result = await startOAuthFlow(config);
      const reconciliation = reconcileCacheForAuthenticatedAccount(
        config.dbPath,
        result.email,
        { clearLegacyUnscoped: true },
      );
      console.log(`Authenticated Gmail account: ${result.email}`);
      console.log(`Redirect URI used: ${result.redirectUri}`);
      if (reconciliation.cleared) {
        console.log("Local cache reset to avoid mixing data from another Gmail account.");
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      const status = await loadRuntimeStatus();
      printCheckpointSummary(status);
      printGoogleCheckpointInstructions(status);
      process.exitCode = 1;
    }
  });

const auth = program.command("auth").description("Gmail authentication");

auth
  .command("login")
  .description("Authenticate with Gmail via OAuth2")
  .action(async () => {
    const config = loadConfig();

    try {
      const result = await startOAuthFlow(config);
      const reconciliation = reconcileCacheForAuthenticatedAccount(
        config.dbPath,
        result.email,
        { clearLegacyUnscoped: true },
      );
      console.log(`Authenticated Gmail account: ${result.email}`);
      console.log(`Redirect URI used: ${result.redirectUri}`);
      if (reconciliation.cleared) {
        console.log("Local cache reset to avoid mixing data from another Gmail account.");
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      const status = await loadRuntimeStatus();
      printCheckpointSummary(status);
      printGoogleCheckpointInstructions(status);
      process.exitCode = 1;
    }
  });

auth
  .command("status")
  .description("Show authentication status")
  .action(async () => {
    const status = await loadRuntimeStatus();
    printCheckpointSummary(status);

    if (status.tokensPresent) {
      try {
        const email = await resolveAuthenticatedEmail(status.config);
        if (email) {
          console.log(`authenticatedEmail: ${email}`);
        }
      } catch (error) {
        console.log(
          `authenticatedEmail: unavailable (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }

    if (!status.gmailReady) {
      printGoogleCheckpointInstructions(status);
    }
  });

program
  .command("sync")
  .description("Sync emails from Gmail")
  .option("--full", "Force full sync (ignore incremental)")
  .action(async (options) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("sync");
      return;
    }

    const result = options.full
      ? await fullSync((synced, total) => {
          console.log(`synced=${synced}${total ? ` total=${total}` : ""}`);
        })
      : await incrementalSync();

    console.log(`mode: ${result.mode}`);
    console.log(`messagesProcessed: ${result.messagesProcessed}`);
    console.log(`historyId: ${result.historyId}`);
    console.log(`usedHistoryFallback: ${result.usedHistoryFallback ? "yes" : "no"}`);

    const syncStatus = await getSyncStatus();
    console.log(`cacheTotalMessages: ${syncStatus.totalMessages}`);
  });

program
  .command("inbox")
  .description("List recent inbox emails")
  .option("-n, --count <number>", "Number of emails to show", "20")
  .action(async (options) => {
    const emails = await getRecentEmails(Number(options.count));

    if (emails.length === 0) {
      console.log("No cached emails yet. Run `inboxctl sync` first.");
      return;
    }

    printSection("Inbox");
    printEmailTableHeader();
    for (const email of emails) {
      console.log(formatEmailRow(email));
    }
  });

program
  .command("search <query>")
  .description("Search emails using Gmail query syntax")
  .option("-n, --count <number>", "Max results", "20")
  .action(async (query, options) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("search");
      return;
    }

    const emails = await listMessages(query, Number(options.count));

    if (emails.length === 0) {
      console.log("No matching Gmail messages.");
      return;
    }

    printSection(`Search ${ui.dim(query)}`);
    printEmailTableHeader();
    for (const email of emails) {
      console.log(formatEmailRow(email));
    }
  });

program
  .command("email <id>")
  .description("View a single email")
  .action(async (id) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("email");
      return;
    }

    const email = await getMessage(id);
    printSection(email.subject || "Email");
    printKeyValue("from", email.fromAddress);
    printKeyValue("to", email.toAddresses.join(", "));
    printKeyValue("date", new Date(email.date).toISOString());
    printKeyValue("labels", email.labelIds.join(", ") || "-");
    console.log("");
    console.log(email.textPlain || email.body || email.snippet);
  });

program
  .command("thread <id>")
  .description("View a full email thread")
  .action(async (id) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("thread");
      return;
    }

    try {
      const thread = await getThread(id);
      printThreadResult(thread);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("archive [id]")
  .description("Archive email(s)")
  .option("-q, --query <query>", "Archive all emails matching query")
  .action(async (id, options) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("archive");
      return;
    }

    try {
      const ids = await resolveMessageIds(id, options.query);

      if (ids.length === 0) {
        console.log("No matching Gmail messages.");
        return;
      }

      await confirmBatchIfNeeded(options.query, ids, "Archive");
      const result = await archiveEmails(ids);
      const runId = await recordManualRun({
        query: options.query,
        requestedActions: [{ type: "archive" }],
        result,
      });
      printMutationSummary(result, runId);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("label <idOrLabel> [label]")
  .description("Apply label to email(s)")
  .option("-q, --query <query>", "Label all emails matching query")
  .action(async (idOrLabel, label, options) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("label");
      return;
    }

    const labelName = options.query ? label || idOrLabel : label;
    const id = options.query ? undefined : idOrLabel;

    if (!labelName) {
      console.log("Provide a label name.");
      process.exitCode = 1;
      return;
    }

    try {
      const ids = await resolveMessageIds(id, options.query);

      if (ids.length === 0) {
        console.log("No matching Gmail messages.");
        return;
      }

      await confirmBatchIfNeeded(options.query, ids, "Apply label to");
      const result = await labelEmails(ids, labelName);
      const runId = await recordManualRun({
        query: options.query,
        requestedActions: [{ type: "label", label: labelName }],
        result,
      });
      printMutationSummary(result, runId);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("read [id]")
  .description("Mark email(s) as read")
  .option("-q, --query <query>", "Mark all matching emails as read")
  .action(async (id, options) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("read");
      return;
    }

    try {
      const ids = await resolveMessageIds(id, options.query);

      if (ids.length === 0) {
        console.log("No matching Gmail messages.");
        return;
      }

      await confirmBatchIfNeeded(options.query, ids, "Mark as read");
      const result = await markRead(ids);
      const runId = await recordManualRun({
        query: options.query,
        requestedActions: [{ type: "mark_read" }],
        result,
      });
      printMutationSummary(result, runId);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("forward <id> <email>")
  .description("Forward email to another address")
  .action(async (id, email) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("forward");
      return;
    }

    try {
      const result = await forwardEmail(id, email);
      const runId = await recordManualRun({
        requestedActions: [{ type: "forward", to: email }],
        result,
      });
      printMutationSummary(result, runId);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("undo <run-id>")
  .description("Undo a previous action run")
  .action(async (runId) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("undo");
      return;
    }

    try {
      const result = await undoRun(runId);
      printSection(`Undo ${ui.dim(result.runId)}`);
      printKeyValue("status", formatStatus(result.status));
      printKeyValue("undone", ui.green(String(result.undoneCount)));
      printKeyValue("warnings", result.warningCount > 0 ? ui.yellow(String(result.warningCount)) : ui.dim("0"));
      printKeyValue("errors", result.errorCount > 0 ? ui.red(String(result.errorCount)) : ui.dim("0"));

      for (const warning of result.warnings) {
        console.log(`${ui.yellow("warning")} ${warning}`);
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("history")
  .description("Show recent run history")
  .option("-n, --count <number>", "Number of entries", "20")
  .option("--email <id>", "Filter by email ID")
  .action(async (options) => {
    const runs = options.email
      ? await getRunsByEmail(options.email)
      : await getRecentRuns(Number(options.count));

    if (runs.length === 0) {
      console.log("No action history yet.");
      return;
    }

    printHistoryTable(runs);
  });

program
  .command("query")
  .description("Run structured analytics queries over the cached inbox")
  .option("--group-by <dimension>", "Group by sender|domain|label|year_month|year_week|day_of_week|is_read|is_newsletter")
  .option("--aggregate <values...>", "Aggregates to return (count, unread_count, unread_rate, newest, oldest, sender_count)")
  .option("--from <address>", "Exact sender email")
  .option("--from-contains <text>", "Partial sender match")
  .option("--domain <domain>", "Exact sender domain")
  .option("--domain-contains <text>", "Partial sender domain match")
  .option("--subject-contains <text>", "Partial subject match")
  .option("--since <date>", "Filter to emails on or after this ISO date")
  .option("--before <date>", "Filter to emails on or before this ISO date")
  .option("--read", "Only read emails")
  .option("--unread", "Only unread emails")
  .option("--newsletter", "Only newsletter senders")
  .option("--without-newsletter", "Exclude newsletter senders")
  .option("--label <name>", "Only emails with a specific label")
  .option("--has-label", "Only emails with any user label")
  .option("--without-label", "Only emails with no user labels")
  .option("--has-unsubscribe", "Only emails with a List-Unsubscribe header")
  .option("--min-sender-messages <number>", "Only senders with at least this many total emails")
  .option("--having-count-gte <number>", "Require grouped count to be >= this value")
  .option("--having-count-lte <number>", "Require grouped count to be <= this value")
  .option("--having-unread-rate-gte <number>", "Require grouped unread_rate to be >= this value")
  .option("--sort <value>", "Sort expression, for example: \"count desc\"")
  .option("--limit <number>", "Maximum rows to return", "50")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      if (options.read && options.unread) {
        throw new Error("Use only one of --read or --unread.");
      }

      if (options.newsletter && options.withoutNewsletter) {
        throw new Error("Use only one of --newsletter or --without-newsletter.");
      }

      if (options.hasLabel && options.withoutLabel) {
        throw new Error("Use only one of --has-label or --without-label.");
      }

      const result = await queryEmails({
        filters: {
          ...(options.from ? { from: options.from } : {}),
          ...(options.fromContains ? { from_contains: options.fromContains } : {}),
          ...(options.domain ? { domain: options.domain } : {}),
          ...(options.domainContains ? { domain_contains: options.domainContains } : {}),
          ...(options.subjectContains ? { subject_contains: options.subjectContains } : {}),
          ...(options.since ? { date_after: options.since } : {}),
          ...(options.before ? { date_before: options.before } : {}),
          ...(options.read ? { is_read: true } : {}),
          ...(options.unread ? { is_read: false } : {}),
          ...(options.newsletter ? { is_newsletter: true } : {}),
          ...(options.withoutNewsletter ? { is_newsletter: false } : {}),
          ...(options.label ? { label: options.label } : {}),
          ...(options.hasLabel ? { has_label: true } : {}),
          ...(options.withoutLabel ? { has_label: false } : {}),
          ...(options.hasUnsubscribe ? { has_unsubscribe: true } : {}),
          ...(options.minSenderMessages
            ? { min_sender_messages: parseIntegerOption(options.minSenderMessages, "min-sender-messages") }
            : {}),
        },
        ...(options.groupBy ? { group_by: options.groupBy } : {}),
        ...(options.aggregate ? { aggregates: options.aggregate } : {}),
        ...(options.sort ? { order_by: options.sort } : {}),
        ...(options.havingCountGte || options.havingCountLte || options.havingUnreadRateGte
          ? {
              having: {
                ...(options.havingCountGte || options.havingCountLte
                  ? {
                      count: {
                        ...(options.havingCountGte
                          ? { gte: parseIntegerOption(options.havingCountGte, "having-count-gte") }
                          : {}),
                        ...(options.havingCountLte
                          ? { lte: parseIntegerOption(options.havingCountLte, "having-count-lte") }
                          : {}),
                      },
                    }
                  : {}),
                ...(options.havingUnreadRateGte
                  ? {
                      unread_rate: {
                        gte: parsePercentOption(options.havingUnreadRateGte, "having-unread-rate-gte"),
                      },
                    }
                  : {}),
              },
            }
          : {}),
        limit: parseIntegerOption(options.limit, "limit"),
      });

      if (maybePrintJson(options.json, result)) {
        return;
      }

      printQueryResult(result);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("unsubscribe <sender>")
  .description("Return an unsubscribe target for a sender and optionally archive or label existing mail")
  .option("--no-archive", "Only return the unsubscribe link, do not archive existing mail")
  .option("--label <name>", "Label existing emails while unsubscribing")
  .action(async (sender, options) => {
    if (options.archive || options.label) {
      const status = await loadRuntimeStatus();

      if (!status.gmailReady) {
        await requireLiveGmailReadiness("unsubscribe");
        return;
      }
    }

    try {
      const result = await unsubscribe({
        senderEmail: sender,
        alsoArchive: options.archive,
        alsoLabel: options.label,
      });

      printSection(`Unsubscribing from ${result.sender}`);
      printKeyValue("messages", String(result.messageCount));
      printKeyValue("archived", String(result.archivedCount));
      printKeyValue("labeled", String(result.labeledCount));
      if (result.runId) {
        printKeyValue("runId", `${ui.dim(result.runId)} (undo with: inboxctl undo ${result.runId})`);
      }
      printKeyValue("method", result.unsubscribeMethod);
      console.log("");
      console.log(result.instruction);
      console.log("");
      console.log(result.unsubscribeLink);
      if (options.archive) {
        console.log("");
        console.log(`Tip: Create a Gmail filter to auto-archive future mail: inboxctl filters create --from ${result.sender} --archive`);
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

const labels = program.command("labels").description("Manage Gmail labels");

labels
  .command("list")
  .description("List all Gmail labels")
  .action(async () => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("labels list");
      return;
    }

    const labels = await listLabels();
    printSection("Labels");
    console.log(
      [
        pad(ui.dim("TYPE"), 8),
        pad(ui.dim("NAME"), 24),
        pad(ui.dim("MESSAGES"), 10),
        pad(ui.dim("UNREAD"), 8),
        ui.dim("ID"),
      ].join("  "),
    );

    for (const label of labels) {
      console.log(
        [
          pad(label.type === "system" ? ui.cyan(label.type) : ui.magenta(label.type), 8),
          pad(truncate(label.name, 24), 24),
          pad(String(label.messagesTotal), 10),
          pad(String(label.messagesUnread), 8),
          ui.dim(label.id),
        ].join("  "),
      );
    }
  });

labels
  .command("create <name>")
  .description("Create a new Gmail label")
  .action(async (name) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("labels create");
      return;
    }

    try {
      const label = await createLabel(name);
      printSection("Label Created");
      printKeyValue("name", label.name);
      printKeyValue("id", ui.dim(label.id));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

const stats = program.command("stats").description("Email analytics");

stats
  .command("overview", { isDefault: true })
  .description("Inbox overview stats")
  .action(async () => {
    const overview = await getInboxOverview();

    if (overview.total === 0) {
      console.log("No cached emails yet. Run `inboxctl sync` first.");
      return;
    }

    printInboxOverview(overview);
  });

stats
  .command("senders")
  .description("Top senders by volume")
  .option("--top <number>", "Number of senders", "20")
  .option("--period <period>", "Time period (day|week|month|year|all)", "all")
  .option("--min-unread <percent>", "Minimum unread rate filter")
  .action(async (options) => {
    try {
      const top = parseIntegerOption(options.top, "top");
      const minUnread = parsePercentOption(options.minUnread, "min-unread");
      const period = options.period as "day" | "week" | "month" | "year" | "all";

      if (!["day", "week", "month", "year", "all"].includes(period)) {
        throw new Error("period must be one of: day, week, month, year, all.");
      }

      const senders = await getTopSenders({
        limit: top,
        period,
        minUnreadRate: minUnread,
      });

      if (senders.length === 0) {
        console.log("No cached sender stats matched that filter.");
        return;
      }

      printTopSendersTable(period, senders);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("noise")
  .description("High-noise senders ranked by noise score")
  .option("--top <number>", "Number of senders", "20")
  .option("--sort <mode>", "Sort by noise_score|all_time_noise_score|message_count|unread_rate", "noise_score")
  .option("--min-score <number>", "Minimum noise score", "5")
  .option("--active-days <number>", "Only consider recent activity within this many days", "90")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const result = await getNoiseSenders({
        limit: parseIntegerOption(options.top, "top"),
        sortBy: options.sort,
        minNoiseScore: Number(options.minScore),
        activeDays: parseIntegerOption(options.activeDays, "active-days"),
      });

      if (maybePrintJson(options.json, result)) {
        return;
      }

      if (result.senders.length === 0) {
        console.log("No noisy senders matched that filter.");
        return;
      }

      printNoiseSendersTable(result);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("uncategorized")
  .description("Summarize uncategorized emails by sender")
  .option("--top <number>", "Number of senders", "20")
  .option("--confidence <level>", "Filter by confidence: high|medium|low")
  .option("--min-emails <number>", "Minimum uncategorized emails per sender", "1")
  .option("--since <date>", "Only include uncategorized emails on or after this ISO date")
  .option("--sort <mode>", "Sort by email_count|newest|unread_rate", "email_count")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const result = await getUncategorizedSenders({
        limit: parseIntegerOption(options.top, "top"),
        confidence: options.confidence,
        minEmails: parseIntegerOption(options.minEmails, "min-emails"),
        since: options.since,
        sortBy: options.sort,
      });

      if (maybePrintJson(options.json, result)) {
        return;
      }

      if (result.totalSenders === 0) {
        console.log("No uncategorized senders matched that filter.");
        return;
      }

      printUncategorizedSendersTable(result);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("unsubscribe")
  .description("Rank unsubscribe candidates by impact")
  .option("--top <number>", "Number of senders", "20")
  .option("--min-emails <number>", "Minimum emails from a sender", "5")
  .option("--unread-only-senders", "Only show senders where every email is unread")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const result = await getUnsubscribeSuggestions({
        limit: parseIntegerOption(options.top, "top"),
        minMessages: parseIntegerOption(options.minEmails, "min-emails"),
        unreadOnlySenders: options.unreadOnlySenders,
      });

      if (maybePrintJson(options.json, result)) {
        return;
      }

      if (result.suggestions.length === 0) {
        console.log("No unsubscribe suggestions matched that filter.");
        return;
      }

      printUnsubscribeSuggestionsTable(result);
      console.log("");
      console.log("Run `inboxctl unsubscribe <sender>` to process a specific sender.");
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("anomalies")
  .description("Review recently categorized emails for potential misclassifications")
  .option("--since <date>", "Only review items on or after this ISO date")
  .option("--limit <number>", "Maximum anomalies to return", "20")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const result = await reviewCategorized({
        ...(options.since ? { since: options.since } : {}),
        limit: parseIntegerOption(options.limit, "limit"),
      });

      if (maybePrintJson(options.json, result)) {
        return;
      }

      printAnomaliesTable(result);
      if (result.anomalies.length > 0) {
        console.log("");
        console.log("Undo a run with `inboxctl undo <run-id>`.");
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("newsletters")
  .description("Detected newsletters and mailing lists")
  .option("--min-unread <percent>", "Minimum unread rate filter")
  .action(async (options) => {
    try {
      const minUnread = parsePercentOption(options.minUnread, "min-unread");
      const newsletters = await getNewsletters({
        minUnreadRate: minUnread,
      });

      if (newsletters.length === 0) {
        console.log("No newsletter senders matched that filter.");
        return;
      }

      printNewslettersTable(newsletters);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("labels")
  .description("Email count per label")
  .action(async () => {
    const labels = await getLabelDistribution();

    if (labels.length === 0) {
      console.log("No cached emails yet. Run `inboxctl sync` first.");
      return;
    }

    printLabelDistributionTable(labels);
  });

stats
  .command("volume")
  .description("Email volume over time")
  .option("--period <period>", "Granularity (day|week|month)", "day")
  .action(async (options) => {
    try {
      const period = options.period as "day" | "week" | "month";

      if (!["day", "week", "month"].includes(period)) {
        throw new Error("period must be one of: day, week, month.");
      }

      const points = await getVolumeByPeriod(period, getVolumeRange(period));

      if (points.length === 0) {
        console.log("No cached emails yet. Run `inboxctl sync` first.");
        return;
      }

      printVolumeTable(period, points);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

stats
  .command("sender <email>")
  .description("Detailed stats for a sender or @domain")
  .action(async (email) => {
    const detail = await getSenderStats(email);

    if (!detail) {
      console.log(`No cached emails found for ${email}.`);
      return;
    }

    printSenderDetail(detail);
  });

const rules = program.command("rules").description("Rule management (IaC)");

rules
  .command("deploy [file]")
  .description("Deploy rules from YAML files")
  .action(async (file) => {
    const config = loadConfig();

    try {
      const result = file
        ? await deployLoadedRule(await loadRuleFile(file))
        : await deployAllRules(config.rulesDir);
      printRuleDeploySummary(result);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

rules
  .command("status [name]")
  .description("Show deployed rules and their status")
  .action(async (name) => {
    try {
      if (name) {
        const rule = await getRuleStatus(name);

        if (!rule) {
          console.log(`Rule not found: ${name}`);
          process.exitCode = 1;
          return;
        }

        printRuleStatusDetail(rule);
        return;
      }

      const rules = await getAllRulesStatus();

      if (rules.length === 0) {
        console.log("No rules have been deployed yet.");
        return;
      }

      printRuleStatusTable(rules);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

rules
  .command("run [name]")
  .description("Execute a rule against matching emails")
  .option("--apply", "Actually execute (default is dry-run)")
  .option("--max <number>", "Maximum emails to process", "100")
  .option("--all", "Run all enabled rules")
  .action(async (name, options) => {
    const maxEmails = Number(options.max);

    if (!Number.isInteger(maxEmails) || maxEmails <= 0) {
      console.log(`Invalid --max value: ${options.max}`);
      process.exitCode = 1;
      return;
    }

    if (!options.all && !name) {
      console.log("Provide a rule name or use --all.");
      process.exitCode = 1;
      return;
    }

    if (options.apply) {
      const status = await loadRuntimeStatus();

      if (!status.gmailReady) {
        await requireLiveGmailReadiness("rules run --apply");
        return;
      }
    }

    try {
      if (options.all) {
        const result = await runAllRules({
          dryRun: !options.apply,
          maxEmails,
        });
        printRunAllRulesResult(result);
        return;
      }

      const result = await runRule(name, {
        dryRun: !options.apply,
        maxEmails,
      });
      printRuleRunResult(result);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

rules
  .command("undo <run-id>")
  .description("Undo a specific rule run")
  .action(async (runId) => {
    const status = await loadRuntimeStatus();

    if (!status.gmailReady) {
      await requireLiveGmailReadiness("rules undo");
      return;
    }

    try {
      const result = await undoRun(runId);
      printSection(`Undo ${ui.dim(result.runId)}`);
      printKeyValue("status", formatStatus(result.status));
      printKeyValue("undone", ui.green(String(result.undoneCount)));
      printKeyValue("warnings", result.warningCount > 0 ? ui.yellow(String(result.warningCount)) : ui.dim("0"));
      printKeyValue("errors", result.errorCount > 0 ? ui.red(String(result.errorCount)) : ui.dim("0"));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

rules
  .command("enable <name>")
  .description("Enable a deployed rule")
  .action(async (name) => {
    try {
      const rule = await enableRule(name);
      printSection("Rule Enabled");
      printKeyValue("name", rule.name);
      printKeyValue("enabled", formatEnabled(rule.enabled));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

rules
  .command("disable <name>")
  .description("Disable a deployed rule")
  .action(async (name) => {
    try {
      const rule = await disableRule(name);
      printSection("Rule Disabled");
      printKeyValue("name", rule.name);
      printKeyValue("enabled", formatEnabled(rule.enabled));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

rules
  .command("diff")
  .description("Show drift between YAML files and deployed rules")
  .action(async () => {
    const config = loadConfig();

    try {
      const result = await detectDrift(config.rulesDir);

      if (result.entries.length === 0) {
        console.log("No rule files found.");
        return;
      }

      printDriftReport(result);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

// ─── filters ────────────────────────────────────────────────────────────────

const filters = program
  .command("filters")
  .description("Gmail server-side filters (always-on, applied at delivery time)");

filters
  .command("list")
  .description("List all Gmail server-side filters")
  .action(async () => {
    try {
      const all = await listFilters();

      if (all.length === 0) {
        console.log("No Gmail filters found.");
        return;
      }

      printSection("Gmail Filters");
      console.log(
        [
          pad(ui.dim("ID"), 32),
          pad(ui.dim("CRITERIA"), 36),
          ui.dim("ACTIONS"),
        ].join("  "),
      );

      for (const f of all) {
        const criteria: string[] = [];
        if (f.criteria.from) criteria.push(`from:${f.criteria.from}`);
        if (f.criteria.to) criteria.push(`to:${f.criteria.to}`);
        if (f.criteria.subject) criteria.push(`subject:${f.criteria.subject}`);
        if (f.criteria.query) criteria.push(`query:${f.criteria.query}`);
        if (f.criteria.hasAttachment) criteria.push("has-attachment");
        if (f.criteria.size != null) criteria.push(`size:${f.criteria.sizeComparison ?? ""}${f.criteria.size}`);

        const actions: string[] = [];
        if (f.actions.archive) actions.push("archive");
        if (f.actions.markRead) actions.push("mark-read");
        if (f.actions.star) actions.push("star");
        if (f.actions.addLabelNames.length > 0) actions.push(`label:${f.actions.addLabelNames.join(",")}`);
        if (f.actions.forward) actions.push(`forward:${f.actions.forward}`);

        console.log(
          [
            pad(ui.dim(f.id), 32),
            pad(truncate(criteria.join(" "), 36), 36),
            truncate(actions.join(", ") || "-", 60),
          ].join("  "),
        );
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

filters
  .command("get <id>")
  .description("Get details of a Gmail server-side filter")
  .action(async (id: string) => {
    try {
      const f = await getFilter(id);

      printSection("Filter");
      printKeyValue("id", f.id);
      console.log();

      console.log(ui.bold("Criteria"));
      if (f.criteria.from) printKeyValue("  from", f.criteria.from);
      if (f.criteria.to) printKeyValue("  to", f.criteria.to);
      if (f.criteria.subject) printKeyValue("  subject", f.criteria.subject);
      if (f.criteria.query) printKeyValue("  query", f.criteria.query);
      if (f.criteria.negatedQuery) printKeyValue("  not", f.criteria.negatedQuery);
      if (f.criteria.hasAttachment) printKeyValue("  has-attachment", "yes");
      if (f.criteria.excludeChats) printKeyValue("  exclude-chats", "yes");
      if (f.criteria.size != null) {
        printKeyValue(
          "  size",
          `${f.criteria.sizeComparison ?? ""} ${f.criteria.size} bytes`,
        );
      }
      console.log();

      console.log(ui.bold("Actions"));
      if (f.actions.archive) printKeyValue("  archive", "yes");
      if (f.actions.markRead) printKeyValue("  mark-read", "yes");
      if (f.actions.star) printKeyValue("  star", "yes");
      if (f.actions.addLabelNames.length > 0) printKeyValue("  add-label", f.actions.addLabelNames.join(", "));
      if (f.actions.removeLabelNames.length > 0) printKeyValue("  remove-label", f.actions.removeLabelNames.join(", "));
      if (f.actions.forward) printKeyValue("  forward", f.actions.forward);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

filters
  .command("create")
  .description("Create a Gmail server-side filter")
  .option("--from <address>", "Match emails from this address")
  .option("--to <address>", "Match emails sent to this address")
  .option("--subject <text>", "Match emails with this text in the subject")
  .option("--query <q>", "Match using Gmail search syntax")
  .option("--negated-query <q>", "Exclude emails matching this Gmail query")
  .option("--has-attachment", "Match emails with attachments")
  .option("--exclude-chats", "Exclude chat messages from matches")
  .option("--size <bytes>", "Match emails by size threshold", parseInt)
  .option("--size-comparison <direction>", "larger or smaller (use with --size)")
  .option("--label <name>", "Apply this label to matching emails (created if missing)")
  .option("--archive", "Archive matching emails (skip inbox)")
  .option("--mark-read", "Mark matching emails as read")
  .option("--star", "Star matching emails")
  .option("--forward <email>", "Forward matching emails to this address")
  .action(async (opts) => {
    try {
      const f = await createFilter({
        from: opts.from,
        to: opts.to,
        subject: opts.subject,
        query: opts.query,
        negatedQuery: opts.negatedQuery,
        hasAttachment: opts.hasAttachment || undefined,
        excludeChats: opts.excludeChats || undefined,
        size: opts.size,
        sizeComparison: opts.sizeComparison,
        labelName: opts.label,
        archive: opts.archive || undefined,
        markRead: opts.markRead || undefined,
        star: opts.star || undefined,
        forward: opts.forward,
      });

      printSection("Filter Created");
      printKeyValue("id", f.id);
      const criteriaStr: string[] = [];
      if (f.criteria.from) criteriaStr.push(`from:${f.criteria.from}`);
      if (f.criteria.to) criteriaStr.push(`to:${f.criteria.to}`);
      if (f.criteria.subject) criteriaStr.push(`subject:${f.criteria.subject}`);
      if (f.criteria.query) criteriaStr.push(f.criteria.query);
      if (criteriaStr.length > 0) printKeyValue("criteria", criteriaStr.join(", "));
      const actionsStr: string[] = [];
      if (f.actions.archive) actionsStr.push("archive");
      if (f.actions.markRead) actionsStr.push("mark-read");
      if (f.actions.star) actionsStr.push("star");
      if (f.actions.addLabelNames.length > 0) actionsStr.push(`label: ${f.actions.addLabelNames.join(", ")}`);
      if (f.actions.forward) actionsStr.push(`forward: ${f.actions.forward}`);
      if (actionsStr.length > 0) printKeyValue("actions", actionsStr.join(", "));

      console.log();
      console.log(ui.dim("Note: filters apply to incoming mail from now on. To process existing mail, use `inboxctl rules`."));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

filters
  .command("delete <id>")
  .description("Delete a Gmail server-side filter")
  .action(async (id: string) => {
    try {
      await deleteFilter(id);
      printSection("Filter Deleted");
      printKeyValue("id", id);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("demo")
  .description("Launch the seeded demo mailbox for screenshots, recordings, and safe exploration")
  .action(async () => {
    await runDemoSession();
  });

program
  .command("mcp")
  .description("Start MCP server on stdio")
  .action(async () => {
    await startMcpServer();
  });

program.action(async (options) => {
  if (options.demo) {
    await runDemoSession();
    return;
  }

  await startTuiApp({
    noSync: Boolean(options.noSync),
  });
});

program.parse();

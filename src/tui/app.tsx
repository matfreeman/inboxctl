import { convert } from "html-to-text";
import {
  Box,
  Newline,
  Spacer,
  Text,
  render,
  useApp,
  useInput,
  useStdout,
} from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";
import { loadConfig } from "../config.js";
import { undoRun } from "../core/actions/undo.js";
import { loadTokens } from "../core/auth/tokens.js";
import type { GmailLabel, EmailDetail, EmailMessage } from "../core/gmail/types.js";
import { createLabel, listLabels } from "../core/gmail/labels.js";
import { getMessage, listMessages } from "../core/gmail/messages.js";
import {
  archiveEmails,
  labelEmails,
  markRead,
  markUnread,
} from "../core/gmail/modify.js";
import { getLabelDistribution } from "../core/stats/labels.js";
import { getNewsletters } from "../core/stats/newsletters.js";
import { getNoiseSenders } from "../core/stats/noise.js";
import { getTopSenders } from "../core/stats/sender.js";
import { getUncategorizedSenders } from "../core/stats/uncategorized-senders.js";
import { getUnsubscribeSuggestions } from "../core/stats/unsubscribe.js";
import { getInboxOverview, getVolumeByPeriod } from "../core/stats/volume.js";
import {
  deployAllRules,
  disableRule,
  enableRule,
  getAllRulesStatus,
  type RuleStatus,
} from "../core/rules/deploy.js";
import { runRule } from "../core/rules/executor.js";
import { getExecutionHistory } from "../core/rules/history.js";
import { getRecentEmails } from "../core/sync/cache.js";
import {
  getSyncStatus,
  incrementalSync,
  type SyncProgressEvent,
} from "../core/sync/sync.js";

type Screen = "inbox" | "email" | "stats" | "rules" | "search";
type StatsTab = "senders" | "labels" | "newsletters" | "noise" | "uncategorized" | "unsubscribe";
type RulesFocus = "rules" | "history";
type SearchFocus = "input" | "results";
type FlashTone = "info" | "success" | "error";

interface AppProps {
  initialSync?: boolean;
}

interface FlashMessage {
  tone: FlashTone;
  text: string;
}

interface ConfirmState {
  title: string;
  message: string;
  onConfirm: () => Promise<void>;
}

interface LabelPickerState {
  open: boolean;
  loading: boolean;
  labels: GmailLabel[];
  selectedIndex: number;
  targetEmailId: string | null;
  createMode: boolean;
  newLabelName: string;
}

interface SyncState {
  syncing: boolean;
  message: string;
  lastSync: number | null;
  totalMessages: number;
  resumableProgressCurrent: number;
  resumableProgressTotal: number | null;
  progressCurrent: number;
  progressTotal: number | null;
  progressMode: "full" | "incremental" | null;
  progressPhase: SyncProgressEvent["phase"] | null;
  startedAt: number | null;
  progressStartedAt: number | null;
  lastProgressAt: number | null;
  lastProgressCurrent: number;
  ratePerSecond: number | null;
}

const PAGE_SIZE = 20;
const SEARCH_LIMIT = 50;
const MIN_CONTENT_HEIGHT = 10;

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function pad(value: string, width: number): string {
  const visible = stripAnsi(value);

  if (visible.length >= width) {
    return value;
  }

  return `${value}${" ".repeat(width - visible.length)}`;
}

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width === 1) {
    return value.slice(0, 1);
  }

  return `${value.slice(0, width - 1)}…`;
}

function flattenWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeInlineText(value: string, width?: number): string {
  let next = value.replace(/[\r\n\t]+/g, " ");

  if (/<[a-z][\s\S]*>/i.test(next)) {
    next = convert(next, {
      wordwrap: false,
      selectors: [{ selector: "a", options: { ignoreHref: true } }],
    });
  }

  next = flattenWhitespace(next);
  return width ? truncate(next, width) : next;
}

function formatFlashText(value: string): string {
  return sanitizeInlineText(value, 240);
}

function formatRelativeTime(value: number | Date | null | undefined): string {
  if (!value) {
    return "-";
  }

  const timestamp = value instanceof Date ? value.getTime() : value;
  const diff = Date.now() - timestamp;

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

  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(1))}%`;
}

function formatCount(value: number | null | undefined): string {
  if (value == null) {
    return "-";
  }

  return new Intl.NumberFormat("en-US").format(value);
}

function formatDurationEstimate(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s`;
  }

  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function getMinimumItemsForEta(total: number | null): number {
  if (!total || total <= 0) {
    return 500;
  }

  return Math.min(2_000, Math.max(500, Math.floor(total * 0.01)));
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, length - 1));
}

function terminalWidth(): number {
  return process.stdout.columns || 100;
}

function terminalHeight(): number {
  return process.stdout.rows || 30;
}

function toneColor(tone: FlashTone): "blue" | "green" | "red" {
  switch (tone) {
    case "success":
      return "green";
    case "error":
      return "red";
    case "info":
      return "blue";
  }
}

function getBodyText(detail: EmailDetail): string {
  if (detail.textPlain?.trim()) {
    return detail.textPlain.trim();
  }

  if (detail.bodyHtml?.trim()) {
    return convert(detail.bodyHtml, {
      wordwrap: Math.max(terminalWidth() - 10, 40),
    }).trim();
  }

  return detail.body?.trim() || detail.snippet || "";
}

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || terminalWidth(),
    rows: stdout.rows || terminalHeight(),
  });

  useEffect(() => {
    function handleResize() {
      setSize({
        columns: stdout.columns || terminalWidth(),
        rows: stdout.rows || terminalHeight(),
      });
    }

    handleResize();
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return size;
}

function getViewportRange(
  length: number,
  selectedIndex: number,
  visibleCount: number,
): { start: number; end: number } {
  if (length <= visibleCount) {
    return { start: 0, end: length };
  }

  const half = Math.floor(visibleCount / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, length - visibleCount));
  return {
    start,
    end: Math.min(length, start + visibleCount),
  };
}

function getScreenGuide(screen: Screen, focus?: RulesFocus | SearchFocus): string {
  const global = "q quit  •  s sync  •  / search  •  d stats  •  R rules";

  switch (screen) {
    case "inbox":
      return `${global}  •  j/k move  •  Enter open  •  a archive  •  l label  •  r read`;
    case "email":
      return "Esc back  •  j/k scroll  •  a archive  •  l label  •  r toggle read";
    case "stats":
      return "Esc back  •  s senders  •  l labels  •  n newsletters  •  o noise  •  c uncategorized  •  u unsubscribe";
    case "rules":
      return `Esc back  •  Tab switch ${focus === "history" ? "history" : "rules"} focus  •  d deploy  •  e toggle  •  r dry-run  •  R apply  •  u undo`;
    case "search":
      return `Esc back  •  Enter search  •  i focus input  •  ${focus === "input" ? "type Gmail query" : "j/k move  •  Enter open  •  a archive  •  l label  •  r read"}`;
  }
}

function renderProgressBar(current: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) {
    return "";
  }

  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function Panel(props: {
  title: string;
  subtitle?: string;
  accent?: "cyan" | "green" | "magenta" | "yellow";
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.accent || "cyan"}
      paddingX={1}
      paddingY={0}
      width="100%"
    >
      <Box>
        <Text bold color={props.accent || "cyan"}>
          {props.title}
        </Text>
        <Spacer />
        {props.subtitle ? <Text color="gray">{props.subtitle}</Text> : null}
      </Box>
      {props.children}
    </Box>
  );
}

function Header(props: {
  screen: Screen;
  sync: SyncState;
  columns: number;
  guide: string;
}) {
  const items: Array<{ key: Screen; label: string }> = [
    { key: "inbox", label: "Inbox" },
    { key: "email", label: "Email" },
    { key: "stats", label: "Stats" },
    { key: "rules", label: "Rules" },
    { key: "search", label: "Search" },
  ];

  return (
    <Box
      width={props.columns}
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box>
        <Text bold color="cyan">
          inboxctl
        </Text>
        <Text color="gray">  local-first Gmail cockpit</Text>
        <Spacer />
        <Text color={props.sync.syncing ? "yellow" : "gray"}>
          {props.sync.syncing ? props.sync.message : "ready"}
        </Text>
      </Box>
      <Box marginTop={1}>
        {items.map((item, index) => (
          <Box key={item.key} marginRight={index === items.length - 1 ? 0 : 2}>
            <Text color={props.screen === item.key ? "black" : "gray"} backgroundColor={props.screen === item.key ? "cyan" : undefined}>
              {` ${item.label} `}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{truncate(props.guide, Math.max(20, props.columns - 4))}</Text>
      </Box>
    </Box>
  );
}

function EmailList(props: {
  emails: EmailMessage[];
  selectedIndex: number;
  title: string;
  loading?: boolean;
  emptyMessage: string;
  visibleRows: number;
  subtitle?: string;
}) {
  const senderWidth = 28;
  const dateWidth = 10;
  const subjectWidth = Math.max(terminalWidth() - senderWidth - dateWidth - 20, 20);
  const { start, end } = getViewportRange(props.emails.length, props.selectedIndex, props.visibleRows);
  const visibleEmails = props.emails.slice(start, end);

  return (
    <Panel
      title={props.title}
      subtitle={props.subtitle || `${props.emails.length} loaded`}
      accent="cyan"
    >
      <Text color="gray">
        {pad("STATE", 6)} {pad("FROM", senderWidth)} {pad("DATE", dateWidth)} SUBJECT
      </Text>
      {props.loading ? (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> Loading inbox…
          </Text>
        </Box>
      ) : props.emails.length === 0 ? (
        <Text color="gray">{props.emptyMessage}</Text>
      ) : (
        <>
          {visibleEmails.map((email, index) => {
            const absoluteIndex = start + index;
            const selected = absoluteIndex === props.selectedIndex;
            const sender = sanitizeInlineText(email.fromName || email.fromAddress || "(unknown)", senderWidth);
            const subject = sanitizeInlineText(email.subject || "(no subject)", subjectWidth);
            const state = email.isRead ? " " : "●";

            return (
              <Text
                key={email.id}
                backgroundColor={selected ? "white" : undefined}
                color={selected ? "black" : !email.isRead ? "white" : "gray"}
                bold={!email.isRead}
              >
                {pad(state, 6)} {pad(sender, senderWidth)} {pad(formatRelativeTime(email.date), dateWidth)} {subject}
              </Text>
            );
          })}
          <Box marginTop={1}>
            <Text color="gray">
              showing {start + 1}-{end} of {props.emails.length}
            </Text>
          </Box>
        </>
      )}
    </Panel>
  );
}

function Table(props: {
  title: string;
  headers: string[];
  rows: string[][];
  emptyMessage: string;
}) {
  const widths = props.headers.map((header, index) =>
    Math.max(
      header.length,
      ...props.rows.map((row) => stripAnsi(row[index] || "").length),
    ),
  );

  return (
    <Panel title={props.title} accent="magenta">
      {props.rows.length === 0 ? (
        <Text color="gray">{props.emptyMessage}</Text>
      ) : (
        <>
          <Text color="gray">
            {props.headers.map((header, index) => pad(header, widths[index] || header.length)).join("  ")}
          </Text>
          {props.rows.map((row, index) => (
            <Text key={`${props.title}-${index}`}>
              {row.map((cell, cellIndex) => pad(cell, widths[cellIndex] || cell.length)).join("  ")}
            </Text>
          ))}
        </>
      )}
    </Panel>
  );
}

function Modal(props: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginTop={1}
      flexDirection="column"
    >
      <Text bold color="cyan">
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

function StatusBar(props: {
  screen: Screen;
  email: string | null;
  unreadCount: number;
  sync: SyncState;
  flash: FlashMessage | null;
  columns: number;
}) {
  const lastSync = props.sync.lastSync ? formatRelativeTime(props.sync.lastSync) : "never";
  const progressWidth = Math.max(12, Math.min(36, Math.floor((props.columns - 48) / 2)));
  const hasProgressBar =
    props.sync.syncing &&
    props.sync.progressTotal !== null &&
    props.sync.progressTotal > 0;
  const progressBar = hasProgressBar
    ? renderProgressBar(
        props.sync.progressCurrent,
        props.sync.progressTotal || 0,
        progressWidth,
      )
    : "";
  const progressSummary = hasProgressBar
    ? `${formatCount(props.sync.progressCurrent)} / ${formatCount(props.sync.progressTotal)}`
    : props.sync.syncing
      ? props.sync.progressMode === "incremental"
        ? "checking for changes"
        : "preparing sync"
      : `Last sync ${lastSync}`;
  const elapsedSeconds = props.sync.startedAt
    ? Math.max(1, (Date.now() - props.sync.startedAt) / 1_000)
    : 0;
  const remainingItems = props.sync.progressTotal !== null
    ? Math.max(0, props.sync.progressTotal - props.sync.progressCurrent)
    : 0;
  const minimumItemsForEta = getMinimumItemsForEta(props.sync.progressTotal);
  const canShowEta =
    hasProgressBar &&
    props.sync.progressMode === "full" &&
    props.sync.progressPhase === "fetching_messages" &&
    props.sync.ratePerSecond !== null &&
    props.sync.ratePerSecond > 0 &&
    elapsedSeconds >= 15 &&
    props.sync.progressCurrent >= minimumItemsForEta &&
    remainingItems > 0;
  const etaSummary = canShowEta
    ? `ETA ~${formatDurationEstimate(remainingItems / (props.sync.ratePerSecond || 1))}`
    : hasProgressBar &&
        props.sync.progressMode === "full" &&
        props.sync.progressPhase === "fetching_messages" &&
        props.sync.progressCurrent > 0 &&
        remainingItems > 0
      ? "ETA calculating…"
      : null;

  return (
    <Box
      borderStyle="round"
      borderColor={props.flash ? toneColor(props.flash.tone) : "gray"}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
      width="100%"
    >
      <Box>
        <Text color="cyan">inboxctl</Text>
        <Text color="gray">  {props.email || "not authenticated"}</Text>
        <Spacer />
        <Text color="yellow">{props.unreadCount} unread</Text>
        <Text color="gray">  |  </Text>
        <Text color="gray">{truncate(progressSummary, Math.max(18, props.columns - 56))}</Text>
        <Text color="gray">  |  </Text>
        <Text color="magenta">{props.screen}</Text>
      </Box>
      {props.sync.syncing ? (
        <>
          <Newline />
          <Box>
            <Text color={props.sync.progressMode === "full" ? "yellow" : "cyan"}>
              {props.sync.progressMode === "full" ? "full" : "incr"}
            </Text>
            <Text color="gray">  {truncate(props.sync.message, Math.max(24, props.columns - 34))}</Text>
            {hasProgressBar ? (
              <>
                <Spacer />
                {etaSummary ? <Text color="gray">{etaSummary}  </Text> : null}
                <Text color="green">{progressBar}</Text>
                <Text color="gray">  {formatPercent((props.sync.progressCurrent / (props.sync.progressTotal || 1)) * 100)}</Text>
              </>
            ) : null}
          </Box>
        </>
      ) : null}
      {props.flash ? (
        <>
          <Newline />
          <Text color={toneColor(props.flash.tone)}>{props.flash.text}</Text>
        </>
      ) : null}
    </Box>
  );
}

export function App({ initialSync = true }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const config = loadConfig();

  const [screen, setScreen] = useState<Screen>("inbox");
  const [emailOrigin, setEmailOrigin] = useState<"inbox" | "search">("inbox");
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({
    syncing: false,
    message: "Syncing…",
    lastSync: null,
    totalMessages: 0,
    resumableProgressCurrent: 0,
    resumableProgressTotal: null,
    progressCurrent: 0,
    progressTotal: null,
    progressMode: null,
    progressPhase: null,
    startedAt: null,
    progressStartedAt: null,
    lastProgressAt: null,
    lastProgressCurrent: 0,
    ratePerSecond: null,
  });
  const [unreadCount, setUnreadCount] = useState(0);

  const [inboxEmails, setInboxEmails] = useState<EmailMessage[]>([]);
  const [inboxSelectedIndex, setInboxSelectedIndex] = useState(0);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxHasMore, setInboxHasMore] = useState(true);

  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [emailDetail, setEmailDetail] = useState<EmailDetail | null>(null);
  const [emailBody, setEmailBody] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailScroll, setEmailScroll] = useState(0);

  const [statsLoading, setStatsLoading] = useState(false);
  const [statsTab, setStatsTab] = useState<StatsTab>("senders");
  const [statsOverview, setStatsOverview] = useState<Awaited<ReturnType<typeof getInboxOverview>> | null>(null);
  const [statsSenders, setStatsSenders] = useState<Awaited<ReturnType<typeof getTopSenders>>>([]);
  const [statsLabels, setStatsLabels] = useState<Awaited<ReturnType<typeof getLabelDistribution>>>([]);
  const [statsNewsletters, setStatsNewsletters] = useState<Awaited<ReturnType<typeof getNewsletters>>>([]);
  const [statsNoise, setStatsNoise] = useState<Awaited<ReturnType<typeof getNoiseSenders>>["senders"]>([]);
  const [statsUncategorized, setStatsUncategorized] = useState<Awaited<ReturnType<typeof getUncategorizedSenders>> | null>(null);
  const [statsUnsubscribe, setStatsUnsubscribe] = useState<Awaited<ReturnType<typeof getUnsubscribeSuggestions>>["suggestions"]>([]);
  const [statsVolume, setStatsVolume] = useState<Awaited<ReturnType<typeof getVolumeByPeriod>>>([]);

  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesFocus, setRulesFocus] = useState<RulesFocus>("rules");
  const [rules, setRules] = useState<RuleStatus[]>([]);
  const [rulesSelectedIndex, setRulesSelectedIndex] = useState(0);
  const [ruleHistory, setRuleHistory] = useState<Awaited<ReturnType<typeof getExecutionHistory>>>([]);
  const [historySelectedIndex, setHistorySelectedIndex] = useState(0);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState<SearchFocus>("input");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<EmailMessage[]>([]);
  const [searchSelectedIndex, setSearchSelectedIndex] = useState(0);

  const [labelPicker, setLabelPicker] = useState<LabelPickerState>({
    open: false,
    loading: false,
    labels: [],
    selectedIndex: 0,
    targetEmailId: null,
    createMode: false,
    newLabelName: "",
  });

  function pushFlash(tone: FlashTone, text: string) {
    setFlash({ tone, text: formatFlashText(text) });
  }

  async function refreshStatus(): Promise<void> {
    const [syncStatus, overview, tokens] = await Promise.all([
      getSyncStatus(),
      getInboxOverview(),
      loadTokens(config.tokensPath),
    ]);

    setSyncState((current) => ({
      ...current,
      lastSync: syncStatus.lastIncrementalSync ?? syncStatus.lastFullSync,
      totalMessages: syncStatus.totalMessages,
      resumableProgressCurrent: syncStatus.fullSyncProcessed,
      resumableProgressTotal: syncStatus.fullSyncTotal,
    }));
    setUnreadCount(overview.unread);
    setAuthEmail(tokens?.email && tokens.email !== "unknown" ? tokens.email : null);
  }

  async function loadInbox(reset: boolean): Promise<void> {
    setInboxLoading(true);

    try {
      const offset = reset ? 0 : inboxEmails.length;
      const rows = await getRecentEmails(PAGE_SIZE, offset);

      setInboxEmails((current) => (reset ? rows : [...current, ...rows]));
      setInboxHasMore(rows.length === PAGE_SIZE);
      setInboxSelectedIndex((current) => clampIndex(reset ? 0 : current, reset ? rows.length : offset + rows.length));
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    } finally {
      setInboxLoading(false);
    }
  }

  async function loadStats(): Promise<void> {
    setStatsLoading(true);

    try {
      const [overview, senders, labels, newsletters, noise, uncategorized, unsubscribe, volume] = await Promise.all([
        getInboxOverview(),
        getTopSenders({ limit: 10 }),
        getLabelDistribution(),
        getNewsletters({ minMessages: 1 }),
        getNoiseSenders({ limit: 10 }),
        getUncategorizedSenders({ limit: 10 }),
        getUnsubscribeSuggestions({ limit: 10 }),
        getVolumeByPeriod("day", { start: Date.now() - 30 * 24 * 60 * 60 * 1000, end: Date.now() }),
      ]);

      setStatsOverview(overview);
      setStatsSenders(senders);
      setStatsLabels(labels.slice(0, 10));
      setStatsNewsletters(newsletters.slice(0, 10));
      setStatsNoise(noise.senders);
      setStatsUncategorized(uncategorized);
      setStatsUnsubscribe(unsubscribe.suggestions);
      setStatsVolume(volume.slice(-7));
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadRules(): Promise<void> {
    setRulesLoading(true);

    try {
      const [nextRules, nextHistory] = await Promise.all([
        getAllRulesStatus(),
        getExecutionHistory(undefined, 10),
      ]);

      setRules(nextRules);
      setRuleHistory(nextHistory);
      setRulesSelectedIndex((current) => clampIndex(current, nextRules.length));
      setHistorySelectedIndex((current) => clampIndex(current, nextHistory.length));
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    } finally {
      setRulesLoading(false);
    }
  }

  async function loadEmailDetail(emailId: string): Promise<void> {
    setEmailLoading(true);
    setEmailScroll(0);

    try {
      const detail = await getMessage(emailId);
      setEmailDetail(detail);
      setEmailBody(getBodyText(detail));
    } catch (error) {
      setEmailDetail(null);
      setEmailBody("");
      pushFlash("error", error instanceof Error ? error.message : String(error));
    } finally {
      setEmailLoading(false);
    }
  }

  async function runSync(message: string): Promise<void> {
    const startedAt = Date.now();

    setSyncState((current) => ({
      ...current,
      syncing: true,
      message,
      progressCurrent: current.resumableProgressCurrent,
      progressTotal: current.resumableProgressTotal,
      progressMode: current.resumableProgressCurrent > 0 ? "full" : null,
      progressPhase: current.resumableProgressCurrent > 0 ? "starting" : "starting",
      startedAt,
      progressStartedAt: null,
      lastProgressAt: startedAt,
      lastProgressCurrent: current.resumableProgressCurrent,
      ratePerSecond: null,
    }));

    try {
      await incrementalSync(
        (synced, total) => {
          setSyncState((current) => {
            const now = Date.now();
            const progressStartedAt =
              current.progressStartedAt ?? (synced > 0 ? now : null);
            const elapsedSinceProgressStart = progressStartedAt
              ? (now - progressStartedAt) / 1_000
              : 0;
            const nextRate =
              synced > 0 && elapsedSinceProgressStart > 0
                ? synced / elapsedSinceProgressStart
                : current.ratePerSecond;

            return {
              ...current,
              progressCurrent: synced,
              progressTotal: total,
              progressStartedAt,
              lastProgressAt: now,
              lastProgressCurrent: Math.max(current.lastProgressCurrent, synced),
              ratePerSecond: nextRate,
            };
          });
        },
        (event) => {
          setSyncState((current) => ({
            ...current,
            message: event.detail,
            progressCurrent: event.synced,
            progressTotal: event.total,
            progressMode: event.mode,
            progressPhase: event.phase,
          }));
        },
      );
      await Promise.all([
        refreshStatus(),
        loadInbox(true),
        screen === "stats" ? loadStats() : Promise.resolve(),
        screen === "rules" ? loadRules() : Promise.resolve(),
      ]);
      pushFlash("success", "Inbox sync complete.");
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSyncState((current) => ({
        ...current,
        syncing: false,
        progressCurrent: 0,
        progressTotal: null,
        progressMode: null,
        progressPhase: null,
        startedAt: null,
        progressStartedAt: null,
        lastProgressAt: null,
        lastProgressCurrent: 0,
        ratePerSecond: null,
      }));
    }
  }

  async function refreshAfterMutation(): Promise<void> {
    await Promise.all([
      refreshStatus(),
      loadInbox(true),
      screen === "stats" ? loadStats() : Promise.resolve(),
      screen === "rules" ? loadRules() : Promise.resolve(),
      selectedEmailId && screen === "email" ? loadEmailDetail(selectedEmailId) : Promise.resolve(),
    ]);
  }

  function currentListSelection(): EmailMessage | null {
    if (screen === "search") {
      return searchResults[searchSelectedIndex] || null;
    }

    return inboxEmails[inboxSelectedIndex] || null;
  }

  async function archiveCurrentEmail(): Promise<void> {
    const email = screen === "email"
      ? emailDetail
      : currentListSelection();

    if (!email) {
      return;
    }

    try {
      await archiveEmails([email.id]);
      pushFlash("success", `Archived ${email.subject || email.id}.`);
      await refreshAfterMutation();
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleReadCurrentEmail(): Promise<void> {
    const email = screen === "email"
      ? emailDetail
      : currentListSelection();

    if (!email) {
      return;
    }

    try {
      if (email.isRead) {
        await markUnread([email.id]);
        pushFlash("success", `Marked ${email.subject || email.id} as unread.`);
      } else {
        await markRead([email.id]);
        pushFlash("success", `Marked ${email.subject || email.id} as read.`);
      }
      await refreshAfterMutation();
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function openLabelPicker(targetEmailId: string | null): Promise<void> {
    if (!targetEmailId) {
      return;
    }

    setLabelPicker({
      open: true,
      loading: true,
      labels: [],
      selectedIndex: 0,
      targetEmailId,
      createMode: false,
      newLabelName: "",
    });

    try {
      const labels = await listLabels();
      setLabelPicker((current) => ({
        ...current,
        loading: false,
        labels,
      }));
    } catch (error) {
      setLabelPicker((current) => ({
        ...current,
        loading: false,
      }));
      pushFlash("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function applySelectedLabel(labelName: string): Promise<void> {
    if (!labelPicker.targetEmailId) {
      return;
    }

    try {
      await labelEmails([labelPicker.targetEmailId], labelName);
      setLabelPicker((current) => ({
        ...current,
        open: false,
      }));
      pushFlash("success", `Applied label ${labelName}.`);
      await refreshAfterMutation();
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function createAndApplyLabel(name: string): Promise<void> {
    const trimmed = name.trim();

    if (!trimmed) {
      pushFlash("error", "Label name cannot be empty.");
      return;
    }

    try {
      await createLabel(trimmed);
      await applySelectedLabel(trimmed);
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    }
  }

  async function executeSearch(query: string): Promise<void> {
    const trimmed = query.trim();

    if (!trimmed) {
      pushFlash("error", "Enter a Gmail query first.");
      return;
    }

    setSearchLoading(true);

    try {
      const results = await listMessages(trimmed, SEARCH_LIMIT);
      setSearchResults(results);
      setSearchSelectedIndex(0);
      setSearchFocus("results");
      pushFlash("info", `${results.length} search results loaded.`);
    } catch (error) {
      pushFlash("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSearchLoading(false);
    }
  }

  function openSelectedEmail(email: EmailMessage, origin: "inbox" | "search"): void {
    setEmailOrigin(origin);
    setSelectedEmailId(email.id);
    setScreen("email");
  }

  useEffect(() => {
    void (async () => {
      await Promise.all([
        refreshStatus(),
        loadInbox(true),
      ]);

      if (initialSync) {
        await runSync("Syncing inbox…");
      }
    })();
  }, []);

  useEffect(() => {
    if (screen === "stats") {
      void loadStats();
    }

    if (screen === "rules") {
      void loadRules();
    }
  }, [screen]);

  useEffect(() => {
    if (screen === "email" && selectedEmailId) {
      void loadEmailDetail(selectedEmailId);
    }
  }, [screen, selectedEmailId]);

  useEffect(() => {
    if (!flash) {
      return;
    }

    const timeout = setTimeout(() => {
      setFlash(null);
    }, 3500);

    return () => clearTimeout(timeout);
  }, [flash]);

  useInput((input, key) => {
    if (confirmState) {
      if (input === "y" || input === "Y") {
        const action = confirmState.onConfirm;
        setConfirmState(null);
        void action();
      } else if (input === "n" || input === "N" || key.escape) {
        setConfirmState(null);
      }
      return;
    }

    if (labelPicker.open) {
      if (labelPicker.createMode) {
        if (key.escape) {
          setLabelPicker((current) => ({
            ...current,
            createMode: false,
            newLabelName: "",
          }));
        }
        return;
      }

      if (key.escape) {
        setLabelPicker((current) => ({
          ...current,
          open: false,
        }));
        return;
      }

      if (input === "j" || key.downArrow) {
        setLabelPicker((current) => ({
          ...current,
          selectedIndex: clampIndex(current.selectedIndex + 1, current.labels.length),
        }));
        return;
      }

      if (input === "k" || key.upArrow) {
        setLabelPicker((current) => ({
          ...current,
          selectedIndex: clampIndex(current.selectedIndex - 1, current.labels.length),
        }));
        return;
      }

      if (input === "c") {
        setLabelPicker((current) => ({
          ...current,
          createMode: true,
          newLabelName: "",
        }));
        return;
      }

      if (key.return) {
        const label = labelPicker.labels[labelPicker.selectedIndex];
        if (label) {
          void applySelectedLabel(label.name);
        }
        return;
      }

      return;
    }

    if (screen === "search" && searchFocus === "input") {
      if (key.escape) {
        setScreen("inbox");
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (screen === "inbox") {
      if (input === "j" || key.downArrow) {
        if (inboxSelectedIndex === inboxEmails.length - 1 && inboxHasMore && !inboxLoading) {
          void loadInbox(false);
        }
        setInboxSelectedIndex((current) => clampIndex(current + 1, inboxEmails.length));
        return;
      }

      if (input === "k" || key.upArrow) {
        setInboxSelectedIndex((current) => clampIndex(current - 1, inboxEmails.length));
        return;
      }

      if (key.return) {
        const email = inboxEmails[inboxSelectedIndex];
        if (email) {
          openSelectedEmail(email, "inbox");
        }
        return;
      }

      if (input === "a") {
        void archiveCurrentEmail();
        return;
      }

      if (input === "l") {
        void openLabelPicker(inboxEmails[inboxSelectedIndex]?.id || null);
        return;
      }

      if (input === "r") {
        void toggleReadCurrentEmail();
        return;
      }

      if (input === "/") {
        setScreen("search");
        setSearchFocus("input");
        return;
      }

      if (input === "s") {
        void runSync("Syncing inbox…");
        return;
      }

      if (input === "d") {
        setScreen("stats");
        return;
      }

      if (input === "R") {
        setScreen("rules");
      }
      return;
    }

    if (screen === "email") {
      if (key.escape || key.backspace) {
        setScreen(emailOrigin);
        return;
      }

      if (input === "j" || key.downArrow) {
        setEmailScroll((current) => current + 1);
        return;
      }

      if (input === "k" || key.upArrow) {
        setEmailScroll((current) => Math.max(0, current - 1));
        return;
      }

      if (input === "a") {
        void archiveCurrentEmail();
        return;
      }

      if (input === "l") {
        void openLabelPicker(selectedEmailId);
        return;
      }

      if (input === "r") {
        void toggleReadCurrentEmail();
      }
      return;
    }

    if (screen === "stats") {
      if (key.escape || key.backspace) {
        setScreen("inbox");
        return;
      }

      if (input === "s") {
        setStatsTab("senders");
        return;
      }

      if (input === "l") {
        setStatsTab("labels");
        return;
      }

      if (input === "n") {
        setStatsTab("newsletters");
        return;
      }

      if (input === "o") {
        setStatsTab("noise");
        return;
      }

      if (input === "c") {
        setStatsTab("uncategorized");
        return;
      }

      if (input === "u") {
        setStatsTab("unsubscribe");
      }
      return;
    }

    if (screen === "rules") {
      if (key.escape || key.backspace) {
        setScreen("inbox");
        return;
      }

      if (key.tab) {
        setRulesFocus((current) => (current === "rules" ? "history" : "rules"));
        return;
      }

      if (input === "j" || key.downArrow) {
        if (rulesFocus === "rules") {
          setRulesSelectedIndex((current) => clampIndex(current + 1, rules.length));
        } else {
          setHistorySelectedIndex((current) => clampIndex(current + 1, ruleHistory.length));
        }
        return;
      }

      if (input === "k" || key.upArrow) {
        if (rulesFocus === "rules") {
          setRulesSelectedIndex((current) => clampIndex(current - 1, rules.length));
        } else {
          setHistorySelectedIndex((current) => clampIndex(current - 1, ruleHistory.length));
        }
        return;
      }

      if (input === "d") {
        void (async () => {
          try {
            await deployAllRules(config.rulesDir);
            pushFlash("success", "Rules deployed from YAML.");
            await loadRules();
          } catch (error) {
            pushFlash("error", error instanceof Error ? error.message : String(error));
          }
        })();
        return;
      }

      if (input === "e" && rulesFocus === "rules") {
        const rule = rules[rulesSelectedIndex];

        if (!rule) {
          return;
        }

        void (async () => {
          try {
            if (rule.enabled) {
              await disableRule(rule.name);
              pushFlash("success", `Disabled rule ${rule.name}.`);
            } else {
              await enableRule(rule.name);
              pushFlash("success", `Enabled rule ${rule.name}.`);
            }
            await loadRules();
          } catch (error) {
            pushFlash("error", error instanceof Error ? error.message : String(error));
          }
        })();
        return;
      }

      if (input === "r" && rulesFocus === "rules") {
        const rule = rules[rulesSelectedIndex];
        if (!rule) {
          return;
        }

        void (async () => {
          try {
            await runRule(rule.name, { dryRun: true, maxEmails: 100 });
            pushFlash("success", `Dry-ran rule ${rule.name}.`);
            await loadRules();
          } catch (error) {
            pushFlash("error", error instanceof Error ? error.message : String(error));
          }
        })();
        return;
      }

      if (input === "R" && rulesFocus === "rules") {
        const rule = rules[rulesSelectedIndex];
        if (!rule) {
          return;
        }

        setConfirmState({
          title: "Run Rule",
          message: `Apply rule ${rule.name} against cached matches?`,
          onConfirm: async () => {
            try {
              await runRule(rule.name, { dryRun: false, maxEmails: 100 });
              pushFlash("success", `Applied rule ${rule.name}.`);
              await refreshAfterMutation();
              await loadRules();
            } catch (error) {
              pushFlash("error", error instanceof Error ? error.message : String(error));
            }
          },
        });
        return;
      }

      if (input === "u" && rulesFocus === "history") {
        const run = ruleHistory[historySelectedIndex];
        if (!run) {
          return;
        }

        void (async () => {
          try {
            await undoRun(run.id);
            pushFlash("success", `Undid run ${run.id}.`);
            await refreshAfterMutation();
            await loadRules();
          } catch (error) {
            pushFlash("error", error instanceof Error ? error.message : String(error));
          }
        })();
      }
      return;
    }

    if (screen === "search") {
      if (key.escape || key.backspace) {
        setScreen("inbox");
        return;
      }

      if (input === "i") {
        setSearchFocus("input");
        return;
      }

      if (input === "j" || key.downArrow) {
        setSearchSelectedIndex((current) => clampIndex(current + 1, searchResults.length));
        return;
      }

      if (input === "k" || key.upArrow) {
        setSearchSelectedIndex((current) => clampIndex(current - 1, searchResults.length));
        return;
      }

      if (key.return) {
        const email = searchResults[searchSelectedIndex];
        if (email) {
          openSelectedEmail(email, "search");
        }
        return;
      }

      if (input === "a") {
        void archiveCurrentEmail();
        return;
      }

      if (input === "l") {
        void openLabelPicker(searchResults[searchSelectedIndex]?.id || null);
        return;
      }

      if (input === "r") {
        void toggleReadCurrentEmail();
      }
    }
  });

  const chromeHeight = 9;
  const contentHeight = Math.max(MIN_CONTENT_HEIGHT, rows - chromeHeight);
  const emailBodyHeight = Math.max(8, contentHeight - 8);
  const listVisibleRows = Math.max(8, contentHeight - 6);
  const emailBodyLines = emailBody.split("\n");
  const visibleBodyLines = emailBodyLines.slice(emailScroll, emailScroll + emailBodyHeight);
  const rulesVisibleCount = Math.max(5, Math.floor(contentHeight / 3));
  const historyVisibleCount = Math.max(4, Math.floor(contentHeight / 4));
  const rulesRange = getViewportRange(rules.length, rulesSelectedIndex, rulesVisibleCount);
  const historyRange = getViewportRange(
    ruleHistory.length,
    historySelectedIndex,
    historyVisibleCount,
  );
  const visibleRules = rules.slice(rulesRange.start, rulesRange.end);
  const visibleHistory = ruleHistory.slice(historyRange.start, historyRange.end);
  const selectedRule = rules[rulesSelectedIndex];
  const selectedRun = ruleHistory[historySelectedIndex];
  const screenGuide = getScreenGuide(
    screen,
    screen === "rules" ? rulesFocus : screen === "search" ? searchFocus : undefined,
  );

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1} paddingY={0}>
      <Header
        screen={screen}
        sync={syncState}
        columns={Math.max(40, columns - 2)}
        guide={screenGuide}
      />
      <Box height={contentHeight} flexDirection="column" marginTop={1}>
      {screen === "inbox" ? (
        <EmailList
          emails={inboxEmails}
          selectedIndex={inboxSelectedIndex}
          title="Inbox"
          loading={inboxLoading}
          emptyMessage="No cached emails yet. Sync to populate the local inbox."
          visibleRows={listVisibleRows}
          subtitle="Local cache first, background sync second"
        />
      ) : null}

      {screen === "email" ? (
        <Panel
          title={sanitizeInlineText(emailDetail?.subject || "Email Detail", Math.max(20, columns - 12))}
          subtitle="Esc back  •  j/k scroll  •  a archive  •  l label  •  r toggle read"
          accent="green"
        >
          {emailLoading ? (
            <Text color="cyan">
              <Spinner type="dots" /> Loading full email body…
            </Text>
          ) : emailDetail ? (
            <>
              <Text>
                From: {sanitizeInlineText(emailDetail.fromName ? `${emailDetail.fromName} <${emailDetail.fromAddress}>` : emailDetail.fromAddress)}
              </Text>
              <Text>To: {sanitizeInlineText(emailDetail.toAddresses.join(", ") || "-")}</Text>
              <Text>Date: {new Date(emailDetail.date).toISOString()}</Text>
              <Text>Labels: {sanitizeInlineText(emailDetail.labelIds.join(", ") || "-")}</Text>
              <Box marginTop={1} flexDirection="column">
                {visibleBodyLines.length === 0 ? (
                  <Text color="gray">(no body content)</Text>
                ) : (
                  visibleBodyLines.map((line, index) => (
                    <Text key={`body-${index}`}>{sanitizeInlineText(line || " ", Math.max(20, columns - 8))}</Text>
                  ))
                )}
              </Box>
              <Box marginTop={1}>
                <Text color="gray">line {Math.min(emailBodyLines.length, emailScroll + 1)} of {emailBodyLines.length || 1}</Text>
              </Box>
            </>
          ) : (
            <Text color="gray">Unable to load email detail.</Text>
          )}
        </Panel>
      ) : null}

      {screen === "stats" ? (
        <Panel
          title="Stats Dashboard"
          subtitle="s senders  •  l labels  •  n newsletters  •  o noise  •  c uncategorized  •  u unsubscribe  •  Esc back"
          accent="yellow"
        >
          {statsLoading ? (
            <Text color="cyan">
              <Spinner type="dots" /> Loading stats…
            </Text>
          ) : (
            <>
              <Box marginTop={1} flexDirection="column">
                <Text>Total: {statsOverview?.total ?? 0}</Text>
                <Text>Unread: {statsOverview?.unread ?? 0}</Text>
                <Text>Starred: {statsOverview?.starred ?? 0}</Text>
                <Text>
                  Today: {statsOverview?.today.received ?? 0} received / {statsOverview?.today.unread ?? 0} unread
                </Text>
                <Text>
                  Week: {statsOverview?.thisWeek.received ?? 0} received / {statsOverview?.thisWeek.unread ?? 0} unread
                </Text>
                <Text>
                  Month: {statsOverview?.thisMonth.received ?? 0} received / {statsOverview?.thisMonth.unread ?? 0} unread
                </Text>
              </Box>
              <Box marginTop={1}>
                <Text color={statsTab === "senders" ? "cyan" : "gray"}>[Senders]</Text>
                <Text> </Text>
                <Text color={statsTab === "labels" ? "cyan" : "gray"}>[Labels]</Text>
                <Text> </Text>
                <Text color={statsTab === "newsletters" ? "cyan" : "gray"}>[Newsletters]</Text>
                <Text> </Text>
                <Text color={statsTab === "noise" ? "cyan" : "gray"}>[Noise]</Text>
                <Text> </Text>
                <Text color={statsTab === "uncategorized" ? "cyan" : "gray"}>[Uncategorized]</Text>
                <Text> </Text>
                <Text color={statsTab === "unsubscribe" ? "cyan" : "gray"}>[Unsubscribe]</Text>
              </Box>
              {statsTab === "senders" ? (
                <Table
                  title="Top Senders"
                  headers={["SENDER", "TOTAL", "UNREAD%"]}
                  rows={statsSenders.map((sender) => [
                    truncate(sender.name || sender.email, 28),
                    String(sender.totalMessages),
                    formatPercent(sender.unreadRate),
                  ])}
                  emptyMessage="No sender stats available."
                />
              ) : null}
              {statsTab === "labels" ? (
                <Table
                  title="Top Labels"
                  headers={["LABEL", "TOTAL", "UNREAD"]}
                  rows={statsLabels.map((label) => [
                    truncate(label.labelName, 24),
                    String(label.totalMessages),
                    String(label.unreadMessages),
                  ])}
                  emptyMessage="No label stats available."
                />
              ) : null}
              {statsTab === "newsletters" ? (
                <Table
                  title="Newsletters"
                  headers={["SENDER", "TOTAL", "UNREAD%", "STATUS"]}
                  rows={statsNewsletters.map((newsletter) => [
                    truncate(newsletter.name || newsletter.email, 24),
                    String(newsletter.messageCount),
                    formatPercent(newsletter.unreadRate),
                    newsletter.status,
                  ])}
                  emptyMessage="No newsletters detected."
                />
              ) : null}
              {statsTab === "noise" ? (
                <Table
                  title="Noise Senders"
                  headers={["SENDER", "EMAILS", "UNREAD%", "SCORE", "UNSUB"]}
                  rows={statsNoise.map((sender) => [
                    truncate(sender.name || sender.email, 24),
                    String(sender.messageCount),
                    formatPercent(sender.unreadRate),
                    String(sender.noiseScore),
                    sender.hasUnsubscribeLink ? "Yes" : "No",
                  ])}
                  emptyMessage="No noisy senders detected."
                />
              ) : null}
              {statsTab === "uncategorized" ? (
                <>
                  <Box marginTop={1} flexDirection="column">
                    <Text>
                      Uncategorized: {statsUncategorized?.totalEmails ?? 0} emails from {statsUncategorized?.totalSenders ?? 0} senders
                    </Text>
                    <Text color="gray">
                      High {statsUncategorized?.summary.byConfidence.high.senders ?? 0}  •  Medium {statsUncategorized?.summary.byConfidence.medium.senders ?? 0}  •  Low {statsUncategorized?.summary.byConfidence.low.senders ?? 0}
                    </Text>
                  </Box>
                  <Table
                    title="Uncategorized Senders"
                    headers={["SENDER", "EMAILS", "UNREAD%", "CONF", "SIGNALS"]}
                    rows={(statsUncategorized?.senders || []).map((sender) => [
                      truncate(sender.name || sender.sender, 20),
                      String(sender.emailCount),
                      formatPercent(sender.unreadRate),
                      sender.confidence.toUpperCase(),
                      truncate(sender.signals.join(","), 22),
                    ])}
                    emptyMessage="No uncategorized senders detected."
                  />
                </>
              ) : null}
              {statsTab === "unsubscribe" ? (
                <Table
                  title="Unsubscribe Candidates"
                  headers={["SENDER", "EMAILS", "UNREAD%", "IMPACT", "METHOD"]}
                  rows={statsUnsubscribe.map((sender) => [
                    truncate(sender.name || sender.email, 24),
                    String(sender.allTimeMessageCount),
                    formatPercent(sender.unreadRate),
                    String(sender.impactScore),
                    sender.unsubscribeMethod,
                  ])}
                  emptyMessage="No unsubscribe candidates detected."
                />
              ) : null}
              <Table
                title="Recent Volume"
                headers={["DAY", "RECEIVED", "UNREAD"]}
                rows={statsVolume.map((point) => [
                  point.period,
                  String(point.received),
                  String(point.unread),
                ])}
                emptyMessage="No cached volume data."
              />
            </>
          )}
        </Panel>
      ) : null}

      {screen === "rules" ? (
        <Panel
          title="Rules Control"
          subtitle="Tab switches focus  •  d deploy  •  e toggle  •  r dry-run  •  R apply  •  u undo"
          accent="magenta"
        >
          {rulesLoading ? (
            <Text color="cyan">
              <Spinner type="dots" /> Loading rules…
            </Text>
          ) : (
            <>
              <Text color={rulesFocus === "rules" ? "cyan" : "gray"}>Rules</Text>
              {rules.length === 0 ? (
                <Text color="gray">No deployed rules.</Text>
              ) : (
                visibleRules.map((rule, index) => {
                  const absoluteIndex = rulesRange.start + index;

                  return (
                    <Text
                      key={rule.id}
                      backgroundColor={rulesFocus === "rules" && absoluteIndex === rulesSelectedIndex ? "magenta" : undefined}
                      color={rulesFocus === "rules" && absoluteIndex === rulesSelectedIndex ? "black" : undefined}
                    >
                      {rule.enabled ? "✓" : "·"} {rule.name} ({rule.totalRuns} runs, last {formatRelativeTime(rule.lastExecutionAt)})
                    </Text>
                  );
                })
              )}
              <Box marginTop={1} flexDirection="column">
                <Text color={rulesFocus === "history" ? "cyan" : "gray"}>Recent History</Text>
                {ruleHistory.length === 0 ? (
                  <Text color="gray">No execution history yet.</Text>
                ) : (
                  visibleHistory.map((run, index) => {
                    const absoluteIndex = historyRange.start + index;

                    return (
                      <Text
                        key={run.id}
                        backgroundColor={rulesFocus === "history" && absoluteIndex === historySelectedIndex ? "white" : undefined}
                        color={rulesFocus === "history" && absoluteIndex === historySelectedIndex ? "black" : undefined}
                      >
                        {run.status} {run.id} ({run.itemCount} items, {formatRelativeTime(run.createdAt)})
                      </Text>
                    );
                  })
                )}
              </Box>
              {selectedRule && rulesFocus === "rules" ? (
                <Box marginTop={1} flexDirection="column">
                  <Text color="gray">Selected rule: {selectedRule.name}</Text>
                  <Text color="gray">Actions: {selectedRule.actions.map((action) => action.type).join(", ") || "-"}</Text>
                </Box>
              ) : null}
              {selectedRun && rulesFocus === "history" ? (
                <Text color="gray">Selected run: {selectedRun.id}</Text>
              ) : null}
            </>
          )}
        </Panel>
      ) : null}

      {screen === "search" ? (
        <Panel
          title="Search"
          subtitle="Enter Gmail query syntax  •  Enter search  •  i focus input  •  Esc back"
          accent="cyan"
        >
          <Box>
            <Text color="cyan">query: </Text>
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={(value) => {
                void executeSearch(value);
              }}
              focus={searchFocus === "input"}
            />
          </Box>
          {searchLoading ? (
            <Text color="cyan">
              <Spinner type="dots" /> Searching Gmail…
            </Text>
          ) : (
            <EmailList
              emails={searchResults}
              selectedIndex={searchSelectedIndex}
              title="Results"
              emptyMessage="No results yet."
              visibleRows={Math.max(6, listVisibleRows - 4)}
            />
          )}
        </Panel>
      ) : null}
      </Box>

      {labelPicker.open ? (
        <Modal title="Label Picker">
          {labelPicker.loading ? (
            <Text color="cyan">
              <Spinner type="dots" /> Loading labels…
            </Text>
          ) : labelPicker.createMode ? (
            <>
              <Text color="gray">Enter new label name, then press Enter. Esc cancels.</Text>
              <TextInput
                value={labelPicker.newLabelName}
                onChange={(value) => {
                  setLabelPicker((current) => ({
                    ...current,
                    newLabelName: value,
                  }));
                }}
                onSubmit={(value) => {
                  void createAndApplyLabel(value);
                }}
                focus
              />
            </>
          ) : labelPicker.labels.length === 0 ? (
            <Text color="gray">No labels available. Press c to create one.</Text>
          ) : (
            <>
              <Text color="gray">j/k navigate, Enter apply, c create label, Esc cancel</Text>
              {labelPicker.labels.map((label, index) => (
                <Text key={label.id} inverse={index === labelPicker.selectedIndex}>
                  {label.name}
                </Text>
              ))}
            </>
          )}
        </Modal>
      ) : null}

      {confirmState ? (
        <Modal title={confirmState.title}>
          <Text>{confirmState.message}</Text>
          <Text color="gray">Press y to continue or n to cancel.</Text>
        </Modal>
      ) : null}

      <StatusBar
        screen={screen}
        email={authEmail}
        unreadCount={unreadCount}
        sync={syncState}
        flash={flash}
        columns={columns}
      />
    </Box>
  );
}

export async function startTuiApp(options?: { noSync?: boolean }): Promise<void> {
  if (process.stdout.isTTY) {
    process.stdout.write("\u001B[?1049h\u001B[2J\u001B[H");
  }

  try {
    const instance = render(<App initialSync={!options?.noSync} />);
    await instance.waitUntilExit();
  } finally {
    if (process.stdout.isTTY) {
      process.stdout.write("\u001B[?1049l");
    }
  }
}

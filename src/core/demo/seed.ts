import type Database from "better-sqlite3";
import type {
  EmailMessage,
  RawGmailFilter,
  RawGmailLabel,
  RawGmailMessage,
} from "../gmail/types.js";

export const DEMO_ACCOUNT_EMAIL = "demo@example.com";
const USER_LABELS = {
  receipts: "Label_1",
  awsAlerts: "Label_2",
  important: "Label_3",
} as const;

type SenderKey =
  | "github"
  | "stripe"
  | "aws"
  | "vercel"
  | "linear"
  | "alice"
  | "bob"
  | "newsletter"
  | "hn"
  | "paypal"
  | "shopify"
  | "docker"
  | "sarah"
  | "npm"
  | "slack";

interface SenderSpec {
  key: SenderKey;
  name: string;
  email: string;
  count: number;
  unread: number;
  hasListUnsubscribe?: boolean;
}

export interface DemoMessageRecord {
  senderKey: SenderKey;
  message: EmailMessage;
  rawMessage: RawGmailMessage;
  bodyText: string;
}

export interface DemoRuleRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  yamlHash: string;
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  priority: number;
  deployedAt: number;
  createdAt: number;
}

export interface DemoExecutionRunRecord {
  id: string;
  sourceType: "manual" | "rule";
  ruleId: string | null;
  dryRun: boolean;
  requestedActions: Array<Record<string, unknown>>;
  query: string | null;
  status: "planned" | "applied";
  createdAt: number;
  undoneAt: number | null;
}

export interface DemoExecutionItemRecord {
  id: string;
  runId: string;
  emailId: string;
  status: "planned" | "applied";
  appliedActions: Array<Record<string, unknown>>;
  beforeLabelIds: string[];
  afterLabelIds: string[];
  errorMessage: string | null;
  executedAt: number;
  undoneAt: number | null;
}

export interface DemoNewsletterRecord {
  id: string;
  email: string;
  name: string;
  messageCount: number;
  unreadCount: number;
  status: "active";
  unsubscribeLink: string | null;
  detectionReason: string;
  firstSeen: number;
  lastSeen: number;
}

export interface DemoDataset {
  accountEmail: string;
  historyId: string;
  labels: RawGmailLabel[];
  messages: DemoMessageRecord[];
  rules: DemoRuleRecord[];
  executionRuns: DemoExecutionRunRecord[];
  executionItems: DemoExecutionItemRecord[];
  newsletters: DemoNewsletterRecord[];
  filters: RawGmailFilter[];
}

const SYSTEM_LABELS: RawGmailLabel[] = [
  { id: "INBOX", name: "Inbox", type: "system" },
  { id: "UNREAD", name: "Unread", type: "system" },
  { id: "STARRED", name: "Starred", type: "system" },
  { id: "SENT", name: "Sent", type: "system" },
  { id: "DRAFT", name: "Drafts", type: "system" },
  { id: "SPAM", name: "Spam", type: "system" },
  { id: "TRASH", name: "Trash", type: "system" },
  { id: "CATEGORY_UPDATES", name: "Updates", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "Promotions", type: "system" },
];

const DEMO_LABELS: RawGmailLabel[] = [
  ...SYSTEM_LABELS,
  { id: USER_LABELS.receipts, name: "Receipts", type: "user" },
  { id: USER_LABELS.awsAlerts, name: "AWS-Alerts", type: "user" },
  { id: USER_LABELS.important, name: "Important", type: "user" },
];

const SENDERS: SenderSpec[] = [
  { key: "github", name: "GitHub", email: "notifications@github.com", count: 25, unread: 8 },
  { key: "stripe", name: "Stripe", email: "receipts@stripe.com", count: 12, unread: 0 },
  { key: "aws", name: "AWS Notifications", email: "no-reply@amazonaws.com", count: 18, unread: 14 },
  { key: "vercel", name: "Vercel", email: "notifications@vercel.com", count: 10, unread: 7 },
  { key: "linear", name: "Linear", email: "notifications@linear.app", count: 15, unread: 3 },
  { key: "alice", name: "Alice Chen", email: "alice.chen@example.com", count: 8, unread: 2 },
  { key: "bob", name: "Bob Martinez", email: "bob.martinez@example.com", count: 6, unread: 1 },
  { key: "newsletter", name: "Newsletter Weekly", email: "digest@newsletterweekly.com", count: 14, unread: 12, hasListUnsubscribe: true },
  { key: "hn", name: "Hacker News Digest", email: "hn@newsletters.hackernews.com", count: 12, unread: 10, hasListUnsubscribe: true },
  { key: "paypal", name: "PayPal", email: "service@paypal.com", count: 8, unread: 0 },
  { key: "shopify", name: "Shopify", email: "no-reply@shopify.com", count: 6, unread: 0 },
  { key: "docker", name: "Docker Hub", email: "noreply@docker.com", count: 5, unread: 4 },
  { key: "sarah", name: "Sarah Kim", email: "sarah.kim@example.com", count: 4, unread: 1 },
  { key: "npm", name: "npm", email: "support@npmjs.com", count: 4, unread: 3 },
  { key: "slack", name: "Slack", email: "notification@slack.com", count: 3, unread: 2 },
];

const PRIORITY_SEQUENCE: SenderKey[] = [
  "github",
  "aws",
  "stripe",
  "alice",
  "linear",
  "github",
  "newsletter",
  "stripe",
  "vercel",
  "hn",
  "bob",
  "github",
];

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildTimestamps(now: number, total: number): number[] {
  const timestamps: number[] = [];
  const blocks = [
    { count: 10, startHours: 0.5, endHours: 23 },
    { count: 15, startHours: 26, endHours: 72 },
    { count: 30, startHours: 74, endHours: 168 },
    { count: total - 55, startHours: 170, endHours: 720 },
  ];

  for (const block of blocks) {
    for (let index = 0; index < block.count; index += 1) {
      const ratio = block.count === 1 ? 0 : index / (block.count - 1);
      const offsetHours = block.startHours + ratio * (block.endHours - block.startHours);
      timestamps.push(now - Math.round(offsetHours * 60 * 60 * 1000));
    }
  }

  return timestamps.sort((a, b) => b - a);
}

function chooseSender(
  slotIndex: number,
  remaining: Map<SenderKey, number>,
  rng: () => number,
): SenderKey {
  const preferred = PRIORITY_SEQUENCE[slotIndex];

  if (preferred && (remaining.get(preferred) || 0) > 0) {
    remaining.set(preferred, (remaining.get(preferred) || 0) - 1);
    return preferred;
  }

  const weighted = [...remaining.entries()].filter(([, count]) => count > 0);
  const totalWeight = weighted.reduce((sum, [, count]) => sum + count, 0);
  let cursor = rng() * totalWeight;

  for (const [key, count] of weighted) {
    cursor -= count;

    if (cursor <= 0) {
      remaining.set(key, count - 1);
      return key;
    }
  }

  const fallback = weighted[weighted.length - 1]?.[0];

  if (!fallback) {
    throw new Error("Demo sender pool exhausted unexpectedly.");
  }

  remaining.set(fallback, (remaining.get(fallback) || 1) - 1);
  return fallback;
}

function getSubject(senderKey: SenderKey, sequence: number): string {
  switch (senderKey) {
    case "github":
      return [
        `Re: [acme/inboxctl] Fix race condition in worker pool (#12${sequence + 1})`,
        `[acme/inboxctl] New issue: Memory leak in cache layer (#23${sequence + 1})`,
        `[acme/platform] Review requested on PR #45${sequence + 1}`,
        `Re: [acme/inboxctl] TUI search pagination follow-up (#34${sequence + 1})`,
      ][sequence % 4];
    case "stripe":
      return [
        "Your receipt from Acme Corp - $49.00",
        "Payment to DigitalOcean - $12.00",
        "Your receipt from Render, Inc. - $29.00",
        "Invoice paid: GitHub Team - $9.00",
      ][sequence % 4];
    case "aws":
      return [
        "AWS Billing Alert: Your estimated charges exceed $50",
        "Amazon EC2 Maintenance Notification",
        "AWS Trusted Advisor weekly summary",
        "Amazon RDS performance insights available",
      ][sequence % 4];
    case "vercel":
      return [
        "Deployment completed for inboxctl-web",
        "Build failed for docs-preview",
        "Preview ready for PR #184",
        "Your project has a new domain alias",
      ][sequence % 4];
    case "linear":
      return [
        "Issue assigned: PROJ-142 Implement retry logic",
        "Comment on PROJ-138",
        "Cycle planning notes are ready",
        "Issue updated: PROJ-155 Improve inbox search",
      ][sequence % 4];
    case "alice":
      return [
        "Re: Architecture review notes",
        "Quick question about the deploy pipeline",
        "Lunch tomorrow?",
        "Follow-up on MCP prompt defaults",
      ][sequence % 4];
    case "bob":
      return [
        "Re: Sprint planning agenda",
        "Can you sanity-check the release notes?",
        "Quick update on the billing incident",
      ][sequence % 3];
    case "newsletter":
      return [
        "Weekly systems brief: incidents, launches, and lessons learned",
        "This week in developer tools",
        "Five workflows worth stealing this week",
      ][sequence % 3];
    case "hn":
      return [
        "Hacker News Digest: Top stories this week",
        "HN Digest: AI tooling, terminals, and SQLite",
        "Your weekly Hacker News roundup",
      ][sequence % 3];
    case "paypal":
      return [
        "Receipt for your payment to Figma",
        "You sent a payment to Notion Labs",
        "Transaction receipt from OpenAI",
      ][sequence % 3];
    case "shopify":
      return [
        "Order confirmation from Acme Supply",
        "Receipt from Shopify Billing",
        "Your Shopify payment receipt",
      ][sequence % 3];
    case "docker":
      return [
        "Docker Hub autobuild completed",
        "New image vulnerability summary",
        "Usage summary for your Docker plan",
      ][sequence % 3];
    case "sarah":
      return [
        "Re: Copy review for the setup guide",
        "Notes from today's product sync",
        "Small wording suggestion for the README",
      ][sequence % 3];
    case "npm":
      return [
        "Security notice for one of your dependencies",
        "Your npm access token was used",
        "Package advisory summary",
      ][sequence % 3];
    case "slack":
      return [
        "You have unread mentions in #engineering",
        "Slack summary for yesterday",
        "Reminder: action requested in #launches",
      ][sequence % 3];
  }
}

function buildBody(sender: SenderSpec, subject: string, sequence: number): string {
  switch (sender.key) {
    case "github":
      return [
        subject,
        "",
        "A reviewer left feedback on your pull request.",
        "",
        "File: src/core/rules/executor.ts",
        "",
        "```ts",
        "if (result.status === \"warning\") {",
        "  retryQueue.push(item);",
        "}",
        "```",
        "",
        "Comment:",
        "The warning path looks good, but we may still emit duplicate audit items",
        "when the retry branch is hit after a partial apply. Can we move the",
        "audit append behind the final status resolution?",
        "",
        "Suggested follow-up:",
        "- add a regression test around repeated partial retries",
        "- confirm undo still sees a single logical execution item",
        "",
        "View pull request",
        "Reply to comment",
      ].join("\n");
    case "stripe":
      return [
        subject,
        "",
        "Receipt summary",
        "----------------------------------------",
        `Receipt number: rcpt_demo_${sequence + 1}`,
        "Paid with: Visa ending in 4242",
        "Billing contact: demo@example.com",
        "",
        "Line items",
        "- Team plan........................ $29.00",
        "- Usage overage................... $20.00",
        "",
        "Subtotal.......................... $49.00",
        "Tax............................... $0.00",
        "Total............................. $49.00",
        "",
        "If you have questions about this charge, reply to this email and include",
        "the receipt number above.",
      ].join("\n");
    case "aws":
      return [
        subject,
        "",
        "Account: demo-platform",
        "Region highlights:",
        "- us-east-1 EC2 running hours increased by 14%",
        "- ap-southeast-2 RDS backup storage exceeded forecast",
        "- CloudWatch logs ingestion steady week over week",
        "",
        "Estimated charges",
        "- EC2.............................. $28.40",
        "- RDS.............................. $13.10",
        "- CloudWatch....................... $7.92",
        "- Data transfer.................... $3.61",
        "",
        "Recommended actions",
        "- review orphaned volumes",
        "- confirm dev database retention",
        "- validate expected scale-up window",
      ].join("\n");
    case "newsletter":
    case "hn":
      return [
        subject,
        "",
        "Good morning.",
        "",
        "Here is your roundup of the links and ideas people kept passing around",
        "this week, from terminal UX to pricing models to practical SQLite tips.",
        "",
        "Featured reads",
        "- A better way to review notification-heavy inboxes",
        "- Why local-first tools feel faster and safer",
        "- The hidden costs of brittle automation",
        "",
        "Worth a skim if you missed them",
        "- Building humane CLIs",
        "- Debugging MCP integrations in practice",
        "- Shipping small tools without creating trust debt",
        "",
        "Read online",
        "Manage subscription",
      ].join("\n");
    case "alice":
    case "bob":
    case "sarah":
      return [
        subject,
        "",
        `Hey team,`,
        "",
        "A couple of quick notes from my side:",
        "- the current flow feels solid once the first sync is done",
        "- the setup copy could be a little shorter",
        "- I like that the TUI keeps the audit story visible",
        "",
        "Can you take a look when you get a chance?",
        "",
        "Thanks,",
        sender.name,
      ].join("\n");
    default:
      return [
        subject,
        "",
        `${sender.name} generated this notification for the demo mailbox.`,
        "",
        "This message exists so the TUI detail view, sender stats, and search",
        "screens all have realistic data to work with.",
      ].join("\n");
  }
}

function getBaseLabelIds(senderKey: SenderKey, unread: boolean, sequence: number): string[] {
  const labels = ["INBOX"];

  if (unread) {
    labels.push("UNREAD");
  }

  switch (senderKey) {
    case "github":
    case "linear":
      labels.push("CATEGORY_UPDATES");
      break;
    case "stripe":
    case "paypal":
    case "shopify":
      labels.push(USER_LABELS.receipts);
      break;
    case "alice":
    case "bob":
    case "sarah":
      if (sequence === 0) {
        labels.push(USER_LABELS.important);
      }
      break;
    case "aws":
      if (sequence < 2) {
        labels.push(USER_LABELS.awsAlerts);
      }
      break;
    case "npm":
      labels.push(USER_LABELS.important);
      break;
  }

  return Array.from(new Set(labels));
}

function buildRawMessage(record: EmailMessage, bodyText: string): RawGmailMessage {
  return {
    id: record.id,
    threadId: record.threadId,
    snippet: record.snippet,
    internalDate: String(record.date),
    labelIds: record.labelIds,
    sizeEstimate: record.sizeEstimate,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: `${record.fromName} <${record.fromAddress}>` },
        { name: "To", value: record.toAddresses.join(", ") },
        { name: "Subject", value: record.subject },
        { name: "Date", value: new Date(record.date).toUTCString() },
        ...(record.listUnsubscribe
          ? [{ name: "List-Unsubscribe", value: record.listUnsubscribe }]
          : []),
      ],
      parts: [
        {
          mimeType: "text/plain",
          filename: "",
          body: {
            data: encodeBase64Url(bodyText),
          },
        },
      ],
    },
  };
}

function buildMessage(
  sender: SenderSpec,
  sequence: number,
  date: number,
): DemoMessageRecord {
  const subject = getSubject(sender.key, sequence);
  const bodyText = buildBody(sender, subject, sequence);
  const unread = sequence < sender.unread;
  const labelIds = getBaseLabelIds(sender.key, unread, sequence);
  const message: EmailMessage = {
    id: `demo-${sender.key}-${String(sequence + 1).padStart(2, "0")}`,
    threadId: `thread-${sender.key}-${Math.floor(sequence / 2) + 1}`,
    fromAddress: sender.email,
    fromName: sender.name,
    toAddresses: [DEMO_ACCOUNT_EMAIL],
    subject,
    snippet: bodyText.split("\n").slice(0, 3).join(" ").slice(0, 160),
    date,
    isRead: !unread,
    isStarred:
      (sender.key === "alice" && sequence === 0) ||
      (sender.key === "stripe" && sequence === 0) ||
      (sender.key === "github" && sequence === 0),
    labelIds,
    sizeEstimate: 1024 + sequence * 17,
    hasAttachments: sender.key === "stripe" || sender.key === "aws",
    listUnsubscribe: sender.hasListUnsubscribe
      ? `<mailto:unsubscribe@${sender.email.split("@")[1]}>`
      : null,
  };

  return {
    senderKey: sender.key,
    message,
    rawMessage: buildRawMessage(message, bodyText),
    bodyText,
  };
}

function makeRuleRecords(now: number): DemoRuleRecord[] {
  return [
    {
      id: "rule-label-receipts",
      name: "label-receipts",
      description: "Label emails that look like receipts",
      enabled: true,
      yamlHash: "demo-hash-label-receipts",
      conditions: {
        operator: "OR",
        matchers: [
          {
            field: "from",
            values: ["receipts@stripe.com", "service@paypal.com", "no-reply@shopify.com"],
          },
          {
            field: "subject",
            contains: ["receipt", "invoice", "order confirmation"],
          },
        ],
      },
      actions: [{ type: "label", label: "Receipts" }],
      priority: 30,
      deployedAt: now - 6 * 24 * 60 * 60 * 1000,
      createdAt: now - 6 * 24 * 60 * 60 * 1000,
    },
    {
      id: "rule-archive-newsletters",
      name: "archive-newsletters",
      description: "Archive low-engagement newsletters",
      enabled: true,
      yamlHash: "demo-hash-archive-newsletters",
      conditions: {
        operator: "AND",
        matchers: [
          {
            field: "from",
            values: ["digest@newsletterweekly.com", "hn@newsletters.hackernews.com"],
          },
        ],
      },
      actions: [{ type: "archive" }, { type: "mark_read" }],
      priority: 50,
      deployedAt: now - 5 * 24 * 60 * 60 * 1000,
      createdAt: now - 5 * 24 * 60 * 60 * 1000,
    },
    {
      id: "rule-flag-aws-alerts",
      name: "flag-aws-alerts",
      description: "Label AWS billing and maintenance alerts",
      enabled: false,
      yamlHash: "demo-hash-flag-aws-alerts",
      conditions: {
        operator: "OR",
        matchers: [
          {
            field: "from",
            values: ["no-reply@amazonaws.com"],
          },
          {
            field: "subject",
            contains: ["billing", "maintenance"],
          },
        ],
      },
      actions: [{ type: "label", label: "AWS-Alerts" }],
      priority: 40,
      deployedAt: now - 4 * 24 * 60 * 60 * 1000,
      createdAt: now - 4 * 24 * 60 * 60 * 1000,
    },
  ];
}

function pickIds(messages: DemoMessageRecord[], senderKey: SenderKey, count: number): string[] {
  return messages
    .filter((entry) => entry.senderKey === senderKey)
    .slice(0, count)
    .map((entry) => entry.message.id);
}

function makeExecutionRecords(
  now: number,
  messages: DemoMessageRecord[],
): Pick<DemoDataset, "executionRuns" | "executionItems"> {
  const receiptIds = [
    ...pickIds(messages, "stripe", 2),
    ...pickIds(messages, "paypal", 1),
    ...pickIds(messages, "shopify", 1),
  ];
  const newsletterIds = [
    ...pickIds(messages, "newsletter", 2),
    ...pickIds(messages, "hn", 2),
  ];
  const manualIds = [
    ...pickIds(messages, "alice", 1),
    ...pickIds(messages, "bob", 1),
    ...pickIds(messages, "github", 1),
  ];

  const executionRuns: DemoExecutionRunRecord[] = [
    {
      id: "run-receipts-apply",
      sourceType: "rule",
      ruleId: "rule-label-receipts",
      dryRun: false,
      requestedActions: [{ type: "label", label: "Receipts" }],
      query: null,
      status: "applied",
      createdAt: now - 3 * 24 * 60 * 60 * 1000,
      undoneAt: null,
    },
    {
      id: "run-receipts-plan",
      sourceType: "rule",
      ruleId: "rule-label-receipts",
      dryRun: true,
      requestedActions: [{ type: "label", label: "Receipts" }],
      query: null,
      status: "planned",
      createdAt: now - 3 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000,
      undoneAt: null,
    },
    {
      id: "run-newsletters-apply",
      sourceType: "rule",
      ruleId: "rule-archive-newsletters",
      dryRun: false,
      requestedActions: [{ type: "archive" }, { type: "mark_read" }],
      query: null,
      status: "applied",
      createdAt: now - 24 * 60 * 60 * 1000,
      undoneAt: null,
    },
    {
      id: "run-manual-read",
      sourceType: "manual",
      ruleId: null,
      dryRun: false,
      requestedActions: [{ type: "mark_read" }],
      query: "label:UNREAD older_than:2d",
      status: "applied",
      createdAt: now - 6 * 60 * 60 * 1000,
      undoneAt: null,
    },
    {
      id: "run-newsletters-plan",
      sourceType: "rule",
      ruleId: "rule-archive-newsletters",
      dryRun: true,
      requestedActions: [{ type: "archive" }, { type: "mark_read" }],
      query: null,
      status: "planned",
      createdAt: now - 2 * 60 * 60 * 1000,
      undoneAt: null,
    },
  ];

  const executionItems: DemoExecutionItemRecord[] = [
    ...receiptIds.map((emailId, index) => ({
      id: `item-receipts-apply-${index + 1}`,
      runId: "run-receipts-apply",
      emailId,
      status: "applied" as const,
      appliedActions: [{ type: "label", label: "Receipts" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX", USER_LABELS.receipts],
      errorMessage: null,
      executedAt: now - 3 * 24 * 60 * 60 * 1000 + index * 60 * 1000,
      undoneAt: null,
    })),
    ...receiptIds.map((emailId, index) => ({
      id: `item-receipts-plan-${index + 1}`,
      runId: "run-receipts-plan",
      emailId,
      status: "planned" as const,
      appliedActions: [{ type: "label", label: "Receipts" }],
      beforeLabelIds: ["INBOX"],
      afterLabelIds: ["INBOX", USER_LABELS.receipts],
      errorMessage: null,
      executedAt: now - 3 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000 + index * 60 * 1000,
      undoneAt: null,
    })),
    ...newsletterIds.map((emailId, index) => ({
      id: `item-newsletters-apply-${index + 1}`,
      runId: "run-newsletters-apply",
      emailId,
      status: "applied" as const,
      appliedActions: [{ type: "archive" }, { type: "mark_read" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: [],
      errorMessage: null,
      executedAt: now - 24 * 60 * 60 * 1000 + index * 60 * 1000,
      undoneAt: null,
    })),
    ...manualIds.map((emailId, index) => ({
      id: `item-manual-read-${index + 1}`,
      runId: "run-manual-read",
      emailId,
      status: "applied" as const,
      appliedActions: [{ type: "mark_read" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: ["INBOX"],
      errorMessage: null,
      executedAt: now - 6 * 60 * 60 * 1000 + index * 60 * 1000,
      undoneAt: null,
    })),
    ...newsletterIds.map((emailId, index) => ({
      id: `item-newsletters-plan-${index + 1}`,
      runId: "run-newsletters-plan",
      emailId,
      status: "planned" as const,
      appliedActions: [{ type: "archive" }, { type: "mark_read" }],
      beforeLabelIds: ["INBOX", "UNREAD"],
      afterLabelIds: [],
      errorMessage: null,
      executedAt: now - 2 * 60 * 60 * 1000 + index * 60 * 1000,
      undoneAt: null,
    })),
  ];

  return { executionRuns, executionItems };
}

function makeNewsletterRecords(messages: DemoMessageRecord[]): DemoNewsletterRecord[] {
  const senders = [
    {
      email: "digest@newsletterweekly.com",
      name: "Newsletter Weekly",
      reason: "list-unsubscribe,high-unread",
    },
    {
      email: "hn@newsletters.hackernews.com",
      name: "Hacker News Digest",
      reason: "list-unsubscribe,high-unread",
    },
    {
      email: "no-reply@amazonaws.com",
      name: "AWS Notifications",
      reason: "noreply-pattern,high-unread",
    },
    {
      email: "noreply@docker.com",
      name: "Docker Hub",
      reason: "noreply-pattern",
    },
    {
      email: "notifications@github.com",
      name: "GitHub",
      reason: "high-volume",
    },
    {
      email: "notification@slack.com",
      name: "Slack",
      reason: "noreply-pattern",
    },
  ];

  return senders.map((sender, index) => {
    const matching = messages.filter((entry) => entry.message.fromAddress === sender.email);

    return {
      id: `newsletter-${index + 1}`,
      email: sender.email,
      name: sender.name,
      messageCount: matching.length,
      unreadCount: matching.filter((entry) => !entry.message.isRead).length,
      status: "active",
      unsubscribeLink: matching[0]?.message.listUnsubscribe || null,
      detectionReason: sender.reason,
      firstSeen: matching[matching.length - 1]?.message.date || Date.now(),
      lastSeen: matching[0]?.message.date || Date.now(),
    };
  });
}

export function buildDemoDataset(referenceNow: number = Date.now()): DemoDataset {
  const timestamps = buildTimestamps(referenceNow, 150);
  const remaining = new Map<SenderKey, number>(
    SENDERS.map((sender) => [sender.key, sender.count]),
  );
  const sequenceBySender = new Map<SenderKey, number>();
  const senderByKey = new Map(SENDERS.map((sender) => [sender.key, sender]));
  const rng = createRng(42);
  const messages: DemoMessageRecord[] = [];

  for (let index = 0; index < timestamps.length; index += 1) {
    const senderKey = chooseSender(index, remaining, rng);
    const sender = senderByKey.get(senderKey);

    if (!sender) {
      throw new Error(`Missing demo sender spec for ${senderKey}`);
    }

    const sequence = sequenceBySender.get(senderKey) || 0;
    messages.push(buildMessage(sender, sequence, timestamps[index] || referenceNow));
    sequenceBySender.set(senderKey, sequence + 1);
  }

  messages.sort((left, right) => right.message.date - left.message.date);

  const rules = makeRuleRecords(referenceNow);
  const { executionRuns, executionItems } = makeExecutionRecords(referenceNow, messages);

  return {
    accountEmail: DEMO_ACCOUNT_EMAIL,
    historyId: "12345678",
    labels: DEMO_LABELS.map((label) => ({ ...label })),
    messages,
    rules,
    executionRuns,
    executionItems,
    newsletters: makeNewsletterRecords(messages),
    filters: [],
  };
}

export function seedDemoData(
  sqlite: Database.Database,
  referenceNow: number = Date.now(),
): DemoDataset {
  const dataset = buildDemoDataset(referenceNow);

  sqlite.exec(`
    DELETE FROM execution_items;
    DELETE FROM execution_runs;
    DELETE FROM rules;
    DELETE FROM newsletter_senders;
    DELETE FROM emails;
  `);

  const insertEmail = sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRule = sqlite.prepare(`
    INSERT INTO rules (
      id, name, description, enabled, yaml_hash, conditions, actions, priority, deployed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRun = sqlite.prepare(`
    INSERT INTO execution_runs (
      id, source_type, rule_id, dry_run, requested_actions, query, status, created_at, undone_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = sqlite.prepare(`
    INSERT INTO execution_items (
      id, run_id, email_id, status, applied_actions, before_label_ids, after_label_ids, error_message, executed_at, undone_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertNewsletter = sqlite.prepare(`
    INSERT INTO newsletter_senders (
      id, email, name, message_count, unread_count, status, unsubscribe_link, detection_reason, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = sqlite.transaction(() => {
    for (const entry of dataset.messages) {
      insertEmail.run(
        entry.message.id,
        entry.message.threadId,
        entry.message.fromAddress,
        entry.message.fromName,
        JSON.stringify(entry.message.toAddresses),
        entry.message.subject,
        entry.message.snippet,
        entry.message.date,
        entry.message.isRead ? 1 : 0,
        entry.message.isStarred ? 1 : 0,
        JSON.stringify(entry.message.labelIds),
        entry.message.sizeEstimate,
        entry.message.hasAttachments ? 1 : 0,
        entry.message.listUnsubscribe,
        referenceNow,
      );
    }

    for (const rule of dataset.rules) {
      insertRule.run(
        rule.id,
        rule.name,
        rule.description,
        rule.enabled ? 1 : 0,
        rule.yamlHash,
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        rule.priority,
        rule.deployedAt,
        rule.createdAt,
      );
    }

    for (const run of dataset.executionRuns) {
      insertRun.run(
        run.id,
        run.sourceType,
        run.ruleId,
        run.dryRun ? 1 : 0,
        JSON.stringify(run.requestedActions),
        run.query,
        run.status,
        run.createdAt,
        run.undoneAt,
      );
    }

    for (const item of dataset.executionItems) {
      insertItem.run(
        item.id,
        item.runId,
        item.emailId,
        item.status,
        JSON.stringify(item.appliedActions),
        JSON.stringify(item.beforeLabelIds),
        JSON.stringify(item.afterLabelIds),
        item.errorMessage,
        item.executedAt,
        item.undoneAt,
      );
    }

    for (const newsletter of dataset.newsletters) {
      insertNewsletter.run(
        newsletter.id,
        newsletter.email,
        newsletter.name,
        newsletter.messageCount,
        newsletter.unreadCount,
        newsletter.status,
        newsletter.unsubscribeLink,
        newsletter.detectionReason,
        newsletter.firstSeen,
        newsletter.lastSeen,
      );
    }

    sqlite
      .prepare(
        `
        UPDATE sync_state
        SET account_email = ?,
            history_id = ?,
            last_full_sync = ?,
            last_incremental_sync = ?,
            total_messages = ?,
            full_sync_cursor = NULL,
            full_sync_processed = 0,
            full_sync_total = 0
        WHERE id = 1
        `,
      )
      .run(
        dataset.accountEmail,
        dataset.historyId,
        referenceNow - 2 * 60 * 60 * 1000,
        referenceNow - 5 * 60 * 1000,
        dataset.messages.length,
      );
  });

  transaction();
  return dataset;
}

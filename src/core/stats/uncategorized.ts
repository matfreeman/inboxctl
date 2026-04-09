import { detectNewsletters } from "./newsletters.js";
import {
  computeConfidence,
  getStatsSqlite,
  normalizeLimit,
  roundPercent,
} from "./common.js";

const SYSTEM_LABEL_IDS = [
  "INBOX",
  "UNREAD",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
] as const;

const CATEGORY_LABEL_PATTERN = "CATEGORY\\_%";

export interface UncategorizedEmailSenderContext {
  totalFromSender: number;
  unreadRate: number;
  isNewsletter: boolean;
  detectionReason: string | null;
  confidence: "high" | "medium" | "low";
  signals: string[];
}

export interface UncategorizedEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string | null;
  snippet: string;
  labels: string[];
  isRead: boolean;
  senderContext: UncategorizedEmailSenderContext;
}

export interface UncategorizedEmailsResult {
  totalUncategorized: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  emails: UncategorizedEmail[];
}

export interface GetUncategorizedEmailsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  since?: string;
}

interface UncategorizedEmailRow {
  id: string;
  threadId: string | null;
  sender: string | null;
  subject: string | null;
  date: number | null;
  snippet: string | null;
  labelIds: string | null;
  isRead: number | null;
  totalFromSender: number | null;
  unreadFromSender: number | null;
  detectionReason: string | null;
  listUnsubscribe: string | null;
}

function toIsoString(value: number | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
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

function resolveSinceTimestamp(since: string | undefined): number | null {
  if (!since) {
    return null;
  }

  const parsed = Date.parse(since);

  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid since value: ${since}`);
  }

  return parsed;
}

function buildWhereClause(options: {
  sinceTimestamp: number | null;
  unreadOnly: boolean;
}): { clause: string; params: Array<number | string> } {
  const whereParts = [
    `
    NOT EXISTS (
      SELECT 1
      FROM json_each(COALESCE(e.label_ids, '[]')) AS label
      WHERE label.value IS NOT NULL
        AND TRIM(CAST(label.value AS TEXT)) <> ''
        AND label.value NOT IN (${SYSTEM_LABEL_IDS.map(() => "?").join(", ")})
        AND label.value NOT LIKE ? ESCAPE '\\'
    )
    `,
  ];
  const params: Array<number | string> = [...SYSTEM_LABEL_IDS, CATEGORY_LABEL_PATTERN];

  if (options.unreadOnly) {
    whereParts.push("COALESCE(e.is_read, 0) = 0");
  }

  if (options.sinceTimestamp !== null) {
    whereParts.push("COALESCE(e.date, 0) >= ?");
    params.push(options.sinceTimestamp);
  }

  return {
    clause: whereParts.join(" AND "),
    params,
  };
}

export async function getUncategorizedEmails(
  options: GetUncategorizedEmailsOptions = {},
): Promise<UncategorizedEmailsResult> {
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const limit = Math.min(1000, normalizeLimit(options.limit, 50));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const sinceTimestamp = resolveSinceTimestamp(options.since);
  const { clause, params } = buildWhereClause({
    sinceTimestamp,
    unreadOnly: options.unreadOnly ?? false,
  });

  const totalRow = sqlite
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM emails AS e
      WHERE ${clause}
      `,
    )
    .get(...params) as { total: number } | undefined;

  const rows = sqlite
    .prepare(
      `
      SELECT
        e.id AS id,
        e.thread_id AS threadId,
        e.from_address AS sender,
        e.subject AS subject,
        e.date AS date,
        e.snippet AS snippet,
        e.label_ids AS labelIds,
        e.is_read AS isRead,
        sender_stats.totalFromSender AS totalFromSender,
        sender_stats.unreadFromSender AS unreadFromSender,
        ns.detection_reason AS detectionReason,
        e.list_unsubscribe AS listUnsubscribe
      FROM emails AS e
      LEFT JOIN (
        SELECT
          LOWER(from_address) AS senderKey,
          COUNT(*) AS totalFromSender,
          SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadFromSender
        FROM emails
        WHERE from_address IS NOT NULL
          AND TRIM(from_address) <> ''
        GROUP BY LOWER(from_address)
      ) AS sender_stats
        ON sender_stats.senderKey = LOWER(e.from_address)
      LEFT JOIN newsletter_senders AS ns
        ON LOWER(ns.email) = LOWER(e.from_address)
      WHERE ${clause}
      ORDER BY COALESCE(e.date, 0) DESC, e.id ASC
      LIMIT ?
      OFFSET ?
      `,
    )
    .all(...params, limit, offset) as UncategorizedEmailRow[];

  const emails = rows.map((row) => {
    const totalFromSender = row.totalFromSender ?? 0;
    const unreadFromSender = row.unreadFromSender ?? 0;
    const confidence = computeConfidence(row);

    return {
      id: row.id,
      threadId: row.threadId || "",
      from: row.sender || "",
      subject: row.subject || "",
      date: toIsoString(row.date),
      snippet: row.snippet || "",
      labels: parseJsonArray(row.labelIds),
      isRead: row.isRead === 1,
      senderContext: {
        totalFromSender,
        unreadRate: roundPercent(unreadFromSender, totalFromSender),
        isNewsletter: Boolean(row.detectionReason),
        detectionReason: row.detectionReason,
        confidence: confidence.confidence,
        signals: confidence.signals,
      },
    };
  });

  return {
    totalUncategorized: totalRow?.total ?? 0,
    returned: emails.length,
    offset,
    hasMore: offset + emails.length < (totalRow?.total ?? 0),
    emails,
  };
}

import { resolveUnsubscribeTarget } from "../unsubscribe.js";
import {
  computeConfidence,
  extractDomain,
  getStatsSqlite,
  normalizeLimit,
  roundPercent,
} from "./common.js";
import { detectNewsletters } from "./newsletters.js";

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
const MAX_EMAIL_IDS = 500;
const EXCLUDED_UNCATEGORIZED_LABELS = ["SPAM", "TRASH"] as const;

export type UncategorizedSenderConfidence = "high" | "medium" | "low";
export type UncategorizedSenderSort = "email_count" | "newest" | "unread_rate";

export interface UncategorizedSender {
  sender: string;
  name: string;
  emailCount: number;
  emailIds?: string[];
  emailIdsTruncated?: boolean;
  unreadCount: number;
  unreadRate: number;
  newestDate: string | null;
  newestSubject: string | null;
  isNewsletter: boolean;
  hasUnsubscribe: boolean;
  confidence: UncategorizedSenderConfidence;
  signals: string[];
  totalFromSender: number;
  domain: string;
}

export interface UncategorizedSendersResult {
  totalSenders: number;
  totalEmails: number;
  returned: number;
  offset: number;
  hasMore: boolean;
  senders: UncategorizedSender[];
  summary: {
    byConfidence: {
      high: { senders: number; emails: number };
      medium: { senders: number; emails: number };
      low: { senders: number; emails: number };
    };
    topDomains: Array<{ domain: string; emails: number; senders: number }>;
  };
}

export interface GetUncategorizedSendersOptions {
  limit?: number;
  offset?: number;
  minEmails?: number;
  confidence?: UncategorizedSenderConfidence;
  since?: string;
  sortBy?: UncategorizedSenderSort;
  includeEmailIds?: boolean;
}

interface UncategorizedSenderRow {
  sender: string | null;
  name: string | null;
  emailCount: number;
  unreadCount: number;
  newestDate: number | null;
  newestSubject: string | null;
  detectionReason: string | null;
  newsletterUnsubscribeLink: string | null;
  emailUnsubscribeHeaders: string | null;
  totalFromSender: number | null;
  emailIds: string | null;
}

function toIsoString(value: number | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
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

function buildWhereClause(sinceTimestamp: number | null): {
  clause: string;
  params: Array<number | string>;
} {
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
    `
    NOT EXISTS (
      SELECT 1
      FROM json_each(COALESCE(e.label_ids, '[]')) AS label
      WHERE label.value IN (${EXCLUDED_UNCATEGORIZED_LABELS.map(() => "?").join(", ")})
    )
    `,
  ];
  const params: Array<number | string> = [
    ...SYSTEM_LABEL_IDS,
    CATEGORY_LABEL_PATTERN,
    ...EXCLUDED_UNCATEGORIZED_LABELS,
  ];

  if (sinceTimestamp !== null) {
    whereParts.push("COALESCE(e.date, 0) >= ?");
    params.push(sinceTimestamp);
  }

  return {
    clause: whereParts.join(" AND "),
    params,
  };
}

function parseEmailIds(raw: string | null): { emailIds: string[]; truncated: boolean } {
  const ids = (raw || "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    emailIds: ids.slice(0, MAX_EMAIL_IDS),
    truncated: ids.length > MAX_EMAIL_IDS,
  };
}

function compareSenders(sortBy: UncategorizedSenderSort) {
  return (left: UncategorizedSender, right: UncategorizedSender) => {
    switch (sortBy) {
      case "newest":
        return (
          (right.newestDate || "").localeCompare(left.newestDate || "") ||
          right.emailCount - left.emailCount ||
          right.unreadRate - left.unreadRate ||
          left.sender.localeCompare(right.sender)
        );
      case "unread_rate":
        return (
          right.unreadRate - left.unreadRate ||
          right.emailCount - left.emailCount ||
          (right.newestDate || "").localeCompare(left.newestDate || "") ||
          left.sender.localeCompare(right.sender)
        );
      case "email_count":
      default:
        return (
          right.emailCount - left.emailCount ||
          (right.newestDate || "").localeCompare(left.newestDate || "") ||
          right.unreadRate - left.unreadRate ||
          left.sender.localeCompare(right.sender)
        );
    }
  };
}

export async function getUncategorizedSenders(
  options: GetUncategorizedSendersOptions = {},
): Promise<UncategorizedSendersResult> {
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const limit = Math.min(500, normalizeLimit(options.limit, 50));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const minEmails = Math.max(1, Math.floor(options.minEmails ?? 1));
  const sinceTimestamp = resolveSinceTimestamp(options.since);
  const sortBy = options.sortBy ?? "email_count";
  const includeEmailIds = options.includeEmailIds ?? false;
  const { clause, params } = buildWhereClause(sinceTimestamp);

  const rows = sqlite
    .prepare(
      `
      WITH uncategorized AS (
        SELECT
          e.id,
          e.from_address,
          e.from_name,
          e.subject,
          e.snippet,
          e.date,
          e.is_read,
          e.list_unsubscribe
        FROM emails AS e
        WHERE e.from_address IS NOT NULL
          AND TRIM(e.from_address) <> ''
          AND ${clause}
      ),
      sender_totals AS (
        SELECT
          LOWER(from_address) AS senderKey,
          COUNT(*) AS totalFromSender
        FROM emails
        WHERE from_address IS NOT NULL
          AND TRIM(from_address) <> ''
        GROUP BY LOWER(from_address)
      )
      SELECT
        grouped.sender AS sender,
        grouped.name AS name,
        grouped.emailCount AS emailCount,
        grouped.unreadCount AS unreadCount,
        grouped.newestDate AS newestDate,
        (
          SELECT u2.subject
          FROM uncategorized AS u2
          WHERE LOWER(u2.from_address) = grouped.senderKey
          ORDER BY COALESCE(u2.date, 0) DESC, u2.id ASC
          LIMIT 1
        ) AS newestSubject,
        grouped.detectionReason AS detectionReason,
        grouped.newsletterUnsubscribeLink AS newsletterUnsubscribeLink,
        grouped.emailUnsubscribeHeaders AS emailUnsubscribeHeaders,
        COALESCE(sender_totals.totalFromSender, grouped.emailCount) AS totalFromSender,
        ${includeEmailIds
          ? `
        (
          SELECT GROUP_CONCAT(u2.id, '\n')
          FROM (
            SELECT id
            FROM uncategorized
            WHERE LOWER(from_address) = grouped.senderKey
            ORDER BY COALESCE(date, 0) DESC, id ASC
          ) AS u2
        ) AS emailIds
        `
          : "NULL AS emailIds"}
      FROM (
        SELECT
          LOWER(u.from_address) AS senderKey,
          MAX(u.from_address) AS sender,
          COALESCE(MAX(NULLIF(TRIM(u.from_name), '')), MAX(u.from_address)) AS name,
          COUNT(*) AS emailCount,
          SUM(CASE WHEN COALESCE(u.is_read, 0) = 0 THEN 1 ELSE 0 END) AS unreadCount,
          MAX(u.date) AS newestDate,
          MAX(ns.detection_reason) AS detectionReason,
          MAX(NULLIF(TRIM(ns.unsubscribe_link), '')) AS newsletterUnsubscribeLink,
          GROUP_CONCAT(NULLIF(TRIM(u.list_unsubscribe), ''), '\n') AS emailUnsubscribeHeaders
        FROM uncategorized AS u
        LEFT JOIN newsletter_senders AS ns
          ON LOWER(ns.email) = LOWER(u.from_address)
        GROUP BY LOWER(u.from_address)
        HAVING COUNT(*) >= ?
      ) AS grouped
      LEFT JOIN sender_totals
        ON sender_totals.senderKey = grouped.senderKey
      `,
    )
    .all(...params, minEmails) as UncategorizedSenderRow[];

  const filtered = rows
    .map((row) => {
      const confidenceResult = computeConfidence({
        sender: row.sender,
        totalFromSender: row.totalFromSender,
        detectionReason: row.detectionReason,
        listUnsubscribe: row.emailUnsubscribeHeaders,
      });
      const unsubscribe = resolveUnsubscribeTarget(
        row.newsletterUnsubscribeLink,
        row.emailUnsubscribeHeaders,
      );
      const sender = row.sender?.trim() || "";
      const domain = extractDomain(sender) || "";
      const emailIds = includeEmailIds ? parseEmailIds(row.emailIds) : null;

      return {
        sender,
        name: row.name?.trim() || sender,
        emailCount: row.emailCount,
        unreadCount: row.unreadCount,
        unreadRate: roundPercent(row.unreadCount, row.emailCount),
        newestDate: toIsoString(row.newestDate),
        newestSubject: row.newestSubject || null,
        isNewsletter: Boolean(row.detectionReason || unsubscribe.unsubscribeLink),
        hasUnsubscribe: Boolean(unsubscribe.unsubscribeLink),
        confidence: confidenceResult.confidence,
        signals: confidenceResult.signals,
        totalFromSender: row.totalFromSender ?? row.emailCount,
        domain,
        ...(emailIds
          ? {
              emailIds: emailIds.emailIds,
              emailIdsTruncated: emailIds.truncated,
            }
          : {}),
      } satisfies UncategorizedSender;
    })
    .filter((sender) => options.confidence ? sender.confidence === options.confidence : true)
    .sort(compareSenders(sortBy));

  const totalSenders = filtered.length;
  const totalEmails = filtered.reduce((sum, sender) => sum + sender.emailCount, 0);
  const byConfidence = filtered.reduce<UncategorizedSendersResult["summary"]["byConfidence"]>(
    (summary, sender) => {
      summary[sender.confidence].senders += 1;
      summary[sender.confidence].emails += sender.emailCount;
      return summary;
    },
    {
      high: { senders: 0, emails: 0 },
      medium: { senders: 0, emails: 0 },
      low: { senders: 0, emails: 0 },
    },
  );

  const topDomains = Array.from(
    filtered.reduce((domains, sender) => {
      if (!sender.domain) {
        return domains;
      }

      const entry = domains.get(sender.domain) || {
        domain: sender.domain,
        emails: 0,
        senders: 0,
      };
      entry.emails += sender.emailCount;
      entry.senders += 1;
      domains.set(sender.domain, entry);
      return domains;
    }, new Map<string, { domain: string; emails: number; senders: number }>()),
  )
    .map(([, entry]) => entry)
    .sort((left, right) =>
      right.emails - left.emails ||
      right.senders - left.senders ||
      left.domain.localeCompare(right.domain),
    )
    .slice(0, 5);

  const senders = filtered.slice(offset, offset + limit);

  return {
    totalSenders,
    totalEmails,
    returned: senders.length,
    offset,
    hasMore: offset + senders.length < totalSenders,
    senders,
    summary: {
      byConfidence,
      topDomains,
    },
  };
}

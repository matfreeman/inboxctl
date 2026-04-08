import { randomUUID } from "node:crypto";
import {
  clampPercentage,
  getStatsSqlite,
  normalizeLimit,
  roundPercent,
} from "./common.js";

export type NewsletterStatus = "active" | "unsubscribed" | "archived";

export interface NewsletterOptions {
  minMessages?: number;
  minUnreadRate?: number;
  status?: NewsletterStatus | "all";
}

export interface NewsletterSender {
  email: string;
  name: string;
  messageCount: number;
  unreadCount: number;
  unreadRate: number;
  status: NewsletterStatus;
  unsubscribeLink: string | null;
  firstSeen: Date;
  lastSeen: Date;
  detectionReason: string;
}

interface NewsletterAggregateRow {
  email: string;
  name: string | null;
  messageCount: number;
  unreadCount: number;
  firstSeen: number;
  lastSeen: number;
  unsubscribeLink: string | null;
  recipientPatternCount: number;
}

interface NewsletterRow {
  email: string;
  name: string | null;
  messageCount: number;
  unreadCount: number;
  status: NewsletterStatus;
  unsubscribeLink: string | null;
  firstSeen: number;
  lastSeen: number;
  detectionReason: string;
}

interface DetectedNewsletterRow {
  id: string;
  email: string;
  name: string;
  messageCount: number;
  unreadCount: number;
  unsubscribeLink: string | null;
  detectionReason: string;
  firstSeen: number;
  lastSeen: number;
}

const KNOWN_NEWSLETTER_LOCAL_PART =
  /^(newsletter|digest|noreply|no-reply|updates|news)([+._-].*)?$/i;

function extractNewsletterReasons(row: NewsletterAggregateRow): string[] {
  const reasons: string[] = [];
  const localPart = row.email.split("@")[0] || "";
  const unreadRate = roundPercent(row.unreadCount, row.messageCount);

  if (row.unsubscribeLink) {
    reasons.push("list_unsubscribe");
  }

  if (row.messageCount > 5 && unreadRate > 50) {
    reasons.push("high_volume_high_unread");
  }

  if (KNOWN_NEWSLETTER_LOCAL_PART.test(localPart)) {
    reasons.push("known_sender_pattern");
  }

  if (row.recipientPatternCount > 1) {
    reasons.push("bulk_sender_pattern");
  }

  return reasons;
}

function normalizeUnsubscribeLink(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const header = value.trim();
  const match = header.match(/<([^>]+)>/);

  return match?.[1]?.trim() || header.split(",")[0]?.trim() || null;
}

function mapNewsletterRow(row: NewsletterRow): NewsletterSender {
  return {
    email: row.email,
    name: row.name?.trim() || row.email,
    messageCount: row.messageCount,
    unreadCount: row.unreadCount,
    unreadRate: roundPercent(row.unreadCount, row.messageCount),
    status: row.status,
    unsubscribeLink: row.unsubscribeLink,
    firstSeen: new Date(row.firstSeen),
    lastSeen: new Date(row.lastSeen),
    detectionReason: row.detectionReason,
  };
}

export async function detectNewsletters(): Promise<NewsletterSender[]> {
  const sqlite = getStatsSqlite();
  const rows = sqlite
    .prepare(
      `
      SELECT
        from_address AS email,
        COALESCE(MAX(NULLIF(TRIM(from_name), '')), from_address) AS name,
        COUNT(*) AS messageCount,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
        MIN(date) AS firstSeen,
        MAX(date) AS lastSeen,
        MAX(NULLIF(TRIM(list_unsubscribe), '')) AS unsubscribeLink,
        COUNT(DISTINCT to_addresses) AS recipientPatternCount
      FROM emails
      WHERE from_address IS NOT NULL
        AND TRIM(from_address) <> ''
      GROUP BY from_address
      `,
    )
    .all() as NewsletterAggregateRow[];

  const detected: DetectedNewsletterRow[] = [];

  for (const row of rows) {
    const reasons = extractNewsletterReasons(row);

    if (reasons.length === 0) {
      continue;
    }

    detected.push({
      id: randomUUID(),
      email: row.email,
      name: row.name?.trim() || row.email,
      messageCount: row.messageCount,
      unreadCount: row.unreadCount,
      unsubscribeLink: normalizeUnsubscribeLink(row.unsubscribeLink),
      detectionReason: reasons.join(", "),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    });
  }

  const upsert = sqlite.prepare(
    `
    INSERT INTO newsletter_senders (
      id,
      email,
      name,
      message_count,
      unread_count,
      status,
      unsubscribe_link,
      detection_reason,
      first_seen,
      last_seen
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = excluded.name,
      message_count = excluded.message_count,
      unread_count = excluded.unread_count,
      unsubscribe_link = excluded.unsubscribe_link,
      detection_reason = excluded.detection_reason,
      first_seen = excluded.first_seen,
      last_seen = excluded.last_seen
    `,
  );

  const transaction = sqlite.transaction(
    (
      entries: DetectedNewsletterRow[],
    ) => {
      for (const entry of entries) {
        upsert.run(
          entry.id,
          entry.email,
          entry.name,
          entry.messageCount,
          entry.unreadCount,
          entry.unsubscribeLink,
          entry.detectionReason,
          entry.firstSeen,
          entry.lastSeen,
        );
      }
    },
  );

  transaction(detected);

  return detected.map((row) => ({
    email: row.email,
    name: row.name,
    messageCount: row.messageCount,
    unreadCount: row.unreadCount,
    unreadRate: roundPercent(row.unreadCount, row.messageCount),
    status: "active",
    unsubscribeLink: row.unsubscribeLink,
    firstSeen: new Date(row.firstSeen),
    lastSeen: new Date(row.lastSeen),
    detectionReason: row.detectionReason,
  }));
}

export async function getNewsletters(
  options: NewsletterOptions = {},
): Promise<NewsletterSender[]> {
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const minMessages = normalizeLimit(options.minMessages, 1);
  const minUnreadRate = clampPercentage(options.minUnreadRate, 0);
  const status = options.status || "active";

  const rows = sqlite
    .prepare(
      `
      SELECT
        email,
        name,
        message_count AS messageCount,
        unread_count AS unreadCount,
        status,
        unsubscribe_link AS unsubscribeLink,
        first_seen AS firstSeen,
        last_seen AS lastSeen,
        detection_reason AS detectionReason
      FROM newsletter_senders
      WHERE message_count >= ?
        AND (100.0 * unread_count / CASE WHEN message_count = 0 THEN 1 ELSE message_count END) >= ?
        AND (? = 'all' OR status = ?)
      ORDER BY message_count DESC, unreadCount DESC, lastSeen DESC, email ASC
      `,
    )
    .all(minMessages, minUnreadRate, status, status) as NewsletterRow[];

  return rows.map(mapNewsletterRow);
}

export async function updateNewsletterStatus(
  email: string,
  status: NewsletterStatus,
): Promise<void> {
  if (!["active", "unsubscribed", "archived"].includes(status)) {
    throw new Error(`Invalid newsletter status: ${status}`);
  }

  const sqlite = getStatsSqlite();
  const result = sqlite
    .prepare(
      `
      UPDATE newsletter_senders
      SET status = ?
      WHERE LOWER(email) = LOWER(?)
      `,
    )
    .run(status, email.trim());

  if (result.changes === 0) {
    throw new Error(`Newsletter sender not found: ${email}`);
  }
}

import { resolveUnsubscribeTarget } from "../unsubscribe.js";
import { detectNewsletters } from "./newsletters.js";
import { extractDomain, getStatsSqlite, normalizeLimit, roundPercent } from "./common.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const SUGGESTED_CATEGORY_RULES = [
  { category: "Receipts", keywords: ["receipt", "invoice", "payment", "order"] },
  { category: "Shipping", keywords: ["shipping", "tracking", "delivery", "dispatch"] },
  { category: "Newsletters", keywords: ["newsletter", "digest", "weekly", "update"] },
  { category: "Notifications", keywords: ["noreply", "notification", "alert"] },
  { category: "Promotions", keywords: ["promo", "offer", "deal", "sale", "marketing"] },
  { category: "Social", keywords: ["linkedin", "facebook", "twitter", "social"] },
] as const;

export type NoiseSenderSort =
  | "noise_score"
  | "all_time_noise_score"
  | "message_count"
  | "unread_rate";

export interface NoiseSender {
  email: string;
  name: string;
  messageCount: number;
  allTimeMessageCount: number;
  unreadCount: number;
  unreadRate: number;
  noiseScore: number;
  allTimeNoiseScore: number;
  lastSeen: string | null;
  isNewsletter: boolean;
  hasUnsubscribeLink: boolean;
  unsubscribeLink: string | null;
  suggestedCategory: string;
}

export interface NoiseSendersResult {
  senders: NoiseSender[];
}

export interface GetNoiseSendersOptions {
  limit?: number;
  minNoiseScore?: number;
  activeDays?: number;
  sortBy?: NoiseSenderSort;
}

interface NoiseSenderRow {
  email: string;
  name: string | null;
  messageCount: number;
  unreadCount: number;
  lastSeen: number | null;
  newsletterUnsubscribeLink: string | null;
  emailUnsubscribeHeaders: string | null;
  isNewsletter: number;
  allTimeMessageCount: number | null;
  allTimeUnreadCount: number | null;
}

function toIsoString(value: number | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function roundNoiseScore(messageCount: number, unreadRate: number): number {
  return Math.round((messageCount * unreadRate * 10) / 100) / 10;
}

function getSuggestedCategory(email: string, name: string, isNewsletter: boolean): string {
  const haystack = `${email} ${name}`.toLowerCase();
  const domain = extractDomain(email) || "";

  if (isNewsletter) {
    if (
      haystack.includes("promo") ||
      haystack.includes("offer") ||
      haystack.includes("deal") ||
      haystack.includes("sale") ||
      haystack.includes("marketing") ||
      domain.includes("marketing.") ||
      domain.includes("mailer.") ||
      domain.includes("email.")
    ) {
      return "Promotions";
    }
  }

  for (const rule of SUGGESTED_CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return rule.category;
    }
  }

  if (isNewsletter) {
    if (
      domain.includes("edm.") ||
      domain.includes("email.") ||
      domain.includes("mailer.") ||
      domain.includes("newsletter.") ||
      domain.includes("marketing.")
    ) {
      return "Newsletters";
    }

    return "Newsletters";
  }

  return "Other";
}

function compareNoiseSenders(sortBy: NoiseSenderSort) {
  return (left: NoiseSender, right: NoiseSender) => {
    switch (sortBy) {
      case "all_time_noise_score":
        return (
          right.allTimeNoiseScore - left.allTimeNoiseScore ||
          right.noiseScore - left.noiseScore ||
          right.allTimeMessageCount - left.allTimeMessageCount ||
          (right.lastSeen || "").localeCompare(left.lastSeen || "") ||
          left.email.localeCompare(right.email)
        );
      case "message_count":
        return (
          right.messageCount - left.messageCount ||
          right.noiseScore - left.noiseScore ||
          right.allTimeMessageCount - left.allTimeMessageCount ||
          (right.lastSeen || "").localeCompare(left.lastSeen || "") ||
          left.email.localeCompare(right.email)
        );
      case "unread_rate":
        return (
          right.unreadRate - left.unreadRate ||
          right.noiseScore - left.noiseScore ||
          right.messageCount - left.messageCount ||
          (right.lastSeen || "").localeCompare(left.lastSeen || "") ||
          left.email.localeCompare(right.email)
        );
      case "noise_score":
      default:
        return (
          right.noiseScore - left.noiseScore ||
          right.allTimeNoiseScore - left.allTimeNoiseScore ||
          right.messageCount - left.messageCount ||
          (right.lastSeen || "").localeCompare(left.lastSeen || "") ||
          left.email.localeCompare(right.email)
        );
    }
  };
}

export async function getNoiseSenders(
  options: GetNoiseSendersOptions = {},
): Promise<NoiseSendersResult> {
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const limit = Math.min(50, normalizeLimit(options.limit, 20));
  const minNoiseScore = options.minNoiseScore ?? 5;
  const activeDays = Math.max(1, Math.floor(options.activeDays ?? 90));
  const activeSince = Date.now() - activeDays * DAY_MS;
  const sortBy = options.sortBy ?? "noise_score";

  const rows = sqlite
    .prepare(
      `
      SELECT
        e.from_address AS email,
        COALESCE(MAX(NULLIF(TRIM(e.from_name), '')), e.from_address) AS name,
        COUNT(*) AS messageCount,
        SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
        MAX(e.date) AS lastSeen,
        MAX(NULLIF(TRIM(ns.unsubscribe_link), '')) AS newsletterUnsubscribeLink,
        GROUP_CONCAT(NULLIF(TRIM(e.list_unsubscribe), ''), '\n') AS emailUnsubscribeHeaders,
        MAX(CASE WHEN ns.email IS NOT NULL THEN 1 ELSE 0 END) AS isNewsletter,
        COALESCE(MAX(all_time.allTimeCount), COUNT(*)) AS allTimeMessageCount,
        COALESCE(
          MAX(all_time.allTimeUnreadCount),
          SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END)
        ) AS allTimeUnreadCount
      FROM emails AS e
      LEFT JOIN newsletter_senders AS ns
        ON LOWER(ns.email) = LOWER(e.from_address)
      LEFT JOIN (
        SELECT
          LOWER(from_address) AS senderKey,
          COUNT(*) AS allTimeCount,
          SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS allTimeUnreadCount
        FROM emails
        WHERE from_address IS NOT NULL
          AND TRIM(from_address) <> ''
        GROUP BY LOWER(from_address)
      ) AS all_time
        ON all_time.senderKey = LOWER(e.from_address)
      WHERE e.from_address IS NOT NULL
        AND TRIM(e.from_address) <> ''
        AND COALESCE(e.date, 0) >= ?
      GROUP BY LOWER(e.from_address)
      `,
    )
    .all(activeSince) as NoiseSenderRow[];

  const senders = rows
    .map((row) => {
      const unreadRate = roundPercent(row.unreadCount, row.messageCount);
      const allTimeMessageCount = row.allTimeMessageCount ?? row.messageCount;
      const allTimeUnreadCount = row.allTimeUnreadCount ?? row.unreadCount;
      const allTimeUnreadRate = roundPercent(allTimeUnreadCount, allTimeMessageCount);
      const noiseScore = roundNoiseScore(row.messageCount, unreadRate);
      const allTimeNoiseScore = roundNoiseScore(allTimeMessageCount, allTimeUnreadRate);
      const unsubscribe = resolveUnsubscribeTarget(
        row.newsletterUnsubscribeLink,
        row.emailUnsubscribeHeaders,
      );
      const isNewsletter = row.isNewsletter === 1;

      return {
        email: row.email,
        name: row.name?.trim() || row.email,
        messageCount: row.messageCount,
        allTimeMessageCount,
        unreadCount: row.unreadCount,
        unreadRate,
        noiseScore,
        allTimeNoiseScore,
        lastSeen: toIsoString(row.lastSeen),
        isNewsletter,
        hasUnsubscribeLink: Boolean(unsubscribe.unsubscribeLink),
        unsubscribeLink: unsubscribe.unsubscribeLink,
        suggestedCategory: getSuggestedCategory(
          row.email,
          row.name?.trim() || row.email,
          isNewsletter,
        ),
      };
    })
    .filter((sender) => sender.noiseScore >= minNoiseScore)
    .sort(compareNoiseSenders(sortBy))
    .slice(0, limit);

  return { senders };
}

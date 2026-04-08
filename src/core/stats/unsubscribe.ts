import {
  buildUnsubscribeReason,
  resolveUnsubscribeTarget,
  type UnsubscribeMethod,
} from "../unsubscribe.js";
import { detectNewsletters } from "./newsletters.js";
import { getStatsSqlite, normalizeLimit, roundPercent } from "./common.js";

export interface UnsubscribeSuggestion {
  email: string;
  name: string;
  allTimeMessageCount: number;
  unreadCount: number;
  unreadRate: number;
  readRate: number;
  lastRead: string | null;
  lastReceived: string | null;
  unsubscribeLink: string;
  unsubscribeMethod: UnsubscribeMethod;
  impactScore: number;
  reason: string;
}

export interface UnsubscribeSuggestionsResult {
  suggestions: UnsubscribeSuggestion[];
  totalWithUnsubscribeLinks: number;
}

export interface GetUnsubscribeSuggestionsOptions {
  limit?: number;
  minMessages?: number;
  unreadOnlySenders?: boolean;
}

interface UnsubscribeSuggestionRow {
  email: string;
  name: string | null;
  messageCount: number;
  unreadCount: number;
  lastRead: number | null;
  lastReceived: number | null;
  newsletterUnsubscribeLink: string | null;
  emailUnsubscribeHeaders: string | null;
}

function toIsoString(value: number | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function roundImpactScore(messageCount: number, unreadRate: number): number {
  return Math.round((messageCount * unreadRate * 10) / 100) / 10;
}

export async function getUnsubscribeSuggestions(
  options: GetUnsubscribeSuggestionsOptions = {},
): Promise<UnsubscribeSuggestionsResult> {
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const limit = Math.min(50, normalizeLimit(options.limit, 20));
  const minMessages = normalizeLimit(options.minMessages, 5);

  const rows = sqlite
    .prepare(
      `
      SELECT
        e.from_address AS email,
        COALESCE(MAX(NULLIF(TRIM(e.from_name), '')), e.from_address) AS name,
        COUNT(*) AS messageCount,
        SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
        MAX(CASE WHEN e.is_read = 1 THEN e.date ELSE NULL END) AS lastRead,
        MAX(e.date) AS lastReceived,
        MAX(NULLIF(TRIM(ns.unsubscribe_link), '')) AS newsletterUnsubscribeLink,
        GROUP_CONCAT(NULLIF(TRIM(e.list_unsubscribe), ''), '\n') AS emailUnsubscribeHeaders
      FROM emails AS e
      LEFT JOIN newsletter_senders AS ns
        ON LOWER(ns.email) = LOWER(e.from_address)
      WHERE e.from_address IS NOT NULL
        AND TRIM(e.from_address) <> ''
      GROUP BY LOWER(e.from_address)
      HAVING COUNT(*) >= ?
      `,
    )
    .all(minMessages) as UnsubscribeSuggestionRow[];

  const suggestions = rows
    .map((row) => {
      const unsubscribe = resolveUnsubscribeTarget(
        row.newsletterUnsubscribeLink,
        row.emailUnsubscribeHeaders,
      );

      if (!unsubscribe.unsubscribeLink || !unsubscribe.unsubscribeMethod) {
        return null;
      }

      const unreadRate = roundPercent(row.unreadCount, row.messageCount);
      const readRate = roundPercent(row.messageCount - row.unreadCount, row.messageCount);

      return {
        email: row.email,
        name: row.name?.trim() || row.email,
        allTimeMessageCount: row.messageCount,
        unreadCount: row.unreadCount,
        unreadRate,
        readRate,
        lastRead: toIsoString(row.lastRead),
        lastReceived: toIsoString(row.lastReceived),
        unsubscribeLink: unsubscribe.unsubscribeLink,
        unsubscribeMethod: unsubscribe.unsubscribeMethod,
        impactScore: roundImpactScore(row.messageCount, unreadRate),
        reason: buildUnsubscribeReason(unreadRate, row.messageCount),
      } satisfies UnsubscribeSuggestion;
    })
    .filter((suggestion): suggestion is UnsubscribeSuggestion => suggestion !== null)
    .filter((suggestion) =>
      options.unreadOnlySenders ? suggestion.unreadCount === suggestion.allTimeMessageCount : true,
    )
    .sort((left, right) =>
      right.impactScore - left.impactScore ||
      right.allTimeMessageCount - left.allTimeMessageCount ||
      right.unreadRate - left.unreadRate ||
      (right.lastReceived || "").localeCompare(left.lastReceived || "") ||
      left.email.localeCompare(right.email),
    );

  return {
    suggestions: suggestions.slice(0, limit),
    totalWithUnsubscribeLinks: suggestions.length,
  };
}

import type Database from "better-sqlite3";
import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { getCachedLabelName } from "../gmail/labels.js";

export type StatsPeriod = "day" | "week" | "month" | "year" | "all";

const DAY_MS = 24 * 60 * 60 * 1000;

export const SYSTEM_LABEL_IDS = [
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "ALL_MAIL",
  "SNOOZED",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
] as const;

export const CATEGORY_LABEL_PREFIX = "CATEGORY_";

const SYSTEM_LABEL_ID_SET = new Set<string>(SYSTEM_LABEL_IDS);
const AUTOMATED_ADDRESS_MARKERS = [
  "noreply",
  "no-reply",
  "no_reply",
  "newsletter",
  "notifications",
  "notification",
  "mailer",
  "info@",
  "hello@",
  "support@",
  "marketing",
  "promo",
  "updates",
] as const;

const SYSTEM_LABEL_NAMES = new Map<string, string>([
  ["INBOX", "Inbox"],
  ["UNREAD", "Unread"],
  ["STARRED", "Starred"],
  ["IMPORTANT", "Important"],
  ["SENT", "Sent"],
  ["DRAFT", "Drafts"],
  ["TRASH", "Trash"],
  ["SPAM", "Spam"],
  ["ALL_MAIL", "All Mail"],
  ["SNOOZED", "Snoozed"],
  ["CHAT", "Chat"],
  ["CATEGORY_PERSONAL", "Personal"],
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_PROMOTIONS", "Promotions"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_FORUMS", "Forums"],
]);

export function getStatsSqlite(): Database.Database {
  const config = loadConfig();
  return getSqlite(config.dbPath);
}

export function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

export function clampPercentage(value: number | undefined, fallback: number = 0): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, value));
}

export function roundPercent(numerator: number, denominator: number): number {
  if (!denominator) {
    return 0;
  }

  return Math.round((numerator / denominator) * 1000) / 10;
}

export function getPeriodStart(period: StatsPeriod = "all", now: number = Date.now()): number | null {
  switch (period) {
    case "day":
      return now - DAY_MS;
    case "week":
      return now - 7 * DAY_MS;
    case "month":
      return now - 30 * DAY_MS;
    case "year":
      return now - 365 * DAY_MS;
    case "all":
      return null;
  }
}

export function extractDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");

  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return null;
  }

  return trimmed.slice(atIndex + 1);
}

export function resolveLabelName(labelId: string): string {
  return SYSTEM_LABEL_NAMES.get(labelId) || getCachedLabelName(labelId) || labelId;
}

export function isUserLabel(labelId: string): boolean {
  const trimmed = labelId.trim();

  return (
    trimmed.length > 0 &&
    !SYSTEM_LABEL_ID_SET.has(trimmed) &&
    !trimmed.startsWith(CATEGORY_LABEL_PREFIX)
  );
}

export function isLikelyAutomatedSenderAddress(sender: string): boolean {
  const normalized = sender.trim().toLowerCase();
  return AUTOMATED_ADDRESS_MARKERS.some((marker) => normalized.includes(marker));
}

export function startOfLocalDay(now: number = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfLocalWeek(now: number = Date.now()): number {
  const date = new Date(startOfLocalDay(now));
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  return date.getTime();
}

export function startOfLocalMonth(now: number = Date.now()): number {
  const date = new Date(now);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

import type Database from "better-sqlite3";
import {
  clampPercentage,
  extractDomain,
  getPeriodStart,
  getStatsSqlite,
  normalizeLimit,
  resolveLabelName,
  roundPercent,
  type StatsPeriod,
} from "./common.js";

export interface SenderOptions {
  limit?: number;
  period?: StatsPeriod;
  minMessages?: number;
  minUnreadRate?: number;
}

export interface SenderStat {
  email: string;
  name: string;
  totalMessages: number;
  unreadMessages: number;
  unreadRate: number;
  lastEmailDate: number;
  firstEmailDate: number;
  labels: string[];
}

export interface SenderRecentEmail {
  id: string;
  fromAddress: string;
  subject: string;
  date: number;
  isRead: boolean;
}

export interface SenderDetail extends SenderStat {
  type: "sender" | "domain";
  query: string;
  matchingSenders: string[];
  recentEmails: SenderRecentEmail[];
}

interface AggregateRow {
  email: string;
  name: string | null;
  totalMessages: number;
  unreadMessages: number;
  lastEmailDate: number;
  firstEmailDate: number;
}

interface RecentEmailRow {
  id: string;
  fromAddress: string;
  subject: string;
  date: number;
  isRead: number;
}

function buildSenderWhereClause(period?: StatsPeriod): {
  clause: string;
  params: Array<number | string>;
} {
  const whereParts = [
    "from_address IS NOT NULL",
    "TRIM(from_address) <> ''",
  ];
  const params: Array<number | string> = [];
  const periodStart = getPeriodStart(period);

  if (periodStart !== null) {
    whereParts.push("date >= ?");
    params.push(periodStart);
  }

  return {
    clause: whereParts.join(" AND "),
    params,
  };
}

function mapAggregateRow(
  sqlite: Database.Database,
  row: AggregateRow,
  whereClause: string,
  params: Array<number | string>,
): SenderStat {
  return {
    email: row.email,
    name: row.name?.trim() || row.email,
    totalMessages: row.totalMessages,
    unreadMessages: row.unreadMessages,
    unreadRate: roundPercent(row.unreadMessages, row.totalMessages),
    lastEmailDate: row.lastEmailDate,
    firstEmailDate: row.firstEmailDate,
    labels: getTopLabels(sqlite, whereClause, params),
  };
}

function getTopLabels(
  sqlite: Database.Database,
  whereClause: string,
  params: Array<number | string>,
): string[] {
  const rows = sqlite
    .prepare(
      `
      SELECT label.value AS labelId, COUNT(*) AS totalMessages
      FROM emails AS e, json_each(e.label_ids) AS label
      WHERE ${whereClause}
      GROUP BY label.value
      ORDER BY totalMessages DESC, label.value ASC
      LIMIT 5
      `,
    )
    .all(...params) as Array<{ labelId: string }>;

  return rows.map((row) => resolveLabelName(row.labelId));
}

function getRecentEmailsForMatch(
  sqlite: Database.Database,
  whereClause: string,
  params: Array<number | string>,
): SenderRecentEmail[] {
  const rows = sqlite
    .prepare(
      `
      SELECT
        id,
        from_address AS fromAddress,
        subject,
        date,
        is_read AS isRead
      FROM emails
      WHERE ${whereClause}
      ORDER BY date DESC
      LIMIT 10
      `,
    )
    .all(...params) as RecentEmailRow[];

  return rows.map((row) => ({
    id: row.id,
    fromAddress: row.fromAddress,
    subject: row.subject,
    date: row.date,
    isRead: row.isRead === 1,
  }));
}

function getMatchingSenders(
  sqlite: Database.Database,
  whereClause: string,
  params: Array<number | string>,
): string[] {
  const rows = sqlite
    .prepare(
      `
      SELECT from_address AS email, COUNT(*) AS totalMessages, MAX(date) AS lastEmailDate
      FROM emails
      WHERE ${whereClause}
      GROUP BY from_address
      ORDER BY totalMessages DESC, lastEmailDate DESC, email ASC
      `,
    )
    .all(...params) as Array<{ email: string }>;

  return rows.map((row) => row.email);
}

export async function getTopSenders(options: SenderOptions = {}): Promise<SenderStat[]> {
  const sqlite = getStatsSqlite();
  const limit = normalizeLimit(options.limit, 20);
  const minMessages = normalizeLimit(options.minMessages, 1);
  const minUnreadRate = clampPercentage(options.minUnreadRate, 0);
  const { clause, params } = buildSenderWhereClause(options.period);

  const rows = sqlite
    .prepare(
      `
      SELECT
        from_address AS email,
        COALESCE(MAX(NULLIF(TRIM(from_name), '')), from_address) AS name,
        COUNT(*) AS totalMessages,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadMessages,
        MAX(date) AS lastEmailDate,
        MIN(date) AS firstEmailDate
      FROM emails
      WHERE ${clause}
      GROUP BY from_address
      HAVING COUNT(*) >= ?
         AND (100.0 * SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) / COUNT(*)) >= ?
      ORDER BY totalMessages DESC, lastEmailDate DESC, email ASC
      LIMIT ?
      `,
    )
    .all(...params, minMessages, minUnreadRate, limit) as AggregateRow[];

  return rows.map((row) =>
    mapAggregateRow(
      sqlite,
      row,
      `from_address = ?${clause.includes("date >= ?") ? " AND date >= ?" : ""}`,
      clause.includes("date >= ?") ? [row.email, ...params] : [row.email],
    ),
  );
}

export async function getSenderStats(emailOrDomain: string): Promise<SenderDetail | null> {
  const sqlite = getStatsSqlite();
  const query = emailOrDomain.trim().toLowerCase();

  if (!query) {
    return null;
  }

  const isDomain = query.startsWith("@");
  const domain = isDomain ? query.slice(1) : "";

  if (isDomain && !domain) {
    return null;
  }

  const whereClause = isDomain
    ? "from_address IS NOT NULL AND INSTR(from_address, '@') > 0 AND LOWER(SUBSTR(from_address, INSTR(from_address, '@') + 1)) = ?"
    : "LOWER(from_address) = ?";
  const params = [isDomain ? domain : query];

  const row = sqlite
    .prepare(
      `
      SELECT
        ${isDomain ? "? AS email" : "LOWER(from_address) AS email"},
        ${
          isDomain
            ? "? AS name"
            : "COALESCE(MAX(NULLIF(TRIM(from_name), '')), LOWER(from_address)) AS name"
        },
        COUNT(*) AS totalMessages,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadMessages,
        MAX(date) AS lastEmailDate,
        MIN(date) AS firstEmailDate
      FROM emails
      WHERE ${whereClause}
      `,
    )
    .get(
      ...(isDomain ? [`@${domain}`, domain] : []),
      ...params,
    ) as AggregateRow | undefined;

  if (!row || row.totalMessages === 0) {
    return null;
  }

  const displayQuery = isDomain ? `@${domain}` : query;
  const detail = mapAggregateRow(
    sqlite,
    row,
    whereClause,
    params,
  );

  return {
    ...detail,
    type: isDomain ? "domain" : "sender",
    query: displayQuery,
    matchingSenders: getMatchingSenders(sqlite, whereClause, params),
    recentEmails: getRecentEmailsForMatch(sqlite, whereClause, params),
  };
}

export async function getSenderDomains(options: SenderOptions = {}): Promise<SenderStat[]> {
  const sqlite = getStatsSqlite();
  const limit = normalizeLimit(options.limit, 20);
  const minMessages = normalizeLimit(options.minMessages, 1);
  const minUnreadRate = clampPercentage(options.minUnreadRate, 0);
  const { clause, params } = buildSenderWhereClause(options.period);

  const rows = sqlite
    .prepare(
      `
      SELECT
        LOWER(SUBSTR(from_address, INSTR(from_address, '@') + 1)) AS email,
        LOWER(SUBSTR(from_address, INSTR(from_address, '@') + 1)) AS name,
        COUNT(*) AS totalMessages,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unreadMessages,
        MAX(date) AS lastEmailDate,
        MIN(date) AS firstEmailDate
      FROM emails
      WHERE ${clause}
        AND INSTR(from_address, '@') > 0
      GROUP BY LOWER(SUBSTR(from_address, INSTR(from_address, '@') + 1))
      HAVING COUNT(*) >= ?
         AND (100.0 * SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) / COUNT(*)) >= ?
      ORDER BY totalMessages DESC, lastEmailDate DESC, email ASC
      LIMIT ?
      `,
    )
    .all(...params, minMessages, minUnreadRate, limit) as AggregateRow[];

  return rows
    .filter((row) => extractDomain(row.email) !== null || row.email.includes("."))
    .map((row) => {
      const domain = row.email.toLowerCase();
      const stat = mapAggregateRow(
        sqlite,
        {
          ...row,
          email: `@${domain}`,
          name: domain,
        },
        `from_address IS NOT NULL AND INSTR(from_address, '@') > 0 AND LOWER(SUBSTR(from_address, INSTR(from_address, '@') + 1)) = ?${
          clause.includes("date >= ?") ? " AND date >= ?" : ""
        }`,
        clause.includes("date >= ?") ? [domain, ...params] : [domain],
      );

      return {
        ...stat,
        name: domain,
      };
    });
}

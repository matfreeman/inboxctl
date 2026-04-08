import {
  getStatsSqlite,
  startOfLocalDay,
  startOfLocalMonth,
  startOfLocalWeek,
} from "./common.js";

export type VolumeGranularity = "hour" | "day" | "week" | "month";

export interface VolumePoint {
  period: string;
  received: number;
  read: number;
  unread: number;
  archived: number;
}

export interface InboxOverview {
  total: number;
  unread: number;
  starred: number;
  today: { received: number; unread: number };
  thisWeek: { received: number; unread: number };
  thisMonth: { received: number; unread: number };
  oldestUnread: Date | null;
}

interface VolumeRow extends VolumePoint {}

interface OverviewRow {
  total: number;
  unread: number;
  starred: number;
  todayReceived: number;
  todayUnread: number;
  thisWeekReceived: number;
  thisWeekUnread: number;
  thisMonthReceived: number;
  thisMonthUnread: number;
  oldestUnread: number | null;
}

function getBucketExpression(granularity: VolumeGranularity): string {
  switch (granularity) {
    case "hour":
      return "strftime('%Y-%m-%d %H:00', date / 1000, 'unixepoch', 'localtime')";
    case "day":
      return "strftime('%Y-%m-%d', date / 1000, 'unixepoch', 'localtime')";
    case "week":
      return "printf('%s-W%02d', strftime('%Y', date / 1000, 'unixepoch', 'localtime'), CAST(strftime('%W', date / 1000, 'unixepoch', 'localtime') AS INTEGER))";
    case "month":
      return "strftime('%Y-%m', date / 1000, 'unixepoch', 'localtime')";
  }
}

export async function getVolumeByPeriod(
  granularity: VolumeGranularity,
  range?: { start?: number; end?: number },
): Promise<VolumePoint[]> {
  const sqlite = getStatsSqlite();
  const whereParts: string[] = [];
  const params: number[] = [];

  if (range?.start !== undefined) {
    whereParts.push("date >= ?");
    params.push(range.start);
  }

  if (range?.end !== undefined) {
    whereParts.push("date <= ?");
    params.push(range.end);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const bucketExpression = getBucketExpression(granularity);

  const rows = sqlite
    .prepare(
      `
      SELECT
        ${bucketExpression} AS period,
        COUNT(*) AS received,
        SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) AS read,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
        SUM(
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM json_each(emails.label_ids)
              WHERE json_each.value = 'INBOX'
            ) THEN 0
            ELSE 1
          END
        ) AS archived
      FROM emails
      ${whereClause}
      GROUP BY period
      ORDER BY MIN(date) ASC
      `,
    )
    .all(...params) as VolumeRow[];

  return rows.map((row) => ({
    period: row.period,
    received: row.received,
    read: row.read,
    unread: row.unread,
    archived: row.archived,
  }));
}

export async function getInboxOverview(): Promise<InboxOverview> {
  const sqlite = getStatsSqlite();
  const now = Date.now();
  const todayStart = startOfLocalDay(now);
  const weekStart = startOfLocalWeek(now);
  const monthStart = startOfLocalMonth(now);

  const row = sqlite
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END) AS starred,
        SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS todayReceived,
        SUM(CASE WHEN date >= ? AND is_read = 0 THEN 1 ELSE 0 END) AS todayUnread,
        SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS thisWeekReceived,
        SUM(CASE WHEN date >= ? AND is_read = 0 THEN 1 ELSE 0 END) AS thisWeekUnread,
        SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS thisMonthReceived,
        SUM(CASE WHEN date >= ? AND is_read = 0 THEN 1 ELSE 0 END) AS thisMonthUnread,
        MIN(CASE WHEN is_read = 0 THEN date ELSE NULL END) AS oldestUnread
      FROM emails
      `,
    )
    .get(
      todayStart,
      todayStart,
      weekStart,
      weekStart,
      monthStart,
      monthStart,
    ) as OverviewRow | undefined;

  return {
    total: row?.total || 0,
    unread: row?.unread || 0,
    starred: row?.starred || 0,
    today: {
      received: row?.todayReceived || 0,
      unread: row?.todayUnread || 0,
    },
    thisWeek: {
      received: row?.thisWeekReceived || 0,
      unread: row?.thisWeekUnread || 0,
    },
    thisMonth: {
      received: row?.thisMonthReceived || 0,
      unread: row?.thisMonthUnread || 0,
    },
    oldestUnread: row?.oldestUnread ? new Date(row.oldestUnread) : null,
  };
}

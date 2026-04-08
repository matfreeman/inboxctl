import { getStatsSqlite, resolveLabelName } from "./common.js";

export interface LabelStat {
  labelId: string;
  labelName: string;
  totalMessages: number;
  unreadMessages: number;
}

interface LabelRow {
  labelId: string;
  totalMessages: number;
  unreadMessages: number;
}

export async function getLabelDistribution(): Promise<LabelStat[]> {
  const sqlite = getStatsSqlite();
  const rows = sqlite
    .prepare(
      `
      SELECT
        label.value AS labelId,
        COUNT(*) AS totalMessages,
        SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadMessages
      FROM emails AS e, json_each(e.label_ids) AS label
      GROUP BY label.value
      ORDER BY totalMessages DESC, unreadMessages DESC, label.value ASC
      `,
    )
    .all() as LabelRow[];

  return rows.map((row) => ({
    labelId: row.labelId,
    labelName: resolveLabelName(row.labelId),
    totalMessages: row.totalMessages,
    unreadMessages: row.unreadMessages,
  }));
}

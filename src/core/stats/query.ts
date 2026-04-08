import { z } from "zod";
import {
  CATEGORY_LABEL_PREFIX,
  SYSTEM_LABEL_IDS,
  getStatsSqlite,
  normalizeLimit,
} from "./common.js";
import { detectNewsletters } from "./newsletters.js";

export const QUERY_EMAIL_GROUP_BY_VALUES = [
  "sender",
  "domain",
  "label",
  "year_month",
  "year_week",
  "day_of_week",
  "is_read",
  "is_newsletter",
] as const;

export const QUERY_EMAIL_AGGREGATE_VALUES = [
  "count",
  "unread_count",
  "read_count",
  "unread_rate",
  "oldest",
  "newest",
  "sender_count",
] as const;

export const QUERY_EMAIL_HAVING_FIELDS = [
  "count",
  "unread_count",
  "unread_rate",
  "sender_count",
] as const;

type QueryEmailGroupBy = (typeof QUERY_EMAIL_GROUP_BY_VALUES)[number];
type QueryEmailAggregate = (typeof QUERY_EMAIL_AGGREGATE_VALUES)[number];
type QueryEmailHavingField = (typeof QUERY_EMAIL_HAVING_FIELDS)[number];

const CATEGORY_LABEL_LIKE_PATTERN = `${CATEGORY_LABEL_PREFIX.replace(/_/g, "\\_")}%`;
const SYSTEM_LABEL_SQL = SYSTEM_LABEL_IDS.map((label) => `'${label}'`).join(", ");
const DOMAIN_SQL = `
  LOWER(
    CASE
      WHEN INSTR(COALESCE(e.from_address, ''), '@') > 0
        THEN SUBSTR(e.from_address, INSTR(e.from_address, '@') + 1)
      ELSE ''
    END
  )
`;

const queryEmailsFiltersSchema = z.object({
  from: z.string().optional(),
  from_contains: z.string().optional(),
  domain: z.string().optional(),
  domain_contains: z.string().optional(),
  subject_contains: z.string().optional(),
  date_after: z.string().optional(),
  date_before: z.string().optional(),
  is_read: z.boolean().optional(),
  is_newsletter: z.boolean().optional(),
  has_label: z.boolean().optional(),
  label: z.string().optional(),
  has_unsubscribe: z.boolean().optional(),
  min_sender_messages: z.number().int().positive().optional(),
}).strict();

const havingConditionSchema = z.object({
  gte: z.number().optional(),
  lte: z.number().optional(),
}).strict().refine(
  (value) => value.gte !== undefined || value.lte !== undefined,
  { message: "Provide at least one of gte or lte." },
);

const queryEmailsHavingSchema = z.object({
  count: havingConditionSchema.optional(),
  unread_count: havingConditionSchema.optional(),
  unread_rate: havingConditionSchema.optional(),
  sender_count: havingConditionSchema.optional(),
}).strict();

export const queryEmailsInputSchema = z.object({
  filters: queryEmailsFiltersSchema.optional(),
  group_by: z.enum(QUERY_EMAIL_GROUP_BY_VALUES).optional(),
  aggregates: z.array(z.enum(QUERY_EMAIL_AGGREGATE_VALUES)).min(1).optional(),
  having: queryEmailsHavingSchema.optional(),
  order_by: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

export interface QueryEmailsResultRow {
  [key: string]: string | number | boolean | null;
}

export interface QueryEmailsResult {
  rows: QueryEmailsResultRow[];
  totalRows: number;
  query: {
    filters: z.infer<typeof queryEmailsFiltersSchema>;
    group_by: QueryEmailGroupBy | null;
    aggregates: QueryEmailAggregate[];
    having: z.infer<typeof queryEmailsHavingSchema>;
    order_by: string;
    limit: number;
  };
}

export const QUERY_EMAILS_FIELD_SCHEMA = {
  description: "Available fields for the query_emails tool.",
  filters: {
    from: { type: "string", description: "Exact sender email (case-insensitive)" },
    from_contains: { type: "string", description: "Partial match on sender email" },
    domain: { type: "string", description: "Exact sender domain" },
    domain_contains: { type: "string", description: "Partial match on sender domain" },
    subject_contains: { type: "string", description: "Partial match on subject line" },
    date_after: { type: "string", description: "ISO date — emails after this date" },
    date_before: { type: "string", description: "ISO date — emails before this date" },
    is_read: { type: "boolean", description: "Filter by read/unread state" },
    is_newsletter: { type: "boolean", description: "Sender detected as newsletter" },
    has_label: { type: "boolean", description: "Has any user-applied label" },
    label: { type: "string", description: "Has this specific label" },
    has_unsubscribe: { type: "boolean", description: "Has List-Unsubscribe header" },
    min_sender_messages: { type: "integer", description: "Sender has at least this many total emails" },
  },
  group_by: [
    { value: "sender", description: "Group by sender email address" },
    { value: "domain", description: "Group by sender domain" },
    { value: "label", description: "Group by applied label (expands multi-label emails)" },
    { value: "year_month", description: "Group by month (YYYY-MM)" },
    { value: "year_week", description: "Group by week (YYYY-WNN)" },
    { value: "day_of_week", description: "Group by day of week (0=Sunday)" },
    { value: "is_read", description: "Group by read/unread state" },
    { value: "is_newsletter", description: "Group by newsletter detection" },
  ],
  aggregates: [
    { value: "count", description: "Number of emails" },
    { value: "unread_count", description: "Number of unread emails" },
    { value: "read_count", description: "Number of read emails" },
    { value: "unread_rate", description: "Percentage of emails that are unread" },
    { value: "oldest", description: "Earliest email date (ISO string)" },
    { value: "newest", description: "Latest email date (ISO string)" },
    { value: "sender_count", description: "Count of distinct senders" },
  ],
  having_fields: [...QUERY_EMAIL_HAVING_FIELDS],
  example_queries: [
    {
      description: "Monthly volume trend for Amazon",
      query: {
        filters: { domain_contains: "amazon" },
        group_by: "year_month",
        aggregates: ["count", "unread_rate"],
        order_by: "year_month asc",
      },
    },
    {
      description: "Domains with 95%+ unread rate and 50+ emails",
      query: {
        group_by: "domain",
        aggregates: ["count", "unread_rate"],
        having: { count: { gte: 50 }, unread_rate: { gte: 95 } },
      },
    },
    {
      description: "What day of the week gets the most email?",
      query: {
        group_by: "day_of_week",
        aggregates: ["count", "sender_count"],
      },
    },
  ],
} as const;

const GROUP_BY_SQL_MAP: Record<QueryEmailGroupBy, string> = {
  sender: "LOWER(COALESCE(e.from_address, ''))",
  domain: DOMAIN_SQL,
  label: "CAST(grouped_label.value AS TEXT)",
  year_month: "STRFTIME('%Y-%m', e.date / 1000, 'unixepoch')",
  year_week: "STRFTIME('%Y-W%W', e.date / 1000, 'unixepoch')",
  day_of_week: "CAST(STRFTIME('%w', e.date / 1000, 'unixepoch') AS INTEGER)",
  is_read: "COALESCE(e.is_read, 0)",
  is_newsletter: "CASE WHEN ns.email IS NOT NULL THEN 1 ELSE 0 END",
};

const AGGREGATE_SQL_MAP: Record<QueryEmailAggregate, string> = {
  count: "COUNT(*)",
  unread_count: "SUM(CASE WHEN COALESCE(e.is_read, 0) = 0 THEN 1 ELSE 0 END)",
  read_count: "SUM(CASE WHEN COALESCE(e.is_read, 0) = 1 THEN 1 ELSE 0 END)",
  unread_rate: `
    ROUND(
      CASE
        WHEN COUNT(*) = 0 THEN 0
        ELSE 100.0 * SUM(CASE WHEN COALESCE(e.is_read, 0) = 0 THEN 1 ELSE 0 END) / COUNT(*)
      END,
      1
    )
  `,
  oldest: "MIN(e.date)",
  newest: "MAX(e.date)",
  sender_count: `
    COUNT(
      DISTINCT CASE
        WHEN e.from_address IS NOT NULL AND TRIM(e.from_address) <> ''
          THEN LOWER(e.from_address)
        ELSE NULL
      END
    )
  `,
};

function userLabelPredicate(column: string): string {
  return `
    ${column} IS NOT NULL
    AND TRIM(CAST(${column} AS TEXT)) <> ''
    AND CAST(${column} AS TEXT) NOT IN (${SYSTEM_LABEL_SQL})
    AND CAST(${column} AS TEXT) NOT LIKE '${CATEGORY_LABEL_LIKE_PATTERN}' ESCAPE '\\'
  `;
}

function toIsoString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

function normalizeGroupValue(groupBy: QueryEmailGroupBy, value: unknown): string | number | boolean | null {
  switch (groupBy) {
    case "is_read":
    case "is_newsletter":
      return Number(value ?? 0) === 1;
    case "day_of_week":
      return Number(value ?? 0);
    case "sender":
    case "domain":
    case "label":
    case "year_month":
    case "year_week":
      return typeof value === "string" ? value : value == null ? null : String(value);
  }
}

function normalizeAggregateValue(aggregate: QueryEmailAggregate, value: unknown): string | number | null {
  switch (aggregate) {
    case "oldest":
    case "newest":
      return toIsoString(value);
    case "count":
    case "unread_count":
    case "read_count":
    case "sender_count":
      return Number(value ?? 0);
    case "unread_rate":
      return Number(value ?? 0);
  }
}

function parseDateFilter(field: "date_after" | "date_before", value: string): number {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid ${field} value: ${value}`);
  }

  return timestamp;
}

function resolveAggregates(
  aggregates: QueryEmailAggregate[] | undefined,
): QueryEmailAggregate[] {
  return Array.from(new Set(aggregates && aggregates.length > 0 ? aggregates : ["count"]));
}

function resolveOrderBy(
  orderBy: string | undefined,
  groupBy: QueryEmailGroupBy | undefined,
  aggregates: QueryEmailAggregate[],
): string {
  const defaultField = aggregates.includes("count") ? "count" : aggregates[0];
  const rawValue = (orderBy || `${defaultField} desc`).trim();
  const match = rawValue.match(/^([a-z_]+)\s+(asc|desc)$/i);

  if (!match) {
    throw new Error(`Invalid order_by value: ${rawValue}`);
  }

  const [, field, direction] = match;
  const allowedFields = new Set<string>(aggregates);

  if (groupBy) {
    allowedFields.add(groupBy);
  }

  if (!allowedFields.has(field)) {
    throw new Error(`Invalid order_by field: ${field}`);
  }

  return `${field} ${direction.toLowerCase()}`;
}

function buildWhereClauses(
  filters: z.infer<typeof queryEmailsFiltersSchema>,
  groupBy: QueryEmailGroupBy | undefined,
): { sql: string; params: unknown[] } {
  const whereParts: string[] = [];
  const params: unknown[] = [];

  if (filters.from !== undefined) {
    whereParts.push("LOWER(COALESCE(e.from_address, '')) = LOWER(?)");
    params.push(filters.from);
  }

  if (filters.from_contains !== undefined) {
    whereParts.push("LOWER(COALESCE(e.from_address, '')) LIKE '%' || LOWER(?) || '%'");
    params.push(filters.from_contains);
  }

  if (filters.domain !== undefined) {
    whereParts.push(`${DOMAIN_SQL} = LOWER(?)`);
    params.push(filters.domain);
  }

  if (filters.domain_contains !== undefined) {
    whereParts.push(`${DOMAIN_SQL} LIKE '%' || LOWER(?) || '%'`);
    params.push(filters.domain_contains);
  }

  if (filters.subject_contains !== undefined) {
    whereParts.push("LOWER(COALESCE(e.subject, '')) LIKE '%' || LOWER(?) || '%'");
    params.push(filters.subject_contains);
  }

  if (filters.date_after !== undefined) {
    whereParts.push("COALESCE(e.date, 0) >= ?");
    params.push(parseDateFilter("date_after", filters.date_after));
  }

  if (filters.date_before !== undefined) {
    whereParts.push("COALESCE(e.date, 0) <= ?");
    params.push(parseDateFilter("date_before", filters.date_before));
  }

  if (filters.is_read !== undefined) {
    whereParts.push("COALESCE(e.is_read, 0) = ?");
    params.push(filters.is_read ? 1 : 0);
  }

  if (filters.is_newsletter !== undefined) {
    whereParts.push(filters.is_newsletter ? "ns.email IS NOT NULL" : "ns.email IS NULL");
  }

  if (filters.has_label !== undefined) {
    whereParts.push(
      filters.has_label
        ? `EXISTS (
            SELECT 1
            FROM json_each(COALESCE(e.label_ids, '[]')) AS label_filter
            WHERE ${userLabelPredicate("label_filter.value")}
          )`
        : `NOT EXISTS (
            SELECT 1
            FROM json_each(COALESCE(e.label_ids, '[]')) AS label_filter
            WHERE ${userLabelPredicate("label_filter.value")}
          )`,
    );
  }

  if (filters.label !== undefined) {
    whereParts.push(`
      EXISTS (
        SELECT 1
        FROM json_each(COALESCE(e.label_ids, '[]')) AS label_filter
        WHERE LOWER(CAST(label_filter.value AS TEXT)) = LOWER(?)
      )
    `);
    params.push(filters.label);
  }

  if (filters.has_unsubscribe !== undefined) {
    whereParts.push(
      filters.has_unsubscribe
        ? "NULLIF(TRIM(e.list_unsubscribe), '') IS NOT NULL"
        : "(e.list_unsubscribe IS NULL OR TRIM(e.list_unsubscribe) = '')",
    );
  }

  if (filters.min_sender_messages !== undefined) {
    whereParts.push("COALESCE(sender_stats.totalFromSender, 0) >= ?");
    params.push(filters.min_sender_messages);
  }

  if (groupBy === "label") {
    whereParts.push(userLabelPredicate("grouped_label.value"));
  }

  return {
    sql: whereParts.length > 0 ? `WHERE ${whereParts.join("\n  AND ")}` : "",
    params,
  };
}

function buildHavingClause(
  having: z.infer<typeof queryEmailsHavingSchema>,
): string {
  const parts: string[] = [];

  for (const field of QUERY_EMAIL_HAVING_FIELDS) {
    const condition = having[field];

    if (!condition) {
      continue;
    }

    const expression = AGGREGATE_SQL_MAP[field];

    if (condition.gte !== undefined) {
      parts.push(`${expression} >= ${condition.gte}`);
    }

    if (condition.lte !== undefined) {
      parts.push(`${expression} <= ${condition.lte}`);
    }
  }

  return parts.length > 0 ? `HAVING ${parts.join("\n  AND ")}` : "";
}

function normalizeRow(
  row: Record<string, unknown>,
  groupBy: QueryEmailGroupBy | undefined,
  aggregates: QueryEmailAggregate[],
): QueryEmailsResultRow {
  const normalized: QueryEmailsResultRow = {};

  if (groupBy) {
    normalized[groupBy] = normalizeGroupValue(groupBy, row[groupBy]);
  }

  for (const aggregate of aggregates) {
    normalized[aggregate] = normalizeAggregateValue(aggregate, row[aggregate]);
  }

  return normalized;
}

export async function queryEmails(
  options: z.input<typeof queryEmailsInputSchema> = {},
): Promise<QueryEmailsResult> {
  const parsed = queryEmailsInputSchema.parse(options);
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const filters = parsed.filters ?? {};
  const groupBy = parsed.group_by;
  const aggregates = resolveAggregates(parsed.aggregates);
  const having = parsed.having ?? {};
  const orderBy = resolveOrderBy(parsed.order_by, groupBy, aggregates);
  const limit = Math.min(500, normalizeLimit(parsed.limit, 50));
  const { sql: whereSql, params } = buildWhereClauses(filters, groupBy);
  const havingSql = buildHavingClause(having);

  const fromSql = [
    "FROM emails AS e",
    "LEFT JOIN newsletter_senders AS ns ON LOWER(ns.email) = LOWER(e.from_address)",
    `LEFT JOIN (
      SELECT
        LOWER(from_address) AS senderKey,
        COUNT(*) AS totalFromSender
      FROM emails
      WHERE from_address IS NOT NULL
        AND TRIM(from_address) <> ''
      GROUP BY LOWER(from_address)
    ) AS sender_stats ON sender_stats.senderKey = LOWER(e.from_address)`,
    groupBy === "label"
      ? "JOIN json_each(COALESCE(e.label_ids, '[]')) AS grouped_label"
      : "",
  ].filter(Boolean).join("\n");

  const selectParts: string[] = [];

  if (groupBy) {
    selectParts.push(`${GROUP_BY_SQL_MAP[groupBy]} AS ${groupBy}`);
  }

  for (const aggregate of aggregates) {
    selectParts.push(`${AGGREGATE_SQL_MAP[aggregate]} AS ${aggregate}`);
  }

  const groupBySql = groupBy ? `GROUP BY ${GROUP_BY_SQL_MAP[groupBy]}` : "";
  const orderBySql = `ORDER BY ${orderBy.split(" ")[0]} ${orderBy.split(" ")[1].toUpperCase()}`;

  const totalRow = groupBy
    ? sqlite
      .prepare(
        `
        SELECT COUNT(*) AS totalRows
        FROM (
          SELECT 1
          ${fromSql}
          ${whereSql}
          ${groupBySql}
          ${havingSql}
        ) AS grouped_rows
        `,
      )
      .get(...params) as { totalRows: number } | undefined
    : undefined;

  const rows = sqlite
    .prepare(
      `
      SELECT
        ${selectParts.join(",\n        ")}
      ${fromSql}
      ${whereSql}
      ${groupBySql}
      ${havingSql}
      ${orderBySql}
      LIMIT ?
      `,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((row) => normalizeRow(row, groupBy, aggregates)),
    totalRows: groupBy ? (totalRow?.totalRows ?? 0) : rows.length,
    query: {
      filters,
      group_by: groupBy ?? null,
      aggregates,
      having,
      order_by: orderBy,
      limit,
    },
  };
}

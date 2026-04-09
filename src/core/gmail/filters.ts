import { randomUUID } from "node:crypto";
import type { Config } from "../../config.js";
import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { createLabel, getLabelId, syncLabels } from "./labels.js";
import type { GmailTransport } from "./transport.js";
import { getGmailTransport } from "./transport.js";
import type {
  GmailFilter,
  GmailFilterActions,
  GmailFilterCriteria,
  GmailLabel,
  RawGmailFilter,
  RawGmailFilterAction,
  RawGmailFilterCriteria,
} from "./types.js";

interface FilterContext {
  config: Config;
  transport: GmailTransport;
}

interface FilterOptions {
  config?: Config;
  transport?: GmailTransport;
}

interface DeleteFilterOptions extends FilterOptions {
  runId?: string;
  sessionId?: string;
}

interface FilterEventRow {
  id: string;
  gmailFilterId: string;
  eventType: string;
  runId: string | null;
  sessionId: string | null;
  criteria: string;
  actions: string;
  createdAt: number | null;
}

export interface CreateFilterInput {
  // Criteria — at least one required
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "larger" | "smaller";
  // Actions — at least one required
  labelName?: string; // resolved to label ID, auto-created if missing
  archive?: boolean; // -> removeLabelIds: ["INBOX"]
  markRead?: boolean; // -> removeLabelIds: ["UNREAD"]
  star?: boolean; // -> addLabelIds: ["STARRED"]
  forward?: string;
  // Audit metadata
  runId?: string;
  sessionId?: string;
}

export interface FilterEvent {
  id: string;
  gmailFilterId: string;
  eventType: "created" | "deleted";
  runId: string | null;
  sessionId: string | null;
  criteria: GmailFilterCriteria;
  actions: GmailFilterActions;
  createdAt: number;
}

export interface GetFilterEventsOptions {
  config?: Config;
  runId?: string;
  sessionId?: string;
  eventType?: "created" | "deleted";
  limit?: number;
}

export interface UndoFiltersResult {
  deletedCount: number;
  errorCount: number;
  errors: Array<{ gmailFilterId: string; error: string }>;
  deletedFilterIds: string[];
}

async function resolveContext(options?: FilterOptions): Promise<FilterContext> {
  const config = options?.config ?? loadConfig();
  const transport = options?.transport ?? (await getGmailTransport(config));
  return { config, transport };
}

function getDatabase(config: Config) {
  return getSqlite(config.dbPath);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function defaultFilterCriteria(): GmailFilterCriteria {
  return {
    from: null,
    to: null,
    subject: null,
    query: null,
    negatedQuery: null,
    hasAttachment: false,
    excludeChats: false,
    size: null,
    sizeComparison: null,
  };
}

function defaultFilterActions(): GmailFilterActions {
  return {
    addLabelNames: [],
    removeLabelNames: [],
    forward: null,
    archive: false,
    markRead: false,
    star: false,
  };
}

function toFilterCriteria(raw: RawGmailFilterCriteria | null | undefined): GmailFilterCriteria {
  return {
    from: raw?.from ?? null,
    to: raw?.to ?? null,
    subject: raw?.subject ?? null,
    query: raw?.query ?? null,
    negatedQuery: raw?.negatedQuery ?? null,
    hasAttachment: raw?.hasAttachment ?? false,
    excludeChats: raw?.excludeChats ?? false,
    size: raw?.size ?? null,
    sizeComparison:
      raw?.sizeComparison === "larger" || raw?.sizeComparison === "smaller"
        ? raw.sizeComparison
        : null,
  };
}

function toFilterActions(
  raw: RawGmailFilterAction | null | undefined,
  labelMap: Map<string, GmailLabel>,
): GmailFilterActions {
  const addIds = raw?.addLabelIds ?? [];
  const removeIds = raw?.removeLabelIds ?? [];

  const addLabelNames = addIds
    .filter((id) => id !== "STARRED")
    .map((id) => labelMap.get(id)?.name ?? id);

  const removeLabelNames = removeIds
    .filter((id) => id !== "INBOX" && id !== "UNREAD")
    .map((id) => labelMap.get(id)?.name ?? id);

  return {
    addLabelNames,
    removeLabelNames,
    forward: raw?.forward ?? null,
    archive: removeIds.includes("INBOX"),
    markRead: removeIds.includes("UNREAD"),
    star: addIds.includes("STARRED"),
  };
}

function toGmailFilter(raw: RawGmailFilter, labelMap: Map<string, GmailLabel>): GmailFilter | null {
  const id = raw.id?.trim();
  if (!id) return null;

  return {
    id,
    criteria: toFilterCriteria(raw.criteria),
    actions: toFilterActions(raw.action, labelMap),
  };
}

function rowToFilterEvent(row: FilterEventRow): FilterEvent {
  const eventType = row.eventType === "deleted" ? "deleted" : "created";

  return {
    id: row.id,
    gmailFilterId: row.gmailFilterId,
    eventType,
    runId: row.runId,
    sessionId: row.sessionId,
    criteria: parseJson(row.criteria, defaultFilterCriteria()),
    actions: parseJson(row.actions, defaultFilterActions()),
    createdAt: row.createdAt ?? 0,
  };
}

function recordFilterEvent(
  config: Config,
  input: {
    gmailFilterId: string;
    eventType: "created" | "deleted";
    runId?: string | null;
    sessionId?: string | null;
    criteria: GmailFilterCriteria;
    actions: GmailFilterActions;
  },
): void {
  const sqlite = getDatabase(config);
  sqlite
    .prepare(
      `
      INSERT INTO filter_events (
        id, gmail_filter_id, event_type, run_id, session_id, criteria, actions, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      randomUUID(),
      input.gmailFilterId,
      input.eventType,
      input.runId ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.criteria),
      JSON.stringify(input.actions),
      Date.now(),
    );
}

async function buildLabelMap(context: FilterContext): Promise<Map<string, GmailLabel>> {
  const labels = await syncLabels({ config: context.config, transport: context.transport });
  const map = new Map<string, GmailLabel>();
  for (const label of labels) {
    map.set(label.id, label);
  }
  return map;
}

function loadActiveCreatedFilters(
  config: Config,
  scope: {
    runId?: string;
    sessionId?: string;
  },
): FilterEvent[] {
  const scopeClauses: string[] = [];
  const params: string[] = [];

  if (scope.runId) {
    scopeClauses.push("created.run_id = ?");
    params.push(scope.runId);
  }

  if (scope.sessionId) {
    scopeClauses.push("created.session_id = ?");
    params.push(scope.sessionId);
  }

  if (scopeClauses.length === 0) {
    throw new Error("runId or sessionId is required");
  }

  const sqlite = getDatabase(config);
  const rows = sqlite
    .prepare(
      `
      SELECT
        created.id AS id,
        created.gmail_filter_id AS gmailFilterId,
        created.event_type AS eventType,
        created.run_id AS runId,
        created.session_id AS sessionId,
        created.criteria AS criteria,
        created.actions AS actions,
        created.created_at AS createdAt
      FROM filter_events AS created
      WHERE created.event_type = 'created'
        AND (${scopeClauses.join(" OR ")})
        AND NOT EXISTS (
          SELECT 1
          FROM filter_events AS deleted
          WHERE deleted.gmail_filter_id = created.gmail_filter_id
            AND deleted.event_type = 'deleted'
            AND deleted.created_at >= created.created_at
        )
      ORDER BY created.created_at DESC, created.id DESC
      `,
    )
    .all(...params) as FilterEventRow[];

  return rows.map(rowToFilterEvent);
}

export async function listFilters(options?: FilterOptions): Promise<GmailFilter[]> {
  const context = await resolveContext(options);
  const [response, labelMap] = await Promise.all([
    context.transport.listFilters(),
    buildLabelMap(context),
  ]);

  const raw = response.filter ?? [];
  return raw
    .map((f) => toGmailFilter(f, labelMap))
    .filter((f): f is GmailFilter => f !== null);
}

export async function getFilter(id: string, options?: FilterOptions): Promise<GmailFilter> {
  const context = await resolveContext(options);
  const [raw, labelMap] = await Promise.all([
    context.transport.getFilter(id),
    buildLabelMap(context),
  ]);

  const filter = toGmailFilter(raw, labelMap);
  if (!filter) {
    throw new Error(`Filter ${id} returned an invalid response from Gmail`);
  }
  return filter;
}

export async function createFilter(
  input: CreateFilterInput,
  options?: FilterOptions,
): Promise<GmailFilter> {
  const hasCriteria =
    input.from != null ||
    input.to != null ||
    input.subject != null ||
    input.query != null ||
    input.negatedQuery != null ||
    input.hasAttachment != null ||
    input.excludeChats != null ||
    input.size != null;

  if (!hasCriteria) {
    throw new Error(
      "At least one criteria field is required (from, to, subject, query, negatedQuery, hasAttachment, excludeChats, or size)",
    );
  }

  const hasAction =
    input.labelName != null ||
    input.archive === true ||
    input.markRead === true ||
    input.star === true ||
    input.forward != null;

  if (!hasAction) {
    throw new Error(
      "At least one action is required (labelName, archive, markRead, star, or forward)",
    );
  }

  const context = await resolveContext(options);
  const addLabelIds: string[] = [];

  if (input.star) {
    addLabelIds.push("STARRED");
  }

  if (input.labelName) {
    let labelId = await getLabelId(input.labelName, context);
    if (!labelId) {
      const created = await createLabel(input.labelName, undefined, context);
      labelId = created.id;
    }
    addLabelIds.push(labelId);
  }

  const removeLabelIds: string[] = [];
  if (input.archive) removeLabelIds.push("INBOX");
  if (input.markRead) removeLabelIds.push("UNREAD");

  const criteria: RawGmailFilterCriteria = {};
  if (input.from) criteria.from = input.from;
  if (input.to) criteria.to = input.to;
  if (input.subject) criteria.subject = input.subject;
  if (input.query) criteria.query = input.query;
  if (input.negatedQuery) criteria.negatedQuery = input.negatedQuery;
  if (input.hasAttachment != null) criteria.hasAttachment = input.hasAttachment;
  if (input.excludeChats != null) criteria.excludeChats = input.excludeChats;
  if (input.size != null) criteria.size = input.size;
  if (input.sizeComparison) criteria.sizeComparison = input.sizeComparison;

  const action: RawGmailFilterAction = {};
  if (addLabelIds.length > 0) action.addLabelIds = addLabelIds;
  if (removeLabelIds.length > 0) action.removeLabelIds = removeLabelIds;
  if (input.forward) action.forward = input.forward;

  const raw = await context.transport.createFilter({ criteria, action });
  const labelMap = await buildLabelMap(context);
  const filter = toGmailFilter(raw, labelMap);

  if (!filter) {
    throw new Error("Gmail did not return a valid filter after creation");
  }

  recordFilterEvent(context.config, {
    gmailFilterId: filter.id,
    eventType: "created",
    runId: input.runId ?? null,
    sessionId: input.sessionId ?? null,
    criteria: filter.criteria,
    actions: filter.actions,
  });

  return filter;
}

export async function deleteFilter(id: string, options?: DeleteFilterOptions): Promise<void> {
  const context = await resolveContext(options);
  const existing = await getFilter(id, context);
  await context.transport.deleteFilter(id);
  recordFilterEvent(context.config, {
    gmailFilterId: id,
    eventType: "deleted",
    runId: options?.runId ?? null,
    sessionId: options?.sessionId ?? null,
    criteria: existing.criteria,
    actions: existing.actions,
  });
}

export async function getFilterEvents(options?: GetFilterEventsOptions): Promise<FilterEvent[]> {
  const config = options?.config ?? loadConfig();
  const sqlite = getDatabase(config);
  const whereClauses: string[] = [];
  const params: Array<string | number> = [];

  if (options?.runId) {
    whereClauses.push("run_id = ?");
    params.push(options.runId);
  }

  if (options?.sessionId) {
    whereClauses.push("session_id = ?");
    params.push(options.sessionId);
  }

  if (options?.eventType) {
    whereClauses.push("event_type = ?");
    params.push(options.eventType);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const limitSql = options?.limit ? "LIMIT ?" : "";
  if (options?.limit) {
    params.push(options.limit);
  }

  const rows = sqlite
    .prepare(
      `
      SELECT
        id AS id,
        gmail_filter_id AS gmailFilterId,
        event_type AS eventType,
        run_id AS runId,
        session_id AS sessionId,
        criteria AS criteria,
        actions AS actions,
        created_at AS createdAt
      FROM filter_events
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      ${limitSql}
      `,
    )
    .all(...params) as FilterEventRow[];

  return rows.map(rowToFilterEvent);
}

export async function getActiveFiltersBySession(
  sessionId: string,
  options?: { config?: Config },
): Promise<FilterEvent[]> {
  return loadActiveCreatedFilters(options?.config ?? loadConfig(), { sessionId });
}

export async function getActiveFiltersByRun(
  runId: string,
  options?: { config?: Config },
): Promise<FilterEvent[]> {
  return loadActiveCreatedFilters(options?.config ?? loadConfig(), { runId });
}

export async function undoFilters(options: {
  runId?: string;
  sessionId?: string;
  config?: Config;
  transport?: GmailTransport;
}): Promise<UndoFiltersResult> {
  if (!options.runId && !options.sessionId) {
    throw new Error("runId or sessionId is required");
  }

  const config = options.config ?? loadConfig();
  const transport = options.transport ?? (await getGmailTransport(config));
  const activeFilters = new Map<string, FilterEvent>();

  if (options.runId) {
    for (const event of await getActiveFiltersByRun(options.runId, { config })) {
      activeFilters.set(event.gmailFilterId, event);
    }
  }

  if (options.sessionId) {
    for (const event of await getActiveFiltersBySession(options.sessionId, { config })) {
      activeFilters.set(event.gmailFilterId, event);
    }
  }

  const deletedFilterIds: string[] = [];
  const errors: Array<{ gmailFilterId: string; error: string }> = [];
  const filters = [...activeFilters.values()].sort((left, right) => left.createdAt - right.createdAt);

  for (const filter of filters) {
    try {
      await deleteFilter(filter.gmailFilterId, {
        config,
        transport,
        runId: options.runId,
        sessionId: options.sessionId,
      });
      deletedFilterIds.push(filter.gmailFilterId);
    } catch (error) {
      errors.push({
        gmailFilterId: filter.gmailFilterId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    deletedCount: deletedFilterIds.length,
    errorCount: errors.length,
    errors,
    deletedFilterIds,
  };
}

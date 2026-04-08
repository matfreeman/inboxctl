import type { Config } from "../../config.js";
import { loadConfig } from "../../config.js";
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
  labelName?: string;   // resolved to label ID, auto-created if missing
  archive?: boolean;    // -> removeLabelIds: ["INBOX"]
  markRead?: boolean;   // -> removeLabelIds: ["UNREAD"]
  star?: boolean;       // -> addLabelIds: ["STARRED"]
  forward?: string;
}

async function resolveContext(options?: FilterOptions): Promise<FilterContext> {
  const config = options?.config ?? loadConfig();
  const transport = options?.transport ?? (await getGmailTransport(config));
  return { config, transport };
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

async function buildLabelMap(context: FilterContext): Promise<Map<string, GmailLabel>> {
  const labels = await syncLabels({ config: context.config, transport: context.transport });
  const map = new Map<string, GmailLabel>();
  for (const label of labels) {
    map.set(label.id, label);
  }
  return map;
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
  // Validate at least one criteria field
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

  // Validate at least one action field
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

  // Build addLabelIds
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

  // Build removeLabelIds
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
  return filter;
}

export async function deleteFilter(id: string, options?: FilterOptions): Promise<void> {
  const context = await resolveContext(options);
  await context.transport.deleteFilter(id);
}

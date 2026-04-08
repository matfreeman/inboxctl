import type { Config } from "../../config.js";
import { loadConfig } from "../../config.js";
import type { GmailTransport } from "./transport.js";
import type {
  GmailLabel,
  RawGmailLabel,
  RawGmailLabelColor,
} from "./types.js";
import { getGmailTransport } from "./transport.js";

interface LabelContext {
  config: Config;
  transport: GmailTransport;
}

interface LabelOptions {
  config?: Config;
  transport?: GmailTransport;
  forceRefresh?: boolean;
}

interface LabelCacheEntry {
  labels: GmailLabel[];
  byId: Map<string, GmailLabel>;
  byName: Map<string, GmailLabel>;
  loadedAt: number;
}

const SYSTEM_LABEL_ALIASES = new Map<string, string>([
  ["INBOX", "INBOX"],
  ["SENT", "SENT"],
  ["DRAFT", "DRAFT"],
  ["TRASH", "TRASH"],
  ["SPAM", "SPAM"],
  ["STARRED", "STARRED"],
  ["IMPORTANT", "IMPORTANT"],
  ["UNREAD", "UNREAD"],
  ["SNOOZED", "SNOOZED"],
  ["ALL_MAIL", "ALL_MAIL"],
  ["CATEGORY_PERSONAL", "CATEGORY_PERSONAL"],
  ["CATEGORY_SOCIAL", "CATEGORY_SOCIAL"],
  ["CATEGORY_PROMOTIONS", "CATEGORY_PROMOTIONS"],
  ["CATEGORY_UPDATES", "CATEGORY_UPDATES"],
  ["CATEGORY_FORUMS", "CATEGORY_FORUMS"],
  ["CHAT", "CHAT"],
]);

const labelCache = new Map<string, LabelCacheEntry>();

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function getCacheKey(config: Config): string {
  return config.dataDir;
}

export function getCachedLabelName(
  labelId: string,
  config: Config = loadConfig(),
): string | null {
  return labelCache.get(getCacheKey(config))?.byId.get(labelId)?.name || null;
}

function toLabel(raw: RawGmailLabel): GmailLabel | null {
  const id = raw.id?.trim() || raw.name?.trim();
  const name = raw.name?.trim() || raw.id?.trim();

  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    type: raw.type === "system" ? "system" : "user",
    color: raw.color || null,
    labelListVisibility: raw.labelListVisibility ?? null,
    messageListVisibility: raw.messageListVisibility ?? null,
    messagesTotal: raw.messagesTotal ?? 0,
    messagesUnread: raw.messagesUnread ?? 0,
    threadsTotal: raw.threadsTotal ?? 0,
    threadsUnread: raw.threadsUnread ?? 0,
  };
}

function setCache(config: Config, labels: GmailLabel[]): void {
  const byId = new Map<string, GmailLabel>();
  const byName = new Map<string, GmailLabel>();

  for (const label of labels) {
    byId.set(label.id, label);
    byName.set(normalizeKey(label.name), label);
    byName.set(normalizeKey(label.id), label);
  }

  labelCache.set(getCacheKey(config), {
    labels,
    byId,
    byName,
    loadedAt: Date.now(),
  });
}

function updateCacheLabel(config: Config, label: GmailLabel): void {
  const key = getCacheKey(config);
  const existing = labelCache.get(key);

  if (!existing) {
    setCache(config, [label]);
    return;
  }

  const nextLabels = existing.labels.filter((entry) => entry.id !== label.id);
  nextLabels.push(label);
  setCache(config, nextLabels);
}

async function resolveContext(options?: LabelOptions): Promise<LabelContext> {
  const config = options?.config || loadConfig();
  const transport = options?.transport || (await getGmailTransport(config));
  return { config, transport };
}

function resolveSystemLabelId(name: string): string | null {
  const normalized = name
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();

  return SYSTEM_LABEL_ALIASES.get(normalized) || null;
}

async function refreshLabels(context: LabelContext): Promise<GmailLabel[]> {
  const response = await context.transport.listLabels();
  const rawLabels = response.labels || [];
  const detailed = await Promise.all(
    rawLabels.map(async (raw) => {
      const id = raw.id?.trim() || raw.name?.trim();

      if (!id) {
        return null;
      }

      const detailedLabel = await context.transport.getLabel(id);
      return toLabel(detailedLabel);
    }),
  );
  const labels = detailed.filter((label): label is GmailLabel => label !== null);
  setCache(context.config, labels);
  return labels;
}

async function getCachedLabels(context: LabelContext, forceRefresh: boolean): Promise<GmailLabel[]> {
  const cached = labelCache.get(getCacheKey(context.config));

  if (!forceRefresh && cached) {
    return cached.labels;
  }

  return refreshLabels(context);
}

export async function syncLabels(options?: LabelOptions): Promise<GmailLabel[]> {
  const context = await resolveContext(options);
  return getCachedLabels(context, options?.forceRefresh ?? false);
}

export async function listLabels(options?: Omit<LabelOptions, "forceRefresh">): Promise<GmailLabel[]> {
  return syncLabels({ ...options, forceRefresh: true });
}

export async function getLabelId(
  name: string,
  options?: Omit<LabelOptions, "forceRefresh">,
): Promise<string | null> {
  const trimmed = name.trim();

  if (!trimmed) {
    return null;
  }

  const systemLabelId = resolveSystemLabelId(trimmed);
  if (systemLabelId) {
    return systemLabelId;
  }

  const context = await resolveContext(options);
  const labels = await getCachedLabels(context, false);
  const key = normalizeKey(trimmed);

  for (const label of labels) {
    if (normalizeKey(label.name) === key || normalizeKey(label.id) === key) {
      return label.id;
    }
  }

  return null;
}

export async function createLabel(
  name: string,
  color?: RawGmailLabelColor,
  options?: Omit<LabelOptions, "forceRefresh">,
): Promise<GmailLabel> {
  const trimmed = name.trim();

  if (!trimmed) {
    throw new Error("Label name cannot be empty");
  }

  const context = await resolveContext(options);
  const existingId = await getLabelId(trimmed, context);

  if (existingId) {
    const refreshed = await context.transport.getLabel(existingId);
    const label = toLabel(refreshed);
    if (!label) {
      throw new Error(`Unable to resolve label details for ${trimmed}`);
    }
    updateCacheLabel(context.config, label);
    return label;
  }

  const created = toLabel(
    await context.transport.createLabel({
      name: trimmed,
      color,
    }),
  );

  if (!created) {
    throw new Error(`Gmail did not return a usable label for ${trimmed}`);
  }

  const detailed = await context.transport.getLabel(created.id).catch(() => created);
  const label = toLabel(detailed) || created;
  updateCacheLabel(context.config, label);
  return label;
}

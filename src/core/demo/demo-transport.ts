import type {
  RawGmailFilter,
  RawGmailFilterAction,
  RawGmailFilterCriteria,
  RawGmailHistoryResponse,
  RawGmailLabel,
  RawGmailListFiltersResponse,
  RawGmailListLabelsResponse,
  RawGmailListMessagesResponse,
  RawGmailMessage,
  RawGmailProfile,
  RawGmailSendMessageResponse,
  RawGmailThread,
} from "../gmail/types.js";
import type { GmailTransport } from "../gmail/transport.js";
import type { DemoDataset, DemoMessageRecord } from "./seed.js";

function copyMessage(message: RawGmailMessage): RawGmailMessage {
  return JSON.parse(JSON.stringify(message)) as RawGmailMessage;
}

function copyLabel(label: RawGmailLabel): RawGmailLabel {
  return { ...label };
}

function copyFilter(filter: RawGmailFilter): RawGmailFilter {
  return JSON.parse(JSON.stringify(filter)) as RawGmailFilter;
}

function getSearchTokens(query: string): string[] {
  return query.match(/"[^"]+"|\S+/g) || [];
}

function normalize(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function includesLabel(
  labelIds: string[],
  rawLabels: Map<string, RawGmailLabel>,
  expected: string,
): boolean {
  return labelIds.some((labelId) => {
    const label = rawLabels.get(labelId);
    return (
      normalize(labelId) === expected ||
      normalize(label?.name) === expected ||
      normalize(label?.name).replace(/\s+/g, "-") === expected
    );
  });
}

function matchesQuery(
  entry: DemoMessageRecord,
  query: string,
  rawLabels: Map<string, RawGmailLabel>,
): boolean {
  const trimmed = query.trim();

  if (!trimmed) {
    return true;
  }

  const searchableText = normalize(
    [
      entry.message.fromAddress,
      entry.message.fromName,
      entry.message.subject,
      entry.message.snippet,
      ...entry.message.toAddresses,
    ].join(" "),
  );

  return getSearchTokens(trimmed).every((token) => {
    const cleaned = token.replace(/^"|"$/g, "");
    const separator = cleaned.indexOf(":");

    if (separator === -1) {
      return searchableText.includes(normalize(cleaned));
    }

    const key = normalize(cleaned.slice(0, separator));
    const value = normalize(cleaned.slice(separator + 1));

    switch (key) {
      case "from":
        return normalize(entry.message.fromAddress).includes(value) || normalize(entry.message.fromName).includes(value);
      case "to":
        return entry.message.toAddresses.some((address) => normalize(address).includes(value));
      case "subject":
        return normalize(entry.message.subject).includes(value);
      case "label":
        return includesLabel(entry.message.labelIds, rawLabels, value);
      case "is":
        if (value === "unread") return !entry.message.isRead;
        if (value === "read") return entry.message.isRead;
        if (value === "starred") return entry.message.isStarred;
        return true;
      case "has":
        if (value === "attachment") return entry.message.hasAttachments;
        return true;
      default:
        return searchableText.includes(normalize(cleaned));
    }
  });
}

function applyLabelMutation(
  labelIds: string[],
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): string[] {
  const next = labelIds.filter((labelId) => !removeLabelIds.includes(labelId));

  for (const labelId of addLabelIds) {
    if (!next.includes(labelId)) {
      next.push(labelId);
    }
  }

  return next;
}

export class DemoTransport implements GmailTransport {
  kind = "rest" as const;
  private readonly labels = new Map<string, RawGmailLabel>();
  private readonly messages = new Map<string, DemoMessageRecord>();
  private readonly filters = new Map<string, RawGmailFilter>();
  private historyCounter: number;

  constructor(private readonly dataset: DemoDataset) {
    this.historyCounter = Number.parseInt(dataset.historyId, 10) || 12345678;

    for (const label of dataset.labels) {
      if (label.id) {
        this.labels.set(label.id, copyLabel(label));
      }
    }

    for (const message of dataset.messages) {
      this.messages.set(message.message.id, {
        ...message,
        message: {
          ...message.message,
          labelIds: [...message.message.labelIds],
        },
        rawMessage: copyMessage(message.rawMessage),
      });
    }

    for (const filter of dataset.filters) {
      if (filter.id) {
        this.filters.set(filter.id, copyFilter(filter));
      }
    }
  }

  async getProfile(): Promise<RawGmailProfile> {
    return {
      emailAddress: this.dataset.accountEmail,
      historyId: String(this.historyCounter),
      messagesTotal: this.messages.size,
      threadsTotal: new Set(
        [...this.messages.values()].map((entry) => entry.message.threadId),
      ).size,
    };
  }

  private buildLabelDetails(label: RawGmailLabel): RawGmailLabel {
    const id = label.id || label.name || "";
    const matching = [...this.messages.values()].filter((entry) =>
      entry.message.labelIds.includes(id),
    );

    return {
      ...copyLabel(label),
      messagesTotal: matching.length,
      messagesUnread: matching.filter((entry) => !entry.message.isRead).length,
      threadsTotal: new Set(matching.map((entry) => entry.message.threadId)).size,
      threadsUnread: new Set(
        matching
          .filter((entry) => !entry.message.isRead)
          .map((entry) => entry.message.threadId),
      ).size,
    };
  }

  async listLabels(): Promise<RawGmailListLabelsResponse> {
    return {
      labels: [...this.labels.values()].map((label) => this.buildLabelDetails(label)),
    };
  }

  async getLabel(id: string): Promise<RawGmailLabel> {
    const label = this.labels.get(id);

    if (!label) {
      throw new Error(`Demo label not found: ${id}`);
    }

    return this.buildLabelDetails(label);
  }

  async createLabel(input: {
    name: string;
    color?: RawGmailLabel["color"];
  }): Promise<RawGmailLabel> {
    const existing = [...this.labels.values()].find(
      (label) => normalize(label.name) === normalize(input.name),
    );

    if (existing) {
      return this.buildLabelDetails(existing);
    }

    const nextUserLabelCount =
      [...this.labels.values()].filter((label) => label.type === "user").length + 1;
    const created: RawGmailLabel = {
      id: `Label_${nextUserLabelCount}`,
      name: input.name.trim(),
      type: "user",
      color: input.color || null,
    };
    this.labels.set(created.id as string, created);
    return this.buildLabelDetails(created);
  }

  async batchModifyMessages(input: {
    ids: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<void> {
    for (const id of input.ids) {
      const entry = this.messages.get(id);

      if (!entry) {
        continue;
      }

      const nextLabelIds = applyLabelMutation(
        entry.message.labelIds,
        input.addLabelIds,
        input.removeLabelIds,
      );

      entry.message.labelIds = nextLabelIds;
      entry.message.isRead = !nextLabelIds.includes("UNREAD");
      entry.message.isStarred = nextLabelIds.includes("STARRED");
      entry.rawMessage.labelIds = [...nextLabelIds];
    }

    this.historyCounter += 1;
  }

  async sendMessage(): Promise<RawGmailSendMessageResponse> {
    this.historyCounter += 1;
    return {
      id: `sent-demo-${this.historyCounter}`,
      threadId: `sent-thread-${this.historyCounter}`,
      labelIds: ["SENT"],
    };
  }

  async listMessages(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<RawGmailListMessagesResponse> {
    const matching = [...this.messages.values()]
      .filter((entry) => matchesQuery(entry, options.query || "", this.labels))
      .sort((left, right) => right.message.date - left.message.date);
    const offset = options.pageToken ? Number.parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 20;
    const slice = matching.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;

    return {
      messages: slice.map((entry) => ({
        id: entry.message.id,
        threadId: entry.message.threadId,
      })),
      nextPageToken: nextOffset < matching.length ? String(nextOffset) : undefined,
      resultSizeEstimate: matching.length,
    };
  }

  async getMessage(options: {
    id: string;
  }): Promise<RawGmailMessage> {
    const entry = this.messages.get(options.id);

    if (!entry) {
      throw new Error(`Demo message not found: ${options.id}`);
    }

    return copyMessage(entry.rawMessage);
  }

  async getThread(id: string): Promise<RawGmailThread> {
    const messages = [...this.messages.values()]
      .filter((entry) => entry.message.threadId === id)
      .sort((left, right) => left.message.date - right.message.date)
      .map((entry) => copyMessage(entry.rawMessage));

    return {
      id,
      messages,
    };
  }

  async listHistory(): Promise<RawGmailHistoryResponse> {
    return {
      history: [],
      historyId: String(this.historyCounter),
    };
  }

  async listFilters(): Promise<RawGmailListFiltersResponse> {
    return {
      filter: [...this.filters.values()].map((filter) => copyFilter(filter)),
    };
  }

  async getFilter(id: string): Promise<RawGmailFilter> {
    const filter = this.filters.get(id);

    if (!filter) {
      throw new Error(`Demo filter not found: ${id}`);
    }

    return copyFilter(filter);
  }

  async createFilter(filter: {
    criteria: RawGmailFilterCriteria;
    action: RawGmailFilterAction;
  }): Promise<RawGmailFilter> {
    const created: RawGmailFilter = {
      id: `filter-demo-${this.filters.size + 1}`,
      criteria: filter.criteria,
      action: filter.action,
    };
    this.filters.set(created.id as string, created);
    return copyFilter(created);
  }

  async deleteFilter(id: string): Promise<void> {
    if (!this.filters.delete(id)) {
      throw new Error(`Demo filter not found: ${id}`);
    }
  }
}

export function createDemoTransport(dataset: DemoDataset): GmailTransport {
  return new DemoTransport(dataset);
}

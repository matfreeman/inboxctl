import type { Config } from "../../config.js";
import { gmailApiRequest } from "./client.js";
import type { GmailTransport } from "./transport.js";
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
} from "./types.js";

function jsonRequestInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export function createRestTransport(config: Config): GmailTransport {
  return {
    kind: "rest",
    getProfile(): Promise<RawGmailProfile> {
      return gmailApiRequest<RawGmailProfile>(config, "/profile");
    },
    listLabels(): Promise<RawGmailListLabelsResponse> {
      return gmailApiRequest<RawGmailListLabelsResponse>(config, "/labels");
    },
    getLabel(id: string): Promise<RawGmailLabel> {
      return gmailApiRequest<RawGmailLabel>(config, `/labels/${id}`);
    },
    createLabel(input): Promise<RawGmailLabel> {
      return gmailApiRequest<RawGmailLabel>(
        config,
        "/labels",
        jsonRequestInit({
          name: input.name,
          color: input.color,
          type: "user",
        }),
      );
    },
    batchModifyMessages(input): Promise<void> {
      return gmailApiRequest<void>(
        config,
        "/messages/batchModify",
        jsonRequestInit({
          ids: input.ids,
          addLabelIds: input.addLabelIds,
          removeLabelIds: input.removeLabelIds,
        }),
      );
    },
    sendMessage(raw: string): Promise<RawGmailSendMessageResponse> {
      return gmailApiRequest<RawGmailSendMessageResponse>(
        config,
        "/messages/send",
        jsonRequestInit({
          raw,
        }),
      );
    },
    listMessages(options): Promise<RawGmailListMessagesResponse> {
      const params = new URLSearchParams();
      if (options.query) {
        params.set("q", options.query);
      }
      if (options.maxResults) {
        params.set("maxResults", String(options.maxResults));
      }
      if (options.pageToken) {
        params.set("pageToken", options.pageToken);
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return gmailApiRequest<RawGmailListMessagesResponse>(config, `/messages${suffix}`);
    },
    getMessage(options): Promise<RawGmailMessage> {
      const params = new URLSearchParams();
      if (options.format) {
        params.set("format", options.format);
      }
      for (const header of options.metadataHeaders || []) {
        params.append("metadataHeaders", header);
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return gmailApiRequest<RawGmailMessage>(config, `/messages/${options.id}${suffix}`);
    },
    getThread(id): Promise<RawGmailThread> {
      return gmailApiRequest<RawGmailThread>(config, `/threads/${id}?format=full`);
    },
    listHistory(options): Promise<RawGmailHistoryResponse> {
      const params = new URLSearchParams({
        startHistoryId: options.startHistoryId,
        maxResults: String(options.maxResults),
      });
      for (const historyType of options.historyTypes) {
        params.append("historyTypes", historyType);
      }
      return gmailApiRequest<RawGmailHistoryResponse>(config, `/history?${params.toString()}`);
    },
    listFilters(): Promise<RawGmailListFiltersResponse> {
      return gmailApiRequest<RawGmailListFiltersResponse>(config, "/settings/filters");
    },
    getFilter(id: string): Promise<RawGmailFilter> {
      return gmailApiRequest<RawGmailFilter>(config, `/settings/filters/${id}`);
    },
    createFilter(filter: { criteria: RawGmailFilterCriteria; action: RawGmailFilterAction }): Promise<RawGmailFilter> {
      return gmailApiRequest<RawGmailFilter>(config, "/settings/filters", jsonRequestInit(filter));
    },
    deleteFilter(id: string): Promise<void> {
      return gmailApiRequest<void>(config, `/settings/filters/${id}`, { method: "DELETE" });
    },
  };
}

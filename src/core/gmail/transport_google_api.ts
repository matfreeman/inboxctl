import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { Config } from "../../config.js";
import { getAuthenticatedOAuthClient } from "./client.js";
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

export function createGoogleApiTransport(config: Config): GmailTransport {
  async function getClient() {
    const auth = await getAuthenticatedOAuthClient(config);
    return gmail({
      version: "v1",
      auth,
    } as any);
  }

  return {
    kind: "google-api",
    async getProfile(): Promise<RawGmailProfile> {
      const client = await getClient();
      const response = await client.users.getProfile({ userId: "me" });
      return response.data as RawGmailProfile;
    },
    async listLabels(): Promise<RawGmailListLabelsResponse> {
      const client = await getClient();
      const response = await client.users.labels.list({ userId: "me" });
      return response.data as RawGmailListLabelsResponse;
    },
    async getLabel(id: string): Promise<RawGmailLabel> {
      const client = await getClient();
      const response = await client.users.labels.get({ userId: "me", id });
      return response.data as RawGmailLabel;
    },
    async createLabel(input): Promise<RawGmailLabel> {
      const client = await getClient();
      const response = await client.users.labels.create({
        userId: "me",
        requestBody: {
          name: input.name,
          color: input.color,
          type: "user",
        } as gmail_v1.Schema$Label,
      });
      return response.data as RawGmailLabel;
    },
    async deleteLabel(id: string): Promise<void> {
      const client = await getClient();
      await client.users.labels.delete({ userId: "me", id });
    },
    async batchModifyMessages(input): Promise<void> {
      const client = await getClient();
      await client.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: input.ids,
          addLabelIds: input.addLabelIds,
          removeLabelIds: input.removeLabelIds,
        } as gmail_v1.Schema$BatchModifyMessagesRequest,
      });
    },
    async sendMessage(raw: string): Promise<RawGmailSendMessageResponse> {
      const client = await getClient();
      const response = await client.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
        } as gmail_v1.Schema$Message,
      });
      return response.data as RawGmailSendMessageResponse;
    },
    async listMessages(options): Promise<RawGmailListMessagesResponse> {
      const client = await getClient();
      const response = await client.users.messages.list({
        userId: "me",
        q: options.query,
        maxResults: options.maxResults,
        pageToken: options.pageToken,
      });
      return response.data as RawGmailListMessagesResponse;
    },
    async getMessage(options): Promise<RawGmailMessage> {
      const client = await getClient();
      const response = await client.users.messages.get({
        userId: "me",
        id: options.id,
        format: options.format,
        metadataHeaders: options.metadataHeaders,
      });
      return response.data as RawGmailMessage;
    },
    async getThread(id): Promise<RawGmailThread> {
      const client = await getClient();
      const response = await client.users.threads.get({
        userId: "me",
        id,
        format: "full",
      });
      return response.data as RawGmailThread;
    },
    async listHistory(options): Promise<RawGmailHistoryResponse> {
      const client = await getClient();
      const response = await client.users.history.list({
        userId: "me",
        startHistoryId: options.startHistoryId,
        maxResults: options.maxResults,
        historyTypes: options.historyTypes,
      });
      return response.data as RawGmailHistoryResponse;
    },
    async listFilters(): Promise<RawGmailListFiltersResponse> {
      const client = await getClient();
      const response = await client.users.settings.filters.list({ userId: "me" });
      return response.data as RawGmailListFiltersResponse;
    },
    async getFilter(id: string): Promise<RawGmailFilter> {
      const client = await getClient();
      const response = await client.users.settings.filters.get({ userId: "me", id });
      return response.data as RawGmailFilter;
    },
    async createFilter(filter: { criteria: RawGmailFilterCriteria; action: RawGmailFilterAction }): Promise<RawGmailFilter> {
      const client = await getClient();
      const response = await client.users.settings.filters.create({
        userId: "me",
        requestBody: filter as any,
      });
      return response.data as RawGmailFilter;
    },
    async deleteFilter(id: string): Promise<void> {
      const client = await getClient();
      await client.users.settings.filters.delete({ userId: "me", id });
    },
  };
}

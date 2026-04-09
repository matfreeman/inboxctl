/**
 * Mock Gmail transport for testing.
 * Returns configurable canned responses for all GmailTransport methods.
 */

import { vi } from "vitest";
import type { GmailTransport } from "../../core/gmail/transport.js";
import type {
  EmailMessage,
  RawGmailFilter,
  RawGmailHistoryResponse,
  RawGmailLabel,
  RawGmailListFiltersResponse,
  RawGmailListLabelsResponse,
  RawGmailListMessagesResponse,
  RawGmailMessage,
  RawGmailProfile,
  RawGmailSendMessageResponse,
  RawGmailThread,
} from "../../core/gmail/types.js";

export const DEFAULT_PROFILE: RawGmailProfile = {
  emailAddress: "user@example.com",
  historyId: "100",
  messagesTotal: 0,
  threadsTotal: 0,
};

export const DEFAULT_LABEL: RawGmailLabel = {
  id: "Label_1",
  name: "TestLabel",
  type: "user",
  messagesTotal: 0,
  messagesUnread: 0,
  threadsTotal: 0,
  threadsUnread: 0,
};

export const DEFAULT_FILTER: RawGmailFilter = {
  id: "filter-1",
  criteria: { from: "test@example.com" },
  action: { removeLabelIds: ["INBOX"] },
};

/**
 * Build a minimal RawGmailMessage suitable for use in transport mocks.
 */
export function makeRawMessage(
  id: string,
  labelIds: string[] = ["INBOX"],
  overrides: Partial<RawGmailMessage> = {},
): RawGmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    snippet: `Snippet for ${id}`,
    internalDate: "1712000000000",
    labelIds,
    sizeEstimate: 1024,
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "user@example.com" },
        { name: "Subject", value: `Subject for ${id}` },
        { name: "Date", value: "Wed, 1 Apr 2026 10:00:00 +0000" },
      ],
    },
    ...overrides,
  };
}

/**
 * Build a minimal EmailMessage as returned by batchGetMessages / parseMessage.
 */
export function makeEmailMessage(id: string, labelIds: string[] = ["INBOX"]): EmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    fromAddress: "sender@example.com",
    fromName: "Sender",
    toAddresses: ["user@example.com"],
    subject: `Subject for ${id}`,
    snippet: `Snippet for ${id}`,
    date: 1_712_000_000_000,
    isRead: !labelIds.includes("UNREAD"),
    isStarred: labelIds.includes("STARRED"),
    labelIds,
    sizeEstimate: 1024,
    hasAttachments: false,
    listUnsubscribe: null,
  };
}

/**
 * Create a full mock GmailTransport with vi.fn() for every method.
 * Provide overrides to customise individual methods per test.
 */
export function createMockTransport(overrides: Partial<GmailTransport> = {}): GmailTransport {
  return {
    kind: "rest",
    getProfile: vi.fn().mockResolvedValue(DEFAULT_PROFILE),
    listLabels: vi.fn().mockResolvedValue({ labels: [DEFAULT_LABEL] }),
    getLabel: vi.fn().mockResolvedValue(DEFAULT_LABEL),
    createLabel: vi.fn().mockResolvedValue(DEFAULT_LABEL),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
    batchModifyMessages: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({
      id: "sent-1",
      threadId: "thread-sent",
      labelIds: ["SENT"],
    }),
    listMessages: vi.fn().mockResolvedValue({ messages: [], resultSizeEstimate: 0 }),
    getMessage: vi.fn().mockResolvedValue(makeRawMessage("msg-1")),
    getThread: vi.fn().mockResolvedValue({ id: "thread-1", messages: [] }),
    listHistory: vi.fn().mockResolvedValue({ history: [], historyId: "200" }),
    listFilters: vi.fn().mockResolvedValue({ filter: [DEFAULT_FILTER] }),
    getFilter: vi.fn().mockResolvedValue(DEFAULT_FILTER),
    createFilter: vi.fn().mockResolvedValue(DEFAULT_FILTER),
    deleteFilter: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

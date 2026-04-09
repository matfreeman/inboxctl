import type { Action } from "../rules/types.js";

export interface EmailMessage {
  id: string;
  threadId: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  subject: string;
  snippet: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  labelIds: string[];
  sizeEstimate: number;
  hasAttachments: boolean;
  listUnsubscribe: string | null;
}

export interface RawGmailLabelColor {
  backgroundColor?: string | null;
  textColor?: string | null;
}

export interface RawGmailLabel {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  color?: RawGmailLabelColor | null;
  labelListVisibility?: string | null;
  messageListVisibility?: string | null;
  messagesTotal?: number | null;
  messagesUnread?: number | null;
  threadsTotal?: number | null;
  threadsUnread?: number | null;
}

export interface RawGmailListLabelsResponse {
  labels?: RawGmailLabel[] | null;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  color: RawGmailLabelColor | null;
  labelListVisibility: string | null;
  messageListVisibility: string | null;
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
}

export interface RawGmailMessagePartHeader {
  name?: string | null;
  value?: string | null;
}

export interface RawGmailMessagePart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: RawGmailMessagePartHeader[] | null;
  body?: {
    data?: string | null;
    attachmentId?: string | null;
  } | null;
  parts?: RawGmailMessagePart[] | null;
}

export interface RawGmailMessage {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  internalDate?: string | null;
  labelIds?: string[] | null;
  sizeEstimate?: number | null;
  payload?: RawGmailMessagePart;
}

export interface RawGmailProfile {
  emailAddress?: string;
  historyId?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export interface RawGmailListMessagesResponse {
  messages?: Array<{ id?: string | null; threadId?: string | null }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface RawGmailThread {
  id?: string | null;
  messages?: RawGmailMessage[];
}

export interface RawGmailHistoryResponse {
  history?: Array<{
    messagesAdded?: Array<{ message?: { id?: string | null } }>;
    labelsAdded?: Array<{ message?: { id?: string | null } }>;
    labelsRemoved?: Array<{ message?: { id?: string | null } }>;
    messagesDeleted?: Array<{ message?: { id?: string | null } }>;
  }>;
  historyId?: string;
}

export interface RawGmailSendMessageResponse {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
}

export interface EmailThread {
  id: string;
  messages: EmailMessage[];
}

export type EmailBodySource = "text_plain" | "html_rendered" | "snippet_fallback";

export interface EmailDetail extends EmailMessage {
  textPlain: string;
  body: string;
  bodyHtml: string | null;
  bodySource: EmailBodySource;
}

// Gmail Filter API types

export interface RawGmailFilterCriteria {
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  query?: string | null;
  negatedQuery?: string | null;
  hasAttachment?: boolean | null;
  excludeChats?: boolean | null;
  size?: number | null;
  sizeComparison?: "larger" | "smaller" | "unspecified" | null;
}

export interface RawGmailFilterAction {
  addLabelIds?: string[] | null;
  removeLabelIds?: string[] | null;
  forward?: string | null;
}

export interface RawGmailFilter {
  id?: string | null;
  criteria?: RawGmailFilterCriteria | null;
  action?: RawGmailFilterAction | null;
}

export interface RawGmailListFiltersResponse {
  // Gmail API uses singular "filter" as the array key
  filter?: RawGmailFilter[] | null;
}

export interface GmailFilterCriteria {
  from: string | null;
  to: string | null;
  subject: string | null;
  query: string | null;
  negatedQuery: string | null;
  hasAttachment: boolean;
  excludeChats: boolean;
  size: number | null;
  sizeComparison: "larger" | "smaller" | null;
}

export interface GmailFilterActions {
  addLabelNames: string[];
  removeLabelNames: string[];
  forward: string | null;
  // Derived booleans for common actions
  archive: boolean;   // true when INBOX is in removeLabelIds
  markRead: boolean;  // true when UNREAD is in removeLabelIds
  star: boolean;      // true when STARRED is in addLabelIds
}

export interface GmailFilter {
  id: string;
  criteria: GmailFilterCriteria;
  actions: GmailFilterActions;
}

export interface SyncResult {
  messagesProcessed: number;
  messagesAdded: number;
  messagesUpdated: number;
  historyId: string;
  mode: "full" | "incremental";
  usedHistoryFallback: boolean;
}

export type GmailModifyAction =
  | "archive"
  | "unarchive"
  | "label"
  | "unlabel"
  | "mark_read"
  | "mark_unread"
  | "mark_spam"
  | "unmark_spam"
  | "forward";

export interface GmailModifyItemResult {
  emailId: string;
  beforeLabelIds: string[];
  afterLabelIds: string[];
  status: "applied" | "warning" | "error";
  appliedActions: Action[];
  errorMessage?: string | null;
}

export interface GmailModifyResult {
  action: GmailModifyAction;
  affectedCount: number;
  items: GmailModifyItemResult[];
  nonReversible: boolean;
  labelId?: string;
  labelName?: string;
  toAddress?: string;
  sentMessageId?: string;
  sentThreadId?: string;
}

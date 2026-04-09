import { loadConfig } from "../../config.js";
import { renderHtmlEmail } from "./body-format.js";
import { getGmailTransport } from "./transport.js";
import type {
  EmailDetail,
  EmailBodySource,
  EmailMessage,
  RawGmailMessage,
  RawGmailMessagePart,
  RawGmailMessagePartHeader,
} from "./types.js";

const MESSAGE_FETCH_CONCURRENCY = 5;

export type BatchGetMessagesProgressCallback = (
  completed: number,
  total: number,
) => void;

function getHeaders(message: RawGmailMessage): RawGmailMessagePartHeader[] {
  return message.payload?.headers || [];
}

function getHeader(message: RawGmailMessage, name: string): string | null {
  const header = getHeaders(message).find(
    (entry) => entry.name?.toLowerCase() === name.toLowerCase(),
  );

  return header?.value || null;
}

function parseAddressList(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/<([^>]+)>/);
      return match?.[1] || part.replace(/^"|"$/g, "");
    });
}

function parseFromHeader(value: string | null): {
  fromName: string;
  fromAddress: string;
} {
  if (!value) {
    return { fromName: "", fromAddress: "" };
  }

  const match = value.match(/^(.*?)(?:\s*<([^>]+)>)?$/);

  if (!match) {
    return { fromName: "", fromAddress: value };
  }

  const rawName = match[1]?.trim().replace(/^"|"$/g, "") || "";
  const rawAddress = match[2]?.trim() || rawName;

  return {
    fromName: rawAddress === rawName ? "" : rawName,
    fromAddress: rawAddress,
  };
}

function decodeBase64Url(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function findParts(part: RawGmailMessagePart | undefined, mimeType: string): RawGmailMessagePart[] {
  if (!part) {
    return [];
  }

  const matches = part.mimeType === mimeType ? [part] : [];
  const nested = (part.parts || []).flatMap((child) => findParts(child, mimeType));
  return [...matches, ...nested];
}

function extractTextBody(message: RawGmailMessage): string {
  const textParts = findParts(message.payload, "text/plain");
  const text = textParts.map((part) => decodeBase64Url(part.body?.data)).join("\n").trim();

  if (text) {
    return text;
  }

  const rootMimeType = message.payload?.mimeType?.toLowerCase();
  if (rootMimeType === "text/plain") {
    return decodeBase64Url(message.payload?.body?.data).trim();
  }

  if (!rootMimeType && !extractHtmlBody(message) && message.payload?.body?.data) {
    return decodeBase64Url(message.payload.body.data).trim();
  }

  return "";
}

function extractHtmlBody(message: RawGmailMessage): string | null {
  const html = findParts(message.payload, "text/html")
    .map((part) => decodeBase64Url(part.body?.data))
    .join("\n")
    .trim();

  return html || null;
}

function hasAttachments(part: RawGmailMessagePart | undefined): boolean {
  if (!part) {
    return false;
  }

  if (part.filename) {
    return true;
  }

  return (part.parts || []).some((child) => hasAttachments(child));
}

export function parseMessage(message: RawGmailMessage): EmailMessage {
  const { fromName, fromAddress } = parseFromHeader(getHeader(message, "From"));
  const dateHeader = getHeader(message, "Date");
  const internalDate = message.internalDate ? Number(message.internalDate) : null;
  const parsedDate = dateHeader ? Date.parse(dateHeader) : NaN;

  return {
    id: message.id || "",
    threadId: message.threadId || "",
    fromAddress,
    fromName,
    toAddresses: parseAddressList(getHeader(message, "To")),
    subject: getHeader(message, "Subject") || "",
    snippet: message.snippet || "",
    date:
      internalDate && !Number.isNaN(internalDate)
        ? internalDate
        : Number.isNaN(parsedDate)
          ? Date.now()
          : parsedDate,
    isRead: !(message.labelIds || []).includes("UNREAD"),
    isStarred: (message.labelIds || []).includes("STARRED"),
    labelIds: message.labelIds || [],
    sizeEstimate: message.sizeEstimate || 0,
    hasAttachments: hasAttachments(message.payload),
    listUnsubscribe: getHeader(message, "List-Unsubscribe"),
  };
}

export function parseMessageDetail(message: RawGmailMessage): EmailDetail {
  const base = parseMessage(message);
  const textPlain = extractTextBody(message);
  const bodyHtml = extractHtmlBody(message);
  const bodySource: EmailBodySource = textPlain
    ? "text_plain"
    : bodyHtml
      ? "html_rendered"
      : "snippet_fallback";
  const body = textPlain
    || (bodyHtml ? renderHtmlEmail(bodyHtml, 80).text : "")
    || base.snippet
    || "";

  return {
    ...base,
    textPlain,
    body,
    bodyHtml,
    bodySource,
  };
}

export async function listMessages(
  query: string,
  maxResults: number = 20,
): Promise<EmailMessage[]> {
  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const response = await transport.listMessages({
    query,
    maxResults,
  });

  const ids = (response.messages || []).map((message) => message.id).filter(Boolean) as string[];
  return batchGetMessages(ids);
}

export async function getMessage(
  id: string,
): Promise<EmailDetail> {
  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const response = await transport.getMessage({
    id,
    format: "full",
  });

  if (!response.id) {
    throw new Error(`Gmail message not found: ${id}`);
  }

  return parseMessageDetail(response);
}

export async function batchGetMessages(
  ids: string[],
  onProgress?: BatchGetMessagesProgressCallback,
): Promise<EmailMessage[]> {
  if (ids.length === 0) {
    return [];
  }

  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const pending = ids.map((id, index) => ({ id, index }));
  const messages: Array<EmailMessage | null> = new Array(ids.length).fill(null);
  let completed = 0;

  async function worker(): Promise<void> {
    while (pending.length > 0) {
      const next = pending.shift();

      if (!next) {
        return;
      }

      const response = await transport.getMessage({
        id: next.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date", "List-Unsubscribe"],
      });

      if (!response.id) {
        messages[next.index] = null;
        completed += 1;
        onProgress?.(completed, ids.length);
        continue;
      }

      messages[next.index] = parseMessage(response);
      completed += 1;
      onProgress?.(completed, ids.length);
    }
  }

  await Promise.all(
    Array.from({
      length: Math.min(MESSAGE_FETCH_CONCURRENCY, ids.length),
    }, () => worker()),
  );

  return messages.filter((message): message is EmailMessage => message !== null);
}

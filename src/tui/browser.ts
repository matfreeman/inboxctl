import open from "open";
import type { EmailMessage } from "../core/gmail/types.js";

export type BrowserEmailTarget = Pick<EmailMessage, "threadId" | "fromAddress" | "subject" | "date">;

function quoteSearchValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return `"${trimmed.replace(/(["\\])/g, "\\$1")}"`;
}

function formatSearchDate(date: number): string {
  return new Date(date).toISOString().slice(0, 10).replace(/-/g, "/");
}

function formatNextSearchDate(date: number): string {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10).replace(/-/g, "/");
}

export function buildGmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

export function buildGmailSearchUrl(target: BrowserEmailTarget): string {
  const terms = [
    "in:anywhere",
    target.fromAddress ? `from:${quoteSearchValue(target.fromAddress)}` : "",
    target.subject ? `subject:${quoteSearchValue(target.subject)}` : "",
    target.date ? `after:${formatSearchDate(target.date)}` : "",
    target.date ? `before:${formatNextSearchDate(target.date)}` : "",
  ].filter(Boolean);

  const query = terms.join(" ");
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query || "in:anywhere")}`;
}

export function buildGmailBrowserUrl(target: BrowserEmailTarget): string {
  if (target.threadId?.trim()) {
    return buildGmailThreadUrl(target.threadId);
  }

  return buildGmailSearchUrl(target);
}

export async function openEmailInBrowser(target: BrowserEmailTarget): Promise<void> {
  await open(buildGmailBrowserUrl(target), {
    wait: false,
    newInstance: false,
  });
}

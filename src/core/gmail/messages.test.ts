import type { gmail_v1 } from "@googleapis/gmail";
import { describe, expect, it } from "vitest";
import { parseMessage, parseMessageDetail } from "./messages.js";

function encode(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createGmailMessage(): gmail_v1.Schema$Message {
  return {
    id: "msg-1",
    threadId: "thread-1",
    snippet: "Quarterly update snippet",
    internalDate: String(Date.parse("2026-04-01T10:00:00Z")),
    labelIds: ["INBOX", "UNREAD", "STARRED"],
    sizeEstimate: 2048,
    payload: {
      headers: [
        { name: "From", value: "\"Alice Example\" <alice@example.com>" },
        { name: "To", value: "team@example.com, Bob <bob@example.com>" },
        { name: "Subject", value: "Quarterly update" },
        { name: "Date", value: "Wed, 1 Apr 2026 10:00:00 +0000" },
        { name: "List-Unsubscribe", value: "<https://example.com/unsub>" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: encode("Plain text body"),
          },
        },
        {
          mimeType: "text/html",
          body: {
            data: encode("<p>HTML body</p>"),
          },
        },
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          body: {
            attachmentId: "attachment-1",
          },
        },
      ],
    },
  };
}

describe("parseMessage", () => {
  it("maps Gmail metadata into the local email shape", () => {
    const message = parseMessage(createGmailMessage());

    expect(message.id).toBe("msg-1");
    expect(message.threadId).toBe("thread-1");
    expect(message.fromAddress).toBe("alice@example.com");
    expect(message.fromName).toBe("Alice Example");
    expect(message.toAddresses).toEqual(["team@example.com", "bob@example.com"]);
    expect(message.subject).toBe("Quarterly update");
    expect(message.snippet).toBe("Quarterly update snippet");
    expect(message.isRead).toBe(false);
    expect(message.isStarred).toBe(true);
    expect(message.hasAttachments).toBe(true);
    expect(message.listUnsubscribe).toBe("<https://example.com/unsub>");
  });

  it("extracts text and html content for email detail views", () => {
    const detail = parseMessageDetail(createGmailMessage());

    expect(detail.textPlain).toBe("Plain text body");
    expect(detail.body).toBe("Plain text body");
    expect(detail.bodyHtml).toBe("<p>HTML body</p>");
    expect(detail.bodySource).toBe("text_plain");
  });

  it("does not treat HTML-only bodies as plain text", () => {
    const detail = parseMessageDetail({
      ...createGmailMessage(),
      snippet: "Fallback snippet",
      payload: {
        mimeType: "text/html",
        headers: createGmailMessage().payload?.headers,
        body: {
          data: encode(`
            <html>
              <head><style>.hidden { display:none; }</style></head>
              <body>
                <div style="display:none;max-height:0">PREHEADER</div>
                <p>Rendered body</p>
              </body>
            </html>
          `),
        },
      },
    });

    expect(detail.textPlain).toBe("");
    expect(detail.bodyHtml).toContain("<p>Rendered body</p>");
    expect(detail.body).toContain("Rendered body");
    expect(detail.body).not.toContain("PREHEADER");
    expect(detail.body).not.toContain("@font-face");
    expect(detail.bodySource).toBe("html_rendered");
  });

  it("keeps a plain root body fallback when no mimeType is declared", () => {
    const detail = parseMessageDetail({
      ...createGmailMessage(),
      payload: {
        headers: createGmailMessage().payload?.headers,
        body: {
          data: encode("Root plain text body"),
        },
      },
    });

    expect(detail.textPlain).toBe("Root plain text body");
    expect(detail.bodySource).toBe("text_plain");
  });
});

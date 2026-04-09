import { describe, expect, it } from "vitest";
import { formatEmailBody, getEmailBodySourceLabel } from "./email-format.js";

describe("formatEmailBody", () => {
  it("returns plain text bodies unchanged", () => {
    const formatted = formatEmailBody({
      id: "msg-1",
      threadId: "thread-1",
      fromAddress: "alice@example.com",
      fromName: "Alice",
      toAddresses: ["bob@example.com"],
      subject: "Hello",
      snippet: "Snippet",
      date: Date.parse("2026-04-01T10:00:00Z"),
      isRead: false,
      isStarred: false,
      labelIds: ["INBOX"],
      sizeEstimate: 1,
      hasAttachments: false,
      listUnsubscribe: null,
      textPlain: "Plain body",
      body: "Plain body",
      bodyHtml: null,
      bodySource: "text_plain",
    }, 72);

    expect(formatted.text).toBe("Plain body");
    expect(formatted.quality).toBe("high");
    expect(formatted.source).toBe("text_plain");
  });

  it("renders HTML bodies with cleanup warnings when needed", () => {
    const formatted = formatEmailBody({
      id: "msg-2",
      threadId: "thread-2",
      fromAddress: "service@example.com",
      fromName: "",
      toAddresses: ["bob@example.com"],
      subject: "Styled email",
      snippet: "Snippet",
      date: Date.parse("2026-04-01T10:00:00Z"),
      isRead: false,
      isStarred: false,
      labelIds: ["INBOX"],
      sizeEstimate: 1,
      hasAttachments: false,
      listUnsubscribe: null,
      textPlain: "",
      body: "Rendered body",
      bodyHtml: `
        <html>
          <body>
            <div style="display:none">PREHEADER</div>
            <p>font-family: Arial;</p>
            <p>@font-face block</p>
            <p>mso-line-height-rule: exactly;</p>
            <p>Real body</p>
          </body>
        </html>
      `,
      bodySource: "html_rendered",
    }, 72);

    expect(formatted.text).toContain("Real body");
    expect(formatted.text).not.toContain("PREHEADER");
    expect(formatted.quality).toBe("low");
    expect(formatted.warnings[0]).toContain("press O");
  });

  it("labels body sources for the UI", () => {
    expect(getEmailBodySourceLabel("text_plain")).toBe("plain text");
    expect(getEmailBodySourceLabel("html_rendered")).toBe("rendered from HTML");
    expect(getEmailBodySourceLabel("snippet_fallback")).toBe("snippet fallback");
  });
});

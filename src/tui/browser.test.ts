import { describe, expect, it, vi } from "vitest";
import open from "open";
import {
  buildGmailBrowserUrl,
  buildGmailSearchUrl,
  buildGmailThreadUrl,
  openEmailInBrowser,
} from "./browser.js";

vi.mock("open", () => ({
  default: vi.fn(async () => undefined),
}));

describe("browser helpers", () => {
  it("builds a direct Gmail thread URL when threadId is available", () => {
    expect(buildGmailThreadUrl("190abc123def")).toBe(
      "https://mail.google.com/mail/u/0/#all/190abc123def",
    );
    expect(buildGmailBrowserUrl({
      threadId: "190abc123def",
      fromAddress: "alice@example.com",
      subject: "Quarterly update",
      date: Date.parse("2026-04-01T10:00:00Z"),
    })).toBe("https://mail.google.com/mail/u/0/#all/190abc123def");
  });

  it("falls back to a Gmail search URL when threadId is missing", () => {
    const url = buildGmailSearchUrl({
      threadId: "",
      fromAddress: "alice@example.com",
      subject: "Quarterly update",
      date: Date.parse("2026-04-01T10:00:00Z"),
    });

    expect(url).toContain("https://mail.google.com/mail/u/0/#search/");
    expect(decodeURIComponent(url)).toContain("in:anywhere");
    expect(decodeURIComponent(url)).toContain('from:"alice@example.com"');
    expect(decodeURIComponent(url)).toContain('subject:"Quarterly update"');
    expect(decodeURIComponent(url)).toContain("after:2026/04/01");
    expect(decodeURIComponent(url)).toContain("before:2026/04/02");
  });

  it("opens in the browser without blocking", async () => {
    await openEmailInBrowser({
      threadId: "190abc123def",
      fromAddress: "alice@example.com",
      subject: "Quarterly update",
      date: Date.parse("2026-04-01T10:00:00Z"),
    });

    expect(open).toHaveBeenCalledWith(
      "https://mail.google.com/mail/u/0/#all/190abc123def",
      {
        wait: false,
        newInstance: false,
      },
    );
  });
});

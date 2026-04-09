import { renderHtmlEmail, type HtmlRenderQuality } from "../core/gmail/body-format.js";
import type { EmailBodySource, EmailDetail } from "../core/gmail/types.js";

export interface FormattedEmailBody {
  text: string;
  source: EmailBodySource;
  quality: HtmlRenderQuality;
  warnings: string[];
}

export function getEmailBodySourceLabel(source: EmailBodySource): string {
  switch (source) {
    case "text_plain":
      return "plain text";
    case "html_rendered":
      return "rendered from HTML";
    case "snippet_fallback":
      return "snippet fallback";
  }
}

export function formatEmailBody(detail: EmailDetail, width: number): FormattedEmailBody {
  if (detail.bodySource === "text_plain") {
    return {
      text: detail.textPlain.trim() || detail.body.trim() || detail.snippet || "",
      source: detail.bodySource,
      quality: "high",
      warnings: [],
    };
  }

  if (detail.bodySource === "html_rendered" && detail.bodyHtml?.trim()) {
    const rendered = renderHtmlEmail(detail.bodyHtml, width);
    return {
      text: rendered.text,
      source: detail.bodySource,
      quality: rendered.quality,
      warnings: rendered.warnings,
    };
  }

  return {
    text: detail.snippet || detail.body || "",
    source: "snippet_fallback",
    quality: "medium",
    warnings: ["Only a snippet is available for this message."],
  };
}

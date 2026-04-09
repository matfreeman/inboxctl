import { convert } from "html-to-text";

export type HtmlRenderQuality = "high" | "medium" | "low";

export interface RenderedHtmlBody {
  text: string;
  quality: HtmlRenderQuality;
  warnings: string[];
}

const BLOCK_TAGS = ["head", "style", "script", "noscript", "title"];
const HIDDEN_STYLE_PATTERN = /(display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0(?:px)?|max-width\s*:\s*0(?:px)?|font-size\s*:\s*0(?:px)?|opacity\s*:\s*0|mso-hide\s*:\s*all)/i;
const TRACKING_IMAGE_PATTERN = /<img\b[^>]*(?:width=["']?1["']?|height=["']?1["']?)[^>]*>/gi;
const STYLE_LEAK_PATTERN = /(font-family|@font-face|mso-|display\s*:\s*none|visibility\s*:\s*hidden|\{.+\}|ExternalClass)/gi;
const FOOTER_LINE_PATTERN = /(unsubscribe|manage preferences|view in browser|privacy policy|terms of service|sent to this email|copyright|all rights reserved)/i;

function stripBlockTag(html: string, tagName: string): string {
  return html.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi"), "");
}

function stripHiddenBlocks(html: string): string {
  return html.replace(
    /<([a-z0-9]+)\b([^>]*?)style=(["'])([\s\S]*?)\3([^>]*?)>[\s\S]*?<\/\1>/gi,
    (full, tagName, beforeStyle, quote, styleValue, afterStyle) => {
      void tagName;
      void beforeStyle;
      void quote;
      void afterStyle;
      return HIDDEN_STYLE_PATTERN.test(styleValue) ? "" : full;
    },
  );
}

function trimFooterNoise(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""));

  let footerLikeLines = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = lines[index]?.trim() || "";

    if (!normalized) {
      continue;
    }

    if (!FOOTER_LINE_PATTERN.test(normalized)) {
      break;
    }

    footerLikeLines += 1;
  }

  if (footerLikeLines < 3) {
    return lines.join("\n").trim();
  }

  return lines.slice(0, lines.length - footerLikeLines).join("\n").trim();
}

function countStyleLeaks(text: string): number {
  return text.match(STYLE_LEAK_PATTERN)?.length || 0;
}

export function cleanupEmailHtml(html: string): string {
  let next = html.replace(/<!--[\s\S]*?-->/g, "");

  for (const tagName of BLOCK_TAGS) {
    next = stripBlockTag(next, tagName);
  }

  next = stripHiddenBlocks(next);
  next = next.replace(TRACKING_IMAGE_PATTERN, "");
  next = next.replace(/\u0000/g, "");

  return next.trim();
}

export function renderHtmlEmail(html: string, wordwrap: number): RenderedHtmlBody {
  const cleanedHtml = cleanupEmailHtml(html);
  const rawText = convert(cleanedHtml, {
    baseElements: { selectors: ["body"] },
    preserveNewlines: false,
    wordwrap: Math.max(40, wordwrap),
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, noAnchorUrl: true } },
      { selector: "ul", options: { itemPrefix: "- " } },
      { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false, maxColumnWidth: 40 } },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "h5", options: { uppercase: false } },
      { selector: "h6", options: { uppercase: false } },
    ],
  }).trim();

  const text = trimFooterNoise(rawText);
  const warnings: string[] = [];
  let quality: HtmlRenderQuality = "high";

  const styleLeakCount = countStyleLeaks(text);
  if (styleLeakCount >= 3) {
    quality = "low";
    warnings.push("HTML-heavy message; press O to open the original in Gmail.");
  } else {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const footerLikeLines = lines.filter((line) => FOOTER_LINE_PATTERN.test(line)).length;
    const urlLikeLines = lines.filter((line) => /^https?:\/\//i.test(line) || /https?:\/\//i.test(line)).length;

    if ((footerLikeLines >= 5 && footerLikeLines >= Math.ceil(lines.length / 3)) || urlLikeLines >= Math.ceil(lines.length / 2)) {
      quality = "medium";
      warnings.push("This email still contains heavy footer or link boilerplate.");
    }
  }

  return {
    text,
    quality,
    warnings,
  };
}

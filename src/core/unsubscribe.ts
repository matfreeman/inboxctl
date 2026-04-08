export type UnsubscribeMethod = "link" | "mailto" | "both";

export interface UnsubscribeTarget {
  unsubscribeLink: string | null;
  unsubscribeMethod: UnsubscribeMethod | null;
}

interface ParsedUnsubscribeValues {
  links: string[];
  mailtos: string[];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function extractCandidates(value: string): string[] {
  const matches = [...value.matchAll(/<([^>]+)>/g)]
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);

  if (matches.length > 0) {
    return matches;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseListUnsubscribeValues(...values: Array<string | null | undefined>): ParsedUnsubscribeValues {
  const links: string[] = [];
  const mailtos: string[] = [];

  for (const rawValue of values) {
    if (!rawValue?.trim()) {
      continue;
    }

    for (const candidate of extractCandidates(rawValue)) {
      const normalized = candidate.trim();

      if (/^mailto:/i.test(normalized)) {
        mailtos.push(normalized);
        continue;
      }

      if (/^https?:\/\//i.test(normalized)) {
        links.push(normalized);
      }
    }
  }

  return {
    links: uniqueStrings(links),
    mailtos: uniqueStrings(mailtos),
  };
}

export function resolveUnsubscribeTarget(
  ...values: Array<string | null | undefined>
): UnsubscribeTarget {
  const parsed = parseListUnsubscribeValues(...values);

  if (parsed.links.length > 0 && parsed.mailtos.length > 0) {
    return {
      unsubscribeLink: parsed.links[0] || null,
      unsubscribeMethod: "both",
    };
  }

  if (parsed.links.length > 0) {
    return {
      unsubscribeLink: parsed.links[0] || null,
      unsubscribeMethod: "link",
    };
  }

  if (parsed.mailtos.length > 0) {
    return {
      unsubscribeLink: parsed.mailtos[0] || null,
      unsubscribeMethod: "mailto",
    };
  }

  return {
    unsubscribeLink: null,
    unsubscribeMethod: null,
  };
}

export function buildUnsubscribeReason(unreadRate: number, messageCount: number): string {
  if (unreadRate >= 90) {
    return `${unreadRate}% unread across ${messageCount} emails — you never engage with this sender`;
  }

  if (unreadRate >= 50) {
    return `${unreadRate}% unread across ${messageCount} emails — you rarely engage with this sender`;
  }

  if (unreadRate >= 25) {
    return `${unreadRate}% unread across ${messageCount} emails — you sometimes read this sender`;
  }

  return `High volume sender (${messageCount} emails) with ${unreadRate}% unread`;
}

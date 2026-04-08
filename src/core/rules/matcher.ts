import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import type { EmailMessage } from "../gmail/types.js";
import type { Conditions, Matcher, Rule } from "./types.js";
import { getRuleByName } from "./deploy.js";

export interface MatchedEmail {
  email: EmailMessage;
  matchedFields: string[];
}

interface EmailRow {
  id: string;
  thread_id: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  subject: string | null;
  snippet: string | null;
  date: number | null;
  is_read: number | null;
  is_starred: number | null;
  label_ids: string | null;
  size_estimate: number | null;
  has_attachments: number | null;
  list_unsubscribe: string | null;
}

function getDatabase() {
  const config = loadConfig();
  return getSqlite(config.dbPath);
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToEmail(row: EmailRow): EmailMessage {
  return {
    id: row.id,
    threadId: row.thread_id ?? "",
    fromAddress: row.from_address ?? "",
    fromName: row.from_name ?? "",
    toAddresses: parseJsonArray(row.to_addresses),
    subject: row.subject ?? "",
    snippet: row.snippet ?? "",
    date: row.date ?? 0,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    labelIds: parseJsonArray(row.label_ids),
    sizeEstimate: row.size_estimate ?? 0,
    hasAttachments: row.has_attachments === 1,
    listUnsubscribe: row.list_unsubscribe,
  };
}

function getFieldValues(email: EmailMessage, matcher: Matcher): string[] {
  switch (matcher.field) {
    case "from":
      return [email.fromAddress, email.fromName].filter(Boolean);
    case "to":
      return email.toAddresses;
    case "subject":
      return [email.subject];
    case "snippet":
      return [email.snippet];
    case "labels":
      return email.labelIds;
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function exactMatch(values: string[], candidates: string[]): boolean {
  if (values.length === 0 || candidates.length === 0) {
    return false;
  }

  const normalizedCandidates = new Set(candidates.map(normalize));
  return values.some((value) => normalizedCandidates.has(normalize(value)));
}

function containsMatch(values: string[], candidates: string[]): boolean {
  if (values.length === 0 || candidates.length === 0) {
    return false;
  }

  const normalizedCandidates = candidates.map(normalize);
  return values.some((value) => {
    const needle = normalize(value);
    return normalizedCandidates.some((candidate) => candidate.includes(needle));
  });
}

function patternMatch(pattern: string | undefined, candidates: string[]): boolean {
  if (!pattern || candidates.length === 0) {
    return false;
  }

  const regex = new RegExp(pattern);
  return candidates.some((candidate) => regex.test(candidate));
}

export function matchField(email: EmailMessage, matcher: Matcher): boolean {
  const candidates = getFieldValues(email, matcher);
  const matched =
    patternMatch(matcher.pattern, candidates) ||
    containsMatch(matcher.contains ?? [], candidates) ||
    exactMatch(matcher.values ?? [], candidates);

  return matcher.exclude ? !matched : matched;
}

export function matchEmail(
  email: EmailMessage,
  conditions: Conditions,
): { matches: boolean; matchedFields: string[] } {
  const matchedFields: string[] = [];

  if (conditions.operator === "AND") {
    for (const matcher of conditions.matchers) {
      const matched = matchField(email, matcher);

      if (!matched) {
        return {
          matches: false,
          matchedFields: [],
        };
      }

      matchedFields.push(matcher.field);
    }

    return {
      matches: true,
      matchedFields: Array.from(new Set(matchedFields)),
    };
  }

  for (const matcher of conditions.matchers) {
    if (matchField(email, matcher)) {
      matchedFields.push(matcher.field);
    }
  }

  return {
    matches: matchedFields.length > 0,
    matchedFields: Array.from(new Set(matchedFields)),
  };
}

export async function findMatchingEmails(
  ruleOrConditions: string | Pick<Rule, "conditions"> | Conditions,
  limit?: number,
): Promise<MatchedEmail[]> {
  const conditions = typeof ruleOrConditions === "string"
    ? (await getRuleByName(ruleOrConditions))?.conditions
    : "conditions" in ruleOrConditions
      ? ruleOrConditions.conditions
      : ruleOrConditions;

  if (!conditions) {
    throw new Error(`Rule not found: ${ruleOrConditions}`);
  }

  const sqlite = getDatabase();
  const rows = sqlite
    .prepare(
      `
      SELECT
        id,
        thread_id,
        from_address,
        from_name,
        to_addresses,
        subject,
        snippet,
        date,
        is_read,
        is_starred,
        label_ids,
        size_estimate,
        has_attachments,
        list_unsubscribe
      FROM emails
      ORDER BY COALESCE(date, 0) DESC, id DESC
      `,
    )
    .all() as EmailRow[];

  const matches: MatchedEmail[] = [];

  for (const row of rows) {
    const email = rowToEmail(row);
    const result = matchEmail(email, conditions);

    if (!result.matches) {
      continue;
    }

    matches.push({
      email,
      matchedFields: result.matchedFields,
    });

    if (limit !== undefined && matches.length >= limit) {
      break;
    }
  }

  return matches;
}

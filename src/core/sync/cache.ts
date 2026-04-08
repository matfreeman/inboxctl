import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import type { EmailMessage } from "../gmail/types.js";

type EmailRow = {
  id: string;
  thread_id: string;
  from_address: string;
  from_name: string;
  to_addresses: string;
  subject: string;
  snippet: string;
  date: number;
  is_read: number;
  is_starred: number;
  label_ids: string;
  size_estimate: number;
  has_attachments: number;
  list_unsubscribe: string | null;
};

function mapRow(row: EmailRow): EmailMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddresses: JSON.parse(row.to_addresses || "[]") as string[],
    subject: row.subject,
    snippet: row.snippet,
    date: row.date,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    labelIds: JSON.parse(row.label_ids || "[]") as string[],
    sizeEstimate: row.size_estimate,
    hasAttachments: row.has_attachments === 1,
    listUnsubscribe: row.list_unsubscribe,
  };
}

export async function getRecentEmails(
  limit: number = 20,
  offset: number = 0,
): Promise<EmailMessage[]> {
  const config = loadConfig();
  const sqlite = getSqlite(config.dbPath);
  const rows = sqlite
    .prepare(
      `
      SELECT id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
             is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe
      FROM emails
      ORDER BY date DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(limit, offset) as EmailRow[];

  return rows.map(mapRow);
}

export async function searchLocalEmails(query: string): Promise<EmailMessage[]> {
  const config = loadConfig();
  const sqlite = getSqlite(config.dbPath);
  const pattern = `%${query}%`;
  const rows = sqlite
    .prepare(
      `
      SELECT id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
             is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe
      FROM emails
      WHERE subject LIKE ?
         OR from_address LIKE ?
         OR from_name LIKE ?
         OR snippet LIKE ?
      ORDER BY date DESC
      LIMIT 100
      `,
    )
    .all(pattern, pattern, pattern, pattern) as EmailRow[];

  return rows.map(mapRow);
}

export async function getEmailById(id: string): Promise<EmailMessage | null> {
  const config = loadConfig();
  const sqlite = getSqlite(config.dbPath);
  const row = sqlite
    .prepare(
      `
      SELECT id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
             is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe
      FROM emails
      WHERE id = ?
      `,
    )
    .get(id) as EmailRow | undefined;

  return row ? mapRow(row) : null;
}

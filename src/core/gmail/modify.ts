import type { Config } from "../../config.js";
import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { parseMessage, parseMessageDetail } from "./messages.js";
import type { GmailTransport } from "./transport.js";
import { getGmailTransport } from "./transport.js";
import type {
  EmailMessage,
  GmailModifyAction,
  GmailModifyItemResult,
  GmailModifyResult,
  RawGmailMessage,
} from "./types.js";
import { getLabelId } from "./labels.js";
import type { Action } from "../rules/types.js";

interface ModifyContext {
  config: Config;
  transport: GmailTransport;
}

interface ModifyOptions {
  config?: Config;
  transport?: GmailTransport;
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

interface Snapshot {
  email: EmailMessage;
}

const MESSAGE_FETCH_HEADERS = ["From", "To", "Subject", "Date", "List-Unsubscribe"];

function now(): number {
  return Date.now();
}

function normalizeLabelIds(labelIds: string[] | null | undefined): string[] {
  return Array.from(new Set((labelIds || []).filter(Boolean)));
}

function rowToEmail(row: EmailRow): EmailMessage {
  return {
    id: row.id,
    threadId: row.thread_id || "",
    fromAddress: row.from_address || "",
    fromName: row.from_name || "",
    toAddresses: row.to_addresses ? (JSON.parse(row.to_addresses) as string[]) : [],
    subject: row.subject || "",
    snippet: row.snippet || "",
    date: row.date || 0,
    isRead: (row.is_read || 0) === 1,
    isStarred: (row.is_starred || 0) === 1,
    labelIds: row.label_ids ? (JSON.parse(row.label_ids) as string[]) : [],
    sizeEstimate: row.size_estimate || 0,
    hasAttachments: (row.has_attachments || 0) === 1,
    listUnsubscribe: row.list_unsubscribe,
  };
}

function emailToRow(email: EmailMessage): Record<string, string | number | null> {
  return {
    id: email.id,
    thread_id: email.threadId,
    from_address: email.fromAddress,
    from_name: email.fromName,
    to_addresses: JSON.stringify(email.toAddresses),
    subject: email.subject,
    snippet: email.snippet,
    date: email.date,
    is_read: email.isRead ? 1 : 0,
    is_starred: email.isStarred ? 1 : 0,
    label_ids: JSON.stringify(email.labelIds),
    size_estimate: email.sizeEstimate,
    has_attachments: email.hasAttachments ? 1 : 0,
    list_unsubscribe: email.listUnsubscribe,
    synced_at: now(),
  };
}

function applyLabelChange(
  labelIds: string[],
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): string[] {
  const next = [...labelIds];

  for (const labelId of removeLabelIds) {
    const index = next.indexOf(labelId);
    if (index >= 0) {
      next.splice(index, 1);
    }
  }

  for (const labelId of addLabelIds) {
    if (!next.includes(labelId)) {
      next.push(labelId);
    }
  }

  return next;
}

function getReadState(labelIds: string[]): boolean {
  return !labelIds.includes("UNREAD");
}

async function resolveContext(options?: ModifyOptions): Promise<ModifyContext> {
  const config = options?.config || loadConfig();
  const transport = options?.transport || (await getGmailTransport(config));
  return { config, transport };
}

function makePlaceholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

function readSnapshots(config: Config, ids: string[]): Map<string, Snapshot> {
  const sqlite = getSqlite(config.dbPath);
  const rows = sqlite
    .prepare(
      `
      SELECT id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
             is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe
      FROM emails
      WHERE id IN (${makePlaceholders(ids)})
      `,
    )
    .all(...ids) as EmailRow[];

  const snapshots = new Map<string, Snapshot>();

  for (const row of rows) {
    snapshots.set(row.id, {
      email: rowToEmail(row),
    });
  }

  return snapshots;
}

async function fetchMissingSnapshots(
  transport: GmailTransport,
  ids: string[],
  snapshots: Map<string, Snapshot>,
): Promise<void> {
  const missing = ids.filter((id) => !snapshots.has(id));

  const fetched = await Promise.all(
    missing.map(async (id) => {
      const response = await transport.getMessage({
        id,
        format: "metadata",
        metadataHeaders: MESSAGE_FETCH_HEADERS,
      });

      if (!response.id) {
        throw new Error(`Gmail message not found: ${id}`);
      }

      return parseMessage(response);
    }),
  );

  for (const email of fetched) {
    snapshots.set(email.id, { email });
  }
}

function upsertEmails(config: Config, emails: EmailMessage[]): void {
  if (emails.length === 0) {
    return;
  }

  const sqlite = getSqlite(config.dbPath);
  const statement = sqlite.prepare(`
    INSERT INTO emails (
      id, thread_id, from_address, from_name, to_addresses, subject, snippet, date,
      is_read, is_starred, label_ids, size_estimate, has_attachments, list_unsubscribe, synced_at
    ) VALUES (
      @id, @thread_id, @from_address, @from_name, @to_addresses, @subject, @snippet, @date,
      @is_read, @is_starred, @label_ids, @size_estimate, @has_attachments, @list_unsubscribe, @synced_at
    )
    ON CONFLICT(id) DO UPDATE SET
      thread_id = excluded.thread_id,
      from_address = excluded.from_address,
      from_name = excluded.from_name,
      to_addresses = excluded.to_addresses,
      subject = excluded.subject,
      snippet = excluded.snippet,
      date = excluded.date,
      is_read = excluded.is_read,
      is_starred = excluded.is_starred,
      label_ids = excluded.label_ids,
      size_estimate = excluded.size_estimate,
      has_attachments = excluded.has_attachments,
      list_unsubscribe = excluded.list_unsubscribe,
      synced_at = excluded.synced_at
  `);

  const transaction = sqlite.transaction((rows: EmailMessage[]) => {
    for (const email of rows) {
      statement.run(emailToRow(email));
    }
  });

  transaction(emails);
}

function buildResult(
  action: GmailModifyAction,
  items: GmailModifyItemResult[],
  metadata?: Partial<Pick<GmailModifyResult, "labelId" | "labelName" | "toAddress" | "sentMessageId" | "sentThreadId">>,
): GmailModifyResult {
  return {
    action,
    affectedCount: items.length,
    items,
    nonReversible: action === "forward",
    ...metadata,
  };
}

function buildAppliedActions(
  action: GmailModifyAction,
  metadata?: Partial<Pick<GmailModifyResult, "labelName" | "toAddress">>,
): Action[] {
  switch (action) {
    case "archive":
      return [{ type: "archive" }];
    case "label":
      return metadata?.labelName ? [{ type: "label", label: metadata.labelName }] : [];
    case "mark_read":
      return [{ type: "mark_read" }];
    case "mark_spam":
      return [{ type: "mark_spam" }];
    case "forward":
      return metadata?.toAddress ? [{ type: "forward", to: metadata.toAddress }] : [];
    default:
      return [];
  }
}

async function performLabelMutation(
  action: Exclude<GmailModifyAction, "forward">,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
  options?: ModifyOptions,
  metadata?: Partial<Pick<GmailModifyResult, "labelId" | "labelName">>,
): Promise<GmailModifyResult> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));

  if (uniqueIds.length === 0) {
    return buildResult(action, [], metadata);
  }

  const context = await resolveContext(options);
  const snapshots = readSnapshots(context.config, uniqueIds);
  await fetchMissingSnapshots(context.transport, uniqueIds, snapshots);

  const orderedSnapshots = uniqueIds.map((id) => {
    const snapshot = snapshots.get(id);

    if (!snapshot) {
      throw new Error(`Unable to resolve Gmail message snapshot for ${id}`);
    }

    return snapshot;
  });

  const batchSize = 1000;
  for (let index = 0; index < uniqueIds.length; index += batchSize) {
    await context.transport.batchModifyMessages({
      ids: uniqueIds.slice(index, index + batchSize),
      addLabelIds,
      removeLabelIds,
    });
  }

  const updatedEmails = orderedSnapshots.map(({ email }) => {
    const labelIds = applyLabelChange(email.labelIds, addLabelIds, removeLabelIds);
    return {
      ...email,
      labelIds,
      isRead: getReadState(labelIds),
    };
  });

  upsertEmails(context.config, updatedEmails);

  const items = orderedSnapshots.map(({ email }, index) => {
    const afterLabelIds = updatedEmails[index]?.labelIds || [];
    return {
      emailId: email.id,
      beforeLabelIds: [...email.labelIds],
      afterLabelIds,
      status: "applied" as const,
      appliedActions: buildAppliedActions(action, metadata),
    };
  });

  return buildResult(action, items, metadata);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function formatAddress(name: string, address: string): string {
  if (!name) {
    return address;
  }

  return `"${name.replace(/"/g, '\\"')}" <${address}>`;
}

function normalizeForwardSubject(subject: string): string {
  if (/^fwd:/i.test(subject)) {
    return subject;
  }

  return `Fwd: ${subject}`;
}

function buildForwardRawMessage(
  message: RawGmailMessage,
  toAddress: string,
): { raw: string; detail: ReturnType<typeof parseMessageDetail> } {
  const detail = parseMessageDetail(message);
  const introLines = [
    "---------- Forwarded message ---------",
    `From: ${formatAddress(detail.fromName, detail.fromAddress)}`,
    `Date: ${new Date(detail.date).toUTCString()}`,
    `Subject: ${detail.subject}`,
    `To: ${detail.toAddresses.join(", ")}`,
    "",
  ];
  const forwardedBody = detail.body || detail.textPlain || detail.snippet || "";
  const rawMessage = [
    `To: ${toAddress}`,
    `Subject: ${normalizeForwardSubject(detail.subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    [...introLines, forwardedBody].join("\r\n"),
  ].join("\r\n");

  return {
    raw: encodeBase64Url(rawMessage),
    detail,
  };
}

export interface RestoreEmailLabelsResult {
  status: "applied" | "error";
  errorMessage?: string | null;
}

export async function restoreEmailLabels(
  emailId: string,
  beforeLabelIds: string[],
): Promise<RestoreEmailLabelsResult> {
  try {
    const context = await resolveContext();
    const snapshots = readSnapshots(context.config, [emailId]);
    await fetchMissingSnapshots(context.transport, [emailId], snapshots);

    const snapshot = snapshots.get(emailId);

    if (!snapshot) {
      return {
        status: "error",
        errorMessage: `Unable to resolve Gmail message snapshot for ${emailId}`,
      };
    }

    const currentLabelIds = normalizeLabelIds(snapshot.email.labelIds);
    const targetLabelIds = normalizeLabelIds(beforeLabelIds);
    const addLabelIds = targetLabelIds.filter((labelId) => !currentLabelIds.includes(labelId));
    const removeLabelIds = currentLabelIds.filter((labelId) => !targetLabelIds.includes(labelId));

    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      return { status: "applied" };
    }

    await context.transport.batchModifyMessages({
      ids: [emailId],
      addLabelIds,
      removeLabelIds,
    });

    const restoredLabelIds = applyLabelChange(currentLabelIds, addLabelIds, removeLabelIds);
    upsertEmails(context.config, [
      {
        ...snapshot.email,
        labelIds: restoredLabelIds,
        isRead: getReadState(restoredLabelIds),
      },
    ]);

    return { status: "applied" };
  } catch (error) {
    return {
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function archiveEmails(
  ids: string[],
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  return performLabelMutation("archive", ids, [], ["INBOX"], options, {
    labelId: "INBOX",
    labelName: "INBOX",
  });
}

export async function unarchiveEmails(
  ids: string[],
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  return performLabelMutation("unarchive", ids, ["INBOX"], [], options, {
    labelId: "INBOX",
    labelName: "INBOX",
  });
}

export async function labelEmails(
  ids: string[],
  labelName: string,
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  const context = await resolveContext(options);
  const labelId = await getLabelId(labelName, context);

  if (!labelId) {
    throw new Error(`Unknown Gmail label: ${labelName}`);
  }

  return performLabelMutation("label", ids, [labelId], [], context, {
    labelId,
    labelName,
  });
}

export async function unlabelEmails(
  ids: string[],
  labelName: string,
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  const context = await resolveContext(options);
  const labelId = await getLabelId(labelName, context);

  if (!labelId) {
    throw new Error(`Unknown Gmail label: ${labelName}`);
  }

  return performLabelMutation("unlabel", ids, [], [labelId], context, {
    labelId,
    labelName,
  });
}

export async function markRead(
  ids: string[],
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  return performLabelMutation("mark_read", ids, [], ["UNREAD"], options, {
    labelId: "UNREAD",
    labelName: "UNREAD",
  });
}

export async function markUnread(
  ids: string[],
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  return performLabelMutation("mark_unread", ids, ["UNREAD"], [], options, {
    labelId: "UNREAD",
    labelName: "UNREAD",
  });
}

export async function markSpam(
  ids: string[],
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  return performLabelMutation("mark_spam", ids, ["SPAM"], ["INBOX"], options, {
    labelId: "SPAM",
    labelName: "SPAM",
  });
}

export async function unmarkSpam(
  ids: string[],
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  return performLabelMutation("unmark_spam", ids, ["INBOX"], ["SPAM"], options, {
    labelId: "SPAM",
    labelName: "SPAM",
  });
}

export async function forwardEmail(
  id: string,
  toAddress: string,
  options?: ModifyOptions,
): Promise<GmailModifyResult> {
  const context = await resolveContext(options);
  const response = await context.transport.getMessage({
    id,
    format: "full",
  });

  if (!response.id) {
    throw new Error(`Gmail message not found: ${id}`);
  }

  const { raw, detail } = buildForwardRawMessage(response, toAddress);
  const sent = await context.transport.sendMessage(raw);
  const labelIds = normalizeLabelIds(response.labelIds || detail.labelIds);

  return buildResult(
    "forward",
    [
      {
        emailId: response.id,
        beforeLabelIds: labelIds,
        afterLabelIds: labelIds,
        status: "applied",
        appliedActions: buildAppliedActions("forward", { toAddress }),
      },
    ],
    {
      toAddress,
      sentMessageId: sent.id || undefined,
      sentThreadId: sent.threadId || undefined,
    },
  );
}

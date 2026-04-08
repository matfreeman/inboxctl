import type { Config } from "../../config.js";
import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { batchApplyActions, type BatchAction } from "./batch.js";
import type { GmailTransport } from "./transport.js";
import {
  resolveUnsubscribeTarget,
  type UnsubscribeMethod,
} from "../unsubscribe.js";

interface UnsubscribeContext {
  config: Config;
  transport?: GmailTransport;
}

export interface UnsubscribeOptions {
  senderEmail: string;
  alsoArchive?: boolean;
  alsoLabel?: string;
  config?: Config;
  transport?: GmailTransport;
}

export interface UnsubscribeResult {
  sender: string;
  unsubscribeLink: string;
  unsubscribeMethod: UnsubscribeMethod;
  messageCount: number;
  archivedCount: number;
  labeledCount: number;
  runId?: string;
  undoAvailable?: boolean;
  instruction: string;
}

interface SenderAggregateRow {
  messageCount: number;
  newsletterUnsubscribeLink: string | null;
  emailUnsubscribeHeaders: string | null;
}

function resolveContext(options: Pick<UnsubscribeOptions, "config" | "transport">): UnsubscribeContext {
  return {
    config: options.config || loadConfig(),
    transport: options.transport,
  };
}

function buildInstruction(
  method: UnsubscribeMethod,
  archivedCount: number,
  labeledCount: number,
): string {
  const cleanupParts: string[] = [];

  if (labeledCount > 0) {
    cleanupParts.push(`${labeledCount} emails labeled`);
  }

  if (archivedCount > 0) {
    cleanupParts.push(`${archivedCount} emails archived`);
  }

  const cleanup = cleanupParts.length > 0 ? `${cleanupParts.join(" and ")}. ` : "";

  if (method === "mailto") {
    return `${cleanup}Open this mailto link in your email client to complete the unsubscribe process. inboxctl cannot auto-submit unsubscribe forms.`;
  }

  return `${cleanup}Open this link in your browser to complete the unsubscribe process. inboxctl cannot auto-submit unsubscribe forms.`;
}

function getSenderAggregate(sqlite: ReturnType<typeof getSqlite>, senderEmail: string): SenderAggregateRow | null {
  const row = sqlite
    .prepare(
      `
      SELECT
        COUNT(*) AS messageCount,
        MAX(NULLIF(TRIM(ns.unsubscribe_link), '')) AS newsletterUnsubscribeLink,
        GROUP_CONCAT(NULLIF(TRIM(e.list_unsubscribe), ''), '\n') AS emailUnsubscribeHeaders
      FROM emails AS e
      LEFT JOIN newsletter_senders AS ns
        ON LOWER(ns.email) = LOWER(e.from_address)
      WHERE LOWER(e.from_address) = LOWER(?)
      GROUP BY LOWER(e.from_address)
      `,
    )
    .get(senderEmail) as SenderAggregateRow | undefined;

  return row || null;
}

function getSenderEmailIds(sqlite: ReturnType<typeof getSqlite>, senderEmail: string): string[] {
  const rows = sqlite
    .prepare(
      `
      SELECT id
      FROM emails
      WHERE LOWER(from_address) = LOWER(?)
      ORDER BY COALESCE(date, 0) DESC, id ASC
      `,
    )
    .all(senderEmail) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

export async function unsubscribe(
  options: UnsubscribeOptions,
): Promise<UnsubscribeResult> {
  const senderEmail = options.senderEmail.trim();

  if (!senderEmail) {
    throw new Error("senderEmail is required");
  }

  const context = resolveContext(options);
  const sqlite = getSqlite(context.config.dbPath);
  const aggregate = getSenderAggregate(sqlite, senderEmail);

  if (!aggregate) {
    throw new Error(`No emails found from ${senderEmail}`);
  }

  const unsubscribeTarget = resolveUnsubscribeTarget(
    aggregate.newsletterUnsubscribeLink,
    aggregate.emailUnsubscribeHeaders,
  );

  if (!unsubscribeTarget.unsubscribeLink || !unsubscribeTarget.unsubscribeMethod) {
    throw new Error(
      `No unsubscribe link found for ${senderEmail}. This sender does not include List-Unsubscribe headers.`,
    );
  }

  const alsoLabel = options.alsoLabel?.trim() || undefined;
  const actions: BatchAction[] = [];

  if (alsoLabel) {
    actions.push({ type: "label", label: alsoLabel });
  }

  if (options.alsoArchive) {
    actions.push({ type: "archive" });
  }

  const emailIds = actions.length > 0 ? getSenderEmailIds(sqlite, senderEmail) : [];
  const batchResult = actions.length > 0
    ? await batchApplyActions({
      groups: [{ emailIds, actions }],
      config: context.config,
      transport: context.transport,
      sourceType: "unsubscribe",
      query: senderEmail,
    })
    : null;

  const archivedCount = options.alsoArchive ? aggregate.messageCount : 0;
  const labeledCount = alsoLabel ? aggregate.messageCount : 0;

  return {
    sender: senderEmail,
    unsubscribeLink: unsubscribeTarget.unsubscribeLink,
    unsubscribeMethod: unsubscribeTarget.unsubscribeMethod,
    messageCount: aggregate.messageCount,
    archivedCount,
    labeledCount,
    ...(batchResult?.runId
      ? {
        runId: batchResult.runId,
        undoAvailable: batchResult.undoAvailable,
      }
      : {}),
    instruction: buildInstruction(
      unsubscribeTarget.unsubscribeMethod,
      archivedCount,
      labeledCount,
    ),
  };
}

import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { getGmailTransport } from "../gmail/transport.js";
import { batchGetMessages } from "../gmail/messages.js";
import type { EmailMessage, SyncResult } from "../gmail/types.js";

export type ProgressCallback = (synced: number, total: number | null) => void;
export type SyncProgressPhase =
  | "starting"
  | "checking_history"
  | "fetching_messages"
  | "applying_changes"
  | "finalizing"
  | "fallback";

export interface SyncProgressEvent {
  mode: "full" | "incremental";
  phase: SyncProgressPhase;
  synced: number;
  total: number | null;
  detail: string;
}

export type SyncProgressEventCallback = (event: SyncProgressEvent) => void;

type SyncStateRow = {
  account_email: string | null;
  history_id: string | null;
  last_full_sync: number | null;
  last_incremental_sync: number | null;
  total_messages: number | null;
  full_sync_cursor: string | null;
  full_sync_processed: number | null;
  full_sync_total: number | null;
};

export interface AccountCacheReconciliationResult {
  cleared: boolean;
  reason: "account_switched" | "legacy_unscoped_cache" | null;
  previousEmail: string | null;
}

function upsertEmails(dbPath: string, messages: EmailMessage[]): void {
  if (messages.length === 0) {
    return;
  }

  const sqlite = getSqlite(dbPath);
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

  const now = Date.now();
  const transaction = sqlite.transaction((emails: EmailMessage[]) => {
    for (const message of emails) {
      statement.run({
        id: message.id,
        thread_id: message.threadId,
        from_address: message.fromAddress,
        from_name: message.fromName,
        to_addresses: JSON.stringify(message.toAddresses),
        subject: message.subject,
        snippet: message.snippet,
        date: message.date,
        is_read: message.isRead ? 1 : 0,
        is_starred: message.isStarred ? 1 : 0,
        label_ids: JSON.stringify(message.labelIds),
        size_estimate: message.sizeEstimate,
        has_attachments: message.hasAttachments ? 1 : 0,
        list_unsubscribe: message.listUnsubscribe,
        synced_at: now,
      });
    }
  });

  transaction(messages);
}

function deleteEmails(dbPath: string, ids: string[]): void {
  if (ids.length === 0) {
    return;
  }

  const sqlite = getSqlite(dbPath);
  const statement = sqlite.prepare(`DELETE FROM emails WHERE id = ?`);
  const transaction = sqlite.transaction((messageIds: string[]) => {
    for (const id of messageIds) {
      statement.run(id);
    }
  });
  transaction(ids);
}

function getSyncState(dbPath: string): SyncStateRow {
  const sqlite = getSqlite(dbPath);
  const row = sqlite
    .prepare(
      `SELECT account_email, history_id, last_full_sync, last_incremental_sync, total_messages, full_sync_cursor, full_sync_processed, full_sync_total FROM sync_state WHERE id = 1`,
    )
    .get() as SyncStateRow | undefined;

  return (
    row || {
      account_email: null,
      history_id: null,
      last_full_sync: null,
      last_incremental_sync: null,
      total_messages: 0,
      full_sync_cursor: null,
      full_sync_processed: 0,
      full_sync_total: 0,
    }
  );
}

function saveSyncState(
  dbPath: string,
  updates: Partial<SyncStateRow>,
): void {
  const current = getSyncState(dbPath);
  const sqlite = getSqlite(dbPath);
  const next = {
    account_email: Object.prototype.hasOwnProperty.call(updates, "account_email")
      ? updates.account_email ?? null
      : current.account_email,
    history_id: Object.prototype.hasOwnProperty.call(updates, "history_id")
      ? updates.history_id ?? null
      : current.history_id,
    last_full_sync: Object.prototype.hasOwnProperty.call(updates, "last_full_sync")
      ? updates.last_full_sync ?? null
      : current.last_full_sync,
    last_incremental_sync: Object.prototype.hasOwnProperty.call(updates, "last_incremental_sync")
      ? updates.last_incremental_sync ?? null
      : current.last_incremental_sync,
    total_messages: Object.prototype.hasOwnProperty.call(updates, "total_messages")
      ? updates.total_messages ?? 0
      : current.total_messages,
    full_sync_cursor: Object.prototype.hasOwnProperty.call(updates, "full_sync_cursor")
      ? updates.full_sync_cursor ?? null
      : current.full_sync_cursor,
    full_sync_processed: Object.prototype.hasOwnProperty.call(updates, "full_sync_processed")
      ? updates.full_sync_processed ?? 0
      : current.full_sync_processed,
    full_sync_total: Object.prototype.hasOwnProperty.call(updates, "full_sync_total")
      ? updates.full_sync_total ?? 0
      : current.full_sync_total,
  };
  sqlite
    .prepare(
      `
      UPDATE sync_state
      SET account_email = ?,
          history_id = ?,
          last_full_sync = ?,
          last_incremental_sync = ?,
          total_messages = ?,
          full_sync_cursor = ?,
          full_sync_processed = ?,
          full_sync_total = ?
      WHERE id = 1
      `,
    )
    .run(
      next.account_email,
      next.history_id,
      next.last_full_sync,
      next.last_incremental_sync,
      next.total_messages,
      next.full_sync_cursor,
      next.full_sync_processed,
      next.full_sync_total,
    );
}

function clearCachedEmailData(dbPath: string): void {
  const sqlite = getSqlite(dbPath);
  sqlite.exec(`
    DELETE FROM emails;
    DELETE FROM newsletter_senders;
  `);
}

function clearAccountScopedState(dbPath: string, nextAccountEmail: string | null): void {
  const sqlite = getSqlite(dbPath);
  sqlite.exec(`
    DELETE FROM emails;
    DELETE FROM newsletter_senders;
    DELETE FROM execution_items;
    DELETE FROM execution_runs;
  `);

  sqlite
    .prepare(
      `
      UPDATE sync_state
      SET account_email = ?,
          history_id = NULL,
          last_full_sync = NULL,
          last_incremental_sync = NULL,
          total_messages = 0,
          full_sync_cursor = NULL,
          full_sync_processed = 0,
          full_sync_total = 0
      WHERE id = 1
      `,
    )
    .run(nextAccountEmail);
}

function resetFullSyncProgress(dbPath: string): void {
  saveSyncState(dbPath, {
    full_sync_cursor: null,
    full_sync_processed: 0,
    full_sync_total: 0,
  });
}

export function reconcileCacheForAuthenticatedAccount(
  dbPath: string,
  authenticatedEmail: string | null | undefined,
  options?: { clearLegacyUnscoped?: boolean },
): AccountCacheReconciliationResult {
  const normalizedEmail =
    authenticatedEmail && authenticatedEmail !== "unknown"
      ? authenticatedEmail
      : null;
  const state = getSyncState(dbPath);
  const sqlite = getSqlite(dbPath);
  const cachedEmailCount = (
    sqlite.prepare("SELECT COUNT(*) as count FROM emails").get() as { count: number }
  ).count;

  if (!normalizedEmail) {
    return {
      cleared: false,
      reason: null,
      previousEmail: state.account_email,
    };
  }

  if (state.account_email && state.account_email !== normalizedEmail) {
    clearAccountScopedState(dbPath, normalizedEmail);
    return {
      cleared: true,
      reason: "account_switched",
      previousEmail: state.account_email,
    };
  }

  if (!state.account_email && cachedEmailCount > 0 && options?.clearLegacyUnscoped) {
    clearAccountScopedState(dbPath, normalizedEmail);
    return {
      cleared: true,
      reason: "legacy_unscoped_cache",
      previousEmail: null,
    };
  }

  if (state.account_email !== normalizedEmail) {
    saveSyncState(dbPath, { account_email: normalizedEmail });
  }

  return {
    cleared: false,
    reason: null,
    previousEmail: state.account_email,
  };
}

export async function fullSync(
  onProgress?: ProgressCallback,
  onEvent?: SyncProgressEventCallback,
): Promise<SyncResult> {
  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const profile = await transport.getProfile();
  const accountEmail = profile.emailAddress || null;
  const priorState = getSyncState(config.dbPath);
  const accountReconciliation = reconcileCacheForAuthenticatedAccount(
    config.dbPath,
    accountEmail,
    { clearLegacyUnscoped: true },
  );
  const pageSize = Math.min(config.sync.pageSize, 100);
  const maxMessages = config.sync.maxMessages;
  const resumableSync =
    !accountReconciliation.cleared &&
    priorState.account_email === accountEmail &&
    !priorState.history_id &&
    ((priorState.full_sync_cursor && priorState.full_sync_cursor.length > 0) ||
      (priorState.full_sync_processed || 0) > 0);
  let pageToken = resumableSync ? priorState.full_sync_cursor || undefined : undefined;
  let processed = resumableSync ? priorState.full_sync_processed || 0 : 0;
  let added = 0;
  let updated = 0;
  let latestHistoryId = profile.historyId || getSyncState(config.dbPath).history_id || "";
  const knownTotalMessages = profile.messagesTotal ?? priorState.full_sync_total ?? null;

  if (!resumableSync) {
    clearCachedEmailData(config.dbPath);
    resetFullSyncProgress(config.dbPath);
  }

  onEvent?.({
    mode: "full",
    phase: "starting",
    synced: processed,
    total: knownTotalMessages,
    detail: resumableSync
      ? `Resuming full mailbox sync… ${processed}${knownTotalMessages ? ` / ${knownTotalMessages}` : ""}`
      : accountReconciliation.cleared
      ? "Starting full mailbox sync after resetting the local cache for this account…"
      : "Starting full mailbox sync…",
  });
  onProgress?.(processed, knownTotalMessages);

  do {
    const response = await transport.listMessages({
      maxResults: pageSize,
      pageToken,
    });

    pageToken = response.nextPageToken || undefined;

    const ids = (response.messages || [])
      .map((message) => message.id)
      .filter(Boolean) as string[];

    if (ids.length === 0) {
      break;
    }

    onEvent?.({
      mode: "full",
      phase: "fetching_messages",
      synced: processed,
      total: knownTotalMessages,
      detail: "Fetching message metadata…",
    });

    const processedBeforeBatch = processed;
    const messages = await batchGetMessages(ids, (completedInBatch) => {
      const synced = processedBeforeBatch + completedInBatch;
      const total = knownTotalMessages !== null
        ? Math.max(knownTotalMessages, synced)
        : null;

      onProgress?.(synced, total);
      onEvent?.({
        mode: "full",
        phase: "fetching_messages",
        synced,
        total,
        detail: `Fetching mailbox metadata… ${synced}${total ? ` / ${total}` : ""}`,
      });
    });
    upsertEmails(config.dbPath, messages);

    processed += messages.length;
    updated += messages.length;
    added += messages.length;
    saveSyncState(config.dbPath, {
      account_email: accountEmail,
      total_messages: processed,
      full_sync_cursor: pageToken || null,
      full_sync_processed: processed,
      full_sync_total: knownTotalMessages ?? processed,
    });
    onProgress?.(
      processed,
      knownTotalMessages !== null ? Math.max(knownTotalMessages, processed) : null,
    );

    if (maxMessages && processed >= maxMessages) {
      pageToken = undefined;
    }
  } while (pageToken);

  onEvent?.({
    mode: "full",
    phase: "finalizing",
    synced: processed,
    total: knownTotalMessages !== null ? Math.max(knownTotalMessages, processed) : processed,
    detail: "Finalizing full sync…",
  });
  saveSyncState(config.dbPath, {
    account_email: accountEmail,
    history_id: latestHistoryId,
    last_full_sync: Date.now(),
    total_messages: processed,
    full_sync_cursor: null,
    full_sync_processed: 0,
    full_sync_total: 0,
  });

  return {
    messagesProcessed: processed,
    messagesAdded: added,
    messagesUpdated: updated,
    historyId: latestHistoryId,
    mode: "full",
    usedHistoryFallback: false,
  };
}

function isStaleHistoryError(error: unknown): boolean {
  const status = (error as { code?: number; status?: number }).code ||
    (error as { code?: number; status?: number }).status;
  return status === 404;
}

export async function incrementalSync(
  onProgress?: ProgressCallback,
  onEvent?: SyncProgressEventCallback,
): Promise<SyncResult> {
  const config = loadConfig();
  const transport = await getGmailTransport(config);
  const profile = await transport.getProfile();
  const accountReconciliation = reconcileCacheForAuthenticatedAccount(
    config.dbPath,
    profile.emailAddress || null,
    { clearLegacyUnscoped: true },
  );
  const state = getSyncState(config.dbPath);

  if (accountReconciliation.cleared || !state.history_id) {
    return fullSync(onProgress, onEvent);
  }

  try {
    onEvent?.({
      mode: "incremental",
      phase: "checking_history",
      synced: 0,
      total: null,
      detail: "Checking Gmail history for changes…",
    });

    const response = await transport.listHistory({
      startHistoryId: state.history_id,
      maxResults: config.sync.pageSize,
      historyTypes: [
        "messageAdded",
        "labelAdded",
        "labelRemoved",
        "messageDeleted",
      ],
    });

    const history = response.history || [];
    const touchedIds = new Set<string>();
    const deletedIds = new Set<string>();

    for (const entry of history) {
      for (const item of entry.messagesAdded || []) {
        if (item.message?.id) {
          touchedIds.add(item.message.id);
        }
      }

      for (const item of entry.labelsAdded || []) {
        if (item.message?.id) {
          touchedIds.add(item.message.id);
        }
      }

      for (const item of entry.labelsRemoved || []) {
        if (item.message?.id) {
          touchedIds.add(item.message.id);
        }
      }

      for (const item of entry.messagesDeleted || []) {
        if (item.message?.id) {
          deletedIds.add(item.message.id);
        }
      }
    }

    for (const id of deletedIds) {
      touchedIds.delete(id);
    }

    const totalChanges = touchedIds.size + deletedIds.size;

    onEvent?.({
      mode: "incremental",
      phase: "fetching_messages",
      synced: 0,
      total: totalChanges,
      detail:
        totalChanges === 0
          ? "No changes found."
          : `Refreshing ${touchedIds.size} changed emails and ${deletedIds.size} deletions…`,
    });

    const refreshed = await batchGetMessages([...touchedIds], (completed) => {
      onProgress?.(completed, totalChanges);
      onEvent?.({
        mode: "incremental",
        phase: "fetching_messages",
        synced: completed,
        total: totalChanges,
        detail: `Refreshing changed emails… ${completed}${totalChanges ? ` / ${totalChanges}` : ""}`,
      });
    });

    onEvent?.({
      mode: "incremental",
      phase: "applying_changes",
      synced: refreshed.length,
      total: totalChanges,
      detail: "Applying Gmail changes to the local cache…",
    });

    upsertEmails(config.dbPath, refreshed);
    deleteEmails(config.dbPath, [...deletedIds]);

    onProgress?.(totalChanges, totalChanges || null);
    onEvent?.({
      mode: "incremental",
      phase: "finalizing",
      synced: totalChanges,
      total: totalChanges || null,
      detail: "Finalizing incremental sync…",
    });

    const latestHistoryId = response.historyId || state.history_id;
    const totalMessagesRow = getSqlite(config.dbPath)
      .prepare(`SELECT COUNT(*) as count FROM emails`)
      .get() as { count: number };
    saveSyncState(config.dbPath, {
      account_email: profile.emailAddress || null,
      history_id: latestHistoryId,
      last_incremental_sync: Date.now(),
      total_messages: totalMessagesRow.count,
      full_sync_cursor: null,
      full_sync_processed: 0,
      full_sync_total: 0,
    });

    return {
      messagesProcessed: refreshed.length + deletedIds.size,
      messagesAdded: refreshed.length,
      messagesUpdated: refreshed.length,
      historyId: latestHistoryId,
      mode: "incremental",
      usedHistoryFallback: false,
    };
  } catch (error) {
    if (!isStaleHistoryError(error)) {
      throw error;
    }

    console.warn(
      `Stored Gmail historyId ${state.history_id} is stale; falling back to full sync.`,
    );
    onEvent?.({
      mode: "incremental",
      phase: "fallback",
      synced: 0,
      total: null,
      detail: "History checkpoint expired. Falling back to a full sync…",
    });
    const result = await fullSync(onProgress, onEvent);

    return {
      ...result,
      usedHistoryFallback: true,
    };
  }
}

export async function getSyncStatus(): Promise<{
  accountEmail: string | null;
  historyId: string | null;
  lastFullSync: number | null;
  lastIncrementalSync: number | null;
  totalMessages: number;
  fullSyncProcessed: number;
  fullSyncTotal: number | null;
  fullSyncResumable: boolean;
}> {
  const config = loadConfig();
  const state = getSyncState(config.dbPath);

  return {
    accountEmail: state.account_email,
    historyId: state.history_id,
    lastFullSync: state.last_full_sync,
    lastIncrementalSync: state.last_incremental_sync,
    totalMessages: state.total_messages || 0,
    fullSyncProcessed: state.full_sync_processed || 0,
    fullSyncTotal: state.full_sync_total || null,
    fullSyncResumable: Boolean((state.full_sync_cursor && state.full_sync_cursor.length > 0) || (state.full_sync_processed || 0) > 0),
  };
}

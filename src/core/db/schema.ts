import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// --- emails ---
// Cached email metadata synced from Gmail
export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(), // Gmail message ID
    threadId: text("thread_id"),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    toAddresses: text("to_addresses"), // JSON array
    subject: text("subject"),
    snippet: text("snippet"),
    date: integer("date"), // Unix timestamp
    isRead: integer("is_read"), // 0/1
    isStarred: integer("is_starred"), // 0/1
    labelIds: text("label_ids"), // JSON array
    sizeEstimate: integer("size_estimate"),
    hasAttachments: integer("has_attachments"), // 0/1
    listUnsubscribe: text("list_unsubscribe"), // List-Unsubscribe header
    syncedAt: integer("synced_at"), // Unix timestamp
  },
  (table) => [
    index("idx_emails_from_address").on(table.fromAddress),
    index("idx_emails_date").on(table.date),
    index("idx_emails_thread_id").on(table.threadId),
    index("idx_emails_is_read").on(table.isRead),
  ],
);

// --- rules ---
// Deployed rule definitions (mirrors YAML source files)
export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(), // UUID
  name: text("name").unique().notNull(),
  description: text("description"),
  enabled: integer("enabled").default(1), // 0/1
  yamlHash: text("yaml_hash"), // SHA-256 of source YAML
  conditions: text("conditions").notNull(), // JSON
  actions: text("actions").notNull(), // JSON
  priority: integer("priority").default(50),
  deployedAt: integer("deployed_at"),
  createdAt: integer("created_at"),
});

// --- execution_runs ---
// Parent audit record for each manual batch or rule run
export const executionRuns = sqliteTable(
  "execution_runs",
  {
    id: text("id").primaryKey(), // UUID
    sourceType: text("source_type").notNull(), // manual | rule
    ruleId: text("rule_id"), // FK to rules.id (null for manual actions)
    dryRun: integer("dry_run").default(0), // 0/1
    requestedActions: text("requested_actions").notNull(), // JSON
    query: text("query"),
    status: text("status").notNull(), // planned | applied | partial | error | undone
    createdAt: integer("created_at"),
    undoneAt: integer("undone_at"),
  },
  (table) => [
    index("idx_execution_runs_rule_id").on(table.ruleId),
    index("idx_execution_runs_created_at").on(table.createdAt),
  ],
);

// --- execution_items ---
// Per-email outcomes within an execution run
export const executionItems = sqliteTable(
  "execution_items",
  {
    id: text("id").primaryKey(), // UUID
    runId: text("run_id").notNull(), // FK to execution_runs.id
    emailId: text("email_id").notNull(), // Gmail message ID
    status: text("status").notNull(), // planned | applied | warning | error | undone
    appliedActions: text("applied_actions").notNull(), // JSON
    beforeLabelIds: text("before_label_ids").notNull(), // JSON array
    afterLabelIds: text("after_label_ids").notNull(), // JSON array
    errorMessage: text("error_message"),
    executedAt: integer("executed_at"),
    undoneAt: integer("undone_at"),
  },
  (table) => [
    index("idx_execution_items_run_id").on(table.runId),
    index("idx_execution_items_email_id").on(table.emailId),
    index("idx_execution_items_executed_at").on(table.executedAt),
  ],
);

// --- sync_state ---
// Singleton tracking Gmail sync progress
export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey(), // Always 1
  accountEmail: text("account_email"),
  historyId: text("history_id"),
  lastFullSync: integer("last_full_sync"),
  lastIncrementalSync: integer("last_incremental_sync"),
  totalMessages: integer("total_messages"),
  fullSyncCursor: text("full_sync_cursor"),
  fullSyncProcessed: integer("full_sync_processed"),
  fullSyncTotal: integer("full_sync_total"),
});

// --- newsletter_senders ---
// Detected mailing lists and their status
export const newsletterSenders = sqliteTable(
  "newsletter_senders",
  {
    id: text("id").primaryKey(), // UUID
    email: text("email").unique().notNull(),
    name: text("name"),
    messageCount: integer("message_count").default(0),
    unreadCount: integer("unread_count").default(0),
    status: text("status").default("active"), // active | unsubscribed | archived
    unsubscribeLink: text("unsubscribe_link"),
    detectionReason: text("detection_reason"),
    firstSeen: integer("first_seen"),
    lastSeen: integer("last_seen"),
  },
  (table) => [index("idx_newsletter_senders_email").on(table.email)],
);

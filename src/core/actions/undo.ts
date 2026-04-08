import { loadConfig } from "../../config.js";
import { getSqlite } from "../db/client.js";
import { restoreEmailLabels } from "../gmail/modify.js";
import type {
  AuditAction,
  ExecutionItemRecord,
  ExecutionItemStatus,
  ExecutionRunRecord,
  ExecutionRunStatus,
} from "./audit.js";
import { getRun, getRunItems } from "./audit.js";

export interface UndoRunResult {
  runId: string;
  run: ExecutionRunRecord;
  warnings: string[];
  restoredItemCount: number;
  itemCount: number;
  undoneCount: number;
  warningCount: number;
  errorCount: number;
  status: ExecutionRunStatus;
}

function getDatabase() {
  const config = loadConfig();
  return getSqlite(config.dbPath);
}

function getActionType(action: AuditAction): string | null {
  return typeof action === "object" && action && "type" in action && typeof action.type === "string"
    ? action.type.toLowerCase()
    : null;
}

function hasNonReversibleAction(item: ExecutionItemRecord): boolean {
  return item.appliedActions.some((action) => getActionType(action) === "forward");
}

function updateItem(
  sqlite: ReturnType<typeof getSqlite>,
  itemId: string,
  status: ExecutionItemStatus,
  errorMessage: string | null,
  undoneAt: number | null,
): void {
  sqlite
    .prepare(
      `
      UPDATE execution_items
      SET status = ?, error_message = ?, undone_at = ?
      WHERE id = ?
      `,
    )
    .run(status, errorMessage, undoneAt, itemId);
}

function updateRun(
  sqlite: ReturnType<typeof getSqlite>,
  runId: string,
  status: ExecutionRunStatus,
  undoneAt: number | null,
): void {
  sqlite
    .prepare(
      `
      UPDATE execution_runs
      SET status = ?, undone_at = ?
      WHERE id = ?
      `,
    )
    .run(status, undoneAt, runId);
}

export async function undoRun(runId: string): Promise<UndoRunResult> {
  const sqlite = getDatabase();
  const run = await getRun(runId);

  if (!run) {
    throw new Error(`Execution run not found: ${runId}`);
  }

  if (run.status === "undone" || run.undoneAt !== null) {
    throw new Error(`Execution run is already undone: ${runId}`);
  }

  const items = await getRunItems(runId);
  const warnings: string[] = [];
  let undoneCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  const undoneAt = Date.now();

  for (const item of items) {
    const restored = await restoreEmailLabels(item.emailId, item.beforeLabelIds);

    if (restored.status === "error") {
      errorCount += 1;
      updateItem(
        sqlite,
        item.id,
        "error",
        restored.errorMessage || "Failed to restore Gmail label snapshot.",
        null,
      );
      continue;
    }

    if (hasNonReversibleAction(item)) {
      const message = `Email ${item.emailId}: label state was restored, but forward actions cannot be undone.`;
      warnings.push(message);
      warningCount += 1;
      updateItem(sqlite, item.id, "warning", message, undoneAt);
      continue;
    }

    undoneCount += 1;
    updateItem(sqlite, item.id, "undone", null, undoneAt);
  }

  const status: ExecutionRunStatus = errorCount > 0 || warningCount > 0 ? "partial" : "undone";
  updateRun(sqlite, run.id, status, undoneAt);

  const refreshedRun = await getRun(run.id);

  if (!refreshedRun) {
    throw new Error(`Failed to reload execution run after undo: ${run.id}`);
  }

  return {
    runId: run.id,
    run: refreshedRun,
    warnings,
    restoredItemCount: undoneCount + warningCount,
    itemCount: items.length,
    undoneCount,
    warningCount,
    errorCount,
    status,
  };
}

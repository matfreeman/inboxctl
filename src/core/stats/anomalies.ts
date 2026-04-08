import { z } from "zod";
import type { AuditAction } from "../actions/audit.js";
import {
  getStatsSqlite,
  isLikelyAutomatedSenderAddress,
  isUserLabel,
  normalizeLimit,
} from "./common.js";
import { detectNewsletters } from "./newsletters.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const BULK_LABELS = new Set([
  "newsletter",
  "newsletters",
  "promotion",
  "promotions",
  "social",
]);

export const reviewCategorizedInputSchema = z.object({
  since: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
}).strict();

export interface CategorizedAnomaly {
  emailId: string;
  from: string;
  subject: string;
  date: string | null;
  assignedLabel: string;
  action: string;
  runId: string;
  severity: "high" | "medium";
  rule:
    | "rare_sender_archived"
    | "no_newsletter_signals_as_newsletter"
    | "personal_address_archived"
    | "low_volume_bulk_label"
    | "first_time_sender_archived";
  reason: string;
  undoAvailable: boolean;
}

export interface ReviewCategorizedResult {
  anomalies: CategorizedAnomaly[];
  totalReviewed: number;
  anomalyCount: number;
  summary: string;
}

interface ReviewCategorizedRow {
  emailId: string;
  sender: string | null;
  subject: string | null;
  date: number | null;
  listUnsubscribe: string | null;
  beforeLabelIds: string;
  afterLabelIds: string;
  appliedActions: string;
  runId: string;
  runStatus: string;
  runDryRun: number | null;
  runUndoneAt: number | null;
  itemUndoneAt: number | null;
  executedAt: number | null;
  detectionReason: string | null;
  totalFromSender: number | null;
}

function toIsoString(value: number | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseActions(raw: string): AuditAction[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AuditAction[]) : [];
  } catch {
    return [];
  }
}

function resolveSinceTimestamp(since: string | undefined): number {
  if (!since) {
    return Date.now() - 7 * DAY_MS;
  }

  const parsed = Date.parse(since);

  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid since value: ${since}`);
  }

  return parsed;
}

function isArchived(actions: AuditAction[], beforeLabelIds: string[], afterLabelIds: string[]): boolean {
  if (actions.some((action) => action.type === "archive")) {
    return true;
  }

  return beforeLabelIds.includes("INBOX") && !afterLabelIds.includes("INBOX");
}

function resolveAssignedLabel(
  actions: AuditAction[],
  beforeLabelIds: string[],
  afterLabelIds: string[],
): string | null {
  const labelAction = actions.find(
    (action): action is Extract<AuditAction, { type: "label"; label: string }> =>
      action.type === "label" && typeof action.label === "string" && action.label.trim().length > 0,
  );

  if (labelAction) {
    return labelAction.label.trim();
  }

  const beforeUserLabels = new Set(beforeLabelIds.filter(isUserLabel));
  const afterUserLabels = afterLabelIds.filter(isUserLabel);
  const addedLabel = afterUserLabels.find((label) => !beforeUserLabels.has(label));

  return addedLabel || afterUserLabels[0] || null;
}

function resolvePrimaryAction(actions: AuditAction[]): string {
  if (actions.some((action) => action.type === "archive")) {
    return "archive";
  }

  if (actions.some((action) => action.type === "label")) {
    return "label";
  }

  return actions[0]?.type || "unknown";
}

function summarizeReview(totalReviewed: number, anomalyCount: number, highCount: number, mediumCount: number): string {
  if (anomalyCount === 0) {
    return `Reviewed ${totalReviewed} recently categorised emails. Found no potential misclassifications.`;
  }

  const severityParts: string[] = [];

  if (highCount > 0) {
    severityParts.push(`${highCount} high severity`);
  }

  if (mediumCount > 0) {
    severityParts.push(`${mediumCount} medium`);
  }

  return `Reviewed ${totalReviewed} recently categorised emails. Found ${anomalyCount} potential misclassifications (${severityParts.join(", ")}).`;
}

function detectAnomaly(row: ReviewCategorizedRow): CategorizedAnomaly | null {
  const actions = parseActions(row.appliedActions);
  const beforeLabelIds = parseJsonArray(row.beforeLabelIds);
  const afterLabelIds = parseJsonArray(row.afterLabelIds);
  const archived = isArchived(actions, beforeLabelIds, afterLabelIds);
  const assignedLabel = resolveAssignedLabel(actions, beforeLabelIds, afterLabelIds);
  const action = resolvePrimaryAction(actions);
  const totalFromSender = row.totalFromSender ?? 0;
  const hasNewsletterSignals = Boolean(row.detectionReason) || Boolean(row.listUnsubscribe?.trim());
  const isBulkLabel = assignedLabel ? BULK_LABELS.has(assignedLabel.toLowerCase()) : false;
  const automatedSender = isLikelyAutomatedSenderAddress(row.sender || "");
  const undoAvailable =
    row.runDryRun !== 1 &&
    row.runStatus !== "undone" &&
    row.runUndoneAt === null &&
    row.itemUndoneAt === null;

  if (archived && totalFromSender <= 3) {
    return {
      emailId: row.emailId,
      from: row.sender || "",
      subject: row.subject || "",
      date: toIsoString(row.date),
      assignedLabel: assignedLabel || "Unlabeled",
      action,
      runId: row.runId,
      severity: "high",
      rule: "rare_sender_archived",
      reason: `Archived email from a rare sender with only ${totalFromSender} total email${totalFromSender === 1 ? "" : "s"}. Rare senders should be reviewed before archiving.`,
      undoAvailable,
    };
  }

  if (isBulkLabel && !hasNewsletterSignals) {
    return {
      emailId: row.emailId,
      from: row.sender || "",
      subject: row.subject || "",
      date: toIsoString(row.date),
      assignedLabel: assignedLabel || "Unlabeled",
      action,
      runId: row.runId,
      severity: "high",
      rule: "no_newsletter_signals_as_newsletter",
      reason: `Labeled as ${assignedLabel} but sender has no List-Unsubscribe header and no newsletter detection signals. Sender has only sent ${totalFromSender} total email${totalFromSender === 1 ? "" : "s"}.`,
      undoAvailable,
    };
  }

  if (archived && !automatedSender && totalFromSender < 5) {
    return {
      emailId: row.emailId,
      from: row.sender || "",
      subject: row.subject || "",
      date: toIsoString(row.date),
      assignedLabel: assignedLabel || "Unlabeled",
      action,
      runId: row.runId,
      severity: "high",
      rule: "personal_address_archived",
      reason: `Archived email from a likely personal sender address with fewer than 5 total emails. This address does not look automated and should stay visible.`,
      undoAvailable,
    };
  }

  if (isBulkLabel && totalFromSender < 5) {
    return {
      emailId: row.emailId,
      from: row.sender || "",
      subject: row.subject || "",
      date: toIsoString(row.date),
      assignedLabel: assignedLabel || "Unlabeled",
      action,
      runId: row.runId,
      severity: "medium",
      rule: "low_volume_bulk_label",
      reason: `Labeled as ${assignedLabel} even though the sender has only ${totalFromSender} total email${totalFromSender === 1 ? "" : "s"}. Bulk labels are safer for higher-volume senders.`,
      undoAvailable,
    };
  }

  if (archived && totalFromSender === 1) {
    return {
      emailId: row.emailId,
      from: row.sender || "",
      subject: row.subject || "",
      date: toIsoString(row.date),
      assignedLabel: assignedLabel || "Unlabeled",
      action,
      runId: row.runId,
      severity: "medium",
      rule: "first_time_sender_archived",
      reason: "Archived an email from a first-time sender. First-time senders are better surfaced for review before cleanup.",
      undoAvailable,
    };
  }

  return null;
}

export async function reviewCategorized(
  options: z.input<typeof reviewCategorizedInputSchema> = {},
): Promise<ReviewCategorizedResult> {
  const parsed = reviewCategorizedInputSchema.parse(options);
  await detectNewsletters();

  const sqlite = getStatsSqlite();
  const sinceTimestamp = resolveSinceTimestamp(parsed.since);
  const limit = Math.min(200, normalizeLimit(parsed.limit, 50));

  const rows = sqlite
    .prepare(
      `
      SELECT
        ei.email_id AS emailId,
        e.from_address AS sender,
        e.subject AS subject,
        e.date AS date,
        e.list_unsubscribe AS listUnsubscribe,
        ei.before_label_ids AS beforeLabelIds,
        ei.after_label_ids AS afterLabelIds,
        ei.applied_actions AS appliedActions,
        ei.executed_at AS executedAt,
        ei.undone_at AS itemUndoneAt,
        ei.run_id AS runId,
        er.status AS runStatus,
        er.dry_run AS runDryRun,
        er.undone_at AS runUndoneAt,
        ns.detection_reason AS detectionReason,
        sender_stats.totalFromSender AS totalFromSender
      FROM execution_items AS ei
      INNER JOIN emails AS e
        ON e.id = ei.email_id
      INNER JOIN execution_runs AS er
        ON er.id = ei.run_id
      LEFT JOIN newsletter_senders AS ns
        ON LOWER(ns.email) = LOWER(e.from_address)
      LEFT JOIN (
        SELECT
          LOWER(from_address) AS senderKey,
          COUNT(*) AS totalFromSender
        FROM emails
        WHERE from_address IS NOT NULL
          AND TRIM(from_address) <> ''
        GROUP BY LOWER(from_address)
      ) AS sender_stats
        ON sender_stats.senderKey = LOWER(e.from_address)
      WHERE ei.status = 'applied'
        AND er.status IN ('applied', 'partial')
        AND COALESCE(er.dry_run, 0) = 0
        AND er.undone_at IS NULL
        AND ei.undone_at IS NULL
        AND COALESCE(ei.executed_at, 0) >= ?
      ORDER BY COALESCE(ei.executed_at, 0) DESC, ei.email_id ASC
      `,
    )
    .all(sinceTimestamp) as ReviewCategorizedRow[];

  const reviewedRows = rows.filter((row) => {
    const actions = parseActions(row.appliedActions);
    const beforeLabelIds = parseJsonArray(row.beforeLabelIds);
    const afterLabelIds = parseJsonArray(row.afterLabelIds);

    return (
      actions.length > 0 &&
      (
        resolveAssignedLabel(actions, beforeLabelIds, afterLabelIds) !== null ||
        isArchived(actions, beforeLabelIds, afterLabelIds)
      )
    );
  });

  const anomalies = reviewedRows
    .map((row) => detectAnomaly(row))
    .filter((anomaly): anomaly is CategorizedAnomaly => anomaly !== null)
    .sort((left, right) =>
      (left.severity === "high" ? 1 : 0) === (right.severity === "high" ? 1 : 0)
        ? (right.date || "").localeCompare(left.date || "") || left.emailId.localeCompare(right.emailId)
        : left.severity === "high" ? -1 : 1,
    );

  const highCount = anomalies.filter((anomaly) => anomaly.severity === "high").length;
  const mediumCount = anomalies.filter((anomaly) => anomaly.severity === "medium").length;

  return {
    anomalies: anomalies.slice(0, limit),
    totalReviewed: reviewedRows.length,
    anomalyCount: anomalies.length,
    summary: summarizeReview(reviewedRows.length, anomalies.length, highCount, mediumCount),
  };
}

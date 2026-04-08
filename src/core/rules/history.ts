import { getRun, getRunItems, getRecentRuns, getRunsByRule } from "../actions/audit.js";

export async function getExecutionHistory(ruleId?: string, limit: number = 20) {
  const runs = ruleId ? await getRunsByRule(ruleId) : await getRecentRuns(limit);
  return runs.slice(0, limit);
}

export async function getExecutionRun(runId: string) {
  const run = await getRun(runId);

  if (!run) {
    return null;
  }

  return {
    run,
    items: await getRunItems(runId),
  };
}

export async function getExecutionRunItems(runId: string) {
  return getRunItems(runId);
}

export async function getExecutionStats(ruleId?: string) {
  const runs = ruleId ? await getRunsByRule(ruleId) : await getRecentRuns(10_000);

  return {
    totalRuns: runs.length,
    plannedRuns: runs.filter((run) => run.status === "planned").length,
    appliedRuns: runs.filter((run) => run.status === "applied").length,
    partialRuns: runs.filter((run) => run.status === "partial").length,
    errorRuns: runs.filter((run) => run.status === "error").length,
    undoneRuns: runs.filter((run) => run.status === "undone").length,
    lastExecutionAt: runs[0]?.createdAt ?? null,
  };
}

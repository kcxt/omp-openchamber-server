/** omp's goal mode: its wire snapshot and what its transcript records. */
import type { BackendGoalSnapshot } from "../shared/types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A goal as omp sends it (`get_state.goal.goal`, `goal_updated.goal`) or journals it; null when it is none. */
export function parseGoal(value: unknown): BackendGoalSnapshot | null {
  const goal = record(value);
  const status = goal?.status;
  if (status !== "active" && status !== "paused" && status !== "complete" && status !== "budget-limited" && status !== "dropped") return null;
  return {
    status,
    objective: typeof goal!.objective === "string" ? goal!.objective : "",
    tokensUsed: typeof goal!.tokensUsed === "number" ? goal!.tokensUsed : 0,
    ...(typeof goal!.tokenBudget === "number" ? { tokenBudget: goal!.tokenBudget } : {}),
  };
}

/**
 * The goal a transcript ends with. omp journals every goal change as a
 * `mode_change` (`goal` / `goal_paused` carry the goal, `none` ends it) and a
 * completion as `none` followed by a `goal-completed` custom entry.
 */
export async function readTranscriptGoal(sessionPath: string): Promise<BackendGoalSnapshot | null> {
  let text: string;
  try {
    text = await Bun.file(sessionPath).text();
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"mode_change"') && !line.includes('"goal-completed"')) continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue; // partial line
    }
    if (entry?.type === "custom" && entry.customType === "goal-completed") {
      return parseGoal({ ...record(entry.data), status: "complete" });
    }
    if (entry?.type !== "mode_change") continue;
    if (entry.mode === "none") return null;
    if (entry.mode === "goal" || entry.mode === "goal_paused") return parseGoal(record(entry.data)?.goal);
  }
  return null;
}

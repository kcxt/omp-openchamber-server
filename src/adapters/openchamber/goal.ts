/**
 * OpenChamber's goal mode, served by omp's own goal.
 *
 * OpenChamber keeps a goal in session metadata (`openchamber.goal`) and runs a
 * server-side loop that, at every idle, asks a small model whether the goal is
 * done and re-prompts the session. omp has its own goal: the agent ends it by
 * calling the `goal` tool, and omp itself continues turns while it is active.
 * The sidecar maps OpenChamber's goal records onto omp's goal and keeps the
 * session busy until omp settles it, so OpenChamber's loop (which only acts on
 * an idle session with an active goal) never runs its audit or sends a prompt.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendGoalSnapshot } from "../../providers/types";

export interface OcGoal {
  id: string;
  status: string;
  objective?: string;
  objectiveFile?: boolean;
  tokenBudget?: number | null;
  tokensUsed?: number;
  statusReason?: string;
}

export type GoalChange =
  | { op: "start"; objective: string; tokenBudget?: number }
  | { op: "resume"; objective: string; tokenBudget?: number }
  | { op: "pause" }
  | { op: "drop" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function ocGoalOf(metadata: unknown): OcGoal | undefined {
  const goal = asRecord(asRecord(asRecord(metadata)?.openchamber)?.goal);
  if (!goal || typeof goal.id !== "string" || typeof goal.status !== "string") return undefined;
  return goal as unknown as OcGoal;
}

/** What omp has to do for a metadata write that took the goal from `prev` to `next`. */
export function goalTransition(prev: OcGoal | undefined, next: OcGoal | undefined): "start" | "resume" | "pause" | "drop" | undefined {
  if (!next) return prev ? "drop" : undefined;
  if (next.status === "paused") return prev?.status === "active" ? "pause" : undefined;
  if (next.status !== "active") return undefined;
  if (prev?.id !== next.id) return "start";
  if (prev.status !== "active") return "resume";
  // OpenChamber's Resume stamps `statusReason: "resumed"` on a goal that is still active here.
  if (next.statusReason === "resumed" && prev.statusReason !== "resumed") return "resume";
  return undefined;
}

function goalsDir(): string {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR;
  return join(dataDir ? dataDir : join(process.env.HOME || homedir(), ".config", "openchamber"), "goals");
}

/** The objective text: the file OpenChamber wrote for the session, else the inline copy. */
export async function readGoalObjective(sessionID: string, goal: OcGoal): Promise<string> {
  if (goal.objectiveFile) {
    const text = await readFile(join(goalsDir(), `${sessionID}.md`), "utf8").catch(() => "");
    if (text.trim()) return text.trim();
  }
  return (goal.objective ?? "").trim();
}

export async function goalChangeFor(
  sessionID: string,
  prev: OcGoal | undefined,
  next: OcGoal | undefined,
): Promise<GoalChange | undefined> {
  const kind = goalTransition(prev, next);
  if (!kind) return undefined;
  if (kind === "pause" || kind === "drop") return { op: kind };
  const objective = await readGoalObjective(sessionID, next!);
  if (!objective) return undefined;
  const budget = typeof next!.tokenBudget === "number" && next!.tokenBudget > 0 ? { tokenBudget: next!.tokenBudget } : {};
  return { op: kind, objective, ...budget };
}

/**
 * The OpenChamber goal fields that mirror an omp goal change, or undefined when
 * the change does not settle or advance the goal. omp ending a goal (the agent
 * called the `goal` tool) is `complete`; omp has no "blocked" of its own.
 */
export function ocPatchForOmpGoal(goal: BackendGoalSnapshot | null): Partial<OcGoal> | undefined {
  if (!goal) return undefined;
  switch (goal.status) {
    case "complete":
      return { status: "complete", statusReason: "reported by agent", tokensUsed: goal.tokensUsed };
    case "budget-limited":
      return { status: "budgetLimited", statusReason: "token budget reached", tokensUsed: goal.tokensUsed };
    case "active":
      return { tokensUsed: goal.tokensUsed };
    default:
      return undefined;
  }
}

/** `metadata` with the goal's fields replaced, or null when the session has no goal in a state to change. */
export function withGoalPatch(metadata: Record<string, unknown> | undefined, patch: Partial<OcGoal>): Record<string, unknown> | null {
  const goal = ocGoalOf(metadata);
  if (!goal || (goal.status !== "active" && goal.status !== "paused")) return null;
  const openchamber = asRecord(metadata?.openchamber) ?? {};
  return { openchamber: { ...openchamber, goal: { ...goal, ...patch, updatedAt: Date.now() } } };
}

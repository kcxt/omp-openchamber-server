import type { SidecarReason } from './sidecar';

// The sidecar's GET /api/omp/goal/:sessionId answer, cut down to what the Goal view draws.

export const GOAL_STATUSES = ['active', 'paused', 'complete', 'budget-limited', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type Goal = { status: GoalStatus; objective: string; tokensUsed: number; tokenBudget: number | null };

export type GoalNotFoundReason = SidecarReason;

export type GoalReport =
  | { status: 'ok'; live: boolean; goal: Goal | null }
  | { status: 'not-found'; reason: GoalNotFoundReason };

/** The fields of the sidecar's answer this view reads. */
export type SidecarGoal = { live?: unknown; goal?: unknown };

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function buildGoalReport(answer: SidecarGoal): GoalReport {
  const live = answer.live === true;
  const raw = answer.goal;
  if (!raw || typeof raw !== 'object') return { status: 'ok', live, goal: null };
  const { status, objective, tokensUsed, tokenBudget } = raw as Record<string, unknown>;
  if (!GOAL_STATUSES.includes(status as GoalStatus)) return { status: 'ok', live, goal: null };
  const budget = finite(tokenBudget);
  return {
    status: 'ok',
    live,
    goal: {
      status: status as GoalStatus,
      objective: typeof objective === 'string' ? objective : '',
      tokensUsed: finite(tokensUsed) ?? 0,
      tokenBudget: budget !== null && budget > 0 ? budget : null,
    },
  };
}

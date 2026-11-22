import type { SidecarReason } from './sidecar';

// The sidecar's GET /api/session-todos/:sessionId answer (omp's todo list), cut down to what the Tasks view draws.

export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = { content: string; status: TaskStatus };

export type TasksNotFoundReason = SidecarReason;

export type TasksReport =
  | { status: 'ok'; tasks: Task[] }
  | { status: 'not-found'; reason: TasksNotFoundReason };

/** The fields of the sidecar's answer this view reads. */
export type SidecarTodos = { todos?: unknown };

export function buildTasksReport(answer: SidecarTodos): TasksReport {
  const tasks: Task[] = [];
  if (Array.isArray(answer.todos)) {
    for (const item of answer.todos) {
      if (!item || typeof item !== 'object') continue;
      const { content, status } = item as Record<string, unknown>;
      if (typeof content !== 'string' || content === '') continue;
      tasks.push({ content, status: TASK_STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : 'pending' });
    }
  }
  return { status: 'ok', tasks };
}

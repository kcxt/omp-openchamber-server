import type { Task, TaskStatus, TasksReport } from '../service/tasks';
import type { Messages } from './i18n';
import { icon } from './icons';
import { el } from './view';

type Report = Extract<TasksReport, { status: 'ok' }>;

// The rows of OpenChamber's work-status "Tasks" section (WorkStatusTasksSection.tsx), redrawn: open ones
// first, cancelled hidden. Returns the `done/total` the section heading shows.
const STATUS_RANK: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };

export function renderTasks(root: HTMLElement, report: Report, m: Messages): string | undefined {
  const tasks = report.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status !== 'cancelled')
    .sort((a, b) => STATUS_RANK[a.task.status] - STATUS_RANK[b.task.status] || a.index - b.index)
    .map(({ task }) => task);

  if (tasks.length === 0) {
    const box = el('div', 'cx-goal-empty');
    box.append(el('div', 'cx-goal-empty-title', m.tasks.emptyTitle), el('div', 'cx-caption', m.tasks.emptyBody));
    root.append(box);
    return undefined;
  }

  const list = el('div', 'cx-ws-list');
  list.append(...tasks.map((task) => row(task, m)));
  root.append(list);
  return `${tasks.filter((task) => task.status === 'completed').length}/${tasks.length}`;
}

function row(task: Task, m: Messages): HTMLElement {
  const node = el('div', 'cx-ws-row');
  node.title = `${m.tasks.status[task.status]}: ${task.content}`;
  const lead = el('span', 'cx-ws-lead');
  lead.dataset.status = task.status;
  lead.append(icon(task.status, 'cx-task-icon'));
  const label = el('span', task.status === 'completed' ? 'cx-ws-label cx-ws-done' : 'cx-ws-label', task.content);
  label.dir = 'auto';
  node.append(lead, label);
  return node;
}

export const TASKS_STYLES = `
  .cx-ws-list { max-height: 18rem; overflow-y: auto; }
  .cx-ws-lead { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 15px; height: 15px; }
  .cx-ws-lead[data-status="in_progress"] { color: var(--oc-info); }
  .cx-ws-lead[data-status="completed"] { color: var(--oc-success); }
  .cx-task-icon { width: 15px; height: 15px; }
  .cx-ws-row { display: flex; align-items: center; gap: 0.5rem; height: 1.875rem; padding: 0 0.25rem; border-radius: 6px; color: var(--oc-muted); }
  .cx-ws-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9375rem; }
  .cx-ws-done { text-decoration: line-through; }
`;

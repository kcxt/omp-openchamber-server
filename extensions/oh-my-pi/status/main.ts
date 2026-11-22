import { connectHost } from '@openchamber/sdk';
import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import { applyHostReady, mountEmpty, mountSpinner } from '@openchamber/sdk/ui';

import type { ContextReport } from '../service/breakdown';
import type { GoalReport } from '../service/goal';
import type { TasksReport } from '../service/tasks';
import { GOAL_STYLES, renderGoal } from './goal';
import { icon } from './icons';
import type { IconName } from './icons';
import { TASKS_STYLES, renderTasks } from './tasks';
import { STYLES, el, renderReport, setLocale } from './view';
import type { Messages } from './i18n';

/** What a view paints: its body (and an optional count for its tab), or an empty state. */
type View = { signature: string; draw: (body: HTMLElement) => string | undefined } | { empty: [string, string?] };

type Section = {
  id: 'goal' | 'tasks' | 'context';
  icon: IconName;
  /** Goal and tasks change mid-turn and the host has no event for them: they are polled while shown. */
  polled: boolean;
  loading: (m: Messages) => string;
  /** Reads this view's route through the panel service and turns the answer into a view. */
  fetch: (session: SessionSnapshot) => Promise<View>;
};

const POLL_MS = 2000;

const root = document.querySelector<HTMLElement>('#root')!;
let host: HostClient;
let session: SessionSnapshot | null = null;
let directory: string | null = null;
let shownKey: string | null = null;
let shownLocale: string | undefined;
let m: Messages = setLocale(undefined);
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function post<T>(path: string, forSession: SessionSnapshot): Promise<T> {
  const result = await host.serviceRequest({ method: 'POST', path, body: JSON.stringify({ sessionId: forSession.id, directory }) });
  return JSON.parse(result.body) as T;
}

// One panel, one tab per view, in this order. A new omp-only view is an entry here plus a service route.
const SECTIONS: Section[] = [
  {
    id: 'goal',
    icon: 'goal',
    polled: true,
    loading: (words) => words.goal.loading,
    async fetch(forSession) {
      const report = await post<GoalReport>('/goal', forSession);
      if (report.status !== 'ok') return { empty: [m.sections.goal, m.goal.reasons[report.reason] ?? m.goal.reasons.failed] };
      return { signature: JSON.stringify(report), draw: (body) => void renderGoal(body, report, m) };
    },
  },
  {
    id: 'tasks',
    icon: 'tasks',
    polled: true,
    loading: (words) => words.tasks.loading,
    async fetch(forSession) {
      const report = await post<TasksReport>('/tasks', forSession);
      if (report.status !== 'ok') return { empty: [m.sections.tasks, m.tasks.reasons[report.reason] ?? m.tasks.reasons.failed] };
      return { signature: JSON.stringify(report), draw: (body) => renderTasks(body, report, m) };
    },
  },
  {
    id: 'context',
    icon: 'context',
    polled: false,
    loading: (words) => words.empty.loading,
    async fetch(forSession) {
      const report = await post<ContextReport>('/context', forSession);
      if (report.status === 'no-turn') return { empty: m.empty.noTurn };
      if (report.status !== 'ok') return { empty: [m.empty.notFound, m.empty.reasons[report.reason] ?? m.empty.reasons.failed] };
      return { signature: '', draw: (body) => void renderReport(body, report) };
    },
  },
];

type Mounted = {
  section: Section;
  tab: HTMLButtonElement;
  label: HTMLElement;
  count: HTMLElement;
  /** Only the latest request may paint: an answer for a session or tab left behind is dropped. */
  request: number;
  signature: string | null;
};

const content = el('div', 'cx-content');
const mounted: Mounted[] = SECTIONS.map((section) => {
  const tab = el('button', 'cx-tab');
  tab.type = 'button';
  tab.setAttribute('role', 'tab');
  const label = el('span', 'cx-tab-label');
  const count = el('span', 'cx-tab-count');
  tab.append(icon(section.icon, 'cx-tab-icon'), label, count);
  const state: Mounted = { section, tab, label, count, request: 0, signature: null };
  tab.addEventListener('click', () => select(state));
  return state;
});
let active: Mounted = mounted[0]!;

function boot() {
  const style = document.createElement('style');
  style.textContent = STYLES + GOAL_STYLES + TASKS_STYLES;
  document.head.append(style);
  // The host sizes the frame to the content, up to its own maximum.
  let reported = -1;
  new ResizeObserver(() => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === reported) return;
    reported = height;
    void host.setHeight(height).catch(() => undefined);
  }).observe(root);

  const bar = el('nav', 'cx-tabs');
  bar.setAttribute('role', 'tablist');
  bar.append(...mounted.map((state) => state.tab));
  root.append(bar, content);
  labelTabs();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshPolled();
  });

  host = connectHost();
  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    directory = context.directory;
    // A language change redraws: the same session would otherwise keep its old words.
    if (context.locale !== shownLocale) {
      shownLocale = context.locale;
      m = setLocale(context.locale);
      document.documentElement.lang = context.locale || 'en';
      labelTabs();
      shownKey = null;
    }
    // A turn ends when `busy` goes back to false: that is when the context numbers move. The polled
    // views are read again here too, not only on their timer.
    const key = context.session ? `${context.session.id}|${context.session.busy}` : '';
    if (key === shownKey) return;
    shownKey = key;
    const changed = context.session?.id !== session?.id;
    session = context.session;
    if (changed) for (const state of mounted) clearCount(state);
    show(changed);
  });
}

function labelTabs() {
  for (const state of mounted) {
    state.label.textContent = m.sections[state.section.id];
    state.tab.setAttribute('aria-selected', String(state === active));
  }
}

function select(next: Mounted) {
  if (next === active) return;
  active = next;
  labelTabs();
  show(true);
}

function clearCount(state: Mounted) {
  state.count.textContent = '';
  state.signature = null;
}

/** Paints the active tab for the open session. `fresh`: start from a spinner. */
function show(fresh: boolean) {
  clearInterval(pollTimer);
  pollTimer = undefined;
  if (!session) {
    active.request++;
    paintEmpty(active, m.empty.noSession);
    return;
  }
  void load(active, session, fresh);
  if (active.section.polled) pollTimer = setInterval(refreshPolled, POLL_MS);
}

function refreshPolled() {
  if (!session || !active.section.polled || document.visibilityState !== 'visible') return;
  void load(active, session, false);
}

async function load(state: Mounted, forSession: SessionSnapshot, fresh: boolean) {
  const request = ++state.request;
  // A new session or tab starts on a spinner; the same one keeps its numbers until the new ones arrive.
  if (fresh || !content.hasChildNodes()) {
    state.signature = null;
    content.replaceChildren();
    mountSpinner(content, { size: 'sm', label: state.section.loading(m) });
  }
  let view: View;
  try {
    view = await state.section.fetch(forSession);
  } catch {
    view = { empty: [m.sections[state.section.id], m.empty.unreachable] };
  }
  if (request !== state.request || state !== active) return;
  if ('empty' in view) {
    paintEmpty(state, view.empty);
    return;
  }
  // An unchanged answer is not repainted, so the page neither flickers nor loses its scroll.
  if (view.signature !== '' && view.signature === state.signature && content.hasChildNodes()) return;
  state.signature = view.signature || null;
  content.replaceChildren();
  state.count.textContent = view.draw(content) ?? '';
}

function paintEmpty(state: Mounted, [title, body]: [string, string?]) {
  state.signature = null;
  state.count.textContent = '';
  content.replaceChildren();
  mountEmpty(content, body ? { title, body } : { title });
}

boot();

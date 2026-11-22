import { connectHost } from '@openchamber/sdk';
import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import { applyHostReady, mountEmpty } from '@openchamber/sdk/ui';

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
  /** Shape of the empty layout drawn before the first answer: heights in rem. */
  skeleton: number[];
  /** Least time between two reads; the poll retries until it has passed. */
  minMs: number;
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
    skeleton: [8],
    icon: 'goal',
    polled: true,
    minMs: 1500,
    async fetch(forSession) {
      const report = await post<GoalReport>('/goal', forSession);
      if (report.status !== 'ok') return { empty: [m.sections.goal, m.goal.reasons[report.reason] ?? m.goal.reasons.failed] };
      return { signature: JSON.stringify(report), draw: (body) => void renderGoal(body, report, m) };
    },
  },
  {
    id: 'tasks',
    skeleton: [1.6, 1.6, 1.6],
    icon: 'tasks',
    polled: true,
    minMs: 1500,
    async fetch(forSession) {
      const report = await post<TasksReport>('/tasks', forSession);
      if (report.status !== 'ok') return { empty: [m.sections.tasks, m.tasks.reasons[report.reason] ?? m.tasks.reasons.failed] };
      return { signature: JSON.stringify(report), draw: (body) => renderTasks(body, report, m) };
    },
  },
  {
    id: 'context',
    skeleton: [6, 1.2, 1.2, 1.2, 1.2],
    icon: 'context',
    polled: false,
    minMs: 12_000,
    async fetch(forSession) {
      const report = await post<ContextReport>('/context', forSession);
      if (report.status === 'no-turn') return { empty: m.empty.noTurn };
      if (report.status !== 'ok') return { empty: [m.empty.notFound, m.empty.reasons[report.reason] ?? m.empty.reasons.failed] };
      return { signature: JSON.stringify(report), draw: (body) => void renderReport(body, report) };
    },
  },
];

type Mounted = {
  section: Section;
  tab: HTMLButtonElement;
  label: HTMLElement;
  count: HTMLElement;
};

const content = el('div', 'cx-content');
const mounted: Mounted[] = SECTIONS.map((section) => {
  const tab = el('button', 'cx-tab');
  tab.type = 'button';
  tab.setAttribute('role', 'tab');
  const label = el('span', 'cx-tab-label');
  const count = el('span', 'cx-tab-count');
  tab.append(icon(section.icon, 'cx-tab-icon'), label, count);
  const state: Mounted = { section, tab, label, count };
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
  document.addEventListener('visibilitychange', tick);

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
      shown = null;
    }
    // A turn ends when `busy` goes back to false: that is when the context numbers move. The polled
    // views are read again here too, not only on their timer.
    const key = context.session ? `${context.session.id}|${context.session.busy}` : '';
    if (key === shownKey) return;
    shownKey = key;
    const changed = context.session?.id !== session?.id;
    session = context.session;
    for (const state of mounted) request(state);
    render(changed);
    ensurePoll();
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
  request(next);
  render(true);
}

// In memory only, per session and view: what was last read, shown at once while a read refreshes it.
type Entry = { view?: View; count: string; at: number; inflight: boolean; wanted: boolean };
const cache = new Map<string, Entry>();
const entryOf = (state: Mounted, id: string): Entry => {
  const key = `${id}|${state.section.id}`;
  let entry = cache.get(key);
  if (!entry) cache.set(key, (entry = { count: '', at: 0, inflight: false, wanted: false }));
  return entry;
};
let shown: string | null = null;

/** Asks for a read of `state` for the open session; the poll starts it once the rate limit allows. */
function request(state: Mounted) {
  if (!session) return;
  entryOf(state, session.id).wanted = true;
  refresh(state);
}

function refresh(state: Mounted) {
  if (!session || document.visibilityState !== 'visible') return;
  const forSession = session;
  const entry = entryOf(state, forSession.id);
  if (entry.inflight || !(state.section.polled || entry.wanted)) return;
  if (Date.now() - entry.at < state.section.minMs) return;
  entry.inflight = true;
  entry.wanted = false;
  void state.section
    .fetch(forSession)
    .then((view) => {
      entry.view = view;
    })
    .catch(() => {
      // Keep what is shown; with nothing yet, say the service does not answer.
      entry.view ??= { empty: [m.sections[state.section.id], m.empty.unreachable] };
    })
    .finally(() => {
      entry.inflight = false;
      entry.at = Date.now();
      if (state === active && session?.id === forSession.id) render(false);
    });
}

/** Runs every 2 s while visible: the cheap views read again, an asked-for one once its limit has passed. */
function tick() {
  for (const state of mounted) refresh(state);
}

function ensurePoll() {
  pollTimer ??= setInterval(tick, POLL_MS);
}

/** Paints the active tab from the cache, or the empty layout before the first answer. `reset`: repaint even if unchanged. */
function render(reset: boolean) {
  if (!session) {
    shown = null;
    active.count.textContent = '';
    content.replaceChildren();
    mountEmpty(content, { title: m.empty.noSession[0], body: m.empty.noSession[1] });
    return;
  }
  const entry = entryOf(active, session.id);
  const view = entry.view;
  if (!view) {
    shown = `${session.id}|${active.section.id}|blank`;
    content.replaceChildren(...active.section.skeleton.map((rem) => {
      const bar = el('div', 'cx-skel');
      bar.style.height = `${rem}rem`;
      return bar;
    }));
    active.count.textContent = '';
    return;
  }
  const signature = `${session.id}|${active.section.id}|${'empty' in view ? JSON.stringify(view.empty) : view.signature}`;
  if (!reset && signature === shown) return;
  shown = signature;
  content.replaceChildren();
  if ('empty' in view) {
    entry.count = '';
    mountEmpty(content, view.empty[1] ? { title: view.empty[0], body: view.empty[1] } : { title: view.empty[0] });
  } else {
    entry.count = view.draw(content) ?? '';
  }
  active.count.textContent = entry.count;
}

boot();

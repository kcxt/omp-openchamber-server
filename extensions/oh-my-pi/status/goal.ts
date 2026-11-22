import type { Goal, GoalReport, GoalStatus } from '../service/goal';
import type { Messages } from './i18n';
import { el, formatTokens } from './view';

type Report = Extract<GoalReport, { status: 'ok' }>;

// The header card's tone variables (view.ts) pick the colors; a status only chooses the tone.
const TONE: Record<GoalStatus, string> = {
  active: '',
  paused: 'warning',
  complete: 'success',
  'budget-limited': 'error',
  dropped: 'muted',
};

const COMMANDS = ['pause', 'resume', 'drop'] as const;

export function renderGoal(root: HTMLElement, report: Report, m: Messages) {
  if (report.goal) root.append(drawGoal(report.goal, report.live, m));
  else root.append(drawEmpty(m));
  root.append(drawCommands(m));
}

function drawGoal(goal: Goal, live: boolean, m: Messages): HTMLElement {
  const tone = TONE[goal.status];
  const card = el('header', 'cx-header');
  if (tone) card.dataset.tone = tone;

  const top = el('div', 'cx-head-top');
  const badge = el('span', 'cx-badge', m.goal.status[goal.status]);
  badge.dataset.status = goal.status;
  const source = el('span', 'cx-pill', live ? m.goal.live : m.goal.transcript);
  source.dataset.tone = live ? 'success' : '';
  source.title = live ? m.goal.liveHint : m.goal.transcriptHint;
  source.prepend(el('span', 'cx-pill-dot'));
  top.append(badge, source);
  card.append(top);

  card.append(el('div', 'cx-caption', m.goal.objective), el('div', 'cx-objective', goal.objective));

  const used = formatTokens(goal.tokensUsed);
  if (goal.tokenBudget === null) {
    card.append(el('div', 'cx-usage', m.goal.tokensNoBudget(used)));
    return card;
  }

  const budget = goal.tokenBudget;
  const percent = Math.min(100, (goal.tokensUsed / budget) * 100);
  card.append(el('div', 'cx-usage', m.goal.tokens(used, formatTokens(budget))));
  const meter = el('div', 'cx-meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(budget));
  meter.setAttribute('aria-valuenow', String(goal.tokensUsed));
  meter.setAttribute('aria-label', m.goal.tokens(used, formatTokens(budget)));
  const blocks = el('div', 'cx-meter-blocks');
  const fill = el('span', 'cx-block cx-goal-fill');
  fill.style.width = `${percent}%`;
  blocks.append(fill);
  meter.append(blocks);
  card.append(meter);
  const scale = el('div', 'cx-meter-scale', m.goal.budgetLeft(formatTokens(Math.max(0, budget - goal.tokensUsed))));
  card.append(scale);
  return card;
}

function drawEmpty(m: Messages): HTMLElement {
  const box = el('div', 'cx-goal-empty');
  box.append(el('div', 'cx-goal-empty-title', m.goal.emptyTitle), el('div', 'cx-caption', m.goal.emptyBody));
  return box;
}

function drawCommands(m: Messages): HTMLElement {
  const section = el('section', 'cx-group');
  section.append(el('div', 'cx-group-heading', m.goal.commands));
  for (const name of COMMANDS) {
    const row = el('div', 'cx-command');
    row.append(el('code', 'cx-code', `/goal ${name}`), el('span', 'cx-caption', m.goal.commandHelp[name]));
    section.append(row);
  }
  return section;
}

export const GOAL_STYLES = `
  .cx-badge { display: inline-flex; align-items: center; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: var(--cx-tone-text); background: color-mix(in srgb, var(--cx-tone) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cx-tone) 40%, transparent); }
  .cx-badge[data-status="complete"] { --cx-tone: var(--oc-success); --cx-tone-text: var(--oc-success-text, var(--oc-success)); }
  .cx-badge[data-status="dropped"] { --cx-tone: var(--oc-muted); --cx-tone-text: var(--oc-muted); }
  .cx-header[data-tone="success"] { --cx-tone: var(--oc-success); --cx-tone-text: var(--oc-success-text, var(--oc-success)); }
  .cx-header[data-tone="muted"] { --cx-tone: var(--oc-muted); --cx-tone-text: var(--oc-muted); }
  .cx-objective { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12rem; overflow: auto; }
  .cx-goal-fill { background: var(--cx-tone); }
  .cx-goal-empty { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.9rem 0.7rem; border-radius: 8px; background: color-mix(in srgb, var(--oc-muted) 8%, transparent); }
  .cx-goal-empty-title { font-weight: 600; }
  .cx-command { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.2rem 0.35rem; }
  .cx-code { font-family: var(--oc-mono, ui-monospace, monospace); font-size: 0.75rem; padding: 0.05rem 0.35rem; border-radius: 4px; background: color-mix(in srgb, var(--oc-muted) 14%, transparent); }
`;

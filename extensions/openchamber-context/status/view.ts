import type { Category, CategoryId, ContextReport } from '../service/breakdown';
import { messagesFor } from './i18n';
import type { Messages } from './i18n';

export type Report = Extract<ContextReport, { status: 'ok' }>;

const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;
const CHART_HEIGHT = 32;

// The host's language: words from its catalog, numbers in its format. English until it says.
let m: Messages = messagesFor('en').messages;
let numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
let percentFormat = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });

export function setLocale(hostLocale: string | undefined): Messages {
  const chosen = messagesFor(hostLocale);
  m = chosen.messages;
  const locale = Intl.NumberFormat.supportedLocalesOf(chosen.locale)[0] ?? 'en';
  numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return m;
}

/** A category's name. */
const categoryLabel = (id: CategoryId): string => m.category[id];

/** What the model is given before anyone speaks, then what the conversation adds. */
const PROMPT_IDS: CategoryId[] = ['system', 'systemPrompt', 'systemTools', 'systemContext', 'instructionFiles', 'skills'];
const CONVERSATION_IDS: CategoryId[] = ['messages'];

const CATEGORY_COLORS: Record<CategoryId, string> = {
  system: 'color-mix(in srgb, var(--oc-muted) 75%, transparent)',
  systemPrompt: 'color-mix(in srgb, var(--oc-muted) 75%, transparent)',
  systemTools: 'color-mix(in srgb, var(--oc-info) 50%, var(--oc-success))',
  systemContext: 'color-mix(in srgb, var(--oc-muted) 50%, var(--oc-warning))',
  instructionFiles: 'var(--oc-warning)',
  skills: 'color-mix(in srgb, var(--oc-warning) 55%, var(--oc-success))',
  messages: 'var(--oc-primary)',
  free: 'transparent',
};

// The cache line counts down on its own; a new render replaces the timer.
let cacheTimer: ReturnType<typeof setInterval> | undefined;
const CACHE_TICK_MS = 30_000;

export function renderReport(root: HTMLElement, report: Report) {
  const percent = (report.total / report.limit) * 100;
  const tone = percent >= ERROR_PERCENT ? 'error' : percent >= WARNING_PERCENT ? 'warning' : '';
  const shown = report.categories.filter((category) => category.tokens > 0 && category.id !== 'free');
  const { compaction } = report;
  // Like /context: the room kept for compaction is not free to use.
  const reserve = Math.min(compaction.buffer ?? 0, Math.max(0, report.limit - report.total));
  const freeTokens = Math.max(0, report.limit - report.total - reserve);

  root.append(drawHeader(report, percent, tone, shown));

  const legend = el('div', 'cx-legend');
  legend.append(
    group(m.group.prompt, shown.filter((category) => PROMPT_IDS.includes(category.id)), report),
    group(m.group.conversation, shown.filter((category) => CONVERSATION_IDS.includes(category.id)), report),
  );
  const free = el('div', 'cx-row cx-row-free');
  free.append(el('span', 'cx-chevron'), swatch('free'), labelOf(m.category.free), ...numbers(freeTokens, report.limit));
  legend.append(free);
  if (reserve > 0) {
    const row = el('div', 'cx-row cx-row-free');
    row.append(el('span', 'cx-chevron'), swatch('reserve'), labelOf(m.category.reserve), ...numbers(reserve, report.limit));
    legend.append(row);
  }
  root.append(legend);

  const footer = el('footer', 'cx-footer');
  if (report.history.length > 1) {
    const trend = el('div', 'cx-trend');
    trend.append(el('div', 'cx-caption', m.trend(report.history.length)), drawHistory(report.history));
    footer.append(trend);
  }
  const facts = el('div', 'cx-facts');
  const lastCompaction = compaction.tokensBefore !== null && compaction.tokensAfter !== null
    ? ` (${m.facts.lastCompaction(formatTokens(compaction.tokensBefore), formatTokens(compaction.tokensAfter))})`
    : '';
  facts.append(
    ...(compaction.growth ? [fact(m.facts.growth, m.facts.perCall(formatTokens(compaction.growth)))] : []),
    fact(m.facts.cacheRead, `${formatTokens(report.cacheRead)} (${formatPercent((report.cacheRead / report.total) * 100)})`),
    fact(m.facts.cacheWrite, formatTokens(report.cacheWrite)),
    fact(m.facts.compactions, compaction.count === 0 ? m.facts.none : `${compaction.count}${lastCompaction}`),
  );
  footer.append(facts, el('div', 'cx-caption', report.categoriesFromOmp ? m.note.omp : m.note.transcript));
  root.append(footer);
}

/**
 * The top of the page: the share used, the model, a meter of the window with the compaction
 * threshold on it, then pills for what comes next: the cache, and compaction once it is due.
 */
function drawHeader(report: Report, percent: number, tone: string, shown: Category[]): HTMLElement {
  const { compaction } = report;
  const header = el('header', 'cx-header');
  if (tone) header.dataset.tone = tone;

  const top = el('div', 'cx-head-top');
  const figures = el('div', 'cx-figures');
  figures.append(el('span', 'cx-percent', formatPercent(percent)), el('span', 'cx-usage', m.tokensOf(formatTokens(report.total), formatTokens(report.limit))));
  top.append(figures);
  if (report.model) top.append(modelChip(report));
  header.append(top);

  // The bar is the whole window, one block per category in the legend's colors and order; the
  // hatched end is the reserve, and the tick where compaction starts.
  const meter = el('div', 'cx-meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(report.limit));
  meter.setAttribute('aria-valuenow', String(report.total));
  meter.setAttribute('aria-label', m.tokensOf(formatTokens(report.total), formatTokens(report.limit)));
  const share = (value: number) => `${Math.min(100, (value / report.limit) * 100)}%`;
  const reserve = el('span', 'cx-meter-reserve');
  if (compaction.threshold !== null) reserve.style.left = share(compaction.threshold);
  const blocks = el('div', 'cx-meter-blocks');
  for (const category of shown) {
    const block = swatch(category.id);
    block.className = 'cx-block';
    // A tiny category keeps a sliver, so every legend color shows on the bar.
    block.style.width = `max(3px, ${share(category.tokens)})`;
    block.title = `${categoryLabel(category.id)} · ${formatTokens(category.tokens)} (${formatPercent((category.tokens / report.limit) * 100)})`;
    blocks.append(block);
  }
  const tick = el('span', 'cx-meter-tick');
  if (compaction.threshold !== null) tick.style.left = share(compaction.threshold);
  else tick.hidden = reserve.hidden = true;
  meter.append(reserve, blocks, tick);
  header.append(meter);

  if (compaction.threshold !== null) {
    const scale = el('div', 'cx-meter-scale');
    scale.append(el('span', 'cx-meter-threshold', m.compaction.at(formatTokens(compaction.threshold))));
    header.append(scale);
  }

  const pills = el('div', 'cx-pills');
  const cache = el('span', 'cx-pill');
  pills.append(cache, compactionPill(report));
  header.append(pills);

  clearInterval(cacheTimer);
  const paintCache = () => paintCachePill(cache, report);
  paintCache();
  if (report.cache.lastTurnAt) cacheTimer = setInterval(paintCache, CACHE_TICK_MS);
  return header;
}

/** The model, with its provider (or the harness) in front when the id does not carry it. */
function modelChip(report: Report): HTMLElement {
  const model = report.model ?? '';
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : 'omp';
  const name = slash > 0 ? model.slice(slash + 1) : model;
  const chip = el('span', 'cx-model');
  chip.title = model;
  chip.append(el('span', 'cx-model-provider', provider), el('span', 'cx-model-name', name));
  return chip;
}

/** Shown only once the threshold is reached: the next call will compact. */
function compactionPill(report: Report): HTMLElement {
  const pill = el('span', 'cx-pill');
  const { threshold } = report.compaction;
  if (threshold === null || report.total < threshold) {
    pill.hidden = true;
    return pill;
  }
  pill.dataset.tone = 'warning';
  pill.append(el('span', 'cx-pill-dot'), el('span', '', m.compaction.imminent));
  pill.title = m.compaction.reached(formatTokens(threshold));
  return pill;
}

/** Whether the prompt cache is still warm: past its lifetime, the next message is billed in full. */
function paintCachePill(node: HTMLElement, report: Report) {
  const { lastTurnAt, ttlMs } = report.cache;
  if (!lastTurnAt) {
    node.hidden = true;
    return;
  }
  const elapsed = Date.now() - lastTurnAt;
  const lifetime = formatDuration(ttlMs);
  const cold = elapsed >= ttlMs;
  node.hidden = false;
  node.dataset.tone = cold ? 'warning' : 'success';
  node.replaceChildren(
    el('span', 'cx-pill-dot'),
    el('span', '', cold ? m.cache.coldShort(formatTokens(report.total)) : m.cache.warmShort(formatDuration(ttlMs - elapsed))),
  );
  node.title = cold ? m.cache.cold(formatDuration(elapsed), lifetime, formatTokens(report.total)) : m.cache.warm(formatDuration(ttlMs - elapsed), lifetime);
}

/** 45 s, 12 min, 1 h 05. */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return m.duration.seconds(Math.max(1, Math.round(ms / 1000)));
  if (minutes < 60) return m.duration.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return m.duration.days(Math.floor(hours / 24));
  return m.duration.hours(hours, String(minutes % 60).padStart(2, '0'));
}

/** A group heading with its subtotal, then one row per category. */
function group(name: string, categories: Category[], report: Report): HTMLElement {
  const section = el('section', 'cx-group');
  if (categories.length === 0) return section;
  const subtotal = categories.reduce((total, category) => total + category.tokens, 0);
  const heading = el('div', 'cx-group-heading');
  heading.append(el('span', '', name), el('span', 'cx-num', formatTokens(subtotal)));
  section.append(heading);
  for (const category of categories) section.append(categoryRow(category, report));
  return section;
}

function categoryRow(category: Category, report: Report): HTMLElement {
  const row = el('div', 'cx-row');
  row.append(el('span', 'cx-chevron'), swatch(category.id), labelOf(categoryLabel(category.id)), ...numbers(category.tokens, report.limit));

  // Pointing at a row lights its block on the bar.
  const highlight = (on: boolean) => {
    const blocks = document.querySelector('.cx-meter-blocks');
    blocks?.classList.toggle('cx-focus', on);
    blocks?.querySelector(`[data-id="${category.id}"]`)?.classList.toggle('cx-lit', on);
  };
  row.addEventListener('pointerenter', () => highlight(true));
  row.addEventListener('pointerleave', () => highlight(false));
  return row;
}

function labelOf(text: string): HTMLElement {
  const node = el('span', 'cx-label', text);
  node.title = text;
  return node;
}

function numbers(tokens: number, limit: number): HTMLElement[] {
  return [el('span', 'cx-num', formatTokens(tokens)), el('span', 'cx-num cx-share', formatPercent((tokens / limit) * 100))];
}

function fact(label: string, value: string): HTMLElement {
  const node = el('div', 'cx-fact');
  node.append(el('span', 'cx-caption', label), el('span', 'cx-fact-value', value));
  return node;
}

function swatch(id: CategoryId | 'reserve'): HTMLElement {
  const node = el('span', 'cx-swatch');
  node.dataset.id = id;
  if (id !== 'free' && id !== 'reserve') node.style.background = CATEGORY_COLORS[id];
  return node;
}

/** Context size at each turn, oldest first, from zero to the largest. */
function drawHistory(history: number[]): SVGSVGElement {
  const width = 100;
  const max = Math.max(...history) || 1;
  const step = width / (history.length - 1);
  const y = (value: number) => (CHART_HEIGHT - (value / max) * (CHART_HEIGHT - 2) - 1).toFixed(2);
  const points = history.map((value, index) => `${(index * step).toFixed(2)},${y(value)}`);
  const svg = svgEl('svg', { class: 'cx-history', viewBox: `0 0 ${width} ${CHART_HEIGHT}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(
    svgEl('polygon', { points: `0,${CHART_HEIGHT} ${points.join(' ')} ${width},${CHART_HEIGHT}`, fill: 'color-mix(in srgb, var(--oc-primary) 15%, transparent)' }),
    svgEl('polyline', { points: points.join(' '), fill: 'none', stroke: 'var(--oc-primary)', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke' }),
  );
  return svg;
}


/** 950, 1,2 k, 142 k, 1 M: the scale Claude Code's /context uses. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${numberFormat.format(tokens / 1_000_000)} M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)} k`;
  if (tokens >= 1000) return `${numberFormat.format(tokens / 1000)} k`;
  return String(tokens);
}

/** 0,2 %, 8 %, 88,2 % (8.4% in English); under 0.1 %, says so rather than 0 %. */
function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return `< ${percentFormat.format(0.001)}`;
  return percentFormat.format(percent / 100);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '', children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  node.append(...children);
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

export const STYLES = `
  html, body { margin: 0; background: transparent; }
  body { container-type: inline-size; color: var(--oc-fg); font-family: var(--oc-font, system-ui, sans-serif); }
  #root { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.5rem 0.75rem 0.75rem; font-size: 0.8125rem; line-height: 1.35; }
  .cx-caption { color: var(--oc-muted); font-size: 0.7rem; }
  .cx-num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }

  .cx-header { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.65rem 0.7rem 0.6rem; border-radius: 8px; background: color-mix(in srgb, var(--oc-muted) 8%, transparent); --cx-tone: var(--oc-primary); --cx-tone-text: var(--oc-fg); }
  .cx-header[data-tone="warning"] { --cx-tone: var(--oc-warning); --cx-tone-text: var(--oc-warning-text, var(--oc-warning)); }
  .cx-header[data-tone="error"] { --cx-tone: var(--oc-error); --cx-tone-text: var(--oc-error-text, var(--oc-error)); }
  .cx-head-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; }
  .cx-figures { display: flex; flex-direction: column; gap: 0.05rem; }
  .cx-percent { font-size: 1.6rem; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; color: var(--cx-tone-text); }
  .cx-usage { color: var(--oc-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .cx-model { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; border-radius: 999px; overflow: hidden; font-size: 0.7rem; box-shadow: inset 0 0 0 1px var(--oc-border); }
  .cx-model-provider { padding: 0.15rem 0.45rem; color: var(--oc-muted); background: color-mix(in srgb, var(--oc-muted) 12%, transparent); white-space: nowrap; }
  .cx-model-name { padding: 0.15rem 0.5rem; font-family: var(--oc-mono, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  .cx-meter { position: relative; height: 10px; border-radius: 3px; background: color-mix(in srgb, var(--oc-muted) 16%, transparent); margin-top: 0.25rem; }
  .cx-meter-blocks { position: absolute; inset: 0; display: flex; gap: 1px; overflow: hidden; border-radius: 3px; }
  .cx-block { flex: none; height: 100%; transition: opacity 120ms; }
  .cx-meter-blocks.cx-focus .cx-block:not(.cx-lit) { opacity: 0.25; }
  .cx-meter-reserve { position: absolute; top: 0; bottom: 0; right: 0; border-radius: 0 3px 3px 0; background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--oc-muted) 40%, transparent) 0 1px, transparent 1px 3px); }
  .cx-meter-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--oc-fg); opacity: 0.55; }
  .cx-meter-scale { display: flex; justify-content: flex-end; color: var(--oc-muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
  .cx-meter-threshold { text-align: right; }

  .cx-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; }
  .cx-pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.15rem 0.55rem 0.15rem 0.45rem; border-radius: 999px; font-size: 0.72rem; background: color-mix(in srgb, var(--oc-muted) 12%, transparent); cursor: default; --cx-dot: var(--oc-muted); }
  .cx-pill[hidden] { display: none; }
  .cx-pill[data-tone="success"] { --cx-dot: var(--oc-success); }
  .cx-pill[data-tone="warning"] { --cx-dot: var(--oc-warning); color: var(--oc-warning-text, var(--oc-warning)); background: color-mix(in srgb, var(--oc-warning) 14%, transparent); }
  .cx-pill-dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; background: var(--cx-dot); flex: none; }


  .cx-swatch[data-id="reserve"] {
    background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--oc-muted) 45%, transparent) 0 1px, transparent 1px 3px);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--oc-muted) 45%, transparent);
  }

  .cx-legend { display: flex; flex-direction: column; gap: 0.6rem; }
  .cx-group { display: flex; flex-direction: column; gap: 1px; }
  .cx-group:empty { display: none; }
  .cx-group-heading { display: flex; justify-content: space-between; padding: 0 0.35rem 0.2rem; color: var(--oc-muted); font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .cx-row { display: grid; grid-template-columns: 0.75rem 0.65rem minmax(0, 1fr) auto 3.4rem; align-items: center; gap: 0.45rem; padding: 0.3rem 0.35rem; border-radius: 4px; }
  .cx-row:hover { background: var(--oc-hover, color-mix(in srgb, var(--oc-muted) 10%, transparent)); }
  .cx-row-free { color: var(--oc-muted); }
  .cx-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-share { color: var(--oc-muted); }
  .cx-swatch { width: 0.65rem; height: 0.65rem; border-radius: 2px; }
  .cx-swatch[data-id="free"] { box-shadow: inset 0 0 0 1px var(--oc-border); }

  .cx-footer { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.6rem; border-top: 1px solid var(--oc-border); }
  .cx-trend { display: flex; flex-direction: column; gap: 0.2rem; }
  .cx-history { width: 100%; height: ${CHART_HEIGHT}px; display: block; }
  .cx-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: 0.5rem; }
  .cx-fact { display: flex; flex-direction: column; gap: 0.05rem; }
  .cx-fact-value { font-variant-numeric: tabular-nums; }

  @media (prefers-reduced-motion: reduce) { .cx-chevron::before, .cx-block { transition: none; } }
`;

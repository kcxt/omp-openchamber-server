// omp context panel: window fill, the history curve, cache weight and compactions
// of the active session, as the sidecar publishes them (see service/src/summary.js).
import { connectHost } from '@openchamber/sdk';

const host = connectHost();

const STYLE = `
:root { color-scheme: light dark; --bd: #8884; --mut: #888; --acc: #3b82f6; --warn: #d9822b; --err: #c0392b; }
html, body { background: transparent; }
body { font: 13px/1.4 system-ui, sans-serif; margin: 0; padding: 10px; display: grid; gap: 12px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); margin: 0 0 4px; }
.bar { height: 10px; border-radius: 5px; background: var(--bd); overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--acc); }
.bar.hot > i { background: var(--warn); } .bar.full > i { background: var(--err); }
.big { font-size: 20px; font-weight: 600; }
.mut { color: var(--mut); font-size: 11.5px; }
.grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
svg { width: 100%; height: 72px; display: block; }
.err { color: var(--err); }
`;

const style = document.createElement('style');
style.textContent = STYLE;
document.head.append(style);
const root = document.createElement('main');
document.body.append(root);

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

const curve = (history) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  if (history.length < 2) return svg;
  const top = Math.max(...history.map((p) => p.window ?? p.used), ...history.map((p) => p.used));
  const x = (i) => (i / (history.length - 1)) * 100;
  const y = (v) => 40 - (v / top) * 38 - 1;
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', history.map((p, i) => `${x(i).toFixed(2)},${y(p.used).toFixed(2)}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--acc)');
  line.setAttribute('stroke-width', '1.2');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  return svg;
};

const render = (view) => {
  root.replaceChildren();
  if (!view.current) {
    root.append(el('p', { className: 'mut', textContent: 'No context figures yet: the session has no assistant reply that reported a prompt size.' }));
    return;
  }
  const { current, history, cache, compactions } = view;
  const pct = current.percent;
  root.append(
    el('section', {},
      el('h2', { textContent: 'Context window' }),
      el('div', { className: 'big', textContent: current.window ? `${fmt(current.used)} / ${fmt(current.window)}` : fmt(current.used) }),
      ...(pct === undefined ? [el('div', { className: 'mut', textContent: 'Window unknown: open the model picker once so the sidecar learns it.' })] : [
        el('div', { className: `bar${pct >= 95 ? ' full' : pct >= 80 ? ' hot' : ''}` }, Object.assign(document.createElement('i'), { style: `width:${pct.toFixed(1)}%` })),
        el('div', { className: 'mut', textContent: `${pct.toFixed(1)}% used` }),
      ])),
    el('section', {}, el('h2', { textContent: 'History' }), curve(history), el('div', { className: 'mut', textContent: `${history.length} assistant turns` })),
    el('section', {}, el('h2', { textContent: 'Cache' }),
      el('div', { className: 'grid' },
        el('span', { className: 'mut', textContent: 'Last turn read' }), el('span', { textContent: fmt(cache.lastRead) }),
        el('span', { className: 'mut', textContent: 'Last turn write' }), el('span', { textContent: fmt(cache.lastWrite) }),
        el('span', { className: 'mut', textContent: 'Session read / write' }), el('span', { textContent: `${fmt(cache.read)} / ${fmt(cache.write)}` }))),
    el('section', {}, el('h2', { textContent: 'Compactions' }),
      el('div', { textContent: compactions.count === 0 ? 'None yet' : `${compactions.count}; last ${fmt(compactions.tokensBefore ?? 0)} → ${fmt(compactions.tokensAfter ?? 0)} tokens` })),
  );
};

let sessionId = null;
let inflight = 0;

const call = async (path) => {
  const res = await host.serviceRequest({ method: 'GET', path });
  const data = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : (res.body ?? {});
  if (res.status >= 400) throw new Error(data.error || `request failed (${res.status})`);
  return data;
};

const refresh = async () => {
  if (!sessionId) {
    root.replaceChildren(el('p', { className: 'mut', textContent: 'Open a session to see its context.' }));
    return;
  }
  const ticket = ++inflight;
  try {
    const view = await call(`/context?sessionId=${encodeURIComponent(sessionId)}`);
    if (ticket === inflight) render(view);
  } catch (error) {
    if (ticket === inflight) root.replaceChildren(el('p', { className: 'err', textContent: error instanceof Error ? error.message : String(error) }));
  }
};

host.onSession((session) => {
  const next = session?.id ?? null;
  if (next === sessionId) return;
  sessionId = next;
  void refresh();
});
// A finished turn is the moment the figures change.
host.onSessionLifecycle((event) => {
  if (event.sessionId === sessionId && event.phase !== 'started') void refresh();
});

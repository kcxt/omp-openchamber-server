// omp settings panel: a searchable editor over `omp config`, reached through the
// extension's local service (see service/src/main.js).
import { connectHost } from '@openchamber/sdk';

const host = connectHost();
const main = document.getElementById('main');
const q = document.getElementById('q');
const setOnly = document.getElementById('setOnly');
const status = document.getElementById('status');
let entries = {};
let setKeys = new Set();

const call = async (method, path, body) => {
  const res = await host.serviceRequest({ method, path, ...(body === undefined ? {} : { body }) });
  const data = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : (res.body ?? {});
  if (res.status >= 400) throw new Error(data.error || `request failed (${res.status})`);
  return data;
};

const display = (type, value) => (type === 'array' || type === 'record'
  ? JSON.stringify(value ?? (type === 'array' ? [] : {}), null, 2)
  : value ?? '');

const show = (node, text, isErr) => { node.textContent = text; node.className = `msg ${isErr ? 'err' : 'ok'}`; };

async function save(key, value, message) {
  try {
    const r = await call('PUT', '/settings', { key, value });
    entries[key].value = r.value;
    setKeys.add(key);
    show(message, 'saved', false);
    render();
  } catch (e) { show(message, e.message, true); }
}

async function reset(key, message) {
  try {
    const r = await call('POST', '/settings/reset', { key });
    entries[key].value = r.value;
    setKeys.delete(key);
    show(message, 'reset to default', false);
    render();
  } catch (e) { show(message, e.message, true); }
}

function control(key, entry, message) {
  const type = entry.type;
  let el;
  if (type === 'boolean') {
    el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = entry.value === true;
    el.onchange = () => save(key, el.checked, message);
  } else if (type === 'number') {
    el = document.createElement('input');
    el.type = 'number';
    el.value = entry.value ?? '';
    el.onchange = () => save(key, Number(el.value), message);
  } else if (type === 'array' || type === 'record') {
    el = document.createElement('textarea');
    el.value = display(type, entry.value);
    el.onchange = () => {
      try { save(key, JSON.parse(el.value), message); } catch { show(message, 'not valid JSON', true); }
    };
  } else {
    el = document.createElement('input');
    el.type = 'text';
    el.value = entry.value ?? '';
    el.onchange = () => save(key, el.value, message);
  }
  return el;
}

function render() {
  const needle = q.value.trim().toLowerCase();
  main.replaceChildren();
  let shown = 0;
  let lastGroup = '';
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key];
    if (setOnly.checked && !setKeys.has(key)) continue;
    if (needle && !(key.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle))) continue;
    const group = key.includes('.') ? key.slice(0, key.indexOf('.')) : 'general';
    if (group !== lastGroup) {
      const h = document.createElement('h2');
      h.textContent = group;
      main.append(h);
      lastGroup = group;
    }
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('div');
    k.className = 'key';
    k.textContent = key;
    if (setKeys.has(key)) {
      const s = document.createElement('span');
      s.className = 'set';
      s.textContent = 'set';
      k.append(s);
    }
    const d = document.createElement('div');
    d.className = 'desc';
    d.textContent = (entry.description || '') + (entry.type === 'enum' ? ' (enum)' : '');
    const message = document.createElement('div');
    message.className = 'msg';
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const b = document.createElement('button');
    b.textContent = 'reset';
    b.title = 'restore the default';
    b.onclick = () => reset(key, message);
    ctl.append(control(key, entry, message), b);
    row.append(k, d, ctl, message);
    main.append(row);
    shown++;
  }
  status.textContent = `${shown} of ${Object.keys(entries).length}`;
}

q.oninput = render;
setOnly.onchange = render;
call('GET', '/settings')
  .then((data) => { entries = data.entries; setKeys = new Set(data.set); render(); })
  .catch((e) => { status.textContent = e.message; });

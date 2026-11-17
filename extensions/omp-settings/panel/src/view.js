// omp settings view, shared by the OpenChamber extension panel and the
// standalone page the sidecar serves. It lays settings out like omp's own
// `/settings`: the tabs, groups, labels, option lists and visibility
// conditions come from a snapshot of omp's settings registry (`data.schema`).
// Everything omp does not list there (internal or newer keys) goes under
// "Advanced" with its raw key.
//
// `call(method, path, body)` is the only transport: GET /settings returns
// { entries, set, models, schema, platform, ompVersion }; PUT /settings writes
// one key; POST /settings/reset restores its default.

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;
const MODEL_LIST_ID = 'omp-models';

const STYLE = `
:root { color-scheme: light dark; --bd: #8884; --mut: #888; --ok: #2a8a4a; --err: #c0392b; --acc: #3b82f6; }
html, body { background: transparent; }
body { font: 13px/1.4 system-ui, sans-serif; margin: 0; }
.os-head { position: sticky; top: 0; z-index: 2; background: Canvas; border-bottom: 1px solid var(--bd); padding: 8px 10px 0; display: grid; gap: 6px; }
.os-head input[type=search] { width: 100%; box-sizing: border-box; padding: 5px 7px; font: inherit; }
.os-bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--mut); font-size: 12px; }
.os-note { font-size: 11.5px; color: var(--err); }
.os-tabs { display: flex; gap: 2px; overflow-x: auto; margin: 0 -10px; padding: 0 10px; }
.os-tabs button { border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 6px 9px; font: inherit; color: var(--mut); cursor: pointer; white-space: nowrap; }
.os-tabs button[aria-selected=true] { color: inherit; border-bottom-color: var(--acc); font-weight: 600; }
.os-main { padding: 4px 10px 48px; }
.os-main h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); margin: 20px 0 2px; }
.os-main h3 { font-size: 12px; margin: 14px 0 0; color: var(--mut); font-weight: 600; }
.os-row { display: grid; gap: 3px; padding: 9px 0; border-bottom: 1px solid var(--bd); }
.os-label { font-weight: 600; }
.os-set { color: var(--ok); font-size: 11px; font-weight: 400; margin-left: 6px; }
.os-desc, .os-optdesc, .os-meta { color: var(--mut); font-size: 11.5px; }
.os-meta { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
.os-ctl { display: flex; gap: 6px; align-items: flex-start; margin-top: 2px; }
.os-ctl input[type=text], .os-ctl input[type=password], .os-ctl input[type=number], .os-ctl select, .os-ctl textarea { flex: 1; min-width: 0; box-sizing: border-box; padding: 4px 6px; font: inherit; }
.os-ctl textarea { font-family: ui-monospace, monospace; font-size: 11.5px; min-height: 56px; }
.os-msg { font-size: 11.5px; }
.os-msg:empty { display: none; }
.os-msg.err { color: var(--err); } .os-msg.ok { color: var(--ok); }
.os-role { display: grid; grid-template-columns: minmax(70px, 120px) 1fr auto; gap: 6px 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--bd); }
.os-role .os-msg { grid-column: 2 / 4; }
.os-role input, .os-role select { min-width: 0; box-sizing: border-box; padding: 4px 6px; font: inherit; }
button { padding: 3px 8px; cursor: pointer; }
`;

export function mountSettings({ call, root = document.body }) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  const head = el('div', 'os-head');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search all settings';
  const bar = el('div', 'os-bar');
  const setOnlyLabel = el('label');
  const setOnly = el('input');
  setOnly.type = 'checkbox';
  setOnlyLabel.append(setOnly, ' only ones I set');
  const status = el('span');
  status.textContent = 'loading…';
  bar.append(setOnlyLabel, status);
  const note = el('div', 'os-note');
  const tabsNav = el('div', 'os-tabs');
  tabsNav.setAttribute('role', 'tablist');
  head.append(search, bar, note, tabsNav);
  const main = el('div', 'os-main');
  const models = el('datalist');
  models.id = MODEL_LIST_ID;
  root.append(head, main, models);

  let data = null;
  let byId = new Map();
  let setKeys = new Set();
  let tab = null;

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  const effective = (id) => {
    const entry = data.entries[id];
    if (entry && entry.value !== undefined) return entry.value;
    return byId.get(id)?.default;
  };

  const visible = (setting) => (setting.condition ?? []).every((clause) => (
    'platform' in clause ? data.platform === clause.platform : effective(clause.id) === clause.eq
  ));

  // Settings in the snapshot, plus raw keys omp reports that the snapshot lacks.
  function advancedKeys() {
    return Object.keys(data.entries).filter((key) => !byId.has(key) && key !== 'modelRoles').sort();
  }

  function advancedSetting(key) {
    const entry = data.entries[key];
    return {
      id: key,
      type: entry.type,
      tab: 'advanced',
      group: key.includes('.') ? key.slice(0, key.indexOf('.')) : 'general',
      label: key,
      description: entry.description || '',
    };
  }

  const isModelSetting = (setting) => setting.type === 'string' && /model/i.test(setting.label);

  const show = (node, text, isErr) => { node.textContent = text; node.className = `os-msg ${isErr ? 'err' : 'ok'}`; };

  async function save(id, value, message) {
    try {
      const r = await call('PUT', '/settings', { key: id, value });
      data.entries[id] = { ...(data.entries[id] ?? { type: 'unknown', description: '' }), value: r.value };
      setKeys.add(id);
      render();
    } catch (e) { show(message, e.message, true); }
  }

  async function reset(id, message) {
    try {
      const r = await call('POST', '/settings/reset', { key: id });
      data.entries[id] = { ...(data.entries[id] ?? { type: 'unknown', description: '' }), value: r.value };
      setKeys.delete(id);
      render();
    } catch (e) { show(message, e.message, true); }
  }

  function selectControl(setting, current, message) {
    const options = setting.options
      ?? (setting.values ?? []).map((value) => ({ value: String(value), label: String(value) }));
    const sel = el('select');
    const currentValue = current === undefined ? '' : String(current);
    const known = options.some((option) => option.value === currentValue);
    if (!known) {
      const extra = el('option');
      extra.value = currentValue;
      extra.textContent = currentValue === '' ? '(unset)' : `${currentValue} (current)`;
      sel.append(extra);
    }
    for (const option of options) {
      const node = el('option');
      node.value = option.value;
      node.textContent = option.label;
      sel.append(node);
    }
    sel.value = currentValue;
    sel.onchange = () => save(setting.id, setting.type === 'number' ? Number(sel.value) : sel.value, message);
    return { node: sel, optionDescription: () => options.find((option) => option.value === sel.value)?.description };
  }

  function control(setting, message) {
    const current = effective(setting.id);
    if (setting.options || setting.type === 'enum') return selectControl(setting, current, message);
    let node;
    if (setting.type === 'boolean') {
      node = el('input');
      node.type = 'checkbox';
      node.checked = current === true;
      node.onchange = () => save(setting.id, node.checked, message);
    } else if (setting.type === 'number') {
      node = el('input');
      node.type = 'number';
      node.value = current ?? '';
      node.onchange = () => save(setting.id, Number(node.value), message);
    } else if (setting.type === 'array' || setting.type === 'record') {
      node = el('textarea');
      node.value = JSON.stringify(current ?? (setting.type === 'array' ? [] : {}), null, 2);
      node.onchange = () => {
        try { save(setting.id, JSON.parse(node.value), message); } catch { show(message, 'not valid JSON', true); }
      };
    } else if (isModelSetting(setting)) {
      node = el('input');
      node.type = 'text';
      node.setAttribute('list', MODEL_LIST_ID);
      node.placeholder = 'provider/model (type to search)';
      node.value = current ?? '';
      node.onchange = () => (node.value.trim() === '' ? reset(setting.id, message) : save(setting.id, node.value.trim(), message));
    } else {
      node = el('input');
      node.type = setting.credential ? 'password' : 'text';
      node.value = current ?? '';
      node.onchange = () => save(setting.id, node.value, message);
    }
    return { node };
  }

  function settingRow(setting) {
    const row = el('div', 'os-row');
    const label = el('div', 'os-label');
    label.textContent = setting.label;
    if (setKeys.has(setting.id)) {
      const badge = el('span', 'os-set');
      badge.textContent = 'set';
      label.append(badge);
    }
    const desc = el('div', 'os-desc');
    desc.textContent = setting.description;
    const message = el('div', 'os-msg');
    const { node, optionDescription } = control(setting, message);
    const ctl = el('div', 'os-ctl');
    ctl.append(node);
    if (setKeys.has(setting.id)) {
      const button = el('button');
      button.textContent = 'reset';
      button.title = 'restore the default';
      button.onclick = () => reset(setting.id, message);
      ctl.append(button);
    }
    row.append(label, desc, ctl);
    if (optionDescription) {
      const text = el('div', 'os-optdesc');
      text.textContent = optionDescription() ?? '';
      node.addEventListener('change', () => { text.textContent = optionDescription() ?? ''; });
      row.append(text);
    }
    const meta = el('div', 'os-meta');
    const dflt = byId.get(setting.id)?.default;
    meta.textContent = setting.id + (dflt === undefined || typeof dflt === 'object' ? '' : ` · default ${dflt}`);
    row.append(message, meta);
    return row;
  }

  // The modelRoles record (default, smol, slow, ...) as one picker per role,
  // with an optional thinking level, the way omp's model browser assigns them.
  function rolesSection() {
    const section = el('div');
    const current = isRecordValue(data.entries.modelRoles?.value) ? data.entries.modelRoles.value : {};
    const known = data.schema.roles.map((role) => ({ id: role.id, name: role.name }));
    for (const id of Object.keys(current)) {
      if (!known.some((role) => role.id === id)) known.push({ id, name: id });
    }
    for (const role of known) {
      const value = typeof current[role.id] === 'string' ? current[role.id] : '';
      const level = THINKING_SUFFIX.exec(value)?.[1] ?? '';
      const selector = value.replace(THINKING_SUFFIX, '');
      const row = el('div', 'os-role');
      const name = el('div');
      name.textContent = role.name;
      name.title = role.id;
      const pick = el('input');
      pick.type = 'text';
      pick.setAttribute('list', MODEL_LIST_ID);
      pick.placeholder = 'omp decides';
      pick.value = selector;
      const thinking = el('select');
      for (const option of ['', ...THINKING]) {
        const node = el('option');
        node.value = option;
        node.textContent = option === '' ? 'thinking: default' : option;
        thinking.append(node);
      }
      thinking.value = level;
      const message = el('div', 'os-msg');
      const commit = () => {
        const next = { ...current };
        const chosen = pick.value.trim();
        if (chosen === '') delete next[role.id];
        else next[role.id] = thinking.value ? `${chosen}:${thinking.value}` : chosen;
        if (Object.keys(next).length === 0) reset('modelRoles', message);
        else save('modelRoles', next, message);
      };
      pick.onchange = commit;
      thinking.onchange = commit;
      row.append(name, pick, thinking, message);
      section.append(row);
    }
    return section;
  }

  const isRecordValue = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

  function matches(setting, needle) {
    return setting.label.toLowerCase().includes(needle)
      || setting.id.toLowerCase().includes(needle)
      || setting.description.toLowerCase().includes(needle)
      || (setting.group ?? '').toLowerCase().includes(needle);
  }

  function render() {
    const needle = search.value.trim().toLowerCase();
    const tabs = [...data.schema.tabs, { id: 'advanced', label: 'Advanced' }];
    if (!tab) tab = tabs[0].id;

    tabsNav.replaceChildren(...tabs.map((entry) => {
      const button = el('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(!needle && entry.id === tab));
      button.textContent = entry.label;
      button.onclick = () => { tab = entry.id; search.value = ''; render(); };
      return button;
    }));

    const all = [
      ...data.schema.settings.filter(visible),
      ...advancedKeys().map(advancedSetting),
    ].filter((setting) => (setOnly.checked ? setKeys.has(setting.id) : true));

    const wanted = needle ? all.filter((setting) => matches(setting, needle)) : all.filter((setting) => setting.tab === tab);
    main.replaceChildren();

    // The role assignments sit at the top of the Model tab, as in omp, and
    // answer a search for "role" or "model". "Only ones I set" keeps them only
    // when some role is assigned.
    const rolesWanted = needle ? 'model roles'.includes(needle) : tab === 'model';
    if (rolesWanted && (!setOnly.checked || setKeys.has('modelRoles'))) {
      const h = el('h2');
      h.textContent = 'Model roles';
      main.append(h, rolesSection());
    }

    let lastTab = null;
    let lastGroup = null;
    for (const setting of wanted) {
      if (needle && setting.tab !== lastTab) {
        const h = el('h2');
        h.textContent = tabs.find((entry) => entry.id === setting.tab)?.label ?? setting.tab;
        main.append(h);
        lastTab = setting.tab;
        lastGroup = null;
      }
      if (setting.group !== lastGroup) {
        const h = needle ? el('h3') : el('h2');
        h.textContent = setting.group;
        main.append(h);
        lastGroup = setting.group;
      }
      main.append(settingRow(setting));
    }
    status.textContent = `${wanted.length} setting${wanted.length === 1 ? '' : 's'}`;
  }

  search.oninput = render;
  setOnly.onchange = render;

  call('GET', '/settings').then((payload) => {
    data = payload;
    byId = new Map(data.schema.settings.map((setting) => [setting.id, setting]));
    setKeys = new Set(data.set);
    models.replaceChildren(...data.models.map((model) => {
      const node = el('option');
      node.value = model.selector;
      node.label = model.name;
      return node;
    }));
    if (data.ompVersion && data.ompVersion !== data.schema.ompVersion) {
      note.textContent = `Layout is from omp ${data.schema.ompVersion}; running ${data.ompVersion}. Newer settings are under Advanced.`;
    }
    render();
  }).catch((e) => { status.textContent = e.message; });
}

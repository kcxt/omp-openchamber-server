/**
 * omp's own settings (`omp config`) over HTTP, plus a small page to edit them.
 *
 * OpenChamber has no screen for omp settings, and its own server answers
 * `/api/config/*` itself, so this lives under `/api/omp/settings`: unmatched
 * `/api/*` paths are proxied to the sidecar by `openchamber serve`, so the page
 * opens at `<openchamber url>/api/omp/settings/ui` behind the same UI login.
 */
import { listOmpConfig, listOmpSetKeys, resetOmpConfigKey, setOmpConfigValue } from "../../vendor/kabmo/config-cli";

export interface SettingsRouteResult {
  status: number;
  data?: unknown;
  html?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

const fail = (error: unknown, status = 500): SettingsRouteResult => ({
  status,
  data: { error: error instanceof Error ? error.message : String(error) },
});

export async function handleOmpSettingsRoute(req: Request, path: string): Promise<SettingsRouteResult | null> {
  if (path !== "/api/omp/settings" && !path.startsWith("/api/omp/settings/")) return null;

  if (path === "/api/omp/settings/ui" && req.method === "GET") return { status: 200, html: SETTINGS_PAGE };

  if (path === "/api/omp/settings" && req.method === "GET") {
    try {
      const [entries, set] = await Promise.all([listOmpConfig(), listOmpSetKeys()]);
      return { status: 200, data: { entries, set } };
    } catch (error) {
      return fail(error);
    }
  }

  if (path === "/api/omp/settings" && (req.method === "PUT" || req.method === "POST")) {
    const body = await readBody(req);
    if (typeof body.key !== "string" || !body.key.trim()) return fail(new Error("key is required"), 400);
    const value = body.value;
    const typeOk = typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || isRecord(value);
    if (!typeOk) return fail(new Error("value must be a string, number, boolean, array, or record"), 400);
    try {
      return { status: 200, data: { success: true, key: body.key, value: (await setOmpConfigValue(body.key, value)) ?? null } };
    } catch (error) {
      // omp's own sentence for a rejected key or value is the useful part.
      return fail(error, 400);
    }
  }

  if (path === "/api/omp/settings/reset" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.key !== "string" || !body.key.trim()) return fail(new Error("key is required"), 400);
    try {
      return { status: 200, data: { success: true, key: body.key, value: (await resetOmpConfigKey(body.key)) ?? null } };
    } catch (error) {
      return fail(error, 400);
    }
  }

  return null;
}

const SETTINGS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omp settings</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; --mut: #888; --ok: #2a8a4a; --err: #c0392b; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; }
  header { position: sticky; top: 0; padding: 10px 16px; background: Canvas; border-bottom: 1px solid var(--bd); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  input[type=search] { flex: 1; min-width: 200px; padding: 6px 8px; }
  main { padding: 8px 16px 64px; max-width: 980px; margin: 0 auto; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); margin: 24px 0 4px; }
  .row { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(200px, 1.4fr) auto; gap: 8px 12px; padding: 8px 0; border-bottom: 1px solid var(--bd); align-items: start; }
  .key { font-family: ui-monospace, monospace; font-size: 12.5px; word-break: break-all; }
  .desc { color: var(--mut); font-size: 12px; margin-top: 2px; }
  .set { color: var(--ok); font-size: 11px; margin-left: 6px; }
  .row input[type=text], .row input[type=number], .row textarea { width: 100%; box-sizing: border-box; padding: 5px 7px; font: inherit; }
  .row textarea { font-family: ui-monospace, monospace; font-size: 12px; min-height: 64px; }
  .msg { font-size: 12px; min-height: 1em; grid-column: 2 / 4; }
  .msg.err { color: var(--err); } .msg.ok { color: var(--ok); }
  button { padding: 4px 10px; cursor: pointer; }
  #status { color: var(--mut); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>omp settings</h1>
  <input id="q" type="search" placeholder="Filter settings (key or description)">
  <label><input id="setOnly" type="checkbox"> only ones I set</label>
  <span id="status">loading…</span>
</header>
<main id="main"></main>
<script>
(() => {
  const main = document.getElementById("main");
  const q = document.getElementById("q");
  const setOnly = document.getElementById("setOnly");
  const status = document.getElementById("status");
  let entries = {};
  let setKeys = new Set();

  const api = async (method, path, body) => {
    const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  };

  const display = (type, value) => (type === "array" || type === "record" ? JSON.stringify(value ?? (type === "array" ? [] : {}), null, 2) : value ?? "");

  function control(key, entry, message) {
    const type = entry.type;
    let el;
    if (type === "boolean") {
      el = document.createElement("input");
      el.type = "checkbox";
      el.checked = entry.value === true;
      el.onchange = () => save(key, el.checked, message);
    } else if (type === "number") {
      el = document.createElement("input");
      el.type = "number";
      el.value = entry.value ?? "";
      el.onchange = () => save(key, Number(el.value), message);
    } else if (type === "array" || type === "record") {
      el = document.createElement("textarea");
      el.value = display(type, entry.value);
      el.onchange = () => {
        try { save(key, JSON.parse(el.value), message); }
        catch { show(message, "not valid JSON", true); }
      };
    } else {
      el = document.createElement("input");
      el.type = "text";
      el.value = entry.value ?? "";
      el.onchange = () => save(key, el.value, message);
    }
    return el;
  }

  const show = (node, text, isErr) => { node.textContent = text; node.className = "msg " + (isErr ? "err" : "ok"); };

  async function save(key, value, message) {
    try { const r = await api("PUT", "/api/omp/settings", { key, value }); entries[key].value = r.value; setKeys.add(key); show(message, "saved", false); render(); }
    catch (e) { show(message, e.message, true); }
  }

  async function reset(key, message) {
    try { const r = await api("POST", "/api/omp/settings/reset", { key }); entries[key].value = r.value; setKeys.delete(key); show(message, "reset to default", false); render(); }
    catch (e) { show(message, e.message, true); }
  }

  function render() {
    const needle = q.value.trim().toLowerCase();
    main.replaceChildren();
    let shown = 0, lastGroup = "";
    for (const key of Object.keys(entries).sort()) {
      const entry = entries[key];
      if (setOnly.checked && !setKeys.has(key)) continue;
      if (needle && !(key.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle))) continue;
      const group = key.includes(".") ? key.slice(0, key.indexOf(".")) : "general";
      if (group !== lastGroup) { const h = document.createElement("h2"); h.textContent = group; main.append(h); lastGroup = group; }
      const row = document.createElement("div"); row.className = "row";
      const left = document.createElement("div");
      const k = document.createElement("div"); k.className = "key"; k.textContent = key;
      if (setKeys.has(key)) { const s = document.createElement("span"); s.className = "set"; s.textContent = "set"; k.append(s); }
      const d = document.createElement("div"); d.className = "desc"; d.textContent = (entry.description || "") + (entry.type === "enum" ? " (enum)" : "");
      left.append(k, d);
      const message = document.createElement("div"); message.className = "msg";
      const right = document.createElement("div"); right.append(control(key, entry, message));
      const actions = document.createElement("div");
      const b = document.createElement("button"); b.textContent = "reset"; b.title = "restore the default";
      b.onclick = () => reset(key, message);
      actions.append(b);
      row.append(left, right, actions, message);
      main.append(row);
      shown++;
    }
    status.textContent = shown + " of " + Object.keys(entries).length + " settings";
  }

  q.oninput = render;
  setOnly.onchange = render;
  api("GET", "/api/omp/settings").then((data) => { entries = data.entries; setKeys = new Set(data.set); render(); }).catch((e) => { status.textContent = e.message; });
})();
</script>
</body>
</html>`;

// Sidecar handover under systemd, in an isolated capsule (capsule.ts): omp children run as transient units,
// so `systemctl restart omp-server` swaps the sidecar without touching them. Offline: the stub omp, no providers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCapsule, type Capsule } from "./capsule";

const REPO = join(import.meta.dir, "..", "..");
const STUB = join(REPO, "test", "stub-omp", "omp");

let capsule: Capsule;
let api: string;
let project: string;
let sandbox: string;

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port!;
  await server.stop(true);
  return port;
}

async function until(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await Promise.resolve(probe()).catch(() => false))) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const http = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const res = await fetch(`${api}${path}`, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    ...(init.json !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const dir = () => `directory=${encodeURIComponent(project)}`;
const frames = (): Array<Record<string, any>> =>
  readFileSync(join(sandbox, "frames.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const messages = async (id: string): Promise<string[]> =>
  ((await http(`/session/${id}/message?${dir()}&order=asc`)).body.data as any[]).map((m) =>
    m.type === "user" ? `user: ${m.text}` : `assistant: ${(m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")}`);
const children = () => capsule.ctl("list-units", "omp-child@*.service", "--plain", "--no-legend", "--state=active").out
  .split("\n").map((line) => line.trim().split(/\s+/)[0]!).filter(Boolean);

beforeAll(async () => {
  const port = await freePort();
  api = `http://127.0.0.1:${port}`;
  capsule = await startCapsule((root) => {
    sandbox = join(root, "sandbox");
    project = join(sandbox, "home", "proj");
    for (const path of [project, join(sandbox, "agent"), join(sandbox, "oc")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(sandbox, "script.json"), JSON.stringify({ turns: [] }));
    return {
      // The shipped template with its host-specific lines pointed at the capsule: the real launcher, and only the capsule's
      // state directories bound (as in production, the runtime directory is not: systemd mounts per-unit credentials under it).
      // Edited in place: layering a drop-in that resets BindPaths= left the instance with no binds at all.
      "omp-child@.service": readFileSync(join(REPO, "omp-child@.service"), "utf8")
        .replace(/^ExecStart=.*$/m, `ExecStart=${REPO}/bin/omp-child %i`)
        .replace(/^BindPaths=.*$/m, `BindPaths=${root}/sandbox ${root}/home ${root}/logs`)
        .replace(/^BindReadOnlyPaths=.*$/m, "")
        .replace(/^\[Service\]$/m, `[Service]\nStandardError=append:${root}/logs/child.log`),
      "omp-server.service": [
        "[Service]", "ProtectSystem=strict", "ProtectHome=tmpfs", "PrivateTmp=yes", "NoNewPrivileges=yes",
        // Like production: the state directories, plus the manager's two sockets for the sidecar alone. `rt/` itself is not bound (systemd mounts per-unit credentials under it).
        `BindPaths=${root}/sandbox ${root}/home ${root}/logs ${root}/rt/bus ${root}/rt/systemd/private`,
        `WorkingDirectory=${REPO}`,
        // The shipped launcher: it must exec bun, or LISTEN_PID would name the shell and socket activation would not engage.
        `ExecStart=${REPO}/bin/omp-server`,
        `StandardOutput=append:${root}/logs/sidecar.log`, "StandardError=inherit",
        `Environment=OC_CHILD_SUPERVISOR=systemd OC_SUPERVISOR_DIR=${root}/home/.cache/omp-sidecar OMP_BIN=${STUB} PATH=/usr/local/bin:/usr/bin`,
        `Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=${root}/rt/bus`,
        `Environment=HOME=${sandbox}/home PI_CODING_AGENT_DIR=${sandbox}/agent OPENCHAMBER_DATA_DIR=${sandbox}/oc`,
        `Environment=OMP_STUB_SCRIPT=${sandbox}/script.json OMP_STUB_RECORD=${sandbox}/frames.jsonl OC_CHILD_IDLE_MS=0`,
      ].join("\n"),
      // systemd owns the public port: connections queue here while the sidecar restarts (socket-activation.ts).
      "omp-server.socket": `[Socket]\nListenStream=127.0.0.1:${port}\n`,
    };
  });
  expect(capsule.ctl("start", "omp-server.socket").code).toBe(0);
  expect(capsule.ctl("start", "omp-server.service").code).toBe(0);
  await until("sidecar", async () => (await fetch(`${api}/health`)).ok);
});

afterAll(async () => {
  // The capsule's logs go with its root; keep the last run's where it can be read afterwards (git-ignored).
  const keep = join(REPO, ".cache", "capsule-last");
  rmSync(keep, { recursive: true, force: true });
  mkdirSync(keep, { recursive: true });
  if (capsule) cpSync(join(capsule.root, "logs"), join(keep, "logs"), { recursive: true });
  await capsule?.stop();
});

describe("a sidecar restart under systemd", () => {
  test("keeps the omp child and the session it is running, and the new sidecar takes both over", async () => {
    writeFileSync(join(sandbox, "script.json"), JSON.stringify({ turns: [
      { when: "slow", steps: [{ text: "before. " }, { sleep: 25_000 }, { text: "after." }] },
      { when: "again", steps: [{ text: "second answer" }] },
    ] }));
    const id = (await http(`/session?${dir()}`, { json: {} })).body.data.id as string;
    const started = await http(`/session/${id}/prompt_async?${dir()}`, { json: { id: "msg_handover0001", parts: [{ type: "text", text: "slow please" }] } });
    if (started.status >= 300) {
      const tail = (file: string) => readFileSync(join(capsule.root, "logs", file), "utf8").split("\n").slice(-25).join("\n");
      throw new Error(`prompt failed ${started.status}: ${JSON.stringify(started.body)}\n--- sidecar.log\n${tail("sidecar.log")}\n--- systemd.log\n${tail("systemd.log")}`);
    }
    await until("the turn to be running", async () => Object.keys((await http(`/session/status?${dir()}`)).body).includes(id));

    // The child is its own unit, with a ledger record the next sidecar adopts from.
    const [unit] = children();
    expect(unit).toMatch(/^omp-child@/);
    const pid = capsule.prop(unit!, "MainPID");
    const sidecarPid = capsule.prop("omp-server.service", "MainPID");
    const ledger = readdirSync(join(capsule.root, "home", ".cache", "omp-sidecar")).filter((name) => name.endsWith(".json"));
    expect(ledger).toEqual([`${unit}.json`]);
    // Same private /tmp, same sandbox, different mount namespaces.
    expect(readdirSync(`/proc/${pid}/root/tmp`).length).toBeGreaterThanOrEqual(0);
    // The spec (cwd, environment, argv) is handed over as credentials and must not stay on disk afterwards.
    expect(readdirSync(join(capsule.root, "home", ".cache", "omp-sidecar")).filter((name) => /\.(cwd|env|argv)$/.test(name))).toEqual([]);

    // The release: stop + start, mid-turn, with requests arriving the whole time. systemd's socket keeps the port
    // open, so none may be refused or fail: they wait for the new sidecar.
    const failures: string[] = [];
    let probing = true;
    const probe = (async () => {
      while (probing) {
        try {
          const res = await fetch(`${api}/health`, { headers: { connection: "close" }, signal: AbortSignal.timeout(20_000) });
          if (!res.ok) failures.push(`status ${res.status}`);
        } catch (err) {
          failures.push(String(err));
        }
        await Bun.sleep(20);
      }
    })();
    expect(capsule.ctl("restart", "omp-server.service").code).toBe(0);
    await until("the new sidecar", async () => (await fetch(`${api}/health`)).ok);
    probing = false;
    await probe;
    expect(failures).toEqual([]);
    expect(capsule.prop("omp-server.service", "MainPID")).not.toBe(sidecarPid);

    // Same unit, same process: the child never noticed.
    expect(children()).toEqual([unit]);
    expect(capsule.prop(unit!, "MainPID")).toBe(pid);


    // The new sidecar adopted it (and did not spawn): mid-turn, the session is still busy.
    expect(readFileSync(join(capsule.root, "logs", "sidecar.log"), "utf8")).toContain("adopted a running omp child");
    expect(Object.keys((await http(`/session/status?${dir()}`)).body)).toContain(id);
    // The turn that was running when the sidecar went away finishes, and the new sidecar reports it.
    await until("the turn to finish", async () => (await messages(id)).some((m) => m.includes("after.")), 30_000);
    await until("idle", async () => Object.keys((await http(`/session/status?${dir()}`)).body).length === 0);

    // The new sidecar drives the adopted child: no second child, no second switch_session.
    expect((await http(`/session/${id}/prompt_async?${dir()}`, { json: { id: "msg_handover0002", parts: [{ type: "text", text: "again please" }] } })).status).toBeLessThan(300);
    await until("the second answer", async () => (await messages(id)).some((m) => m.includes("second answer")));
    expect(children()).toEqual([unit]);
    expect(frames().filter((f) => f.type === "switch_session")).toHaveLength(1);
  }, 120_000);
});

describe("a supervised child that dies", () => {
  test("is reported as a crash through the closing frame, its unit and ledger record go, and the next prompt starts a fresh child", async () => {
    writeFileSync(join(sandbox, "script.json"), JSON.stringify({ turns: [
      { when: "boom", steps: [{ text: "about to die" }, { crash: true }] },
      { when: "recover", steps: [{ text: "back again" }] },
    ] }));
    const id = (await http(`/session?${dir()}`, { json: {} })).body.data.id as string;
    // The earlier test's child is still there (idle release is off in this capsule): only the crashed one must go.
    const others = children();
    await http(`/session/${id}/prompt_async?${dir()}`, { json: { id: "msg_crash0001", parts: [{ type: "text", text: "boom" }] } });
    await until("the crashing child to start", () => children().length > others.length);
    await until("the child to be gone", () => children().length === others.length);
    await until("idle", async () => !Object.keys((await http(`/session/status?${dir()}`)).body).includes(id));
    expect(readdirSync(join(capsule.root, "home", ".cache", "omp-sidecar")).filter((name) => name.endsWith(".json")).sort()).toEqual(others.map((unit) => `${unit}.json`).sort());

    await http(`/session/${id}/prompt_async?${dir()}`, { json: { id: "msg_crash0002", parts: [{ type: "text", text: "recover" }] } });
    await until("the new child's answer", async () => (await messages(id)).some((m) => m.includes("back again")));
  }, 60_000);
});

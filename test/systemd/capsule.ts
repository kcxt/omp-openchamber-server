// An isolated `systemd --user` for tests: nothing in it can reach the real user manager.
//
//  - its own user, mount and cgroup namespaces (`unshare -Urm --cgroup`), so it sees only its own cgroup subtree
//    as `/`, can mount cgroup2, and its tmpfs over /run/systemd/oom keeps it from reporting to the host's oomd;
//  - its own XDG_RUNTIME_DIR and HOME under one throwaway root, and SYSTEMD_UNIT_PATH pinned to `<root>/units`
//    so the host's stock user units (pipewire, gnupg, ...) are not loaded;
//  - a session bus (dbus-daemon, socket-activated by its own dbus.socket) for `systemctl --user` / `systemd-run --user`.
//
// Needs unprivileged user namespaces and a delegated, writable cgroup (any normal user session has both).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INNER = `#!/bin/bash
mount -t cgroup2 none /sys/fs/cgroup
mount -t tmpfs none /run/systemd/oom 2>/dev/null || true
exec env -i SYSTEMD_UNIT_PATH="$CAPSULE_ROOT/units" XDG_RUNTIME_DIR="$CAPSULE_ROOT/rt" HOME="$CAPSULE_ROOT/home" \\
  PATH=/usr/local/bin:/usr/bin LANG=C.UTF-8 /usr/lib/systemd/systemd --user --log-level=info --log-target=console
`;

const OUTER = `#!/bin/bash
set -e
own=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)
mkdir "$own/capsule-$$" && echo $$ > "$own/capsule-$$/cgroup.procs"
echo "$own/capsule-$$" > "$CAPSULE_ROOT/cgroup-path"
exec unshare --user --map-root-user --mount --cgroup --propagation private bash "$CAPSULE_ROOT/inner.sh"
`;

const sh = (cmd: string[], env: Record<string, string>) => {
  const result = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

export type Capsule = Awaited<ReturnType<typeof startCapsule>>;

export async function startCapsule(units: (root: string) => Record<string, string>) {
  // Not under /tmp: units that join the sidecar's private /tmp (JoinsNamespaceOf=) would not see a bind of anything below it.
  const base = join(import.meta.dir, "..", "..", ".cache", "capsules");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "c-"));
  const env = { PATH: process.env.PATH ?? "/usr/bin", XDG_RUNTIME_DIR: join(root, "rt"), HOME: join(root, "home") };
  for (const dir of ["units", "rt", "home", "logs"]) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const stockDbus = readFileSync("/usr/lib/systemd/user/dbus.socket", "utf8");
  writeFileSync(join(root, "units", "default.target"), "[Unit]\nDescription=capsule\nWants=dbus.socket\n");
  writeFileSync(join(root, "units", "basic.target"), "[Unit]\nDescription=capsule basic\n");
  writeFileSync(join(root, "units", "dbus.socket"), stockDbus);
  writeFileSync(join(root, "units", "dbus.service"), [
    "[Unit]", "Requires=dbus.socket", "After=dbus.socket",
    "[Service]", "ExecStart=/usr/bin/dbus-daemon --session --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only",
  ].join("\n"));
  for (const [name, text] of Object.entries(units(root))) {
    mkdirSync(join(root, "units", name, ".."), { recursive: true });
    writeFileSync(join(root, "units", name), text);
  }
  writeFileSync(join(root, "inner.sh"), INNER);
  writeFileSync(join(root, "outer.sh"), OUTER);

  const log = Bun.file(join(root, "logs", "systemd.log"));
  // The manager needs a cgroup subtree it may write. Inside a user service that is already so; from a login session
  // (session-N.scope, which is not delegated) it is not, so the capsule runs in a delegated scope of the real user
  // manager. The scope is only a cgroup to live in: nothing of the capsule is configured through that manager.
  const own = `/sys/fs/cgroup${readFileSync("/proc/self/cgroup", "utf8").trim().split(":").pop()}`;
  const writable = Bun.spawnSync(["test", "-w", own]).exitCode === 0;
  const launch = writable ? ["bash", join(root, "outer.sh")] : ["systemd-run", "--user", "--scope", "--quiet", "-p", "Delegate=yes", "bash", join(root, "outer.sh")];
  const manager = Bun.spawn(launch, { env: { ...env, CAPSULE_ROOT: root, ...(writable ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "" }) }, stdout: log, stderr: log, stdin: "ignore" });

  const ctl = (...args: string[]) => sh(["systemctl", "--user", ...args], env);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (ctl("is-system-running").out.trim() !== "" || ctl("list-units", "--no-legend").code === 0) break;
    if (Date.now() > deadline) throw new Error(`capsule did not come up:\n${readFileSync(join(root, "logs", "systemd.log"), "utf8")}`);
    await Bun.sleep(100);
  }

  return {
    root,
    env,
    ctl,
    /** `systemctl --user show <unit> -p <property>` as a bare value. */
    prop: (unit: string, property: string) => ctl("show", unit, "-p", property, "--value").out.trim(),
    unitLog: () => readFileSync(join(root, "logs", "systemd.log"), "utf8"),
    async stop() {
      // The capsule's whole cgroup subtree: the manager, the bus, every unit and everything they started.
      try {
        const cgroup = readFileSync(join(root, "cgroup-path"), "utf8").trim();
        writeFileSync(join(cgroup, "cgroup.kill"), "1");
      } catch { /* never started */ }
      manager.kill();
      await manager.exited;
      await Bun.sleep(200);
      // systemd leaves mode-000 stand-ins under rt/systemd/inaccessible.
      Bun.spawnSync(["chmod", "-R", "u+rwx", root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

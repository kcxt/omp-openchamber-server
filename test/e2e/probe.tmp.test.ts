import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStack } from "./stack";
import { newSession, send } from "./ui";
test("probe", async () => {
  const s = await startStack();
  Bun.spawnSync(["git", "init", "-q"], { cwd: s.project });
  writeFileSync(join(s.project, "a.txt"), "hello\n");
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: s.project });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: s.project });
  writeFileSync(join(s.project, "a.txt"), "hello\nchanged\n");
  const p = await s.page();
  const bad = new Set<string>();
  p.on("response", r => { if (r.status() >= 400) bad.add(`${r.status()} ${r.request().method()} ${r.url().replace(/^http:\/\/[^/]+/, "").replace(/ses_[A-Za-z0-9]+/g, ":id").replace(/\?.*/, "")}`); });
  await p.goto(s.ui);
  await p.locator(".group\\/project").first().waitFor();
  await newSession(p); await send(p, "hello probe"); await p.getByText("Echo: hello probe").waitFor();
  for (const y of [70, 120, 156, 192, 242, 278, 314, 364, 401]) {
    await p.mouse.click(1378, y); await p.waitForTimeout(1500);
    await p.screenshot({ path: `/tmp/probe-${y}.png` }); await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  }
  for (const name of ["Issues and PRs", "Scheduled tasks", "Archive", "Stats", "Integrations catalog"]) {
    await p.getByText(name, { exact: true }).first().click(); await p.waitForTimeout(1500);
    await p.screenshot({ path: `/tmp/probe-${name.split(" ")[0]}.png` }); await p.keyboard.press("Escape");
  }
  await p.getByRole("button", { name: "Settings" }).first().click().catch(()=>{}); await p.waitForTimeout(1500);
  await p.screenshot({ path: `/tmp/probe-settings.png` });
  console.log([...bad].join("\n"));
  console.log(s.log("sidecar").split("\n").filter(l => /unimplemented|ERROR|WARN/.test(l)).join("\n"));
  await s.stop();
}, 120000);

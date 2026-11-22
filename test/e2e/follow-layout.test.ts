import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { OmpInstance } from "./omp";
import { startStack, type Stack } from "./stack";
import { newSession, openSession, send } from "./ui";

// While new turns land in a session the chat is showing, nothing already on screen may be torn down and
// rebuilt (a message whose DOM node is removed and re-added right away), and the scroll position may not
// move backwards.

let stack: Stack;
let page: Page;
const fetches: string[] = [];
const events: Array<{ at: number; type: string }> = [];
const DEBUG = Boolean(process.env.LAYOUT_DEBUG);

beforeAll(async () => {
  stack = await startStack({ env: { OC_FOLLOW_POLL_MS: "100", ...(process.env.OC_FOLLOW_PACE_MS ? { OC_FOLLOW_PACE_MS: process.env.OC_FOLLOW_PACE_MS } : {}) } });
  page = await stack.page();
  if (DEBUG) {
    await page.addInitScript(() => localStorage.setItem("openchamber:sync:debug", "1"));
    page.on("console", (msg) => { const t = msg.text(); if (t.includes("[sync:")) console.log("SYNC", Date.now() % 100000, t.slice(0, 260)); });
  }
  page.on("request", (req) => {
    if (req.method() === "GET" && /\/session\/[^/?]+\/message/.test(req.url())) fetches.push(req.url());
  });
  const dir = encodeURIComponent(stack.project);
  void fetch(`${stack.api}/event?directory=${dir}`).then(async (res) => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any) {
      buf += decoder.decode(chunk);
      const frames = buf.split("\n\n");
      buf = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) try { events.push({ at: Date.now(), type: JSON.parse(data.slice(5)).type }); if (DEBUG) appendFileSync(`/tmp/layout-events-${process.env.LAYOUT_DEBUG}.jsonl`, data.slice(5) + "\n"); } catch { /* keepalive */ }
      }
    }
  }).catch(() => {});
});
afterAll(() => stack.stop());

const filler = (n: number) => `Paragraph ${n}. ` + "Some words to make this message tall enough to scroll. ".repeat(12);
const turn = (key: string, n: number) => ({
  when: key,
  steps: [
    { thinking: `Thinking about ${key}` },
    { tool: "bash", args: { command: `echo ${key}` }, result: `out ${key}\n${"line\n".repeat(6)}` },
    ...(key.startsWith("new") ? [
      { sleep: 700 },
      { thinking: `More thinking about ${key}` },
      { tool: "bash", args: { command: `echo again ${key}` }, result: `again ${key}\n${"line\n".repeat(6)}` },
      { sleep: 700 },
    ] : []),
    { text: filler(n) },
  ],
});

type Probe = { remounted: string[]; stamps: number[]; maxScrollBack: number; shifts: number; scroller: boolean; start: string; where: string[] };

/** In-page probe: message nodes removed and re-added within 250 ms (a remount), upward scroll, layout shifts. */
const INSTRUMENT = () => {
  const w = window as any;
  let scroller = document.querySelector("[data-message-id]") as HTMLElement | null;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const p: Probe = { remounted: [], stamps: [], maxScrollBack: 0, shifts: 0, scroller: !!scroller, start: scroller ? `top=${Math.round(scroller.scrollTop)} h=${scroller.scrollHeight} c=${scroller.clientHeight} rows=${document.querySelectorAll("[data-message-id]").length} ids=${[...document.querySelectorAll("[data-message-id]")].map((m) => m.getAttribute("data-message-id")!.slice(-4)).join(",")}` : "" };
  w.__probe = p;
  const idsOf = (n: Node): string[] => {
    if (!(n instanceof HTMLElement)) return [];
    return [...(n.hasAttribute("data-message-id") ? [n] : []), ...n.querySelectorAll("[data-message-id]")].map((m) => m.getAttribute("data-message-id")!);
  };
  const removedAt = new Map<string, number>();
  new MutationObserver((records) => {
    const now = performance.now();
    for (const r of records) {
      for (const n of r.removedNodes) for (const id of idsOf(n)) { removedAt.set(id, now); (p.where ??= []).push(`${id.slice(-4)} from ${(r.target as HTMLElement).tagName}.${String((r.target as HTMLElement).className).slice(0, 50)}/${(r.target as HTMLElement).getAttribute?.("style")?.slice(0, 60) ?? ""} node=${(n as HTMLElement).tagName}.${String((n as HTMLElement).className).slice(0, 30)}`); }
      for (const n of r.addedNodes) for (const id of idsOf(n)) if (now - (removedAt.get(id) ?? -1e9) < 250) { p.remounted.push(id); p.stamps.push(Date.now()); }
    }
  }).observe(document.body, { childList: true, subtree: true });
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) p.shifts += e.value; }).observe({ type: "layout-shift", buffered: false });
  } catch { /* unsupported */ }
  if (scroller) {
    const s = scroller;
    let last = s.scrollTop;
    const tick = () => {
      p.maxScrollBack = Math.max(p.maxScrollBack, last - s.scrollTop);
      last = s.scrollTop;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
};

const probe = () => page.evaluate(() => (window as any).__probe as Probe);
const toBottom = () => page.evaluate(() => {
  let el = document.querySelector("[data-message-id]") as HTMLElement | null;
  while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (el) el.scrollTop = el.scrollHeight;
});

const report = (label: string, p: Probe, refetches: number) => {
  const line = { remounts: p.remounted.length, maxScrollBack: Math.round(p.maxScrollBack), shifts: Number(p.shifts.toFixed(3)), refetches, start: p.start };
  console.log(label, JSON.stringify(line));
  if (DEBUG) {
    const merged = [...events.map((e) => ({ at: e.at, text: e.type })), ...p.stamps.map((at, i) => ({ at, text: `REMOUNT ${p.remounted[i]!.slice(-6)}` }))].sort((a, b) => a.at - b.at);
    console.log(label, "timeline\n" + merged.map((m) => `${m.at % 100000} ${m.text}`).join("\n"));
    console.log(label, "WHERE\n" + (p.where ?? []).slice(0, 14).join("\n"));
  }
};

describe("new turns land in a followed session", () => {
  test("no message is remounted and the view does not scroll back", async () => {
    const keys = ["h1", "h2", "h3", "h4", "h5"];
    stack.script([...keys.map((k, i) => turn(k, i)), turn("new1", 10), turn("new2", 11), turn("new3", 12)]);
    const terminal = await OmpInstance.start(stack, stack.project);
    for (const k of keys) await terminal.prompt(k);
    if (process.env.LAYOUT_SUMMARY) await fetch(`${stack.ui}/api/config/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ activityRenderMode: "summary" }) });
    await page.goto(stack.ui);
    await page.locator(".group\\/project").first().waitFor();
    await openSession(page, "h1");
    await page.getByText(filler(4).slice(0, 40)).first().waitFor();
    await Bun.sleep(1000);
    await toBottom();
    await Bun.sleep(500);
    await page.evaluate(INSTRUMENT);
    const before = fetches.length;
    for (const k of ["new1", "new2", "new3"]) {
      await terminal.prompt(k);
      await Bun.sleep(1200);
    }
    const p = await probe();
    report("FOLLOW", p, fetches.length - before);
    expect(p.scroller).toBe(true);
    expect(p.remounted).toEqual([]);
    expect(p.maxScrollBack).toBeLessThan(40);
    await terminal.close();
  });
});

describe("new turns driven from the UI", () => {
  test("no message is remounted and the view does not scroll back", async () => {
    const keys = ["l1", "l2", "l3", "l4", "l5"];
    stack.script([...keys.map((k, i) => turn(k, i)), turn("new1", 10), turn("new2", 11), turn("new3", 12)]);
    await page.goto(stack.ui);
    await page.locator(".group\\/project").first().waitFor();
    await newSession(page);
    for (const [i, k] of keys.entries()) {
      await send(page, k);
      await page.getByText(filler(i).slice(0, 40)).first().waitFor();
      await Bun.sleep(300);
    }
    if (process.env.XP_RELOAD) {
      await Bun.sleep(1500);
      await page.reload();
      await page.getByText(filler(4).slice(0, 40)).first().waitFor();
      await Bun.sleep(1000);
    }
    await toBottom();
    await Bun.sleep(500);
    await page.evaluate(INSTRUMENT);
    const before = fetches.length;
    for (const k of ["new1", "new2", "new3"]) {
      await send(page, k);
      await Bun.sleep(1500);
    }
    const p = await probe();
    report("LIVE", p, fetches.length - before);
    expect(p.scroller).toBe(true);
    expect(p.remounted).toEqual([]);
    expect(p.maxScrollBack).toBeLessThan(40);
  });
});

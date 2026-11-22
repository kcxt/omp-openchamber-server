/**
 * OpenChamber's Stats page (`GET /experimental/session/stats`), computed from the
 * session transcripts omp wrote: one pass over every session active in the range.
 */
import { loadSessionMessages } from "../../omp/messages";
import { listOmpSessions } from "../../store/sessions";
import type { OpenCodeMessageRecord, OpenCodeSession } from "../../shared/types";

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
const zero = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
const add = (to: Tokens, from: Tokens | undefined) => {
  if (!from) return;
  to.input += from.input ?? 0;
  to.output += from.output ?? 0;
  to.reasoning += from.reasoning ?? 0;
  to.cache.read += from.cache?.read ?? 0;
  to.cache.write += from.cache?.write ?? 0;
};

function dayKey(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export async function buildUsageStats(params: { from?: number; to?: number; timezone: string; tools: "none" | "detail" }) {
  const to = params.to ?? Date.now();
  const sessions = await listOmpSessions(null, { all: true });
  const inRange = sessions.filter((s: OpenCodeSession) => (params.from === undefined || s.time.updated >= params.from) && s.time.created <= to);
  const tokens = zero();
  let cost = 0, prompts = 0, steps = 0, subagents = 0;
  const activity = new Map<string, number>();
  const models = new Map<string, { providerID: string; id: string; variant?: string; steps: number; tokens: Tokens; cost: number }>();
  const toolUsage = new Map<string, { name: string; calls: number; succeeded: number; failed: number; unfinished: number }>();

  for (const session of inRange) {
    if (session.parentID) subagents++;
    let records: OpenCodeMessageRecord[] = [];
    try {
      records = (await loadSessionMessages(session.id, session.directory)) ?? [];
    } catch {
      continue;
    }
    for (const { info, parts } of records) {
      const created = info.time?.created ?? 0;
      if ((params.from !== undefined && created < params.from) || created > to) continue;
      if (info.role === "user") {
        prompts++;
        continue;
      }
      steps++;
      const day = dayKey(created, params.timezone);
      activity.set(day, (activity.get(day) ?? 0) + 1);
      add(tokens, info.tokens as Tokens | undefined);
      cost += info.cost ?? 0;
      const key = `${info.providerID}/${info.modelID}/${info.variant ?? ""}`;
      const entry = models.get(key) ?? { providerID: String(info.providerID ?? "omp"), id: String(info.modelID ?? "omp"), variant: info.variant, steps: 0, tokens: zero(), cost: 0 };
      entry.steps++;
      add(entry.tokens, info.tokens as Tokens | undefined);
      entry.cost += info.cost ?? 0;
      models.set(key, entry);
      for (const part of parts) {
        if (part.type !== "tool") continue;
        const tool = toolUsage.get(String(part.tool)) ?? { name: String(part.tool), calls: 0, succeeded: 0, failed: 0, unfinished: 0 };
        tool.calls++;
        const status = (part.state as { status?: string } | undefined)?.status;
        if (status === "completed") tool.succeeded++;
        else if (status === "error") tool.failed++;
        else tool.unfinished++;
        toolUsage.set(tool.name, tool);
      }
    }
  }

  const days = [...activity.keys()].sort();
  let streak = 0;
  for (let day = new Date(); ; day = new Date(day.getTime() - 86_400_000)) {
    if (!activity.has(dayKey(day.getTime(), params.timezone))) break;
    streak++;
  }
  const totals = [...toolUsage.values()].reduce((sum, t) => ({ calls: sum.calls + t.calls, succeeded: sum.succeeded + t.succeeded, failed: sum.failed + t.failed, unfinished: sum.unfinished + t.unfinished }), { calls: 0, succeeded: 0, failed: 0, unfinished: 0 });
  return {
    range: { from: params.from ?? (days[0] ? Date.parse(days[0]) : to), to },
    sessions: inRange.length - subagents,
    subagents,
    prompts,
    steps,
    tokens,
    cost,
    tools: params.tools === "detail"
      ? { mode: "detail", totals, usage: [...toolUsage.values()].map((t) => ({ ...t, durationP50: null })) }
      : { mode: "summary", totals },
    activeDays: days.length,
    streak,
    activity: days.map((date) => ({ date, steps: activity.get(date)! })),
    models: [...models.values()].map((m) => ({ model: { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) }, steps: m.steps, tokens: m.tokens, cost: m.cost })),
  };
}
